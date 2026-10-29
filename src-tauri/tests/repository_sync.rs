use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::{operations, runner, status, sync};

struct Fixture {
    _temp: tempfile::TempDir,
    local: PathBuf,
    peer: PathBuf,
    bare: PathBuf,
}
fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap().trim().into()
}
fn commit(root: &Path, text: &str) -> String {
    fs::write(root.join("file.txt"), text).unwrap();
    git(root, &["add", "file.txt"]);
    git(root, &["commit", "-qm", text]);
    git(root, &["rev-parse", "HEAD"])
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        let peer = temp.path().join("peer");
        let bare = temp.path().join("remote.git");
        fs::create_dir(&local).unwrap();
        git(&local, &["init", "-q", "-b", "main"]);
        Self::identity(&local);
        commit(&local, "base");
        git(&local, &["clone", "--bare", ".", bare.to_str().unwrap()]);
        git(&local, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&local, &["fetch", "origin"]);
        git(&local, &["branch", "--set-upstream-to=origin/main"]);
        git(&local, &["clone", bare.to_str().unwrap(), peer.to_str().unwrap()]);
        Self::identity(&peer);
        Self { _temp: temp, local, peer, bare }
    }
    fn identity(root: &Path) {
        for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            git(root, &["config", key, value]);
        }
    }
    fn incoming(&self) -> String {
        let oid = commit(&self.peer, "incoming");
        git(&self.peer, &["push", "origin", "main"]);
        oid
    }
    fn plan(&self) -> runner::GitResult<sync::SyncPlan> {
        operations::run(&self.local, "sync_prepare", None, |_, _| {}, || sync::prepare(&self.local))
    }
    fn run(&self, plan: &sync::SyncPlan, receive: bool, send: bool) -> runner::GitResult<sync::SyncResult> {
        operations::run(&self.local, "sync_execute", Some(&plan.state_token), |_, _| {}, || sync::execute(&self.local, plan, receive, send))
    }
}
#[test]
fn incoming_review_fetches_objects_without_changing_refs_index_or_files() {
    let f = Fixture::new();
    let local = git(&f.local, &["rev-parse", "HEAD"]);
    let incoming = f.incoming();
    let index = fs::read(f.local.join(".git/index")).unwrap();
    let refs = git(&f.local, &["show-ref"]);
    let plan = f.plan().unwrap();
    assert_eq!((plan.ahead, plan.behind), (0, 1));
    assert_eq!(plan.server_oid, incoming);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), local);
    assert_eq!(git(&f.local, &["show-ref"]), refs);
    assert_eq!(fs::read(f.local.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read_to_string(f.local.join("file.txt")).unwrap(), "base");
    let result = f.run(&plan, true, false).unwrap();
    assert!(result.received);
    assert!(!result.sent);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), incoming);
    assert_eq!(result.checkpoint.head.as_deref(), Some(local.as_str()));
    assert_eq!(git(&f.local, &["rev-parse", "refs/remotes/origin/main"]), incoming);
}
#[test]
fn outgoing_requires_selection_and_pushes_only_reviewed_branch_without_tags_or_mirror() {
    let f = Fixture::new();
    let old = git(&f.bare, &["rev-parse", "main"]);
    let local = commit(&f.local, "outgoing");
    git(&f.local, &["tag", "-am", "tag", "private-tag"]);
    git(&f.local, &["branch", "private-branch"]);
    git(&f.local, &["config", "remote.origin.mirror", "true"]);
    git(&f.local, &["config", "push.followTags", "true"]);
    let plan = f.plan().unwrap();
    assert_eq!((plan.ahead, plan.behind), (1, 0));
    assert!(f.run(&plan, false, false).is_err());
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), old);
    let result = f.run(&plan, false, true).unwrap();
    assert!(result.sent);
    assert!(!result.received);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), local);
    assert!(!runner::exec(&f.bare, ["show-ref", "--verify", "refs/tags/private-tag"]).unwrap().ok());
    assert!(!runner::exec(&f.bare, ["show-ref", "--verify", "refs/heads/private-branch"]).unwrap().ok());
}
#[test]
fn changed_local_or_server_state_rejects_old_review() {
    let f = Fixture::new();
    commit(&f.local, "outgoing");
    let plan = f.plan().unwrap();
    let server = f.incoming();
    assert!(f.run(&plan, false, true).is_err());
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), server);
    let g = Fixture::new();
    g.incoming();
    let plan = g.plan().unwrap();
    let changed = commit(&g.local, "external commit");
    assert!(g.run(&plan, true, false).is_err());
    assert_eq!(git(&g.local, &["rev-parse", "HEAD"]), changed);
}
#[test]
fn dirty_diverged_detached_and_distinct_push_servers_are_blocked() {
    let f = Fixture::new();
    fs::write(f.local.join("untracked.txt"), "keep").unwrap();
    assert!(f.plan().is_err());
    fs::remove_file(f.local.join("untracked.txt")).unwrap();
    f.incoming();
    commit(&f.local, "diverged");
    assert!(f.plan().unwrap_err().message.contains("diverged"));
    git(&f.local, &["checkout", "--detach"]);
    assert!(f.plan().is_err());
    let g = Fixture::new();
    git(&g.local, &["remote", "set-url", "--push", "origin", g.peer.to_str().unwrap()]);
    assert!(g.plan().is_err());
}
#[test]
fn custom_fetch_destinations_cannot_rewrite_local_branches_or_tags_during_review() {
    let f = Fixture::new();
    let old = git(&f.local, &["rev-parse", "HEAD"]);
    f.incoming();
    git(&f.local, &["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
    git(&f.local, &["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/tags/*"]);
    let plan = f.plan().unwrap();
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), old);
    assert!(!runner::exec(&f.local, ["show-ref", "--verify", "refs/tags/main"]).unwrap().ok());
    assert_eq!(plan.behind, 1);
}
#[test]
fn symbolic_or_shared_tracking_refs_cannot_change_main() {
    let f = Fixture::new();
    let old = git(&f.local, &["rev-parse", "HEAD"]);
    f.incoming();
    let plan = f.plan().unwrap();
    git(&f.local, &["symbolic-ref", "refs/remotes/origin/main", "refs/heads/main"]);
    assert!(f.run(&plan, true, false).is_err());
    assert!(f.plan().is_err());
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), old);
    let g = Fixture::new();
    git(&g.local, &["remote", "add", "other", g.bare.to_str().unwrap()]);
    git(&g.local, &["config", "remote.other.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    assert!(g.plan().is_err());
}
#[test]
fn failed_push_returns_checkpoint_and_does_not_claim_sent() {
    let f = Fixture::new();
    commit(&f.local, "outgoing");
    let plan = f.plan().unwrap();
    git(&f.bare, &["config", "receive.denyNonFastForwards", "true"]);
    // A server-side rule rejects this fast-forward, with an unambiguous outcome.
    git(&f.bare, &["config", "receive.denyCurrentBranch", "refuse"]);
    git(&f.bare, &["config", "core.bare", "false"]);
    let result = f.run(&plan, false, true).unwrap();
    assert!(!result.sent);
    assert!(!result.warnings.is_empty());
    assert!(!result.checkpoint.id.is_empty());
    assert_eq!(status::status(&f.local).unwrap().oid.as_deref(), Some(plan.local_oid.as_str()));
}

#[test]
fn receiving_does_not_overwrite_ignored_local_files() {
    let f = Fixture::new();
    fs::write(f.local.join(".git/info/exclude"), "private.txt\n").unwrap();
    fs::write(f.local.join("private.txt"), "keep local secret").unwrap();
    fs::write(f.peer.join("private.txt"), "incoming tracked file").unwrap();
    git(&f.peer, &["add", "private.txt"]);
    git(&f.peer, &["commit", "-qm", "track private file"]);
    git(&f.peer, &["push", "origin", "main"]);
    let plan = f.plan().unwrap();
    let result = f.run(&plan, true, false).unwrap();
    assert!(!result.received);
    assert!(!result.warnings.is_empty());
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), plan.local_oid);
    assert_eq!(fs::read_to_string(f.local.join("private.txt")).unwrap(), "keep local secret");
}

fn unrelated_tip(f: &Fixture) -> (String, String) {
    let server = git(&f.bare, &["rev-parse", "main"]);
    let tree = git(&f.local, &["rev-parse", "HEAD^{tree}"]);
    let local = git(&f.local, &["commit-tree", &tree, "-m", "Unrelated root"]);
    git(&f.local, &["reset", "--hard", &local]);
    (server, local)
}
fn cannot_publish_unrelated(f: &Fixture, server: &str) {
    if let Ok(plan) = f.plan() {
        let result = f.run(&plan, false, true);
        assert!(result.is_err() || !result.unwrap().sent, "Sync published unrelated history");
    }
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), server);
}
#[test]
fn replacement_history_cannot_authorize_a_non_fast_forward_push() {
    let f = Fixture::new();
    let (server, local) = unrelated_tip(&f);
    let tree = git(&f.local, &["rev-parse", "HEAD^{tree}"]);
    let replacement = git(&f.local, &["commit-tree", &tree, "-p", &server, "-m", "Synthetic parent"]);
    git(&f.local, &["replace", &local, &replacement]);
    // Reproduce the misleading ancestry that used to authorize the leased push.
    git(&f.local, &["merge-base", "--is-ancestor", &server, &local]);
    cannot_publish_unrelated(&f, &server);
}
#[test]
fn legacy_graft_history_cannot_authorize_a_non_fast_forward_push() {
    let f = Fixture::new();
    let (server, local) = unrelated_tip(&f);
    fs::write(f.local.join(".git/info/grafts"), format!("{local} {server}\n")).unwrap();
    git(&f.local, &["merge-base", "--is-ancestor", &server, &local]);
    cannot_publish_unrelated(&f, &server);
}
#[test]
fn branch_squash_options_cannot_prevent_the_reviewed_fast_forward() {
    let f = Fixture::new();
    let incoming = f.incoming();
    git(&f.local, &["config", "branch.main.mergeOptions", "--squash --no-ff --autostash"]);
    let plan = f.plan().unwrap();
    let result = f.run(&plan, true, false).unwrap();
    assert!(result.received);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), incoming);
    assert_eq!(git(&f.local, &["status", "--porcelain"]), "");
    assert_eq!(git(&f.local, &["config", "--get", "branch.main.mergeOptions"]), "--squash --no-ff --autostash");
}
#[test]
fn receive_verifies_head_after_a_successful_merge_command() {
    let f = Fixture::new();
    let before = git(&f.local, &["rev-parse", "HEAD"]);
    f.incoming();
    git(&f.local, &["config", "core.hooksPath", ".git/hooks"]);
    let hook = f.local.join(".git/hooks/post-merge");
    fs::write(&hook, format!("#!/bin/sh\ngit update-ref refs/heads/main {before}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let plan = f.plan().unwrap();
    let result = f.run(&plan, true, false).unwrap();
    assert!(!result.received);
    assert!(!result.warnings.is_empty());
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), before);
    assert_eq!(git(&f.local, &["rev-parse", "refs/remotes/origin/main"]), plan.target.oid);
    assert_eq!(result.checkpoint.head.as_deref(), Some(before.as_str()));
}

#[test]
fn receiving_preserves_the_users_signature_verification_policy() {
    let f = Fixture::new();
    let before = git(&f.local, &["rev-parse", "HEAD"]);
    f.incoming();
    git(&f.local, &["config", "branch.main.mergeOptions", "--squash --verify-signatures"]);
    let plan = f.plan().unwrap();
    let result = f.run(&plan, true, false).unwrap();
    assert!(!result.received, "Sync bypassed the configured signature policy");
    assert!(!result.warnings.is_empty());
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), before);
    assert_eq!(git(&f.local, &["status", "--porcelain"]), "");
    assert_eq!(git(&f.local, &["rev-parse", "refs/remotes/origin/main"]), plan.target.oid);
}
