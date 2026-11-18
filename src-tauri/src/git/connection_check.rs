//! "Check connection": Git read and write access and each API capability of one remote,
//! each with its own result, cause and next step. Nothing is pushed, fetched or changed.
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::runner::{self, GitError, GitResult};

const GIT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// git-read, git-write, profile, pull-requests, files, checks
    pub id: &'static str,
    pub label: String,
    /// ok, failed, limited (works partly), not-verified, skipped
    pub state: &'static str,
    pub detail: String,
    /// no-credentials, token-rejected, permission, not-found, timeout, rate-limit, network,
    /// server, ssh-host, invalid-response, other
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub repository: String,
    pub remote: Option<String>,
    /// The fetch URL without user name or password.
    pub url: Option<String>,
    /// https, ssh, local or other
    pub transport: Option<&'static str>,
    pub provider: Option<String>,
    pub project: Option<String>,
    pub credential_source: Option<String>,
    pub items: Vec<Item>,
}

fn item(id: &'static str, label: &str, state: &'static str, detail: impl Into<String>, started: Instant) -> Item {
    Item {
        id,
        label: label.into(),
        state,
        detail: detail.into(),
        cause: None,
        next: None,
        code: None,
        http_status: None,
        request_id: None,
        ms: started.elapsed().as_millis() as u64,
    }
}

fn skipped(id: &'static str, label: &str, detail: impl Into<String>) -> Item {
    item(id, label, "skipped", detail, Instant::now())
}

/// A failed step: the error's own message, its cause, a next step and the HTTP facts.
fn failed(id: &'static str, label: &str, error: &GitError, git: bool, started: Instant) -> Item {
    let (cause, next) = if git { git_cause(error) } else { api_cause(error) };
    let detail_value = |key: &str| error.details.iter().find_map(|detail| detail.strip_prefix(key)).map(str::to_owned);
    let state = if error.kind == "identity-unavailable" { "limited" } else { "failed" };
    Item {
        cause: Some(cause),
        next: Some(next),
        code: Some(error.kind.clone()).filter(|kind| !kind.is_empty()),
        http_status: detail_value("http_status=").and_then(|s| s.parse().ok()),
        request_id: detail_value("request_id="),
        ..item(id, label, state, error.message.clone(), started)
    }
}

/// Cause and next step for a failed Git command, from Git's own message.
pub fn git_cause(error: &GitError) -> (&'static str, String) {
    let text = format!("{}\n{}", error.message, error.stderr).to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if error.kind == "git-timeout" || has(&["timed out", "time limit"]) {
        ("timeout", "The server did not answer in time. Check the network, VPN or proxy and try again.".into())
    } else if has(&["host key verification failed", "remote host identification has changed"]) {
        ("ssh-host", "Verify the server's SSH host key, then add it to known hosts (or review it in Git connection settings).".into())
    } else if has(&["permission denied (publickey", "no supported authentication methods", "too many authentication failures"]) {
        ("token-rejected", "The server rejected the SSH key. Add your public key to the provider or choose another key in Git connection settings.".into())
    } else if has(&["could not read username", "could not read password", "unable to get password", "terminal prompts disabled", "no credential"]) {
        ("no-credentials", "No saved Git credential for this remote. Sign in once with Fetch, or choose a token in Git connection settings.".into())
    } else if has(&["authentication failed", "invalid username or password", "http basic: access denied", "bad credentials", "invalid credentials", " 401"]) {
        ("token-rejected", "The saved Git credential was rejected. Sign in again or replace the token in Git connection settings.".into())
    } else if has(&["rate limit", " 429"]) {
        ("rate-limit", "The provider is limiting requests. Wait and try again.".into())
    } else if has(&[
        "permission to",
        "access denied",
        "not allowed to push",
        "write access to repository not granted",
        "denied to",
        "insufficient permission",
        "requested url returned error: 403",
        "you do not have permission",
    ]) {
        ("permission", "This credential can't do this on the repository. Ask for access, or use a token with write (push) permission.".into())
    } else if has(&["repository not found", "not found", "does not appear to be a git repository", "does not exist"]) {
        ("not-found", "Check the remote URL. Private repositories also answer \"not found\" when the credential has no access.".into())
    } else if has(&[
        "could not resolve host",
        "failed to connect",
        "connection refused",
        "network is unreachable",
        "could not connect",
        "ssl",
        "certificate",
        "proxy",
    ]) {
        ("network", "Revqora could not reach the server. Check the URL, network, proxy and TLS certificate settings.".into())
    } else {
        ("other", "See the message. Copy diagnostics to report it.".into())
    }
}

/// Cause and next step for a failed API request.
pub fn api_cause(error: &GitError) -> (&'static str, String) {
    let status = error.details.iter().find_map(|detail| detail.strip_prefix("http_status=")).and_then(|s| s.parse::<u16>().ok());
    let message = error.message.to_lowercase();
    match error.kind.as_str() {
        "identity-unavailable" => {
            ("permission", "Pull requests can still work. To show your profile, grant the token permission to read the user account.".into())
        }
        "forge-rate-limit" => {
            let wait = error.details.iter().find_map(|detail| detail.strip_prefix("retry_after="));
            (
                "rate-limit",
                wait.map_or("Wait until the provider's limit resets, then check again.".into(), |s| {
                    format!("Wait {s} s (the provider's Retry-After), then check again.")
                }),
            )
        }
        "forge-timeout" => ("timeout", "The provider did not answer in time. Try again; check the network or proxy if it repeats.".into()),
        "forge-network" => ("network", "Revqora could not reach the API. Check the server URL, network, proxy and TLS certificate.".into()),
        "forge-server" => ("server", "The provider reported a server error. Try again later or check its status page.".into()),
        "pr-connection-required" => ("no-credentials", "Choose an API account for this repository in PR Center or Accounts.".into()),
        _ if status == Some(401) => ("token-rejected", "Reconnect the account or replace its token in Accounts.".into()),
        _ if status == Some(403) => ("permission", "Grant the token read access to this repository (see the message for the scopes).".into()),
        _ if status == Some(404) => ("not-found", "Check the repository path. A private repository also answers 404 without access.".into()),
        _ if message.contains("no git credential") || message.contains("no api credential") || message.contains("configure an api connection") => {
            ("no-credentials", "Add an API account in Accounts, or sign in with Git once.".into())
        }
        _ if message.contains("invalid json") || message.contains("incomplete") || message.contains("invalid") && message.contains("response") => {
            ("invalid-response", "The provider's answer was incomplete. Try again; report it with diagnostics if it repeats.".into())
        }
        _ => ("other", "See the message. Copy diagnostics to report it.".into()),
    }
}

/// The remote's URL without credentials (user name and password removed).
pub fn clean_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) if !matches!(parsed.scheme(), "file") => {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            let mut text = parsed.to_string();
            if !url.ends_with('/') && text.ends_with('/') && parsed.path() == "/" {
                text.pop();
            }
            text
        }
        // scp-like SSH (git@host:path) keeps its user name: it is not a secret.
        _ => crate::journal::redact::text(url),
    }
}

pub fn transport(url: &str) -> &'static str {
    match url::Url::parse(url).map(|u| u.scheme().to_owned()).as_deref() {
        Ok("https" | "http") => "https",
        Ok("ssh" | "git+ssh") => "ssh",
        Ok("file") => "local",
        Ok(_) if url.len() > 2 && url.as_bytes()[1] == b':' => "local",
        Ok(_) => "other",
        Err(_) if url.contains(':') && !url.contains("://") && !Path::new(url).exists() => "ssh",
        Err(_) => "local",
    }
}

fn ssh_configured(repo: &Path) -> bool {
    std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || super::connection::managed_ssh(repo).unwrap_or(false)
        || super::config_cache::run(repo, &["config", "--get", "core.sshCommand"]).is_ok_and(|s| !s.trim().is_empty())
}

/// Runs a probe the same way as a background fetch: no prompts, batch SSH, a time limit,
/// and outside the Operation log.
fn git_probe(repo: &Path, args: &[&str]) -> GitResult<String> {
    let env = super::ops::background_env(ssh_configured(repo));
    crate::journal::suspend(|| runner::run_with_deadline(repo, args, &env, GIT_DEADLINE))
}

fn git_read(repo: &Path, remote: &str, label: &str) -> Item {
    let started = Instant::now();
    match git_probe(repo, &["ls-remote", "--heads", "--", remote]) {
        Ok(out) => {
            let heads = out.lines().filter(|line| !line.trim().is_empty()).count();
            item("git-read", label, "ok", format!("Git listed {heads} branch{} on the server.", if heads == 1 { "" } else { "es" }), started)
        }
        Err(error) => failed("git-read", label, &error, true, started),
    }
}

/// `git push --dry-run` of HEAD to a branch name that is never created: the server checks
/// the credential's push access when Git connects, and nothing is sent.
fn git_write(repo: &Path, remote: &str, label: &str) -> Item {
    let started = Instant::now();
    let head = runner::run(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let Some(head) = head else {
        return item("git-write", label, "not-verified", "Write access not verified: the repository has no commit to test a push with.", started);
    };
    let target = format!("{head}:refs/heads/revqora-write-check-{}", &head[..12.min(head.len())]);
    match git_probe(repo, &["push", "--dry-run", "--no-verify", "--porcelain", "--", remote, &target]) {
        Ok(_) => item(
            "git-write",
            label,
            "ok",
            "The server accepted a push connection (dry run; nothing was sent). Branch protection rules are checked only by a real push.",
            started,
        ),
        Err(error) => {
            let mut result = failed("git-write", label, &error, true, started);
            if result.cause == Some("other") {
                // Some servers only check push access when objects arrive.
                result.state = "not-verified";
                result.detail = format!("Write access not verified: {}", result.detail);
            }
            result
        }
    }
}

/// Runs every check for `remote` (default: the remote of the API connection, else origin).
pub fn run(repo: &Path, remote: Option<&str>) -> GitResult<Report> {
    let remotes = super::refs::remotes(repo)?;
    let repository = repo.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let probe = super::forge::probe_profile(repo);
    let api_remote = probe.as_ref().ok().and_then(|p| p.as_ref().map(|p| p.info.remote.clone()));
    let chosen = remote
        .map(str::to_owned)
        .or_else(|| api_remote.clone())
        .or_else(|| remotes.iter().find(|r| r.name == "origin").or(remotes.first()).map(|r| r.name.clone()));
    let Some(selected) = chosen.and_then(|name| remotes.iter().find(|r| r.name == name)) else {
        if let Some(name) = remote {
            return Err(GitError::new(format!("The remote {name} was removed. Reload and choose another remote.")).kind("stale-operation"));
        }
        return Ok(Report {
            repository,
            remote: None,
            url: None,
            transport: None,
            provider: None,
            project: None,
            credential_source: None,
            items: vec![skipped("git-read", "Git read", "This repository has no remote.")],
        });
    };
    let kind = transport(&selected.fetch_url);
    let protocol = match kind {
        "https" => "HTTPS",
        "ssh" => "SSH",
        "local" => "local path",
        _ => "Git",
    };
    let mut items = vec![git_read(repo, &selected.name, &format!("Git read ({protocol})"))];
    let push_kind = transport(&selected.push_url);
    let push_label = format!(
        "Git push ({}, dry run)",
        if push_kind == "ssh" {
            "SSH"
        } else if push_kind == "https" {
            "HTTPS"
        } else {
            protocol
        }
    );
    items.push(if items[0].state == "ok" || selected.push_url != selected.fetch_url {
        git_write(repo, &selected.name, &push_label)
    } else {
        Item { state: "not-verified", ..skipped("git-write", &push_label, "Write access not verified: Git could not read this remote.") }
    });
    let mut report = Report {
        repository,
        remote: Some(selected.name.clone()),
        url: Some(clean_url(&selected.fetch_url)),
        transport: Some(kind),
        provider: None,
        project: None,
        credential_source: None,
        items,
    };
    let probe = match probe {
        Ok(probe) => probe,
        Err(error) => {
            let started = Instant::now();
            report.items.push(failed("profile", "Account profile", &error, false, started));
            return Ok(report);
        }
    };
    let Some(probe) = probe else {
        for (id, label) in api_labels() {
            report.items.push(skipped(id, label, "No supported provider (GitHub, GitLab, Bitbucket, Azure DevOps) or API account for this remote."));
        }
        return Ok(report);
    };
    report.provider = Some(provider_name(&probe.info.kind).to_owned());
    report.project = Some(probe.info.project.clone());
    report.credential_source = Some(probe.credential_source.clone());
    if probe.info.remote != selected.name {
        for (id, label) in api_labels() {
            report.items.push(skipped(id, label, format!("The API connection uses the remote {}. Check that remote for API access.", probe.info.remote)));
        }
        return Ok(report);
    }
    report.items.extend(api_items(repo, probe));
    Ok(report)
}

fn api_labels() -> [(&'static str, &'static str); 4] {
    [("profile", "Account profile"), ("pull-requests", "Pull request list"), ("files", "Pull request files"), ("checks", "Checks")]
}

fn provider_name(kind: &str) -> &str {
    match kind {
        "github" => "GitHub",
        "gitlab" => "GitLab",
        "bitbucket" => "Bitbucket Cloud",
        "bitbucket-server" => "Bitbucket Server",
        "azure" => "Azure DevOps",
        other => other,
    }
}

fn api_items(repo: &Path, probe: super::forge::ProfileProbe) -> Vec<Item> {
    let mut items = Vec::new();
    let started = Instant::now();
    items.push(match &probe.result {
        Ok(login) => item("profile", "Account profile", "ok", format!("Signed in as {login}."), started),
        Err(error) => failed("profile", "Account profile", error, false, started),
    });
    let started = Instant::now();
    let page = super::pr_center::page(repo, "open", None);
    let first = match &page {
        Ok(page) => {
            let more = if page.next_cursor.is_some() { " or more" } else { "" };
            items.push(item("pull-requests", "Pull request list", "ok", format!("Listed {}{more} open pull requests.", page.items.len()), started));
            page.items.first().map(|pull| (pull.number, page.forge.connection_revision.clone().unwrap_or_default()))
        }
        Err(error) => {
            items.push(failed("pull-requests", "Pull request list", error, false, started));
            None
        }
    };
    let Some((number, connection)) = first else {
        let why = if page.is_ok() { "No open pull request to read files and checks from." } else { "Skipped: the pull request list could not be read." };
        items.push(skipped("files", "Pull request files", why));
        items.push(skipped("checks", "Checks", why));
        return items;
    };
    let started = Instant::now();
    items.push(match super::pr_center::files(repo, number, &connection, None, 0) {
        Ok(files) => item(
            "files",
            "Pull request files",
            "ok",
            format!("Read {} changed file{} of #{number}.", files.items.len(), if files.items.len() == 1 { "" } else { "s" }),
            started,
        ),
        Err(error) => failed("files", "Pull request files", &error, false, started),
    });
    let started = Instant::now();
    items.push(match super::pr_center::checks(repo, number, &connection, None) {
        Ok(checks) => item(
            "checks",
            "Checks",
            "ok",
            format!("Read {} check{} of #{number}.", checks.checks.len(), if checks.checks.len() == 1 { "" } else { "s" }),
            started,
        ),
        Err(error) => failed("checks", "Checks", &error, false, started),
    });
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_error(stderr: &str) -> GitError {
        let mut error = GitError::new("git ls-remote failed");
        error.stderr = stderr.into();
        error
    }

    #[test]
    fn git_failures_name_their_cause() {
        for (stderr, cause) in [
            ("fatal: could not read Username for 'https://example.com': terminal prompts disabled", "no-credentials"),
            ("remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.com/r.git/'", "token-rejected"),
            ("git@example.com: Permission denied (publickey).", "token-rejected"),
            ("Host key verification failed.", "ssh-host"),
            ("remote: Permission to team/repo.git denied to someone.\nfatal: unable to access: The requested URL returned error: 403", "permission"),
            ("remote: Write access to repository not granted.", "permission"),
            ("remote: Repository not found.", "not-found"),
            ("fatal: unable to access 'https://example.com/': Could not resolve host: example.com", "network"),
            ("fatal: unable to access: Failed to connect to example.com port 443 after 21000 ms: Timed out", "timeout"),
            ("something else entirely", "other"),
        ] {
            assert_eq!(git_cause(&git_error(stderr)).0, cause, "{stderr}");
        }
        assert_eq!(git_cause(&GitError::new("Git exceeded its 30 second time limit.").kind("git-timeout")).0, "timeout");
    }

    #[test]
    fn api_failures_name_their_cause_and_keep_http_facts() {
        let error = |kind: &str, details: &[&str]| GitError::new("x").kind(kind).details(details.iter().map(|s| s.to_string()).collect());
        assert_eq!(api_cause(&error("auth", &["http_status=401"])).0, "token-rejected");
        assert_eq!(api_cause(&error("auth", &["http_status=403"])).0, "permission");
        let limited = api_cause(&error("forge-rate-limit", &["http_status=429", "retry_after=60"]));
        assert_eq!(limited.0, "rate-limit");
        assert!(limited.1.contains("60 s"));
        assert_eq!(api_cause(&error("forge-timeout", &[])).0, "timeout");
        assert_eq!(api_cause(&error("forge-network", &[])).0, "network");
        assert_eq!(api_cause(&error("forge-server", &["http_status=502"])).0, "server");
        assert_eq!(api_cause(&error("pr-connection-required", &[])).0, "no-credentials");
        assert_eq!(api_cause(&GitError::new("No Git credential is available for this remote.").kind("auth")).0, "no-credentials");
        let item = failed("pull-requests", "Pull request list", &error("auth", &["http_status=403", "request_id=AB12:34CD"]), false, Instant::now());
        assert_eq!((item.state, item.http_status, item.request_id.as_deref()), ("failed", Some(403), Some("AB12:34CD")));
        // A profile the token may not read is a limitation, not a failed connection.
        let profile =
            failed("profile", "Account profile", &GitError::new("Bitbucket denied access to the profile.").kind("identity-unavailable"), false, Instant::now());
        assert_eq!((profile.state, profile.cause), ("limited", Some("permission")));
    }

    #[test]
    fn a_local_remote_is_read_and_push_checked_without_sending_anything() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("origin.git");
        let work = temp.path().join("work");
        runner::run(temp.path(), ["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]).unwrap();
        runner::run(temp.path(), ["clone", "-q", origin.to_str().unwrap(), work.to_str().unwrap()]).unwrap();
        runner::run(&work, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "first"]).unwrap();
        runner::run(&work, ["push", "-q", "origin", "main"]).unwrap();
        let before = runner::run(&origin, ["for-each-ref"]).unwrap();
        let report = run(&work, None).unwrap();
        assert_eq!(report.remote.as_deref(), Some("origin"));
        assert_eq!(report.transport, Some("local"));
        let state = |id: &str| report.items.iter().find(|item| item.id == id).map(|item| (item.state, item.detail.clone())).unwrap();
        assert_eq!(state("git-read").0, "ok", "{:?}", report.items);
        assert!(state("git-read").1.contains("1 branch"));
        assert_eq!(state("git-write").0, "ok", "{:?}", report.items);
        // No provider: every API check says why it did not run.
        for id in ["profile", "pull-requests", "files", "checks"] {
            assert_eq!(state(id).0, "skipped");
        }
        assert_eq!(runner::run(&origin, ["for-each-ref"]).unwrap(), before, "the dry run created nothing on the server");
        // An unborn repository cannot test a push and says so.
        let empty = temp.path().join("empty");
        runner::run(temp.path(), ["init", "-q", empty.to_str().unwrap()]).unwrap();
        runner::run(&empty, ["remote", "add", "origin", origin.to_str().unwrap()]).unwrap();
        let report = run(&empty, None).unwrap();
        let write = report.items.iter().find(|item| item.id == "git-write").unwrap();
        assert_eq!(write.state, "not-verified", "{write:?}");
        // A missing server is a failed read with a cause and a next step.
        runner::run(&empty, ["remote", "set-url", "origin", temp.path().join("missing.git").to_str().unwrap()]).unwrap();
        let read = run(&empty, None).unwrap().items.into_iter().find(|item| item.id == "git-read").unwrap();
        assert_eq!(read.state, "failed");
        assert!(read.cause.is_some() && read.next.is_some(), "{read:?}");
        assert!(run(&empty, Some("removed")).is_err());
    }

    #[test]
    fn urls_lose_their_credentials() {
        assert_eq!(clean_url("https://user:secret@example.com/team/repo.git"), "https://example.com/team/repo.git");
        assert_eq!(clean_url("https://x-token-auth@bitbucket.org/team/repo.git"), "https://bitbucket.org/team/repo.git");
        assert_eq!(clean_url("git@github.com:team/repo.git"), "git@github.com:team/repo.git");
        assert_eq!(transport("https://example.com/r.git"), "https");
        assert_eq!(transport("ssh://git@example.com/r.git"), "ssh");
        assert_eq!(transport("git@github.com:team/repo.git"), "ssh");
        assert_eq!(transport("C:\\repos\\origin.git"), "local");
    }
}
