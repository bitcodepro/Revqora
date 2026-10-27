//! Resolve destructive server targets from fetch mappings, never from display names.
use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::runner::{self, GitError, GitResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranchTarget {
    pub label: String,
    pub remote: String,
    pub push_url: String,
    pub remote_ref: String,
    pub tracking_ref: String,
    pub oid: String,
    pub is_upstream: bool,
}

fn substitute(pattern: &str, replacement: &str, value: &str) -> Option<String> {
    match (pattern.split_once('*'), replacement.split_once('*')) {
        (None, None) => (pattern == value).then(|| replacement.to_owned()),
        (Some((prefix, suffix)), Some((left, right))) if !suffix.contains('*') && !right.contains('*') => {
            let middle = value.strip_prefix(prefix)?.strip_suffix(suffix)?;
            Some(format!("{left}{middle}{right}"))
        }
        _ => None,
    }
}

fn excluded(spec: &str, source: &str) -> bool {
    spec.strip_prefix('^').is_some_and(|pattern| substitute(pattern, pattern, source).is_some())
}

pub fn targets(repo: &Path, name: &str) -> GitResult<Vec<RemoteBranchTarget>> {
    runner::run(repo, ["check-ref-format", "--branch", name])?;
    let local_ref = format!("refs/heads/{name}");
    let upstream = runner::run(repo, ["for-each-ref", "--format=%(refname)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream)", &local_ref])?;
    let upstream: Vec<&str> = upstream.lines().find(|line| line.split('\t').next() == Some(local_ref.as_str())).unwrap_or("").split('\t').collect();
    let refs = runner::run(repo, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)"])?;
    let mut result = Vec::new();
    for remote in runner::run(repo, ["remote"])?.lines() {
        let Some(push_url) = push_destination(repo, remote)? else { continue };
        let config = runner::exec(repo, ["config", "--get-all", &format!("remote.{remote}.fetch")])?;
        if config.code != 0 && config.code != 1 {
            return Err(runner::to_error("git config --get-all", &config));
        }
        let config_text = config.text();
        let specs: Vec<&str> = config_text.lines().collect();
        for line in refs.lines() {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() != 3 || !fields[2].is_empty() || fields[0].starts_with("refs/heads/") {
                continue;
            }
            let tracking_ref = fields[0];
            let mut sources = BTreeSet::new();
            for spec in &specs {
                let spec = spec.strip_prefix('+').unwrap_or(spec);
                if let Some((source, destination)) = spec.split_once(':') {
                    if let Some(source) = substitute(destination, source, tracking_ref) {
                        if source.starts_with("refs/heads/") && !specs.iter().any(|s| excluded(s, &source)) {
                            sources.insert(source);
                        }
                    }
                }
            }
            // Git resolves the configured upstream even when its tracking name was renamed.
            let is_upstream = upstream.len() == 4 && upstream[1] == remote && upstream[3] == tracking_ref;
            let source = if is_upstream {
                if sources.len() != 1 || !upstream[2].starts_with("refs/heads/") || !sources.contains(upstream[2]) {
                    continue;
                }
                upstream[2].to_owned()
            } else if sources.len() == 1 {
                sources.into_iter().next().unwrap()
            } else {
                continue;
            };
            if !is_upstream && source != local_ref {
                continue;
            }
            result.push(RemoteBranchTarget {
                label: format!("{remote}/{}", source.strip_prefix("refs/heads/").unwrap()),
                remote: remote.to_owned(),
                push_url: push_url.clone(),
                remote_ref: source,
                tracking_ref: tracking_ref.to_owned(),
                oid: fields[1].to_owned(),
                is_upstream,
            });
        }
    }
    result.sort_by(|a, b| b.is_upstream.cmp(&a.is_upstream).then(a.label.cmp(&b.label)));
    result.dedup_by(|a, b| a.remote == b.remote && a.remote_ref == b.remote_ref);
    Ok(result)
}

pub fn delete(repo: &Path, name: &str, force: bool, target: Option<&RemoteBranchTarget>) -> GitResult<()> {
    if let Some(target) = target {
        validate_mapping(repo, target)?;
        if !targets(repo, name)?.contains(target) {
            return Err(GitError::new("The remote branch mapping or tip changed. Reopen the deletion dialog.").kind("stale-selection"));
        }
        if !force {
            // `branch -d` accepts commits merged only into the upstream we are about to remove.
            // Require a surviving checkout to retain BOTH tips before deleting either label.
            for tip in [&format!("refs/heads/{name}"), &target.oid] {
                let out = runner::exec(repo, ["merge-base", "--is-ancestor", tip, "HEAD"])?;
                if out.code == 1 {
                    return Err(GitError::new(
                        "Branch history is not fully merged into the current checkout. Confirm force deletion before deleting either branch.",
                    )
                    .kind("not-merged"));
                }
                if !out.ok() {
                    return Err(runner::to_error("git merge-base", &out));
                }
            }
        }
    }
    super::ops::delete_branch(repo, name, force)
}

fn push_destination(repo: &Path, remote: &str) -> GitResult<Option<String>> {
    let urls = runner::run(repo, ["remote", "get-url", "--push", "--all", remote])?;
    let urls: Vec<&str> = urls.lines().filter(|s| !s.is_empty()).collect();
    // One confirmation cannot describe deletion on several independent servers.
    Ok((urls.len() == 1).then(|| urls[0].to_owned()))
}

// A local branch may already be gone after a partial failure. Validate the actual
// fetch mapping independently of its upstream configuration on EVERY retry.
fn validate_mapping(repo: &Path, target: &RemoteBranchTarget) -> GitResult<()> {
    let stale = || GitError::new("The remote branch mapping changed. Close and reopen the deletion dialog.").kind("stale-selection");
    if target.remote.starts_with('-')
        || !runner::run(repo, ["remote"])?.lines().any(|name| name == target.remote)
        || push_destination(repo, &target.remote)?.as_deref() != Some(target.push_url.as_str())
        || !target.remote_ref.starts_with("refs/heads/")
        || !target.tracking_ref.starts_with("refs/")
        || target.tracking_ref.starts_with("refs/heads/")
        || !runner::exec(repo, ["check-ref-format", &target.remote_ref])?.ok()
        || !runner::exec(repo, ["check-ref-format", &target.tracking_ref])?.ok()
    {
        return Err(stale());
    }
    let config = runner::run(repo, ["config", "--get-all", &format!("remote.{}.fetch", target.remote)])?;
    let mut sources = BTreeSet::new();
    for spec in config.lines() {
        if let Some((source, destination)) = spec.trim_start_matches('+').split_once(':') {
            if let Some(source) = substitute(destination, source, &target.tracking_ref) {
                if source.starts_with("refs/heads/") && !config.lines().any(|s| excluded(s, &source)) {
                    sources.insert(source);
                }
            }
        }
    }
    // Refuse aliases shared by multiple server branches, including after the
    // configured upstream (which previously disambiguated them) was deleted.
    if sources.len() != 1 || !sources.contains(&target.remote_ref) {
        return Err(stale());
    }
    if !matches!(target.oid.len(), 40 | 64) || !target.oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("A complete reviewed commit SHA is required to delete a remote branch.").kind("stale-selection"));
    }
    Ok(())
}

fn require_merged(repo: &Path, oid: &str, force: bool) -> GitResult<()> {
    if !force {
        let out = runner::exec(repo, ["merge-base", "--is-ancestor", oid, "HEAD"])?;
        if out.code == 1 {
            return Err(
                GitError::new("The reviewed remote tip contains commits outside the current checkout. Confirm their deletion first.").kind("not-merged")
            );
        }
        if !out.ok() {
            return Err(runner::to_error("git merge-base", &out));
        }
    }
    Ok(())
}

/// Force acknowledges unmerged history; it NEVER disables the expected-SHA lease.
pub fn delete_remote(repo: &Path, target: &RemoteBranchTarget, force: bool, on_line: impl FnMut(&str)) -> GitResult<String> {
    validate_mapping(repo, target)?;
    require_merged(repo, &target.oid, force)?;
    let same_server = runner::run(repo, ["remote", "get-url", &target.remote])?.trim() == target.push_url;
    let output = runner::run_streaming(
        repo,
        &[
            "push".into(),
            "--progress".into(),
            "--porcelain".into(),
            "--no-follow-tags".into(),
            format!("--force-with-lease={}:{}", target.remote_ref, target.oid),
            "--".into(),
            target.push_url.clone(),
            format!(":{}", target.remote_ref),
        ],
        &[],
        on_line,
    )
    .map_err(|e| {
        // Porcelain rejection text can be in stdout, which runner includes in message.
        if e.message.contains("stale info") || e.stderr.contains("stale info") {
            GitError {
                message: "The server branch changed since the reviewed SHA. Refresh its state and confirm the new tip before deleting it.".into(),
                kind: "remote-changed".into(),
                ..e
            }
        } else {
            e
        }
    })?;
    // Pushing an explicit URL avoids remote mirror/multiple-pushurl settings.
    // Clear only the cache for that SAME server and only at the reviewed SHA.
    if same_server {
        let _ = runner::exec(repo, ["update-ref", "-d", &target.tracking_ref, &target.oid]);
    }
    Ok(output)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeletionReview {
    pub target: RemoteBranchTarget,
    pub previous_oid: String,
    pub new_commits: u64,
    pub removed_commits: u64,
    pub unmerged_commits: u64,
    pub commits: Vec<String>,
}

/// Explicit refresh after a lease rejection; the UI must obtain NEW consent.
pub fn refresh_remote(repo: &Path, target: &RemoteBranchTarget, on_line: impl FnMut(&str)) -> GitResult<RemoteDeletionReview> {
    validate_mapping(repo, target)?;
    let same_server = runner::run(repo, ["remote", "get-url", &target.remote])?.trim() == target.push_url;
    let remote_tip = runner::run(repo, ["ls-remote", "--heads", "--refs", "--", &target.push_url, &target.remote_ref])?;
    let oid = remote_tip
        .lines()
        .find_map(|line| {
            let (oid, name) = line.split_once('\t')?;
            (name == target.remote_ref).then(|| oid.to_owned())
        })
        .ok_or_else(|| GitError::new("The server branch no longer exists. Close this dialog and refresh the repository.").kind("remote-missing"))?;
    // Fetch the advertised SHA, never a moving branch name. If it becomes
    // unavailable during fetch, fail and ask for another explicit refresh.
    runner::run_streaming(
        repo,
        &[
            "fetch".into(),
            "--no-tags".into(),
            "--no-write-fetch-head".into(),
            "--no-recurse-submodules".into(),
            "--".into(),
            target.push_url.clone(),
            oid.clone(),
        ],
        &[],
        on_line,
    )?;
    if same_server {
        // Do not rewrite a cache concurrently changed by an external Git process.
        let _ = runner::exec(repo, ["update-ref", &target.tracking_ref, &oid, &target.oid]);
    }
    let count = |range: &str| -> GitResult<u64> {
        runner::run(repo, ["rev-list", "--count", range])?.trim().parse().map_err(|_| GitError::new("Invalid commit count from Git."))
    };
    let commits = runner::run(repo, ["log", "-5", "--format=%h %s", &oid])?.lines().map(str::to_owned).collect();
    Ok(RemoteDeletionReview {
        previous_oid: target.oid.clone(),
        new_commits: count(&format!("{}..{oid}", target.oid))?,
        removed_commits: count(&format!("{oid}..{}", target.oid))?,
        unmerged_commits: count(&format!("HEAD..{oid}"))?,
        target: RemoteBranchTarget { oid, ..target.clone() },
        commits,
    })
}
