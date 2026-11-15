//! History of a range of lines and of a folder.
use std::fs;
use std::path::Path;

use revqora_lib::git::{line_history as lh, runner};

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "Tester"],
        &["config", "user.email", "tester@example.com"],
        &["config", "core.autocrlf", "false"],
    ] {
        runner::run(dir.path(), args).unwrap();
    }
    dir
}
fn commit(root: &Path, file: &str, text: &str, msg: &str) {
    if let Some(parent) = Path::new(file).parent() {
        fs::create_dir_all(root.join(parent)).unwrap();
    }
    fs::write(root.join(file), text).unwrap();
    runner::run(root, ["add", "-A"]).unwrap();
    runner::run(root, ["commit", "-q", "-m", msg]).unwrap();
}

#[test]
fn line_history_lists_only_commits_that_touched_those_lines() {
    let dir = repo();
    let root = dir.path();
    commit(root, "a.txt", "1\n2\n3\n4\n5\n", "create");
    commit(root, "a.txt", "1\nTWO\n3\n4\n5\n", "change line 2");
    commit(root, "a.txt", "1\nTWO\n3\n4\nFIVE\n", "change line 5");
    let entries = lh::line_history(root, "a.txt", 2, 2, None, 50).unwrap();
    let subjects: Vec<_> = entries.iter().map(|e| e.subject.as_str()).collect();
    assert_eq!(subjects, ["change line 2", "create"]);
    let changed = &entries[0].diff;
    assert_eq!((changed.additions, changed.deletions), (1, 1));
    assert!(changed.hunks.iter().flat_map(|h| &h.lines).any(|l| l.text == "TWO"));
    let entries = lh::line_history(root, "a.txt", 5, 5, None, 50).unwrap();
    assert_eq!(entries.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["change line 5", "create"]);
    // An older revision's line numbers.
    let first = runner::run(root, ["rev-parse", "HEAD~2"]).unwrap();
    assert_eq!(lh::line_history(root, "a.txt", 2, 2, Some(first.trim()), 50).unwrap().len(), 1);
}

#[test]
fn line_history_follows_renames() {
    let dir = repo();
    let root = dir.path();
    commit(root, "old.txt", "x\ny\n", "create");
    runner::run(root, ["mv", "old.txt", "new.txt"]).unwrap();
    runner::run(root, ["commit", "-q", "-m", "rename"]).unwrap();
    commit(root, "new.txt", "x\nY\n", "edit after rename");
    let entries = lh::line_history(root, "new.txt", 2, 2, None, 50).unwrap();
    assert_eq!(entries.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["edit after rename", "create"]);
    assert_eq!(entries[1].path, "old.txt");
}

#[test]
fn line_history_rejects_bad_input() {
    let dir = repo();
    let root = dir.path();
    commit(root, "a.txt", "1\n", "create");
    assert_eq!(lh::line_history(root, "a.txt", 0, 1, None, 5).unwrap_err().kind, "invalid-argument");
    assert_eq!(lh::line_history(root, "a.txt", 3, 2, None, 5).unwrap_err().kind, "invalid-argument");
    assert_eq!(lh::line_history(root, "a.txt", 1, 1, Some("--output=x"), 5).unwrap_err().kind, "invalid-argument");
    assert!(lh::line_history(root, "a.txt", 5, 9, None, 5).is_err(), "beyond the end of the file");
}

#[test]
fn folder_history_is_limited_to_the_folder_and_lists_its_files() {
    let dir = repo();
    let root = dir.path();
    commit(root, "src/a.rs", "a", "add src a");
    commit(root, "docs/readme.md", "d", "docs only");
    commit(root, "src/deep/b.rs", "b", "add src deep b");
    commit(root, "srcx/c.rs", "c", "sibling with a common prefix");
    let entries = lh::folder_history(root, "src", 100).unwrap();
    assert_eq!(entries.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["add src deep b", "add src a"]);
    assert_eq!(entries[0].files, ["src/deep/b.rs"]);
    assert_eq!(lh::folder_history(root, "", 100).unwrap().len(), 4);
}

#[cfg(unix)]
#[test]
fn folder_names_are_literal() {
    let dir = repo();
    let root = dir.path();
    commit(root, "a*/x.txt", "x", "star folder");
    commit(root, "ab/y.txt", "y", "other folder");
    assert_eq!(lh::folder_history(root, "a*", 100).unwrap().len(), 1);
}
