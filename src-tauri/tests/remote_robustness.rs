//! Remote situations found by the November 2026 remote audit: failed sign-ins, tags moved on
//! the server, stalled servers, coloured server messages, a renamed default branch, one broken
//! remote among several and partial pushes.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use revqora_lib::git::{ops, runner};

fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap_or_else(|e| panic!("git {args:?}: {}", e.message))
}

fn commit(root: &Path, file: &str, text: &str, message: &str) {
    std::fs::write(root.join(file), text).unwrap();
    git(root, &["add", "-A"]);
    git(root, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message]);
}

/// A bare remote, a colleague's clone that has pushed `main`, and the user's clone.
struct World {
    _tmp: tempfile::TempDir,
    remote: PathBuf,
    colleague: PathBuf,
    user: PathBuf,
}

fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    std::fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);
    git(tmp.path(), &["clone", "-q", "remote.git", "colleague"]);
    let colleague = tmp.path().join("colleague");
    commit(&colleague, "a.txt", "one\n", "base");
    git(&colleague, &["push", "-q", "-u", "origin", "main"]);
    git(tmp.path(), &["clone", "-q", "remote.git", "user"]);
    let user = tmp.path().join("user");
    World { _tmp: tmp, remote, colleague, user }
}

/// Answers 401 to every request, like Bitbucket for a repository you cannot access.
fn unauthorized_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let _ = stream.read(&mut [0; 4096]);
            let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    });
    origin
}

#[test]
fn a_failed_sign_in_never_erases_the_saved_login_for_the_host() {
    let origin = unauthorized_server();
    for background in [true, false] {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        let store = tmp.path().join("credentials");
        let saved = origin.replace("http://", "http://user:saved-token@");
        std::fs::write(&store, format!("{saved}\n")).unwrap();
        git(&repo, &["config", "credential.helper", ""]);
        git(&repo, &["config", "--add", "credential.helper", &format!("store --file=\"{}\"", store.to_string_lossy().replace('\\', "/"))]);
        git(&repo, &["remote", "add", "origin", &format!("{origin}/team/missing.git")]);
        let result = if background { ops::fetch_background(&repo) } else { ops::fetch(&repo, None, false, |_| {}) };
        let error = result.expect_err("the server refuses every request");
        assert_eq!(error.kind, "auth", "{}", error.message);
        assert!(std::fs::read_to_string(&store).unwrap().contains("saved-token"), "background={background}: the saved login was erased");
        // Forget saved login is the explicit way to drop it.
        ops::forget_saved_login(&repo, "origin").unwrap();
        assert!(!std::fs::read_to_string(&store).unwrap().contains("saved-token"), "Forget saved login keeps the login");
    }
}

#[test]
fn a_tag_moved_on_the_server_does_not_fail_every_fetch() {
    let w = world();
    git(&w.colleague, &["tag", "nightly"]);
    git(&w.colleague, &["push", "-q", "origin", "nightly"]);
    ops::fetch(&w.user, None, true, |_| {}).unwrap();
    commit(&w.colleague, "b.txt", "two\n", "second");
    git(&w.colleague, &["tag", "-f", "nightly"]);
    git(&w.colleague, &["push", "-q", "origin", "main"]);
    git(&w.colleague, &["push", "-qf", "origin", "nightly"]);
    let moved = git(&w.colleague, &["rev-parse", "nightly"]);
    let before = git(&w.user, &["rev-parse", "nightly"]);

    let out = ops::fetch(&w.user, None, true, |_| {}).expect("branches are fetched; the moved tag is only reported");
    assert!(out.contains("nightly"), "{out}");
    assert_eq!(git(&w.user, &["rev-parse", "origin/main"]), git(&w.colleague, &["rev-parse", "main"]));
    assert_eq!(git(&w.user, &["rev-parse", "nightly"]), before, "a local tag is never replaced without asking");
    assert_eq!(ops::moved_tags(&w.user).unwrap(), vec!["nightly".to_owned()]);
    ops::fetch(&w.user, None, true, |_| {}).expect("the next fetch works too");
    ops::fetch_background(&w.user).expect("the automatic fetch works too");

    ops::update_tags_from_remote(&w.user, "origin", &["nightly".to_owned()], |_| {}).unwrap();
    assert_eq!(git(&w.user, &["rev-parse", "nightly"]), moved);
    assert!(ops::moved_tags(&w.user).unwrap().is_empty());
}

#[test]
fn a_stalled_server_ends_a_user_fetch_instead_of_waiting_forever() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/stall.git", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let mut open = Vec::new();
        for stream in listener.incoming().flatten() {
            open.push(stream); // accepted, never answered
        }
    });
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q"]);
    git(tmp.path(), &["remote", "add", "origin", &url]);
    git(tmp.path(), &["config", "remote.origin.proxy", ""]);
    std::env::set_var("REVQORA_TRANSFER_STALL_SECONDS", "3");
    let start = std::time::Instant::now();
    let error = ops::fetch(tmp.path(), None, false, |_| {}).expect_err("a silent server cannot answer");
    assert!(start.elapsed() < std::time::Duration::from_secs(60), "fetch waited {:?}", start.elapsed());
    assert_eq!(error.kind, "network-stalled", "{}", error.message);
}

#[test]
fn server_messages_lose_terminal_colour_codes() {
    let w = world();
    let hook = w.remote.join("hooks").join("pre-receive");
    std::fs::write(&hook, "#!/bin/sh\nprintf '\\033[38;5;226mPolicy: blocked\\033[0m\\n' >&2\nexit 1\n").unwrap();
    commit(&w.user, "u.txt", "u\n", "user");
    let options = ops::PushOptions {
        remote: Some("origin".into()),
        branch: Some("main".into()),
        remote_branch: None,
        set_upstream: false,
        force_with_lease: false,
        tags: false,
    };
    let error = ops::push(&w.user, &options, |_| {}).expect_err("the hook refuses");
    assert!(error.message.contains("Policy: blocked"), "{}", error.message);
    assert!(!error.message.contains('\u{1b}') && !error.message.contains("[38;5;226m"), "{}", error.message);
}

#[test]
fn a_renamed_default_branch_moves_origin_head() {
    let w = world();
    git(&w.colleague, &["branch", "-m", "main", "trunk"]);
    git(&w.colleague, &["push", "-q", "-u", "origin", "trunk"]);
    git(&w.remote, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    git(&w.colleague, &["push", "-q", "origin", "--delete", "main"]);
    ops::fetch(&w.user, None, true, |_| {}).unwrap();
    assert_eq!(git(&w.user, &["symbolic-ref", "refs/remotes/origin/HEAD"]).trim(), "refs/remotes/origin/trunk");
}

#[test]
fn cancel_stops_a_running_fetch() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/silent.git", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let mut open = Vec::new();
        for stream in listener.incoming().flatten() {
            open.push(stream);
        }
    });
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q"]);
    git(tmp.path(), &["remote", "add", "origin", &url]);
    git(tmp.path(), &["config", "remote.origin.proxy", ""]);
    git(tmp.path(), &["config", "http.lowSpeedTime", "600"]);
    git(tmp.path(), &["config", "http.lowSpeedLimit", "1"]);
    assert!(!runner::transfers::cancel(tmp.path()), "nothing runs yet");
    let repo = tmp.path().to_owned();
    let fetch = std::thread::spawn(move || ops::fetch(&repo, Some("origin"), false, |_| {}));
    let start = std::time::Instant::now();
    while !runner::transfers::running(tmp.path()) {
        assert!(start.elapsed() < std::time::Duration::from_secs(30), "the fetch never started");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(runner::transfers::cancel(tmp.path()));
    let error = fetch.join().unwrap().expect_err("cancelled");
    assert_eq!(error.kind, "cancelled", "{}", error.message);
    assert!(start.elapsed() < std::time::Duration::from_secs(30), "cancel took {:?}", start.elapsed());
    assert!(!runner::transfers::running(tmp.path()));
}

#[test]
fn one_broken_remote_is_named_and_the_others_are_fetched() {
    let w = world();
    git(&w.user, &["remote", "add", "broken", "C:/does/not/exist/repo.git"]);
    commit(&w.colleague, "b.txt", "two\n", "second");
    git(&w.colleague, &["push", "-q", "origin", "main"]);
    let error = ops::fetch(&w.user, None, true, |_| {}).expect_err("broken cannot be fetched");
    assert_eq!(error.kind, "partial-fetch", "{}", error.message);
    assert!(error.message.starts_with("Fetched origin. Could not fetch broken"), "{}", error.message);
    assert_eq!(git(&w.user, &["rev-parse", "origin/main"]), git(&w.colleague, &["rev-parse", "main"]));
}

#[test]
fn diverged_fast_forward_only_pull_says_what_to_do() {
    let w = world();
    commit(&w.user, "u.txt", "u\n", "user");
    commit(&w.colleague, "c.txt", "c\n", "colleague");
    git(&w.colleague, &["push", "-q", "origin", "main"]);
    let error = ops::pull(&w.user, "ff-only", |_| {}).expect_err("cannot fast-forward");
    assert_eq!(error.kind, "diverged", "{}", error.message);
    assert!(error.message.contains("Pull with merge or rebase"), "{}", error.message);
    assert!(!error.message.contains("hint:"), "{}", error.message);
}

#[test]
fn a_push_with_tags_sends_nothing_when_the_branch_is_refused() {
    let w = world();
    commit(&w.colleague, "c.txt", "c\n", "colleague");
    git(&w.colleague, &["push", "-q", "origin", "main"]);
    commit(&w.user, "u.txt", "u\n", "user");
    git(&w.user, &["tag", "release-1"]);
    let options = ops::PushOptions {
        remote: Some("origin".into()),
        branch: Some("main".into()),
        remote_branch: None,
        set_upstream: false,
        force_with_lease: false,
        tags: true,
    };
    ops::push(&w.user, &options, |_| {}).expect_err("main is behind");
    assert!(!runner::exec(&w.remote, ["rev-parse", "--verify", "-q", "refs/tags/release-1"]).unwrap().ok(), "the tag was pushed without its branch");
}
