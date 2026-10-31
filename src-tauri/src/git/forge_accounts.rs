//! Portable API accounts. Git transport still belongs to the user's Git/SSH configuration.
//! Secrets never enter the public snapshot, command line, journal or plaintext settings.
use super::{
    forge, operations, refs,
    runner::{GitError, GitResult},
};
use fs2::FileExt;
use parking_lot::Mutex;
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

const ROUNDS: u32 = 600_000;
const LIMIT: u64 = 4 * 1024 * 1024;
fn fail(s: impl Into<String>) -> GitError {
    GitError::new(s).kind("forge-account")
}
fn stale() -> GitError {
    fail("Account settings changed. Refresh and review the current selection before trying again.").kind("stale-operation")
}
fn digest(v: &[u8]) -> String {
    format!("{:x}", Sha256::digest(v))
}
fn json<T: Serialize>(v: &T) -> GitResult<Vec<u8>> {
    serde_json::to_vec(v).map_err(|_| fail("Could not encode account settings."))
}
fn random<const N: usize>() -> GitResult<[u8; N]> {
    let mut b = [0; N];
    SystemRandom::new().fill(&mut b).map_err(|_| fail("Secure random source unavailable."))?;
    Ok(b)
}
fn valid_text(v: &str, max: usize) -> bool {
    !v.is_empty() && v.len() <= max && !v.chars().any(char::is_control)
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub kind: String,
    pub server: String,
}
impl Server {
    pub fn new(kind: &str, value: &str) -> GitResult<Self> {
        if !["github", "gitlab", "azure", "bitbucket"].contains(&kind) {
            return Err(fail("Choose GitHub, GitLab, Azure DevOps or Bitbucket Cloud."));
        }
        let mut u = Url::parse(value.trim()).map_err(|_| fail("Enter a complete HTTPS server URL."))?;
        let local_http = u.scheme() == "http"
            && match u.host() {
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                _ => false,
            };
        if u.scheme() != "https" && !local_http
            || u.host_str().is_none()
            || !u.username().is_empty()
            || u.password().is_some()
            || u.query().is_some()
            || u.fragment().is_some()
        {
            return Err(fail(
                "Use HTTPS without embedded credentials, query parameters or fragments. HTTP is allowed only on literal loopback IPs for local services.",
            ));
        }
        if kind == "bitbucket" && u.host_str() != Some("bitbucket.org") && !local_http {
            return Err(fail("Managed Bitbucket accounts use https://bitbucket.org."));
        }
        if let Some(h) = u.host_str().and_then(|h| h.strip_suffix(".visualstudio.com")) {
            if kind == "azure" {
                u = Url::parse(&format!("https://dev.azure.com/{h}")).map_err(|_| fail("Invalid Azure organization."))?;
            }
        }
        if kind == "azure" && u.host_str() == Some("dev.azure.com") && u.path().trim_matches('/').split('/').filter(|s| !s.is_empty()).count() != 1 {
            return Err(fail("Include the Azure organization: https://dev.azure.com/organization."));
        }
        let server = u.as_str().trim_end_matches('/').to_owned();
        if server.len() > 2048 {
            return Err(fail("Server URL is too long."));
        }
        Ok(Self { kind: kind.into(), server })
    }
    pub fn api(&self) -> String {
        match (self.kind.as_str(), self.server.as_str()) {
            ("github", "https://github.com") => "https://api.github.com".into(),
            ("github", _) => format!("{}/api/v3", self.server),
            ("gitlab", _) => format!("{}/api/v4", self.server),
            ("bitbucket", "https://bitbucket.org") => "https://api.bitbucket.org/2.0".into(),
            ("bitbucket", _) => format!("{}/2.0", self.server),
            _ => self.server.clone(),
        }
    }
    fn identity_path(&self) -> &'static str {
        if self.kind == "azure" {
            "/_apis/connectionData?api-version=7.1-preview.1"
        } else {
            "/user"
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    #[serde(flatten)]
    pub server: Server,
    pub login: String,
    pub user_id: String,
    pub name: String,
    pub auth_mode: String,
    pub auth_username: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Sealed {
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    profile: Profile,
    sealed: Option<Sealed>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Vault {
    salt: Vec<u8>,
    rounds: u32,
    check: Sealed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    #[serde(default)]
    allow_ssh_alias: bool,
    repository: String,
    remote: String,
    fingerprint: String,
    account_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Active {
    repository: String,
    remote: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    accounts: Vec<Record>,
    vault: Option<Vault>,
    bindings: Vec<Binding>,
    active: Vec<Active>,
}
impl Default for Document {
    fn default() -> Self {
        Self { version: 1, accounts: vec![], vault: None, bindings: vec![], active: vec![] }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Credential {
    pub username: String,
    pub token: String,
    pub mode: String,
}
impl Drop for Credential {
    fn drop(&mut self) {
        self.username.zeroize();
        self.token.zeroize();
    }
}
#[derive(Clone, Default)]
struct Memory {
    key: Option<Zeroizing<[u8; 32]>>,
    stamp: Option<String>,
    sessions: HashMap<String, (String, Credential)>,
    epoch: u64,
}
fn key(password: &str, v: &Vault) -> GitResult<Zeroizing<[u8; 32]>> {
    if v.salt.len() != 32 || v.rounds != ROUNDS {
        return Err(fail("Unsupported vault key parameters."));
    }
    let mut k = Zeroizing::new([0; 32]);
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, NonZeroU32::new(ROUNDS).unwrap(), &v.salt, password.as_bytes(), k.as_mut());
    Ok(k)
}
fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> GitResult<Sealed> {
    let nonce = random::<12>()?;
    let mut data = plain.to_vec();
    aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| fail("Invalid encryption key."))?)
        .seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad), &mut data)
        .map_err(|_| fail("Could not encrypt account token."))?;
    Ok(Sealed { nonce: nonce.to_vec(), ciphertext: data })
}
fn unseal(key: &[u8; 32], aad: &[u8], v: &Sealed) -> GitResult<Zeroizing<Vec<u8>>> {
    let nonce: [u8; 12] = v.nonce.as_slice().try_into().map_err(|_| fail("Invalid encrypted token."))?;
    let mut data = Zeroizing::new(v.ciphertext.clone());
    let len = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| fail("Invalid encryption key."))?)
        .open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad), data.as_mut())
        .map_err(|_| fail("Incorrect vault password or damaged account data."))?
        .len();
    data.truncate(len);
    Ok(data)
}
fn aad(p: &Profile) -> GitResult<Vec<u8>> {
    let mut b = b"Revqora account v1\0".to_vec();
    b.extend(json(p)?);
    Ok(b)
}
fn stamp(d: &Document) -> GitResult<Option<String>> {
    d.vault.as_ref().map(|v| json(v).map(|b| digest(&b))).transpose()
}
fn sync_memory(d: &Document, m: &mut Memory) -> GitResult<()> {
    if m.stamp != stamp(d)? {
        m.key = None;
        m.stamp = stamp(d)?;
        m.epoch += 1;
    }
    m.sessions.retain(|id, (sig, _)| d.accounts.iter().any(|r| r.profile.id == *id && r.sealed.is_none() && aad(&r.profile).is_ok_and(|a| digest(&a) == *sig)));
    Ok(())
}
fn revision(d: &Document, m: &Memory) -> GitResult<String> {
    let mut b = json(d)?;
    b.extend(m.epoch.to_le_bytes());
    Ok(digest(&b))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    #[serde(flatten)]
    pub profile: Profile,
    pub storage: String,
    pub status: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: String,
    pub accounts: Vec<AccountView>,
    pub vault_configured: bool,
    pub vault_unlocked: bool,
}
fn validate_document(d: &Document) -> GitResult<()> {
    if d.version != 1 || d.accounts.len() > 50 || d.bindings.len() > 2000 || d.active.len() > 1000 {
        return Err(fail("Unsupported account settings or account/connection limit reached."));
    }
    let mut ids = std::collections::HashSet::new();
    for r in &d.accounts {
        let p = &r.profile;
        if !ids.insert(&p.id)
            || !valid_text(&p.id, 24)
            || !valid_text(&p.login, 256)
            || !valid_text(&p.user_id, 256)
            || p.name.len() > 512
            || p.auth_username.len() > 254
            || Server::new(&p.server.kind, &p.server.server)? != p.server
            || !["token", "basic", "bearer"].contains(&p.auth_mode.as_str())
        {
            return Err(fail("Invalid account metadata."));
        }
        if let Some(v) = &r.sealed {
            if d.vault.is_none() || v.nonce.len() != 12 || v.ciphertext.len() < 16 || v.ciphertext.len() > 8192 {
                return Err(fail("Invalid encrypted token record."));
            }
        }
    }
    let mut bindings = std::collections::HashSet::new();
    for b in &d.bindings {
        if !bindings.insert((&b.repository, &b.remote)) || !valid_text(&b.repository, 128) || !valid_text(&b.remote, 1024) || b.fingerprint.len() != 64 {
            return Err(fail("Invalid or duplicate repository API binding."));
        }
    }
    let mut active = std::collections::HashSet::new();
    for a in &d.active {
        if !active.insert(&a.repository) || !valid_text(&a.repository, 128) || !valid_text(&a.remote, 1024) {
            return Err(fail("Invalid active API remote."));
        }
    }
    Ok(())
}

pub struct Manager {
    root: PathBuf,
    memory: Mutex<Memory>,
}
impl Manager {
    pub fn new(root: PathBuf) -> Self {
        Self { root, memory: Mutex::new(Memory::default()) }
    }
    fn read(&self) -> GitResult<Document> {
        let path = self.root.join("accounts.json");
        let mut bytes = Vec::new();
        match fs::File::open(path) {
            Ok(f) => {
                f.take(LIMIT + 1).read_to_end(&mut bytes)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Document::default()),
            Err(e) => return Err(e.into()),
        }
        if bytes.len() as u64 > LIMIT {
            return Err(fail("Account settings exceed the size limit."));
        }
        let d: Document = serde_json::from_slice(&bytes).map_err(|_| fail("Account settings are damaged. They were kept without overwriting them."))?;
        validate_document(&d)?;
        Ok(d)
    }
    fn edit(&self, expected: &str, f: impl FnOnce(&mut Document, &mut Memory) -> GitResult<()>) -> GitResult<()> {
        fs::create_dir_all(&self.root)?;
        let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(self.root.join("accounts.lock"))?;
        lock.lock_exclusive()?;
        let mut current = self.memory.lock();
        let mut doc = self.read()?;
        sync_memory(&doc, &mut current)?;
        if expected != revision(&doc, &current)? {
            return Err(stale());
        }
        let mut next = current.clone();
        f(&mut doc, &mut next)?;
        next.epoch += 1;
        validate_document(&doc)?;
        let bytes = json(&doc)?;
        if bytes.len() as u64 > LIMIT {
            return Err(fail("Account settings exceed the size limit."));
        }
        let mut temp = tempfile::NamedTempFile::new_in(&self.root)?;
        temp.write_all(&bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(self.root.join("accounts.json")).map_err(|_| fail("Could not save account settings. Previous settings were kept."))?;
        next.stamp = stamp(&doc)?;
        *current = next;
        Ok(())
    }
    pub fn snapshot(&self) -> GitResult<Snapshot> {
        let mut m = self.memory.lock();
        let d = self.read()?;
        sync_memory(&d, &mut m)?;
        Ok(Snapshot {
            revision: revision(&d, &m)?,
            vault_configured: d.vault.is_some(),
            vault_unlocked: m.key.is_some(),
            accounts: d
                .accounts
                .iter()
                .map(|r| AccountView {
                    profile: r.profile.clone(),
                    storage: if r.sealed.is_some() { "encrypted" } else { "session" }.into(),
                    status: if r.sealed.is_some() {
                        if m.key.is_some() {
                            "available"
                        } else {
                            "locked"
                        }
                    } else if m.sessions.contains_key(&r.profile.id) {
                        "available"
                    } else {
                        "reconnect"
                    }
                    .into(),
                })
                .collect(),
        })
    }
    pub fn lock(&self) -> GitResult<Snapshot> {
        let mut m = self.memory.lock();
        m.key = None;
        m.sessions.clear();
        m.epoch += 1;
        drop(m);
        self.snapshot()
    }
    pub fn vault(&self, password: String, expected: &str, unlock: bool) -> GitResult<Snapshot> {
        let password = Zeroizing::new(password);
        self.edit(expected, |d, m| {
            if unlock {
                let v = d.vault.as_ref().ok_or_else(|| fail("Create a vault password first."))?;
                let k = key(&password, v)?;
                if unseal(&k, b"Revqora vault v1", &v.check)?.as_slice() != b"account vault" {
                    return Err(fail("Damaged vault."));
                }
                for r in &d.accounts {
                    if let Some(s) = &r.sealed {
                        let _: Credential = serde_json::from_slice(&unseal(&k, &aad(&r.profile)?, s)?).map_err(|_| fail("Damaged saved account."))?;
                    }
                }
                m.key = Some(k);
            } else {
                if password.chars().count() < 12 || password.len() > 1024 {
                    return Err(fail("Choose a vault password of 12–1024 characters."));
                }
                let old = d
                    .accounts
                    .iter()
                    .filter_map(|r| r.sealed.as_ref().map(|_| r))
                    .map(|r| credential(d, m, &r.profile.id).map(|c| (r.profile.id.clone(), c)))
                    .collect::<GitResult<HashMap<_, _>>>()?;
                if d.vault.is_some() && m.key.is_none() {
                    return Err(fail("Unlock the existing vault before changing its password."));
                }
                let mut v = Vault { salt: random::<32>()?.to_vec(), rounds: ROUNDS, check: Sealed { nonce: vec![], ciphertext: vec![] } };
                let k = key(&password, &v)?;
                v.check = seal(&k, b"Revqora vault v1", b"account vault")?;
                for r in &mut d.accounts {
                    if let Some(c) = old.get(&r.profile.id) {
                        r.sealed = Some(seal(&k, &aad(&r.profile)?, &Zeroizing::new(json(c)?))?);
                    }
                }
                d.vault = Some(v);
                m.key = Some(k);
            }
            Ok(())
        })?;
        self.snapshot()
    }
    pub fn reset_vault(&self, expected: &str) -> GitResult<Snapshot> {
        self.edit(expected, |d, m| {
            d.vault = None;
            for r in &mut d.accounts {
                r.sealed = None;
            }
            m.key = None;
            m.sessions.clear();
            Ok(())
        })?;
        self.snapshot()
    }
    pub fn add(&self, input: Add, expected: &str) -> GitResult<Snapshot> {
        let c = Credential { username: input.username.clone(), token: input.token, mode: input.auth_mode.clone() };
        if !valid_text(&c.token, 4096) || c.token.len() < 8 || c.token.chars().any(char::is_whitespace) {
            return Err(fail("Enter a token without whitespace (8–4096 bytes)."));
        }
        let server = Server::new(&input.kind, &input.server)?;
        if !["token", "basic", "bearer"].contains(&c.mode.as_str()) || server.kind == "bitbucket" && c.mode == "basic" && !valid_text(&c.username, 254) {
            return Err(fail("Bitbucket API tokens require your Atlassian email address."));
        }
        let identity = verify(&server, &c)?;
        self.edit(expected, |d, m| {
            let id = if let Some(id) = &input.id {
                let old = d.accounts.iter().find(|r| r.profile.id == *id).ok_or_else(|| fail("Account was removed. Refresh first."))?;
                if old.profile.server != server || old.profile.user_id != identity.user_id {
                    return Err(fail("This token belongs to a different account. Add it separately."));
                }
                id.clone()
            } else {
                if d.accounts.len() >= 50 {
                    return Err(fail("At most 50 accounts can be saved."));
                }
                if d.accounts.iter().any(|r| r.profile.server == server && r.profile.user_id == identity.user_id) {
                    return Err(fail("This account already exists. Use Reconnect to replace its token."));
                }
                digest(&random::<32>()?)[..24].to_owned()
            };
            let profile = Profile {
                id: id.clone(),
                server: server.clone(),
                login: identity.login,
                name: identity.name,
                user_id: identity.user_id,
                auth_mode: c.mode.clone(),
                auth_username: c.username.clone(),
            };
            if String::from_utf8_lossy(&json(&profile)?).contains(&c.token) {
                return Err(fail("Server returned token material as identity metadata; account was not saved."));
            }
            let sealed = if input.persist {
                let k = m.key.as_ref().ok_or_else(|| fail("Create or unlock the vault before saving a token."))?;
                Some(seal(k, &aad(&profile)?, &Zeroizing::new(json(&c)?))?)
            } else {
                None
            };
            d.accounts.retain(|r| r.profile.id != id);
            d.accounts.push(Record { profile: profile.clone(), sealed });
            m.sessions.remove(&id);
            if !input.persist {
                m.sessions.insert(id, (digest(&aad(&profile)?), c.clone()));
            }
            Ok(())
        })?;
        self.snapshot()
    }
    pub fn remove(&self, id: &str, expected: &str) -> GitResult<Snapshot> {
        self.edit(expected, |d, m| {
            if !d.accounts.iter().any(|r| r.profile.id == id) {
                return Err(stale());
            }
            d.accounts.retain(|r| r.profile.id != id);
            m.sessions.remove(id);
            Ok(())
        })?;
        self.snapshot()
    }
    pub fn test(&self, id: &str) -> GitResult<String> {
        let (p, c) = self.account(id)?;
        let i = verify(&p.server, &c)?;
        if i.user_id != p.user_id {
            return Err(fail("The server identity changed. Reconnect and review this account."));
        }
        Ok(i.login)
    }
    fn account(&self, id: &str) -> GitResult<(Profile, Credential)> {
        let mut m = self.memory.lock();
        let d = self.read()?;
        sync_memory(&d, &mut m)?;
        let r = d.accounts.iter().find(|r| r.profile.id == id).ok_or_else(|| fail("Selected API account was removed. Choose an account explicitly."))?;
        Ok((r.profile.clone(), credential(&d, &m, id)?))
    }
}
fn credential(d: &Document, m: &Memory, id: &str) -> GitResult<Credential> {
    let r = d.accounts.iter().find(|r| r.profile.id == id).ok_or_else(|| fail("Selected account no longer exists."))?;
    if let Some(s) = &r.sealed {
        let k = m.key.as_ref().ok_or_else(|| fail("Unlock the account vault before using this API account.").kind("auth"))?;
        serde_json::from_slice(&unseal(k, &aad(&r.profile)?, s)?).map_err(|_| fail("Invalid encrypted account."))
    } else {
        m.sessions
            .get(id)
            .map(|(_, c)| c.clone())
            .ok_or_else(|| fail("This session token expired. Reconnect this account; no other account was substituted.").kind("auth"))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Add {
    pub id: Option<String>,
    pub kind: String,
    pub server: String,
    pub username: String,
    pub token: String,
    pub auth_mode: String,
    pub persist: bool,
}
struct Identity {
    login: String,
    user_id: String,
    name: String,
}
fn verify(server: &Server, c: &Credential) -> GitResult<Identity> {
    let v = request_json(&server.kind, &server.api(), c, "GET", server.identity_path(), None)?;
    let text = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or("").to_owned();
    let (login, id, name) = match server.kind.as_str() {
        "github" => (text("/login"), v.get("id").and_then(Value::as_u64).map(|n| n.to_string()).unwrap_or_default(), text("/name")),
        "gitlab" => (text("/username"), v.get("id").filter(|x| x.is_number()).map(Value::to_string).unwrap_or_default(), text("/name")),
        "bitbucket" => (Some(text("/nickname")).filter(|s| !s.is_empty()).unwrap_or_else(|| text("/display_name")), text("/uuid"), text("/display_name")),
        _ => {
            let id = text("/authenticatedUser/id");
            let name = text("/authenticatedUser/providerDisplayName");
            let login = Some(text("/authenticatedUser/properties/Account/$value")).filter(|s| !s.is_empty()).unwrap_or_else(|| name.clone());
            (login, id, name)
        }
    };
    if !valid_text(&login, 256)
        || !valid_text(&id, 256)
        || id == "0"
        || id == "00000000-0000-0000-0000-000000000000"
        || server.kind == "azure" && (id.eq_ignore_ascii_case("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") || login.eq_ignore_ascii_case("anonymous"))
        || name.len() > 512
        || name.chars().any(char::is_control)
    {
        return Err(fail("The server did not return a valid authenticated user identity."));
    }
    Ok(Identity { login, user_id: id, name })
}
pub fn request_json(kind: &str, base: &str, c: &Credential, method: &str, path: &str, body: Option<Value>) -> GitResult<Value> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['\r', '\n', '\\']) {
        return Err(fail("Invalid API request path."));
    }
    let target = format!("{base}{path}");
    let local = Url::parse(base).ok().is_some_and(|u| match u.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    });
    let agent = ureq::AgentBuilder::new().try_proxy_from_env(!local).redirects(0).timeout(Duration::from_secs(20)).user_agent("Revqora").build();
    let mut req = agent.request(method, &target);
    if kind == "gitlab" && c.mode != "bearer" {
        req = req.set("PRIVATE-TOKEN", &c.token);
    } else {
        let auth = Zeroizing::new(if kind == "azure" || kind == "bitbucket" && c.mode == "basic" || kind == "bitbucket-server" && c.mode == "basic" {
            format!("Basic {}", forge::base64(format!("{}:{}", c.username, c.token).as_bytes()))
        } else {
            format!("Bearer {}", c.token)
        });
        req = req.set("Authorization", &auth);
    }
    if kind == "github" {
        req = req.set("Accept", "application/vnd.github+json").set("X-GitHub-Api-Version", "2022-11-28");
    }
    let response = match body {
        Some(v) => req.send_json(v),
        None => req.call(),
    };
    let response = match response {
        Ok(r) if (200..300).contains(&r.status()) => r,
        Ok(r) => return Err(fail(format!("API returned {}. Redirects are not followed with credentials.", r.status()))),
        Err(ureq::Error::Status(code, r))
            if code == 429
                || code == 403 && (r.header("x-ratelimit-remaining") == Some("0") || r.header("retry-after").and_then(|s| s.parse::<u64>().ok()).is_some()) =>
        {
            return Err(fail("API rate limit reached. Wait before trying again.").kind("forge-rate-limit"))
        }
        Err(ureq::Error::Status(code, _)) => {
            return Err(fail(match code {
                401 => "Token rejected. Reconnect this account.".into(),
                403 => "Access denied. Check token permissions and organization SSO authorization.".into(),
                429 => "API rate limit reached. Wait and try again.".into(),
                _ => format!("API request failed with HTTP {code}."),
            })
            .kind(if code == 401 || code == 403 { "auth" } else { "forge-http" }))
        }
        Err(_) => return Err(fail("API connection failed. Check the server URL, network, proxy and TLS certificate.").kind("forge-network")),
    };
    let mut bytes = Zeroizing::new(Vec::new());
    response.into_reader().take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| fail("Could not read the API response."))?;
    if bytes.len() as u64 > LIMIT {
        return Err(fail("API response exceeds 4 MiB."));
    }
    serde_json::from_slice(&bytes).map_err(|_| fail("The server returned an invalid JSON response."))
}

static MANAGER: OnceLock<Manager> = OnceLock::new();
pub fn manager() -> GitResult<&'static Manager> {
    if let Some(m) = MANAGER.get() {
        return Ok(m);
    }
    let root = crate::portable::runtime_dir()?.join("accounts");
    let _ = MANAGER.set(Manager::new(root));
    Ok(MANAGER.get().unwrap())
}
fn repository(root: &Path) -> String {
    digest(operations::repository_key(root).as_os_str().as_encoded_bytes())
}
fn fingerprint(value: &str) -> String {
    digest(value.as_bytes())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteView {
    pub is_ssh: bool,
    pub allow_ssh_alias: bool,
    pub name: String,
    pub host: String,
    pub project: String,
    pub fingerprint: String,
    pub account_id: Option<String>,
    pub forge: Option<forge::ForgeInfo>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connections {
    pub revision: String,
    pub active_remote: Option<String>,
    pub remotes: Vec<RemoteView>,
}
fn info_for_profile(p: &Profile, url: &str, remote: &str, allow_ssh_alias: bool) -> GitResult<forge::ForgeInfo> {
    let (_, mut project) = forge::parse_remote(url).ok_or_else(|| fail("The remote is not a supported network URL."))?;
    let server = &p.server;
    let base = url::Url::parse(&server.server).map_err(|_| fail("Invalid API server."))?;
    let source = url::Url::parse(url).ok();
    if server.kind != "azure" {
        if let Some(source) = source.as_ref().filter(|u| u.scheme() == "http" || u.scheme() == "https") {
            if source.origin() != base.origin() {
                return Err(fail("The API account server does not match this HTTPS remote. Choose an account for that server."));
            }
        } else {
            let (host, _) = forge::parse_remote(url).ok_or_else(|| fail("Invalid SSH remote."))?;
            if host != base.host_str().unwrap_or("") && !allow_ssh_alias {
                return Err(fail("The SSH host differs from the API server. Confirm the SSH alias mapping explicitly, or choose a matching account."));
            }
        }
    }
    let prefix = Url::parse(&server.server).map_err(|_| fail("Invalid API server."))?.path().trim_matches('/').to_owned();
    if server.kind == "azure" {
        project = forge::azure_project(url, &server.server).ok_or_else(|| fail("Azure remote does not match this organization or collection."))?;
    } else if !prefix.is_empty() {
        project = project.strip_prefix(&format!("{prefix}/")).ok_or_else(|| fail("The remote is outside this server's URL prefix."))?.into();
    }
    let count = project.split('/').count();
    if count < 2 || server.kind != "gitlab" && count != 2 {
        return Err(fail("The repository path does not match this provider."));
    }
    let web_url = if server.kind == "azure" {
        let (p, r) = project.split_once('/').unwrap();
        format!("{}/{}/_git/{}", server.server, forge::enc(p), forge::enc(r))
    } else {
        format!("{}/{}", server.server, project.split('/').map(forge::enc).collect::<Vec<_>>().join("/"))
    };
    let u = Url::parse(&server.server).unwrap();
    let host = u.port().map(|p| format!("{}:{p}", u.host_str().unwrap())).unwrap_or_else(|| u.host_str().unwrap().into());
    Ok(forge::ForgeInfo {
        kind: server.kind.clone(),
        host,
        project,
        remote: remote.into(),
        web_url,
        api: server.api(),
        connection_revision: None,
        account_login: Some(p.login.clone()),
    })
}
pub struct Context {
    pub info: forge::ForgeInfo,
    pub credential: Option<Credential>,
    pub git_url: String,
}
fn resolve(d: &Document, m: &Memory, repository: &str, r: &refs::RemoteInfo) -> GitResult<Option<Context>> {
    if let Some(b) = d.bindings.iter().find(|b| b.repository == repository && b.remote == r.name) {
        if b.fingerprint != fingerprint(&r.fetch_url) {
            return Err(fail("The remote URL changed. Review and select its API account again; no credentials were sent."));
        }
        if let Some(id) = &b.account_id {
            let record =
                d.accounts.iter().find(|a| a.profile.id == *id).ok_or_else(|| fail("The selected API account was removed. Choose an account explicitly."))?;
            return Ok(Some(Context {
                info: info_for_profile(&record.profile, &r.fetch_url, &r.name, b.allow_ssh_alias)?,
                credential: Some(credential(d, m, id)?),
                git_url: r.fetch_url.clone(),
            }));
        }
    }
    Ok(forge::forge_for(&r.fetch_url, &r.name).map(|info| Context { info, credential: None, git_url: r.fetch_url.clone() }))
}
pub fn context(root: &Path) -> GitResult<Option<Context>> {
    context_from(manager()?, root)
}
fn context_from(manager: &Manager, root: &Path) -> GitResult<Option<Context>> {
    let repo = repository(root);
    let remotes = refs::remotes(root)?;
    let mut m = manager.memory.lock();
    let d = manager.read()?;
    sync_memory(&d, &mut m)?;
    let active = d.active.iter().find(|a| a.repository == repo).map(|a| a.remote.as_str());
    let r = if let Some(active) = active {
        Some(remotes.iter().find(|r| r.name == active).ok_or_else(|| fail("The selected API remote was removed. Choose another remote."))?)
    } else {
        remotes.iter().find(|r| r.name == "origin").or_else(|| remotes.first())
    };
    let mut context = r.map(|r| resolve(&d, &m, &repo, r)).transpose()?.flatten();
    if let Some(c) = context.as_mut() {
        let proof = format!("{}\0{}\0{}\0{}", revision(&d, &m)?, repo, c.git_url, c.info.remote);
        c.info.connection_revision = Some(digest(proof.as_bytes()));
    }
    Ok(context)
}
pub fn connections(root: &Path) -> GitResult<Connections> {
    let manager = manager()?;
    let repo = repository(root);
    let remotes = refs::remotes(root)?;
    let mut m = manager.memory.lock();
    let d = manager.read()?;
    sync_memory(&d, &mut m)?;
    let active = d
        .active
        .iter()
        .find(|a| a.repository == repo)
        .map(|a| a.remote.clone())
        .or_else(|| remotes.iter().find(|r| r.name == "origin").or_else(|| remotes.first()).map(|r| r.name.clone()));
    let rows = remotes
        .iter()
        .map(|r| {
            let parsed = forge::parse_remote(&r.fetch_url).unwrap_or_default();
            let binding = d.bindings.iter().find(|b| b.repository == repo && b.remote == r.name);
            let resolved = resolve(&d, &m, &repo, r);
            let (forge, error) = match resolved {
                Ok(c) => (c.map(|c| c.info), None),
                Err(e) => (None, Some(e.message)),
            };
            RemoteView {
                is_ssh: url::Url::parse(&r.fetch_url).is_ok_and(|u| u.scheme() == "ssh")
                    || (!r.fetch_url.contains("://") && forge::parse_remote(&r.fetch_url).is_some()),
                allow_ssh_alias: binding.is_some_and(|b| b.allow_ssh_alias),
                name: r.name.clone(),
                host: parsed.0,
                project: parsed.1,
                fingerprint: fingerprint(&r.fetch_url),
                account_id: binding.and_then(|b| b.account_id.clone()),
                forge,
                error,
            }
        })
        .collect();
    Ok(Connections { revision: revision(&d, &m)?, active_remote: active, remotes: rows })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    #[serde(default)]
    pub allow_ssh_alias: bool,
    pub remote: String,
    pub fingerprint: String,
    pub account_id: Option<String>,
}
pub fn select(root: &Path, s: Selection, expected: &str) -> GitResult<Connections> {
    operations::read(root, || {
        let r = refs::remotes(root)?.into_iter().find(|r| r.name == s.remote).ok_or_else(stale)?;
        if fingerprint(&r.fetch_url) != s.fingerprint {
            return Err(stale());
        }
        let repo = repository(root);
        let manager = manager()?;
        manager.edit(expected, |d, m| {
            if let Some(id) = &s.account_id {
                let p = d.accounts.iter().find(|a| a.profile.id == *id).ok_or_else(stale)?;
                info_for_profile(&p.profile, &r.fetch_url, &r.name, s.allow_ssh_alias)?;
                credential(d, m, id)?;
            }
            d.bindings.retain(|b| b.repository != repo || b.remote != r.name);
            d.bindings.push(Binding {
                repository: repo.clone(),
                remote: r.name.clone(),
                fingerprint: s.fingerprint,
                account_id: s.account_id,
                allow_ssh_alias: s.allow_ssh_alias,
            });
            d.active.retain(|a| a.repository != repo);
            d.active.push(Active { repository: repo, remote: r.name });
            Ok(())
        })?;
        connections(root)
    })
}

#[cfg(test)]
#[path = "forge_accounts_tests.rs"]
mod tests;
