//! Credential, passphrase and host-key prompts from git / ssh, answered in the Revqora window.
//!
//! Git and OpenSSH call the program in `GIT_ASKPASS` / `SSH_ASKPASS` with the prompt as the
//! only argument and read the answer from stdout. SSH calls our executable directly;
//! Git uses a portable wrapper adding a fixed argument. Each has a separate authenticated
//! socket capability, so server-controlled SSH text cannot become a Git request. When it
//! starts with `REVQORA_ASKPASS_PORT` in the environment it acts as a tiny helper that forwards
//! the prompt over a localhost socket (authenticated by a random token) to the running app,
//! which shows a dialog and sends the answer back.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

pub const PORT_VAR: &str = "REVQORA_ASKPASS_PORT";
pub const TOKEN_VAR: &str = "REVQORA_ASKPASS_TOKEN";
pub const GIT_TOKEN_VAR: &str = "REVQORA_GIT_ASKPASS_TOKEN";
const GIT_HELPER_FLAG: &str = "--revqora-git-askpass";
const MAX_LINE: u64 = 64 * 1024;
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Git,
    Ssh,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskpassRequest {
    pub id: u64,
    pub prompt: String,
    /// "username" | "secret" | "yesno" | "text"
    pub kind: String,
    pub origin: Origin,
}

#[derive(Serialize, Deserialize)]
struct Ask {
    token: String,
    #[serde(default)]
    prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential: Option<crate::git_credentials::Request>,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    ok: bool,
    value: String,
}
impl Drop for Answer {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.value.zeroize();
    }
}

type Responder = Arc<dyn Fn(AskpassRequest) + Send + Sync>;

struct PendingPrompt {
    request: AskpassRequest,
    answer: Sender<Option<String>>,
}

struct Server {
    pending: Mutex<HashMap<u64, PendingPrompt>>,
    next: AtomicU64,
}

static SERVER: OnceLock<Arc<Server>> = OnceLock::new();
static ENV: OnceLock<Vec<(String, String)>> = OnceLock::new();

/// Environment to give every git process (empty until the server runs).
pub fn env() -> &'static [(String, String)] {
    ENV.get().map(|v| v.as_slice()).unwrap_or(&[])
}

pub fn classify(prompt: &str) -> &'static str {
    let p = prompt.to_lowercase();
    if p.contains("(yes/no") || p.contains("yes/no/") {
        "yesno"
    } else if p.contains("username") {
        "username"
    } else if p.contains("password") || p.contains("passphrase") || p.contains("pin for") || p.contains("token") {
        "secret"
    } else {
        "text"
    }
}

struct Channels {
    git: String,
    ssh: String,
}
impl Channels {
    fn origin(&self, token: &str) -> Option<Origin> {
        if token == self.git {
            Some(Origin::Git)
        } else if token == self.ssh {
            Some(Origin::Ssh)
        } else {
            None
        }
    }
}

fn random_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new().fill(&mut bytes).map_err(|_| std::io::Error::other("Secure askpass randomness is unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Git executes one helper pathname, not a shell command with arguments. A tiny
/// executable script adds a fixed argv marker; SSH still executes the bare exe
/// with ONE server-controlled argument, which cannot become this two-arg entry.
fn git_helper(exe: &std::path::Path, directory: &std::path::Path, filename: &str, flag: &str) -> std::io::Result<std::path::PathBuf> {
    std::fs::create_dir_all(directory)?;
    let mut path = exe.to_string_lossy().into_owned();
    if cfg!(windows) {
        path = path.replace('\\', "/");
    }
    let quoted = path.replace('\'', "'\\''");
    let script = format!("#!/bin/sh\nexec '{quoted}' {flag} \"$@\"\n");
    let mut file = crate::git::atomic_file::new_in(directory)?;
    file.write_all(script.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file().set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    file.as_file().sync_all()?;
    let destination = directory.join(filename);
    crate::git::atomic_file::replace(file, &destination)?;
    Ok(destination)
}

/// Starts the prompt server. `on_request` shows the prompt; answers come back via [`respond`].
pub fn start(helper_exe: &std::path::Path, directory: &std::path::Path, on_request: Responder) -> std::io::Result<()> {
    if SERVER.get().is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let channels = Arc::new(Channels { git: random_token()?, ssh: random_token()? });
    let git_helper = git_helper(helper_exe, directory, "git-askpass.sh", GIT_HELPER_FLAG)?;
    let credential_helper = self::git_helper(helper_exe, directory, "git-credential.sh", crate::git_credentials::HELPER_FLAG)?;
    let credential_helper = credential_helper.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
    let server = Arc::new(Server { pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    let _ = SERVER.set(server.clone());
    let exe = helper_exe.to_string_lossy().into_owned();
    let mut vars = vec![
        ("GIT_ASKPASS".to_string(), git_helper.to_string_lossy().into_owned()),
        ("SSH_ASKPASS".to_string(), exe),
        // OpenSSH ≥ 8.4: use the askpass program even without a terminal or X display.
        ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
        (PORT_VAR.to_string(), port.to_string()),
        (TOKEN_VAR.to_string(), channels.ssh.clone()),
        (GIT_TOKEN_VAR.to_string(), channels.git.clone()),
        (crate::git_credentials::HELPER_VAR.into(), format!("!'{credential_helper}'")),
    ];
    if std::env::var_os("DISPLAY").is_none() {
        // Older OpenSSH builds only consult SSH_ASKPASS when DISPLAY is set.
        vars.push(("DISPLAY".to_string(), ":0".to_string()));
    }
    let _ = ENV.set(vars);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let server = server.clone();
            let channels = channels.clone();
            let on_request = on_request.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, &server, &channels, &on_request);
            });
        }
    });
    Ok(())
}

fn handle(stream: TcpStream, server: &Server, channels: &Channels, on_request: &Responder) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?.take(MAX_LINE));
    let mut line = zeroize::Zeroizing::new(String::new());
    reader.read_line(&mut line)?;
    let mut out = stream;
    let Ok(ask) = serde_json::from_str::<Ask>(line.trim()) else { return Ok(()) };
    let Some(origin) = channels.origin(&ask.token) else { return Ok(()) };
    if let Some(credential) = ask.credential {
        if origin != Origin::Git {
            return Ok(());
        }
        let value = zeroize::Zeroizing::new(crate::git_credentials::handle(&credential));
        let reply = zeroize::Zeroizing::new(serde_json::to_string(&Answer { ok: true, value: value.to_string() })?);
        writeln!(out, "{}", reply.as_str())?;
        return out.flush();
    }
    let id = server.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    let request = AskpassRequest { id, kind: classify(&ask.prompt).to_string(), prompt: ask.prompt, origin };
    server.pending.lock().insert(id, PendingPrompt { request: request.clone(), answer: tx });
    on_request(request);
    let answer = rx.recv_timeout(ANSWER_TIMEOUT).ok().flatten();
    server.pending.lock().remove(&id);
    let reply = match answer {
        Some(v) => Answer { ok: true, value: v },
        None => Answer { ok: false, value: String::new() },
    };
    writeln!(out, "{}", serde_json::to_string(&reply).unwrap_or_default())?;
    out.flush()
}

/// Delivers the user's answer (None = cancelled).
pub fn respond(id: u64, value: Option<String>) -> bool {
    let Some(server) = SERVER.get() else { return false };
    let tx = server.pending.lock().remove(&id);
    match tx {
        Some(pending) => pending.answer.send(value).is_ok(),
        None => false,
    }
}

/// Only a live native Git prompt may receive a saved account credential.
pub fn pending_request(id: u64) -> Option<AskpassRequest> {
    SERVER.get()?.pending.lock().get(&id).map(|pending| pending.request.clone())
}

/// Asks the running app; Ok(None) = the user cancelled.
pub fn ask(port: &str, token: &str, prompt: &str) -> std::io::Result<Option<String>> {
    let mut s = TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap_or(0)))?;
    let msg = serde_json::to_string(&Ask { token: token.to_string(), prompt: prompt.to_string(), credential: None }).unwrap_or_default();
    writeln!(s, "{msg}")?;
    s.flush()?;
    let mut line = String::new();
    BufReader::new(s.take(MAX_LINE)).read_line(&mut line)?;
    let mut a: Answer = serde_json::from_str(line.trim()).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(if a.ok { Some(std::mem::take(&mut a.value)) } else { None })
}

pub(crate) fn credential(port: &str, token: &str, request: crate::git_credentials::Request) -> std::io::Result<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap_or(0)))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let message = zeroize::Zeroizing::new(serde_json::to_string(&Ask { token: token.into(), prompt: String::new(), credential: Some(request) })?);
    writeln!(stream, "{}", message.as_str())?;
    stream.flush()?;
    let mut line = zeroize::Zeroizing::new(String::new());
    BufReader::new(stream.take(MAX_LINE)).read_line(&mut line)?;
    let mut answer: Answer = serde_json::from_str(line.trim())?;
    if answer.ok {
        Ok(std::mem::take(&mut answer.value))
    } else {
        Err(std::io::Error::other("Credential helper request rejected"))
    }
}

/// Entry point used by `main`: when started by git/ssh as the askpass program, answer and
/// return the exit code; otherwise None and the app starts normally.
pub fn run_helper_if_requested() -> Option<i32> {
    let port = std::env::var(PORT_VAR).ok()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [marker, operation] = args.as_slice() {
        if marker == crate::git_credentials::HELPER_FLAG {
            return Some(crate::git_credentials::run_helper(&port, operation));
        }
    }
    let (variable, prompt) = match args.as_slice() {
        [marker, prompt] if marker == GIT_HELPER_FLAG => (GIT_TOKEN_VAR, prompt),
        [prompt] => (TOKEN_VAR, prompt),
        _ => return Some(1),
    };
    let Ok(token) = std::env::var(variable) else { return Some(1) };
    match ask(&port, &token, prompt) {
        Ok(Some(v)) => {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{v}");
            let _ = out.flush();
            Some(0)
        }
        _ => Some(1),
    }
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn classifies_prompts() {
        assert_eq!(classify("Username for 'https://github.com': "), "username");
        assert_eq!(classify("Password for 'https://me@github.com': "), "secret");
        assert_eq!(classify("Enter passphrase for key '/c/Users/me/.ssh/id_ed25519': "), "secret");
        assert_eq!(classify("Are you sure you want to continue connecting (yes/no/[fingerprint])? "), "yesno");
        assert_eq!(classify("Something else"), "text");
    }
}
