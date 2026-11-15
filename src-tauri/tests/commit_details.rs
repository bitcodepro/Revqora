//! Commit preview reads: the header and file list do not wait for remote containment.
use std::fs;
use std::path::Path;

use revqora_lib::git::{commit, runner};

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

fn commit_file(root: &Path, file: &str, text: &str, message: &str) -> String {
    fs::write(root.join(file), text).unwrap();
    runner::run(root, ["add", "-A"]).unwrap();
    runner::run(root, ["commit", "-qm", message]).unwrap();
    runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim().to_string()
}

#[test]
fn header_leaves_remote_containment_unknown_and_matches_the_full_read() {
    let dir = repo();
    let root = dir.path();
    let pushed = commit_file(root, "a.txt", "one\n", "Pushed subject\n\nBody line");
    runner::run(root, ["update-ref", "refs/remotes/origin/main", &pushed]).unwrap();
    let local = commit_file(root, "b.txt", "two\n", "Local subject");

    for (oid, expected) in [(&pushed, true), (&local, false)] {
        let header = commit::header(root, oid).unwrap();
        assert_eq!(header.contained_in_remote, None, "the early answer must not claim a containment state");
        let full = commit::details(root, oid).unwrap();
        assert_eq!(full.contained_in_remote, Some(expected));
        assert_eq!(commit::remote_containment(root, oid).unwrap(), expected);
        assert_eq!(
            (&header.oid, &header.parents, &header.subject, &header.body, &header.diff_base),
            (&full.oid, &full.parents, &full.subject, &full.body, &full.diff_base)
        );
        let paths = |d: &commit::CommitDetails| d.files.iter().map(|f| (f.path.clone(), f.status.clone(), f.additions, f.deletions)).collect::<Vec<_>>();
        assert_eq!(paths(&header), paths(&full));
    }
    let header = commit::header(root, &pushed).unwrap();
    assert_eq!((header.subject.as_str(), header.body.as_str()), ("Pushed subject", "Body line"));
    assert_eq!(header.files.len(), 1);
    assert_eq!(header.files[0].path, "a.txt");

    // A fetch or push changes the answer for the same immutable commit.
    runner::run(root, ["update-ref", "refs/remotes/origin/main", &local]).unwrap();
    assert!(commit::remote_containment(root, &local).unwrap());
    runner::run(root, ["update-ref", "-d", "refs/remotes/origin/main"]).unwrap();
    assert!(!commit::remote_containment(root, &pushed).unwrap());
}

#[test]
fn remote_containment_accepts_only_full_hashes() {
    let dir = repo();
    let root = dir.path();
    let oid = commit_file(root, "a.txt", "one\n", "One");
    for bad in ["HEAD", &oid[..12], "--count=0", "", "refs/heads/main"] {
        assert_eq!(commit::remote_containment(root, bad).unwrap_err().kind, "invalid-commit", "{bad}");
    }
    // An unknown object is an error (unknown), never "local only".
    assert!(commit::remote_containment(root, &"0".repeat(oid.len())).is_err());
}
