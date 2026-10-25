//! Pull / merge requests and CI status for GitHub and GitLab remotes.
//!
//! The access token comes from git's own credential helper (`git credential fill`), i.e. the
//! sign-in the user already did for pushing; Revqora keeps it in memory only.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use super::runner::{self, GitError, GitResult};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForgeInfo {
    /// "github" | "gitlab"
    pub kind: String,
    pub host: String,
    /// "owner/repo" (GitLab: full project path, may contain groups)
    pub project: String,
    pub remote: String,
    pub web_url: String,
    pub api: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub head: String,
    pub base: String,
    pub url: String,
    pub draft: bool,
    pub state: String,
    pub created: String,
    pub head_sha: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// "success" | "failure" | "pending" | "neutral" | "skipped" | "cancelled"
    pub state: String,
    pub url: Option<String>,
}

/// Parses https / ssh remote URLs into (host, path without .git).
pub fn parse_remote(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    let (host, path) = if let Some(rest) = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")) {
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        rest.split_once('/')?
    } else if let Some(rest) = u.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (h, p) = rest.split_once('/')?;
        (h.split(':').next().unwrap_or(h), p)
    } else if let Some((user_host, p)) = u.split_once(':') {
        // "C:/path" is a Windows drive, not scp-style "host:path".
        if user_host.contains('/') || p.starts_with("//") || user_host.len() == 1 {
            return None;
        }
        (user_host.split_once('@').map(|(_, h)| h).unwrap_or(user_host), p)
    } else {
        return None;
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git").to_string();
    (!host.is_empty() && path.contains('/')).then(|| (host.to_lowercase(), path))
}

pub fn detect(repo: &Path) -> GitResult<Option<ForgeInfo>> {
    let remotes = super::refs::remotes(repo)?;
    let pick = remotes.iter().find(|r| r.name == "origin").or_else(|| remotes.first());
    let Some(r) = pick else { return Ok(None) };
    Ok(forge_for(&r.fetch_url, &r.name))
}

/// Works out the forge and its API from a remote URL.
pub fn forge_for(url: &str, remote: &str) -> Option<ForgeInfo> {
    let (host, project) = parse_remote(url)?;
    let info = |kind: &str, project: String, web_url: String, api: String| {
        Some(ForgeInfo { kind: kind.into(), host: host.clone(), project, remote: remote.into(), web_url, api })
    };
    if host == "github.com" {
        info("github", project.clone(), format!("https://{host}/{project}"), "https://api.github.com".into())
    } else if host.contains("github") {
        info("github", project.clone(), format!("https://{host}/{project}"), format!("https://{host}/api/v3"))
    } else if host.contains("gitlab") {
        info("gitlab", project.clone(), format!("https://{host}/{project}"), format!("https://{host}/api/v4"))
    } else if host == "bitbucket.org" {
        info("bitbucket", project.clone(), format!("https://bitbucket.org/{project}"), "https://api.bitbucket.org/2.0".into())
    } else if host.contains("bitbucket") {
        // Server / Data Center: https://host[/context]/scm/PROJECT/repo.git or ssh://git@host:7999/PROJECT/repo.git
        let (context, path) = match project.split_once("scm/") {
            Some((ctx, rest)) => (ctx.trim_end_matches('/').to_string(), rest.to_string()),
            None => (String::new(), project.clone()),
        };
        let (key, slug) = path.split_once('/')?;
        let base = if context.is_empty() { format!("https://{host}") } else { format!("https://{host}/{context}") };
        info("bitbucket-server", format!("{key}/{slug}"), format!("{base}/projects/{key}/repos/{slug}"), base)
    } else {
        None
    }
}

fn is_bitbucket(f: &ForgeInfo) -> bool {
    f.kind.starts_with("bitbucket")
}

/// (username, password or token) from git's credential helper, per host.
type Credentials = (String, String);
static TOKENS: Mutex<Option<HashMap<String, Credentials>>> = Mutex::new(None);

fn token(repo: &Path, host: &str) -> GitResult<Credentials> {
    if let Some(t) = TOKENS.lock().as_ref().and_then(|m| m.get(host).cloned()) {
        return Ok(t);
    }
    let input = format!("protocol=https\nhost={host}\n\n");
    let out = runner::exec_full(repo, ["credential", "fill"], &[], Some(input.as_bytes()))?;
    if !out.ok() {
        return Err(GitError::new(format!("No credentials for {host}. Push or fetch once so git can sign you in, then try again.")).kind("auth"));
    }
    let text = out.text();
    let field = |k: &str| text.lines().find_map(|l| l.strip_prefix(k).map(|s| s.to_string())).unwrap_or_default();
    let (user, pass) = (field("username="), field("password="));
    if pass.is_empty() {
        return Err(GitError::new(format!("Git returned no token for {host}.")).kind("auth"));
    }
    TOKENS.lock().get_or_insert_with(HashMap::new).insert(host.to_string(), (user.clone(), pass.clone()));
    Ok((user, pass))
}

fn forget(host: &str) {
    if let Some(m) = TOKENS.lock().as_mut() {
        m.remove(host);
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).user_agent("Revqora").build()
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in input.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

fn request(repo: &Path, f: &ForgeInfo, method: &str, path: &str, body: Option<Value>) -> GitResult<Value> {
    let (user, tok) = token(repo, &f.host)?;
    let url = format!("{}{}", f.api, path);
    let send = |auth: String| {
        let mut req = agent().request(method, &url).set("Authorization", &auth);
        if f.kind == "github" {
            req = req.set("Accept", "application/vnd.github+json");
        }
        match &body {
            Some(b) => req.send_json(b.clone()),
            None => req.call(),
        }
        .map_err(Box::new)
    };
    let mut res = send(format!("Bearer {tok}"));
    // Bitbucket app passwords and Server passwords use Basic auth; OAuth / access tokens use Bearer.
    if is_bitbucket(f) && !user.is_empty() && matches!(&res, Err(e) if matches!(**e, ureq::Error::Status(401, _))) {
        res = send(format!("Basic {}", base64(format!("{user}:{tok}").as_bytes())));
    }
    match res.map_err(|e| *e) {
        Ok(r) => r.into_json::<Value>().map_err(|e| GitError::new(format!("Unexpected response: {e}"))),
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| error_message(&v)).unwrap_or(text);
            if code == 401 {
                forget(&f.host);
                return Err(GitError::new(format!("{} rejected the token: {msg}", f.host)).kind("auth"));
            }
            Err(GitError::new(format!("{} returned {code}: {msg}", f.host)))
        }
        Err(e) => Err(GitError::new(format!("Network error: {e}"))),
    }
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// GitHub / GitLab `message`, Bitbucket Cloud `error.message`, Bitbucket Server `errors[0].message`.
fn error_message(v: &Value) -> Option<String> {
    v.get("message").or_else(|| v.pointer("/error/message")).or_else(|| v.pointer("/errors/0/message")).and_then(|m| m.as_str()).map(String::from)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn gh_pr(v: &Value) -> PullRequest {
    PullRequest {
        number: v.get("number").and_then(|n| n.as_u64()).unwrap_or(0),
        title: s(v, "title"),
        author: v.get("user").map(|u| s(u, "login")).unwrap_or_default(),
        head: v.get("head").map(|h| s(h, "ref")).unwrap_or_default(),
        base: v.get("base").map(|h| s(h, "ref")).unwrap_or_default(),
        url: s(v, "html_url"),
        draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        state: s(v, "state"),
        created: s(v, "created_at"),
        head_sha: v.get("head").map(|h| s(h, "sha")).unwrap_or_default(),
    }
}

fn gl_mr(v: &Value) -> PullRequest {
    PullRequest {
        number: v.get("iid").and_then(|n| n.as_u64()).unwrap_or(0),
        title: s(v, "title"),
        author: v.get("author").map(|u| s(u, "username")).unwrap_or_default(),
        head: s(v, "source_branch"),
        base: s(v, "target_branch"),
        url: s(v, "web_url"),
        draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        state: s(v, "state"),
        created: s(v, "created_at"),
        head_sha: s(v, "sha"),
    }
}

fn p(v: &Value, ptr: &str) -> String {
    v.pointer(ptr).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

pub fn bb_pr(v: &Value) -> PullRequest {
    PullRequest {
        number: v.get("id").and_then(|n| n.as_u64()).unwrap_or(0),
        title: s(v, "title"),
        author: Some(p(v, "/author/nickname")).filter(|a| !a.is_empty()).unwrap_or_else(|| p(v, "/author/display_name")),
        head: p(v, "/source/branch/name"),
        base: p(v, "/destination/branch/name"),
        url: p(v, "/links/html/href"),
        draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        state: s(v, "state").to_lowercase(),
        created: s(v, "created_on"),
        head_sha: p(v, "/source/commit/hash"),
    }
}

pub fn bbs_pr(v: &Value) -> PullRequest {
    PullRequest {
        number: v.get("id").and_then(|n| n.as_u64()).unwrap_or(0),
        title: s(v, "title"),
        author: Some(p(v, "/author/user/name")).filter(|a| !a.is_empty()).unwrap_or_else(|| p(v, "/author/user/displayName")),
        head: p(v, "/fromRef/displayId"),
        base: p(v, "/toRef/displayId"),
        url: p(v, "/links/self/0/href"),
        draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        state: s(v, "state").to_lowercase(),
        created: v.get("createdDate").and_then(|d| d.as_i64()).map(iso_from_millis).unwrap_or_default(),
        head_sha: p(v, "/fromRef/latestCommit"),
    }
}

/// Unix milliseconds to "YYYY-MM-DDTHH:MM:SSZ" (Bitbucket Server dates).
pub fn iso_from_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn server_repo(f: &ForgeInfo) -> String {
    let (key, slug) = f.project.split_once('/').unwrap_or((&f.project, ""));
    format!("/rest/api/1.0/projects/{}/repos/{}", enc(key), enc(slug))
}

pub fn list(repo: &Path) -> GitResult<(ForgeInfo, Vec<PullRequest>)> {
    let f = detect(repo)?.ok_or_else(|| GitError::new("The remote is not on GitHub, GitLab or Bitbucket."))?;
    let prs = if f.kind == "github" {
        let v = request(repo, &f, "GET", &format!("/repos/{}/pulls?state=open&per_page=100", f.project), None)?;
        v.as_array().map(|a| a.iter().map(gh_pr).collect()).unwrap_or_default()
    } else if f.kind == "bitbucket" {
        let v = request(repo, &f, "GET", &format!("/repositories/{}/pullrequests?state=OPEN&pagelen=50", f.project), None)?;
        v.get("values").and_then(|a| a.as_array()).map(|a| a.iter().map(bb_pr).collect()).unwrap_or_default()
    } else if f.kind == "bitbucket-server" {
        let v = request(repo, &f, "GET", &format!("{}/pull-requests?state=OPEN&limit=100", server_repo(&f)), None)?;
        v.get("values").and_then(|a| a.as_array()).map(|a| a.iter().map(bbs_pr).collect()).unwrap_or_default()
    } else {
        let v = request(repo, &f, "GET", &format!("/projects/{}/merge_requests?state=opened&per_page=100", enc(&f.project)), None)?;
        v.as_array().map(|a| a.iter().map(gl_mr).collect()).unwrap_or_default()
    };
    Ok((f, prs))
}

pub fn create(repo: &Path, title: &str, body: &str, head: &str, base: &str, draft: bool) -> GitResult<PullRequest> {
    let f = detect(repo)?.ok_or_else(|| GitError::new("The remote is not on GitHub, GitLab or Bitbucket."))?;
    if f.kind == "bitbucket" {
        let v = request(
            repo,
            &f,
            "POST",
            &format!("/repositories/{}/pullrequests", f.project),
            Some(
                serde_json::json!({ "title": title, "description": body, "draft": draft, "source": { "branch": { "name": head } }, "destination": { "branch": { "name": base } } }),
            ),
        )?;
        return Ok(bb_pr(&v));
    }
    if f.kind == "bitbucket-server" {
        let (key, slug) = f.project.split_once('/').unwrap_or((&f.project, ""));
        let repo_ref = serde_json::json!({ "slug": slug, "project": { "key": key } });
        let v = request(
            repo,
            &f,
            "POST",
            &format!("{}/pull-requests", server_repo(&f)),
            Some(serde_json::json!({
                "title": title, "description": body, "draft": draft,
                "fromRef": { "id": format!("refs/heads/{head}"), "repository": repo_ref },
                "toRef": { "id": format!("refs/heads/{base}"), "repository": repo_ref },
            })),
        )?;
        return Ok(bbs_pr(&v));
    }
    if f.kind == "github" {
        let v = request(
            repo,
            &f,
            "POST",
            &format!("/repos/{}/pulls", f.project),
            Some(serde_json::json!({ "title": title, "body": body, "head": head, "base": base, "draft": draft })),
        )?;
        Ok(gh_pr(&v))
    } else {
        let t = if draft { format!("Draft: {title}") } else { title.to_string() };
        let v = request(
            repo,
            &f,
            "POST",
            &format!("/projects/{}/merge_requests", enc(&f.project)),
            Some(serde_json::json!({ "title": t, "description": body, "source_branch": head, "target_branch": base })),
        )?;
        Ok(gl_mr(&v))
    }
}

/// Fetches a PR / MR head into a local `pr/<n>` branch and checks it out.
pub fn checkout(repo: &Path, number: u64) -> GitResult<String> {
    let f = detect(repo)?.ok_or_else(|| GitError::new("The remote is not on GitHub, GitLab or Bitbucket."))?;
    let local = format!("pr/{number}");
    if f.kind == "bitbucket" {
        // Bitbucket Cloud has no pull request refs: fetch the source branch, from the fork if needed.
        let v = request(repo, &f, "GET", &format!("/repositories/{}/pullrequests/{number}", f.project), None)?;
        let branch = p(&v, "/source/branch/name");
        let from = p(&v, "/source/repository/full_name");
        let remote = if from.is_empty() || from.eq_ignore_ascii_case(&f.project) { f.remote.clone() } else { format!("https://bitbucket.org/{from}.git") };
        runner::run(repo, ["fetch", &remote, &format!("+refs/heads/{branch}:refs/heads/{local}")])?;
        runner::run(repo, ["switch", &local])?;
        return Ok(local);
    }
    let src = match f.kind.as_str() {
        "github" => format!("pull/{number}/head"),
        "bitbucket-server" => format!("refs/pull-requests/{number}/from"),
        _ => format!("merge-requests/{number}/head"),
    };
    runner::run(repo, ["fetch", &f.remote, &format!("+{src}:refs/heads/{local}")])?;
    runner::run(repo, ["switch", &local])?;
    Ok(local)
}

fn norm_state(s: &str) -> String {
    match s {
        "success" | "passed" | "successful" => "success",
        "failure" | "failed" | "error" | "timed_out" | "action_required" => "failure",
        "stopped" => "cancelled",
        "neutral" => "neutral",
        "skipped" => "skipped",
        "cancelled" | "canceled" => "cancelled",
        _ => "pending",
    }
    .to_string()
}

pub fn checks(repo: &Path, sha: &str) -> GitResult<Vec<Check>> {
    let Some(f) = detect(repo)? else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    if f.kind == "github" {
        let runs = request(repo, &f, "GET", &format!("/repos/{}/commits/{sha}/check-runs?per_page=100", f.project), None)?;
        for r in runs.get("check_runs").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
            let st = if s(&r, "status") == "completed" { norm_state(&s(&r, "conclusion")) } else { "pending".into() };
            out.push(Check { name: s(&r, "name"), state: st, url: Some(s(&r, "html_url")).filter(|u| !u.is_empty()) });
        }
        let status = request(repo, &f, "GET", &format!("/repos/{}/commits/{sha}/status", f.project), None)?;
        for st in status.get("statuses").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
            out.push(Check { name: s(&st, "context"), state: norm_state(&s(&st, "state")), url: Some(s(&st, "target_url")).filter(|u| !u.is_empty()) });
        }
    } else if is_bitbucket(&f) {
        out = bitbucket_statuses(&f, sha, |path| request(repo, &f, "GET", path, None))?;
    } else {
        let v = request(repo, &f, "GET", &format!("/projects/{}/repository/commits/{sha}/statuses", enc(&f.project)), None)?;
        for st in v.as_array().cloned().unwrap_or_default() {
            out.push(Check { name: s(&st, "name"), state: norm_state(&s(&st, "status")), url: Some(s(&st, "target_url")).filter(|u| !u.is_empty()) });
        }
    }
    Ok(out)
}

/// Every page of a commit's Bitbucket build statuses. Both APIs paginate (Cloud: `next` URL,
/// Server: `isLastPage` / `nextPageStart`); a failure on a later page must not be missed.
pub fn bitbucket_statuses(f: &ForgeInfo, sha: &str, mut get: impl FnMut(&str) -> GitResult<Value>) -> GitResult<Vec<Check>> {
    let cloud = f.kind == "bitbucket";
    let first = if cloud {
        format!("/repositories/{}/commit/{sha}/statuses?pagelen=100", f.project)
    } else {
        format!("/rest/build-status/1.0/commits/{sha}?limit=100")
    };
    let mut out = Vec::new();
    let mut path = Some(first);
    for _ in 0..50 {
        let Some(current) = path.take() else { break };
        let v = get(&current)?;
        for st in v.get("values").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
            let name = Some(s(&st, "name")).filter(|n| !n.is_empty()).unwrap_or_else(|| s(&st, "key"));
            out.push(Check { name, state: norm_state(&s(&st, "state").to_lowercase()), url: Some(s(&st, "url")).filter(|u| !u.is_empty()) });
        }
        path = if cloud {
            // `next` is an absolute URL on the same API; anything else is ignored.
            v.get("next").and_then(|n| n.as_str()).and_then(|n| n.strip_prefix(f.api.as_str())).map(String::from)
        } else if v.get("isLastPage").and_then(|b| b.as_bool()) == Some(false) {
            v.get("nextPageStart").and_then(|n| n.as_u64()).map(|start| format!("/rest/build-status/1.0/commits/{sha}?limit=100&start={start}"))
        } else {
            None
        };
    }
    if path.is_some() {
        // More than 50 pages: report it rather than a possibly incomplete green.
        out.push(Check { name: "More statuses than Revqora loads".into(), state: "pending".into(), url: None });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_bitbucket_cloud_and_server() {
        let c = forge_for("git@bitbucket.org:team/app.git", "origin").unwrap();
        assert_eq!((c.kind.as_str(), c.project.as_str(), c.api.as_str()), ("bitbucket", "team/app", "https://api.bitbucket.org/2.0"));
        assert_eq!(c.web_url, "https://bitbucket.org/team/app");
        let s = forge_for("https://dev@bitbucket.corp.example/scm/PROJ/service.git", "origin").unwrap();
        assert_eq!((s.kind.as_str(), s.project.as_str(), s.api.as_str()), ("bitbucket-server", "PROJ/service", "https://bitbucket.corp.example"));
        assert_eq!(s.web_url, "https://bitbucket.corp.example/projects/PROJ/repos/service");
        let ctx = forge_for("https://bitbucket.corp.example/bitbucket/scm/PROJ/service.git", "origin").unwrap();
        assert_eq!(ctx.api, "https://bitbucket.corp.example/bitbucket");
        let ssh = forge_for("ssh://git@bitbucket.corp.example:7999/PROJ/service.git", "origin").unwrap();
        assert_eq!((ssh.kind.as_str(), ssh.project.as_str()), ("bitbucket-server", "PROJ/service"));
        assert!(forge_for("https://example.com/a/b.git", "origin").is_none());
    }

    #[test]
    fn parses_bitbucket_pull_requests() {
        let cloud = serde_json::json!({
            "id": 7, "title": "Add login", "state": "OPEN", "draft": false, "created_on": "2026-10-20T10:00:00.000000+00:00",
            "author": { "display_name": "Sam Chen", "nickname": "sam" },
            "source": { "branch": { "name": "feature/login" }, "commit": { "hash": "abc123def456" } },
            "destination": { "branch": { "name": "main" } },
            "links": { "html": { "href": "https://bitbucket.org/team/app/pull-requests/7" } }
        });
        let pr = bb_pr(&cloud);
        assert_eq!((pr.number, pr.author.as_str(), pr.head.as_str(), pr.base.as_str(), pr.state.as_str()), (7, "sam", "feature/login", "main", "open"));
        let server = serde_json::json!({
            "id": 12, "title": "Fix", "state": "OPEN", "createdDate": 1_767_225_600_000_i64,
            "author": { "user": { "name": "jblake", "displayName": "Jordan Blake" } },
            "fromRef": { "displayId": "bugfix/x", "latestCommit": "0123abcd" },
            "toRef": { "displayId": "develop" },
            "links": { "self": [{ "href": "https://bitbucket.corp.example/projects/PROJ/repos/service/pull-requests/12" }] }
        });
        let pr = bbs_pr(&server);
        assert_eq!((pr.number, pr.author.as_str(), pr.head.as_str(), pr.base.as_str()), (12, "jblake", "bugfix/x", "develop"));
        assert_eq!(pr.created, "2026-01-01T00:00:00Z");
        assert!(pr.url.ends_with("/pull-requests/12"));
    }

    #[test]
    fn bitbucket_statuses_follow_every_page() {
        let cloud = forge_for("git@bitbucket.org:team/app.git", "origin").unwrap();
        let mut seen = Vec::new();
        let checks = bitbucket_statuses(&cloud, "abc", |path| {
            seen.push(path.to_string());
            Ok(if seen.len() == 1 {
                serde_json::json!({ "values": [{ "key": "build", "state": "SUCCESSFUL" }], "next": "https://api.bitbucket.org/2.0/repositories/team/app/commit/abc/statuses?page=2" })
            } else {
                serde_json::json!({ "values": [{ "key": "lint", "state": "FAILED" }] })
            })
        })
        .unwrap();
        assert_eq!(seen[1], "/repositories/team/app/commit/abc/statuses?page=2");
        assert_eq!(checks.iter().map(|c| c.state.as_str()).collect::<Vec<_>>(), ["success", "failure"]);

        let server = forge_for("https://bitbucket.corp.example/scm/PROJ/service.git", "origin").unwrap();
        let mut seen = Vec::new();
        let checks = bitbucket_statuses(&server, "abc", |path| {
            seen.push(path.to_string());
            Ok(if seen.len() == 1 {
                serde_json::json!({ "values": [{ "key": "build", "state": "SUCCESSFUL" }], "isLastPage": false, "nextPageStart": 100 })
            } else {
                serde_json::json!({ "values": [{ "key": "deploy", "state": "FAILED" }], "isLastPage": true })
            })
        })
        .unwrap();
        assert_eq!(seen[1], "/rest/build-status/1.0/commits/abc?limit=100&start=100");
        assert!(checks.iter().any(|c| c.state == "failure"), "the only failure is on page two");
    }

    #[test]
    fn helpers() {
        assert_eq!(base64(b"user:app-pass"), "dXNlcjphcHAtcGFzcw==");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_millis(951_782_400_000), "2000-02-29T00:00:00Z");
        assert_eq!(error_message(&serde_json::json!({ "error": { "message": "bad" } })).as_deref(), Some("bad"));
        assert_eq!(error_message(&serde_json::json!({ "errors": [{ "message": "nope" }] })).as_deref(), Some("nope"));
        assert_eq!(norm_state("successful"), "success");
    }

    #[test]
    fn parses_remote_urls() {
        assert_eq!(parse_remote("https://github.com/owner/repo.git"), Some(("github.com".into(), "owner/repo".into())));
        assert_eq!(parse_remote("git@github.com:owner/repo.git"), Some(("github.com".into(), "owner/repo".into())));
        assert_eq!(parse_remote("ssh://git@gitlab.example.com:2222/group/sub/proj.git"), Some(("gitlab.example.com".into(), "group/sub/proj".into())));
        assert_eq!(parse_remote("https://user@gitlab.com/g/p"), Some(("gitlab.com".into(), "g/p".into())));
        assert_eq!(parse_remote("C:/local/path"), None);
        assert_eq!(parse_remote("../origin.git"), None);
    }
}
