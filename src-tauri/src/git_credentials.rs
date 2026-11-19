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
use sha2::{Digest, Sha256};

pub const REPO_VAR: &str = "REVQORA_CREDENTIAL_REPO";
pub const EPOCH_VAR: &str = "REVQORA_CREDENTIAL_EPOCH";
pub const HELPER_VAR: &str = "REVQORA_CREDENTIAL_HELPER";
pub const HELPER_FLAG: &str = "--revqora-git-credential";
/// Names one Git command run by Revqora: its helper calls share it, so `kept` can tell whether
/// Revqora itself answered `get` in that very command.
pub const CALL_VAR: &str = "REVQORA_CREDENTIAL_CALL";
const LIMIT: usize = 200;

#[derive(Serialize, Deserialize)]
pub(crate) struct Request {
    operation: String,
    root: String,
    epoch: u64,
    input: String,
    #[serde(default)]
    call: String,
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
    /// Approved by Git after a configured helper (Git Credential Manager, a keychain) answered:
    /// neither typed into a Revqora prompt nor remembered by Revqora. That helper keeps it.
    from_helper: bool,
}
struct Cache {
    epoch: u64,
    entries: Vec<Entry>,
    #[cfg(windows)]
    pending: Vec<Pending>,
    /// Digests of values typed into Revqora's Git prompts in the last ten minutes, per
    /// repository: a login Git approves with one of them did not come from a helper.
    typed: Vec<Typed>,
    /// Logins Revqora answered `get` with, per Git command (see [`CALL_VAR`]).
    answered: Vec<Answered>,
}
static CACHE: Mutex<Cache> = Mutex::new(Cache {
    epoch: 0,
    entries: Vec::new(),
    #[cfg(windows)]
    pending: Vec::new(),
    typed: Vec::new(),
    answered: Vec::new(),
});
struct Answered {
    call: String,
    key: Key,
    digest: Zeroizing<[u8; 32]>,
    until: u64,
}
struct Typed {
    root: PathBuf,
    digest: Zeroizing<[u8; 32]>,
    until: u64,
}

/// Notes a value typed into a Revqora prompt that Git opened for `repo`.
pub(crate) fn note_typed(repo: &Path, epoch: u64, value: &str) {
    note_typed_in(&mut CACHE.lock(), repo, epoch, value);
}

fn note_typed_in(cache: &mut Cache, repo: &Path, epoch: u64, value: &str) {
    let Some(root) = root(repo) else { return };
    if cache.epoch != epoch || value.is_empty() || value.len() > 16384 {
        return;
    }
    let time = now();
    cache.typed.retain(|entry| entry.until > time);
    if cache.typed.len() >= LIMIT {
        cache.typed.remove(0);
    }
    cache.typed.push(Typed { root, digest: Zeroizing::new(Sha256::digest(value.as_bytes()).into()), until: time + 600 });
}
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
    cache.typed.retain(|entry| entry.root != root);
    cache.epoch = cache.epoch.wrapping_add(1);
    Ok(())
}
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}
/// Whether Revqora's helper may answer for `repo`: a credential typed in this session or a
/// remembered token. Cheap: it neither decrypts nor contacts the helper.
pub(crate) fn remembers(repo: &Path) -> bool {
    let Some(root) = root(repo) else { return false };
    let typed = CACHE.lock().entries.iter().any(|entry| entry.key.root == root);
    typed || remembered_on_disk(&root)
}
#[cfg(windows)]
fn remembered_on_disk(root: &Path) -> bool {
    remembered::Store::for_repo(root).is_ok_and(|store| store.exists())
}
#[cfg(not(windows))]
fn remembered_on_disk(_root: &Path) -> bool {
    false
}
/// Whether Revqora holds a login for `repo` that a configured helper gave it in this session.
/// Only then can a `store` to the configured helpers repeat what they keep already (see
/// [`run_helper`]'s `kept` check); otherwise they are not asked.
pub(crate) fn holds_helper_logins(repo: &Path) -> bool {
    let Some(root) = root(repo) else { return false };
    CACHE.lock().entries.iter().any(|entry| entry.key.root == root && entry.from_helper)
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
                let answer = response(&entry.key, &entry.password, Some(entry.expires));
                if entry.from_helper && !request.call.is_empty() {
                    let answered = Answered {
                        call: request.call.clone(),
                        key: entry.key.clone(),
                        digest: Zeroizing::new(Sha256::digest(entry.password.as_bytes()).into()),
                        until: time + 600,
                    };
                    cache.answered.retain(|entry| entry.until > time);
                    if cache.answered.len() >= LIMIT {
                        cache.answered.remove(0);
                    }
                    cache.answered.push(answered);
                }
                return Ok(answer);
            }
        }
        "store" => {
            let Some(password) = password.filter(|p| !p.is_empty() && p.len() <= 16384) else {
                return Ok(String::new());
            };
            if key.username.is_empty() {
                return Ok(String::new());
            }
            let digest: [u8; 32] = Sha256::digest(password.as_bytes()).into();
            cache.typed.retain(|entry| entry.until > time);
            let typed = cache.typed.iter().any(|entry| entry.root == key.root && *entry.digest == digest);
            #[cfg(windows)]
            let remembered = {
                cache.pending.retain(|entry| entry.until > time);
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
                let from_helper = !typed && remembered.is_none();
                #[cfg(not(windows))]
                let from_helper = !typed;
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
                cache.entries.push(Entry { key, password, expires, touched: time, from_helper });
                #[cfg(windows)]
                saved?;
            }
        }
        // Asked by a configured helper's wrapper before Git's `store` reaches it: "1" only when
        // Revqora itself answered `get` in this Git command with exactly this login, and that
        // login came from a configured helper earlier. Anything a helper answered in this command
        // (a refreshed token, say) reaches every helper's `store`.
        "kept" => {
            let kept = password.is_some_and(|password| {
                let digest: [u8; 32] = Sha256::digest(password.as_bytes()).into();
                !key.username.is_empty()
                    && !request.call.is_empty()
                    && cache.answered.iter().any(|entry| entry.until > time && entry.call == request.call && entry.key == key && *entry.digest == digest)
                    && cache.entries.iter().any(|entry| entry.from_helper && entry.key == key && entry.password.as_bytes() == password.as_bytes())
            });
            if kept {
                return Ok("1".into());
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
/// Answers Git's credential helper protocol for Revqora's own helper. `kept` is not a Git
/// operation: the wrapper around a configured helper asks it before `store` (exit 0 = that
/// helper gave Revqora exactly this login and keeps it; skip the call).
pub(crate) fn run_helper(port: &str, operation: &str) -> i32 {
    if !matches!(operation, "get" | "store" | "erase" | "kept") {
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
    let call = std::env::var(CALL_VAR).unwrap_or_default();
    let request = Request { operation: operation.into(), root, epoch, input, call };
    let kept = operation == "kept";
    match crate::askpass::credential(port, &token, request) {
        Ok(value) if kept => i32::from(value != "1"),
        Err(_) if kept => 1,
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
        let mut cache = Cache { epoch: 0, entries: vec![], pending: vec![], typed: vec![], answered: vec![] };
        let request = |operation: &str, fields: &str| Request {
            operation: operation.into(),
            root: repo.to_string_lossy().into_owned(),
            epoch: 0,
            input: format!("protocol=https\nhost=bitbucket.org\npath=team/repo.git\nusername=git-name\n{fields}\n"),
            call: String::new(),
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

#[cfg(test)]
mod kept_tests {
    use super::*;

    #[test]
    fn only_a_helper_login_revqora_answered_in_the_same_command_counts_as_kept() {
        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path();
        let mut cache = Cache {
            epoch: 0,
            entries: vec![],
            #[cfg(windows)]
            pending: vec![],
            typed: vec![],
            answered: vec![],
        };
        let request = |operation: &str, call: &str, host: &str, fields: &str| Request {
            operation: operation.into(),
            root: repo.to_string_lossy().into_owned(),
            epoch: 0,
            input: format!("protocol=https\nhost={host}\nusername=user\n{fields}\n"),
            call: call.into(),
        };
        let kept = |cache: &mut Cache, call: &str, host: &str, password: &str| {
            handle_in(&request("kept", call, host, &format!("password={password}\n")), cache).unwrap() == "1"
        };
        // Command 1: a configured helper answered; Git approves the login everywhere.
        handle_in(&request("store", "1", "a.invalid", "password=helper-token\n"), &mut cache).unwrap();
        assert!(!kept(&mut cache, "1", "a.invalid", "helper-token"), "Revqora did not answer this command: the helpers must store it");
        // Command 2: Revqora answers with that login, so the helper keeps it already.
        assert!(handle_in(&request("get", "2", "a.invalid", ""), &mut cache).unwrap().contains("password=helper-token\n"));
        assert!(kept(&mut cache, "2", "a.invalid", "helper-token"));
        assert!(!kept(&mut cache, "3", "a.invalid", "helper-token"), "another command did not get Revqora's answer");
        assert!(!kept(&mut cache, "2", "a.invalid", "other-token"), "a changed password must reach the helper");
        assert!(!kept(&mut cache, "2", "b.invalid", "helper-token"), "another host must reach the helper");
        assert!(!kept(&mut cache, "", "a.invalid", "helper-token"));
        // Command 4: the cached login is gone, a helper answers with a refreshed token. Revqora
        // keeps the new token, but every helper must still store it.
        handle_in(&request("store", "4", "a.invalid", "password=refreshed-token\n"), &mut cache).unwrap();
        assert!(!kept(&mut cache, "4", "a.invalid", "refreshed-token"));
        // A login typed into Revqora's prompt was never given by a helper, even when Revqora answers it later.
        note_typed_in(&mut cache, repo, 0, "typed-token");
        handle_in(&request("store", "5", "b.invalid", "password=typed-token\n"), &mut cache).unwrap();
        assert!(handle_in(&request("get", "6", "b.invalid", ""), &mut cache).unwrap().contains("password=typed-token\n"));
        assert!(!kept(&mut cache, "6", "b.invalid", "typed-token"));
        // A prompt of another session (older epoch) is ignored.
        note_typed_in(&mut cache, repo, 7, "old-token");
        assert_eq!(cache.typed.len(), 1);
    }
}
