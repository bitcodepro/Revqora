//! Fetch, Pull and Push of several branches: all of them, or the chosen ones.

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
    // Pull all checks files out with the repository's own settings: keep line endings exact on
    // machines with a global core.autocrlf.
    git(&work, &["config", "core.autocrlf", "false"]);
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

#[test]
fn pull_all_leaves_a_branch_that_another_worktree_is_rebasing() {
    // During a rebase the worktree's HEAD is detached, so only the rebase state names the branch.
    let f = fixture();
    let linked = tip(&f.work, "linked");
    let stopped = runner::exec(&f.linked, ["-c", "core.editor=true", "rebase", "--exec", "exit 1", "--root"]).unwrap();
    assert!(!stopped.ok(), "the rebase stops at the failing exec");
    assert_ne!(runner::exec(&f.linked, ["symbolic-ref", "-q", "HEAD"]).unwrap().code, 0, "HEAD is detached during the rebase");

    let result = ops::pull_all_branches(&f.work, |_| {}).unwrap();

    assert_eq!(tip(&f.work, "linked"), linked, "the rebased branch is not moved under the rebase");
    let reason = &result.skipped.iter().find(|s| s.branch == "linked").expect("linked is reported").reason;
    assert!(reason.contains("rebase"), "{reason}");
    assert_eq!(tip(&f.work, "feature"), tip(&f.other, "feature"), "other branches still move");
    git(&f.linked, &["rebase", "--abort"]);
    assert_eq!(git(&f.linked, &["symbolic-ref", "--short", "HEAD"]), "linked");
}

fn names(list: &[String]) -> Vec<String> {
    let mut list = list.to_vec();
    list.sort();
    list
}

#[test]
fn pull_of_chosen_branches_fetches_and_moves_only_those() {
    let f = fixture();
    let (main, remote_main) = (tip(&f.work, "main"), tip(&f.work, "origin/main"));
    let chosen = ["refs/heads/feature", "refs/heads/ahead", "refs/heads/gone-locally"].map(String::from);

    let result = ops::pull_branches(&f.work, Some(&chosen), |_| {}).unwrap();

    // No separate Fetch first: Pull fetched the chosen branch's upstream itself.
    assert_eq!(tip(&f.work, "feature"), tip(&f.other, "feature"));
    let updated: Vec<_> = result.updated.iter().map(|u| (u.branch.as_str(), u.commits, u.current)).collect();
    assert_eq!(updated, [("feature", 1, false)]);
    assert_eq!(tip(&f.work, "main"), main, "a branch that was not chosen stays");
    assert_eq!(tip(&f.work, "origin/main"), remote_main, "only the chosen upstreams are fetched");
    let skipped = names(&result.skipped.iter().map(|s| format!("{}: {}", s.branch, s.reason)).collect::<Vec<_>>());
    assert_eq!(skipped, ["gone-locally: The branch no longer exists."]);

    // HEAD names the checked-out branch: the global "Pull All Current Branches".
    let result = ops::pull_branches(&f.work, Some(&["HEAD".to_owned()]), |_| {}).unwrap();
    let updated: Vec<_> = result.updated.iter().map(|u| (u.branch.as_str(), u.current)).collect();
    assert_eq!(updated, [("main", true)]);
    assert_eq!(fs::read_to_string(f.work.join("shared.txt")).unwrap(), "main update\n");
}

#[test]
fn fetch_of_chosen_branches_fetches_only_their_upstreams() {
    let f = fixture();
    let remote_main = tip(&f.work, "origin/main");
    // The upstream of linked was deleted on the server: the other branches are still fetched.
    git(&f.other, &["push", "-q", "origin", "--delete", "linked"]);
    let chosen = ["refs/heads/feature", "refs/heads/linked", "refs/remotes/origin/diverged"].map(String::from);

    let result = ops::fetch_branches(&f.work, &chosen, |_| {}).unwrap();

    assert_eq!(tip(&f.work, "origin/feature"), tip(&f.other, "feature"));
    assert_eq!(tip(&f.work, "origin/diverged"), tip(&f.other, "diverged"), "a chosen remote branch is fetched too");
    assert_eq!(tip(&f.work, "origin/main"), remote_main, "branches that were not chosen are not fetched");
    let updated: Vec<_> = result.updated.iter().map(|u| (u.branch.as_str(), u.commits)).collect();
    assert_eq!(updated, [("feature", 1)], "fetched branches with incoming commits are listed");
    let skipped: Vec<_> = result.skipped.iter().map(|s| (s.branch.as_str(), s.reason.as_str())).collect();
    assert_eq!(skipped, [("linked", "The branch no longer exists on origin.")]);
}

#[test]
fn push_of_chosen_branches_sends_what_the_remote_accepts_and_reports_the_rest() {
    let f = fixture();
    git(&f.work, &["branch", "-q", "local-only"]);
    let ahead = tip(&f.work, "ahead");
    let remote = f.work.parent().unwrap().join("remote.git");
    let diverged_on_server = git(&remote, &["rev-parse", "refs/heads/diverged"]);
    // Nothing fetched yet: diverged still looks only ahead, so the server refuses it.
    let chosen = ["refs/heads/ahead", "refs/heads/diverged", "refs/heads/local-only", "refs/heads/main"].map(String::from);

    let result = ops::push_branches(&f.work, Some(&chosen), |_| {}).unwrap();

    let updated: Vec<_> = result.updated.iter().map(|u| (u.branch.as_str(), u.commits)).collect();
    assert_eq!(updated, [("ahead", 1)]);
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/ahead"]), ahead);
    assert_eq!(tip(&f.work, "origin/ahead"), ahead);
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/diverged"]), diverged_on_server, "nothing is forced");
    let mut skipped: Vec<_> = result.skipped.iter().map(|s| (s.branch.as_str(), s.reason.as_str())).collect();
    skipped.sort();
    assert_eq!(skipped.len(), 2, "{skipped:?}");
    assert_eq!(skipped[0].0, "diverged");
    assert!(skipped[0].1.contains("Pull it first"), "{}", skipped[0].1);
    assert_eq!(skipped[1], ("local-only", "No upstream branch. Push it on its own once to publish it."));

    // Every branch: nothing left to send, and branches without an upstream are not reported.
    let again = ops::push_branches(&f.work, None, |_| {}).unwrap();
    assert!(again.updated.is_empty());
    assert!(again.skipped.iter().all(|s| s.branch == "diverged"), "{:?}", again.skipped.iter().map(|s| &s.branch).collect::<Vec<_>>());

    // A checkpoint only when something is sent: once fetched, diverged is not even tried.
    let checkpoints = recovery::list(&f.work).unwrap().checkpoints.len();
    assert!(checkpoints >= 1, "pushing keeps a recovery checkpoint first");
    git(&f.work, &["fetch", "-q", "origin"]);
    let idle = ops::push_branches(&f.work, None, |_| {}).unwrap();
    assert!(idle.updated.is_empty());
    assert_eq!(recovery::list(&f.work).unwrap().checkpoints.len(), checkpoints, "no checkpoint when nothing is sent");
}
