//! External diff / merge tools run through Git's difftool / mergetool with a scripted tool.
use std::fs;
use std::path::Path;

use revqora_lib::git::{external_tools as tools, runner};

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
fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap()
}
/// A "tool" that records what Git hands it: the left and right versions of the file.
fn fake_diff_tool(root: &Path) {
    git(root, &["config", "difftool.fake.cmd", "cat \"$LOCAL\" > .left; cat \"$REMOTE\" > .right"]);
}

#[test]
fn diff_tool_receives_the_versions_being_compared() {
    let dir = repo();
    let root = dir.path();
    fs::write(root.join("a.txt"), "one\n").unwrap();
    git(root, &["add", "a.txt"]);
    git(root, &["commit", "-q", "-m", "one"]);
    let first = git(root, &["rev-parse", "HEAD"]).trim().to_string();
    fs::write(root.join("a.txt"), "two\n").unwrap();
    git(root, &["commit", "-qam", "two"]);
    let second = git(root, &["rev-parse", "HEAD"]).trim().to_string();
    fs::write(root.join("a.txt"), "three\n").unwrap();
    fake_diff_tool(root);

    tools::difftool(root, "a.txt", "unstaged", None, None, Some("fake")).unwrap();
    assert_eq!((fs::read_to_string(root.join(".left")).unwrap(), fs::read_to_string(root.join(".right")).unwrap()), ("two\n".into(), "three\n".into()));

    tools::difftool(root, "a.txt", "commits", Some(&first), Some(&second), Some("fake")).unwrap();
    assert_eq!((fs::read_to_string(root.join(".left")).unwrap(), fs::read_to_string(root.join(".right")).unwrap()), ("one\n".into(), "two\n".into()));
}

#[test]
fn a_missing_or_terminal_tool_is_refused_instead_of_hanging() {
    let dir = repo();
    let root = dir.path();
    let err = tools::difftool(root, "a.txt", "unstaged", None, None, None).unwrap_err();
    assert_eq!(err.kind, "no-external-tool");
    let err = tools::difftool(root, "a.txt", "unstaged", None, None, Some("vimdiff")).unwrap_err();
    assert_eq!(err.kind, "terminal-tool");
    git(root, &["config", "merge.tool", "vimdiff"]);
    assert_eq!(tools::mergetool(root, "a.txt", None).unwrap_err().kind, "terminal-tool");
    assert_eq!(tools::difftool(root, "a.txt", "commits", Some("--output=x"), Some("HEAD"), Some("fake")).unwrap_err().kind, "invalid-argument");
    assert_eq!(tools::difftool(root, "../a.txt", "unstaged", None, None, Some("fake")).unwrap_err().kind, "invalid-argument");
    assert_eq!(tools::difftool(root, "a.txt", "unstaged", None, None, Some("x;rm")).unwrap_err().kind, "invalid-argument");
}

#[test]
fn merge_tool_result_is_staged_without_backup_files() {
    let dir = repo();
    let root = dir.path();
    fs::write(root.join("c.txt"), "base\n").unwrap();
    git(root, &["add", "c.txt"]);
    git(root, &["commit", "-q", "-m", "base"]);
    git(root, &["switch", "-q", "-c", "other"]);
    fs::write(root.join("c.txt"), "theirs\n").unwrap();
    git(root, &["commit", "-qam", "theirs"]);
    git(root, &["switch", "-q", "main"]);
    fs::write(root.join("c.txt"), "ours\n").unwrap();
    git(root, &["commit", "-qam", "ours"]);
    assert!(!runner::exec(root, ["merge", "-q", "other"]).unwrap().ok());
    git(root, &["config", "mergetool.fake.cmd", "echo resolved > \"$MERGED\""]);
    git(root, &["config", "mergetool.fake.trustExitCode", "true"]);

    tools::mergetool(root, "c.txt", Some("fake")).unwrap();
    assert_eq!(fs::read_to_string(root.join("c.txt")).unwrap(), "resolved\n");
    assert!(git(root, &["status", "--porcelain"]).contains("M  c.txt"), "the resolution is staged");
    assert!(!root.join("c.txt.orig").exists(), "no backup file is left behind");
}

#[test]
fn a_missing_editor_is_reported() {
    let dir = repo();
    let err = tools::open_in_editor(dir.path(), "a.txt", 3, 1, "revqora-no-such-editor-xyz --goto {file}:{line}").unwrap_err();
    assert_eq!(err.kind, "editor-not-found");
}
