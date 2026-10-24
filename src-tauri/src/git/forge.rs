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
    let Some((host, project)) = parse_remote(&r.fetch_url) else { return Ok(None) };
    let (kind, api) = if host == "github.com" {
        ("github", "https://api.github.com".to_string())
    } else if host.contains("github") {
        ("github", format!("https://{host}/api/v3"))
    } else if host.contains("gitlab") {
        ("gitlab", format!("https://{host}/api/v4"))
    } else {
        return Ok(None);
    };
    Ok(Some(ForgeInfo { kind: kind.into(), web_url: format!("https://{host}/{project}"), host, project, remote: r.name.clone(), api }))
}

static TOKENS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn token(repo: &Path, host: &str) -> GitResult<String> {
    if let Some(t) = TOKENS.lock().as_ref().and_then(|m| m.get(host).cloned()) {
        return Ok(t);
    }
    let input = format!("protocol=https\nhost={host}\n\n");
    let out = runner::exec_full(repo, ["credential", "fill"], &[], Some(input.as_bytes()))?;
    if !out.ok() {
        return Err(GitError::new(format!("No credentials for {host}. Push or fetch once so git can sign you in, then try again.")).kind("auth"));
    }
    let pass = out.text().lines().find_map(|l| l.strip_prefix("password=").map(|s| s.to_string())).unwrap_or_default();
    if pass.is_empty() {
        return Err(GitError::new(format!("Git returned no token for {host}.")).kind("auth"));
    }
    TOKENS.lock().get_or_insert_with(HashMap::new).insert(host.to_string(), pass.clone());
    Ok(pass)
}

fn forget(host: &str) {
    if let Some(m) = TOKENS.lock().as_mut() {
        m.remove(host);
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).user_agent("Revqora").build()
}

fn request(repo: &Path, f: &ForgeInfo, method: &str, path: &str, body: Option<Value>) -> GitResult<Value> {
    let tok = token(repo, &f.host)?;
    let url = format!("{}{}", f.api, path);
    let mut req = agent().request(method, &url);
    req = if f.kind == "github" {
        req.set("Authorization", &format!("Bearer {tok}")).set("Accept", "application/vnd.github+json")
    } else {
        req.set("Authorization", &format!("Bearer {tok}"))
    };
    let res = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match res {
        Ok(r) => r.into_json::<Value>().map_err(|e| GitError::new(format!("Unexpected response: {e}"))),
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string())).unwrap_or(text);
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

pub fn list(repo: &Path) -> GitResult<(ForgeInfo, Vec<PullRequest>)> {
    let f = detect(repo)?.ok_or_else(|| GitError::new("The remote is not on GitHub or GitLab."))?;
    let prs = if f.kind == "github" {
        let v = request(repo, &f, "GET", &format!("/repos/{}/pulls?state=open&per_page=100", f.project), None)?;
        v.as_array().map(|a| a.iter().map(gh_pr).collect()).unwrap_or_default()
    } else {
        let v = request(repo, &f, "GET", &format!("/projects/{}/merge_requests?state=opened&per_page=100", enc(&f.project)), None)?;
        v.as_array().map(|a| a.iter().map(gl_mr).collect()).unwrap_or_default()
    };
    Ok((f, prs))
}

pub fn create(repo: &Path, title: &str, body: &str, head: &str, base: &str, draft: bool) -> GitResult<PullRequest> {
    let f = detect(repo)?.ok_or_else(|| GitError::new("The remote is not on GitHub or GitLab."))?;
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
    let f = detect(repo)?.ok_or_else(|| GitError::new("The remote is not on GitHub or GitLab."))?;
    let src = if f.kind == "github" { format!("pull/{number}/head") } else { format!("merge-requests/{number}/head") };
    let local = format!("pr/{number}");
    runner::run(repo, ["fetch", &f.remote, &format!("+{src}:refs/heads/{local}")])?;
    runner::run(repo, ["switch", &local])?;
    Ok(local)
}

fn norm_state(s: &str) -> String {
    match s {
        "success" | "passed" => "success",
        "failure" | "failed" | "error" | "timed_out" | "action_required" => "failure",
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
    } else {
        let v = request(repo, &f, "GET", &format!("/projects/{}/repository/commits/{sha}/statuses", enc(&f.project)), None)?;
        for st in v.as_array().cloned().unwrap_or_default() {
            out.push(Check { name: s(&st, "name"), state: norm_state(&s(&st, "status")), url: Some(s(&st, "target_url")).filter(|u| !u.is_empty()) });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::parse_remote;

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
