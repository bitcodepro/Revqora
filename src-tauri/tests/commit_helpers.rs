//! Commit authoring helpers: co-author candidates, own recent messages, fixup!/squash! commits.
use std::fs;
use std::path::Path;

use revqora_lib::git::ops::{self, FixupOptions};
use revqora_lib::git::runner;

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "Tester"],
        &["config", "user.email", "tester@example.com"],
        &["config", "core.autocrlf", "false"],
        &["config", "commit.gpgsign", "false"],
    ] {
        runner::run(dir.path(), args).unwrap();
    }
    dir
}

fn commit_as(root: &Path, name: &str, email: &str, file: &str, msg: &str) {
    let text = fs::read_to_string(root.join(file)).unwrap_or_default();
    fs::write(root.join(file), format!("{text}{msg}\n")).unwrap();
    runner::run(root, ["add", "-A"]).unwrap();
    let author = format!("{name} <{email}>");
    runner::run(root, ["commit", "-q", "--author", author.as_str(), "-m", msg]).unwrap();
}

fn fixup(kind: &str, message: Option<&str>) -> FixupOptions {
    FixupOptions { kind: kind.into(), message: message.map(str::to_string), no_verify: false, sign: Some(false) }
}

fn head_message(root: &Path) -> String {
    runner::run(root, ["log", "-1", "--format=%B"]).unwrap().trim().to_string()
}

#[test]
fn authors_are_unique_frequent_first_and_limited() {
    let dir = repo();
    let root = dir.path();
    assert!(ops::commit_authors(root, 2000, 10).unwrap().is_empty());
    commit_as(root, "Old Once", "once@example.com", "a.txt", "1");
    commit_as(root, "Zoë Ünicode", "zoe@example.com", "a.txt", "2");
    commit_as(root, "Ada Example", "ada@example.com", "a.txt", "3");
    commit_as(root, "Zoë Ünicode", "ZOE@example.com", "a.txt", "4");
    commit_as(root, "Ada Example", "ada@example.com", "a.txt", "5");
    commit_as(root, "Recent Once", "recent@example.com", "a.txt", "6");
    let all = ops::commit_authors(root, 2000, 10).unwrap();
    let names: Vec<_> = all.iter().map(|a| (a.name.as_str(), a.commits)).collect();
    // Equal counts: the most recently seen author first.
    assert_eq!(names, [("Ada Example", 2), ("Zoë Ünicode", 2), ("Recent Once", 1), ("Old Once", 1)]);
    assert_eq!(ops::commit_authors(root, 2000, 2).unwrap().len(), 2);
    // Only the scanned window counts.
    let recent = ops::commit_authors(root, 1, 10).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].email, "recent@example.com");
}

#[test]
fn own_recent_messages_use_the_configured_identity() {
    let dir = repo();
    let root = dir.path();
    commit_as(root, "Tester", "tester@example.com", "a.txt", "mine one");
    commit_as(root, "Other", "other@example.com", "a.txt", "not mine");
    commit_as(root, "Tester", "tester@example.com", "a.txt", "mine two");
    commit_as(root, "Tester", "tester@example.com", "a.txt", "mine one");
    assert_eq!(ops::own_recent_messages(root, 30).unwrap(), ["mine one", "mine two"]);
}

#[test]
fn own_recent_messages_match_plus_addressed_email_literally() {
    let dir = repo();
    let root = dir.path();
    runner::run(root, ["config", "user.email", "alice+tag@example.com"]).unwrap();
    commit_as(root, "Alice", "alice+tag@example.com", "a.txt", "plus addressed");
    // Would match if the address were read as a regex ("e+" = one or more 'e').
    commit_as(root, "Decoy", "aliceeetag@example.com", "a.txt", "regex lookalike");
    commit_as(root, "Decoy", "alice.tag@example.com", "a.txt", "dot lookalike");
    assert_eq!(ops::own_recent_messages(root, 30).unwrap(), ["plus addressed"]);
}

#[test]
fn fixup_and_squash_commit_only_staged_changes() {
    let dir = repo();
    let root = dir.path();
    commit_as(root, "Tester", "tester@example.com", "a.txt", "Add feature");
    commit_as(root, "Tester", "tester@example.com", "b.txt", "Later work");
    let target = runner::run(root, ["rev-parse", "HEAD~1"]).unwrap().trim().to_string();

    fs::write(root.join("a.txt"), "staged fix\n").unwrap();
    runner::run(root, ["add", "a.txt"]).unwrap();
    fs::write(root.join("b.txt"), "unstaged edit\n").unwrap();
    let oid = ops::fixup_commit(root, &target, &fixup("fixup", None)).unwrap();
    assert_eq!(oid, runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim());
    assert_eq!(head_message(root), "fixup! Add feature");
    assert_eq!(runner::run(root, ["show", "--name-only", "--format=", "HEAD"]).unwrap().trim(), "a.txt");
    assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "unstaged edit\n");
    assert_eq!(runner::run(root, ["diff", "--name-only"]).unwrap().trim(), "b.txt");

    fs::write(root.join("c.txt"), "new\n").unwrap();
    runner::run(root, ["add", "c.txt"]).unwrap();
    ops::fixup_commit(root, &target, &fixup("squash", Some("Explain the squash"))).unwrap();
    assert_eq!(head_message(root), "squash! Add feature\n\nExplain the squash");

    fs::write(root.join("d.txt"), "new\n").unwrap();
    runner::run(root, ["add", "d.txt"]).unwrap();
    ops::fixup_commit(root, &target[..10], &fixup("squash", None)).unwrap();
    assert_eq!(head_message(root), "squash! Add feature");
    assert_eq!(runner::run(root, ["diff", "--name-only"]).unwrap().trim(), "b.txt");
}

#[test]
fn fixup_refuses_without_staged_changes_or_with_bad_input() {
    let dir = repo();
    let root = dir.path();
    commit_as(root, "Tester", "tester@example.com", "a.txt", "Base");
    let head = runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim().to_string();
    fs::write(root.join("a.txt"), "unstaged only\n").unwrap();
    let err = ops::fixup_commit(root, &head, &fixup("fixup", None)).unwrap_err();
    assert!(err.message.contains("Stage"), "{}", err.message);
    runner::run(root, ["add", "a.txt"]).unwrap();
    for bad in ["--all", "-n", "HEAD", "", "abc def", "0123456789abcdef0123456789abcdef01234567"] {
        assert!(ops::fixup_commit(root, bad, &fixup("fixup", None)).is_err(), "accepted {bad:?}");
    }
    assert!(ops::fixup_commit(root, &head, &fixup("reword", None)).is_err());
    assert_eq!(runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim(), head);
}
