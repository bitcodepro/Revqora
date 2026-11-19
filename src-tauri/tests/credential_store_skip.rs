//! A login that Git Credential Manager (or another configured helper) gave Revqora is answered
//! by Revqora on the next transfer, and Git's `store` afterwards no longer reaches that helper:
//! it already keeps the login, and Git Credential Manager takes about a second per call.

use revqora_lib::{askpass, git::ops, git::runner};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;

fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap_or_else(|e| panic!("git {args:?}: {}", e.message))
}

fn pkt(line: &str) -> String {
    format!("{:04x}{line}", line.len() + 4)
}

/// Asks for a login, then advertises an empty repository to anyone who sends one.
fn signed_in_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let mut request = vec![0; 8192];
            let read = stream.read(&mut request).unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            if !request.contains("\r\nauthorization: basic ") {
                let _ =
                    stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
            let body = format!("{}0000{}0000", pkt("# service=git-upload-pack\n"), pkt(&format!("{} capabilities^{{}}\0agent=test\n", "0".repeat(40))));
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body.as_bytes());
        }
    });
    origin
}

#[test]
fn a_helper_login_answered_by_revqora_is_not_stored_in_the_helper_again() {
    let temp = tempfile::tempdir().unwrap();
    let exe = temp.path().join(if cfg!(windows) { "helper.exe" } else { "helper" });
    std::fs::copy(env!("CARGO_BIN_EXE_revqora"), &exe).unwrap();
    askpass::start(
        &exe,
        &temp.path().join("scripts"),
        Arc::new(|request| {
            askpass::respond(request.id, None);
        }),
    )
    .unwrap();

    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    // The configured helper writes down every request and answers `get` with a login.
    let log = temp.path().join("helper.log");
    let log_path = log.to_string_lossy().replace('\\', "/");
    let helper = format!(
        "!f() {{ echo \"$1\" >> \"{log_path}\"; cat >/dev/null; if [ \"$1\" = get ]; then printf 'username=user\\npassword=helper-fixture-token\\n'; fi; }}; f"
    );
    git(&repo, &["config", "credential.helper", ""]);
    git(&repo, &["config", "--add", "credential.helper", &helper]);
    git(&repo, &["remote", "add", "origin", &format!("{}/team/repo.git", signed_in_server())]);
    let requests = || std::fs::read_to_string(&log).unwrap_or_default().split_whitespace().map(str::to_owned).collect::<Vec<_>>();

    ops::fetch(&repo, None, false, |_| {}).expect("the first fetch signs in through the configured helper");
    assert_eq!(requests(), ["get", "store"], "the configured helper answers the first sign-in and keeps the login");

    ops::fetch(&repo, None, false, |_| {}).expect("the second fetch reuses the login");
    assert_eq!(requests(), ["get", "store"], "Revqora answered the second sign-in, so the helper was neither asked nor told to store it again");
    ops::fetch_background(&repo).expect("the automatic fetch reuses the login too");
    assert_eq!(requests(), ["get", "store"]);
}
