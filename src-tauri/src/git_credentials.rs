//! A repository-scoped Git credential helper. Git supplies matching
//! context and approves/rejects credentials; SSH prompts cannot access this channel.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};
#[cfg(windows)]
mod remembered;
#[cfg(windows)]
use sha2::{Digest, Sha256};

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
#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(windows, derive(Deserialize, Serialize))]
struct Key {
    root: PathBuf,
    protocol: String,
    host: String,
    path: Option<String>,
    username: String,
}
impl Key {
    fn matches(&self, query: &Self) -> bool {
        self.root == query.root
            && self.protocol == query.protocol
            && self.host == query.host
            && self.path == query.path
            && (query.username.is_empty() || self.username == query.username)
    }
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
    #[cfg(windows)]
    pending: Vec<Pending>,
}
static CACHE: Mutex<Cache> = Mutex::new(Cache {
    epoch: 0,
    entries: Vec::new(),
    #[cfg(windows)]
    pending: Vec::new(),
});
#[cfg(windows)]
struct Pending {
    key: Key,
    digest: Zeroizing<[u8; 32]>,
    until: u64,
    api_email: Option<String>,
}

#[cfg(windows)]
pub(crate) fn remember_input(repo: &Path, epoch: u64, url: &url::Url, value: &str, email: Option<String>) {
    remember_in(&mut CACHE.lock(), repo, epoch, url, value, email);
}

#[cfg(windows)]
fn remember_in(cache: &mut Cache, repo: &Path, epoch: u64, url: &url::Url, value: &str, email: Option<String>) {
    let Some(root) = root(repo) else { return };
    let Some(host) = url.host_str() else { return };
    let key = Key {
        root,
        protocol: url.scheme().into(),
        host: url.port().map_or_else(|| host.into(), |port| format!("{host}:{port}")),
        path: Some(url.path().trim_start_matches('/'))
            .filter(|p| !p.is_empty())
            .map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()),
        username: percent_encoding::percent_decode_str(url.username()).decode_utf8_lossy().into_owned(),
    };
    if cache.epoch != epoch || value.is_empty() || value.len() > 16384 {
        return;
    }
    cache.pending.retain(|entry| entry.until > now());
    if cache.pending.len() >= LIMIT {
        cache.pending.remove(0);
    }
    let api_email = email.filter(|s| host == "bitbucket.org" && s.len() <= 254 && s.contains('@') && !s.chars().any(|c| c.is_whitespace() || c.is_control()));
    cache.pending.push(Pending { key, digest: Zeroizing::new(Sha256::digest(value.as_bytes()).into()), until: now() + 600, api_email });
}
#[cfg(not(windows))]
pub(crate) fn remember_input(_repo: &Path, _epoch: u64, _url: &url::Url, _value: &str, _email: Option<String>) {}

#[cfg(windows)]
pub(crate) fn bitbucket_email(repo: &Path, path: &str, username: &str, password: &str) -> Option<String> {
    let root = root(repo)?;
    let store = remembered::Store::for_repo(&root).ok()?;
    let mut tokens = store.read().ok()?;
    let mut matches = tokens.iter_mut().filter(|token| {
        token.expires.is_none_or(|expiry| expiry > now())
            && token.key.root == root
            && token.key.protocol == "https"
            && token.key.host == "bitbucket.org"
            && token.key.path.as_deref().is_none_or(|p| p == path)
            && token.key.username == username
            && token.password == password
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    first.api_email.take()
}

#[cfg(windows)]
pub(crate) fn expired(repo: &Path, protocol: &str, host: &str, path: &str, username: &str) -> bool {
    let Some(root) = root(repo) else { return false };
    let Ok(tokens) = remembered::Store::for_repo(&root).and_then(|store| store.read()) else { return false };
    let mut matching = tokens.iter().filter(|token| {
        token.key.root == root
            && token.key.protocol == protocol
            && token.key.host == host
            && token.key.path.as_deref().is_none_or(|p| p == path)
            && (username.is_empty() || token.key.username == username)
    });
    matching.next().is_some_and(|token| token.expires.is_some_and(|expiry| expiry <= now())) && matching.next().is_none()
}

#[cfg(windows)]
pub(crate) fn forget(repo: &Path) -> std::io::Result<()> {
    let root = root(repo).ok_or_else(|| std::io::Error::other("Repository unavailable."))?;
    let mut cache = CACHE.lock();
    remembered::Store::for_repo(&root)?.forget()?;
    cache.entries.retain(|entry| entry.key.root != root);
    cache.pending.retain(|entry| entry.key.root != root);
    cache.epoch = cache.epoch.wrapping_add(1);
    Ok(())
}
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}
pub fn epoch() -> u64 {
    CACHE.lock().epoch
}
pub fn clear_sessions() {
    let mut c = CACHE.lock();
    c.entries.clear();
    #[cfg(windows)]
    c.pending.clear();
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
fn response(key: &Key, password: &str, expires: Option<u64>) -> String {
    let expiry = expires.map(|e| format!("password_expiry_utc={e}\n")).unwrap_or_default();
    format!("username={}\npassword={password}\n{expiry}\n", key.username)
}

pub(crate) fn handle(request: &Request) -> std::io::Result<String> {
    handle_in(request, &mut CACHE.lock())
}

fn handle_in(request: &Request, cache: &mut Cache) -> std::io::Result<String> {
    let Some((key, password, expiry)) = parse(request) else {
        return Ok(String::new());
    };
    let time = now();
    if request.epoch != cache.epoch {
        return Ok(String::new());
    }
    cache.entries.retain(|e| e.expires > time);
    match request.operation.as_str() {
        "get" => {
            let mut entries = cache.entries.iter().filter(|entry| entry.key.matches(&key));
            let first = entries.next();
            if entries.next().is_some() {
                return Ok(String::new());
            }
            #[cfg(windows)]
            if key.protocol == "https" && (first.is_none() || key.username.is_empty()) {
                let saved = remembered::Store::for_repo(&key.root)?.read()?;
                let mut matches = saved.iter().filter(|token| {
                    token.expires.is_none_or(|expiry| expiry > time) && token.key.matches(&key) && first.is_none_or(|entry| entry.key != token.key)
                });
                if let Some(token) = matches.next() {
                    return Ok(if first.is_none() && matches.next().is_none() { response(&token.key, &token.password, token.expires) } else { String::new() });
                }
            }
            if let Some(entry) = first {
                return Ok(response(&entry.key, &entry.password, Some(entry.expires)));
            }
        }
        "store" => {
            let Some(password) = password.filter(|p| !p.is_empty() && p.len() <= 16384) else {
                return Ok(String::new());
            };
            if key.username.is_empty() {
                return Ok(String::new());
            }
            #[cfg(windows)]
            let remembered = {
                cache.pending.retain(|entry| entry.until > time);
                let digest: [u8; 32] = Sha256::digest(password.as_bytes()).into();
                cache
                    .pending
                    .iter()
                    .position(|entry| {
                        entry.key.root == key.root
                            && entry.key.host == key.host
                            && entry.key.protocol == key.protocol
                            && entry.key.path.as_ref().is_none_or(|path| key.path.as_ref() == Some(path))
                            && (entry.key.username.is_empty() || entry.key.username == key.username)
                            && *entry.digest == digest
                    })
                    .map(|index| cache.pending.remove(index))
            };
            let expires = expiry.unwrap_or(time.saturating_add(12 * 60 * 60));
            cache.entries.retain(|entry| entry.key != key);
            if expires > time {
                if cache.entries.len() >= LIMIT {
                    if let Some(index) = cache.entries.iter().enumerate().min_by_key(|(_, e)| e.touched).map(|(i, _)| i) {
                        cache.entries.remove(index);
                    }
                }
                #[cfg(windows)]
                let saved = remembered
                    .map(|pending| {
                        remembered::Store::for_repo(&key.root)?.save(remembered::Token {
                            key: key.clone(),
                            password: password.to_string(),
                            expires: expiry,
                            api_email: pending.api_email,
                        })
                    })
                    .transpose();
                cache.entries.push(Entry { key, password, expires, touched: time });
                #[cfg(windows)]
                saved?;
            }
        }
        "erase" => {
            cache.entries.retain(|entry| !entry.key.matches(&key) || password.as_ref().is_some_and(|p| p.as_str() != entry.password.as_str()));
            #[cfg(windows)]
            if key.protocol == "https" {
                remembered::Store::for_repo(&key.root)?.erase(&key, password.as_ref().map(|p| p.as_str()))?;
            }
        }
        _ => {}
    }
    Ok(String::new())
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn remembers_only_approved_prompt_values_and_reuses_them_after_restart() {
        let fixture = tempfile::tempdir_in(crate::portable::temp_dir().unwrap()).unwrap();
        let repo = fixture.path();
        let mut cache = Cache { epoch: 0, entries: vec![], pending: vec![] };
        let request = |operation: &str, fields: &str| Request {
            operation: operation.into(),
            root: repo.to_string_lossy().into_owned(),
            epoch: 0,
            input: format!("protocol=https\nhost=bitbucket.org\npath=team/repo.git\nusername=git-name\n{fields}\n"),
        };
        let url = url::Url::parse("https://git-name@bitbucket.org/team/repo.git").unwrap();
        let store = remembered::Store::for_repo(&root(repo).unwrap()).unwrap();
        remember_in(&mut cache, repo, 0, &url, "fixture-token", Some("owner@example.invalid".into()));
        assert!(store.read().unwrap().is_empty());
        handle_in(&request("store", "password=unrelated\n"), &mut cache).unwrap();
        assert!(store.read().unwrap().is_empty());
        handle_in(&request("store", "password=fixture-token\n"), &mut cache).unwrap();
        cache.entries.clear();
        assert!(handle_in(&request("get", ""), &mut cache).unwrap().contains("password=fixture-token\n"));
        assert_eq!(bitbucket_email(repo, "team/repo.git", "git-name", "fixture-token").as_deref(), Some("owner@example.invalid"));
        assert!(bitbucket_email(repo, "team/other.git", "git-name", "fixture-token").is_none());
        handle_in(&request("erase", "password=unrelated\n"), &mut cache).unwrap();
        assert!(!store.read().unwrap().is_empty());
        handle_in(&request("erase", "password=fixture-token\n"), &mut cache).unwrap();
        assert!(handle_in(&request("get", ""), &mut cache).unwrap().is_empty());
        store.forget().unwrap();
    }
}
