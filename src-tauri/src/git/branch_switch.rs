use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::runner::{self, GitError, GitResult};
use super::{layers, ops, refs, status};

const STASH_PREFIX: &str = "Revqora switch ";

pub(super) fn stash_source(subject: &str) -> Option<String> {
    let (source, _) = subject.split_once(": ")?.1.strip_prefix(STASH_PREFIX)?.split_once(' ')?;
    Some(source.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirtyAction {
    Stash,
    Move,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchChoice {
    action: DirtyAction,
    target_oid: String,
}

#[derive(Deserialize)]
pub struct SourceHead {
    branch: Option<String>,
    oid: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SwitchOutcome {
    Review { source: String, target_oid: String, state_token: String, files: usize },
    Switched { branch: String, saved: bool, moved: bool, conflicts: Vec<String>, warning: Option<String> },
}

fn stale() -> GitError {
    GitError::new("The source or destination changed. Open the branch switch again to review it.").kind("stale-operation")
}

fn target_reference(repo: &Path, target: &str, kind: &str) -> GitResult<(Option<String>, String)> {
    match kind {
        "local" => Ok((Some(target.into()), format!("refs/heads/{target}"))),
        "remote" => {
            let local = target.split_once('/').map(|(_, branch)| branch).unwrap_or(target);
            let reference = format!("refs/heads/{local}");
            let exists = runner::exec(repo, ["show-ref", "--verify", "--quiet", &reference])?.ok();
            Ok((Some(local.into()), if exists { reference } else { format!("refs/remotes/{target}") }))
        }
        "commit" => Ok((None, target.into())),
        _ => Err(GitError::new("Invalid checkout target.")),
    }
}

fn stash_message(source: &str) -> String {
    static IDS: AtomicU64 = AtomicU64::new(0);
    let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{STASH_PREFIX}{source} {}-{time}-{}", std::process::id(), IDS.fetch_add(1, Ordering::Relaxed))
}

fn find_stash(repo: &Path, message: &str) -> GitResult<refs::StashInfo> {
    refs::stashes(repo)?
        .into_iter()
        .find(|stash| stash.message.split_once(": ").is_some_and(|(_, subject)| subject == message))
        .ok_or_else(|| GitError::new("Could not verify the saved stash. Inspect Stashes and the working tree before retrying."))
}

fn working_state(repo: &Path) -> GitResult<status::StatusSummary> {
    let raw = runner::run(repo, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=none"])?;
    Ok(status::parse(&raw))
}

fn resolve_commit(repo: &Path, reference: &str) -> GitResult<String> {
    runner::run(repo, ["rev-parse", "--verify", "--end-of-options", &format!("{reference}^{{commit}}")]).map(|oid| oid.trim().to_string())
}

pub fn switch(
    repo: &Path,
    target: &str,
    kind: &str,
    choice: Option<SwitchChoice>,
    expected: Option<&str>,
    source_head: Option<&SourceHead>,
) -> GitResult<SwitchOutcome> {
    if target.starts_with('-') {
        return Err(GitError::new("Invalid checkout target."));
    }
    let current = working_state(repo)?;
    if source_head.is_some_and(|head| head.branch != current.branch || head.oid != current.oid) {
        return Err(stale());
    }
    let (branch, reference) = target_reference(repo, target, kind)?;
    let same_branch = branch.is_some() && current.branch == branch;
    if choice.is_none() && (current.files.is_empty() || same_branch) {
        let branch = ops::checkout(repo, target, kind)?;
        return Ok(SwitchOutcome::Switched { branch, saved: false, moved: false, conflicts: Vec::new(), warning: None });
    }
    if same_branch || current.files.is_empty() {
        return Err(stale());
    }
    let oid = current.oid.as_deref().ok_or_else(|| GitError::new("Make the first commit before saving changes for a branch switch."))?;
    let source = current.branch.as_ref().map_or_else(|| format!("HEAD/{oid}"), |name| format!("refs/heads/{name}"));
    if current.conflict_count > 0 {
        return Err(GitError::new("Resolve existing conflicts before switching branches."));
    }
    if current.files.iter().any(|file| file.submodule) {
        return Err(GitError::new("Save changed submodules separately before switching branches."));
    }
    if current.files.iter().any(|file| file.untracked && file.path.ends_with('/')) {
        return Err(GitError::new("Save untracked nested repositories separately before switching branches."));
    }
    if layers::staged_base(repo).is_some() {
        return Err(GitError::new("Finish or flatten your stage layers before switching branches with uncommitted changes."));
    }
    let target_oid = resolve_commit(repo, &reference)?;
    let Some(choice) = choice else {
        let state_token = match expected {
            Some(token) => token.to_string(),
            None => {
                let reviewed = status::status(repo)?;
                if reviewed.branch != current.branch || reviewed.oid != current.oid {
                    return Err(stale());
                }
                reviewed.state_token.ok_or_else(stale)?
            }
        };
        return Ok(SwitchOutcome::Review { source, target_oid, state_token, files: current.files.len() });
    };
    if expected.is_none() || choice.target_oid != target_oid {
        return Err(stale());
    }

    let message = stash_message(&source);
    ops::stash_save(repo, &message, true, false, &[])?;
    let stash = find_stash(repo, &message)?;
    let stashed = working_state(repo)?;
    if !stashed.files.is_empty() {
        return Err(GitError::new("Some changes could not be stashed. The branch was kept and the saved changes are in Stashes.").kind("partial-operation"));
    }
    let (_, latest_reference) = target_reference(repo, target, kind)?;
    if stashed.branch != current.branch || stashed.oid != current.oid || latest_reference != reference || resolve_commit(repo, &reference)? != target_oid {
        return Err(GitError::new("The source or destination changed during the switch. Saved changes are still in Stashes.").kind("partial-operation"));
    }
    let branch = ops::checkout(repo, target, kind)
        .map_err(|error| GitError::new(format!("{}. Saved changes are still in Stashes for the source branch.", error.message)).kind("partial-operation"))?;
    let mut moved = false;
    let mut conflicts = Vec::new();
    let mut warning = None;
    if matches!(choice.action, DirtyAction::Move) {
        let applied = (|| {
            let destination = working_state(repo)?;
            if destination.branch.as_deref() != (kind != "commit").then_some(branch.as_str())
                || destination.oid.as_deref() != Some(&target_oid)
                || !destination.files.is_empty()
            {
                return Err(stale());
            }
            let result = ops::stash_apply_ref(repo, &stash.oid, false)?;
            conflicts = result.conflicts;
            if conflicts.is_empty() {
                moved = true;
                let latest = find_stash(repo, &message)?;
                ops::stash_drop_reviewed(repo, latest.index, &stash.oid)?;
            }
            Ok(())
        })();
        if let Err(error) = applied {
            warning = Some(format!("{}. Check the working tree and Stashes before trying again.", error.message));
        }
    }
    Ok(SwitchOutcome::Switched { branch, saved: true, moved, conflicts, warning })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(repo: &Path, args: &[&str]) -> String {
        runner::run(repo, args).unwrap().trim().to_string()
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-qb", "main"]);
        for (key, value) in [("user.name", "Fixture"), ("user.email", "fixture@example.test"), ("core.autocrlf", "false"), ("commit.gpgsign", "false")] {
            git(repo, &["config", key, value]);
        }
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(repo, &["add", "."]);
        git(repo, &["commit", "-qm", "Base"]);
        git(repo, &["branch", "target"]);
        dir
    }

    fn review(repo: &Path) -> (String, String) {
        match switch(repo, "target", "local", None, None, None).unwrap() {
            SwitchOutcome::Review { state_token, target_oid, .. } => (state_token, target_oid),
            _ => panic!("Dirty checkout should require a review"),
        }
    }

    fn confirm(repo: &Path, action: DirtyAction, state: &str, target_oid: String) -> GitResult<SwitchOutcome> {
        super::super::operations::run(
            repo,
            "checkout",
            Some(state),
            |_, _| {},
            || switch(repo, "target", "local", Some(SwitchChoice { action, target_oid }), Some(state), None),
        )
    }

    #[test]
    fn initial_checkout_verifies_the_displayed_head_and_reviews_fresh_worktree_changes() {
        let dir = fixture();
        let repo = dir.path();
        let displayed = SourceHead { branch: Some("main".into()), oid: Some(git(repo, &["rev-parse", "HEAD"])) };
        let switch_from_displayed =
            || super::super::operations::run(repo, "checkout", None, |_, _| {}, || switch(repo, "target", "local", None, None, Some(&displayed)));

        git(repo, &["switch", "-qc", "external"]);
        assert_eq!(switch_from_displayed().err().unwrap().kind, "stale-operation");
        assert_eq!(git(repo, &["branch", "--show-current"]), "external");

        git(repo, &["switch", "-q", "main"]);
        fs::write(repo.join("file.txt"), "changed outside Revqora\n").unwrap();
        let outcome = switch_from_displayed().unwrap();
        let SwitchOutcome::Review { files: 1, state_token, target_oid, .. } = outcome else {
            panic!("Fresh changes must be reviewed before checkout");
        };
        assert_eq!(git(repo, &["branch", "--show-current"]), "main");
        assert!(refs::stashes(repo).unwrap().is_empty());
        fs::write(repo.join("file.txt"), "changed again after review\n").unwrap();
        assert_eq!(confirm(repo, DirtyAction::Stash, &state_token, target_oid).err().unwrap().kind, "stale-operation");
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "changed again after review\n");
    }

    #[test]
    fn returning_to_source_restores_index_worktree_and_untracked_files() {
        let dir = fixture();
        let repo = dir.path();
        fs::write(repo.join("file.txt"), "staged\n").unwrap();
        git(repo, &["add", "file.txt"]);
        fs::write(repo.join("file.txt"), "working\n").unwrap();
        fs::write(repo.join("new.txt"), "new\n").unwrap();
        let (state, target) = review(repo);
        assert!(refs::stashes(repo).unwrap().is_empty());
        assert!(matches!(confirm(repo, DirtyAction::Stash, &state, target).unwrap(), SwitchOutcome::Switched { saved: true, moved: false, .. }));
        assert_eq!(git(repo, &["branch", "--show-current"]), "target");
        assert!(working_state(repo).unwrap().files.is_empty());
        let stash = refs::stashes(repo).unwrap().remove(0);
        assert_eq!(stash.switch_source.as_deref(), Some("refs/heads/main"));
        switch(repo, "main", "local", None, None, None).unwrap();
        assert_eq!(ops::stash_apply_reviewed(repo, stash.index, &stash.oid, true).unwrap().status, "done");
        assert_eq!(git(repo, &["show", ":file.txt"]), "staged");
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "working\n");
        assert_eq!(fs::read_to_string(repo.join("new.txt")).unwrap(), "new\n");
        assert!(refs::stashes(repo).unwrap().is_empty());
    }

    #[test]
    fn successful_move_removes_only_its_own_stash() {
        let dir = fixture();
        let repo = dir.path();
        fs::write(repo.join("file.txt"), "existing stash\n").unwrap();
        git(repo, &["stash", "push", "-m", "existing"]);
        let existing = refs::stashes(repo).unwrap().remove(0).oid;
        fs::write(repo.join("file.txt"), "moved\n").unwrap();
        git(repo, &["add", "file.txt"]);
        let (state, target) = review(repo);
        assert!(matches!(confirm(repo, DirtyAction::Move, &state, target).unwrap(), SwitchOutcome::Switched { moved: true, warning: None, .. }));
        assert_eq!(git(repo, &["branch", "--show-current"]), "target");
        assert_eq!(git(repo, &["show", ":file.txt"]), "moved");
        let remaining = refs::stashes(repo).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].oid, existing);
    }

    #[test]
    fn move_conflict_stays_on_destination_and_keeps_original_stash() {
        let dir = fixture();
        let repo = dir.path();
        git(repo, &["switch", "-q", "target"]);
        fs::write(repo.join("file.txt"), "destination\n").unwrap();
        git(repo, &["commit", "-qam", "Destination"]);
        git(repo, &["switch", "-q", "main"]);
        fs::write(repo.join("file.txt"), "source\n").unwrap();
        let (state, target) = review(repo);
        assert!(
            matches!(confirm(repo, DirtyAction::Move, &state, target).unwrap(), SwitchOutcome::Switched { moved: false, conflicts, .. } if conflicts == ["file.txt"])
        );
        assert_eq!(git(repo, &["branch", "--show-current"]), "target");
        assert_eq!(working_state(repo).unwrap().conflict_count, 1);
        let stash = refs::stashes(repo).unwrap().remove(0);
        assert_eq!(git(repo, &["show", &format!("{}:file.txt", stash.oid)]), "source");
    }

    #[test]
    fn changed_destination_is_rejected_before_stashing() {
        let dir = fixture();
        let repo = dir.path();
        git(repo, &["switch", "-qc", "other"]);
        git(repo, &["commit", "-qm", "Other", "--allow-empty"]);
        git(repo, &["switch", "-q", "main"]);
        fs::write(repo.join("file.txt"), "working\n").unwrap();
        let (state, target) = review(repo);
        git(repo, &["branch", "-f", "target", "other"]);
        assert_eq!(confirm(repo, DirtyAction::Move, &state, target).err().unwrap().kind, "stale-operation");
        assert_eq!(git(repo, &["branch", "--show-current"]), "main");
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "working\n");
        assert!(refs::stashes(repo).unwrap().is_empty());
    }

    #[test]
    fn restoring_a_switch_stash_preserves_ignored_data() {
        let dir = fixture();
        let repo = dir.path();
        fs::write(repo.join("private.txt"), "uncommitted\n").unwrap();
        let (state, target) = review(repo);
        confirm(repo, DirtyAction::Stash, &state, target).unwrap();
        switch(repo, "main", "local", None, None, None).unwrap();
        fs::write(repo.join(".git/info/exclude"), "private.txt\n").unwrap();
        fs::write(repo.join("private.txt"), "ignored data\n").unwrap();
        let stash = refs::stashes(repo).unwrap().remove(0);
        assert!(ops::stash_apply_reviewed(repo, stash.index, &stash.oid, true).is_err());
        assert_eq!(fs::read_to_string(repo.join("private.txt")).unwrap(), "ignored data\n");
        assert_eq!(refs::stashes(repo).unwrap()[0].oid, stash.oid);
    }
}
