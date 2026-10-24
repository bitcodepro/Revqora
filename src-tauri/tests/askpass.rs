//! Git asks for credentials through the Revqora executable acting as GIT_ASKPASS.

use std::path::Path;
use std::sync::{Arc, Mutex};

use revqora_lib::askpass;
use revqora_lib::git::runner;

#[test]
fn git_credential_prompts_go_through_revqora() {
    let exe = env!("CARGO_BIN_EXE_revqora");
    let answer: Arc<Mutex<Option<&'static str>>> = Arc::new(Mutex::new(Some("ok")));
    let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let (a, s) = (answer.clone(), seen.clone());
    askpass::start(
        Path::new(exe),
        Arc::new(move |req| {
            s.lock().unwrap().push((req.kind.clone(), req.prompt.clone()));
            let reply = a.lock().unwrap().map(|_| if req.kind == "username" { "alice".to_string() } else { "s3cret".to_string() });
            std::thread::spawn(move || askpass::respond(req.id, reply));
        }),
    )
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    runner::run(dir.path(), ["init", "-q"]).unwrap();
    let input = b"protocol=https\nhost=example.com\n\n";
    // An empty helper list makes git fall back to GIT_ASKPASS.
    let out = runner::exec_full(dir.path(), ["-c", "credential.helper=", "credential", "fill"], &[], Some(input)).unwrap();
    let text = out.text();
    assert!(out.ok(), "credential fill failed: {}", out.stderr);
    assert!(text.contains("username=alice"), "{text}");
    assert!(text.contains("password=s3cret"), "{text}");
    let prompts = seen.lock().unwrap().clone();
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[0].0, "username");
    assert_eq!(prompts[1].0, "secret");
    assert!(prompts[0].1.contains("example.com"));

    // Cancelling the dialog makes the git command fail instead of hanging.
    *answer.lock().unwrap() = None;
    let out = runner::exec_full(dir.path(), ["-c", "credential.helper=", "credential", "fill"], &[], Some(input)).unwrap();
    assert!(!out.ok());
}
