use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::{branch_deletion, runner};

struct Repo {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo");
        let remote = dir.path().join("origin.git");
        fs::create_dir_all(&path).unwrap();
        fs::create_dir_all(&remote).unwrap();
        runner::run(&remote, ["init", "--bare", "-q"]).unwrap();
        let repo = Self { _dir: dir, path };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "Tester"]);
        repo.git(&["config", "user.email", "tester@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.git(&["commit", "--allow-empty", "-qm", "Initial"]);
        repo.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
        repo.git(&["branch", "topic"]);
        repo.git(&["push", "-q", "-u", "origin", "topic"]);
        repo
    }
    fn p(&self) -> &Path {
        &self.path
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(self.p(), args).unwrap().trim().to_owned()
    }
    fn local_exists(&self) -> bool {
        !self.git(&["branch", "--list", "topic"]).is_empty()
    }
    fn remote_exists(&self, name: &str) -> bool {
        !self.git(&["ls-remote", "--heads", "origin", &format!("refs/heads/{name}")]).is_empty()
    }
    fn advance(&self, push: bool) {
        let tip = self.git(&["commit-tree", &self.git(&["rev-parse", "HEAD^{tree}"]), "-p", "HEAD", "-m", "Topic only"]);
        self.git(&["update-ref", "refs/heads/topic", &tip]);
        if push {
            self.git(&["push", "-q", "origin", "topic"]);
        }
    }
    fn second_clone(&self) -> PathBuf {
        let clone = self._dir.path().join("other-clone");
        self.git(&["clone", "-q", "--branch", "topic", &self.git(&["remote", "get-url", "origin"]), clone.to_str().unwrap()]);
        for args in [["config", "user.name", "Other"], ["config", "user.email", "other@example.com"], ["config", "commit.gpgsign", "false"]] {
            runner::run(&clone, args).unwrap();
        }
        clone
    }
    fn push_from_other(&self, clone: &Path) -> String {
        runner::run(clone, ["commit", "--allow-empty", "-qm", "Unseen server commit"]).unwrap();
        runner::run(clone, ["push", "-q", "origin", "topic"]).unwrap();
        runner::run(clone, ["rev-parse", "HEAD"]).unwrap().trim().to_owned()
    }
}

#[test]
fn custom_upstream_mapping_deletes_only_the_intended_server_ref() {
    let r = Repo::new();
    r.git(&["push", "-q", "origin", "topic:refs/heads/topic2"]);
    r.git(&["config", "remote.origin.fetch", "+refs/heads/topic:refs/remotes/origin/topic2"]);
    r.git(&["fetch", "-q", "origin"]);
    let targets = branch_deletion::targets(r.p(), "topic").unwrap();
    assert_eq!(targets.len(), 1);
    let t = &targets[0];
    assert_eq!(t.remote_ref, "refs/heads/topic");
    assert_eq!(t.tracking_ref, "refs/remotes/origin/topic2");
    assert_eq!(t.label, "origin/topic");
    branch_deletion::delete(r.p(), "topic", false, Some(t)).unwrap();
    branch_deletion::delete_remote(r.p(), t, false, |_| {}).unwrap();
    assert!(!r.local_exists());
    assert!(!r.remote_exists("topic"));
    assert!(r.remote_exists("topic2"));
}

#[test]
fn exact_and_wildcard_inverse_mappings_work_without_upstream() {
    for spec in ["+refs/heads/topic:refs/remotes/origin/renamed", "+refs/heads/*:refs/remotes/origin/prefix-*"] {
        let r = Repo::new();
        r.git(&["branch", "--unset-upstream", "topic"]);
        r.git(&["config", "remote.origin.fetch", spec]);
        r.git(&["fetch", "-q", "origin"]);
        let targets = branch_deletion::targets(r.p(), "topic").unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].remote_ref, "refs/heads/topic");
        assert!(!targets[0].is_upstream);
    }
}

#[test]
fn ambiguous_excluded_and_unmapped_refs_are_not_offered() {
    let r = Repo::new();
    r.git(&["branch", "--unset-upstream", "topic"]);
    r.git(&["config", "remote.origin.fetch", "+refs/heads/topic:refs/remotes/origin/topic"]);
    r.git(&["config", "--add", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/topic"]);
    assert!(branch_deletion::targets(r.p(), "topic").unwrap().is_empty());
    r.git(&["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    r.git(&["config", "--add", "remote.origin.fetch", "^refs/heads/topic"]);
    assert!(branch_deletion::targets(r.p(), "topic").unwrap().is_empty());
    r.git(&["config", "--unset-all", "remote.origin.fetch"]);
    assert!(branch_deletion::targets(r.p(), "topic").unwrap().is_empty());
}

#[test]
fn pushed_and_unpushed_history_requires_confirmation_before_either_deletion() {
    for push in [true, false] {
        let r = Repo::new();
        r.advance(push);
        let t = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
        let err = branch_deletion::delete(r.p(), "topic", false, Some(&t)).unwrap_err();
        assert_eq!(err.kind, "not-merged");
        assert!(r.local_exists());
        assert!(r.remote_exists("topic"));
        branch_deletion::delete(r.p(), "topic", true, Some(&t)).unwrap();
        branch_deletion::delete_remote(r.p(), &t, true, |_| {}).unwrap();
        assert!(!r.local_exists());
        assert!(!r.remote_exists("topic"));
    }
}

#[test]
fn remote_only_unmerged_history_is_also_guarded() {
    let r = Repo::new();
    r.advance(true);
    r.git(&["update-ref", "refs/heads/topic", "HEAD"]);
    let t = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
    assert_eq!(branch_deletion::delete(r.p(), "topic", false, Some(&t)).unwrap_err().kind, "not-merged");
    assert!(r.local_exists());
    assert!(r.remote_exists("topic"));
}

#[test]
fn stale_mapping_or_tip_cannot_delete_either_branch_even_with_force() {
    let r = Repo::new();
    let t = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
    r.advance(true);
    assert_eq!(branch_deletion::delete(r.p(), "topic", true, Some(&t)).unwrap_err().kind, "stale-selection");
    let t = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
    r.git(&["config", "remote.origin.fetch", "+refs/heads/topic:refs/remotes/origin/renamed"]);
    assert_eq!(branch_deletion::delete(r.p(), "topic", true, Some(&t)).unwrap_err().kind, "stale-selection");
    assert!(r.local_exists());
    assert!(r.remote_exists("topic"));
}

#[test]
fn unseen_server_advancement_is_leased_even_with_force() {
    for force in [false, true] {
        let r = Repo::new();
        let other = r.second_clone();
        let target = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
        let server = r.push_from_other(&other);
        assert_eq!(r.git(&["rev-parse", &target.tracking_ref]), target.oid, "only the other clone fetched/pushed");
        branch_deletion::delete(r.p(), "topic", force, Some(&target)).unwrap();
        let err = branch_deletion::delete_remote(r.p(), &target, force, |_| {}).unwrap_err();
        assert_eq!(err.kind, "remote-changed", "{err:?}");
        assert!(!r.local_exists());
        assert!(r.git(&["ls-remote", "--heads", "origin", &target.remote_ref]).starts_with(&server));
    }
}

#[test]
fn partial_failure_retry_and_refreshed_force_keep_the_exact_lease() {
    let r = Repo::new();
    let other = r.second_clone();
    let target = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
    branch_deletion::delete(r.p(), "topic", false, Some(&target)).unwrap();
    // A real server rejection AFTER local deletion, rather than a fabricated error.
    let hook = r._dir.path().join("origin.git/hooks/pre-receive");
    fs::write(&hook, "#!/bin/sh\necho 'Server temporarily refuses updates' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(branch_deletion::delete_remote(r.p(), &target, false, |_| {}).is_err());
    assert!(r.remote_exists("topic"));
    fs::remove_file(hook).unwrap();
    let server = r.push_from_other(&other);
    for force in [false, true] {
        assert_eq!(branch_deletion::delete_remote(r.p(), &target, force, |_| {}).unwrap_err().kind, "remote-changed");
    }
    let review = branch_deletion::refresh_remote(r.p(), &target, |_| {}).unwrap();
    assert_eq!(review.target.oid, server);
    assert_eq!((review.new_commits, review.removed_commits, review.unmerged_commits), (1, 0, 1));
    assert!(review.commits[0].contains("Unseen server commit"));
    assert_eq!(branch_deletion::delete_remote(r.p(), &review.target, false, |_| {}).unwrap_err().kind, "not-merged");
    // Explicit consent to B still cannot delete a subsequent unseen C.
    let latest = r.push_from_other(&other);
    assert_eq!(branch_deletion::delete_remote(r.p(), &review.target, true, |_| {}).unwrap_err().kind, "remote-changed");
    let review = branch_deletion::refresh_remote(r.p(), &review.target, |_| {}).unwrap();
    assert_eq!(review.target.oid, latest);
    assert_eq!(review.unmerged_commits, 2);
    branch_deletion::delete_remote(r.p(), &review.target, true, |_| {}).unwrap();
    assert!(!r.remote_exists("topic"));
}

#[test]
fn divergent_server_tip_can_be_reviewed_and_explicitly_deleted() {
    let r = Repo::new();
    let other = r.second_clone();
    r.advance(true);
    let target = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
    runner::run(&other, ["commit", "--allow-empty", "-qm", "Different history"]).unwrap();
    runner::run(&other, ["push", "-q", "--force", "origin", "topic"]).unwrap();
    branch_deletion::delete(r.p(), "topic", true, Some(&target)).unwrap();
    assert_eq!(branch_deletion::delete_remote(r.p(), &target, true, |_| {}).unwrap_err().kind, "remote-changed");
    let review = branch_deletion::refresh_remote(r.p(), &target, |_| {}).unwrap();
    assert_eq!((review.new_commits, review.removed_commits), (1, 1));
    branch_deletion::delete_remote(r.p(), &review.target, true, |_| {}).unwrap();
    assert!(!r.remote_exists("topic"));
}

#[test]
fn retry_refuses_mapping_changes_and_incomplete_oids() {
    let r = Repo::new();
    let mut target = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
    branch_deletion::delete(r.p(), "topic", false, Some(&target)).unwrap();
    target.oid.clear();
    assert_eq!(branch_deletion::delete_remote(r.p(), &target, true, |_| {}).unwrap_err().kind, "stale-selection");
    target.oid = r.git(&["rev-parse", "HEAD"]);
    r.git(&["config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/topic"]);
    assert_eq!(branch_deletion::delete_remote(r.p(), &target, true, |_| {}).unwrap_err().kind, "stale-selection");
    assert!(branch_deletion::refresh_remote(r.p(), &target, |_| {}).is_err());
    assert!(r.remote_exists("topic"));
}

#[test]
fn refresh_reviews_the_push_server_and_preserves_the_fetch_server() {
    let r = Repo::new();
    let push_server = r._dir.path().join("push.git");
    r.git(&["clone", "-q", "--bare", &r.git(&["remote", "get-url", "origin"]), push_server.to_str().unwrap()]);
    r.git(&["remote", "set-url", "--push", "origin", push_server.to_str().unwrap()]);
    let target = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
    let other = r.second_clone();
    runner::run(&other, ["remote", "set-url", "origin", push_server.to_str().unwrap()]).unwrap();
    let server_tip = r.push_from_other(&other);
    branch_deletion::delete(r.p(), "topic", false, Some(&target)).unwrap();
    assert_eq!(branch_deletion::delete_remote(r.p(), &target, false, |_| {}).unwrap_err().kind, "remote-changed");
    let review = branch_deletion::refresh_remote(r.p(), &target, |_| {}).unwrap();
    assert_eq!(review.target.oid, server_tip);
    assert_eq!(r.git(&["rev-parse", &target.tracking_ref]), target.oid, "fetch server cache must not become push server history");
    branch_deletion::delete_remote(r.p(), &review.target, true, |_| {}).unwrap();
    assert!(r.remote_exists("topic"), "the fetch server was not deleted");
    assert!(runner::run(&push_server, ["for-each-ref", "refs/heads/topic"]).unwrap().is_empty());
}

#[test]
fn deletion_does_not_mirror_other_refs_or_push_tags_and_binds_destination() {
    let r = Repo::new();
    r.git(&["branch", "keep"]);
    r.git(&["push", "-q", "origin", "keep"]);
    r.git(&["tag", "-a", "local-only", "-m", "Must not be pushed"]);
    r.git(&["config", "push.followTags", "true"]);
    r.git(&["config", "remote.origin.mirror", "true"]);
    let target = branch_deletion::targets(r.p(), "topic").unwrap().remove(0);
    branch_deletion::delete(r.p(), "topic", false, Some(&target)).unwrap();
    branch_deletion::delete_remote(r.p(), &target, false, |_| {}).unwrap();
    assert!(r.remote_exists("keep"));
    assert!(r.git(&["ls-remote", "--tags", "origin", "refs/tags/local-only"]).is_empty());
    r.git(&["config", "remote.origin.pushurl", "https://example.invalid/changed.git"]);
    assert_eq!(branch_deletion::delete_remote(r.p(), &target, true, |_| {}).unwrap_err().kind, "stale-selection");
    r.git(&["config", "--add", "remote.origin.pushurl", "https://example.invalid/second.git"]);
    assert!(branch_deletion::targets(r.p(), "keep").unwrap().is_empty(), "multiple push destinations need separate confirmations");
}
