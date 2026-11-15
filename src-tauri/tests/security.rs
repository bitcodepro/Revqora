//! Regressions for security findings: untrusted text must never become git options.

use std::fs;

use revqora_lib::git::ops;
use revqora_lib::git::runner;

#[test]
fn a_url_that_looks_like_an_option_is_never_read_as_one() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("pwned");
    let hostile = format!("--upload-pack=touch {}", marker.to_string_lossy().replace('\\', "/"));

    // Clone: Git must treat it as a repository address (and fail to reach it), not as an option.
    let parent = dir.path().join("clones");
    assert!(ops::clone(&parent, &hostile, "copy", |_| {}).is_err());
    assert!(!marker.exists(), "clone ran an injected upload-pack command");

    // Remote add / set-url store it literally as the URL.
    let repo = dir.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    runner::run(&repo, ["init", "-q", "-b", "main"]).unwrap();
    ops::remote_add(&repo, "origin", &hostile).unwrap();
    assert_eq!(runner::run(&repo, ["config", "--get", "remote.origin.url"]).unwrap().trim(), hostile);
    ops::remote_set_url(&repo, "origin", "--receive-pack=evil").unwrap();
    assert_eq!(runner::run(&repo, ["config", "--get", "remote.origin.url"]).unwrap().trim(), "--receive-pack=evil");
    assert!(!marker.exists());
}

#[test]
fn commit_details_and_transport_never_take_options_from_values() {
    use revqora_lib::git::{commit, recovery};
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    runner::run(&repo, ["init", "-q", "-b", "main"]).unwrap();
    let written = dir.path().join("written.txt");
    let hostile = format!("--output={}", written.to_string_lossy().replace('\\', "/"));
    assert!(commit::details(&repo, &hostile).is_err());
    assert!(!written.exists(), "git show wrote a file chosen by the caller");
    // No recovery refs exist here; the remote-name check must still apply.
    assert!(recovery::protect_transport(&repo, false, Some("--upload-pack=x"), None, false).is_err());
}
