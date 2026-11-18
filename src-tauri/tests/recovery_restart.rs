//! Recovery after a restart: the result of an operation and what it changed stay beside its
//! checkpoint, are linked to its Operation log entry, and chosen files come back without
//! overwriting anything edited after the operation.
use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::recovery::{self, CheckpointFiles};
use revqora_lib::git::{operations, runner};
use revqora_lib::journal;

struct Repo {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Repo {
    /// A committed file, a modified tracked file and an ignored file.
    fn new() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo");
        fs::create_dir_all(&path).unwrap();
        let repo = Repo { _dir: dir, path };
        repo.git(&["init", "-q", "-b", "main"]);
        for (k, v) in [("user.name", "Tester"), ("user.email", "tester@example.com"), ("core.autocrlf", "false"), ("commit.gpgsign", "false")] {
            repo.git(&["config", k, v]);
        }
        repo.write(".gitignore", "*.env\n");
        repo.write("notes.txt", "committed\n");
        repo.write("draft.txt", "committed draft\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("draft.txt", "my uncommitted draft\n");
        repo.write("local.env", "SECRET=mine\n");
        repo
    }
    fn p(&self) -> &Path {
        &self.path
    }
    fn write(&self, name: &str, content: &str) {
        fs::write(self.path.join(name), content).unwrap();
    }
    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.path.join(name)).unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(&self.path, args).unwrap()
    }
}

/// Runs `f` as the queued operation `reset` (which saves the working tree and ignored files first)
/// and returns the checkpoint saved for it.
fn reset(repo: &Repo, f: impl FnOnce() -> runner::GitResult<()>) -> (runner::GitResult<()>, Option<String>) {
    let before: Vec<String> = recovery::list(repo.p()).map(|c| c.checkpoints.into_iter().map(|s| s.id).collect()).unwrap_or_default();
    let result = operations::run(repo.p(), "reset", None, |_, _| {}, f);
    recovery::take_ignored_report(repo.p());
    let created = recovery::list(repo.p()).unwrap().checkpoints.into_iter().map(|s| s.id).find(|id| !before.contains(id));
    (result, created)
}

fn state<'a>(files: &'a CheckpointFiles, path: &str) -> &'a str {
    &files.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} is not saved")).state
}

/// What an operation did reaches Git's working tree the way `git reset --hard` would.
fn overwrite_both(repo: &Repo) -> runner::GitResult<()> {
    repo.write("draft.txt", "committed draft\n");
    repo.write("local.env", "SECRET=from git\n");
    Ok(())
}

#[test]
fn the_result_and_changed_files_of_an_operation_are_kept_beside_its_checkpoint() {
    let repo = Repo::new();
    let (result, id) = reset(&repo, || overwrite_both(&repo));
    result.unwrap();
    let id = id.expect("reset saves a checkpoint");
    // Everything below is read from disk only, as after a restart.
    let listed = recovery::list(repo.p()).unwrap();
    assert_eq!(listed.checkpoints.iter().find(|c| c.id == id).unwrap().operation_status.as_deref(), Some("succeeded"));
    let files = recovery::files(repo.p(), &id).unwrap();
    let operation = files.operation.as_ref().expect("the operation result is recorded");
    assert_eq!((operation.record.command.as_str(), operation.effective_status.as_str()), ("reset", "succeeded"));
    assert!(operation.record.finished_at.is_some());
    assert_eq!(operation.record.changed.keys().collect::<Vec<_>>(), ["draft.txt", "local.env"], "only the paths the operation changed");
    assert_eq!(state(&files, "draft.txt"), "operation");
    assert_eq!(state(&files, "local.env"), "operation");
    assert!(files.files.iter().filter(|f| f.restorable).count() == 2);

    // Restoring both: each was still as the operation left it, so both are replaced, and the
    // versions the operation wrote are saved in a new checkpoint first.
    let outcome = recovery::restore_paths(repo.p(), &id, &["draft.txt".into(), "local.env".into()]).unwrap();
    assert_eq!(outcome.restored, ["draft.txt", "local.env"]);
    assert!(outcome.kept_both.is_empty() && outcome.failed.is_none() && outcome.checkpoint_error.is_none());
    assert_eq!(repo.read("draft.txt"), "my uncommitted draft\n");
    assert_eq!(repo.read("local.env"), "SECRET=mine\n");
    let safety = outcome.checkpoint.expect("the replaced versions are saved");
    let saved = recovery::detail(repo.p(), &safety).unwrap();
    assert_eq!(saved.summary.command, "recovery_restore_files");
    assert!(saved.paths.iter().any(|p| p.path == "local.env"));
    let after = recovery::files(repo.p(), &id).unwrap();
    assert!(after.files.iter().all(|f| f.state == "same"), "nothing left to restore");
    let last = after.last_restore.expect("the restore is logged beside the checkpoint");
    assert!(last.finished && last.not_finished.is_empty());
    assert_eq!(last.restored, ["draft.txt", "local.env"]);
    assert_eq!(last.checkpoint.as_deref(), Some(safety.as_str()));
}

#[test]
fn a_file_edited_after_the_operation_is_kept_and_the_saved_copy_written_beside_it() {
    let repo = Repo::new();
    let (result, id) = reset(&repo, || overwrite_both(&repo));
    result.unwrap();
    let id = id.unwrap();
    // The user goes on working on one of the files after the operation.
    repo.write("draft.txt", "rewritten after the reset\n");
    let files = recovery::files(repo.p(), &id).unwrap();
    assert_eq!(state(&files, "draft.txt"), "later");
    assert_eq!(state(&files, "local.env"), "operation");
    let outcome = recovery::restore_paths(repo.p(), &id, &["draft.txt".into(), "local.env".into()]).unwrap();
    assert_eq!(outcome.restored, ["local.env"]);
    assert_eq!(outcome.changed_since, ["draft.txt"]);
    assert_eq!(outcome.kept_both.len(), 1);
    assert_eq!(outcome.kept_both[0].copy, "draft.txt.recovered");
    assert_eq!(repo.read("draft.txt"), "rewritten after the reset\n", "the newer edit is never replaced");
    assert_eq!(repo.read("draft.txt.recovered"), "my uncommitted draft\n", "both versions are kept");
    // Restoring it again never overwrites the first copy.
    let again = recovery::restore_paths(repo.p(), &id, &["draft.txt".into()]).unwrap();
    assert_eq!(again.kept_both[0].copy, "draft.txt.recovered-2");
    assert_eq!(repo.read("draft.txt.recovered"), "my uncommitted draft\n");
}

#[test]
fn an_operation_the_app_did_not_finish_reads_as_interrupted_and_nothing_is_overwritten() {
    let repo = Repo::new();
    let mut running = None;
    let (result, id) = reset(&repo, || {
        // The app stops here: the checkpoint and its "running" record are all that reached disk.
        let storage = PathBuf::from(recovery::list(repo.p())?.storage_path);
        let record = fs::read_dir(&storage)?.flatten().map(|e| e.path().join("operation.json")).find(|p| p.exists()).unwrap();
        running = Some((record.clone(), fs::read(&record)?));
        overwrite_both(&repo)
    });
    result.unwrap();
    let id = id.unwrap();
    let (record, bytes) = running.unwrap();
    fs::write(record, bytes).unwrap();

    let listed = recovery::list(repo.p()).unwrap();
    assert_eq!(listed.checkpoints.iter().find(|c| c.id == id).unwrap().operation_status.as_deref(), Some("interrupted"));
    let files = recovery::files(repo.p(), &id).unwrap();
    assert_eq!(files.operation.as_ref().unwrap().effective_status, "interrupted");
    // What the operation did is unknown: changed files need a manual check.
    assert_eq!(state(&files, "draft.txt"), "unknown");
    assert_eq!(state(&files, "local.env"), "unknown");
    let outcome = recovery::restore_paths(repo.p(), &id, &["draft.txt".into(), "local.env".into()]).unwrap();
    assert!(outcome.restored.is_empty() && outcome.checkpoint.is_none());
    assert_eq!(outcome.changed_since, ["draft.txt", "local.env"]);
    assert_eq!(repo.read("draft.txt"), "committed draft\n");
    assert_eq!(repo.read("draft.txt.recovered"), "my uncommitted draft\n");
    assert_eq!(repo.read("local.env.recovered"), "SECRET=mine\n");
    // A file deleted since then is simply put back: nothing in its place can be lost.
    fs::remove_file(repo.p().join("draft.txt")).unwrap();
    let outcome = recovery::restore_paths(repo.p(), &id, &["draft.txt".into()]).unwrap();
    assert_eq!(outcome.restored, ["draft.txt"]);
    assert_eq!(repo.read("draft.txt"), "my uncommitted draft\n");
}

#[test]
fn a_restore_the_app_did_not_finish_shows_which_files_were_done() {
    let repo = Repo::new();
    let (result, id) = reset(&repo, || overwrite_both(&repo));
    result.unwrap();
    let id = id.unwrap();
    recovery::restore_paths(repo.p(), &id, &["draft.txt".into(), "local.env".into()]).unwrap();
    // The app stops after the first file: cut the log after its first result.
    let log = PathBuf::from(recovery::list(repo.p()).unwrap().storage_path).join(&id).join("restores.jsonl");
    let text = fs::read_to_string(&log).unwrap();
    let mut lines = text.lines();
    let kept = format!("{}\n{}\n{{\"at\":1,\"event\":\"resto", lines.next().unwrap(), lines.next().unwrap());
    fs::write(&log, kept).unwrap();
    let last = recovery::files(repo.p(), &id).unwrap().last_restore.unwrap();
    assert!(!last.finished);
    assert_eq!(last.restored, ["draft.txt"]);
    assert_eq!(last.not_finished, ["local.env"]);
}

#[test]
fn when_the_replaced_versions_cannot_be_saved_every_changed_file_is_kept_and_copied_beside() {
    let repo = Repo::new();
    let (result, id) = reset(&repo, || overwrite_both(&repo));
    result.unwrap();
    let id = id.unwrap();
    // A nested repository cannot be captured, so no checkpoint of the current versions can be made.
    let nested = repo.p().join("nested");
    fs::create_dir_all(&nested).unwrap();
    runner::run(&nested, ["init", "-q"]).unwrap();
    let outcome = recovery::restore_paths(repo.p(), &id, &["local.env".into()]).unwrap();
    assert!(outcome.checkpoint.is_none());
    assert!(outcome.checkpoint_error.as_deref().is_some_and(|e| e.contains("Nested")), "{:?}", outcome.checkpoint_error);
    assert!(outcome.restored.is_empty());
    assert_eq!(outcome.kept_both[0].copy, "local.env.recovered");
    assert_eq!(repo.read("local.env"), "SECRET=from git\n");
    assert_eq!(repo.read("local.env.recovered"), "SECRET=mine\n");
}

#[test]
fn a_checkpoint_that_cannot_be_written_stops_the_operation_before_it_changes_anything() {
    let repo = Repo::new();
    fs::remove_file(repo.p().join("local.env")).unwrap();
    // The recovery storage cannot be created (a file is in its place).
    let storage = PathBuf::from(recovery::list(repo.p()).unwrap().storage_path);
    assert!(!storage.exists());
    fs::write(&storage, "not a folder").unwrap();
    let mut ran = false;
    let result = operations::run(
        repo.p(),
        "reset",
        None,
        |_, _| {},
        || {
            ran = true;
            overwrite_both(&repo)
        },
    );
    let error = result.unwrap_err();
    assert_eq!(error.kind, "checkpoint-failed", "{}", error.message);
    assert!(error.message.contains("was not started"));
    assert!(!ran, "the operation never runs without its checkpoint");
    assert_eq!(repo.read("draft.txt"), "my uncommitted draft\n");
    fs::remove_file(&storage).unwrap();
}

#[test]
fn the_operation_log_entry_and_its_checkpoint_point_at_each_other() {
    let log_dir = tempfile::tempdir().unwrap();
    journal::initialize(Some(log_dir.path()));
    let repo = Repo::new();
    let entry = journal::begin(repo.p(), "reset").expect("journal");
    let (result, id) = reset(&repo, || overwrite_both(&repo));
    entry.finish(&result);
    drop(entry);
    let id = id.unwrap();
    let page = journal::store().unwrap().list(&journal::Filter { repo: Some(repo.p().to_string_lossy().into_owned()), ..Default::default() }, 10).unwrap();
    let logged = page.entries.iter().find(|e| e.command == "reset").unwrap();
    assert_eq!(logged.checkpoints, std::slice::from_ref(&id));
    let files = recovery::files(repo.p(), &id).unwrap();
    assert_eq!(files.operation.unwrap().record.operation.as_deref(), Some(logged.id.as_str()));
}
