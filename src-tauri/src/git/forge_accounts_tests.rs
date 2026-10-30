use super::*;
use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};

type Requests = Arc<Mutex<Vec<(String, String)>>>;
struct Http {
    url: String,
    seen: Requests,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Http {
    fn new(response: impl Fn(&str, &str) -> String + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let seen = Arc::new(Mutex::new(vec![]));
        let capture = seen.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let handle = thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        let mut line = String::new();
                        if reader.read_line(&mut line).is_err() {
                            continue;
                        }
                        let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                        let mut auth = String::new();
                        loop {
                            line.clear();
                            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                                break;
                            }
                            let lower = line.to_lowercase();
                            if lower.starts_with("authorization:") || lower.starts_with("private-token:") {
                                auth = line.split_once(':').unwrap().1.trim().into();
                            }
                        }
                        capture.lock().push((path.clone(), auth.clone()));
                        let reply = response(&path, &auth);
                        let _ = stream.write_all(reply.as_bytes());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
                    Err(_) => break,
                }
            }
        });
        Self { url, seen, stop, thread: Some(handle) }
    }
    fn identities() -> Self {
        Self::new(|_, auth| {
            let b = auth.contains("token-two") || auth.contains(&forge::base64(b"mail@example.invalid:token-two"));
            let login = if b { "second" } else { "first" };
            response(200,&serde_json::json!({"id":if b{2}else{1},"login":login,"username":login,"name":"Test Person","nickname":login,"display_name":"Test Person","uuid":format!("uuid-{login}"),"authenticatedUser":{"id":format!("id-{login}"),"providerDisplayName":login,"properties":{"Account":{"$value":login}}}}).to_string())
        })
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn response(code: u16, body: &str) -> String {
    format!("HTTP/1.1 {code} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}
fn input(server: &Http, kind: &str, token: &str, persist: bool) -> Add {
    Add {
        id: None,
        kind: kind.into(),
        server: server.url.clone(),
        username: if kind == "bitbucket" { "mail@example.invalid" } else { "" }.into(),
        token: token.into(),
        auth_mode: if kind == "bitbucket" { "basic" } else { "token" }.into(),
        persist,
    }
}
fn manager_temp() -> (tempfile::TempDir, Manager) {
    let t = tempfile::tempdir().unwrap();
    let manager = Manager::new(t.path().join("portable/accounts"));
    (t, manager)
}
fn add(m: &Manager, h: &Http, kind: &str, token: &str, persist: bool) -> Snapshot {
    m.add(input(h, kind, token, persist), &m.snapshot().unwrap().revision).unwrap()
}

#[test]
fn multiple_accounts_use_provider_auth_and_never_return_or_persist_session_tokens() {
    let (_t, m) = manager_temp();
    let h = Http::identities();
    for kind in ["github", "gitlab", "azure", "bitbucket"] {
        let s = add(&m, &h, kind, "token-one", false);
        assert_eq!(s.accounts.last().unwrap().profile.login, "first");
    }
    let s = add(&m, &h, "github", "token-two", false);
    assert_eq!(s.accounts.len(), 5);
    assert_eq!(s.accounts.last().unwrap().profile.login, "second");
    let snapshot = String::from_utf8(json(&s).unwrap()).unwrap();
    let disk = fs::read_to_string(m.root.join("accounts.json")).unwrap();
    for token in ["token-one", "token-two"] {
        assert!(!snapshot.contains(token));
        assert!(!disk.contains(token));
    }
    let auths = h.seen.lock();
    assert!(auths.iter().any(|(p, a)| p.starts_with("/api/v4/user") && a == "token-one"));
    assert!(auths.iter().any(|(p, a)| p.starts_with("/_apis/") && a == &format!("Basic {}", forge::base64(b":token-one"))));
    assert!(auths.iter().any(|(p, a)| p.starts_with("/2.0/user") && a == &format!("Basic {}", forge::base64(b"mail@example.invalid:token-one"))));
    let restarted = Manager::new(m.root.clone());
    assert!(restarted.snapshot().unwrap().accounts.iter().all(|a| a.status == "reconnect"));
    assert!(restarted.account(&s.accounts[0].profile.id).is_err());
}

#[test]
fn vault_encrypts_restarts_locked_rejects_wrong_password_rotates_and_authenticates_metadata() {
    let (_t, m) = manager_temp();
    let h = Http::identities();
    let password = "correct horse portable vault";
    let s = m.vault(password.into(), &m.snapshot().unwrap().revision, false).unwrap();
    assert!(s.vault_unlocked);
    let s = add(&m, &h, "github", "token-one", true);
    let id = &s.accounts[0].profile.id;
    let disk = fs::read(m.root.join("accounts.json")).unwrap();
    assert!(!String::from_utf8_lossy(&disk).contains("token-one"));
    assert!(!String::from_utf8_lossy(&disk).contains(password));
    let restarted = Manager::new(m.root.clone());
    let s = restarted.snapshot().unwrap();
    assert_eq!(s.accounts[0].status, "locked");
    assert!(restarted.account(id).is_err());
    assert!(restarted.vault("incorrect password".into(), &s.revision, true).is_err());
    assert_eq!(fs::read(m.root.join("accounts.json")).unwrap(), disk);
    let s = restarted.vault(password.into(), &s.revision, true).unwrap();
    assert_eq!(restarted.test(id).unwrap(), "first");
    let s = restarted.vault("new portable vault password".into(), &s.revision, false).unwrap();
    restarted.lock().unwrap();
    assert!(restarted.vault(password.into(), &restarted.snapshot().unwrap().revision, true).is_err());
    restarted.vault("new portable vault password".into(), &restarted.snapshot().unwrap().revision, true).unwrap();
    assert_eq!(restarted.test(id).unwrap(), "first");
    assert_eq!(s.accounts.len(), 1);
    let mut doc: Value = serde_json::from_slice(&fs::read(m.root.join("accounts.json")).unwrap()).unwrap();
    doc["accounts"][0]["profile"]["server"] = "https://attacker.invalid".into();
    fs::write(m.root.join("accounts.json"), serde_json::to_vec(&doc).unwrap()).unwrap();
    let tampered = Manager::new(m.root.clone());
    assert!(tampered.vault("new portable vault password".into(), &tampered.snapshot().unwrap().revision, true).is_err());
    assert!(tampered.account(id).is_err());
}

#[test]
fn explicit_selection_never_substitutes_another_account_after_lock_restart_removal_or_url_change() {
    let (_t, m) = manager_temp();
    let h = Http::identities();
    let s = add(&m, &h, "github", "token-one", false);
    let first = s.accounts[0].profile.id.clone();
    let s = add(&m, &h, "github", "token-two", false);
    let second = &s.accounts[1].profile.id;
    let remote = refs::RemoteInfo { name: "origin".into(), fetch_url: format!("{}/team/repo.git", h.url), push_url: String::new() };
    let mut d = m.read().unwrap();
    d.bindings.push(Binding {
        allow_ssh_alias: false,
        repository: "repo-key".into(),
        remote: "origin".into(),
        fingerprint: fingerprint(&remote.fetch_url),
        account_id: Some(second.clone()),
    });
    let c = resolve(&d, &m.memory.lock(), "repo-key", &remote).unwrap().unwrap();
    let c = c.credential.unwrap();
    assert_eq!(c.token, "token-two");
    assert_eq!(c.mode, "token");
    let mut edited = remote.clone();
    edited.fetch_url.push_str("-changed");
    assert!(resolve(&d, &m.memory.lock(), "repo-key", &edited).is_err());
    m.lock().unwrap();
    assert!(resolve(&d, &m.memory.lock(), "repo-key", &remote).is_err());
    d.accounts.retain(|r| r.profile.id != *second);
    assert!(resolve(&d, &m.memory.lock(), "repo-key", &remote).is_err());
    assert!(d.accounts.iter().any(|r| r.profile.id == first));
}

#[test]
fn reconnect_cannot_replace_a_different_identity_and_stale_requests_do_not_overwrite_new_settings() {
    let (_t, m) = manager_temp();
    let h = Http::identities();
    let s = add(&m, &h, "github", "token-one", false);
    let old = s.revision;
    let id = s.accounts[0].profile.id.clone();
    let mut other = input(&h, "github", "token-two", false);
    other.id = Some(id.clone());
    assert!(m.add(other, &old).is_err());
    assert_eq!(m.test(&id).unwrap(), "first");
    add(&m, &h, "gitlab", "token-one", false);
    assert!(m.remove(&id, &old).is_err());
    assert_eq!(m.snapshot().unwrap().accounts.len(), 2);
    let mut replacement = input(&h, "github", "token-one", false);
    replacement.id = Some(id.clone());
    m.add(replacement, &m.snapshot().unwrap().revision).unwrap();
    assert_eq!(m.snapshot().unwrap().accounts.len(), 2);
}

#[test]
fn failed_auth_and_redirects_never_save_accounts_or_echo_secrets_or_follow_other_origins() {
    let (_t, m) = manager_temp();
    let h = Http::new(|_, _| response(401, "{\"message\":\"token-one and Authorization: token-one\"}"));
    let e = m.add(input(&h, "github", "token-one", false), &m.snapshot().unwrap().revision).err().unwrap();
    assert_eq!(e.kind, "auth");
    assert!(!json(&e).unwrap().windows(9).any(|s| s == b"token-one"));
    assert!(m.snapshot().unwrap().accounts.is_empty());
    let other = Http::identities();
    let target = other.url.clone();
    let redirect = Http::new(move |_, _| format!("HTTP/1.1 302 Found\r\nLocation: {target}/user\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
    assert!(m.add(input(&redirect, "github", "token-one", false), &m.snapshot().unwrap().revision).is_err());
    assert!(other.seen.lock().is_empty());
    assert!(m.snapshot().unwrap().accounts.is_empty());
    assert!(Server::new("github", "http://untrusted.example").is_err());
    assert!(Server::new("github", "https://user:token@github.com").is_err());
    assert!(Server::new("github", "https://github.com/?token=secret").is_err());
}

#[test]
fn mutation_during_identity_validation_rejects_the_old_save_instead_of_reactivating_a_locked_session() {
    let (_t, manager) = manager_temp();
    let manager = Arc::new(manager);
    let (ready, received) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let wait = std::sync::Mutex::new(wait);
    let h = Http::new(move |_, _| {
        ready.send(()).unwrap();
        wait.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
        response(200, "{\"id\":1,\"login\":\"first\",\"name\":\"First\"}")
    });
    let request = input(&h, "github", "token-one", false);
    let expected = manager.snapshot().unwrap().revision;
    let worker = manager.clone();
    let pending = thread::spawn(move || worker.add(request, &expected));
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    manager.lock().unwrap();
    release.send(()).unwrap();
    assert_eq!(pending.join().unwrap().err().unwrap().kind, "stale-operation");
    assert!(manager.snapshot().unwrap().accounts.is_empty());
}

#[test]
fn malformed_documents_and_forgetting_tokens_fail_closed_without_changing_git_or_erasing_metadata() {
    let (_t, m) = manager_temp();
    let h = Http::identities();
    m.vault("portable secret password".into(), &m.snapshot().unwrap().revision, false).unwrap();
    let s = add(&m, &h, "github", "token-one", true);
    let id = &s.accounts[0].profile.id;
    let s = m.reset_vault(&s.revision).unwrap();
    assert!(!s.vault_configured);
    assert_eq!(s.accounts[0].status, "reconnect");
    assert!(m.account(id).is_err());
    assert!(!fs::read_to_string(m.root.join("accounts.json")).unwrap().contains("ciphertext"));
    fs::write(m.root.join("accounts.json"), b"not valid JSON").unwrap();
    assert!(m.snapshot().is_err());
    assert_eq!(fs::read(m.root.join("accounts.json")).unwrap(), b"not valid JSON");
}

#[test]
fn connection_revision_includes_the_actual_remote_url_and_repository_identity() {
    let (_t, m) = manager_temp();
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("repo");
    fs::create_dir(&root).unwrap();
    super::super::runner::run(&root, ["init", "-q"]).unwrap();
    super::super::runner::run(&root, ["remote", "add", "origin", "https://github.com/team/one.git"]).unwrap();
    let first = context_from(&m, &root).unwrap().unwrap().info;
    let unchanged = context_from(&m, &root).unwrap().unwrap().info;
    assert_eq!(first.connection_revision, unchanged.connection_revision);
    super::super::runner::run(&root, ["remote", "set-url", "origin", "https://github.com/team/two.git"]).unwrap();
    let other = context_from(&m, &root).unwrap().unwrap().info;
    assert_ne!(first.connection_revision, other.connection_revision);
    assert_eq!(other.project, "team/two");
}

#[test]
fn failed_atomic_save_keeps_the_previous_document_and_live_session() {
    let (_t, m) = manager_temp();
    let h = Http::identities();
    let s = add(&m, &h, "github", "token-one", false);
    let id = s.accounts[0].profile.id.clone();
    let before = fs::read(m.root.join("accounts.json")).unwrap();
    let epoch = m.memory.lock().epoch;
    let result = m.edit(&s.revision, |_, next| {
        next.sessions.clear();
        fs::rename(m.root.join("accounts.json"), m.root.join("previous.json"))?;
        fs::create_dir(m.root.join("accounts.json"))?;
        Ok(())
    });
    assert!(result.is_err());
    fs::remove_dir(m.root.join("accounts.json")).unwrap();
    fs::rename(m.root.join("previous.json"), m.root.join("accounts.json")).unwrap();
    assert_eq!(m.memory.lock().epoch, epoch);
    assert_eq!(fs::read(m.root.join("accounts.json")).unwrap(), before);
    assert_eq!(m.test(&id).unwrap(), "first");
}
#[test]
fn anonymous_azure_identity_and_oversized_state_cannot_be_committed() {
    let (_t, m) = manager_temp();
    let h = Http::new(|_, _| response(200, r#"{"authenticatedUser":{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","providerDisplayName":"Anonymous"}}"#));
    assert!(m.add(input(&h, "azure", "token-one", false), &m.snapshot().unwrap().revision).is_err());
    assert!(m.snapshot().unwrap().accounts.is_empty());
    let before = m.snapshot().unwrap();
    assert!(m
        .edit(&before.revision, |d, _| {
            for i in 0..1001 {
                d.active.push(Active { repository: format!("repo-{i}"), remote: "origin".into() });
            }
            Ok(())
        })
        .is_err());
    assert!(m.snapshot().is_ok());
    assert_eq!(m.snapshot().unwrap().revision, before.revision);
}

#[test]
fn https_host_mismatches_are_rejected_and_ssh_aliases_require_an_explicit_mapping() {
    let (_t, m) = manager_temp();
    let h = Http::identities();
    let s = add(&m, &h, "github", "token-one", false);
    let p = &s.accounts[0].profile;
    assert!(info_for_profile(p, "https://other.example/team/repo.git", "origin", true).is_err());
    assert!(info_for_profile(p, "git@work-alias:team/repo.git", "origin", false).is_err());
    let f = info_for_profile(p, "git@work-alias:team/repo.git", "origin", true).unwrap();
    assert_eq!(f.api, format!("{}/api/v3", h.url));
    assert_eq!(f.project, "team/repo");
}

#[test]
fn concurrent_snapshot_reads_never_erase_newly_committed_session_credentials() {
    let (_t, m) = manager_temp();
    let manager = Arc::new(m);
    let h = Http::identities();
    add(&manager, &h, "github", "token-one", false);
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let reader = manager.clone();
    let thread = thread::spawn(move || {
        while !done.load(Ordering::SeqCst) {
            reader.snapshot().unwrap();
            thread::yield_now();
        }
    });
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for _ in 0..15 {
            let s = add(&manager, &h, "github", "token-two", false);
            let p = s.accounts.iter().find(|a| a.profile.login == "second").unwrap();
            assert_eq!(p.status, "available");
            assert_eq!(manager.test(&p.profile.id).unwrap(), "second");
            manager.remove(&p.profile.id, &manager.snapshot().unwrap().revision).unwrap();
        }
    }));
    stop.store(true, Ordering::SeqCst);
    thread.join().unwrap();
    result.unwrap();
}
