//! Explicit, reviewed synchronization of one checked-out branch. No implicit
//! stash, merge commit, rebase, tag publication or history rewrite.
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use super::branch_deletion::{self, RemoteBranchTarget};
use super::recovery::{self, Summary};
use super::runner::{self, GitError, GitResult};
use super::{repo, status};

// Safety decisions and transport must see the same physical commit graph.
// A lease checks a ref's old SHA, but does not itself prohibit rewriting history.
const ACTUAL_HISTORY: [(&str, &str); 2] = [("GIT_NO_REPLACE_OBJECTS", "1"), ("GIT_GRAFT_FILE", if cfg!(windows) { "NUL" } else { "/dev/null" })];
fn run<I, S>(root: &Path, args: I) -> GitResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    runner::run_env(root, args, &ACTUAL_HISTORY, None)
}
fn exec<I, S>(root: &Path, args: I) -> GitResult<runner::Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    runner::exec_full(root, args, &ACTUAL_HISTORY, None)
}
fn require_actual_history(root: &Path) -> GitResult<()> {
    // Query the actual configured path before our per-command null override.
    let grafts = runner::run(root, ["rev-parse", "--git-path", "info/grafts"])?;
    if !run(root, ["for-each-ref", "--format=%(refname)", "refs/replace/"])?.trim().is_empty()
        || root.join(grafts.trim()).try_exists()?
        || std::env::var_os("GIT_REPLACE_REF_BASE").is_some()
        || std::env::var_os("GIT_GRAFT_FILE").is_some()
    {
        return Err(GitError::new("Sync requires original commit history. Local replacement refs, legacy grafts or history override environment variables are configured; use individual Git actions after reviewing their effects."));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    pub branch: String,
    pub local_oid: String,
    pub server_oid: String,
    pub target: RemoteBranchTarget,
    pub ahead: u64,
    pub behind: u64,
    pub state_token: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub received: bool,
    pub sent: bool,
    pub checkpoint: Summary,
    pub warnings: Vec<String>,
}
fn stale() -> GitError {
    GitError::new("Repository, upstream or server branch changed. Prepare a new Sync review; nothing was synchronized.").kind("stale-operation")
}
fn clean(root: &Path) -> GitResult<status::StatusSummary> {
    require_actual_history(root)?;
    let info = repo::info(root)?;
    let s = status::status(root)?;
    if info.is_bare || info.head.detached || info.head.unborn || s.branch.is_none() || s.oid.is_none() {
        return Err(GitError::new("Sync requires a checked-out branch with an existing upstream."));
    }
    if info.state.kind != "none" || !s.files.is_empty() || s.conflict_count != 0 {
        return Err(GitError::new("Commit or stash local changes and finish the current operation before Sync."));
    }
    Ok(s)
}
fn upstream(root: &Path, branch: &str) -> GitResult<RemoteBranchTarget> {
    let targets = branch_deletion::targets(root, branch)?;
    let mut candidates = targets.into_iter().filter(|t| t.is_upstream);
    let target = candidates.next().ok_or_else(|| GitError::new("Configure an unambiguous remote upstream before Sync."))?;
    if candidates.next().is_some() || !target.tracking_ref.starts_with("refs/remotes/") {
        return Err(GitError::new("Sync requires a unique upstream under refs/remotes/. Use individual Git actions for custom mappings."));
    }
    branch_deletion::validate_mapping(root, &target)?;
    let owner = branch_deletion::remote_target(root, &target.tracking_ref)?;
    if owner.remote != target.remote || owner.remote_ref != target.remote_ref {
        return Err(stale());
    }
    let urls = run(root, ["remote", "get-url", "--all", &target.remote])?;
    if urls.lines().collect::<Vec<_>>() != vec![target.push_url.as_str()] {
        return Err(GitError::new("Fetch and push must use the same single server for Sync. Use Fetch and Push individually for this remote."));
    }
    if exec(root, ["symbolic-ref", "--quiet", &target.tracking_ref])?.ok() {
        return Err(stale());
    }
    Ok(target)
}
/// An ephemeral command-scoped remote has no fetch mappings. Git must not
/// opportunistically update configured refs before our checks (Git 2.56+).
fn transport(root: &Path, url: &str) -> GitResult<(Vec<String>, String)> {
    static IDS: AtomicU64 = AtomicU64::new(0);
    let name = format!("revqora-sync-{}-{}", std::process::id(), IDS.fetch_add(1, Ordering::Relaxed));
    if run(root, ["remote"])?.lines().any(|n| n == name) || exec(root, ["config", "--get-all", &format!("remotes.{name}")])?.code != 1 {
        return Err(GitError::new("Cannot allocate an isolated Sync transport."));
    }
    let args = vec!["-c".into(), format!("remote.{name}.url={url}"), "-c".into(), format!("remote.{name}.pushurl={url}")];
    // Reject a second URL rewrite or an existing remote used as a URL alias.
    // `remote get-url` does not recognize command-scoped remotes on older
    // supported Git versions. ls-remote --get-url resolves fetch rewriting
    // without contacting the server; explicit pushurl disables pushInsteadOf.
    let mut check = args.clone();
    check.extend(["ls-remote".into(), "--get-url".into(), "--".into(), name.clone()]);
    if run(root, &check)?.lines().collect::<Vec<_>>() != vec![url] {
        return Err(GitError::new("URL rewriting makes the Sync destination ambiguous. Use individual remote actions."));
    }
    Ok((args, name))
}
fn server_tip(root: &Path, target: &RemoteBranchTarget) -> GitResult<String> {
    let (mut args, name) = transport(root, &target.push_url)?;
    args.extend(["ls-remote".into(), "--heads".into(), "--refs".into(), "--".into(), name, target.remote_ref.clone()]);
    run(root, &args)?
        .lines()
        .find_map(|line| {
            let (oid, reference) = line.split_once('\t')?;
            (reference == target.remote_ref && (oid.len() == 40 || oid.len() == 64) && oid.bytes().all(|b| b.is_ascii_hexdigit())).then(|| oid.to_owned())
        })
        .ok_or_else(|| GitError::new("The upstream branch is missing on the server. Publish it with Push first."))
}
fn counts(root: &Path, local: &str, remote: &str) -> GitResult<(u64, u64)> {
    let text = run(root, ["rev-list", "--left-right", "--count", &format!("{local}...{remote}")])?;
    let values = text.split_whitespace().map(str::parse::<u64>).collect::<Result<Vec<_>, _>>().map_err(|_| GitError::new("Invalid ahead/behind response."))?;
    if values.len() != 2 {
        return Err(GitError::new("Invalid ahead/behind response."));
    }
    if values[0] > 0 && values[1] > 0 {
        return Err(GitError::new("Local and server history have diverged. Resolve with Merge or Rebase before Sync."));
    }
    Ok((values[0], values[1]))
}
pub fn prepare(root: &Path) -> GitResult<SyncPlan> {
    let before = clean(root)?;
    let branch = before.branch.clone().unwrap();
    let local_oid = before.oid.clone().unwrap();
    let target = upstream(root, &branch)?;
    let server_oid = server_tip(root, &target)?;
    let (mut args, name) = transport(root, &target.push_url)?;
    args.extend([
        "fetch".into(),
        "--no-tags".into(),
        "--no-prune".into(),
        "--no-write-fetch-head".into(),
        "--no-recurse-submodules".into(),
        "--".into(),
        name,
        server_oid.clone(),
    ]);
    run(root, &args)?;
    let (ahead, behind) = counts(root, &local_oid, &server_oid)?;
    let after = clean(root)?;
    if before.state_token != after.state_token || upstream(root, &branch)? != target {
        return Err(stale());
    }
    Ok(SyncPlan { branch, local_oid, server_oid, target, ahead, behind, state_token: after.state_token.ok_or_else(stale)? })
}
pub fn execute(root: &Path, plan: &SyncPlan, receive: bool, send: bool) -> GitResult<SyncResult> {
    let before = clean(root)?;
    if before.state_token.as_deref() != Some(&plan.state_token)
        || before.branch.as_deref() != Some(&plan.branch)
        || before.oid.as_deref() != Some(&plan.local_oid)
        || upstream(root, &plan.branch)? != plan.target
        || server_tip(root, &plan.target)? != plan.server_oid
    {
        return Err(stale());
    }
    let (ahead, behind) = counts(root, &plan.local_oid, &plan.server_oid)?;
    if (ahead, behind) != (plan.ahead, plan.behind) || (!receive && !send) || (receive && behind == 0) || (send && ahead == 0) {
        return Err(GitError::new("Select an available Sync direction from a fresh review."));
    }
    let checkpoint = recovery::create_expected(root, "sync_execute", "Before reviewed Sync", true, false, Some(&plan.state_token))?;
    let mut result = SyncResult { received: false, sent: false, checkpoint, warnings: Vec::new() };
    // Failures after this point can leave completed work. Return its exact outcome
    // and checkpoint instead of encouraging an automatic retry.
    let action = (|| -> GitResult<()> {
        if receive {
            run(
                root,
                [
                    "-c",
                    &format!("branch.{}.mergeOptions=", plan.branch),
                    "merge",
                    "--ff-only",
                    "--no-squash",
                    "--no-commit",
                    "--no-autostash",
                    "--no-overwrite-ignore",
                    "--",
                    &plan.server_oid,
                ],
            )?;
            let received = clean(root)?;
            if received.branch.as_deref() != Some(&plan.branch) || received.oid.as_deref() != Some(&plan.server_oid) {
                return Err(GitError::new("Receive did not leave the reviewed branch at the expected commit. Review the working copy; the recovery checkpoint preserves its previous state."));
            }
            result.received = true;
        }
        if send {
            let current = clean(root)?;
            if current.state_token != before.state_token || upstream(root, &plan.branch)? != plan.target {
                return Err(stale());
            }
            // A lease alone permits rewriting: explicitly prove fast-forward,
            // then push a fixed SHA rather than a movable local ref.
            run(root, ["merge-base", "--is-ancestor", &plan.server_oid, &plan.local_oid])?;
            let (mut args, name) = transport(root, &plan.target.push_url)?;
            args.extend([
                "push".into(),
                "--porcelain".into(),
                "--no-follow-tags".into(),
                "--recurse-submodules=no".into(),
                format!("--force-with-lease={}:{}", plan.target.remote_ref, plan.server_oid),
                "--".into(),
                name,
                format!("{}:{}", plan.local_oid, plan.target.remote_ref),
            ]);
            let pushed = run(root, &args);
            match server_tip(root, &plan.target) {
                Ok(oid) if oid == plan.local_oid => result.sent = true,
                Ok(oid) if oid == plan.server_oid => {
                    pushed?;
                    return Err(GitError::new("The server did not confirm the outgoing commit."));
                }
                _ => return Err(GitError::new("The server outcome is uncertain. Refresh and review before another Sync.")),
            }
        }
        let tip = if result.sent { &plan.local_oid } else { &plan.server_oid };
        if server_tip(root, &plan.target)? != *tip {
            return Err(GitError::new("The server advanced during Sync. Prepare a new review for its latest state."));
        }
        // Validate ownership again, then update only the reviewed cache by CAS.
        // --no-deref prevents a symbolic-ref race from changing a local branch.
        if upstream(root, &plan.branch)? != plan.target {
            return Err(GitError::new("Sync finished; upstream metadata changed and was preserved."));
        }
        run(root, ["update-ref", "--no-deref", &plan.target.tracking_ref, tip, &plan.target.oid])?;
        Ok(())
    })();
    if let Err(e) = action {
        result.warnings.push(e.message);
    }
    Ok(result)
}
