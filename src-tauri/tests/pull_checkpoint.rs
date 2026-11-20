//! The checkpoint before a pull saves what the pull can change, not every local file.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::{operations, ops, recovery, runner};

fn git(dir: &Path, args: &[&str]) -> String {
    let mut all = vec!["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.invalid"];
    all.extend_from_slice(args);
    runner::run(dir, all).unwrap_or_else(|e| panic!("git {args:?}: {}", e.message)).trim().to_owned()
}

/// `work` is one commit behind `other`, which changes `incoming` to `text`.
fn behind(incoming: &str, text: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let (remote, other, work) = (tmp.path().join("remote.git"), tmp.path().join("other"), tmp.path().join("work"));
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(tmp.path(), &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]);
    fs::write(other.join("base.txt"), "base\n").unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-qm", "base"]);
    git(&other, &["push", "-q", "origin", "HEAD:main"]);
    git(tmp.path(), &["clone", "-q", remote.to_str().unwrap(), work.to_str().unwrap()]);
    git(&work, &["config", "core.autocrlf", "false"]);
    fs::write(work.join(".git/info/exclude"), "*.dat\n").unwrap();
    fs::write(other.join(incoming), text).unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-qm", "incoming"]);
    git(&other, &["push", "-q", "origin", "HEAD:main"]);
    (tmp, other, work)
}

fn pull(work: &Path) -> Result<ops::PullOutcome, runner::GitError> {
    operations::run(work, "pull", None, |_, _| {}, || ops::pull_with_prune(work, "ff-only", false, |_| {}))
}

/// Paths saved by this repository's checkpoints taken before a pull.
fn saved_before_pull(work: &Path) -> Vec<Vec<String>> {
    let catalog = recovery::list(work).unwrap();
    catalog
        .checkpoints
        .iter()
        .filter(|c| c.command == "pull")
        .map(|c| recovery::detail(work, &c.id).unwrap().paths.into_iter().map(|p| p.path).collect())
        .collect()
}

#[test]
fn a_pull_saves_tracked_changes_but_not_untracked_or_unrelated_ignored_files() {
    let (_tmp, other, work) = behind("shared.txt", "incoming\n");
    fs::write(work.join("base.txt"), "edited locally\n").unwrap();
    // Untracked data Git never overwrites in a pull, and an ignored file the pull does not touch.
    fs::write(work.join("big.bin"), vec![7u8; 3_000_000]).unwrap();
    fs::write(work.join("cache.dat"), "cache\n").unwrap();

    let outcome = pull(&work).unwrap();

    assert_eq!(outcome.operation.status, "fastForward", "{}", outcome.operation.message);
    assert_eq!(git(&work, &["rev-parse", "HEAD"]), git(&other, &["rev-parse", "HEAD"]));
    assert_eq!(fs::read_to_string(work.join("base.txt")).unwrap(), "edited locally\n");
    assert!(work.join("big.bin").exists() && work.join("cache.dat").exists());
    assert!(recovery::take_ignored_report(&work).is_none());
    let saved = saved_before_pull(&work);
    assert_eq!(saved.len(), 1, "one checkpoint: {saved:?}");
    assert!(saved[0].contains(&"base.txt".to_owned()), "{saved:?}");
    assert!(!saved[0].iter().any(|p| p == "big.bin" || p == "cache.dat"), "{saved:?}");
}

#[test]
fn a_pull_saves_the_ignored_files_in_the_way_of_the_incoming_commits() {
    // The incoming commit adds notes.dat, which is an ignored local file here.
    let (_tmp, _other, work) = behind("notes.dat", "from the server\n");
    fs::write(work.join("notes.dat"), "my notes\n").unwrap();
    fs::write(work.join("cache.dat"), "cache\n").unwrap();

    // The collision guard still stops the pull and asks first.
    let error = pull(&work).unwrap_err();
    assert_eq!(error.kind, "ignored-collision", "{}", error.message);
    assert_eq!(fs::read_to_string(work.join("notes.dat")).unwrap(), "my notes\n");
    let saved = saved_before_pull(&work);
    assert!(saved.iter().any(|paths| paths.contains(&"notes.dat".to_owned())), "{saved:?}");
    assert!(!saved.iter().flatten().any(|p| p == "cache.dat"), "{saved:?}");
}

#[test]
fn a_pull_keeps_one_checkpoint_with_the_staging_as_the_user_left_it() {
    // Staged work and an ignored file in the way of the incoming commit: the pull has one
    // "Before pull" checkpoint, taken before the staged work is set aside.
    let (tmp, _other, work) = behind("notes.dat", "from the server\n");
    fs::write(work.join("base.txt"), "staged\n").unwrap();
    git(&work, &["add", "base.txt"]);
    fs::write(work.join("notes.dat"), "my notes\n").unwrap();

    let error = pull(&work).unwrap_err();
    assert_eq!(error.kind, "ignored-collision", "{}", error.message);
    assert_eq!(git(&work, &["diff", "--cached", "--name-only"]), "base.txt", "the staging is back");

    let points: Vec<_> = recovery::list(&work).unwrap().checkpoints.into_iter().filter(|c| c.command == "pull").collect();
    assert_eq!(points.len(), 1, "one Before pull point: {:?}", points.iter().map(|c| &c.label).collect::<Vec<_>>());
    let saved: Vec<String> = recovery::detail(&work, &points[0].id).unwrap().paths.into_iter().map(|p| p.path).collect();
    assert!(saved.contains(&"notes.dat".to_owned()) && saved.contains(&"base.txt".to_owned()), "{saved:?}");

    // Restoring it brings the staged change back staged.
    let restored = tmp.path().join("restored");
    recovery::restore_workspace(&work, &points[0].id, &restored, "restored-pull").unwrap();
    assert_eq!(git(&restored, &["diff", "--cached", "--name-only"]), "base.txt");
    assert_eq!(fs::read_to_string(restored.join("base.txt")).unwrap(), "staged\n");
}
