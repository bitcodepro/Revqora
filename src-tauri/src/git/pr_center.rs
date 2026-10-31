//! PR browsing and optimistic metadata editing; never checks out or stages files.
use super::{
    diff,
    forge::{self, ForgeInfo, PullRequest},
    runner::{self, GitError, GitResult},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::Write,
    path::Path,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

const PAGE: usize = 50;
const PATCH_LIMIT: u64 = 8 * 1024 * 1024;
const BLOB_LIMIT: u64 = 1024 * 1024;
fn fail(message: &str) -> GitError {
    GitError::new(message).kind("pr-center")
}
fn stale() -> GitError {
    GitError::new("The pull request changed. Refresh it before continuing; your edit was not sent.").kind("stale-operation")
}
fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}
fn text(v: &Value, path: &str) -> String {
    v.pointer(path).and_then(Value::as_str).unwrap_or("").into()
}
fn oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn number(n: u64) -> GitResult<()> {
    if n == 0 || n > 9_007_199_254_740_991 {
        Err(fail("Enter a valid pull request number."))
    } else {
        Ok(())
    }
}

fn endpoint(f: &ForgeInfo) -> String {
    match f.kind.as_str() {
        "github" => format!("/repos/{}/pulls", forge::project_path(&f.project)),
        "gitlab" => format!("/projects/{}/merge_requests", forge::enc(&f.project)),
        "bitbucket" => format!("/repositories/{}/pullrequests", forge::project_path(&f.project)),
        "bitbucket-server" => format!("{}/pull-requests", forge::server_repo(f)),
        _ => format!("{}/pullrequests", forge::azure_repo(f)),
    }
}
fn item_endpoint(f: &ForgeInfo, n: u64) -> String {
    format!("{}/{n}{}", endpoint(f), if f.kind == "azure" { "?api-version=7.1" } else { "" })
}
fn browser_url(f: &ForgeInfo, n: u64) -> String {
    let project = forge::project_path(&f.project);
    match f.kind.as_str() {
        "github" => format!(
            "{}/{project}/pull/{n}",
            if f.api == "https://api.github.com" { "https://github.com" } else { f.api.strip_suffix("/api/v3").unwrap_or(&f.api) }
        ),
        "gitlab" => format!("{}/{project}/-/merge_requests/{n}", f.api.strip_suffix("/api/v4").unwrap_or(&f.api)),
        "bitbucket" => format!(
            "{}/{project}/pull-requests/{n}",
            if f.api == "https://api.bitbucket.org/2.0" { "https://bitbucket.org" } else { f.api.strip_suffix("/2.0").unwrap_or(&f.api) }
        ),
        "bitbucket-server" => {
            let (p, r) = f.project.split_once('/').unwrap_or((&f.project, ""));
            format!("{}/projects/{}/repos/{}/pull-requests/{n}", f.api, forge::enc(p), forge::enc(r))
        }
        _ => {
            let (p, r) = f.project.split_once('/').unwrap_or((&f.project, ""));
            format!("{}/{}/_git/{}/pullrequest/{n}", f.api, forge::enc(p), forge::enc(r))
        }
    }
}
fn summary(f: &ForgeInfo, v: &Value) -> GitResult<PullRequest> {
    let mut p = match f.kind.as_str() {
        "github" => forge::gh_pr(v),
        "gitlab" => forge::gl_mr(v),
        "bitbucket" => forge::bb_pr(v),
        "bitbucket-server" => forge::bbs_pr(v),
        _ => forge::azure_pr(v, f),
    };
    number(p.number)?;
    if p.title.is_empty() || p.head.is_empty() || p.base.is_empty() {
        return Err(fail("The provider returned incomplete pull request metadata."));
    }
    p.state = match p.state.to_ascii_lowercase().as_str() {
        "open" | "opened" | "active" => "open",
        "merged" | "completed" => "merged",
        "closed" if f.kind == "github" && (v.get("merged").and_then(Value::as_bool) == Some(true) || v.get("merged_at").is_some_and(|x| !x.is_null())) => {
            "merged"
        }
        "closed" | "declined" | "abandoned" | "superseded" => "closed",
        _ => "unknown",
    }
    .into();
    // Never turn a provider-supplied file:/javascript:/credential URL into an Open action.
    p.url = browser_url(f, p.number);
    Ok(p)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub forge: ForgeInfo,
    pub items: Vec<PullRequest>,
    pub next_cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    connection: String,
    state: String,
    offset: u32,
}

pub fn page(repo: &Path, state: &str, cursor: Option<&str>) -> GitResult<Page> {
    if !["open", "closed", "merged", "all"].contains(&state) {
        return Err(fail("Choose Open, Closed, Merged or All requests."));
    }
    let f = forge::detect(repo)?.ok_or_else(|| fail("Configure an API connection first."))?;
    let connection = f.connection_revision.clone().ok_or_else(|| fail("Missing API connection revision."))?;
    let offset = if let Some(c) = cursor {
        if c.len() > 2048 {
            return Err(fail("Invalid PR page cursor."));
        }
        let c: Cursor = serde_json::from_str(c).map_err(|_| fail("Invalid PR page cursor."))?;
        if c.connection != connection || c.state != state {
            return Err(stale());
        }
        if c.offset > 1_000_000 {
            return Err(fail("PR page limit reached."));
        }
        c.offset
    } else {
        0
    };
    let page = offset / PAGE as u32 + 1;
    let route = match f.kind.as_str() {
        "github" => {
            format!("{}?state={}&sort=updated&direction=desc&per_page={PAGE}&page={page}", endpoint(&f), if state == "merged" { "closed" } else { state })
        }
        "gitlab" => {
            format!("{}?state={}&order_by=updated_at&sort=desc&per_page={PAGE}&page={page}", endpoint(&f), if state == "open" { "opened" } else { state })
        }
        "bitbucket" => format!(
            "{}?{}sort=-updated_on&pagelen={PAGE}&page={page}",
            endpoint(&f),
            match state {
                "open" => "state=OPEN&",
                "closed" => "state=DECLINED&state=SUPERSEDED&",
                "merged" => "state=MERGED&",
                _ => "state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&",
            }
        ),
        "bitbucket-server" => format!(
            "{}?state={}&order=NEWEST&limit={PAGE}&start={offset}",
            endpoint(&f),
            match state {
                "open" => "OPEN",
                "closed" => "DECLINED",
                "merged" => "MERGED",
                _ => "ALL",
            }
        ),
        _ => format!(
            "{}?searchCriteria.status={}&$top={PAGE}&$skip={offset}&api-version=7.1",
            endpoint(&f),
            match state {
                "open" => "active",
                "closed" => "abandoned",
                "merged" => "completed",
                _ => "all",
            }
        ),
    };
    let v = forge::request(repo, &f, "GET", &route, None)?;
    let rows = match f.kind.as_str() {
        "github" | "gitlab" => v.as_array(),
        "bitbucket" | "bitbucket-server" => v.get("values").and_then(Value::as_array),
        _ => v.get("value").and_then(Value::as_array),
    }
    .ok_or_else(|| fail("The provider returned an invalid pull request page."))?;
    if rows.len() > 200 {
        return Err(fail("The provider ignored the PR page size."));
    }
    let mut items = rows.iter().map(|v| summary(&f, v)).collect::<GitResult<Vec<_>>>()?;
    if state != "all" {
        items.retain(|p| p.state == state);
    }
    let next = match f.kind.as_str() {
        "bitbucket-server" => {
            if v.get("isLastPage").and_then(Value::as_bool) == Some(false) {
                Some(
                    u32::try_from(v.get("nextPageStart").and_then(Value::as_u64).ok_or_else(|| fail("Missing next-page offset."))?)
                        .map_err(|_| fail("Invalid next-page offset."))?,
                )
            } else {
                None
            }
        }
        "bitbucket" => v.get("next").and_then(Value::as_str).map(|_| offset + PAGE as u32),
        _ => {
            if rows.len() >= PAGE {
                Some(offset + PAGE as u32)
            } else {
                None
            }
        }
    };
    if next.is_some_and(|n| n <= offset) {
        return Err(fail("The provider returned a non-advancing PR page."));
    }
    let next_cursor = next.map(|offset| serde_json::to_string(&Cursor { connection, state: state.into(), offset }).unwrap());
    Ok(Page { forge: f, items, next_cursor })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub pull: PullRequest,
    pub body: String,
    pub updated: String,
    pub base_sha: String,
    pub diff_base_sha: String,
    pub revision: String,
    pub file_count: Option<usize>,
}
fn detail_value(f: &ForgeInfo, v: &Value) -> GitResult<Detail> {
    let pull = summary(f, v)?;
    let (body, updated, base_sha, diff_base_sha, count) = match f.kind.as_str() {
        "github" => {
            (text(v, "/body"), text(v, "/updated_at"), text(v, "/base/sha"), String::new(), v.get("changed_files").and_then(Value::as_u64).map(|n| n as usize))
        }
        "gitlab" => (
            text(v, "/description"),
            text(v, "/updated_at"),
            text(v, "/diff_refs/start_sha"),
            text(v, "/diff_refs/base_sha"),
            v.get("changes_count").and_then(Value::as_str).and_then(|s| s.parse().ok()),
        ),
        "bitbucket" => (text(v, "/description"), text(v, "/updated_on"), text(v, "/destination/commit/hash"), String::new(), None),
        "bitbucket-server" => {
            (text(v, "/description"), v.get("updatedDate").map(Value::to_string).unwrap_or_default(), text(v, "/toRef/latestCommit"), String::new(), None)
        }
        _ => (text(v, "/description"), text(v, "/creationDate"), text(v, "/lastMergeTargetCommit/commitId"), String::new(), None),
    };
    let revision = hash(
        serde_json::to_vec(&json!([f.connection_revision, pull, body, updated, base_sha, diff_base_sha, v.get("version"), v.pointer("/diff_refs/head_sha")]))
            .map_err(|_| fail("Could not fingerprint PR metadata."))?,
    );
    Ok(Detail { pull, body, updated, base_sha, diff_base_sha, revision, file_count: count })
}
fn load_detail(repo: &Path, f: &ForgeInfo, n: u64) -> GitResult<(Detail, Value)> {
    number(n)?;
    let v = forge::request(repo, f, "GET", &item_endpoint(f, n), None)?;
    let d = detail_value(f, &v)?;
    if d.pull.number != n {
        return Err(fail("The provider returned a different pull request."));
    }
    Ok((d, v))
}
pub fn detail(repo: &Path, n: u64, connection: &str) -> GitResult<Detail> {
    let f = forge::reviewed_connection(repo, connection)?;
    load_detail(repo, &f, n).map(|x| x.0)
}

pub fn checks(repo: &Path, n: u64, connection: &str, revision: &str) -> GitResult<Vec<forge::Check>> {
    let f = forge::reviewed_connection(repo, connection)?;
    let (d, _) = load_detail(repo, &f, n)?;
    if d.revision != revision {
        return Err(stale());
    }
    forge::checks_for(repo, &f, &d.pull.head_sha)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub title: String,
    pub body: String,
    pub base: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub detail: Detail,
    pub notice: Option<String>,
}
fn validate_fields(repo: &Path, title: &str, body: &str, base: &str) -> GitResult<()> {
    if title.trim().is_empty() || title.chars().count() > 256 || title.chars().any(char::is_control) {
        return Err(fail("Use a title of 1–256 characters without control characters."));
    }
    if body.len() > 65536 || body.contains('\0') {
        return Err(fail("The description must be at most 64 KiB and contain no NUL characters."));
    }
    branch(repo, base)
}
fn branch(repo: &Path, b: &str) -> GitResult<()> {
    if b.is_empty() || b.len() > 1024 || !runner::exec(repo, ["check-ref-format", &format!("refs/heads/{b}")])?.ok() {
        return Err(fail("Enter a valid published branch name."));
    }
    Ok(())
}
pub fn create(repo: &Path, title: &str, body: &str, head: &str, base: &str, draft: bool, connection: &str) -> GitResult<PullRequest> {
    let f = forge::reviewed_connection(repo, connection)?;
    validate_fields(repo, title, body, base)?;
    if f.kind == "github" {
        if let Some((owner, b)) = head.split_once(':') {
            if owner.is_empty() || !owner.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
                return Err(fail("Enter owner:branch for a GitHub fork."));
            }
            branch(repo, b)?;
        } else {
            branch(repo, head)?;
        }
    } else {
        branch(repo, head)?;
    }
    let mut p = forge::create(repo, title, body, head, base, draft, connection).map_err(uncertain)?;
    if number(p.number).is_err() || p.title.is_empty() || p.head.is_empty() || p.base.is_empty() {
        return Err(fail("The create response was incomplete. Check the PR list before trying again.").kind("forge-write-uncertain"));
    }
    p.url = browser_url(&f, p.number);
    p.state = match p.state.as_str() {
        "opened" | "active" | "open" => "open",
        "completed" | "merged" => "merged",
        "declined" | "abandoned" | "closed" => "closed",
        _ => "unknown",
    }
    .into();
    Ok(p)
}
fn uncertain(e: GitError) -> GitError {
    if matches!(e.kind.as_str(), "forge-network" | "forge-account" | "forge-server") {
        GitError::new("The server may have saved the request, but its result could not be read. Check the PR on the server before retrying.")
            .kind("forge-write-uncertain")
    } else {
        e
    }
}
pub fn edit(repo: &Path, n: u64, connection: &str, revision: &str, input: Edit) -> GitResult<EditResult> {
    let f = forge::reviewed_connection(repo, connection)?;
    validate_fields(repo, &input.title, &input.body, &input.base)?;
    let (before, v) = load_detail(repo, &f, n)?;
    if revision.is_empty() || before.revision != revision {
        return Err(stale());
    }
    if input.base != before.pull.base && before.pull.state != "open" {
        return Err(fail("Only an open request can change its target branch."));
    }
    let (method, body) = match f.kind.as_str() {
        "github" => ("PATCH", json!({"title":input.title,"body":input.body,"base":input.base})),
        "gitlab" => ("PUT", json!({"title":input.title,"description":input.body,"target_branch":input.base})),
        "bitbucket" => ("PUT", json!({"title":input.title,"description":input.body,"destination":{"branch":{"name":input.base}}})),
        "bitbucket-server" => {
            let version = v.get("version").and_then(Value::as_u64).ok_or_else(|| fail("Missing server PR version; refresh before editing."))?;
            let mut to = v.get("toRef").cloned().ok_or_else(|| fail("Missing target branch metadata."))?;
            to["id"] = json!(format!("refs/heads/{}", input.base));
            to["displayId"] = json!(input.base);
            ("PUT", json!({"id":n,"version":version,"title":input.title,"description":input.body,"toRef":to}))
        }
        _ => ("PATCH", json!({"title":input.title,"description":input.body,"targetRefName":format!("refs/heads/{}",input.base)})),
    };
    let response = forge::request(repo, &f, method, &item_endpoint(&f, n), Some(body)).map_err(uncertain)?;
    let detail =
        detail_value(&f, &response).map_err(|_| fail("The save response was incomplete. Refresh the PR before retrying.").kind("forge-write-uncertain"))?;
    if detail.pull.number != n {
        return Err(fail("Unexpected PR save response. Check the server before retrying.").kind("forge-write-uncertain"));
    }
    let notice = if detail.pull.title != input.title || detail.body != input.body || detail.pull.base != input.base {
        Some("The server did not apply every requested field. Review the returned title, description and target branch before continuing.".into())
    } else {
        None
    };
    Ok(EditResult { detail, notice })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub path: String,
    pub body: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Templates {
    pub items: Vec<Template>,
    pub notice: Option<String>,
}
fn template_path(kind: &str, path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    let name = p.rsplit('/').next().unwrap_or("");
    let default = ["pull_request_template.md", "pull_request_template.txt", "pull_request_template"].contains(&name);
    let markdown = name.ends_with(".md") || name.ends_with(".txt") || name.ends_with(".markdown");
    match kind {
        "gitlab" => p.starts_with(".gitlab/merge_request_templates/") && markdown,
        "bitbucket" | "bitbucket-server" => p == ".bitbucket/pull_request_template.md" || default && !p.contains('/'),
        "azure" => [".azuredevops/", ".vsts/", "docs/", ""].iter().any(|prefix| {
            let rest = p.strip_prefix(prefix).unwrap_or("/");
            default && !rest.contains('/') || rest.starts_with("pull_request_template/") && markdown
        }),
        _ => [".github/", "docs/", ""].iter().any(|prefix| {
            let rest = p.strip_prefix(prefix).unwrap_or("/");
            default && !rest.contains('/') || rest.starts_with("pull_request_template/") && markdown
        }),
    }
}
pub fn templates(repo: &Path, connection: &str) -> GitResult<Templates> {
    let f = forge::reviewed_connection(repo, connection)?;
    let head = runner::exec(repo, ["rev-parse", "--verify", "HEAD^{tree}"])?;
    if !head.ok() {
        return Ok(Templates { items: vec![], notice: Some("This repository has no committed templates yet.".into()) });
    }
    let tree = head.text().trim().to_owned();
    let listing = runner::run_bytes(
        repo,
        [
            "ls-tree",
            "-r",
            "-z",
            &tree,
            "--",
            ".github",
            ".gitlab/merge_request_templates",
            ".bitbucket",
            ".azuredevops",
            ".vsts",
            "docs",
            "pull_request_template.md",
            "PULL_REQUEST_TEMPLATE.md",
            "pull_request_template.txt",
            "pull_request_template",
            "PULL_REQUEST_TEMPLATE",
        ],
    )?;
    if listing.len() > 2 * 1024 * 1024 {
        return Err(fail("Template directory listing exceeds 2 MiB."));
    }
    let mut items = Vec::new();
    let mut skipped = 0;
    for entry in listing.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let Some(tab) = entry.iter().position(|b| *b == b'\t') else { continue };
        let Ok(path) = std::str::from_utf8(&entry[tab + 1..]) else { continue };
        if !template_path(&f.kind, path) {
            continue;
        }
        let meta = String::from_utf8_lossy(&entry[..tab]);
        let fields = meta.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 || !["100644", "100755"].contains(&fields[0]) || fields[1] != "blob" || !oid(fields[2]) {
            skipped += 1;
            continue;
        }
        let size = runner::run(repo, ["cat-file", "-s", fields[2]])?.trim().parse::<usize>().unwrap_or(usize::MAX);
        if size > 65536 || items.len() >= 50 {
            skipped += 1;
            continue;
        }
        let bytes = runner::run_bytes(repo, ["cat-file", "blob", fields[2]])?;
        let Ok(body) = String::from_utf8(bytes) else {
            skipped += 1;
            continue;
        };
        if body.contains('\0') {
            skipped += 1;
            continue;
        }
        items.push(Template { path: path.into(), body });
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));
    forge::reviewed_connection(repo, connection)?;
    Ok(Templates {
        items,
        notice: if skipped > 0 {
            Some(format!("{skipped} unsupported, linked or oversized templates were skipped (50 templates, 64 KiB each)."))
        } else {
            None
        },
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub binary: bool,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Files {
    pub items: Vec<File>,
    pub next_offset: Option<u32>,
    pub notice: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub diff: Option<diff::FileDiff>,
    pub notice: Option<String>,
}
struct Entry {
    meta: File,
    raw: Option<diff::RawFileDiff>,
    old_commit: String,
    new_commit: String,
}
struct Bundle {
    key: String,
    snapshot: String,
    files: Vec<Entry>,
    next: Option<u32>,
    notice: Option<String>,
    cost: usize,
    created: Instant,
}
static CACHE: OnceLock<Mutex<VecDeque<Arc<Bundle>>>> = OnceLock::new();
fn cache() -> &'static Mutex<VecDeque<Arc<Bundle>>> {
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}
fn cache_get(key: &str) -> Option<Arc<Bundle>> {
    let mut c = cache().lock();
    c.retain(|b| b.created.elapsed() < Duration::from_secs(300));
    let i = c.iter().position(|b| b.key == key)?;
    let b = c.remove(i)?;
    c.push_front(b.clone());
    Some(b)
}
fn cache_put(b: Bundle) -> Arc<Bundle> {
    let b = Arc::new(b);
    let mut c = cache().lock();
    c.retain(|x| x.key != b.key && x.created.elapsed() < Duration::from_secs(300));
    while !c.is_empty() && (c.len() >= 16 || c.iter().map(|x| x.cost).sum::<usize>() + b.cost > 32 * 1024 * 1024) {
        c.pop_back();
    }
    c.push_front(b.clone());
    b
}
fn snapshot(connection: &str, n: u64, revision: &str) -> String {
    hash(format!("{connection}\0{n}\0{revision}"))
}

fn decode_path(value: &str) -> GitResult<String> {
    if !value.starts_with('"') {
        return Ok(value.trim_end_matches('\t').into());
    }
    if !value.ends_with('"') || value.len() < 2 {
        return Err(fail("Malformed quoted diff path."));
    }
    let s = &value.as_bytes()[1..value.len() - 1];
    let mut bytes = Vec::new();
    let mut i = 0;
    while i < s.len() {
        let b = s[i];
        i += 1;
        if b != b'\\' {
            bytes.push(b);
            continue;
        }
        let b = *s.get(i).ok_or_else(|| fail("Malformed quoted diff path."))?;
        i += 1;
        if (b'0'..=b'7').contains(&b) {
            let mut n = (b - b'0') as u16;
            for _ in 0..2 {
                if let Some(b) = s.get(i).filter(|b| (b'0'..=b'7').contains(b)) {
                    n = n * 8 + (*b - b'0') as u16;
                    i += 1;
                } else {
                    break;
                }
            }
            if n > 255 {
                return Err(fail("Malformed octal diff path."));
            }
            bytes.push(n as u8);
        } else {
            bytes.push(match b {
                b'n' => b'\n',
                b'r' => b'\r',
                b't' => b'\t',
                b'b' => 8,
                b'f' => 12,
                b'v' => 11,
                b'a' => 7,
                b'"' => b'"',
                b'\\' => b'\\',
                _ => return Err(fail("Unsupported quoted diff path.")),
            });
        }
    }
    String::from_utf8(bytes).map_err(|_| fail("The provider returned a non-UTF-8 file name."))
}
fn header_paths(line: &str) -> Option<(String, String)> {
    let s = line.strip_prefix("diff --git ")?;
    if s.starts_with('"') {
        let b = s.as_bytes();
        let mut i = 1;
        while i < b.len() {
            if b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == b'"' {
                let a = decode_path(&s[..=i]).ok()?;
                let z = decode_path(s[i + 1..].trim_start()).ok()?;
                return Some((a.strip_prefix("a/").unwrap_or(&a).into(), z.strip_prefix("b/").unwrap_or(&z).into()));
            }
            i += 1;
        }
        return None;
    }
    for (i, _) in s.match_indices(" b/") {
        let a = s[..i].strip_prefix("a/")?;
        let b = &s[i + 3..];
        if a == b {
            return Some((a.into(), b.into()));
        }
    }
    None
}
fn normalize_raw(raw: &mut diff::RawFileDiff) -> GitResult<()> {
    if let Some((a, b)) = raw.header.first().and_then(|l| header_paths(String::from_utf8_lossy(l).trim_end_matches(['\r', '\n']))) {
        raw.old_path = Some(a);
        raw.new_path = Some(b);
    }
    for line in &raw.header {
        let s = String::from_utf8_lossy(line);
        let s = s.trim_end_matches(['\r', '\n']);
        if s.starts_with("@@ ") {
            break;
        }
        if let Some(p) = s.strip_prefix("--- ") {
            raw.old_path = if p == "/dev/null" { None } else { Some(decode_path(p)?.strip_prefix("a/").unwrap_or(&decode_path(p)?).into()) };
        } else if let Some(p) = s.strip_prefix("+++ ") {
            raw.new_path = if p == "/dev/null" { None } else { Some(decode_path(p)?.strip_prefix("b/").unwrap_or(&decode_path(p)?).into()) };
        } else if let Some(p) = s.strip_prefix("rename from ") {
            raw.old_path = Some(decode_path(p)?);
        } else if let Some(p) = s.strip_prefix("rename to ") {
            raw.new_path = Some(decode_path(p)?);
        }
    }
    Ok(())
}
fn complete(raw: &diff::RawFileDiff) -> bool {
    raw.hunks.iter().all(|h| {
        let old = h.lines.iter().filter(|l| l.kind == b' ' || l.kind == b'-').count();
        let new = h.lines.iter().filter(|l| l.kind == b' ' || l.kind == b'+').count();
        old == h.old_lines as usize && new == h.new_lines as usize
    })
}

fn bitbucket_redirect(f: &ForgeInfo, n: u64, d: &Detail, location: &str) -> GitResult<String> {
    let base = url::Url::parse(&f.api).map_err(|_| fail("Invalid API base."))?;
    let target = base.join(location).map_err(|_| fail("Invalid PR diff redirect."))?;
    if target.origin() != base.origin() || !target.username().is_empty() || target.password().is_some() || target.fragment().is_some() {
        return Err(fail("PR diff redirect leaves the selected API origin; credentials were not forwarded."));
    }
    let prefix = format!("{}/repositories/{}/diff/", base.path().trim_end_matches('/'), forge::project_path(&f.project));
    let spec = target.path().strip_prefix(&prefix).ok_or_else(|| fail("PR diff redirect leaves the selected repository."))?;
    if spec != format!("{}..{}", d.pull.head_sha, d.base_sha) && spec != format!("{}..{}", d.base_sha, d.pull.head_sha) {
        return Err(fail("PR diff redirect changed the reviewed commits."));
    }
    for (k, v) in target.query_pairs() {
        if !matches!((k.as_ref(), v.as_ref()), ("topic", "true") | ("context", "3")) && !(k == "from_pullrequest_id" && v == n.to_string()) {
            return Err(fail("Unsupported PR diff redirect parameters."));
        }
    }
    Ok(format!(
        "{}{}",
        target.path().strip_prefix(base.path().trim_end_matches('/')).unwrap_or(target.path()),
        target.query().map(|q| format!("?{q}")).unwrap_or_default()
    ))
}

fn raw_bundle(repo: &Path, f: &ForgeInfo, n: u64, d: &Detail, snapshot: String, key: String) -> GitResult<Bundle> {
    let route = match f.kind.as_str() {
        "github" => item_endpoint(f, n),
        "gitlab" => format!("{}/{n}/raw_diffs", endpoint(f)),
        "bitbucket" => format!("{}/{n}/diff", endpoint(f)),
        _ => format!("{}/{n}.diff", endpoint(f)),
    };
    let accept = if f.kind == "github" { "application/vnd.github.diff" } else { "text/plain" };
    let mut response = forge::raw_request(repo, f, &route, accept, PATCH_LIMIT, f.kind == "bitbucket")?;
    if (300..400).contains(&response.status) {
        let location = response.location.as_deref().ok_or_else(|| fail("The provider omitted the PR diff redirect location."))?;
        let path = bitbucket_redirect(f, n, d, location)?;
        response = forge::raw_request(repo, f, &path, accept, PATCH_LIMIT, false)?;
    }
    if response.bytes.iter().filter(|b| **b == b'\n').count() > 100_000 {
        return Err(fail("PR diff exceeds 100,000 lines. Use the server or a local checkout for this diff."));
    }
    if load_detail(repo, f, n)?.0.revision != d.revision {
        return Err(stale());
    }
    let cost = response.bytes.len() * 2;
    let parsed = diff::parse(&response.bytes);
    let mut files = Vec::new();
    for (i, mut raw) in parsed.into_iter().enumerate() {
        normalize_raw(&mut raw)?;
        let path = raw.new_path.clone().or_else(|| raw.old_path.clone()).ok_or_else(|| fail("The provider omitted a changed file's path."))?;
        let old_path = raw.old_path.as_ref().filter(|p| **p != path).cloned();
        let additions = raw.hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind == b'+').count() as u32;
        let deletions = raw.hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind == b'-').count() as u32;
        let meta = File {
            id: hash(format!("{key}:{i}")),
            path,
            old_path: old_path.clone(),
            status: if raw.is_new {
                "A"
            } else if raw.is_deleted {
                "D"
            } else if old_path.is_some() {
                "R"
            } else {
                "M"
            }
            .into(),
            binary: raw.binary,
            additions: Some(additions),
            deletions: Some(deletions),
        };
        files.push(Entry { meta, raw: Some(raw), old_commit: String::new(), new_commit: String::new() });
    }
    let notice = if d.file_count.is_some_and(|n| n != files.len()) {
        Some(format!(
            "The provider reports {} files but supplied {} diff entries. Some changes may be omitted by server diff limits.",
            d.file_count.unwrap(),
            files.len()
        ))
    } else if f.kind == "gitlab" && d.file_count.is_none() {
        Some("GitLab server diff limits may omit large files. Missing changes can be inspected on the server or in a local checkout.".into())
    } else if files.is_empty() {
        Some("The provider supplied no file diff. Binary or oversized changes may require the server view.".into())
    } else {
        None
    };
    Ok(Bundle { key, snapshot, files, next: None, notice, cost, created: Instant::now() })
}

fn azure_bundle(repo: &Path, f: &ForgeInfo, d: &Detail, snapshot: String, key: String, offset: u32) -> GitResult<Bundle> {
    let route=format!("{}/diffs/commits?baseVersion={}&baseVersionType=commit&targetVersion={}&targetVersionType=commit&diffCommonCommit=true&$top={PAGE}&$skip={offset}&api-version=7.1",forge::azure_repo(f),d.base_sha,d.pull.head_sha);
    let v = forge::request(repo, f, "GET", &route, None)?;
    let common = text(&v, "/commonCommit");
    if !oid(&common) {
        return Err(fail("The provider has not prepared the PR merge base yet."));
    }
    let rows = v.get("changes").and_then(Value::as_array).ok_or_else(|| fail("Invalid changed-files response."))?;
    if rows.len() > 200 {
        return Err(fail("The provider ignored the file page size."));
    }
    let mut files = Vec::new();
    for (i, v) in rows.iter().enumerate() {
        if v.pointer("/item/isFolder").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let path = text(v, "/item/path").trim_start_matches('/').to_owned();
        if path.is_empty() {
            return Err(fail("The provider omitted a file path."));
        }
        let change = text(v, "/changeType").to_ascii_lowercase();
        let old_path = Some(text(v, "/originalPath").trim_start_matches('/').to_owned()).filter(|p| !p.is_empty() && *p != path);
        let status = if change.contains("rename") {
            "R"
        } else if change.contains("delete") {
            "D"
        } else if change.contains("add") {
            "A"
        } else {
            "M"
        };
        files.push(Entry {
            meta: File { id: hash(format!("{key}:{i}")), path, old_path, status: status.into(), binary: false, additions: None, deletions: None },
            raw: None,
            old_commit: common.clone(),
            new_commit: d.pull.head_sha.clone(),
        });
    }
    let next = if v.get("allChangesIncluded").and_then(Value::as_bool) == Some(true) || rows.is_empty() { None } else { Some(offset + rows.len() as u32) };
    Ok(Bundle { key, snapshot, files, next, notice: None, cost: rows.len() * 2048, created: Instant::now() })
}
pub fn files(repo: &Path, n: u64, connection: &str, revision: &str, offset: u32) -> GitResult<Files> {
    number(n)?;
    if offset > 100_000 {
        return Err(fail("Invalid file page offset."));
    }
    let f = forge::reviewed_connection(repo, connection)?;
    let snapshot = snapshot(connection, n, revision);
    let key = format!("{snapshot}:{}", if f.kind == "azure" { offset } else { 0 });
    let bundle = if let Some(b) = cache_get(&key) {
        b
    } else {
        let (d, metadata) = load_detail(repo, &f, n)?;
        if d.revision != revision {
            return Err(stale());
        }
        if f.kind == "gitlab" && text(&metadata, "/diff_refs/head_sha") != d.pull.head_sha {
            return Err(fail("GitLab is still preparing the diff for this source commit. Refresh shortly."));
        }
        if !oid(&d.pull.head_sha) || !oid(&d.base_sha) {
            return Err(fail("The provider has not prepared complete PR commit IDs yet. Refresh shortly."));
        }
        let b =
            if f.kind == "azure" { azure_bundle(repo, &f, &d, snapshot.clone(), key, offset)? } else { raw_bundle(repo, &f, n, &d, snapshot.clone(), key)? };
        forge::reviewed_connection(repo, connection)?;
        cache_put(b)
    };
    if f.kind == "azure" {
        Ok(Files { items: bundle.files.iter().map(|e| e.meta.clone()).collect(), next_offset: bundle.next, notice: bundle.notice.clone() })
    } else {
        let start = offset as usize;
        Ok(Files {
            items: bundle.files.iter().skip(start).take(PAGE).map(|e| e.meta.clone()).collect(),
            next_offset: if start + PAGE < bundle.files.len() { Some(offset + PAGE as u32) } else { None },
            notice: bundle.notice.clone(),
        })
    }
}

fn azure_blob(repo: &Path, f: &ForgeInfo, path: &str, commit: &str) -> GitResult<Vec<u8>> {
    if path.split('/').any(|s| s == "..") || path.contains('\0') {
        return Err(fail("Invalid provider file path."));
    }
    let route = format!(
        "{}/items?path={}&versionDescriptor.version={commit}&versionDescriptor.versionType=commit&includeContentMetadata=true&api-version=7.1",
        forge::azure_repo(f),
        forge::enc(&format!("/{path}"))
    );
    let v = forge::request(repo, f, "GET", &route, None)?;
    let object = text(&v, "/objectId");
    if !oid(&object) {
        return Err(fail("The provider did not return the requested file blob."));
    }
    if v.get("size").and_then(Value::as_u64).is_some_and(|n| n > BLOB_LIMIT) {
        return Err(fail("This remote file exceeds the 1 MiB text preview limit."));
    }
    let route = format!("{}/blobs/{object}?$format=octetstream&resolveLfs=false&api-version=7.1", forge::azure_repo(f));
    Ok(forge::raw_request(repo, f, &route, "application/octet-stream", BLOB_LIMIT, false)?.bytes.to_vec())
}
fn azure_diff(repo: &Path, f: &ForgeInfo, e: &Entry) -> GitResult<FileView> {
    let old = if e.meta.status == "A" { vec![] } else { azure_blob(repo, f, e.meta.old_path.as_deref().unwrap_or(&e.meta.path), &e.old_commit)? };
    let new = if e.meta.status == "D" { vec![] } else { azure_blob(repo, f, &e.meta.path, &e.new_commit)? };
    if old.contains(&0) || new.contains(&0) || std::str::from_utf8(&old).is_err() || std::str::from_utf8(&new).is_err() {
        return Ok(FileView {
            diff: Some(diff::FileDiff {
                path: e.meta.path.clone(),
                old_path: e.meta.old_path.clone(),
                binary: true,
                is_new: e.meta.status == "A",
                is_deleted: e.meta.status == "D",
                ..Default::default()
            }),
            notice: None,
        });
    }
    let temp = crate::portable::temp_dir()?;
    let mut a = tempfile::NamedTempFile::new_in(&temp)?;
    let mut b = tempfile::NamedTempFile::new_in(&temp)?;
    a.write_all(&old)?;
    b.write_all(&new)?;
    let out = runner::exec(
        repo,
        [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--text",
            "--histogram",
            "--unified=3",
            "--output-indicator-new=+",
            "--output-indicator-old=-",
            "--output-indicator-context= ",
            "--no-relative",
            "--",
            a.path().to_string_lossy().as_ref(),
            b.path().to_string_lossy().as_ref(),
        ],
    )?;
    if !matches!(out.code, 0 | 1) {
        return Err(fail("Could not compare the remote text blobs."));
    }
    let mut view = diff::parse(&out.stdout)
        .first()
        .map(|r| diff::to_display(r, &e.meta.path, hash(&out.stdout)))
        .unwrap_or_else(|| diff::FileDiff { empty: true, ..Default::default() });
    view.path = e.meta.path.clone();
    view.old_path = e.meta.old_path.clone();
    view.is_new = e.meta.status == "A";
    view.is_deleted = e.meta.status == "D";
    view.hash = e.meta.id.clone();
    Ok(FileView { diff: Some(view), notice: None })
}
pub fn file(repo: &Path, n: u64, connection: &str, revision: &str, id: &str) -> GitResult<FileView> {
    number(n)?;
    let f = forge::reviewed_connection(repo, connection)?;
    let key = snapshot(connection, n, revision);
    let bundle = {
        let mut c = cache().lock();
        c.retain(|b| b.created.elapsed() < Duration::from_secs(300));
        c.iter().find(|b| b.snapshot == key && b.files.iter().any(|e| e.meta.id == id)).cloned()
    }
    .ok_or_else(|| fail("The file snapshot expired. Reload the PR files."))?;
    let entry = bundle.files.iter().find(|e| e.meta.id == id).unwrap();
    if let Some(raw) = &entry.raw {
        if !complete(raw) {
            return Ok(FileView{diff:None,notice:Some("The provider returned an incomplete patch for this file. Open the server view or use a local checkout; no complete diff is available here.".into())});
        }
        return Ok(FileView { diff: Some(diff::to_display(raw, &entry.meta.path, entry.meta.id.clone())), notice: None });
    }
    let result = azure_diff(repo, &f, entry)?;
    forge::reviewed_connection(repo, connection)?;
    Ok(result)
}

#[cfg(test)]
#[path = "pr_center_tests.rs"]
mod tests;
