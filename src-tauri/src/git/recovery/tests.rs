use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

struct Fixture {
    dir: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new(unborn: bool, sha256: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Проект-quoted'");
        fs::create_dir(&root).unwrap();
        let mut args = strings(&["init", "-q", "-b", "main"]);
        if sha256 {
            args.push("--object-format=sha256".into());
        }
        runner::run(&root, args).unwrap();
        for (key, value) in [
            ("user.name", "Tester"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", ".git/hooks"),
        ] {
            runner::run(&root, ["config", key, value]).unwrap();
        }
        let f = Self { dir, root };
        if !unborn {
            f.write("file.txt", b"base\r\n");
            f.write("remove.txt", b"delete me\n");
            f.write("old.txt", b"rename me\n");
            f.commit("Initial");
        }
        f
    }
    fn write(&self, path: &str, data: &[u8]) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, data).unwrap();
    }
    fn commit(&self, message: &str) {
        runner::run(&self.root, ["add", "-A"]).unwrap();
        runner::run(&self.root, ["commit", "-qm", message]).unwrap();
    }
    fn save(&self, workspace: bool) -> Summary {
        operations::run(&self.root, "recovery_create", None, |_, _| {}, || create(&self.root, "manual", "Test checkpoint", workspace, false)).unwrap()
    }
    fn restore(&self, id: &str, name: &str) -> PathBuf {
        let destination = self.dir.path().join(name);
        operations::run(&self.root, "recovery_restore_workspace", None, |_, _| {}, || restore_workspace(&self.root, id, &destination, name)).unwrap();
        destination
    }
}
fn porcelain(root: &Path) -> Vec<u8> {
    runner::run_bytes(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).unwrap()
}

#[test]
fn checkpoints_restore_exact_files_staging_and_renames_in_a_separate_worktree() {
    for sha256 in [false, true] {
        let f = Fixture::new(false, sha256);
        f.write("file.txt", b"staged\r\n");
        runner::run(&f.root, ["add", "file.txt"]).unwrap();
        f.write("file.txt", b"unstaged\r\n");
        runner::run(&f.root, ["mv", "old.txt", "переименован.txt"]).unwrap();
        fs::remove_file(f.root.join("remove.txt")).unwrap();
        f.write("new binary.bin", &[0, 1, 255, 13, 10]);
        let old_index = fs::read(f.root.join(".git/index")).unwrap();
        let old_status = porcelain(&f.root);
        let cp = f.save(true);
        assert_eq!(old_index, fs::read(f.root.join(".git/index")).unwrap(), "snapshotting never rewrites the source index");
        assert_eq!(old_status, porcelain(&f.root));
        runner::run(&f.root, ["reset", "--hard", "HEAD"]).unwrap();
        runner::run(&f.root, ["clean", "-fd"]).unwrap();
        runner::run(&f.root, ["reflog", "expire", "--expire=now", "--all"]).unwrap();
        runner::run(&f.root, ["gc", "--prune=now"]).unwrap();
        let source_index = fs::read(f.root.join(".git/index")).unwrap();
        let recovered = f.restore(&cp.id, "recovered");
        assert_eq!(fs::read(recovered.join("file.txt")).unwrap(), b"unstaged\r\n");
        assert_eq!(fs::read(recovered.join("new binary.bin")).unwrap(), [0, 1, 255, 13, 10]);
        assert_eq!(old_status, porcelain(&recovered));
        assert_eq!(fs::read(f.root.join("file.txt")).unwrap(), b"base\r\n");
        assert_eq!(source_index, fs::read(f.root.join(".git/index")).unwrap());
        assert_eq!(list(&recovered).unwrap().checkpoints[0].id, cp.id, "linked worktrees share a recovery catalog");
    }
}

#[test]
fn deleted_branch_and_stash_objects_survive_gc_and_restore_without_overwriting_refs() {
    let f = Fixture::new(false, false);
    runner::run(&f.root, ["checkout", "-qb", "topic"]).unwrap();
    f.write("topic.txt", b"unique commit\n");
    f.commit("Topic");
    runner::run(&f.root, ["checkout", "main"]).unwrap();
    f.write("stash.txt", b"untracked stash data\n");
    runner::run(&f.root, ["stash", "push", "-u", "-m", "Saved stash"]).unwrap();
    let cp = f.save(false);
    let full = detail(&f.root, &cp.id).unwrap();
    let branch = full.refs.iter().position(|r| r.name == "refs/heads/topic").unwrap();
    let stash = full.refs.iter().position(|r| r.kind == "stash").unwrap();
    runner::run(&f.root, ["branch", "-D", "topic"]).unwrap();
    runner::run(&f.root, ["stash", "clear"]).unwrap();
    runner::run(&f.root, ["reflog", "expire", "--expire=now", "--all"]).unwrap();
    runner::run(&f.root, ["gc", "--prune=now"]).unwrap();
    restore_branch(&f.root, &cp.id, Some(branch), "topic").unwrap();
    assert_eq!(runner::run(&f.root, ["rev-parse", "topic"]).unwrap().trim(), full.refs[branch].oid);
    assert!(restore_branch(&f.root, &cp.id, Some(branch), "main").is_err());
    restore_stash(&f.root, &cp.id, stash).unwrap();
    assert_eq!(runner::run(&f.root, ["show", "stash@{0}^3:stash.txt"]).unwrap(), "untracked stash data\n");
    assert!(porcelain(&f.root).is_empty());
}

#[test]
fn unborn_repositories_recover_staged_and_untracked_files() {
    let f = Fixture::new(true, false);
    f.write("staged.txt", b"initial staging\n");
    runner::run(&f.root, ["add", "staged.txt"]).unwrap();
    f.write("untracked.txt", b"not staged\n");
    let before = porcelain(&f.root);
    let cp = f.save(true);
    let restored = f.restore(&cp.id, "initial-recovery");
    assert!(repo::head(&restored).unwrap().unborn);
    assert_eq!(porcelain(&restored), before);
}

#[test]
fn split_indexes_and_conflict_stages_are_recoverable() {
    let f = Fixture::new(false, false);
    f.write("file.txt", b"staged split index\n");
    runner::run(&f.root, ["add", "file.txt"]).unwrap();
    runner::run(&f.root, ["update-index", "--split-index"]).unwrap();
    let cp = f.save(true);
    let restored = f.restore(&cp.id, "split-recovery");
    assert_eq!(porcelain(&restored), porcelain(&f.root));
    assert_eq!(runner::run(&restored, ["show", ":file.txt"]).unwrap(), "staged split index\n");
    runner::run(&f.root, ["reset", "--hard", "HEAD"]).unwrap();
    runner::run(&f.root, ["checkout", "-qb", "other"]).unwrap();
    f.write("file.txt", b"other\n");
    f.commit("Other");
    runner::run(&f.root, ["checkout", "main"]).unwrap();
    f.write("file.txt", b"main\n");
    f.commit("Main");
    assert!(!runner::exec(&f.root, ["merge", "other"]).unwrap().ok());
    let cp = f.save(true);
    let conflicted = f.restore(&cp.id, "conflict-recovery");
    assert_eq!(porcelain(&conflicted), porcelain(&f.root));
    assert_eq!(runner::run(&conflicted, ["ls-files", "--unmerged"]).unwrap(), runner::run(&f.root, ["ls-files", "--unmerged"]).unwrap());
    assert_eq!(repo::op_state(&conflicted, &repo::git_dir(&conflicted).unwrap()).kind, "none", "workflow metadata is deliberately not replayed");
}

#[test]
fn sparse_workspaces_preserve_patterns_and_staging() {
    let f = Fixture::new(false, false);
    f.write("keep/yes.txt", b"keep\n");
    f.write("other/no.txt", b"hidden\n");
    f.commit("Folders");
    runner::run(&f.root, ["sparse-checkout", "init", "--cone"]).unwrap();
    runner::run(&f.root, ["sparse-checkout", "set", "keep"]).unwrap();
    f.write("keep/yes.txt", b"sparse edit\n");
    let cp = f.save(true);
    let restored = f.restore(&cp.id, "sparse-recovery");
    assert_eq!(porcelain(&restored), porcelain(&f.root));
    assert_eq!(fs::read(restored.join("keep/yes.txt")).unwrap(), b"sparse edit\n");
    assert!(!restored.join("other/no.txt").exists());
}

#[test]
fn case_only_renames_keep_the_actual_filesystem_spelling() {
    let f = Fixture::new(false, false);
    runner::run(&f.root, ["mv", "old.txt", "Old.txt"]).unwrap();
    let cp = f.save(true);
    let restored = f.restore(&cp.id, "case-recovery");
    let names: Vec<_> = fs::read_dir(&restored).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert!(names.iter().any(|name| name == "Old.txt"));
    assert!(!names.iter().any(|name| name == "old.txt"));
    assert_eq!(porcelain(&restored), porcelain(&f.root));
}

#[test]
fn intent_to_add_survives_recovery_while_worktree_cache_extensions_are_removed() {
    let f = Fixture::new(false, false);
    f.write("intent.txt", b"intent is not staged content\n");
    runner::run(&f.root, ["add", "-N", "intent.txt"]).unwrap();
    runner::run(&f.root, ["update-index", "--untracked-cache"]).unwrap();
    let before = porcelain(&f.root);
    let source_index = fs::read(f.root.join(".git/index")).unwrap();
    let cp = f.save(true);
    let restored = f.restore(&cp.id, "intent-recovery");
    assert_eq!(porcelain(&restored), before);
    assert_eq!(fs::read(restored.join("intent.txt")).unwrap(), b"intent is not staged content\n");
    assert_eq!(source_index, fs::read(f.root.join(".git/index")).unwrap());
    let restored_index = fs::read(repo::git_dir(&restored).unwrap().join("index")).unwrap();
    assert!(!restored_index.windows(4).any(|s| s == b"UNTR" || s == b"FSMN"));
}

#[test]
fn automatic_checkpoints_follow_preflight_and_backup_failure_prevents_the_action() {
    let f = Fixture::new(false, false);
    let expected = status::status(&f.root).unwrap().state_token.unwrap();
    f.write("file.txt", b"new external edit\n");
    let started = AtomicBool::new(false);
    let result = operations::run(
        &f.root,
        "reset",
        Some(&expected),
        |_, _| {},
        || {
            started.store(true, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().kind, "stale-operation");
    assert!(!started.load(Ordering::SeqCst));
    assert!(list(&f.root).unwrap().checkpoints.is_empty());
    operations::run(
        &f.root,
        "reset",
        None,
        |_, _| {},
        || {
            runner::run(&f.root, ["reset", "--hard", "HEAD"])?;
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(list(&f.root).unwrap().checkpoints.len(), 1);
    let file = File::create(f.root.join("too-large.bin")).unwrap();
    file.set_len(MAX_SNAPSHOT + 1).unwrap();
    drop(file);
    let result = operations::run(
        &f.root,
        "reset",
        None,
        |_, _| {},
        || {
            started.store(true, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().kind, "checkpoint-failed");
    assert!(!started.load(Ordering::SeqCst));
    assert_eq!(fs::metadata(f.root.join("too-large.bin")).unwrap().len(), MAX_SNAPSHOT + 1);
}

#[test]
fn checkpoint_storage_wait_cannot_accept_an_obsolete_precondition() {
    let f = Fixture::new(false, false);
    let guard = lock(&f.root).unwrap();
    let expected = status::status(&f.root).unwrap().state_token.unwrap();
    let root = f.root.clone();
    let worker = std::thread::spawn(move || create_expected(&root, "reset", "Waiting checkpoint", true, false, Some(&expected)));
    f.write("file.txt", b"keep this concurrent editor change\n");
    drop(guard);
    assert_eq!(worker.join().unwrap().err().expect("stale checkpoint precondition must be rejected").kind, "stale-operation");
    assert!(list(&f.root).unwrap().checkpoints.is_empty());
    assert_eq!(fs::read(f.root.join("file.txt")).unwrap(), b"keep this concurrent editor change\n");
}

#[test]
fn saving_a_checkpoint_does_not_invalidate_force_consent_but_user_refs_still_do() {
    let f = Fixture::new(false, false);
    let tree = runner::run(&f.root, ["rev-parse", "HEAD^{tree}"]).unwrap();
    let tip = runner::run(&f.root, ["commit-tree", tree.trim(), "-p", "HEAD", "-m", "Unmerged topic"]).unwrap();
    runner::run(&f.root, ["branch", "unmerged", tip.trim()]).unwrap();
    let expected = status::status(&f.root).unwrap().state_token.unwrap();
    let result =
        operations::run(&f.root, "branch_delete", Some(&expected), |_, _| {}, || super::super::branch_deletion::delete(&f.root, "unmerged", false, None));
    assert!(result.is_err());
    assert_eq!(list(&f.root).unwrap().checkpoints.len(), 1);
    assert_eq!(status::status(&f.root).unwrap().state_token.as_deref(), Some(expected.as_str()));
    operations::run(&f.root, "branch_delete", Some(&expected), |_, _| {}, || super::super::branch_deletion::delete(&f.root, "unmerged", true, None)).unwrap();
    assert!(!runner::exec(&f.root, ["show-ref", "--verify", "--quiet", "refs/heads/unmerged"]).unwrap().ok());
    let before = status::status(&f.root).unwrap().state_token;
    runner::run(&f.root, ["branch", "external-change"]).unwrap();
    assert_ne!(before, status::status(&f.root).unwrap().state_token);
}

#[test]
fn damaged_checkpoints_and_destination_collisions_cannot_replace_existing_data() {
    let f = Fixture::new(false, false);
    f.write("file.txt", b"save me\n");
    let cp = f.save(true);
    let dest = f.dir.path().join("existing");
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("private.txt"), b"keep").unwrap();
    assert!(restore_workspace(&f.root, &cp.id, &dest, "occupied").is_err());
    assert_eq!(fs::read(dest.join("private.txt")).unwrap(), b"keep");
    assert!(restore_workspace(&f.root, &cp.id, &f.root.join("nested"), "nested").is_err());
    fs::write(base(&f.root).unwrap().join(&cp.id).join("files/0"), b"corrupt").unwrap();
    assert!(restore_workspace(&f.root, &cp.id, &f.dir.path().join("bad"), "bad").is_err());
    assert!(!f.dir.path().join("bad").exists());
    restore_branch(&f.root, &cp.id, None, "branch-from-damaged-files").unwrap();
    let manifest = base(&f.root).unwrap().join(&cp.id).join("checkpoint.json");
    let mut damaged = detail(&f.root, &cp.id).unwrap();
    damaged.paths[0].path = "../outside.txt".into();
    fs::write(&manifest, serde_json::to_vec(&damaged).unwrap()).unwrap();
    assert!(detail(&f.root, &cp.id).is_err());
    assert!(detail(&f.root, "../other").is_err());
}

#[test]
fn retention_and_explicit_removal_delete_only_the_checkpoints_expected_pin() {
    let f = Fixture::new(false, false);
    let old = f.save(true);
    let mut cp = detail(&f.root, &old.id).unwrap();
    cp.summary.created_at = crate::journal::now() - RETENTION - 1;
    fs::write(base(&f.root).unwrap().join(&old.id).join("checkpoint.json"), serde_json::to_vec(&cp).unwrap()).unwrap();
    let fresh = f.save(true);
    assert!(!base(&f.root).unwrap().join(&old.id).exists());
    let head = repo::head(&f.root).unwrap().oid.unwrap();
    runner::run(&f.root, ["update-ref", &format!("{PREFIX}{}", fresh.id), &head]).unwrap();
    assert!(delete(&f.root, &fresh.id).is_err());
    assert!(base(&f.root).unwrap().join(&fresh.id).exists());
    let full = detail(&f.root, &fresh.id).unwrap();
    runner::run(&f.root, ["update-ref", &format!("{PREFIX}{}", fresh.id), &full.pin]).unwrap();
    delete(&f.root, &fresh.id).unwrap();
    assert!(list(&f.root).unwrap().checkpoints.is_empty());
}

#[cfg(unix)]
#[test]
fn symlinks_are_restored_as_links_without_copying_their_targets() {
    let f = Fixture::new(false, false);
    let external = f.dir.path().join("external.txt");
    fs::write(&external, b"outside").unwrap();
    std::os::unix::fs::symlink(&external, f.root.join("link.txt")).unwrap();
    let cp = f.save(true);
    let restored = f.restore(&cp.id, "links-recovery");
    assert_eq!(fs::read_link(restored.join("link.txt")).unwrap(), external);
    assert_eq!(fs::read(&external).unwrap(), b"outside");
}

#[test]
fn transport_cannot_publish_or_prune_private_checkpoint_references() {
    let f = Fixture::new(false, false);
    f.save(true);
    let remote = f.dir.path().join("server.git");
    fs::create_dir(&remote).unwrap();
    runner::run(&remote, ["init", "--bare", "-q"]).unwrap();
    runner::run(&f.root, ["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
    runner::run(&f.root, ["config", "remote.origin.mirror", "true"]).unwrap();
    let options = super::super::ops::PushOptions { remote: Some("origin".into()), branch: Some("main".into()), ..Default::default() };
    assert_eq!(super::super::ops::push(&f.root, &options, |_| {}).unwrap_err().kind, "recovery-protected");
    assert!(runner::run(&remote, ["for-each-ref"]).unwrap().is_empty());
    runner::run(&f.root, ["config", "remote.origin.mirror", "false"]).unwrap();
    super::super::ops::push(&f.root, &options, |_| {}).unwrap();
    assert!(runner::run(&remote, ["for-each-ref", PREFIX]).unwrap().is_empty());
    runner::run(&f.root, ["remote", "rename", "origin", "upstream"]).unwrap();
    runner::run(&f.root, ["config", "remote.upstream.mirror", "yes"]).unwrap();
    assert_eq!(super::super::ops::push(&f.root, &Default::default(), |_| {}).unwrap_err().kind, "recovery-protected");
    runner::run(&f.root, ["config", "remote.upstream.mirror", "false"]).unwrap();
    runner::run(&f.root, ["remote", "rename", "upstream", "origin"]).unwrap();
    assert_eq!(super::super::ops::push_ref(&f.root, "origin", "refs/*:refs/*", |_| {}).unwrap_err().kind, "recovery-protected");
    runner::run(&f.root, ["config", "remote.origin.fetch", "+refs/*:refs/*"]).unwrap();
    assert_eq!(super::super::ops::fetch(&f.root, Some("origin"), true, |_| {}).unwrap_err().kind, "recovery-protected");
    assert_eq!(super::super::ops::fetch_background(&f.root).unwrap_err().kind, "recovery-protected");
    assert_eq!(list(&f.root).unwrap().checkpoints.len(), 1);
}

#[test]
fn checkpoint_payloads_are_portable_and_shared_by_linked_worktrees() {
    let f = Fixture::new(false, false);
    f.write("file.txt", b"portable recovery\n");
    let cp = f.save(true);
    let storage = base(&f.root).unwrap();
    assert!(storage.starts_with(crate::portable::runtime_dir().unwrap()));
    assert!(!storage.starts_with(operations::repository_key(&f.root)));
    assert!(!repo::git_dir(&f.root).unwrap().join("revqora").exists());
    let linked = f.dir.path().join("linked");
    runner::run(&f.root, ["worktree", "add", "-qb", "linked", linked.to_str().unwrap()]).unwrap();
    assert_eq!(base(&linked).unwrap(), storage);
    assert!(list(&linked).unwrap().checkpoints.iter().any(|p| p.id == cp.id));
    assert_ne!(super::super::storage::dir(&linked).unwrap(), super::super::storage::dir(&f.root).unwrap());
    assert_eq!(fs::read(f.root.join("file.txt")).unwrap(), b"portable recovery\n");
}

#[test]
fn review_conflict_replacements_capture_manual_files_and_index() {
    for action in ["ours", "theirs", "base", "delete", "unresolve"] {
        let f = Fixture::new(false, false);
        runner::run(&f.root, ["checkout", "-qb", "topic"]).unwrap();
        f.write("file.txt", b"topic\n");
        f.commit("Topic");
        runner::run(&f.root, ["checkout", "main"]).unwrap();
        f.write("file.txt", b"main\n");
        f.commit("Main");
        assert!(!runner::exec(&f.root, ["merge", "--no-commit", "topic"]).unwrap().ok());
        let manual = b"manually edited resolution\r\nkeep these bytes\r\n";
        f.write("file.txt", manual);
        if action == "unresolve" {
            runner::run(&f.root, ["add", "file.txt"]).unwrap();
            f.write("file.txt", b"further unstaged resolution\r\n");
        }
        let saved_bytes = fs::read(f.root.join("file.txt")).unwrap();
        let saved_index = runner::run_bytes(&f.root, ["ls-files", "--stage", "-z"]).unwrap();
        let expected = status::status(&f.root).unwrap().state_token;
        let command = if action == "unresolve" { "conflict_unresolve" } else { "conflict_take" };
        operations::run(
            &f.root,
            command,
            expected.as_deref(),
            |_, _| {},
            || {
                if action == "unresolve" {
                    super::super::conflicts::unresolve(&f.root, "file.txt")
                } else {
                    super::super::conflicts::take_side(&f.root, "file.txt", action)
                }
            },
        )
        .unwrap();
        let catalog = list(&f.root).unwrap();
        assert_eq!(catalog.checkpoints.len(), 1, "missing automatic capture before {action}");
        assert_eq!(catalog.checkpoints[0].command, command);
        assert_ne!(fs::read(f.root.join("file.txt")).ok(), Some(saved_bytes.clone()));
        let after_action = porcelain(&f.root);
        let restored = f.restore(&catalog.checkpoints[0].id, "manual-resolution-recovery");
        assert_eq!(fs::read(restored.join("file.txt")).unwrap(), saved_bytes, "manual resolution lost before {action}");
        assert_eq!(runner::run_bytes(&restored, ["ls-files", "--stage", "-z"]).unwrap(), saved_index);
        assert_eq!(porcelain(&f.root), after_action, "recovery changed original worktree");
    }
}

#[test]
fn review_git_boolean_spellings_preserve_sparse_checkouts() {
    for value in ["yes", "on", "1"] {
        let f = Fixture::new(false, false);
        f.write("keep/yes.txt", b"keep\n");
        f.write("other/no.txt", b"hidden\n");
        f.commit("Folders");
        runner::run(&f.root, ["sparse-checkout", "init", "--cone"]).unwrap();
        runner::run(&f.root, ["sparse-checkout", "set", "keep"]).unwrap();
        runner::run(&f.root, ["config", "extensions.worktreeConfig", value]).unwrap();
        for key in ["core.sparseCheckout", "core.sparseCheckoutCone"] {
            runner::run(&f.root, ["config", "--worktree", key, value]).unwrap();
        }
        let cp = f.save(true);
        let saved = detail(&f.root, &cp.id).unwrap();
        assert!(saved.sparse && saved.sparse_cone, "Git boolean {value} was lost");
        let restored = f.restore(&cp.id, "bool-recovery");
        assert!(!restored.join("other/no.txt").exists());
        assert_eq!(runner::run(&restored, ["config", "--bool", "--get", "core.sparseCheckout"]).unwrap().trim(), "true");
        assert_eq!(runner::run(&restored, ["config", "--bool", "--get", "core.sparseCheckoutCone"]).unwrap().trim(), "true");
    }
}

#[test]
fn review_legacy_sparse_restore_uses_saved_patterns_and_preserves_source_settings() {
    for cone in [false, true] {
        let f = Fixture::new(false, false);
        f.write("keep/yes.txt", b"keep\n");
        f.write("other/no.txt", b"hidden\n");
        f.commit("Folders");
        let gd = repo::git_dir(&f.root).unwrap();
        fs::create_dir_all(gd.join("info")).unwrap();
        let patterns = if cone { "/*\n!/*/\n/keep/\n" } else { "/keep/yes.txt\n" };
        fs::write(gd.join("info/sparse-checkout"), patterns).unwrap();
        runner::run(&f.root, ["config", "core.sparseCheckout", "true"]).unwrap();
        runner::run(&f.root, ["config", "core.sparseCheckoutCone", if cone { "true" } else { "false" }]).unwrap();
        runner::run(&f.root, ["read-tree", "--reset", "-u", "HEAD"]).unwrap();
        f.write("keep/yes.txt", b"saved staged sparse edit\n");
        runner::run(&f.root, ["add", "keep/yes.txt"]).unwrap();
        f.write("keep/yes.txt", b"saved unstaged sparse edit\r\n");
        let cp = f.save(true);
        let saved_status = porcelain(&f.root);
        runner::run(&f.root, ["reset", "--hard", "HEAD"]).unwrap();
        runner::run(&f.root, ["config", "core.sparseCheckout", "false"]).unwrap();
        runner::run(&f.root, ["config", "core.sparseCheckoutCone", "false"]).unwrap();
        runner::run(&f.root, ["config", "core.worktree", &display_path(&f.root)]).unwrap();
        runner::run(&f.root, ["read-tree", "--reset", "-u", "HEAD"]).unwrap();
        fs::write(gd.join("info/sparse-checkout"), "/other/\n").unwrap();
        let source_index = fs::read(gd.join("index")).unwrap();
        let source_status = porcelain(&f.root);
        let source_other = fs::read(f.root.join("other/no.txt")).ok();
        let restored = f.restore(&cp.id, "legacy-sparse-recovery");
        assert!(!restored.join("other/no.txt").exists(), "current shared settings materialized an excluded file");
        assert_eq!(porcelain(&restored), saved_status);
        assert_eq!(fs::read(restored.join("keep/yes.txt")).unwrap(), b"saved unstaged sparse edit\r\n");
        assert_eq!(runner::run(&restored, ["show", ":keep/yes.txt"]).unwrap(), "saved staged sparse edit\n");
        assert_eq!(runner::run(&restored, ["config", "--bool", "--get", "core.sparseCheckout"]).unwrap().trim(), "true");
        assert_eq!(runner::run(&restored, ["config", "--bool", "--get", "core.sparseCheckoutCone"]).unwrap().trim(), if cone { "true" } else { "false" });
        assert_eq!(fs::read_to_string(repo::git_dir(&restored).unwrap().join("info/sparse-checkout")).unwrap(), patterns);
        runner::run(&restored, ["sparse-checkout", "reapply"]).unwrap();
        assert!(!restored.join("other/no.txt").exists());
        assert_eq!(runner::run(&f.root, ["config", "--bool", "--get", "core.sparseCheckout"]).unwrap().trim(), "false");
        assert_eq!(runner::run(&f.root, ["config", "--bool", "--get", "core.sparseCheckoutCone"]).unwrap().trim(), "false");
        let source_top = runner::run(&f.root, ["rev-parse", "--show-toplevel"]).unwrap();
        assert_eq!(fs::canonicalize(source_top.trim()).unwrap(), fs::canonicalize(&f.root).unwrap());
        assert_eq!(fs::read_to_string(gd.join("info/sparse-checkout")).unwrap(), "/other/\n");
        assert_eq!(fs::read(gd.join("index")).unwrap(), source_index);
        assert_eq!(porcelain(&f.root), source_status);
        assert_eq!(fs::read(f.root.join("other/no.txt")).ok(), source_other);
    }
}

#[test]
fn review_full_checkpoint_ignores_sparse_settings_enabled_after_capture() {
    let f = Fixture::new(false, false);
    f.write("keep/yes.txt", b"keep\n");
    f.write("other/no.txt", b"full checkout\n");
    f.commit("Folders");
    let cp = f.save(true);
    let gd = repo::git_dir(&f.root).unwrap();
    fs::create_dir_all(gd.join("info")).unwrap();
    fs::write(gd.join("info/sparse-checkout"), "/keep/yes.txt\n").unwrap();
    runner::run(&f.root, ["config", "core.sparseCheckout", "yes"]).unwrap();
    runner::run(&f.root, ["config", "core.sparseCheckoutCone", "off"]).unwrap();
    runner::run(&f.root, ["read-tree", "--reset", "-u", "HEAD"]).unwrap();
    let source_index = fs::read(gd.join("index")).unwrap();
    let restored = f.restore(&cp.id, "full-checkout-recovery");
    assert_eq!(fs::read(restored.join("other/no.txt")).unwrap(), b"full checkout\n");
    assert_eq!(runner::run(&restored, ["config", "--bool", "--get", "core.sparseCheckout"]).unwrap().trim(), "false");
    assert_eq!(runner::run(&f.root, ["config", "--bool", "--get", "core.sparseCheckout"]).unwrap().trim(), "true");
    assert!(!f.root.join("other/no.txt").exists());
    assert_eq!(fs::read(gd.join("index")).unwrap(), source_index);
}

#[test]
fn review_sparse_without_patterns_does_not_invent_exclusions() {
    let f = Fixture::new(false, false);
    f.write("keep/yes.txt", b"keep\n");
    f.write("other/no.txt", b"also present\n");
    f.commit("Folders");
    runner::run(&f.root, ["config", "core.sparseCheckout", "on"]).unwrap();
    let cp = f.save(true);
    assert!(detail(&f.root, &cp.id).unwrap().sparse_patterns.is_none());
    let source_index = fs::read(repo::git_dir(&f.root).unwrap().join("index")).unwrap();
    let restored = f.restore(&cp.id, "missing-patterns-recovery");
    assert_eq!(fs::read(restored.join("other/no.txt")).unwrap(), b"also present\n");
    assert_eq!(porcelain(&restored), porcelain(&f.root));
    assert!(!repo::git_dir(&restored).unwrap().join("info/sparse-checkout").exists());
    assert_eq!(fs::read(repo::git_dir(&f.root).unwrap().join("index")).unwrap(), source_index);
}
