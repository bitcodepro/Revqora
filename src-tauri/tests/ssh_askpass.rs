//! OpenSSH asks for a key passphrase through the Revqora executable (SSH_ASKPASS).
//! Uses ssh-agent / ssh-add / ssh-keygen from a Git for Windows install; skipped when missing.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use revqora_lib::askpass;

fn tool(dir: &Path, name: &str) -> Option<PathBuf> {
    let p = dir.join(format!("{name}.exe"));
    p.is_file().then_some(p)
}

#[test]
fn ssh_key_passphrase_is_asked_through_revqora() {
    if !cfg!(windows) {
        return;
    }
    let bin = PathBuf::from("C:/Program Files/Git/usr/bin");
    let (Some(agent), Some(add), Some(keygen)) = (tool(&bin, "ssh-agent"), tool(&bin, "ssh-add"), tool(&bin, "ssh-keygen")) else {
        eprintln!("Git for Windows ssh tools not found; skipping");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let key = tmp.path().join("id_test");
    let st = Command::new(&keygen).args(["-q", "-t", "ed25519", "-N", "correct horse", "-C", "revqora-test", "-f"]).arg(&key).status().unwrap();
    assert!(st.success());

    let prompts: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let p2 = prompts.clone();
    askpass::start(
        Path::new(env!("CARGO_BIN_EXE_revqora")),
        Arc::new(move |req| {
            p2.lock().unwrap().push(req.prompt.clone());
            std::thread::spawn(move || askpass::respond(req.id, Some("correct horse".into())));
        }),
    )
    .unwrap();

    // Start an agent and parse SSH_AUTH_SOCK / SSH_AGENT_PID from its sh-style output.
    let out = Command::new(&agent).arg("-s").output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let var = |name: &str| text.split(';').find_map(|p| p.trim().strip_prefix(&format!("{name}="))).map(|s| s.to_string()).unwrap_or_default();
    let sock = var("SSH_AUTH_SOCK");
    let pid = var("SSH_AGENT_PID");
    assert!(!sock.is_empty(), "agent output: {text}");

    let mut cmd = Command::new(&add);
    cmd.arg(&key).env("SSH_AUTH_SOCK", &sock).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in askpass::env() {
        cmd.env(k, v);
    }
    let res = cmd.output().unwrap();
    let _ = Command::new(&agent).args(["-k"]).env("SSH_AGENT_PID", &pid).env("SSH_AUTH_SOCK", &sock).output();
    assert!(res.status.success(), "ssh-add failed: {}", String::from_utf8_lossy(&res.stderr));
    let seen = prompts.lock().unwrap().clone();
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(seen[0].to_lowercase().contains("passphrase"), "{seen:?}");
}
