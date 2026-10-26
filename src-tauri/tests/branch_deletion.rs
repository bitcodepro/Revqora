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
    r.git(&["push", "-q", &t.remote, &format!(":{}", t.remote_ref)]);
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
        r.git(&["push", "-q", &t.remote, &format!(":{}", t.remote_ref)]);
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
