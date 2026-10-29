use revqora_lib::git::{operations, ops, rebase_studio as studio, recovery, runner, status, storage};
use std::fs;
use std::path::{Path, PathBuf};

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
    base: String,
    a: String,
    b: String,
}
impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("studio проверка");
        fs::create_dir(&root).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.autocrlf", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            git(&root, &args);
        }
        fs::write(root.join("f.txt"), "base\n").unwrap();
        let base = commit(&root, "Base");
        fs::write(root.join("f.txt"), "base\nA\n").unwrap();
        let a = commit(&root, "First change");
        fs::write(root.join("f.txt"), "base\nB\n").unwrap();
        let b = commit(&root, "Second change");
        Self { _temp: temp, root, base, a, b }
    }
    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }
    fn items(&self) -> Vec<ops::RebaseItem> {
        vec![
            ops::RebaseItem { oid: self.a.clone(), action: "pick".into(), message: None },
            ops::RebaseItem { oid: self.b.clone(), action: "reword".into(), message: Some("Second change rewritten".into()) },
        ]
    }
    fn review(&self, items: &[ops::RebaseItem]) -> studio::Review {
        operations::inspect(&self.root, || studio::review(&self.root, &self.a, items)).unwrap().0
    }
    fn run<T>(&self, name: &str, f: impl FnOnce() -> runner::GitResult<T>) -> runner::GitResult<T> {
        let token = status::status(&self.root)?.state_token;
        operations::run(&self.root, name, token.as_deref(), |_, _| {}, f)
    }
    fn start(&self, items: &[ops::RebaseItem], review: &studio::Review, published: bool, dirty: bool) -> runner::GitResult<studio::StartResult> {
        let expected = status::status(&self.root)?.state_token.unwrap();
        operations::run(
            &self.root,
            "rebase_studio_start",
            Some(&expected),
            |_, _| {},
            || studio::start(&self.root, &self.a, items, &review.token, &expected, published, dirty),
        )
    }
    fn index(&self) -> Vec<u8> {
        fs::read(self.root.join(".git/index")).unwrap()
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap().trim().into()
}
fn commit(root: &Path, message: &str) -> String {
    git(root, &["add", "-A"]);
    git(root, &["commit", "-qm", message]);
    git(root, &["rev-parse", "HEAD"])
}
fn hook(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}
fn sh(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace('\'', "'\\''")
}

#[test]
fn review_is_read_only_and_reports_custom_fetch_aliases_tags_and_worktrees() {
    let r = Repo::new();
    r.git(&["branch", "keep", &r.a]);
    r.git(&["tag", "-a", "release", "-m", "Annotated", &r.a]);
    r.git(&["remote", "add", "origin", "https://example.invalid/repo.git"]);
    r.git(&["config", "remote.origin.fetch", "+refs/heads/*:refs/cache/forge/*"]);
    r.git(&["update-ref", "refs/cache/forge/topic", &r.a]);
    let wt = r.root.parent().unwrap().join("related workspace");
    r.git(&["worktree", "add", wt.to_str().unwrap(), "keep"]);
    let index = r.index();
    let refs = r.git(&["show-ref"]);
    let files = fs::read(r.root.join("f.txt")).unwrap();
    let review = r.review(&r.items());
    assert_eq!(review.published_commits, 1);
    assert_eq!(review.branch_ref.as_deref(), Some("refs/heads/main"));
    assert!(review.references.iter().any(|v| v.name == "refs/cache/forge/topic" && v.remote && !v.rewritten));
    assert!(review.references.iter().any(|v| v.name == "refs/tags/release" && !v.rewritten));
    assert!(review.worktrees.iter().any(|v| !v.current && v.branch.as_deref() == Some("keep")));
    assert_eq!(r.index(), index);
    assert_eq!(r.git(&["show-ref"]), refs);
    assert_eq!(fs::read(r.root.join("f.txt")).unwrap(), files);
    // Changing the fetch policy must invalidate consent even when every
    // currently cached ref has the same name, SHA and publication status.
    r.git(&["config", "--add", "remote.origin.fetch", "^refs/heads/not-yet-cached"]);
    let changed = r.review(&r.items());
    assert_eq!(changed.published_commits, review.published_commits);
    assert_ne!(changed.token, review.token);
}
#[test]
fn review_identifies_the_current_worktree_through_a_directory_alias() {
    let r = Repo::new();
    #[cfg(unix)]
    let alias = {
        let alias = r.root.parent().unwrap().join("repository alias");
        std::os::unix::fs::symlink(&r.root, &alias).unwrap();
        alias
    };
    #[cfg(not(unix))]
    let alias = r.root.join(".");
    let (review, _) = operations::inspect(&alias, || studio::review(&alias, &r.a, &r.items())).unwrap();
    assert!(review.blockers.is_empty());
    assert_eq!(review.worktrees.iter().filter(|w| w.current).count(), 1);
}
#[test]
fn explicit_plan_disables_update_refs_and_preserves_related_branch_tag_and_worktree() {
    let r = Repo::new();
    r.git(&["config", "rebase.updateRefs", "true"]);
    r.git(&["config", "rebase.autoSquash", "true"]);
    r.git(&["branch", "keep", &r.a]);
    r.git(&["branch", "free-branch", &r.a]);
    r.git(&["tag", "-a", "release", "-m", "Annotated", &r.a]);
    let tag = r.git(&["rev-parse", "refs/tags/release"]);
    let wt = r.root.parent().unwrap().join("kept");
    r.git(&["worktree", "add", wt.to_str().unwrap(), "keep"]);
    let bytes = fs::read(wt.join("f.txt")).unwrap();
    let mut items = r.items();
    items[0].action = "reword".into();
    items[0].message = Some("First change rewritten".into());
    let review = r.review(&items);
    let result = r.start(&items, &review, false, false).unwrap();
    assert_eq!(result.outcome.status, "done");
    assert_eq!(result.report.phase, "completed");
    assert_ne!(result.report.after_head.as_deref(), Some(r.b.as_str()));
    assert_eq!(r.git(&["rev-parse", "refs/heads/keep"]), r.a);
    assert_eq!(r.git(&["rev-parse", "refs/heads/free-branch"]), r.a);
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), r.a);
    assert_eq!(fs::read(wt.join("f.txt")).unwrap(), bytes);
    assert_eq!(r.git(&["rev-parse", "refs/tags/release"]), tag);
    assert_eq!(r.git(&["config", "rebase.updateRefs"]), "true");
    assert!(result.report.after_checkpoint.is_some());
    let cmp = operations::inspect(&r.root, || studio::comparison(&r.root, &result.report.id)).unwrap().0;
    assert!(cmp.same_tree);
    assert_eq!(cmp.before.len(), 2);
    assert_eq!(cmp.after.len(), 2);
    assert!(cmp.range_diff.is_some());
}
#[test]
fn published_and_dirty_acknowledgements_are_checked_before_history_changes() {
    let r = Repo::new();
    r.git(&["remote", "add", "origin", "https://example.invalid/r.git"]);
    r.git(&["update-ref", "refs/remotes/origin/main", &r.b]);
    fs::write(r.root.join("draft"), "untracked").unwrap();
    let items = r.items();
    let review = r.review(&items);
    assert_eq!(review.published_commits, 2);
    assert_eq!(review.dirty_files, 1);
    let index = r.index();
    assert!(r.start(&items, &review, false, true).is_err());
    assert!(r.start(&items, &review, true, false).is_err());
    assert_eq!(r.git(&["rev-parse", "HEAD"]), r.b);
    assert_eq!(r.index(), index);
    assert!(studio::report(&r.root).unwrap().is_none());
    assert_eq!(fs::read_to_string(r.root.join("draft")).unwrap(), "untracked");
}
#[test]
fn plan_edits_and_ref_changes_invalidate_the_review() {
    let r = Repo::new();
    let items = r.items();
    let review = r.review(&items);
    let mut edited = items.clone();
    edited[1].message = Some("Different message".into());
    assert!(r.start(&edited, &review, false, false).err().unwrap().message.contains("review changed"));
    r.git(&["branch", "new-reference", &r.a]);
    assert!(r.start(&items, &review, false, false).err().unwrap().message.contains("review changed"));
    assert_eq!(r.git(&["rev-parse", "HEAD"]), r.b);
}
#[test]
fn queued_start_rejects_a_changed_displayed_state() {
    let r = Repo::new();
    let items = r.items();
    let review = r.review(&items);
    let token = status::status(&r.root).unwrap().state_token.unwrap();
    fs::write(r.root.join("f.txt"), "external edit").unwrap();
    let result =
        operations::run(&r.root, "rebase_studio_start", Some(&token), |_, _| {}, || studio::start(&r.root, &r.a, &items, &review.token, &token, false, false));
    assert!(result.is_err());
    assert_eq!(r.git(&["rev-parse", "HEAD"]), r.b);
    assert_eq!(fs::read_to_string(r.root.join("f.txt")).unwrap(), "external edit");
}
#[test]
fn original_staging_and_working_bytes_can_be_recovered_in_a_separate_worktree() {
    let r = Repo::new();
    fs::write(r.root.join("staged"), "stage only\r\n").unwrap();
    r.git(&["add", "staged"]);
    fs::write(r.root.join("f.txt"), "base\nB\nworking\n").unwrap();
    fs::write(r.root.join("untracked"), "keep me").unwrap();
    let items = r.items();
    let review = r.review(&items);
    let out = r.start(&items, &review, false, true).unwrap();
    assert_eq!(out.report.phase, "completed");
    assert_eq!(fs::read_to_string(r.root.join("untracked")).unwrap(), "keep me");
    let target = r.root.parent().unwrap().join("recovered");
    r.run("recovery_restore_workspace", || recovery::restore_workspace(&r.root, &out.report.before_checkpoint.id, &target, "recovered-studio")).unwrap();
    assert_eq!(fs::read(target.join("staged")).unwrap(), b"stage only\r\n");
    assert_eq!(fs::read_to_string(target.join("f.txt")).unwrap(), "base\nB\nworking\n");
    assert_eq!(git(&target, &["diff", "--cached", "--name-only"]), "staged");
    assert_eq!(fs::read_to_string(target.join("untracked")).unwrap(), "keep me");
}
#[test]
fn paused_session_is_persistent_and_continuation_records_its_exact_result() {
    let r = Repo::new();
    let mut items = r.items();
    items[0].action = "edit".into();
    let review = r.review(&items);
    let out = r.start(&items, &review, false, false).unwrap();
    assert_eq!(out.report.phase, "paused");
    let loaded = studio::report(&r.root).unwrap().unwrap();
    assert_eq!(loaded.id, out.report.id);
    assert_eq!(loaded.phase, "paused");
    let result = r.run("op_continue", || studio::step(&r.root, "rebase", None, || ops::continue_op(&r.root, "rebase", None))).unwrap();
    assert_eq!(result.studio_session.as_deref(), Some(out.report.id.as_str()));
    assert_eq!(result.outcome.status, "done");
    let loaded = studio::report(&r.root).unwrap().unwrap();
    assert_eq!(loaded.phase, "completed");
    assert_eq!(loaded.after_head.as_deref(), Some(r.git(&["rev-parse", "HEAD"]).as_str()));
    assert!(loaded.after_checkpoint.is_some());
}
#[test]
fn abort_keeps_a_checkpoint_of_manual_edits_made_after_the_pause() {
    let r = Repo::new();
    let mut items = r.items();
    items[0].action = "edit".into();
    let review = r.review(&items);
    r.start(&items, &review, false, false).unwrap();
    fs::write(r.root.join("f.txt"), "manual resolution").unwrap();
    let out = r.run("op_abort", || studio::abort(&r.root, "rebase", None)).unwrap();
    assert!(out.studio_session.is_some());
    assert_eq!(r.git(&["rev-parse", "HEAD"]), r.b);
    assert_eq!(studio::report(&r.root).unwrap().unwrap().phase, "aborted");
    let catalog = recovery::list(&r.root).unwrap();
    let point = catalog.checkpoints.iter().find(|p| p.command == "op_abort").unwrap();
    let target = r.root.parent().unwrap().join("manual-recovery");
    r.run("recovery_restore_workspace", || recovery::restore_workspace(&r.root, &point.id, &target, "manual-recovery")).unwrap();
    assert_eq!(fs::read_to_string(target.join("f.txt")).unwrap(), "manual resolution");
}
#[test]
fn a_conflicted_plan_can_finish_and_its_changed_tree_is_reported() {
    let r = Repo::new();
    let mut items = r.items();
    items[0].action = "drop".into();
    items[1].action = "pick".into();
    items[1].message = None;
    let review = r.review(&items);
    let out = r.start(&items, &review, false, false).unwrap();
    assert_eq!(out.outcome.status, "conflicts");
    assert_eq!(out.report.phase, "paused");
    assert!(r.run("op_continue", || studio::step(&r.root, "rebase", None, || ops::continue_op(&r.root, "rebase", None))).is_err());
    assert!(studio::report(&r.root).unwrap().unwrap().error.is_some());
    fs::write(r.root.join("f.txt"), "chosen resolution\n").unwrap();
    r.run("stage", || ops::stage_paths(&r.root, &["f.txt".into()])).unwrap();
    let out = r.run("op_continue", || studio::step(&r.root, "rebase", None, || ops::continue_op(&r.root, "rebase", None))).unwrap();
    assert_eq!(out.outcome.status, "done");
    let report = studio::report(&r.root).unwrap().unwrap();
    assert!(report.error.is_none());
    let cmp = studio::comparison(&r.root, &report.id).unwrap();
    assert!(!cmp.same_tree);
    assert_eq!(cmp.after.len(), 1);
    assert_eq!(fs::read_to_string(r.root.join("f.txt")).unwrap(), "chosen resolution\n");
}
#[test]
fn external_completion_requires_explicit_association_and_does_not_guess_success() {
    let r = Repo::new();
    let mut items = r.items();
    items[0].action = "edit".into();
    let review = r.review(&items);
    let out = r.start(&items, &review, false, false).unwrap();
    r.git(&["rebase", "--continue"]);
    let report = studio::report(&r.root).unwrap().unwrap();
    assert_eq!(report.phase, "unconfirmed");
    assert!(report.after_head.is_none());
    let head = report.candidate_head.unwrap();
    assert!(r.run("rebase_studio_capture", || studio::capture(&r.root, &out.report.id, &r.base, None)).is_err());
    let captured = r.run("rebase_studio_capture", || studio::capture(&r.root, &out.report.id, &head, None)).unwrap();
    assert_eq!(captured.phase, "captured");
    assert_eq!(captured.after_head.as_deref(), Some(head.as_str()));
    assert!(captured.warning.unwrap().contains("external Git"));
}
#[test]
fn a_new_external_rebase_with_the_same_original_head_cannot_steal_a_studio_session() {
    let r = Repo::new();
    let mut items = r.items();
    items[0].action = "edit".into();
    let review = r.review(&items);
    r.start(&items, &review, false, false).unwrap();
    let original_stamp = fs::metadata(r.root.join(".git/rebase-merge/orig-head")).unwrap().modified().unwrap();
    r.git(&["rebase", "--abort"]);
    std::thread::sleep(std::time::Duration::from_millis(30));
    r.run("interactive_rebase", || ops::interactive_rebase(&r.root, Some(&r.base), &items)).unwrap();
    fs::OpenOptions::new().write(true).open(r.root.join(".git/rebase-merge/orig-head")).unwrap().set_modified(original_stamp).unwrap();
    assert_eq!(studio::report(&r.root).unwrap().unwrap().phase, "unconfirmed");
    let out = r.run("op_continue", || studio::step(&r.root, "rebase", None, || ops::continue_op(&r.root, "rebase", None))).unwrap();
    assert!(out.studio_session.is_none());
    assert_eq!(studio::report(&r.root).unwrap().unwrap().phase, "unconfirmed");
}
#[test]
fn checked_out_duplicate_branch_is_a_blocker_but_other_worktrees_are_not_moved() {
    let r = Repo::new();
    let wt = r.root.parent().unwrap().join("duplicate");
    r.git(&["worktree", "add", "--force", wt.to_str().unwrap(), "main"]);
    let items = r.items();
    let review = r.review(&items);
    assert!(!review.blockers.is_empty());
    assert!(r.start(&items, &review, false, false).is_err());
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), r.b);
}
#[test]
fn detached_result_is_pinned_and_comparison_stays_bound_after_checkout_and_gc() {
    let r = Repo::new();
    r.git(&["checkout", "--detach", &r.b]);
    let items = r.items();
    let review = r.review(&items);
    assert!(review.branch_ref.is_none());
    let result = r.start(&items, &review, false, false).unwrap();
    let head = result.report.after_head.clone().unwrap();
    r.git(&["checkout", "main"]);
    r.git(&["reflog", "expire", "--expire=now", "--all"]);
    r.git(&["gc", "--prune=now"]);
    assert!(runner::exec(&r.root, ["cat-file", "-e", &head]).unwrap().ok());
    assert_eq!(r.git(&["rev-parse", "refs/heads/main"]), r.b);
    let cmp = studio::comparison(&r.root, &result.report.id).unwrap();
    assert_eq!(cmp.after.last().unwrap().oid, head);
    assert!(cmp.same_tree);
}
#[test]
fn failure_to_save_intent_does_not_rewrite_history() {
    let r = Repo::new();
    let dir = storage::dir(&r.root).unwrap().join("rebase-studio");
    fs::create_dir_all(dir.join("last.json")).unwrap();
    let items = r.items();
    let review = r.review(&items);
    let index = r.index();
    assert!(r.start(&items, &review, false, false).is_err());
    assert_eq!(r.git(&["rev-parse", "HEAD"]), r.b);
    assert_eq!(r.index(), index);
    assert!(dir.join("last.json").is_dir());
}
#[test]
fn post_rewrite_metadata_failure_is_a_warning_not_a_retryable_git_failure() {
    let r = Repo::new();
    let dir = storage::dir(&r.root).unwrap().join("rebase-studio");
    let record = dir.join("last.json");
    let backup = dir.join("saved.json");
    let script = format!("#!/bin/sh\nif test -f '{}'; then mv '{}' '{}' && mkdir '{}'; fi\nexit 0\n", sh(&record), sh(&record), sh(&backup), sh(&record));
    hook(&r.root.join(".git/hooks/post-rewrite"), &script);
    let items = r.items();
    let review = r.review(&items);
    let result = r.start(&items, &review, false, false).unwrap();
    assert_eq!(result.outcome.status, "done");
    assert_ne!(r.git(&["rev-parse", "HEAD"]), r.b);
    assert!(result.report.warning.unwrap().contains("already run"));
    assert!(result.report.after_checkpoint.is_some());
    assert!(backup.is_file());
}
#[test]
fn root_rewrite_and_control_characters_have_readable_before_after_history() {
    let r = Repo::new();
    let plan = ops::rebase_plan(&r.root, &r.base).unwrap();
    let mut items: Vec<_> = plan.commits.iter().map(|c| ops::RebaseItem { oid: c.oid.clone(), action: "pick".into(), message: None }).collect();
    items[0].action = "reword".into();
    items[0].message = Some("New root\n\nBody with record separator \u{1e} and field \u{1f}".into());
    let review = studio::review(&r.root, &r.base, &items).unwrap();
    let expected = status::status(&r.root).unwrap().state_token.unwrap();
    let result = operations::run(
        &r.root,
        "rebase_studio_start",
        Some(&expected),
        |_, _| {},
        || studio::start(&r.root, &r.base, &items, &review.token, &expected, false, false),
    )
    .unwrap();
    let cmp = studio::comparison(&r.root, &result.report.id).unwrap();
    assert_eq!(cmp.after.len(), 3);
    assert!(cmp.after[0].body.contains('\u{1e}'));
    assert!(cmp.same_tree);
    assert!(cmp.range_diff.is_none());
}
#[test]
fn invalid_actions_duplicate_commits_and_uncombined_squash_messages_are_rejected() {
    let r = Repo::new();
    for action in ["fixup", "squash", "invalid"] {
        let mut items = r.items();
        items[0].action = action.into();
        assert!(studio::review(&r.root, &r.a, &items).is_err());
    }
    let mut items = r.items();
    items[1].oid = items[0].oid.clone();
    assert!(studio::review(&r.root, &r.a, &items).is_err());
    let mut items = r.items();
    items[1].action = "squash".into();
    assert!(studio::review(&r.root, &r.a, &items).is_err());
    assert_eq!(r.git(&["rev-parse", "HEAD"]), r.b);
}

#[test]
fn unexpected_ref_changes_by_user_hooks_are_recorded_and_warned_about() {
    let r = Repo::new();
    r.git(&["branch", "free-branch", &r.a]);
    hook(&r.root.join(".git/hooks/post-rewrite"), &format!("#!/bin/sh\ngit update-ref refs/heads/free-branch {}\n", r.base));
    let items = r.items();
    let review = r.review(&items);
    let result = r.start(&items, &review, false, false).unwrap();
    assert_eq!(result.outcome.status, "done");
    assert_eq!(r.git(&["rev-parse", "refs/heads/free-branch"]), r.base);
    assert!(result.report.warning.unwrap().contains("Other reviewed references changed"));
    let change = result.report.ref_changes.iter().find(|v| v.name == "refs/heads/free-branch").unwrap();
    assert_eq!(change.before, r.a);
    assert_eq!(change.after.as_deref(), Some(r.base.as_str()));
}

#[cfg(windows)]
mod windows_long_profile {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::process::Command;

    #[test]
    fn report_creation_and_replacement_survive_a_long_portable_profile() {
        let temporary = tempfile::tempdir().unwrap();
        let mut profile = temporary.path().join("portable profile");
        let length = profile.as_os_str().encode_wide().count();
        if length < 150 {
            profile.push("p".repeat(149 - length));
        }
        fs::create_dir_all(&profile).unwrap();
        // Portable storage is cached per process. Give this case its own
        // profile without racing the other tests' environment or data.
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "windows_long_profile::roundtrip_child", "--ignored", "--nocapture"])
            .env("REVQORA_STUDIO_LONG_PROFILE_CHILD", "1")
            .env("REVQORA_MULTI_INSTANCE", "1")
            .env("WEBVIEW2_USER_DATA_FOLDER", &profile)
            .output()
            .unwrap();
        assert!(child.status.success(), "{}\n{}", String::from_utf8_lossy(&child.stdout), String::from_utf8_lossy(&child.stderr));
    }

    #[test]
    #[ignore = "Run through the parent with an isolated portable profile"]
    fn roundtrip_child() {
        assert_eq!(std::env::var("REVQORA_STUDIO_LONG_PROFILE_CHILD").as_deref(), Ok("1"));
        let r = Repo::new();
        let file = storage::dir(&r.root).unwrap().join("rebase-studio/last.json");
        assert!(file.as_os_str().encode_wide().count() > 260, "Regression requires a path beyond MAX_PATH: {file:?}");
        // Exercise Studio's longer record path without requiring the user's
        // Git to enable core.longpaths for unrelated rebase message files.
        assert!(storage::dir(&r.root).unwrap().join("ri-msg-1").as_os_str().encode_wide().count() < 260);
        let items = r.items();
        let review = r.review(&items);
        // Start saves a new intent, then atomically replaces it with the result.
        let result = r.start(&items, &review, false, false).unwrap();
        assert_eq!(result.report.phase, "completed", "{:?}", result.outcome);
        let reopened = studio::report(&r.root).unwrap().unwrap();
        assert_eq!(reopened.id, result.report.id);
        assert_eq!(reopened.phase, "completed");
        assert_eq!(reopened.after_head.as_deref(), Some(r.git(&["rev-parse", "HEAD"]).as_str()));
        assert!(reopened.after_checkpoint.is_some());
        assert!(studio::comparison(&r.root, &reopened.id).unwrap().same_tree);
    }
}
