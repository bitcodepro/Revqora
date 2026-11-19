//! A login that Git Credential Manager (or another configured helper) gave Revqora is answered
//! by Revqora on the next transfer, and Git's `store` afterwards no longer reaches that helper:
//! it already keeps the login, and Git Credential Manager takes about a second per call.
//! Any other login, such as one typed into Revqora's prompt for another host, still does.

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
    // Revqora's prompt: the user types a login for the host the configured helper does not know.
    askpass::start(
        &exe,
        &temp.path().join("scripts"),
        Arc::new(|request| {
            let typed = if request.prompt.starts_with("Username") { "user" } else { "typed-fixture-token" };
            askpass::respond(request.id, Some(typed.into()));
        }),
    )
    .unwrap();

    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    // The configured helper writes down every request with its host and password, and answers
    // `get` with a login only for the first server.
    let log = temp.path().join("helper.log");
    let log_path = log.to_string_lossy().replace('\\', "/");
    let origin = signed_in_server();
    let other = signed_in_server();
    let known = origin.trim_start_matches("http://");
    let helper = format!(
        "!f() {{ i=$(cat); h=$(printf '%s\\n' \"$i\" | sed -n 's/^host=//p'); p=$(printf '%s\\n' \"$i\" | sed -n 's/^password=//p'); echo \"$1@$h@$p\" >> \"{log_path}\"; if [ \"$1\" = get ] && [ \"$h\" = '{known}' ]; then printf 'username=user\\npassword=helper-fixture-token\\n'; fi; }}; f"
    );
    git(&repo, &["config", "credential.helper", ""]);
    git(&repo, &["config", "--add", "credential.helper", &helper]);
    git(&repo, &["remote", "add", "origin", &format!("{origin}/team/repo.git")]);
    let other_host = other.trim_start_matches("http://");
    let requests = || std::fs::read_to_string(&log).unwrap_or_default().split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    let first = [format!("get@{known}@"), format!("store@{known}@helper-fixture-token")];

    ops::fetch(&repo, Some("origin"), false, |_| {}).expect("the first fetch signs in through the configured helper");
    assert_eq!(requests(), first, "the configured helper answers the first sign-in and keeps the login");

    ops::fetch(&repo, Some("origin"), false, |_| {}).expect("the second fetch reuses the login");
    assert_eq!(requests(), first, "Revqora answered the second sign-in, so the helper was neither asked nor told to store it again");
    ops::fetch_background(&repo).expect("the automatic fetch reuses the login too");
    assert_eq!(requests(), first);

    git(&repo, &["remote", "add", "other", &format!("{other}/team/repo.git")]);
    // Revqora holds the helper's login, but has none for this host: the helper is asked, has
    // nothing, the user types a login into Revqora's prompt, and the helper must keep that one.
    ops::fetch(&repo, Some("other"), false, |_| {}).expect("the fetch from the other host signs in through Revqora's prompt");
    let mut expected = first.to_vec();
    expected.extend([format!("get@{other_host}@"), format!("store@{other_host}@typed-fixture-token")]);
    assert_eq!(requests(), expected, "a login typed into Revqora reaches the configured helper's store");
}
