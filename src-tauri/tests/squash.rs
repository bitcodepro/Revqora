//! Squash-merged branches are recognized although git keeps no merge link for them.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::refs;
use revqora_lib::git::runner;

fn repo(dir: &Path) -> PathBuf {
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.name", "T"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "core.autocrlf", "false"],
        vec!["config", "commit.gpgsign", "false"],
    ] {
        runner::run(dir, &args).unwrap();
    }
    revqora_lib::git::repo::discover(dir).unwrap()
}

fn commit(r: &Path, file: &str, content: &str, msg: &str) {
    fs::write(r.join(file), content).unwrap();
    runner::run(r, ["add", "-A"]).unwrap();
    runner::run(r, ["commit", "-qm", msg]).unwrap();
}

#[test]
fn squash_merged_branches_are_detected() {
    let tmp = tempfile::tempdir().unwrap();
    let r = repo(tmp.path());
    commit(&r, "a.txt", "a\n", "init");

    runner::run(&r, ["switch", "-q", "-c", "feature/squashed"]).unwrap();
    commit(&r, "b.txt", "b1\n", "b1");
    commit(&r, "b.txt", "b2\n", "b2");
    runner::run(&r, ["switch", "-q", "main"]).unwrap();
    runner::run(&r, ["switch", "-q", "-c", "feature/open"]).unwrap();
    commit(&r, "c.txt", "c\n", "c");
    runner::run(&r, ["switch", "-q", "main"]).unwrap();
    runner::run(&r, ["switch", "-q", "-c", "feature/merged"]).unwrap();
    commit(&r, "d.txt", "d\n", "d");
    runner::run(&r, ["switch", "-q", "main"]).unwrap();

    // Squash merge feature/squashed, then main moves on; a regular merge of feature/merged.
    runner::run(&r, ["merge", "-q", "--squash", "feature/squashed"]).unwrap();
    runner::run(&r, ["commit", "-qm", "Squash feature"]).unwrap();
    commit(&r, "a.txt", "a2\n", "more work");
    runner::run(&r, ["merge", "-q", "--no-ff", "-m", "Merge feature/merged", "feature/merged"]).unwrap();

    let found = refs::squash_merged(&r).unwrap();
    if revqora_lib::git::locate::version() < (2, 38, 0) {
        assert!(found.is_empty());
        return;
    }
    assert_eq!(found, vec!["feature/squashed".to_string()]);
}
