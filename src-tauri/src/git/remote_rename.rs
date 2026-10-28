//! Reviewed server branch rename. Both server ref updates use one atomic push.
use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::branch_deletion::{self, RemoteBranchTarget};
use super::recovery::{self, SavedRef, Summary};
use super::runner::{self, GitError, GitResult};
use super::status;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlan {
    pub target: RemoteBranchTarget,
    pub new_ref: String,
    pub server_oid: String,
    pub state_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub checkpoint: Summary,
    pub tracking_ref: Option<String>,
    pub local_branches: Vec<String>,
    pub warnings: Vec<String>,
}

fn server_refs(root: &Path, target: &RemoteBranchTarget, new_ref: &str) -> GitResult<(Option<String>, Option<String>)> {
    let text = runner::run(root, ["ls-remote", "--heads", "--refs", "--", &target.push_url, &target.remote_ref, new_ref])?;
    let find = |name: &str| text.lines().find_map(|line| line.split_once('\t').and_then(|(oid, reference)| (reference == name).then(|| oid.to_owned())));
    Ok((find(&target.remote_ref), find(new_ref)))
}

fn valid_new(root: &Path, target: &RemoteBranchTarget, new_ref: &str) -> GitResult<()> {
    if !new_ref.starts_with("refs/heads/")
        || new_ref == target.remote_ref
        || !runner::exec(root, ["check-ref-format", new_ref])?.ok()
        || !runner::exec(root, ["check-ref-format", "--branch", new_ref.strip_prefix("refs/heads/").unwrap_or("")])?.ok()
    {
        return Err(GitError::new("Choose a different, valid server branch name."));
    }
    Ok(())
}

pub fn plan(root: &Path, tracking_ref: &str, new_name: &str) -> GitResult<RenamePlan> {
    let target = branch_deletion::remote_target(root, tracking_ref)?;
    let new_ref = format!("refs/heads/{new_name}");
    valid_new(root, &target, &new_ref)?;
    let (source, destination) = server_refs(root, &target, &new_ref)?;
    if destination.is_some() {
        return Err(GitError::new("The destination branch already exists on the push server. Nothing was changed."));
    }
    let server_oid = source.ok_or_else(|| GitError::new("The source branch no longer exists on the push server."))?;
    if !runner::exec(root, ["cat-file", "-e", &format!("{server_oid}^{{commit}}")])?.ok() {
        runner::run(root, ["fetch", "--no-tags", "--no-prune", "--no-write-fetch-head", "--no-recurse-submodules", "--", &target.push_url, &server_oid])?;
    }
    let state_token = status::status(root)?.state_token.ok_or_else(|| GitError::new("Cannot capture repository state."))?;
    Ok(RenamePlan { target, new_ref, server_oid, state_token })
}

fn map(pattern: &str, replacement: &str, value: &str) -> Option<String> {
    match (pattern.split_once('*'), replacement.split_once('*')) {
        (None, None) => (pattern == value).then(|| replacement.to_owned()),
        (Some((a, b)), Some((x, y))) if !b.contains('*') && !y.contains('*') => Some(format!("{x}{}{y}", value.strip_prefix(a)?.strip_suffix(b)?)),
        _ => None,
    }
}

fn tracking(root: &Path, plan: &RenamePlan) -> GitResult<Option<String>> {
    let specs = runner::run(root, ["config", "--get-all", &format!("remote.{}.fetch", plan.target.remote)])?;
    if specs.lines().filter_map(|s| s.strip_prefix('^')).any(|s| map(s, s, &plan.new_ref).is_some()) {
        return Ok(None);
    }
    let mapped: BTreeSet<_> =
        specs.lines().filter_map(|s| s.trim_start_matches('+').split_once(':')).filter_map(|(source, dest)| map(source, dest, &plan.new_ref)).collect();
    if mapped.len() != 1 {
        return Ok(None);
    }
    let candidate = mapped.into_iter().next().unwrap();
    if !candidate.starts_with("refs/remotes/") || !runner::exec(root, ["check-ref-format", &candidate])?.ok() {
        return Ok(None);
    }
    // A newly mapped alias must also have one inverse mapping, across ALL
    // remotes, not merely one resulting destination in this remote's refspecs.
    let mut owners = BTreeSet::new();
    for remote in runner::run(root, ["remote"])?.lines() {
        let config = runner::exec(root, ["config", "--get-all", &format!("remote.{remote}.fetch")])?;
        if config.code == 1 {
            continue;
        }
        if !config.ok() {
            return Err(runner::to_error("git config", &config));
        }
        let specs = config.text();
        for (source, dest) in specs.lines().filter_map(|s| s.trim_start_matches('+').split_once(':')) {
            if let Some(source) = map(dest, source, &candidate) {
                if !specs.lines().filter_map(|s| s.strip_prefix('^')).any(|s| map(s, s, &source).is_some()) {
                    owners.insert((remote.to_owned(), source));
                }
            }
        }
    }
    Ok((owners.len() == 1 && owners.contains(&(plan.target.remote.clone(), plan.new_ref.clone()))).then_some(candidate))
}

pub fn rename(root: &Path, plan: &RenamePlan) -> GitResult<RenameResult> {
    branch_deletion::validate_mapping(root, &plan.target)?;
    valid_new(root, &plan.target, &plan.new_ref)?;
    if branch_deletion::remote_target(root, &plan.target.tracking_ref)? != plan.target {
        return Err(GitError::new("The tracking branch changed. Review the rename again.").kind("stale-selection"));
    }
    if !matches!(plan.server_oid.len(), 40 | 64) || !plan.server_oid.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::new("A complete reviewed server commit SHA is required."));
    }
    let (source, destination) = server_refs(root, &plan.target, &plan.new_ref)?;
    if source.as_deref() != Some(&plan.server_oid) || destination.is_some() {
        return Err(
            GitError::new("The source or destination branch changed on the server. Review the rename again; nothing was changed.").kind("remote-changed")
        );
    }
    let checkpoint = recovery::reference_checkpoint(
        root,
        "remote_branch_rename",
        "Before remote branch rename",
        &[SavedRef { name: plan.target.remote_ref.clone(), oid: plan.server_oid.clone(), kind: "remote".into() }],
        Some(&plan.state_token),
    )?;
    let args = vec![
        "push".into(),
        "--atomic".into(),
        "--porcelain".into(),
        "--no-follow-tags".into(),
        format!("--force-with-lease={}:{}", plan.target.remote_ref, plan.server_oid),
        format!("--force-with-lease={}:", plan.new_ref),
        "--".into(),
        plan.target.push_url.clone(),
        format!("{}:{}", plan.server_oid, plan.new_ref),
        format!(":{}", plan.target.remote_ref),
    ];
    if let Err(error) = runner::run(root, &args) {
        // A lost transport response is not proof of failure. Inspect both refs;
        // never blindly retry a potentially completed server operation.
        match server_refs(root, &plan.target, &plan.new_ref) {
            Ok((None, Some(tip))) if tip == plan.server_oid => {}
            Ok((Some(tip), None)) if tip == plan.server_oid => return Err(GitError { message: format!("The atomic rename was rejected; both branches were left unchanged. The server must support atomic pushes and allow creation/deletion. {}", error.message), ..error }),
            _ => return Err(GitError::new("The rename outcome could not be confirmed. Refresh the server branches before any further action; a recovery checkpoint preserves the reviewed commit.").kind("remote-outcome-unknown")),
        }
    }
    let mut result = RenameResult { checkpoint, tracking_ref: None, local_branches: Vec::new(), warnings: Vec::new() };
    // Once the server succeeded, local refresh problems are warnings, never a
    // retryable rename failure. A distinct fetch server must retain its own refs.
    let local = (|| -> GitResult<()> {
        let fetch = runner::run(root, ["remote", "get-url", &plan.target.remote])?;
        if fetch.trim() != plan.target.push_url {
            result.warnings.push("Fetch and push use different servers. Fetch-tracking refs and local upstreams were preserved.".into());
            return Ok(());
        }
        let Some(new_tracking) = tracking(root, plan)? else {
            result
                .warnings
                .push("The fetch configuration does not map the new branch uniquely. Update its fetch mapping before setting a local upstream.".into());
            return Ok(());
        };
        if runner::exec(root, ["symbolic-ref", "--quiet", &new_tracking])?.ok() {
            result.warnings.push("The new tracking name is a symbolic reference and was preserved. Refresh local tracking configuration manually.".into());
            return Ok(());
        }
        let current = runner::exec(root, ["rev-parse", "--verify", "--quiet", &new_tracking])?;
        let expected = if current.ok() {
            let oid = current.text().trim().to_owned();
            if oid != plan.server_oid {
                result.warnings.push("A different local tracking tip was preserved. Fetch before changing upstreams.".into());
                return Ok(());
            }
            oid
        } else if current.code == 1 {
            "0".repeat(plan.server_oid.len())
        } else {
            return Err(runner::to_error("git rev-parse", &current));
        };
        runner::run(root, ["update-ref", "--no-deref", &new_tracking, &plan.server_oid, &expected])?;
        result.tracking_ref = Some(new_tracking);
        let branches = runner::run(root, ["for-each-ref", "--format=%(refname)%09%(upstream:remotename)%09%(upstream:remoteref)", "refs/heads/"])?;
        for line in branches.lines() {
            let fields: Vec<_> = line.split('\t').collect();
            if fields.len() == 3 && fields[1] == plan.target.remote && fields[2] == plan.target.remote_ref {
                if let Some(name) = fields[0].strip_prefix("refs/heads/") {
                    result.local_branches.push(name.into());
                }
            }
        }
        runner::run(root, ["update-ref", "--no-deref", "-d", &plan.target.tracking_ref, &plan.target.oid])?;
        Ok(())
    })();
    if let Err(error) = local {
        result.warnings.push(format!("The server branch was renamed, but local metadata needs refresh: {}", error.message));
    }
    Ok(result)
}
