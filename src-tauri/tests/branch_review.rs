use std::fs;
use std::path::PathBuf;

use revqora_lib::git::{branch_deletion, branch_review, operations, recovery, runner};

struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
}

#[test]
fn manager_policy_blocks_combined_protected_server_deletion_before_either_mutation() {
    for tracking in ["main", "innocent"] {
        let f = Fixture::new();
        let server = f.bare("protected-server.git");
        f.git(&["remote", "add", "origin", server.to_str().unwrap()]);
        f.git(&["push", "-q", "origin", "main:refs/heads/main"]);
        f.git(&["config", "remote.origin.fetch", &format!("+refs/heads/main:refs/remotes/origin/{tracking}")]);
        f.git(&["fetch", "-q", "origin"]);
        f.git(&["config", "branch.topic.remote", "origin"]);
        f.git(&["config", "branch.topic.merge", "refs/heads/main"]);
        let target = branch_deletion::targets(&f.root, "topic").unwrap().remove(0);
        let plan = branch_review::plan(&f.root, "topic", Some("refs/heads/main"), Some(target.clone()), None, false).unwrap();
        let refs = f.git(&["show-ref"]);
        let index = fs::read(f.root.join(".git/index")).unwrap();
        let rules = vec!["main".to_owned()];
        // Even force consent cannot bypass the manager policy. No local half,
        // remote branch, recovery pin or index entry may change on rejection.
        let error = branch_review::delete_local(&f.root, &plan.proof, true, true, None, Some(&rules)).err().unwrap();
        assert_eq!(error.kind, "protected-branch");
        let local_rules = vec!["topic".to_owned()];
        assert_eq!(branch_review::delete_local(&f.root, &plan.proof, false, true, None, Some(&local_rules)).err().unwrap().kind, "protected-branch");
        assert!(f.exists());
        assert_eq!(f.git(&["show-ref"]), refs);
        assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
        assert_eq!(runner::run(&server, ["rev-parse", "refs/heads/main"]).unwrap().trim(), target.oid);
        // The same protected upstream must not prevent a local-only cleanup.
        branch_review::delete_local(&f.root, &plan.proof, false, false, None, Some(&rules)).unwrap();
        assert!(!f.exists());
        assert_eq!(runner::run(&server, ["rev-parse", "refs/heads/main"]).unwrap().trim(), target.oid);
    }
}

#[test]
fn manager_policy_checks_refreshed_remote_proofs_and_allows_explicit_rule_changes() {
    let f = Fixture::new();
    let server = f.bare("refreshed-policy.git");
    f.git(&["remote", "add", "origin", server.to_str().unwrap()]);
    f.git(&["push", "-q", "origin", "main:refs/heads/main"]);
    f.git(&["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/innocent"]);
    f.git(&["fetch", "-q", "origin"]);
    let target = branch_deletion::remote_target(&f.root, "refs/remotes/origin/innocent").unwrap();
    let next = f.git(&["commit-tree", &f.git(&["rev-parse", "HEAD^{tree}"]), "-p", "HEAD", "-m", "Updated protected main"]);
    f.git(&["push", "-q", "origin", &format!("{next}:refs/heads/main")]);
    let refreshed = branch_deletion::refresh_remote(&f.root, &target, |_| {}).unwrap();
    let plan = branch_review::plan(&f.root, "main", Some("refs/heads/main"), Some(refreshed.target), None, true).unwrap();
    let refs = f.git(&["show-ref"]);
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let rules = vec!["main".to_owned()];
    assert_eq!(branch_review::delete_remote(&f.root, &plan.proof, true, None, Some(&rules), |_| {}).err().unwrap().kind, "protected-branch");
    assert_eq!(f.git(&["show-ref"]), refs);
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
    assert_eq!(runner::run(&server, ["rev-parse", "refs/heads/main"]).unwrap().trim(), next);
    // The protection is a configurable client policy, not an unconditional ban.
    branch_review::delete_remote(&f.root, &plan.proof, true, None, Some(&[]), |_| {}).unwrap();
    assert!(!runner::exec(&server, ["show-ref", "--verify", "--quiet", "refs/heads/main"]).unwrap().ok());
    assert_eq!(f.git(&["rev-parse", "main"]), f.git(&["rev-parse", "HEAD"]));
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Review репо 'quoted'");
        fs::create_dir(&root).unwrap();
        let f = Self { temp, root };
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.autocrlf", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            f.git(&args);
        }
        f.write("base.txt", "base\n");
        f.commit("Initial");
        f.git(&["branch", "topic"]);
        f
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(&self.root, args).unwrap().trim().into()
    }
    fn write(&self, path: &str, value: &str) {
        fs::write(self.root.join(path), value).unwrap();
    }
    fn commit(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-qm", message]);
    }
    fn topic_change(&self) {
        self.git(&["checkout", "-q", "topic"]);
        self.write("topic.txt", "topic\n");
        self.commit("Topic");
        self.git(&["checkout", "-q", "main"]);
    }
    fn plan(&self) -> branch_review::DeletionPlan {
        branch_review::plan(&self.root, "topic", Some("refs/heads/main"), None, None, false).unwrap()
    }
    fn exists(&self) -> bool {
        !self.git(&["branch", "--list", "topic"]).is_empty()
    }
    fn remove(&self, plan: &branch_review::DeletionPlan, remote: bool, force: bool) -> Result<branch_review::DeletionResult, runner::GitError> {
        operations::run(
            &self.root,
            "branch_delete_reviewed",
            Some(&plan.state_token),
            |_, _| {},
            || branch_review::delete_local(&self.root, &plan.proof, remote, force, Some(&plan.state_token), None),
        )
    }
    fn bare(&self, name: &str) -> PathBuf {
        let path = self.temp.path().join(name);
        fs::create_dir(&path).unwrap();
        runner::run(&path, ["init", "--bare", "-q"]).unwrap();
        path
    }
}

#[test]
fn selected_base_controls_deletion_and_returns_exact_recovery_checkpoint() {
    let f = Fixture::new();
    f.topic_change();
    let tip = f.git(&["rev-parse", "topic"]);
    f.git(&["branch", "integrated", "topic"]);
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let refs = f.git(&["show-ref"]);
    let plan = branch_review::plan(&f.root, "topic", Some("refs/heads/integrated"), None, None, false).unwrap();
    assert_eq!(plan.local_unmerged, 0);
    assert_eq!(plan.local_integration, "reachable");
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
    assert_eq!(f.git(&["show-ref"]), refs);
    let result = f.remove(&plan, false, false).unwrap();
    assert!(!f.exists());
    let cp = recovery::detail(&f.root, &result.checkpoint.id).unwrap();
    let slot = cp.refs.iter().position(|r| r.name == "refs/heads/topic" && r.oid == tip).unwrap();
    recovery::restore_branch(&f.root, &cp.summary.id, Some(slot), "restored-topic").unwrap();
    assert_eq!(f.git(&["rev-parse", "restored-topic"]), tip);
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
}

#[test]
fn squash_content_estimate_does_not_bypass_force_consent() {
    let f = Fixture::new();
    f.topic_change();
    f.git(&["merge", "--squash", "topic"]);
    f.commit("Squash topic");
    let plan = f.plan();
    assert_eq!(plan.local_unmerged, 1);
    if runner::version_at_least(2, 38) {
        assert_eq!(plan.local_integration, "content-integrated");
    }
    assert_eq!(f.remove(&plan, false, false).err().unwrap().kind, "not-merged");
    assert!(f.exists());
    f.remove(&plan, false, true).unwrap();
    assert!(!f.exists());
}

#[test]
fn worktree_usage_and_dirty_state_are_visible_and_cannot_be_forced_away() {
    let f = Fixture::new();
    let wt = f.temp.path().join("worktree проверка 'quoted'");
    f.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "topic"]);
    fs::write(wt.join("untracked.txt"), "keep this\n").unwrap();
    let plan = f.plan();
    assert_eq!(plan.worktrees.len(), 1);
    assert_eq!(plan.worktrees[0].dirty, Some(true));
    assert_eq!(plan.worktrees[0].changed_files, Some(1));
    assert_eq!(fs::canonicalize(&plan.worktrees[0].path).unwrap(), fs::canonicalize(&wt).unwrap());
    assert_eq!(f.remove(&plan, false, true).err().unwrap().kind, "branch-in-use");
    assert!(f.exists());
    assert_eq!(fs::read(wt.join("untracked.txt")).unwrap(), b"keep this\n");
}

#[test]
fn force_cannot_override_a_changed_base_or_local_tip() {
    let f = Fixture::new();
    let plan = f.plan();
    f.git(&["commit", "--allow-empty", "-qm", "Advance comparison"]);
    assert!(branch_review::delete_local(&f.root, &plan.proof, false, true, None, None).is_err());
    assert!(f.exists());
    let plan = f.plan();
    let next = f.git(&["commit-tree", &f.git(&["rev-parse", "topic^{tree}"]), "-p", "topic", "-m", "External topic advance"]);
    f.git(&["update-ref", "refs/heads/topic", &next]);
    assert!(branch_review::delete_local(&f.root, &plan.proof, false, true, None, None).is_err());
    assert_eq!(f.git(&["rev-parse", "topic"]), next);
}

#[test]
fn failed_checkpoint_stops_local_deletion() {
    let f = Fixture::new();
    let plan = f.plan();
    let storage = recovery::list(&f.root).unwrap().storage_path;
    fs::write(storage, "blocked directory").unwrap();
    assert_eq!(f.remove(&plan, false, true).err().unwrap().kind, "checkpoint-failed");
    assert!(f.exists());
}

#[test]
fn local_remote_divergence_counts_and_server_lease_survive_partial_failure() {
    let f = Fixture::new();
    let server = f.bare("origin.git");
    f.git(&["remote", "add", "origin", server.to_str().unwrap()]);
    f.git(&["push", "-q", "-u", "origin", "topic"]);
    let target = branch_deletion::targets(&f.root, "topic").unwrap().remove(0);
    let plan = branch_review::plan(&f.root, "topic", None, Some(target.clone()), None, false).unwrap();
    assert_eq!((plan.local_only, plan.remote_only), (Some(0), Some(0)));
    f.remove(&plan, true, false).unwrap();
    let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
    let next = runner::run(
        &server,
        [
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Peer",
            "-c",
            "user.email=peer@example.com",
            "commit-tree",
            &tree,
            "-p",
            &target.oid,
            "-m",
            "Unseen server tip",
        ],
    )
    .unwrap()
    .trim()
    .to_owned();
    runner::run(&server, ["update-ref", "refs/heads/topic", &next]).unwrap();
    let failed = branch_review::delete_remote(&f.root, &plan.proof, true, None, None, |_| {});
    assert_eq!(failed.err().unwrap().kind, "remote-changed");
    assert_eq!(runner::run(&server, ["rev-parse", "topic"]).unwrap().trim(), next);
    let refreshed = branch_deletion::refresh_remote(&f.root, &target, |_| {}).unwrap();
    let plan = branch_review::plan(&f.root, "topic", Some("refs/heads/main"), Some(refreshed.target), Some(&plan.proof.local_oid), false).unwrap();
    assert_eq!((plan.local_only, plan.remote_only), (Some(0), Some(1)));
    assert_eq!(plan.remote_unmerged, Some(1));
    assert!(branch_review::delete_remote(&f.root, &plan.proof, false, None, None, |_| {}).is_err());
    branch_review::delete_remote(&f.root, &plan.proof, true, None, None, |_| {}).unwrap();
    assert!(!runner::exec(&server, ["show-ref", "--verify", "--quiet", "refs/heads/topic"]).unwrap().ok());
}

#[test]
fn distinct_push_server_tip_is_backed_up_without_rewriting_fetch_tracking_ref() {
    let f = Fixture::new();
    let fetch = f.bare("fetch.git");
    let push = f.bare("push.git");
    f.git(&["remote", "add", "origin", fetch.to_str().unwrap()]);
    f.git(&["push", "-q", "-u", "origin", "topic"]);
    f.git(&["push", "-q", push.to_str().unwrap(), "topic"]);
    f.git(&["config", "remote.origin.pushurl", push.to_str().unwrap()]);
    let target = branch_deletion::targets(&f.root, "topic").unwrap().remove(0);
    let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
    let remote_oid = runner::run(
        &push,
        [
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Peer",
            "-c",
            "user.email=peer@example.com",
            "commit-tree",
            &tree,
            "-p",
            &target.oid,
            "-m",
            "Push server only",
        ],
    )
    .unwrap()
    .trim()
    .to_owned();
    runner::run(&push, ["update-ref", "refs/heads/topic", &remote_oid]).unwrap();
    let fresh = branch_deletion::refresh_remote(&f.root, &target, |_| {}).unwrap();
    assert_eq!(f.git(&["rev-parse", "refs/remotes/origin/topic"]), target.oid);
    let plan = branch_review::plan(&f.root, "topic", Some("refs/heads/main"), Some(fresh.target), None, false).unwrap();
    assert_eq!((plan.local_only, plan.remote_only), (Some(0), Some(1)));
    let local = f.remove(&plan, true, true).unwrap();
    let remote = branch_review::delete_remote(&f.root, &plan.proof, true, None, None, |_| {}).unwrap();
    recovery::delete(&f.root, &local.checkpoint.id).unwrap();
    f.git(&["reflog", "expire", "--expire=now", "--all"]);
    f.git(&["gc", "--prune=now"]);
    let cp = recovery::detail(&f.root, &remote.checkpoint.id).unwrap();
    let slot = cp.refs.iter().position(|r| r.name == "push/origin/topic" && r.oid == remote_oid).unwrap();
    recovery::restore_branch(&f.root, &cp.summary.id, Some(slot), "saved-server-tip").unwrap();
    assert_eq!(f.git(&["rev-parse", "saved-server-tip"]), remote_oid);
    assert!(runner::exec(&fetch, ["show-ref", "--verify", "--quiet", "refs/heads/topic"]).unwrap().ok());
    assert!(!runner::exec(&push, ["show-ref", "--verify", "--quiet", "refs/heads/topic"]).unwrap().ok());
}

#[test]
fn remote_only_deletion_keeps_checked_out_local_branch_and_dirty_files() {
    let f = Fixture::new();
    let server = f.bare("remote-only.git");
    f.git(&["remote", "add", "origin", server.to_str().unwrap()]);
    f.git(&["push", "-q", "origin", "main"]);
    f.write("base.txt", "Manual edit stays here\n");
    let target = branch_deletion::remote_target(&f.root, "refs/remotes/origin/main").unwrap();
    let plan = branch_review::plan(&f.root, "main", None, Some(target), None, true).unwrap();
    assert!(plan.proof.remote_only && plan.proof.local_present);
    assert_eq!(plan.proof.base_ref.as_deref(), Some("refs/heads/main"));
    assert_eq!(plan.current_changes, 1);
    let tip = f.git(&["rev-parse", "main"]);
    assert!(f.remove(&plan, true, true).is_err()); // This proof cannot delete a local ref.
    let result = operations::run(
        &f.root,
        "branch_delete_remote_reviewed",
        Some(&plan.state_token),
        |_, _| {},
        || branch_review::delete_remote(&f.root, &plan.proof, false, Some(&plan.state_token), None, |_| {}),
    )
    .unwrap();
    assert_eq!(f.git(&["rev-parse", "main"]), tip);
    assert_eq!(fs::read(f.root.join("base.txt")).unwrap(), b"Manual edit stays here\n");
    assert!(!runner::exec(&server, ["show-ref", "--verify", "--quiet", "refs/heads/main"]).unwrap().ok());
    let cp = recovery::detail(&f.root, &result.checkpoint.id).unwrap();
    assert!(cp.refs.iter().any(|r| r.name == "push/origin/main" && r.oid == tip));
}

#[test]
fn remote_only_without_local_branch_requires_force_and_retains_server_tip() {
    let f = Fixture::new();
    let server = f.bare("server-only.git");
    f.git(&["remote", "add", "origin", server.to_str().unwrap()]);
    f.topic_change();
    let tip = f.git(&["rev-parse", "topic"]);
    f.git(&["push", "-q", "origin", "topic"]);
    f.git(&["branch", "-D", "topic"]);
    let target = branch_deletion::remote_target(&f.root, "refs/remotes/origin/topic").unwrap();
    let plan = branch_review::plan(&f.root, "topic", None, Some(target.clone()), None, true).unwrap();
    assert!(!plan.proof.local_present);
    assert_eq!((plan.local_only, plan.remote_only), (None, None));
    assert_eq!(plan.remote_unmerged, Some(1));
    assert_eq!(branch_review::delete_remote(&f.root, &plan.proof, false, None, None, |_| {}).err().unwrap().kind, "not-merged");
    // Creating a local ref after review must not silently change the shown comparison.
    f.git(&["branch", "topic"]);
    assert_eq!(branch_review::delete_remote(&f.root, &plan.proof, true, None, None, |_| {}).err().unwrap().kind, "stale-selection");
    f.git(&["branch", "-D", "topic"]);
    let result = branch_review::delete_remote(&f.root, &plan.proof, true, None, None, |_| {}).unwrap();
    assert!(!f.exists());
    let cp = recovery::detail(&f.root, &result.checkpoint.id).unwrap();
    let slot = cp.refs.iter().position(|r| r.name == "push/origin/topic" && r.oid == tip).unwrap();
    recovery::restore_branch(&f.root, &result.checkpoint.id, Some(slot), "restored-server-only").unwrap();
    assert_eq!(f.git(&["rev-parse", "restored-server-only"]), tip);
}

#[test]
fn direct_remote_resolution_uses_fetch_mapping_and_still_leases_the_server() {
    let f = Fixture::new();
    let server = f.bare("mapped-server.git");
    f.git(&["remote", "add", "origin", server.to_str().unwrap()]);
    f.git(&["push", "-q", "origin", "main:refs/heads/published"]);
    f.git(&["config", "remote.origin.fetch", "+refs/heads/published:refs/remotes/origin/display-alias"]);
    f.git(&["fetch", "-q", "origin"]);
    let target = branch_deletion::remote_target(&f.root, "refs/remotes/origin/display-alias").unwrap();
    assert_eq!(target.remote_ref, "refs/heads/published");
    let plan = branch_review::plan(&f.root, "published", None, Some(target.clone()), None, true).unwrap();
    // Force consent never removes the server-SHA lease.
    let next = f.git(&["commit-tree", &f.git(&["rev-parse", "HEAD^{tree}"]), "-p", "HEAD", "-m", "New server history"]);
    f.git(&["push", "-q", "origin", &format!("{next}:refs/heads/published")]);
    assert_eq!(branch_review::delete_remote(&f.root, &plan.proof, true, None, None, |_| {}).err().unwrap().kind, "remote-changed");
    assert_eq!(runner::run(&server, ["rev-parse", "published"]).unwrap().trim(), next);
    let refreshed = branch_deletion::refresh_remote(&f.root, &target, |_| {}).unwrap();
    let plan = branch_review::plan(&f.root, "published", None, Some(refreshed.target), None, true).unwrap();
    branch_review::delete_remote(&f.root, &plan.proof, true, None, None, |_| {}).unwrap();
    assert!(!runner::exec(&server, ["show-ref", "--verify", "--quiet", "refs/heads/published"]).unwrap().ok());
}
