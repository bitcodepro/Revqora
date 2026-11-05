use revqora_lib::git::{branch_manager, refs, runner};
use std::{fs, path::Path};

fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap().trim().to_owned()
}
fn init(root: &Path) {
    git(root, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "Branch Tester"), ("user.email", "branch@test.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
        git(root, &["config", k, v]);
    }
}
fn commit(root: &Path, text: &str) -> String {
    fs::write(root.join("file.txt"), text).unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", text]);
    git(root, &["rev-parse", "HEAD"])
}

#[test]
fn inventory_is_read_only_tracks_upstreams_and_worktree_occupancy() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    init(root);
    let base = commit(root, "base");
    git(root, &["branch", "topic"]);
    git(root, &["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, &["update-ref", "refs/remotes/origin/main", &base]);
    git(root, &["branch", "--set-upstream-to=origin/main"]);
    let tip = commit(root, "message with \u{1f} delimiter");
    let wt = root.join("linked");
    git(root, &["worktree", "add", wt.to_str().unwrap(), "topic"]);
    // Modified and staged contents must survive every read, including comparison.
    fs::write(root.join("file.txt"), "staged contents").unwrap();
    git(root, &["add", "file.txt"]);
    fs::write(root.join("file.txt"), "manual contents").unwrap();
    let index = fs::read(root.join(".git/index")).unwrap();
    let refs = git(root, &["show-ref"]);
    let snap = branch_manager::snapshot(root, Some("refs/heads/topic")).unwrap();
    assert_eq!(snap.base_oid.as_deref(), Some(base.as_str()));
    assert_eq!(snap.branches.len(), 3);
    let main = snap.branches.iter().find(|b| b.name == "main").unwrap();
    assert!(main.current && !main.merged.unwrap());
    assert_eq!((main.ahead, main.behind), (1, 0));
    assert_eq!(main.subject, "message with \u{1f} delimiter");
    assert_eq!(main.author_email, "branch@test.invalid");
    assert_eq!(snap.identity_email.as_deref(), Some("branch@test.invalid"));
    let sidebar = refs::snapshot(root).unwrap();
    let main = sidebar.local.iter().find(|b| b.name == "main").unwrap();
    assert_eq!(main.subject, "message with \u{1f} delimiter");
    assert_eq!(main.upstream_full_name.as_deref(), Some("refs/remotes/origin/main"));
    assert!(snap.worktrees.iter().any(|w| w.branch.as_deref() == Some("topic") && !w.is_current));
    let d = branch_manager::compare(root, &base, &tip).unwrap();
    assert_eq!((d.ahead, d.behind), (1, 0));
    assert!(branch_manager::compare(root, "HEAD", &tip).is_err());
    assert_eq!(index, fs::read(root.join(".git/index")).unwrap());
    assert_eq!(refs, git(root, &["show-ref"]));
    assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "manual contents");
}

#[test]
fn author_filter_identity_uses_effective_git_config_not_the_head_author() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    init(root);
    let oid = commit(root, "authored by someone else");
    // Conditional config and worktree overrides must work just like committing
    // in this repository. Do not derive the user's email from this old commit.
    let included = root.join("identity.gitconfig");
    fs::write(&included, "[user]\n\temail = configured@example.invalid\n").unwrap();
    git(root, &["config", "includeIf.onbranch:main.path", included.to_str().unwrap()]);
    let snap = branch_manager::snapshot(root, None).unwrap();
    assert_eq!(snap.identity_email.as_deref(), Some("configured@example.invalid"));
    assert_eq!(snap.branches[0].author_email, "branch@test.invalid");
    assert_eq!(snap.branches[0].oid, oid);
    git(root, &["config", "extensions.worktreeConfig", "true"]);
    git(root, &["config", "--worktree", "user.email", "worktree@example.invalid"]);
    assert_eq!(branch_manager::snapshot(root, None).unwrap().identity_email.as_deref(), Some("worktree@example.invalid"));
    git(root, &["config", "--worktree", "user.email", ""]);
    assert!(branch_manager::snapshot(root, None).unwrap().identity_email.is_none());
}

#[test]
fn full_upstream_refs_distinguish_local_tracking_and_deleted_remote_branches() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    init(root);
    let oid = commit(root, "base");
    git(root, &["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, &["update-ref", "refs/remotes/origin/differently-named", &oid]);
    git(root, &["branch", "--set-upstream-to=origin/differently-named", "main"]);
    git(root, &["branch", "local-tracking"]);
    git(root, &["branch", "--set-upstream-to=main", "local-tracking"]);
    let snapshot = refs::snapshot(root).unwrap();
    assert_eq!(snapshot.local.iter().find(|b| b.name == "local-tracking").unwrap().upstream_full_name.as_deref(), Some("refs/heads/main"));
    assert_eq!(snapshot.local.iter().find(|b| b.name == "main").unwrap().upstream_full_name.as_deref(), Some("refs/remotes/origin/differently-named"));
    git(root, &["update-ref", "-d", "refs/remotes/origin/differently-named"]);
    let snapshot = refs::snapshot(root).unwrap();
    let main = snapshot.local.iter().find(|b| b.name == "main").unwrap();
    assert!(main.gone);
    assert_eq!(main.upstream_full_name.as_deref(), Some("refs/remotes/origin/differently-named"));
}

#[test]
fn protection_names_follow_actual_remote_sources_and_ambiguous_negative_specs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    init(root);
    let base = commit(root, "base");
    git(root, &["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, &["config", "--unset-all", "remote.origin.fetch"]);
    git(root, &["config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/innocent"]);
    git(root, &["update-ref", "refs/remotes/origin/innocent", &base]);
    let snap = branch_manager::snapshot(root, None).unwrap();
    let remote = snap.branches.iter().find(|b| !b.local).unwrap();
    assert!(remote.mapping_known);
    assert!(remote.protection_names.contains(&"main".into()));
    git(root, &["config", "--add", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/innocent"]);
    let snap = branch_manager::snapshot(root, None).unwrap();
    assert!(!snap.branches.iter().find(|b| !b.local).unwrap().mapping_known);
    git(root, &["config", "--add", "remote.origin.fetch", "^refs/heads/main"]);
    let snap = branch_manager::snapshot(root, None).unwrap();
    let remote = snap.branches.iter().find(|b| !b.local).unwrap();
    assert!(remote.mapping_known);
    assert!(!remote.protection_names.contains(&"main".into()));
}

#[test]
fn original_ancestry_ignores_replace_refs_and_legacy_grafts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    init(root);
    let base = commit(root, "base");
    let tip = commit(root, "tip");
    git(root, &["branch", "topic"]);
    git(root, &["reset", "--hard", &base]);
    git(root, &["replace", &base, &tip]);
    let snap = branch_manager::snapshot(root, Some("refs/heads/main")).unwrap();
    assert_eq!(snap.branches.iter().find(|b| b.name == "topic").unwrap().merged, Some(false));
    let d = branch_manager::compare(root, &base, &tip).unwrap();
    assert_eq!((d.ahead, d.behind), (1, 0));
    git(root, &["replace", "-d", &base]);
    fs::write(root.join(".git/info/grafts"), format!("{base} {tip}\n")).unwrap();
    let snap = branch_manager::snapshot(root, Some("refs/heads/main")).unwrap();
    assert_eq!(snap.branches.iter().find(|b| b.name == "topic").unwrap().merged, Some(false));
}

#[test]
fn unborn_detached_and_bare_repositories_have_honest_base_states() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    init(root);
    let empty = branch_manager::snapshot(root, None).unwrap();
    assert!(empty.branches.is_empty() && empty.base_oid.is_none());
    let base = commit(root, "base");
    git(root, &["checkout", "--detach", &base]);
    let detached = branch_manager::snapshot(root, Some("refs/heads/missing")).unwrap();
    assert_eq!(detached.base_ref.as_deref(), Some("refs/heads/main"));
    assert!(!detached.branches[0].current);
    let bare = root.join("bare.git");
    git(root, &["clone", "--bare", ".", bare.to_str().unwrap()]);
    let snap = branch_manager::snapshot(&bare, None).unwrap();
    assert_eq!(snap.branches.len(), 1);
}
