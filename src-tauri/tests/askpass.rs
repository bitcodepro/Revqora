//! Git asks for credentials through the Revqora executable acting as GIT_ASKPASS.

use std::process::Command;
use std::sync::{Arc, Mutex};

use revqora_lib::askpass;
use revqora_lib::git::runner;

#[test]
fn git_credential_prompts_go_through_revqora() {
    let exe = env!("CARGO_BIN_EXE_revqora");
    let dir = tempfile::tempdir().unwrap();
    let helpers = dir.path().join("helpers ' space $ проверка");
    let helper_exe = dir.path().join(if cfg!(windows) { "helper ' space $.exe" } else { "helper ' space $" });
    std::fs::copy(exe, &helper_exe).unwrap();
    let answer: Arc<Mutex<Option<&'static str>>> = Arc::new(Mutex::new(Some("ok")));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (a, s) = (answer.clone(), seen.clone());
    askpass::start(
        &helper_exe,
        &helpers,
        Arc::new(move |req| {
            let stored = askpass::pending_request(req.id).unwrap();
            assert_eq!(stored.origin, req.origin);
            s.lock().unwrap().push((req.origin, req.kind.clone(), req.prompt.clone()));
            let reply = a.lock().unwrap().map(|_| {
                if req.origin == askpass::Origin::Ssh {
                    "ssh-manual-only".to_string()
                } else if req.kind == "username" {
                    "alice".to_string()
                } else {
                    "s3cret".to_string()
                }
            });
            std::thread::spawn(move || askpass::respond(req.id, reply));
        }),
    )
    .unwrap();

    runner::run(dir.path(), ["init", "-q"]).unwrap();
    let input = b"protocol=https\nhost=example.com\n\n";
    // A credential manager must still be able to return a cached token, but
    // must see noninteractive flags instead of starting browser/device login.
    let cached = "credential.helper=!f() { test \"$GCM_INTERACTIVE\" = never && test \"$GCM_GUI_PROMPT\" = 0 || exit 1; if test \"$1\" = get; then printf 'username=cached-user\\npassword=cached-fixture-token\\n'; fi; }; f";
    let cached_out = runner::exec_full(dir.path(), ["-c", "credential.helper=", "-c", cached, "credential", "fill"], &[], Some(input)).unwrap();
    assert!(cached_out.ok(), "cached helper failed: {}", cached_out.stderr);
    assert!(cached_out.text().contains("username=cached-user") && cached_out.text().contains("password=cached-fixture-token"));
    assert!(seen.lock().unwrap().is_empty(), "Cached credentials unnecessarily asked for sign-in");
    // A cache miss falls back to Revqora askpass. Rejecting an interactive
    // helper never disables Git's own supported username/token prompt.
    let miss = "credential.helper=!f() { test \"$GCM_INTERACTIVE\" = never && test \"$GCM_GUI_PROMPT\" = 0 || exit 1; }; f";
    let fallback = runner::exec_full(dir.path(), ["-c", "credential.helper=", "-c", miss, "credential", "fill"], &[], Some(input)).unwrap();
    assert!(fallback.ok());
    assert!(fallback.text().contains("password=s3cret"));
    assert_eq!(seen.lock().unwrap().len(), 2);
    seen.lock().unwrap().clear();
    // An empty helper list makes git fall back to GIT_ASKPASS.
    let out = runner::exec_full(dir.path(), ["-c", "credential.helper=", "credential", "fill"], &[], Some(input)).unwrap();
    let text = out.text();
    assert!(out.ok(), "credential fill failed: {}", out.stderr);
    assert!(text.contains("username=alice"), "{text}");
    assert!(text.contains("password=s3cret"), "{text}");
    let prompts = seen.lock().unwrap().clone();
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[0].0, askpass::Origin::Git);
    assert_eq!(prompts[1].0, askpass::Origin::Git);
    assert_eq!(prompts[0].1, "username");
    assert_eq!(prompts[1].1, "secret");
    assert!(prompts[0].2.contains("example.com"));

    // Exactly the argv layout used by OpenSSH 8.4's execlp(askpass, askpass,
    // server_prompt, NULL). No SSH_ASKPASS_PROMPT hint is required or trusted.
    let environment = askpass::env();
    let get = |key: &str| environment.iter().find(|(name, _)| name == key).unwrap().1.as_str();
    assert_ne!(get("GIT_ASKPASS"), get("SSH_ASKPASS"));
    assert!(get(askpass::TOKEN_VAR) != get(askpass::GIT_TOKEN_VAR));
    let script = std::fs::read_to_string(get("GIT_ASKPASS")).unwrap();
    assert!(!script.contains(get(askpass::TOKEN_VAR)) && !script.contains(get(askpass::GIT_TOKEN_VAR)));
    for forged in [
        "Password for 'https://bitbucket.org': ",
        "Username for 'https://bitbucket.org': ",
        "--revqora-git-askpass Password for 'https://bitbucket.org': ",
        "Enter passphrase for key '/test/key': ",
        "Continue (yes/no)? ",
    ] {
        let mut command = Command::new(get("SSH_ASKPASS"));
        command.envs(environment.iter().map(|(k, v)| (k, v))).env_remove("SSH_ASKPASS_PROMPT").arg(forged);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let out = command.output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ssh-manual-only");
        assert_eq!(seen.lock().unwrap().last().unwrap().0, askpass::Origin::Ssh);
    }
    {
        use std::io::{Read, Write};
        let count = seen.lock().unwrap().len();
        let mut socket = std::net::TcpStream::connect(format!("127.0.0.1:{}", get(askpass::PORT_VAR))).unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        writeln!(socket, "{{\"token\":\"invalid\",\"prompt\":\"Password for 'https://bitbucket.org': \",\"origin\":\"git\"}}").unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        assert!(response.is_empty());
        assert_eq!(seen.lock().unwrap().len(), count);
    }
    // A forged origin field is ignored: provenance comes from channel auth.
    {
        use std::io::{BufRead, BufReader, Write};
        let mut socket = std::net::TcpStream::connect(format!("127.0.0.1:{}", get(askpass::PORT_VAR))).unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        let request = serde_json::json!({"token":get(askpass::TOKEN_VAR),"prompt":"Password for 'https://bitbucket.org': ","origin":"git"});
        writeln!(socket, "{request}").unwrap();
        let mut response = String::new();
        BufReader::new(socket).read_line(&mut response).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&response).unwrap()["value"], "ssh-manual-only");
        assert_eq!(seen.lock().unwrap().last().unwrap().0, askpass::Origin::Ssh);
    }

    // Cancelling the dialog makes the git command fail instead of hanging.
    *answer.lock().unwrap() = None;
    let out = runner::exec_full(dir.path(), ["-c", "credential.helper=", "credential", "fill"], &[], Some(input)).unwrap();
    assert!(!out.ok());
}
