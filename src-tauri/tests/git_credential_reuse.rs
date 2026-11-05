use revqora_lib::{askpass, git::runner, git_credentials};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

fn query(root: &Path, operation: &str, body: &str) -> runner::Output {
    runner::exec_full(
        root,
        ["-c", "credential.interactive=false", "-c", "core.askPass=", "credential", operation],
        &[("GIT_ASKPASS", "")],
        Some(body.as_bytes()),
    )
    .unwrap()
}
fn body(host: &str, path: &str, user: &str, password: Option<&str>) -> String {
    format!("protocol=https\nhost={host}\npath={path}\nusername={user}\n{}\n", password.map(|p| format!("password={p}\n")).unwrap_or_default())
}
#[test]
fn git_approved_tokens_reuse_exact_scope_without_prompts_and_reject_ssh_and_stale_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let one = temp.path().join("one");
    let two = temp.path().join("two");
    for root in [&one, &two] {
        std::fs::create_dir(root).unwrap();
        runner::run(root, ["init", "-q"]).unwrap();
        runner::run(root, ["config", "credential.helper", ""]).unwrap();
        runner::run(root, ["config", "credential.useHttpPath", "true"]).unwrap();
    }
    let exe = temp.path().join(if cfg!(windows) { "helper ' space $ токен.exe" } else { "helper ' space $ токен" });
    std::fs::copy(env!("CARGO_BIN_EXE_revqora"), &exe).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    askpass::start(
        &exe,
        &temp.path().join("helper scripts ' $"),
        Arc::new(move |request| {
            seen.fetch_add(1, Ordering::Relaxed);
            askpass::respond(request.id, None);
        }),
    )
    .unwrap();
    let approved = body("bitbucket.org", "team/repo.git", "alice", Some("fixture-token-one"));
    assert!(query(&one, "approve", &approved).ok());
    let lookup = body("bitbucket.org", "team/repo.git", "alice", None);
    let filled = query(&one, "fill", &lookup);
    assert!(filled.ok());
    assert!(filled.text().contains("password=fixture-token-one"));
    for (root, input) in [
        (&two, lookup.clone()),
        (&one, body("bitbucket.org", "other/repo.git", "alice", None)),
        (&one, body("bitbucket.org", "team/repo.git", "bob", None)),
        (&one, body("bitbucket.org.evil.invalid", "team/repo.git", "alice", None)),
    ] {
        assert!(!query(root, "fill", &input).ok(), "A different credential scope obtained a token");
    }
    let unspecified = "protocol=https\nhost=bitbucket.org\npath=team/repo.git\n\n";
    assert!(query(&one, "fill", unspecified).ok());
    let bob = body("bitbucket.org", "team/repo.git", "bob", Some("fixture-token-bob"));
    assert!(query(&one, "approve", &bob).ok());
    assert!(!query(&one, "fill", unspecified).ok(), "An ambiguous account was chosen silently");
    assert!(query(&one, "reject", &bob).ok());

    // An older request rejecting token A cannot erase a newer token B.
    let changed = body("bitbucket.org", "team/repo.git", "alice", Some("fixture-token-two"));
    assert!(query(&one, "approve", &changed).ok());
    assert!(query(&one, "reject", &approved).ok());
    assert!(query(&one, "fill", &lookup).text().contains("password=fixture-token-two"));
    assert!(query(&one, "reject", &changed).ok());
    assert!(!query(&one, "fill", &lookup).ok());
    assert!(query(&one, "approve", &approved).ok());
    let environment = askpass::env();
    let get = |key: &str| environment.iter().find(|(k, _)| k == key).unwrap().1.as_str();
    let request = |token: &str, operation: &str, input: &str| {
        let mut stream = TcpStream::connect(format!("127.0.0.1:{}", get(askpass::PORT_VAR))).unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let message = serde_json::json!({"token":token,"credential":{"operation":operation,"root":one,"epoch":git_credentials::epoch(),"input":input}});
        writeln!(stream, "{message}").unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        response
    };
    assert!(request(get(askpass::TOKEN_VAR), "get", &lookup).is_empty(), "The SSH capability accessed Git credentials");
    assert!(request("invalid", "get", &lookup).is_empty());
    let reply = request(get(askpass::GIT_TOKEN_VAR), "get", &lookup);
    assert!(reply.contains("fixture-token-one"));
    // New Git helpers send repeated capability[]/wwwauth[] fields. Ignore
    // unfamiliar attributes without dropping the real username/password.
    let with_capabilities = format!("capability[]=authtype\ncapability[]=state\nwwwauth[]=Basic\nwwwauth[]=Bearer\n{approved}");
    assert!(!request(get(askpass::GIT_TOKEN_VAR), "store", &with_capabilities).is_empty());
    assert!(query(&one, "fill", &lookup).ok());
    let expired = format!("password_expiry_utc=1\n{approved}");
    request(get(askpass::GIT_TOKEN_VAR), "store", &expired);
    assert!(!query(&one, "fill", &lookup).ok());
    let old_epoch = git_credentials::epoch().to_string();
    git_credentials::clear_sessions();
    let old = runner::exec_full(&one, ["credential", "approve"], &[(git_credentials::EPOCH_VAR, &old_epoch)], Some(approved.as_bytes())).unwrap();
    assert!(old.ok());
    assert!(!query(&one, "fill", &lookup).ok(), "An in-flight old session repopulated the cache after locking");
    assert!(query(&one, "approve", &approved).ok());
    assert!(query(&one, "fill", &lookup).ok());
    git_credentials::clear_sessions();
    assert!(!query(&one, "fill", &lookup).ok());
    assert_eq!(count.load(Ordering::Relaxed), 0, "Credential reuse tried to show an interactive sign-in");
    // Token material is neither written into the helpers nor into any config.
    for path in [one.join(".git/config"), two.join(".git/config"), temp.path().join("helper scripts ' $/git-credential.sh")] {
        let bytes = std::fs::read(path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("fixture-token-"));
    }
}
