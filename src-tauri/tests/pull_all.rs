//! Pull all: one fetch, then every branch that only lacks incoming commits moves forward.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::{ops, recovery, runner};

fn git(dir: &Path, args: &[&str]) -> String {
    let mut all = vec!["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.invalid"];
    all.extend_from_slice(args);
    runner::run(dir, all).unwrap_or_else(|e| panic!("git {args:?}: {}", e.message)).trim().to_owned()
}

fn commit(dir: &Path, file: &str, text: &str) -> String {
    fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", &format!("change {file}")]);
    git(dir, &["rev-parse", "HEAD"])
}

struct Fixture {
    _tmp: tempfile::TempDir,
    other: PathBuf,
    work: PathBuf,
    linked: PathBuf,
}

/// `work` tracks main (checked out), feature, diverged, linked (checked out in a second
/// worktree) and ahead; `other` then pushes new commits to all but ahead.
fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (remote, other, work, linked) = (root.join("remote.git"), root.join("other"), root.join("work"), root.join("linked"));
    git(root, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(root, &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]);
    commit(&other, "base.txt", "base\n");
    git(&other, &["push", "-q", "origin", "HEAD:main", "HEAD:feature", "HEAD:diverged", "HEAD:linked", "HEAD:ahead"]);
    git(root, &["clone", "-q", remote.to_str().unwrap(), work.to_str().unwrap()]);
    for branch in ["feature", "diverged", "linked", "ahead"] {
        git(&work, &["branch", "-q", "--track", branch, &format!("origin/{branch}")]);
    }
    git(&work, &["worktree", "add", "-q", linked.to_str().unwrap(), "linked"]);
    git(&work, &["checkout", "-q", "diverged"]);
    commit(&work, "local.txt", "local\n");
    git(&work, &["checkout", "-q", "ahead"]);
    commit(&work, "ahead.txt", "ahead\n");
    git(&work, &["checkout", "-q", "main"]);
    for branch in ["main", "feature", "diverged", "linked"] {
        git(&other, &["checkout", "-q", "-B", branch, &format!("origin/{branch}")]);
        commit(&other, "shared.txt", &format!("{branch} update\n"));
        git(&other, &["push", "-q", "origin", branch]);
    }
    Fixture { _tmp: tmp, other, work, linked }
}

fn tip(dir: &Path, reference: &str) -> String {
    git(dir, &["rev-parse", reference])
}

#[test]
fn pull_all_fast_forwards_every_branch_that_only_lacks_incoming_commits() {
    let f = fixture();
    let (diverged, ahead, linked) = (tip(&f.work, "diverged"), tip(&f.work, "ahead"), tip(&f.work, "linked"));
    // An unrelated local edit and an untracked file do not hold the checked-out branch back.
    fs::write(f.work.join("base.txt"), "edited locally\n").unwrap();
    fs::write(f.work.join("notes.txt"), "untracked\n").unwrap();

    let result = ops::pull_all_branches(&f.work, |_| {}).unwrap();

    let mut updated: Vec<_> = result.updated.iter().map(|u| (u.branch.as_str(), u.commits, u.current)).collect();
    updated.sort();
    assert_eq!(updated, [("feature", 1, false), ("main", 1, true)]);
    assert_eq!(tip(&f.work, "main"), tip(&f.other, "main"));
    assert_eq!(tip(&f.work, "feature"), tip(&f.other, "feature"));
    assert_eq!(fs::read_to_string(f.work.join("shared.txt")).unwrap(), "main update\n", "the checked-out files follow");
    assert_eq!(fs::read_to_string(f.work.join("base.txt")).unwrap(), "edited locally\n");
    assert!(f.work.join("notes.txt").exists());
    assert!(git(&f.work, &["stash", "list"]).is_empty(), "nothing is left in the stash");

    let mut skipped: Vec<_> = result.skipped.iter().map(|s| s.branch.as_str()).collect();
    skipped.sort();
    assert_eq!(skipped, ["diverged", "linked"]);
    assert!(result.skipped.iter().any(|s| s.branch == "diverged" && s.reason.contains("Diverged")));
    assert_eq!(tip(&f.work, "diverged"), diverged, "a diverged branch is never changed");
    assert_eq!(tip(&f.work, "ahead"), ahead, "a branch with only outgoing commits is left alone");
    assert_eq!(tip(&f.work, "linked"), linked, "the other worktree's branch is left for that worktree");
    assert_eq!(git(&f.linked, &["status", "--porcelain"]), "");

    // Nothing new: nothing changes and nothing is reported as updated.
    let checkpoints = recovery::list(&f.work).unwrap().checkpoints.len();
    assert!(checkpoints >= 1, "updating the checked-out branch keeps a recovery checkpoint first");
    let again = ops::pull_all_branches(&f.work, |_| {}).unwrap();
    assert!(again.updated.is_empty());
    assert_eq!(recovery::list(&f.work).unwrap().checkpoints.len(), checkpoints, "no checkpoint when nothing changes");
}

#[test]
fn pull_all_leaves_the_checked_out_branch_when_local_changes_touch_incoming_files() {
    let f = fixture();
    let main = tip(&f.work, "main");
    fs::write(f.work.join("shared.txt"), "my draft\n").unwrap();

    let result = ops::pull_all_branches(&f.work, |_| {}).unwrap();

    assert_eq!(tip(&f.work, "HEAD"), main);
    assert_eq!(fs::read_to_string(f.work.join("shared.txt")).unwrap(), "my draft\n");
    let reason = &result.skipped.iter().find(|s| s.branch == "main").expect("main is reported").reason;
    assert!(reason.contains("shared.txt"), "{reason}");
    // The other branches still move.
    assert_eq!(tip(&f.work, "feature"), tip(&f.other, "feature"));
    assert!(result.updated.iter().all(|u| !u.current));
}
