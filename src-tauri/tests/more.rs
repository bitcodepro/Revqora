//! Branch recovery, patches, cross-commit transfer, stash contents, grep, worktree comparison,
//! commit helpers, maintenance and incremental graph rebuilds.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::{graph, maint, more, ops, runner};

fn repo(dir: &Path) -> PathBuf {
    let r = dir.join("r");
    fs::create_dir_all(&r).unwrap();
    for a in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.name", "T"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "core.autocrlf", "false"],
        vec!["config", "commit.gpgsign", "false"],
    ] {
        runner::run(&r, &a).unwrap();
    }
    r
}

fn commit(r: &Path, file: &str, content: &str, msg: &str) -> String {
    if let Some(parent) = r.join(file).parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(r.join(file), content).unwrap();
    runner::run(r, ["add", "-A"]).unwrap();
    runner::run(r, ["commit", "-qm", msg]).unwrap();
    runner::run(r, ["rev-parse", "HEAD"]).unwrap().trim().to_string()
}

fn git(r: &Path, a: &[&str]) -> String {
    runner::run(r, a).unwrap().trim().to_string()
}

#[test]
fn deleted_branches_can_be_restored() {
    let t = tempfile::tempdir().unwrap();
    let r = repo(t.path());
    commit(&r, "a.txt", "a\n", "init");
    git(&r, &["switch", "-qc", "topic"]);
    let tip = commit(&r, "b.txt", "b\n", "topic work");
    git(&r, &["switch", "-q", "main"]);
    ops::delete_branch(&r, "topic", true).unwrap();
    // A branch deleted outside Revqora is still found through HEAD's reflog.
    git(&r, &["switch", "-qc", "other"]);
    let other_tip = commit(&r, "c.txt", "c\n", "other work");
    git(&r, &["switch", "-q", "main"]);
    git(&r, &["branch", "-D", "other"]);

    let list = more::deleted_branches(&r).unwrap();
    let topic = list.iter().find(|b| b.name == "topic").expect("topic listed");
    assert_eq!(topic.oid, tip);
    assert_eq!(topic.source, "revqora");
    let other = list.iter().find(|b| b.name == "other").expect("other listed");
    assert_eq!(other.oid, other_tip);
    more::restore_branch(&r, "topic", &topic.oid).unwrap();
    assert_eq!(git(&r, &["rev-parse", "topic"]), tip);
    assert!(!more::deleted_branches(&r).unwrap().iter().any(|b| b.name == "topic"));
    assert!(!more::branch_reflog(&r, "main").unwrap().is_empty());
}

#[test]
fn patches_roundtrip() {
    let t = tempfile::tempdir().unwrap();
    let r = repo(t.path());
    commit(&r, "a.txt", "a\n", "init");
    git(&r, &["switch", "-qc", "feat"]);
    let c1 = commit(&r, "b.txt", "b\n", "add b");
    let c2 = commit(&r, "c.txt", "c\n", "add c");
    git(&r, &["switch", "-q", "main"]);
    let file = t.path().join("two.patch");
    assert_eq!(more::create_patch(&r, &[c1, c2], &file.to_string_lossy()).unwrap(), 2);
    let out = more::apply_patch(&r, &file.to_string_lossy()).unwrap();
    assert_eq!(out.status, "done");
    assert_eq!(git(&r, &["log", "-2", "--format=%s"]), "add c\nadd b");

    // A plain diff goes to the working tree.
    let diff = t.path().join("plain.diff");
    fs::write(&diff, "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+A\n").unwrap();
    more::apply_patch(&r, &diff.to_string_lossy()).unwrap();
    assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "A\n");
}

#[test]
fn take_files_and_lines_from_another_commit() {
    let t = tempfile::tempdir().unwrap();
    let r = repo(t.path());
    let base = commit(&r, "f.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "base");
    git(&r, &["switch", "-qc", "other"]);
    let changed = commit(&r, "f.txt", "ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n", "change both ends");
    git(&r, &["switch", "-q", "main"]);

    // Only the first change (lines are indexes in the displayed diff: hunk 0 = top).
    let d = revqora_lib::git::diff::rev_diff(&r, Some(&base), &changed, "f.txt", &Default::default()).unwrap();
    let sel: Vec<(usize, usize)> = d.hunks[0].lines.iter().enumerate().filter(|(_, l)| l.kind != " ").map(|(i, _)| (0, i)).collect();
    more::apply_from_commit(&r, Some(&base), &changed, "f.txt", Some(&sel)).unwrap();
    assert!(fs::read_to_string(r.join("f.txt")).unwrap().starts_with("ONE\n2"));
    assert!(fs::read_to_string(r.join("f.txt")).unwrap().ends_with("9\n10\n"));

    more::checkout_file(&r, &changed, "f.txt").unwrap();
    assert!(fs::read_to_string(r.join("f.txt")).unwrap().ends_with("TEN\n"));
}

#[test]
fn stash_contents_and_single_file_restore() {
    let t = tempfile::tempdir().unwrap();
    let r = repo(t.path());
    commit(&r, "a.txt", "a\n", "init");
    fs::write(r.join("a.txt"), "changed\n").unwrap();
    fs::write(r.join("new.txt"), "untracked\n").unwrap();
    ops::stash_save(&r, "wip", true, false, &[]).unwrap();
    let c = more::stash_contents(&r, 0).unwrap();
    assert_eq!(c.files.len(), 1);
    assert_eq!(c.files[0].path, "a.txt");
    assert_eq!(c.untracked.len(), 1);
    assert_eq!(c.untracked[0].path, "new.txt");
    more::stash_restore_file(&r, 0, "new.txt", true).unwrap();
    assert_eq!(fs::read_to_string(r.join("new.txt")).unwrap(), "untracked\n");
    assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "a\n");
    more::stash_restore_file(&r, 0, "a.txt", false).unwrap();
    assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "changed\n");
}

#[test]
fn tree_grep_worktree_compare_and_helpers() {
    let t = tempfile::tempdir().unwrap();
    let r = repo(t.path());
    let first = commit(&r, "src/lib.rs", "fn alpha() {}\nfn beta() {}\n", "init");
    commit(&r, "README.md", "hello\n", "readme");
    assert_eq!(more::list_tree(&r, "HEAD").unwrap(), vec!["README.md".to_string(), "src/lib.rs".to_string()]);
    let hits = more::grep(&r, "HEAD", "beta", false, false).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!((hits[0].path.as_str(), hits[0].line), ("src/lib.rs", 2));
    assert!(more::grep(&r, "HEAD", "nothing-here", false, false).unwrap().is_empty());

    fs::write(r.join("src/lib.rs"), "fn alpha() {}\nfn gamma() {}\n").unwrap();
    let c = more::compare_worktree(&r, &first).unwrap();
    let mut files: Vec<&str> = c.files.iter().map(|f| f.path.as_str()).collect();
    files.sort();
    assert_eq!(files, vec!["README.md", "src/lib.rs"]);
    let d = more::worktree_file_diff(&r, &first, "src/lib.rs", &Default::default()).unwrap();
    assert!(d.hunks[0].lines.iter().any(|l| l.text.contains("gamma")));

    fs::write(r.join(".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n").unwrap();
    fs::write(r.join("tmpl.txt"), "feat: \n\nWhy:\n").unwrap();
    git(&r, &["config", "commit.template", "tmpl.txt"]);
    let h = more::commit_helpers(&r).unwrap();
    assert_eq!(h.template.as_deref(), Some("feat: \n\nWhy:\n"));
    assert_eq!(h.recent, vec!["readme".to_string(), "init".to_string()]);
    assert!(h.hooks.contains(&"pre-commit".to_string()));
}

#[test]
fn large_files_and_maintenance() {
    let t = tempfile::tempdir().unwrap();
    let r = repo(t.path());
    commit(&r, "a.txt", "a\n", "init");
    fs::write(r.join("big.bin"), vec![7u8; 4096]).unwrap();
    fs::write(r.join("small.txt"), "s\n").unwrap();
    runner::run(&r, ["add", "-A"]).unwrap();
    let big = maint::large_staged_files(&r, 1000).unwrap();
    assert_eq!(big.len(), 1);
    assert_eq!(big[0].path, "big.bin");
    assert_eq!(big[0].size, 4096);
    assert!(maint::large_staged_files(&r, 10_000).unwrap().is_empty());

    let before = maint::size(&r).unwrap();
    assert!(before.loose_objects > 0);
    maint::run(&r, "gc", |_| {}).unwrap();
    let after = maint::size(&r).unwrap();
    assert!(after.packs >= 1);
}

#[test]
fn graph_rebuilds_incrementally() {
    let t = tempfile::tempdir().unwrap();
    let r = repo(t.path());
    for i in 0..5 {
        commit(&r, "f.txt", &format!("{i}\n"), &format!("c{i}"));
    }
    let g1 = graph::build(&r, None, false, 1000, false).unwrap();
    assert_eq!(g1.source, "full");
    let g2 = graph::build_with(&r, None, false, 1000, false, Some(&g1)).unwrap();
    assert_eq!(g2.source, "reused");
    assert_eq!(g2.rows.len(), 5);

    commit(&r, "f.txt", "new\n", "c5");
    let g3 = graph::build_with(&r, None, false, 1000, false, Some(&g2)).unwrap();
    assert_eq!(g3.source, "incremental");
    let full = graph::build(&r, None, false, 1000, false).unwrap();
    let a: Vec<&str> = g3.rows.iter().map(|x| x.oid.as_str()).collect();
    let b: Vec<&str> = full.rows.iter().map(|x| x.oid.as_str()).collect();
    assert_eq!(a, b);

    // Rewriting history (reset) forces a full read.
    git(&r, &["reset", "-q", "--hard", "HEAD~2"]);
    let g4 = graph::build_with(&r, None, false, 1000, false, Some(&g3)).unwrap();
    assert_eq!(g4.source, "full");
    assert_eq!(g4.rows.len(), 4);
}
