//! Frozen branch-deletion review. Server deletion always retains its exact-SHA lease.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::branch_deletion::{self, RemoteBranchTarget};
use super::runner::{self, GitError, GitResult};
use super::{operations, recovery, repo, status};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionProof {
    pub name: String,
    pub local_oid: String,
    pub remote_only: bool,
    pub local_present: bool,
    pub base_ref: Option<String>,
    pub base_oid: Option<String>,
    pub target: Option<RemoteBranchTarget>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseChoice {
    pub reference: String,
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchWorktree {
    pub path: String,
    pub current: bool,
    pub dirty: Option<bool>,
    pub changed_files: Option<usize>,
    pub operation: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionPlan {
    pub proof: DeletionProof,
    pub bases: Vec<BaseChoice>,
    pub local_only: Option<u64>,
    pub remote_only: Option<u64>,
    pub local_unmerged: u64,
    pub remote_unmerged: Option<u64>,
    pub local_integration: String,
    pub remote_integration: Option<String>,
    pub worktrees: Vec<BranchWorktree>,
    pub current_changes: usize,
    pub state_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionResult {
    pub checkpoint: recovery::Summary,
    pub warning: Option<String>,
}

fn stale(message: &str) -> GitError {
    GitError::new(message).kind("stale-selection")
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn commit_oid(root: &Path, reference: &str) -> GitResult<String> {
    Ok(runner::run(root, ["rev-parse", "--verify", &format!("{reference}^{{commit}}")])?.trim().into())
}

fn count(root: &Path, base: Option<&str>, tip: &str) -> GitResult<u64> {
    let range = base.map(|base| format!("{base}..{tip}")).unwrap_or_else(|| tip.into());
    super::history::run(root, ["rev-list", "--count", &range])?.trim().parse().map_err(|_| GitError::new("Git returned an invalid commit count."))
}

fn integration(root: &Path, base: Option<&str>, tip: &str, outside: u64) -> GitResult<String> {
    if outside == 0 {
        return Ok("reachable".into());
    }
    let Some(base) = base else { return Ok("unknown".into()) };
    if !runner::version_at_least(2, 38) {
        return Ok("unknown".into());
    }
    let tree = runner::run(root, ["rev-parse", &format!("{base}^{{tree}}")])?;
    let merged = runner::exec(root, ["merge-tree", "--write-tree", base, tip])?;
    if merged.ok() && merged.text().lines().next().map(str::trim) == Some(tree.trim()) {
        return Ok("content-integrated".into());
    }
    Ok(if matches!(merged.code, 0 | 1) { "not-integrated" } else { "unknown" }.into())
}

/// NUL-separated porcelain preserves quoted, Unicode and newline-containing paths.
fn used_paths(root: &Path, name: &str) -> GitResult<Vec<PathBuf>> {
    let branch = format!("branch refs/heads/{name}");
    let raw = runner::run(root, ["worktree", "list", "--porcelain", "-z"])?;
    Ok(raw
        .split("\0\0")
        .filter_map(|block| {
            let fields: Vec<_> = block.split('\0').collect();
            if !fields.iter().any(|field| *field == branch) {
                return None;
            }
            fields.iter().find_map(|field| field.strip_prefix("worktree ").map(PathBuf::from))
        })
        .collect())
}

fn validate_base(root: &Path, proof: &DeletionProof) -> GitResult<()> {
    match (&proof.base_ref, &proof.base_oid) {
        (None, None) => Ok(()),
        (Some(reference), Some(oid))
            if valid_oid(oid)
                && (reference == "HEAD" || reference.starts_with("refs/heads/"))
                && (proof.remote_only || reference != &format!("refs/heads/{}", proof.name)) =>
        {
            let symbolic = runner::exec(root, ["symbolic-ref", "-q", reference])?;
            if symbolic.ok() {
                return Err(stale("Choose a direct local branch or detached HEAD as the comparison target."));
            }
            if symbolic.code != 1 {
                return Err(runner::to_error("git symbolic-ref", &symbolic));
            }
            if commit_oid(root, reference)? != *oid {
                return Err(stale("The comparison branch changed. Refresh the deletion review."));
            }
            Ok(())
        }
        _ => Err(stale("Choose a surviving local comparison branch or explicitly review deletion without a target.")),
    }
}

fn validate_target(root: &Path, name: &str, target: &RemoteBranchTarget, local_exists: bool) -> GitResult<()> {
    branch_deletion::validate_mapping(root, target)?;
    if commit_oid(root, &target.oid)? != target.oid {
        return Err(stale("The reviewed remote commit is unavailable."));
    }
    if local_exists
        && !branch_deletion::targets(root, name)?.iter().any(|candidate| {
            candidate.remote == target.remote
                && candidate.remote_ref == target.remote_ref
                && candidate.tracking_ref == target.tracking_ref
                && candidate.push_url == target.push_url
        })
    {
        return Err(stale("The remote branch mapping changed. Reopen deletion review."));
    }
    Ok(())
}

pub fn plan(
    root: &Path,
    name: &str,
    base: Option<&str>,
    target: Option<RemoteBranchTarget>,
    saved_local_oid: Option<&str>,
    remote_only: bool,
) -> GitResult<DeletionPlan> {
    let (mut plan, token) = operations::inspect(root, || {
        runner::run(root, ["check-ref-format", "--branch", name])?;
        let local_ref = format!("refs/heads/{name}");
        let current_local = runner::exec(root, ["rev-parse", "--verify", &format!("{local_ref}^{{commit}}")])?;
        let exists = current_local.ok();
        if remote_only && target.is_none() {
            return Err(stale("Choose the remote branch to review."));
        }
        let local_oid = if exists {
            current_local.text().trim().into()
        } else if remote_only {
            target.as_ref().unwrap().oid.clone()
        } else {
            let oid = saved_local_oid.filter(|value| valid_oid(value)).ok_or_else(|| stale("The local branch no longer exists. Reopen deletion review."))?;
            commit_oid(root, oid)?
        };
        if let Some(target) = &target {
            validate_target(root, name, target, exists && !remote_only)?;
        }
        let raw = runner::run(root, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/heads"])?;
        let mut bases: Vec<BaseChoice> = raw
            .lines()
            .filter_map(|line| {
                let (reference, symref) = line.split_once('\t')?;
                ((remote_only || reference != local_ref) && symref.is_empty())
                    .then(|| BaseChoice { reference: reference.into(), label: reference.trim_start_matches("refs/heads/").into() })
            })
            .collect();
        let head = runner::exec(root, ["symbolic-ref", "-q", "HEAD"])?;
        if !head.ok() && commit_oid(root, "HEAD").is_ok() {
            bases.push(BaseChoice { reference: "HEAD".into(), label: "Current detached HEAD".into() });
        }
        let base_ref = match base {
            Some("") => None,
            Some(value) => Some(value.to_owned()),
            None => bases
                .iter()
                .find(|b| b.reference == head.text().trim())
                .or_else(|| bases.iter().find(|b| b.label == "main"))
                .or_else(|| bases.first())
                .map(|b| b.reference.clone()),
        };
        let base_oid = base_ref.as_deref().map(|reference| commit_oid(root, reference)).transpose()?;
        let proof = DeletionProof { name: name.into(), local_oid, remote_only, local_present: exists, base_ref, base_oid, target };
        validate_base(root, &proof)?;
        let local_unmerged = count(root, proof.base_oid.as_deref(), &proof.local_oid)?;
        let remote_unmerged = proof.target.as_ref().map(|t| count(root, proof.base_oid.as_deref(), &t.oid)).transpose()?;
        let local_only = proof.target.as_ref().filter(|_| !remote_only || exists).map(|t| count(root, Some(&t.oid), &proof.local_oid)).transpose()?;
        let remote_count = proof.target.as_ref().filter(|_| !remote_only || exists).map(|t| count(root, Some(&proof.local_oid), &t.oid)).transpose()?;
        let local_integration = integration(root, proof.base_oid.as_deref(), &proof.local_oid, local_unmerged)?;
        let remote_integration =
            proof.target.as_ref().zip(remote_unmerged).map(|(t, n)| integration(root, proof.base_oid.as_deref(), &t.oid, n)).transpose()?;
        let current = std::fs::canonicalize(root)?;
        let worktrees = used_paths(root, name)?
            .into_iter()
            .map(|path| {
                let current_path = std::fs::canonicalize(&path).is_ok_and(|p| p == current);
                let observed = status::status(&path);
                let operation = repo::git_dir(&path).ok().map(|gd| repo::op_state(&path, &gd).kind);
                match observed {
                    Ok(s) => BranchWorktree {
                        path: path.to_string_lossy().into(),
                        current: current_path,
                        dirty: Some(!s.files.is_empty()),
                        changed_files: Some(s.files.len()),
                        operation,
                        error: None,
                    },
                    Err(e) => BranchWorktree {
                        path: path.to_string_lossy().into(),
                        current: current_path,
                        dirty: None,
                        changed_files: None,
                        operation,
                        error: Some(e.message),
                    },
                }
            })
            .collect();
        Ok(DeletionPlan {
            proof,
            bases,
            local_only,
            remote_only: remote_count,
            local_unmerged,
            remote_unmerged,
            local_integration,
            remote_integration,
            worktrees,
            current_changes: status::status(root)?.files.len(),
            state_token: String::new(),
        })
    })?;
    plan.state_token = token;
    Ok(plan)
}

pub(super) fn validate(root: &Path, proof: &DeletionProof, local: bool) -> GitResult<()> {
    runner::run(root, ["check-ref-format", "--branch", &proof.name])?;
    if !valid_oid(&proof.local_oid) {
        return Err(stale("A complete reviewed local SHA is required."));
    }
    validate_base(root, proof)?;
    let reference = format!("refs/heads/{}", proof.name);
    let now = runner::exec(root, ["rev-parse", "--verify", &format!("{reference}^{{commit}}")])?;
    if local {
        let symbolic = runner::exec(root, ["symbolic-ref", "-q", &reference])?;
        if symbolic.ok() {
            return Err(stale("Select a direct local branch, not a symbolic reference."));
        }
        if symbolic.code != 1 {
            return Err(runner::to_error("git symbolic-ref", &symbolic));
        }
        if proof.remote_only {
            return Err(stale("Remote-only review cannot delete a local branch."));
        }
        if !now.ok() || now.text().trim() != proof.local_oid {
            return Err(stale("The local branch changed. Refresh deletion review."));
        }
        if !used_paths(root, &proof.name)?.is_empty() {
            return Err(
                GitError::new("This branch is checked out in a worktree. Switch that worktree to another branch before deleting it.").kind("branch-in-use")
            );
        }
    } else if proof.remote_only {
        if now.ok() != proof.local_present || (now.ok() && now.text().trim() != proof.local_oid) {
            return Err(stale("The matching local branch changed. Refresh remote deletion review."));
        }
    } else if now.ok() {
        return Err(stale("The local branch exists again. Reopen deletion review before removing the server branch."));
    }
    if let Some(target) = &proof.target {
        validate_target(root, &proof.name, target, local && !proof.remote_only)?;
    }
    Ok(())
}

pub(super) fn require_retained(root: &Path, proof: &DeletionProof, local: bool, remote: bool, force: bool) -> GitResult<()> {
    if force {
        return Ok(());
    }
    let local_outside = if local { count(root, proof.base_oid.as_deref(), &proof.local_oid)? } else { 0 };
    let remote_outside = if remote { proof.target.as_ref().map(|t| count(root, proof.base_oid.as_deref(), &t.oid)).transpose()?.unwrap_or(0) } else { 0 };
    if proof.base_oid.is_none() || local_outside > 0 || remote_outside > 0 {
        return Err(GitError::new("The reviewed history is not fully reachable from the selected comparison branch. Explicit force confirmation is required, including for squash-integrated changes.").kind("not-merged"));
    }
    Ok(())
}

fn checkpoint(root: &Path, proof: &DeletionProof, command: &str, expected: Option<&str>) -> GitResult<recovery::Summary> {
    let mut references = Vec::new();
    if !proof.remote_only || proof.local_present {
        references.push(recovery::SavedRef { name: format!("refs/heads/{}", proof.name), oid: proof.local_oid.clone(), kind: "branch".into() });
    }
    if let Some(t) = &proof.target {
        references.push(recovery::SavedRef {
            name: format!("push/{}/{}", t.remote, t.remote_ref.trim_start_matches("refs/heads/")),
            oid: t.oid.clone(),
            kind: "remote".into(),
        });
    }
    recovery::reference_checkpoint(root, command, &format!("Before deleting {}", proof.name), &references, expected)
}

pub fn delete_local(
    root: &Path,
    proof: &DeletionProof,
    include_remote: bool,
    force: bool,
    expected: Option<&str>,
    protection_rules: Option<&[String]>,
) -> GitResult<DeletionResult> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            validate(root, proof, true)?;
            super::branch_protection::require_allowed(protection_rules, Some(&proof.name), if include_remote { proof.target.as_ref() } else { None })?;
            if include_remote && proof.target.is_none() {
                return Err(stale("Choose the remote branch to delete."));
            }
            require_retained(root, proof, true, include_remote, force)?;
            let checkpoint = checkpoint(root, proof, "branch_delete_reviewed", expected)?;
            validate(root, proof, true)?;
            let _ = super::more::record_deleted(root, &proof.name);
            let reference = format!("refs/heads/{}", proof.name);
            let out = runner::exec(root, ["update-ref", "--no-deref", "-d", &reference, &proof.local_oid])?;
            if !out.ok() {
                return Err(runner::to_error("git update-ref -d", &out).kind("stale-selection"));
            }
            // Ref deletion is complete. A failed metadata cleanup must not invite a
            // repeat of the destructive action or discard the successful checkpoint.
            let cleanup = runner::exec(root, ["config", "--remove-section", &format!("branch.{}", proof.name)]);
            let warning = match cleanup {
                Ok(out) if out.ok() || out.stderr.contains("no such section") => None,
                _ => Some("The branch was deleted and checkpoint saved, but its Git configuration section could not be removed.".into()),
            };
            Ok(DeletionResult { checkpoint, warning })
        },
    )
}

pub fn delete_remote(
    root: &Path,
    proof: &DeletionProof,
    force: bool,
    expected: Option<&str>,
    protection_rules: Option<&[String]>,
    on_line: impl FnMut(&str),
) -> GitResult<DeletionResult> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            validate(root, proof, false)?;
            let target = proof.target.as_ref().ok_or_else(|| stale("Choose the remote branch to delete."))?;
            super::branch_protection::require_allowed(protection_rules, None, Some(target))?;
            require_retained(root, proof, false, true, force)?;
            let checkpoint = checkpoint(root, proof, "branch_delete_remote_reviewed", expected)?;
            validate(root, proof, false)?;
            // The selected comparison was checked above. Reuse the sender with its
            // HEAD-specific ancestry check disabled; the exact-SHA server lease stays.
            branch_deletion::delete_remote(root, target, true, on_line)?;
            Ok(DeletionResult { checkpoint, warning: None })
        },
    )
}
