//! Credential, passphrase and host-key prompts from git / ssh, answered in the Revqora window.
//!
//! Git and OpenSSH call the program in `GIT_ASKPASS` / `SSH_ASKPASS` with the prompt as the
//! only argument and read the answer from stdout. We point both at our own executable: when it
//! starts with `REVQORA_ASKPASS_PORT` in the environment it acts as a tiny helper that forwards
//! the prompt over a localhost socket (authenticated by a random token) to the running app,
//! which shows a dialog and sends the answer back.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const PORT_VAR: &str = "REVQORA_ASKPASS_PORT";
pub const TOKEN_VAR: &str = "REVQORA_ASKPASS_TOKEN";
const MAX_LINE: u64 = 64 * 1024;
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskpassRequest {
    pub id: u64,
    pub prompt: String,
    /// "username" | "secret" | "yesno" | "text"
    pub kind: String,
}

#[derive(Serialize, Deserialize)]
struct Ask {
    token: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    ok: bool,
    value: String,
}

type Responder = Arc<dyn Fn(AskpassRequest) + Send + Sync>;

struct Server {
    pending: Mutex<HashMap<u64, Sender<Option<String>>>>,
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

fn random_token() -> String {
    let a = std::collections::hash_map::RandomState::new();
    let b = std::collections::hash_map::RandomState::new();
    let mut h1 = a.build_hasher();
    h1.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let mut h2 = b.build_hasher();
    h2.write_u32(std::process::id());
    format!("{:016x}{:016x}", h1.finish(), h2.finish())
}

/// Starts the prompt server. `on_request` shows the prompt; answers come back via [`respond`].
pub fn start(helper_exe: &std::path::Path, on_request: Responder) -> std::io::Result<()> {
    if SERVER.get().is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let server = Arc::new(Server { pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    let _ = SERVER.set(server.clone());
    let exe = helper_exe.to_string_lossy().into_owned();
    let mut vars = vec![
        ("GIT_ASKPASS".to_string(), exe.clone()),
        ("SSH_ASKPASS".to_string(), exe),
        // OpenSSH ≥ 8.4: use the askpass program even without a terminal or X display.
        ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
        (PORT_VAR.to_string(), port.to_string()),
        (TOKEN_VAR.to_string(), token.clone()),
    ];
    if std::env::var_os("DISPLAY").is_none() {
        // Older OpenSSH builds only consult SSH_ASKPASS when DISPLAY is set.
        vars.push(("DISPLAY".to_string(), ":0".to_string()));
    }
    let _ = ENV.set(vars);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let server = server.clone();
            let token = token.clone();
            let on_request = on_request.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, &server, &token, &on_request);
            });
        }
    });
    Ok(())
}

fn handle(stream: TcpStream, server: &Server, token: &str, on_request: &Responder) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?.take(MAX_LINE));
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut out = stream;
    let Ok(ask) = serde_json::from_str::<Ask>(line.trim()) else { return Ok(()) };
    if ask.token != token {
        return Ok(());
    }
    let id = server.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    server.pending.lock().insert(id, tx);
    on_request(AskpassRequest { id, kind: classify(&ask.prompt).to_string(), prompt: ask.prompt });
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
        Some(tx) => tx.send(value).is_ok(),
        None => false,
    }
}

/// Asks the running app; Ok(None) = the user cancelled.
pub fn ask(port: &str, token: &str, prompt: &str) -> std::io::Result<Option<String>> {
    let mut s = TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap_or(0)))?;
    let msg = serde_json::to_string(&Ask { token: token.to_string(), prompt: prompt.to_string() }).unwrap_or_default();
    writeln!(s, "{msg}")?;
    s.flush()?;
    let mut line = String::new();
    BufReader::new(s.take(MAX_LINE)).read_line(&mut line)?;
    let a: Answer = serde_json::from_str(line.trim()).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(if a.ok { Some(a.value) } else { None })
}

/// Entry point used by `main`: when started by git/ssh as the askpass program, answer and
/// return the exit code; otherwise None and the app starts normally.
pub fn run_helper_if_requested() -> Option<i32> {
    let port = std::env::var(PORT_VAR).ok()?;
    let token = std::env::var(TOKEN_VAR).ok()?;
    let prompt = std::env::args().nth(1).unwrap_or_default();
    match ask(&port, &token, &prompt) {
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
