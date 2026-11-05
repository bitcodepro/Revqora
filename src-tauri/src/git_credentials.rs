//! A repository-scoped, memory-only Git credential helper. Git supplies matching
//! context and approves/rejects credentials; SSH prompts cannot access this channel.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};

pub const REPO_VAR: &str = "REVQORA_CREDENTIAL_REPO";
pub const EPOCH_VAR: &str = "REVQORA_CREDENTIAL_EPOCH";
pub const HELPER_VAR: &str = "REVQORA_CREDENTIAL_HELPER";
pub const HELPER_FLAG: &str = "--revqora-git-credential";
const LIMIT: usize = 200;

#[derive(Serialize, Deserialize)]
pub(crate) struct Request {
    operation: String,
    root: String,
    epoch: u64,
    input: String,
}
impl Drop for Request {
    fn drop(&mut self) {
        self.input.zeroize();
    }
}
#[derive(PartialEq, Eq)]
struct Key {
    root: PathBuf,
    protocol: String,
    host: String,
    path: Option<String>,
    username: String,
}
struct Entry {
    key: Key,
    password: Zeroizing<String>,
    expires: u64,
    touched: u64,
}
struct Cache {
    epoch: u64,
    entries: Vec<Entry>,
}
static CACHE: Mutex<Cache> = Mutex::new(Cache { epoch: 0, entries: Vec::new() });
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}
pub fn epoch() -> u64 {
    CACHE.lock().epoch
}
pub fn clear_sessions() {
    let mut c = CACHE.lock();
    c.entries.clear();
    c.epoch = c.epoch.wrapping_add(1);
}
fn root(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    std::fs::canonicalize(path).ok().or_else(|| Some(std::fs::canonicalize(path.parent()?).ok()?.join(path.file_name()?)))
}
fn parse(request: &Request) -> Option<(Key, Option<Zeroizing<String>>, Option<u64>)> {
    let mut fields = std::collections::HashMap::new();
    for line in request.input.lines().take_while(|line| !line.is_empty()) {
        let (key, value) = line.split_once('=')?;
        if !matches!(key, "protocol" | "host" | "path" | "username" | "password" | "password_expiry_utc") {
            continue;
        }
        if value.contains(['\r', '\0']) || fields.insert(key, value).is_some() {
            return None;
        }
    }
    let protocol = *fields.get("protocol")?;
    let host = *fields.get("host")?;
    let u = url::Url::parse(&format!("{protocol}://{host}/")).ok()?;
    let local = matches!(u.host(),Some(url::Host::Ipv4(ip)) if ip.is_loopback()) || matches!(u.host(),Some(url::Host::Ipv6(ip)) if ip.is_loopback());
    if !(protocol == "https" || protocol == "http" && local)
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return None;
    }
    let host = u.port().map(|p| format!("{}:{p}", u.host_str().unwrap_or_default())).unwrap_or_else(|| u.host_str().unwrap_or_default().into());
    let key = Key {
        root: root(Path::new(&request.root))?,
        protocol: protocol.into(),
        host,
        path: fields.get("path").map(|s| (*s).into()),
        username: fields.get("username").copied().unwrap_or_default().into(),
    };
    let password = fields.get("password").map(|s| Zeroizing::new((*s).to_owned()));
    let expiry = fields.get("password_expiry_utc").map(|s| s.parse()).transpose().ok()?;
    Some((key, password, expiry))
}
pub(crate) fn handle(request: &Request) -> String {
    let Some((key, password, expiry)) = parse(request) else {
        return String::new();
    };
    let time = now();
    let mut cache = CACHE.lock();
    if request.epoch != cache.epoch {
        return String::new();
    }
    cache.entries.retain(|e| e.expires > time);
    let matches = |entry: &Entry| {
        entry.key.root == key.root
            && entry.key.protocol == key.protocol
            && entry.key.host == key.host
            && entry.key.path == key.path
            && (key.username.is_empty() || entry.key.username == key.username)
    };
    match request.operation.as_str() {
        "get" => {
            let mut entries = cache.entries.iter().filter(|e| matches(e));
            if let (Some(entry), None) = (entries.next(), entries.next()) {
                return format!("username={}\npassword={}\npassword_expiry_utc={}\n\n", entry.key.username, entry.password.as_str(), entry.expires);
            }
        }
        "store" => {
            let Some(password) = password.filter(|p| !p.is_empty() && p.len() <= 16384) else {
                return String::new();
            };
            if key.username.is_empty() {
                return String::new();
            }
            let expires = expiry.unwrap_or(time.saturating_add(12 * 60 * 60));
            cache.entries.retain(|entry| entry.key != key);
            if expires > time {
                if cache.entries.len() >= LIMIT {
                    if let Some(index) = cache.entries.iter().enumerate().min_by_key(|(_, e)| e.touched).map(|(i, _)| i) {
                        cache.entries.remove(index);
                    }
                }
                cache.entries.push(Entry { key, password, expires, touched: time });
            }
        }
        "erase" => cache.entries.retain(|entry| !matches(entry) || password.as_ref().is_some_and(|p| p.as_str() != entry.password.as_str())),
        _ => {}
    }
    String::new()
}
pub(crate) fn run_helper(port: &str, operation: &str) -> i32 {
    if !matches!(operation, "get" | "store" | "erase") {
        return 0;
    }
    let (Ok(token), Ok(root), Ok(epoch)) = (std::env::var(crate::askpass::GIT_TOKEN_VAR), std::env::var(REPO_VAR), std::env::var(EPOCH_VAR)) else {
        return 1;
    };
    let Ok(epoch) = epoch.parse() else {
        return 1;
    };
    let mut input = String::new();
    if std::io::stdin().take(48 * 1024).read_to_string(&mut input).is_err() {
        return 1;
    }
    let request = Request { operation: operation.into(), root, epoch, input };
    match crate::askpass::credential(port, &token, request) {
        Ok(value) => {
            let value = Zeroizing::new(value);
            let mut output = std::io::stdout();
            if output.write_all(value.as_bytes()).and_then(|_| output.flush()).is_ok() {
                0
            } else {
                1
            }
        }
        Err(_) => 1,
    }
}
