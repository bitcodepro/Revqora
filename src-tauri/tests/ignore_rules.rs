//! "Ignore this file / extension / folder" against real repositories.
use std::fs;
use std::path::Path;

use revqora_lib::git::{ignore, runner};

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
fn ignored(root: &Path, path: &str) -> bool {
    let mut input = path.as_bytes().to_vec();
    input.push(0);
    runner::exec_full(root, ["check-ignore", "-q", "--no-index", "-z", "--stdin"], &[], Some(&input)).unwrap().code == 0
}

#[test]
fn file_extension_and_folder_rules_ignore_what_they_say() {
    let dir = repo();
    let root = dir.path();
    fs::create_dir_all(root.join("build/out")).unwrap();
    fs::write(root.join("debug.log"), "x").unwrap();
    fs::write(root.join("build/out/app.js"), "x").unwrap();
    fs::write(root.join("keep.js"), "x").unwrap();

    let p = ignore::preview(root, "debug.log", "file", "shared").unwrap();
    assert_eq!((p.pattern.as_str(), p.file.as_str(), p.before.as_str()), ("/debug.log", ".gitignore", ""));
    assert!(!p.already_ignored);
    let r = ignore::apply(root, "debug.log", "file", "shared", &p.token, false).unwrap();
    assert!(r.ignored);
    assert_eq!(fs::read_to_string(root.join(".gitignore")).unwrap(), "/debug.log\n");

    let p = ignore::preview(root, "build/out", "folder", "shared").unwrap();
    ignore::apply(root, "build/out", "folder", "shared", &p.token, false).unwrap();
    assert!(ignored(root, "build/out/app.js"));
    assert!(!ignored(root, "keep.js"), "an anchored folder rule must not ignore other files");

    let p = ignore::preview(root, "keep.js", "extension", "local").unwrap();
    assert_eq!((p.pattern.as_str(), p.file.as_str()), ("*.js", ".git/info/exclude"));
    ignore::apply(root, "keep.js", "extension", "local", &p.token, false).unwrap();
    assert!(ignored(root, "keep.js"));
    assert_eq!(fs::read_to_string(root.join(".gitignore")).unwrap(), "/debug.log\n/build/out/\n", "local rules stay out of .gitignore");
}

#[test]
fn names_with_gitignore_syntax_are_matched_literally() {
    let dir = repo();
    let root = dir.path();
    // `*` cannot be part of a Windows file name; the other characters can.
    let names: &[&str] = if cfg!(windows) { &["#notes.txt", "!draft.md", "a[1].txt"] } else { &["#notes.txt", "!draft.md", "a[1].txt", "star*.txt"] };
    for name in names {
        fs::write(root.join(name), "x").unwrap();
    }
    fs::write(root.join("a1.txt"), "x").unwrap();
    fs::write(root.join("starry.txt"), "x").unwrap();
    for name in names {
        let p = ignore::preview(root, name, "file", "shared").unwrap();
        assert!(ignore::apply(root, name, "file", "shared", &p.token, false).unwrap().ignored, "{name}");
    }
    assert!(!ignored(root, "a1.txt"), "[1] must not act as a character class");
    assert!(!ignored(root, "starry.txt"), "* must not act as a wildcard");
}

#[test]
fn keeps_crlf_and_a_missing_final_newline() {
    let dir = repo();
    let root = dir.path();
    fs::write(root.join(".gitignore"), "a\r\nb").unwrap();
    fs::write(root.join("c.tmp"), "x").unwrap();
    let p = ignore::preview(root, "c.tmp", "file", "shared").unwrap();
    ignore::apply(root, "c.tmp", "file", "shared", &p.token, false).unwrap();
    assert_eq!(fs::read(root.join(".gitignore")).unwrap(), b"a\r\nb\r\n/c.tmp\r\n");
}

#[test]
fn a_concurrent_edit_is_never_overwritten() {
    let dir = repo();
    let root = dir.path();
    fs::write(root.join("x.tmp"), "x").unwrap();
    let p = ignore::preview(root, "x.tmp", "file", "shared").unwrap();
    fs::write(root.join(".gitignore"), "written meanwhile\n").unwrap();
    let err = ignore::apply(root, "x.tmp", "file", "shared", &p.token, false).unwrap_err();
    assert_eq!(err.kind, "ignore-file-changed");
    assert_eq!(fs::read_to_string(root.join(".gitignore")).unwrap(), "written meanwhile\n");
}

#[test]
fn tracked_files_are_listed_and_can_be_untracked_but_stay_on_disk() {
    let dir = repo();
    let root = dir.path();
    fs::create_dir_all(root.join("logs")).unwrap();
    fs::write(root.join("logs/a.log"), "a").unwrap();
    fs::write(root.join("logs/b.log"), "b").unwrap();
    fs::write(root.join("main.rs"), "m").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "base"]);
    let p = ignore::preview(root, "logs/a.log", "extension", "shared").unwrap();
    assert_eq!(p.tracked_count, 2);
    assert_eq!(p.tracked, vec!["logs/a.log".to_string(), "logs/b.log".to_string()]);
    let r = ignore::apply(root, "logs/a.log", "extension", "shared", &p.token, true).unwrap();
    assert_eq!(r.untracked, 2);
    assert!(root.join("logs/a.log").exists() && root.join("logs/b.log").exists(), "files stay on disk");
    let status = git(root, &["status", "--porcelain"]);
    assert!(status.contains("D  logs/a.log") && status.contains("D  logs/b.log"), "{status}");
    assert!(!status.contains("?? logs/"), "now ignored, not untracked: {status}");
    assert!(git(root, &["ls-files", "main.rs"]).contains("main.rs"));
}

#[test]
fn a_later_negation_is_reported() {
    let dir = repo();
    let root = dir.path();
    fs::write(root.join(".gitignore"), "").unwrap();
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("sub/.gitignore"), "!keep.tmp\n").unwrap();
    fs::write(root.join("sub/keep.tmp"), "x").unwrap();
    let p = ignore::preview(root, "sub/keep.tmp", "extension", "shared").unwrap();
    let r = ignore::apply(root, "sub/keep.tmp", "extension", "shared", &p.token, false).unwrap();
    assert!(!r.ignored, "sub/.gitignore re-includes it");
}

#[cfg(unix)]
#[test]
fn a_symlinked_gitignore_is_not_replaced() {
    let dir = repo();
    let root = dir.path();
    fs::write(root.join("real-ignore"), "").unwrap();
    std::os::unix::fs::symlink("real-ignore", root.join(".gitignore")).unwrap();
    let err = ignore::preview(root, "x", "file", "shared").unwrap_err();
    assert_eq!(err.kind, "ignore-file-symlink");
}

#[test]
fn untracking_is_refused_when_the_matched_files_changed_after_the_preview() {
    let dir = repo();
    let root = dir.path();
    fs::write(root.join("a.log"), "a").unwrap();
    fs::write(root.join("main.rs"), "m").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "base"]);
    let p = ignore::preview(root, "a.log", "extension", "shared").unwrap();
    assert_eq!(p.tracked, vec!["a.log".to_string()]);
    // Another tool tracks b.log before the user confirms.
    fs::write(root.join("b.log"), "b").unwrap();
    git(root, &["add", "b.log"]);
    let err = ignore::apply(root, "a.log", "extension", "shared", &p.token, true).unwrap_err();
    assert_eq!(err.kind, "ignore-preview-stale");
    assert!(!root.join(".gitignore").exists(), "nothing was written");
    assert!(git(root, &["ls-files", "b.log"]).contains("b.log"), "b.log is still tracked");
    assert!(git(root, &["ls-files", "a.log"]).contains("a.log"), "a.log is still tracked");

    // A branch switch since the preview is refused too.
    let p = ignore::preview(root, "a.log", "extension", "shared").unwrap();
    git(root, &["commit", "-q", "-m", "track b"]);
    assert_eq!(ignore::apply(root, "a.log", "extension", "shared", &p.token, true).unwrap_err().kind, "ignore-preview-stale");
    // A fresh preview applies.
    let p = ignore::preview(root, "a.log", "extension", "shared").unwrap();
    assert_eq!(ignore::apply(root, "a.log", "extension", "shared", &p.token, true).unwrap().untracked, 2);
}
