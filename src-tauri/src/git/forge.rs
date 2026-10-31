//! Pull / merge requests and CI status for GitHub and GitLab remotes.
//!
//! API accounts are selected per remote. Git credential fallback is scoped to each lookup;
//! managed tokens are session-only or stored in the encrypted portable vault.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::runner::{self, GitError, GitResult};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForgeInfo {
    /// GitHub, GitLab, Azure DevOps and Bitbucket integrations.
    pub kind: String,
    pub host: String,
    /// "owner/repo" (GitLab: full project path, may contain groups)
    pub project: String,
    pub remote: String,
    pub web_url: String,
    pub api: String,
    pub connection_revision: Option<String>,
    pub account_login: Option<String>,
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

/// Parse network remotes without returning embedded credentials or query data.
pub fn parse_remote(value: &str) -> Option<(String, String)> {
    let value = value.trim();
    let (host, path, encoded) = if value.contains("://") {
        let u = url::Url::parse(value).ok()?;
        if !["https", "http", "ssh"].contains(&u.scheme()) || u.query().is_some() || u.fragment().is_some() {
            return None;
        }
        let host = if u.scheme() != "ssh" {
            u.port().map(|p| format!("{}:{p}", u.host_str().unwrap_or(""))).unwrap_or_else(|| u.host_str().unwrap_or("").into())
        } else {
            u.host_str()?.to_owned()
        };
        (host, u.path().to_owned(), true)
    } else {
        let (user_host, p) = value.split_once(':')?;
        if user_host.contains('/') || p.starts_with("//") || user_host.len() == 1 {
            return None;
        }
        (user_host.rsplit('@').next()?.into(), p.into(), false)
    };
    if host.is_empty() || host.chars().any(char::is_control) {
        return None;
    }
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let segments = path
        .split('/')
        .map(|s| {
            let v = if encoded { percent_encoding::percent_decode_str(s).decode_utf8().ok()?.into_owned() } else { s.to_owned() };
            (!v.is_empty() && v != "." && v != ".." && !v.contains(['/', '\\']) && !v.chars().any(char::is_control)).then_some(v)
        })
        .collect::<Option<Vec<_>>>()?;
    (segments.len() >= 2).then(|| (host.to_ascii_lowercase(), segments.join("/")))
}

pub fn detect(repo: &Path) -> GitResult<Option<ForgeInfo>> {
    Ok(super::forge_accounts::context(repo)?.map(|c| c.info))
}

/// Azure's HTTPS, legacy visualstudio.com and v3 SSH forms share one project/repository.
pub fn azure_project(url: &str, server: &str) -> Option<String> {
    let (host, path) = parse_remote(url)?;
    let base = url::Url::parse(server).ok()?;
    let (host_expected, prefix) = (base.host_str()?, base.path().trim_matches('/'));
    if host == "ssh.dev.azure.com" {
        let p = path.strip_prefix("v3/")?;
        let (org, repo) = p.split_once('/')?;
        return (host_expected == "dev.azure.com" && org == prefix && repo.split('/').count() == 2).then(|| repo.to_owned());
    }
    let rest = if host.ends_with(".visualstudio.com") {
        if host_expected != "dev.azure.com" || host.strip_suffix(".visualstudio.com")? != prefix {
            return None;
        }
        if path.split('/').count() == 4 {
            path.strip_prefix("DefaultCollection/")?.to_owned()
        } else {
            path
        }
    } else {
        if host != base.port().map(|p| format!("{host_expected}:{p}")).unwrap_or_else(|| host_expected.into()) {
            return None;
        }
        if prefix.is_empty() {
            path
        } else {
            path.strip_prefix(&format!("{prefix}/"))?.to_owned()
        }
    };
    let p: Vec<_> = rest.split('/').collect();
    (p.len() == 3 && p[1] == "_git").then(|| format!("{}/{}", p[0], p[2]))
}

/// Works out the forge and its API from a remote URL.
pub fn forge_for(url: &str, remote: &str) -> Option<ForgeInfo> {
    let (host, project) = parse_remote(url)?;
    let info = |kind: &str, project: String, web_url: String, api: String| {
        Some(ForgeInfo { kind: kind.into(), host: host.clone(), project, remote: remote.into(), web_url, api, connection_revision: None, account_login: None })
    };
    if host == "dev.azure.com" || host == "ssh.dev.azure.com" || host.ends_with(".visualstudio.com") {
        let org = if host == "ssh.dev.azure.com" {
            project.strip_prefix("v3/")?.split('/').next()?
        } else if host == "dev.azure.com" {
            project.split('/').next()?
        } else {
            host.strip_suffix(".visualstudio.com")?
        };
        let server = format!("https://dev.azure.com/{org}");
        let project = azure_project(url, &server)?;
        let (p, r) = project.split_once('/')?;
        return info("azure", project.clone(), format!("{server}/{}/_git/{}", enc(p), enc(r)), server);
    }
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

/// Git helper lookups are scoped to this repository, URL path and username; never cached by host.
fn token(repo: &Path, url: &str) -> GitResult<super::forge_accounts::Credential> {
    let (host, path) = parse_remote(url).ok_or_else(|| GitError::new("Unsupported credential URL").kind("auth"))?;
    let username = url::Url::parse(url).ok().filter(|u| matches!(u.scheme(), "http" | "https")).map(|u| u.username().to_owned()).unwrap_or_default();
    let username =
        percent_encoding::percent_decode_str(&username).decode_utf8().map_err(|_| GitError::new("Invalid credential username").kind("auth"))?.into_owned();
    if username.chars().any(char::is_control) {
        return Err(GitError::new("Invalid credential username").kind("auth"));
    }
    let git_path = url::Url::parse(url)
        .ok()
        .map(|u| percent_encoding::percent_decode_str(u.path().trim_start_matches('/')).decode_utf8_lossy().into_owned())
        .unwrap_or_else(|| url.split_once(':').map(|(_, p)| p.into()).unwrap_or(path));
    let user = if username.is_empty() { String::new() } else { format!("username={username}\n") };
    let input = format!("protocol=https\nhost={host}\npath={git_path}\n{user}\n");
    let out = crate::journal::suspend(|| {
        runner::exec_full(
            repo,
            ["-c", "credential.useHttpPath=true", "-c", "credential.interactive=false", "-c", "core.askPass=", "credential", "fill"],
            &[("GIT_ASKPASS", ""), ("GCM_INTERACTIVE", "never"), ("GIT_TERMINAL_PROMPT", "0")],
            Some(input.as_bytes()),
        )
    })?;
    if !out.ok() {
        return Err(GitError::new("No Git credential is available for this remote. Add an API account or sign in with Git first.").kind("auth"));
    }
    let text = zeroize::Zeroizing::new(out.text());
    let field = |key: &str| text.lines().find_map(|l| l.strip_prefix(key)).unwrap_or("").to_owned();
    let pass = field("password=");
    if pass.is_empty() {
        return Err(GitError::new("Git returned no API credential. Add an API account.").kind("auth"));
    }
    Ok(super::forge_accounts::Credential { username: field("username="), token: pass, mode: "bearer".into() })
}

pub(crate) fn base64(input: &[u8]) -> String {
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

pub(super) fn request(repo: &Path, f: &ForgeInfo, method: &str, path: &str, body: Option<Value>) -> GitResult<Value> {
    authorized(repo, f, |credential| super::forge_accounts::request_json(&f.kind, &f.api, credential, method, path, body.clone()))
}

pub(super) fn raw_request(repo: &Path, f: &ForgeInfo, path: &str, accept: &str, limit: u64, redirect: bool) -> GitResult<super::forge_accounts::ApiContent> {
    authorized(repo, f, |credential| super::forge_accounts::request_content(&f.kind, &f.api, credential, "GET", path, None, accept, limit, redirect))
}

pub(super) fn graphql(repo: &Path, f: &ForgeInfo, query: &str, variables: Value) -> GitResult<Value> {
    graphql_as(repo, f, query, variables, None)
}
pub(super) fn graphql_as(repo: &Path, f: &ForgeInfo, query: &str, variables: Value, actor: Option<&str>) -> GitResult<Value> {
    if f.kind != "github" {
        return Err(GitError::new("GraphQL is only configured for GitHub."));
    }
    let (base, path) = match f.api.strip_suffix("/api/v3") {
        Some(base) => (base, "/api/graphql"),
        None => (f.api.as_str(), "/graphql"),
    };
    let v = authorized(repo, f, |c| {
        if let Some(actor) = actor {
            check_actor(f, c, actor)?;
        }
        super::forge_accounts::request_json("github", base, c, "POST", path, Some(serde_json::json!({"query":query,"variables":variables})))
    })?;
    if v.get("errors").and_then(Value::as_array).is_some_and(|e| !e.is_empty()) || v.get("data").is_none_or(Value::is_null) {
        return Err(
            GitError::new("GitHub GraphQL rejected the request. Check token permissions and server support; refresh before retrying.").kind("forge-graphql")
        );
    }
    Ok(v["data"].clone())
}

/// Some writes return 204. An empty success body is not a failed JSON response.
pub(super) fn write_api(repo: &Path, f: &ForgeInfo, method: &str, path: &str, body: Option<Value>, actor: &str) -> GitResult<()> {
    authorized(repo, f, |c| {
        check_actor(f, c, actor)?;
        super::forge_accounts::request_content(&f.kind, &f.api, c, method, path, body.clone(), "application/json", 4 * 1024 * 1024, false)
    })
    .map(|_| ())
}

fn check_actor(f: &ForgeInfo, c: &super::forge_accounts::Credential, expected: &str) -> GitResult<()> {
    if f.kind == "bitbucket-server" {
        return if expected == "git-credentials" { Ok(()) } else { Err(GitError::new("Unverified review identity.").kind("stale-operation")) };
    }
    let path = if f.kind == "azure" { "/_apis/connectionData?api-version=7.1-preview.1" } else { "/user" };
    let v = super::forge_accounts::request_json(&f.kind, &f.api, c, "GET", path, None)?;
    let key = match f.kind.as_str() {
        "azure" => "/authenticatedUser/id",
        "bitbucket" => "/uuid",
        _ => "/id",
    };
    let actual = v.pointer(key).map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())).unwrap_or_default();
    if actual.is_empty() || actual != expected {
        return Err(GitError::new("The review identity changed. Refresh before sending.").kind("stale-operation"));
    }
    Ok(())
}

fn authorized<T>(repo: &Path, f: &ForgeInfo, send: impl Fn(&super::forge_accounts::Credential) -> GitResult<T>) -> GitResult<T> {
    let context = super::forge_accounts::context(repo)?.ok_or_else(|| GitError::new("Configure an API connection first."))?;
    if context.info != *f {
        return Err(GitError::new("The API connection changed. Refresh before trying again.").kind("stale-operation"));
    }
    let explicit = context.credential.is_some();
    let mut credential = match context.credential {
        Some(c) => c,
        None => token(repo, &context.git_url)?,
    };
    let result = send(&credential);
    if is_bitbucket(f)
        && !explicit
        && !credential.username.is_empty()
        && matches!(&result,Err(e) if e.kind=="auth"&&e.message=="Token rejected. Reconnect this account.")
    {
        credential.mode = "basic".into();
        return send(&credential);
    }
    result
}

pub(crate) fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// GitHub / GitLab `message`, Bitbucket Cloud `error.message`, Bitbucket Server `errors[0].message`.
#[cfg(test)]
fn error_message(v: &Value) -> Option<String> {
    v.get("message").or_else(|| v.pointer("/error/message")).or_else(|| v.pointer("/errors/0/message")).and_then(|m| m.as_str()).map(String::from)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

pub(super) fn gh_pr(v: &Value) -> PullRequest {
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

pub(super) fn gl_mr(v: &Value) -> PullRequest {
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

pub(super) fn project_path(s: &str) -> String {
    s.split('/').map(enc).collect::<Vec<_>>().join("/")
}

pub(super) fn azure_repo(f: &ForgeInfo) -> String {
    let (p, r) = f.project.split_once('/').unwrap_or((&f.project, ""));
    format!("/{}/_apis/git/repositories/{}", enc(p), enc(r))
}
pub(super) fn azure_pr(v: &Value, f: &ForgeInfo) -> PullRequest {
    let number = v.get("pullRequestId").and_then(Value::as_u64).unwrap_or(0);
    PullRequest {
        number,
        title: s(v, "title"),
        author: p(v, "/createdBy/displayName"),
        head: s(v, "sourceRefName").strip_prefix("refs/heads/").unwrap_or(&s(v, "sourceRefName")).into(),
        base: s(v, "targetRefName").strip_prefix("refs/heads/").unwrap_or(&s(v, "targetRefName")).into(),
        url: format!("{}/pullrequest/{number}", f.web_url),
        draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        state: s(v, "status"),
        created: s(v, "creationDate"),
        head_sha: p(v, "/lastMergeSourceCommit/commitId"),
    }
}

pub(super) fn server_repo(f: &ForgeInfo) -> String {
    let (key, slug) = f.project.split_once('/').unwrap_or((&f.project, ""));
    format!("/rest/api/1.0/projects/{}/repos/{}", enc(key), enc(slug))
}

pub fn list(repo: &Path) -> GitResult<(ForgeInfo, Vec<PullRequest>)> {
    let f = detect(repo)?.ok_or_else(|| GitError::new("The remote is not on GitHub, GitLab or Bitbucket."))?;
    let prs = if f.kind == "azure" {
        let v = request(repo, &f, "GET", &format!("{}/pullrequests?searchCriteria.status=active&$top=100&api-version=7.1", azure_repo(&f)), None)?;
        v.get("value").and_then(Value::as_array).map(|a| a.iter().map(|v| azure_pr(v, &f)).collect()).unwrap_or_default()
    } else if f.kind == "github" {
        let v = request(repo, &f, "GET", &format!("/repos/{}/pulls?state=open&per_page=100", project_path(&f.project)), None)?;
        v.as_array().map(|a| a.iter().map(gh_pr).collect()).unwrap_or_default()
    } else if f.kind == "bitbucket" {
        let v = request(repo, &f, "GET", &format!("/repositories/{}/pullrequests?state=OPEN&pagelen=50", project_path(&f.project)), None)?;
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

pub(super) fn reviewed_connection(repo: &Path, expected: &str) -> GitResult<ForgeInfo> {
    let f = detect(repo)?.ok_or_else(|| GitError::new("Configure an API connection first."))?;
    if expected.is_empty() || f.connection_revision.as_deref() != Some(expected) {
        return Err(GitError::new("The API account or remote changed. Reload the pull request view before continuing.").kind("stale-operation"));
    }
    Ok(f)
}

pub fn create(repo: &Path, title: &str, body: &str, head: &str, base: &str, draft: bool, expected_connection: &str) -> GitResult<PullRequest> {
    let f = reviewed_connection(repo, expected_connection)?;
    if f.kind == "azure" {
        let v = request(
            repo,
            &f,
            "POST",
            &format!("{}/pullrequests?api-version=7.1", azure_repo(&f)),
            Some(
                serde_json::json!({"title":title,"description":body,"sourceRefName":format!("refs/heads/{head}"),"targetRefName":format!("refs/heads/{base}"),"isDraft":draft}),
            ),
        )?;
        return Ok(azure_pr(&v, &f));
    }
    if f.kind == "bitbucket" {
        let v = request(
            repo,
            &f,
            "POST",
            &format!("/repositories/{}/pullrequests", project_path(&f.project)),
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
            &format!("/repos/{}/pulls", project_path(&f.project)),
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

/// Check out the reviewed source commit on a SHA-specific branch. Existing history is never forced.
pub fn checkout(repo: &Path, number: u64, expected_connection: &str, expected_head: &str) -> GitResult<String> {
    if !matches!(expected_head.len(), 40 | 64) || !expected_head.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("Reload the PR to review its complete source commit before checkout."));
    }
    let f = reviewed_connection(repo, expected_connection)?;
    let mut remote = f.remote.clone();
    let source = match f.kind.as_str() {
        "azure" => {
            let v = request(repo, &f, "GET", &format!("{}/pullrequests/{number}?api-version=7.1", azure_repo(&f)), None)?;
            if p(&v, "/lastMergeSourceCommit/commitId") != expected_head {
                return Err(GitError::new("The PR source changed. Refresh before checkout.").kind("stale-operation"));
            }
            expected_head.to_owned()
        }
        "bitbucket" => {
            let v = request(repo, &f, "GET", &format!("/repositories/{}/pullrequests/{number}", project_path(&f.project)), None)?;
            if p(&v, "/source/commit/hash") != expected_head {
                return Err(GitError::new("The PR source changed. Refresh before checkout.").kind("stale-operation"));
            }
            let branch = p(&v, "/source/branch/name");
            if !runner::exec(repo, ["check-ref-format", &format!("refs/heads/{branch}")])?.ok() {
                return Err(GitError::new("The server returned an invalid source branch."));
            }
            let from = p(&v, "/source/repository/full_name");
            if !from.is_empty() && !from.eq_ignore_ascii_case(&f.project) {
                if from.split('/').count() != 2 || from.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
                    return Err(GitError::new("Invalid fork repository path."));
                }
                remote = format!("https://bitbucket.org/{}.git", project_path(&from));
            }
            format!("refs/heads/{branch}")
        }
        "github" => format!("refs/pull/{number}/head"),
        "bitbucket-server" => format!("refs/pull-requests/{number}/from"),
        _ => format!("refs/merge-requests/{number}/head"),
    };
    reviewed_connection(repo, expected_connection)?;
    fetch_pr_branch(repo, &remote, &source, number, expected_head)
}
fn fetch_pr_branch(repo: &Path, remote: &str, source: &str, number: u64, expected_head: &str) -> GitResult<String> {
    use ring::rand::SecureRandom;
    let mut nonce = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut nonce).map_err(|_| GitError::new("Secure random source unavailable."))?;
    let slot = format!("refs/revqora/recovery/pr-fetch/{}", nonce.iter().map(|b| format!("{b:02x}")).collect::<String>());
    if runner::exec(repo, ["show-ref", "--verify", "--quiet", &slot])?.ok() {
        return Err(GitError::new("Temporary PR reference already exists; no checkout was attempted."));
    }
    let result = (|| {
        runner::run(
            repo,
            [
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                "--refmap=",
                "--no-recurse-submodules",
                "--no-auto-maintenance",
                "--",
                remote,
                &format!("{source}:{slot}"),
            ],
        )?;
        let actual = runner::run(repo, ["rev-parse", "--verify", &format!("{slot}^{{commit}}")])?.trim().to_owned();
        if actual != expected_head {
            return Err(GitError::new("The PR source changed while fetching. Refresh before checkout; existing branches were kept.").kind("stale-operation"));
        }
        let local = format!("pr/{number}-{}", &expected_head[..12]);
        let reference = format!("refs/heads/{local}");
        if runner::exec(repo, ["show-ref", "--verify", "--quiet", &reference])?.ok() {
            if runner::exec(repo, ["symbolic-ref", "-q", &reference])?.ok() || runner::run(repo, ["rev-parse", "--verify", &reference])?.trim() != expected_head
            {
                return Err(GitError::new("The PR branch already contains different history or is an alias. It was kept."));
            }
        } else {
            runner::run(repo, ["branch", "--", &local, expected_head])?;
        }
        runner::run(repo, ["switch", "--", &local])?;
        Ok(local)
    })();
    // Remove only this operation's private pin, using its observed object ID.
    if let Ok(out) = runner::run(repo, ["rev-parse", "--verify", &slot]) {
        let oid = out.trim();
        let _ = runner::exec(repo, ["update-ref", "-d", &slot, oid]);
    }
    result
}

fn norm_state(s: &str) -> String {
    match s {
        "success" | "passed" | "successful" | "succeeded" => "success",
        "notApplicable" | "notapplicable" => "neutral",
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
    if !matches!(sha.len(), 40 | 64) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("Choose a complete commit ID for CI checks."));
    }
    let Some(f) = detect(repo)? else { return Ok(Vec::new()) };
    checks_for(repo, &f, sha)
}

pub(super) fn checks_for(repo: &Path, f: &ForgeInfo, sha: &str) -> GitResult<Vec<Check>> {
    if !matches!(sha.len(), 40 | 64) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("Choose a complete commit ID for CI checks."));
    }
    let mut out = Vec::new();
    if f.kind == "azure" {
        let v = request(repo, f, "GET", &format!("{}/commits/{}/statuses?api-version=7.1", azure_repo(f), enc(sha)), None)?;
        for st in v.get("value").and_then(Value::as_array).cloned().unwrap_or_default() {
            out.push(Check {
                name: st.pointer("/context/name").and_then(Value::as_str).unwrap_or("Status").into(),
                state: norm_state(&s(&st, "state")),
                url: Some(s(&st, "targetUrl")).filter(|s| !s.is_empty()),
            });
        }
    } else if f.kind == "github" {
        let runs = request(repo, f, "GET", &format!("/repos/{}/commits/{sha}/check-runs?per_page=100", project_path(&f.project)), None)?;
        for r in runs.get("check_runs").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
            let st = if s(&r, "status") == "completed" { norm_state(&s(&r, "conclusion")) } else { "pending".into() };
            out.push(Check { name: s(&r, "name"), state: st, url: Some(s(&r, "html_url")).filter(|u| !u.is_empty()) });
        }
        let status = request(repo, f, "GET", &format!("/repos/{}/commits/{sha}/status", project_path(&f.project)), None)?;
        for st in status.get("statuses").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
            out.push(Check { name: s(&st, "context"), state: norm_state(&s(&st, "state")), url: Some(s(&st, "target_url")).filter(|u| !u.is_empty()) });
        }
    } else if is_bitbucket(f) {
        out = bitbucket_statuses(f, sha, |path| request(repo, f, "GET", path, None))?;
    } else {
        let v = request(repo, f, "GET", &format!("/projects/{}/repository/commits/{sha}/statuses", enc(&f.project)), None)?;
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
        format!("/repositories/{}/commit/{}/statuses?pagelen=100", project_path(&f.project), enc(sha))
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
        assert_eq!(norm_state("succeeded"), "success");
        assert_eq!(norm_state("notApplicable"), "neutral");
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

#[cfg(test)]
mod connection_tests {
    use super::*;
    #[test]
    fn azure_url_forms_preserve_organization_and_encode_project_and_repository() {
        for url in [
            "https://dev.azure.com/org/Team%20Space/_git/My%20Repo.git",
            "https://org.visualstudio.com/DefaultCollection/Team%20Space/_git/My%20Repo.git",
            "git@ssh.dev.azure.com:v3/org/Team Space/My Repo",
        ] {
            let f = forge_for(url, "upstream").unwrap();
            assert_eq!(f.kind, "azure");
            assert_eq!(f.project, "Team Space/My Repo");
            assert_eq!(azure_repo(&f), "/Team%20Space/_apis/git/repositories/My%20Repo");
        }
        assert_eq!(
            azure_project("https://org.visualstudio.com/DefaultCollection/_git/Repo.git", "https://dev.azure.com/org").as_deref(),
            Some("DefaultCollection/Repo")
        );
        assert!(azure_project("git@ssh.dev.azure.com:v3/other/Team/Repo", "https://dev.azure.com/org").is_none());
        assert_eq!(azure_project("https://server.example/collection/Team/_git/Repo.git", "https://server.example/collection").as_deref(), Some("Team/Repo"));
    }
    #[test]
    fn encoded_names_and_azure_prs_do_not_confuse_path_fragments_or_merge_heads() {
        let (_, p) = parse_remote("https://github.com/team/repo%23name.git").unwrap();
        assert_eq!(project_path(&p), "team/repo%23name");
        assert!(parse_remote("https://github.com/team/repo%2Fother.git").is_none());
        assert!(parse_remote("https://github.com/team/repo?token=secret").is_none());
        let f = forge_for("https://dev.azure.com/org/Team/_git/Repo.git", "origin").unwrap();
        let v = serde_json::json!({"pullRequestId":7,"title":"Test","createdBy":{"displayName":"Alex"},"sourceRefName":"refs/heads/topic","targetRefName":"refs/heads/main","lastMergeSourceCommit":{"commitId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"isDraft":false,"status":"active"});
        let p = azure_pr(&v, &f);
        assert_eq!(p.head, "topic");
        assert_eq!(p.base, "main");
        assert_eq!(p.head_sha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(p.url, "https://dev.azure.com/org/Team/_git/Repo/pullrequest/7");
    }
}

#[cfg(test)]
mod credential_scope_tests {
    use super::*;
    #[test]
    fn ssh_transport_users_do_not_constrain_https_account_matching() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path();
        runner::run(repo, ["init", "-q"]).unwrap();
        runner::run(repo, ["config", "credential.helper", ""]).unwrap();
        runner::run(repo, ["config", "credential.username", "alice"]).unwrap();
        // Match the complete query, not just the requested host.
        let helper = r#"!f() {
username=; protocol=; host=; path=;
while IFS='=' read -r key value; do
  case "$key" in username) username="$value";; protocol) protocol="$value";; host) host="$value";; path) path="$value";; esac
done
if [ "$1" = get ] && [ "$username" = alice ] && [ "$protocol" = https ] && [ "$host" = credential-scope.invalid ] && [ "$path" = team/repo.git ]; then
  printf '%s\n' 'username=alice' 'password=fixture-token-alice'
fi
}; f"#;
        runner::run(repo, ["config", "--add", "credential.helper", helper]).unwrap();
        for url in [
            "git@credential-scope.invalid:team/repo.git",
            "ssh://git@credential-scope.invalid/team/repo.git",
            "ssh://another-transport-user@credential-scope.invalid:2222/team/repo.git",
            "https://alice@credential-scope.invalid/team/repo.git",
            "https://%61lice@credential-scope.invalid/team/repo.git",
        ] {
            let c = token(repo, url).unwrap();
            assert_eq!(c.username, "alice");
            assert_eq!(c.token, "fixture-token-alice");
        }
        assert!(token(repo, "https://bob@credential-scope.invalid/team/repo.git").is_err(), "an explicit HTTPS identity must still constrain the helper");
        assert!(token(repo, "https://alice%0Apassword=injected@credential-scope.invalid/team/repo.git").is_err());
        assert!(!repo.join(".git/index").exists());
    }
    #[test]
    fn git_credentials_are_read_per_repository_without_a_host_cache_or_index_write() {
        let t = tempfile::tempdir().unwrap();
        let setup = |name: &str, user: &str, password: &str| {
            let p = t.path().join(name);
            std::fs::create_dir(&p).unwrap();
            runner::run(&p, ["init", "-q"]).unwrap();
            let helper = format!("!f() {{ printf '%s\n' 'username={user}' 'password={password}'; }}; f");
            runner::run(&p, ["config", "credential.helper", ""]).unwrap();
            runner::run(&p, ["config", "--add", "credential.helper", &helper]).unwrap();
            p
        };
        let a = setup("first", "first", "fixture-token-one");
        let b = setup("second", "second", "fixture-token-two");
        for (repo, user, password) in [(&a, "first", "fixture-token-one"), (&b, "second", "fixture-token-two"), (&a, "first", "fixture-token-one")] {
            let c = super::super::operations::read(repo, || token(repo, "https://credential-scope.invalid/team/repo.git")).unwrap();
            assert_eq!(c.username, user);
            assert_eq!(c.token, password);
            assert!(!repo.join(".git/index").exists());
        }
    }
}

#[cfg(test)]
mod checkout_tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf, String) {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let hooks = t.path().join("no-hooks").to_string_lossy().into_owned();
        runner::run(&source, ["init", "-qb", "main"]).unwrap();
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", hooks.as_str())] {
            runner::run(&source, ["config", k, v]).unwrap();
        }
        std::fs::write(source.join("file.txt"), "base\n").unwrap();
        runner::run(&source, ["add", "."]).unwrap();
        runner::run(&source, ["commit", "-qm", "Base"]).unwrap();
        let base = runner::run(&source, ["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        runner::run(&source, ["update-ref", "refs/pull/7/head", &base]).unwrap();
        let local = t.path().join("local");
        runner::run(t.path(), ["-c", &format!("core.hooksPath={hooks}"), "clone", "-q", source.to_str().unwrap(), local.to_str().unwrap()]).unwrap();
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", hooks.as_str())] {
            runner::run(&local, ["config", k, v]).unwrap();
        }
        (t, source, local, base)
    }
    fn no_pins(root: &Path) {
        assert!(runner::run(root, ["for-each-ref", "refs/revqora/recovery/pr-fetch/"]).unwrap().is_empty());
    }
    #[test]
    fn source_checkout_preserves_existing_pr_history_and_working_changes() {
        let (_t, _source, local, base) = fixture();
        std::fs::write(local.join("file.txt"), "local edit\n").unwrap();
        let branch = fetch_pr_branch(&local, "origin", "refs/pull/7/head", 7, &base).unwrap();
        assert_eq!(runner::run(&local, ["rev-parse", "HEAD"]).unwrap().trim(), base);
        assert_eq!(std::fs::read(local.join("file.txt")).unwrap(), b"local edit\n");
        assert!(runner::exec(&local, ["diff", "--cached", "--exit-code"]).unwrap().ok());
        no_pins(&local);
        runner::run(&local, ["add", "file.txt"]).unwrap();
        runner::run(&local, ["commit", "-qm", "User PR work"]).unwrap();
        let user = runner::run(&local, ["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        runner::run(&local, ["switch", "main"]).unwrap();
        assert!(fetch_pr_branch(&local, "origin", "refs/pull/7/head", 7, &base).is_err());
        assert_eq!(runner::run(&local, ["rev-parse", &format!("refs/heads/{branch}")]).unwrap().trim(), user);
        assert_eq!(runner::run(&local, ["rev-parse", "HEAD"]).unwrap().trim(), base);
        no_pins(&local);
    }
    #[test]
    fn changed_pr_heads_and_symbolic_branch_aliases_are_rejected_without_forcing_refs() {
        let (_t, source, local, base) = fixture();
        std::fs::write(source.join("new.txt"), "PR change\n").unwrap();
        runner::run(&source, ["add", "."]).unwrap();
        runner::run(&source, ["commit", "-qm", "New source"]).unwrap();
        let tip = runner::run(&source, ["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        runner::run(&source, ["update-ref", "refs/pull/7/head", &tip]).unwrap();
        assert_eq!(fetch_pr_branch(&local, "origin", "refs/pull/7/head", 7, &base).err().unwrap().kind, "stale-operation");
        assert_eq!(runner::run(&local, ["rev-parse", "HEAD"]).unwrap().trim(), base);
        no_pins(&local);
        runner::run(&local, ["branch", "kept", &tip]).unwrap();
        let alias = format!("refs/heads/pr/7-{}", &tip[..12]);
        runner::run(&local, ["symbolic-ref", &alias, "refs/heads/kept"]).unwrap();
        assert!(fetch_pr_branch(&local, "origin", "refs/pull/7/head", 7, &tip).is_err());
        assert_eq!(runner::run(&local, ["symbolic-ref", &alias]).unwrap().trim(), "refs/heads/kept");
        assert_eq!(runner::run(&local, ["rev-parse", "refs/heads/kept"]).unwrap().trim(), tip);
        no_pins(&local);
    }
}
