//! The periodic background fetch never asks for credentials: a remote that wants a password
//! fails fast with an authentication error instead of waiting on a prompt.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use revqora_lib::git::ops;
use revqora_lib::git::runner;

#[test]
fn background_env_disables_every_prompt() {
    let env = ops::background_env(false);
    let get = |k: &str| env.iter().find(|(key, _)| *key == k).map(|(_, v)| *v);
    assert_eq!(get("GIT_ASKPASS"), Some(""));
    assert_eq!(get("SSH_ASKPASS"), Some(""));
    assert_eq!(get("GIT_TERMINAL_PROMPT"), Some("0"));
    assert_eq!(get("GCM_INTERACTIVE"), Some("never"));
    assert!(get("GIT_SSH_COMMAND").unwrap().contains("BatchMode=yes"));
    // A user's own core.sshCommand is kept.
    assert!(ops::background_env(true).iter().all(|(k, _)| *k != "GIT_SSH_COMMAND"));
}

#[test]
fn missing_credentials_fail_fast_without_prompting() {
    // An HTTP remote that answers every request with 401.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut s = stream;
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    });
    let tmp = tempfile::tempdir().unwrap();
    let r = tmp.path();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.name", "T"],
        vec!["config", "user.email", "t@example.com"],
        // No stored credentials: only the (disabled) prompts could supply them.
        vec!["config", "credential.helper", ""],
    ] {
        runner::run(r, &args).unwrap();
    }
    runner::run(r, ["remote", "add", "origin", &format!("http://127.0.0.1:{port}/repo.git")]).unwrap();
    // Cover both a missing username and a known username with a missing password. Older Git
    // uses different messages for these; newer Git reports "unable to get password from user".
    for username in [None, Some("test")] {
        if let Some(user) = username {
            runner::run(r, ["config", "credential.username", user]).unwrap();
        }
        let started = Instant::now();
        let err = ops::fetch_background(r).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(30), "background fetch waited {:?}", started.elapsed());
        assert_eq!(err.kind, "auth", "username={username:?}: {}", err.message);
    }
}
