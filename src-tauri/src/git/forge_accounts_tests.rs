use super::*;
use crate::git::runner;
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
fn git_prompt(prompt: &str) -> crate::askpass::AskpassRequest {
    crate::askpass::AskpassRequest { id: 1, prompt: prompt.into(), kind: crate::askpass::classify(prompt).into(), origin: crate::askpass::Origin::Git }
}

#[test]
fn bitbucket_git_prompts_reject_other_transports_origins_and_arbitrary_text() {
    assert_eq!(bitbucket_git_prompt("Username for 'https://bitbucket.org': "), Some(true));
    assert_eq!(bitbucket_git_prompt("Password for 'https://x-token-auth@bitbucket.org:443/workspace/repo.git': "), Some(false));
    for address in [
        "http://bitbucket.org",
        "ssh://git@bitbucket.org",
        "https://bitbucket.org.evil.invalid",
        "https://bitbucket.org@evil.invalid",
        "https://bitbucket.org:8443",
        "https://bitbucket.org?host=evil",
        "https://bitbucket.org/#fake",
        "https://me:secret@bitbucket.org",
        "https://bitbucket.org\\@evil.invalid",
    ] {
        assert_eq!(bitbucket_git_prompt(&format!("Password for '{address}': ")), None);
    }
    assert_eq!(bitbucket_git_prompt("Password for 'https://elsewhere.invalid': https://bitbucket.org "), None);
    assert_eq!(bitbucket_git_prompt("Enter passphrase for key 'bitbucket.org': "), None);
}
#[test]
fn all_four_services_reuse_only_explicitly_selected_matching_api_tokens_for_git_https() {
    let (_temp, m) = manager_temp();
    for (kind, server, destination, expected_user) in [
        ("github", "https://github.com", "https://github.com/team/repo.git", "fixture"),
        ("gitlab", "https://gitlab.com", "https://gitlab.com/group/repo.git", "oauth2"),
        ("bitbucket", "https://bitbucket.org", "https://bitbucket.org/team/repo.git", "x-bitbucket-api-token-auth"),
        ("azure", "https://dev.azure.com/org", "https://dev.azure.com/org/project/_git/repo", "git"),
    ] {
        m.edit(&m.snapshot().unwrap().revision, |d, memory| {
            let profile = Profile {
                id: kind.into(),
                server: Server::new(kind, server)?,
                login: "fixture".into(),
                user_id: kind.into(),
                name: "Fixture".into(),
                auth_mode: if kind == "bitbucket" { "basic" } else { "token" }.into(),
                auth_username: "".into(),
                identity_verified: None,
                git_username: None,
                actor_namespace: None,
            };
            memory.sessions.insert(
                profile.id.clone(),
                (digest(&aad(&profile)?), Credential { username: "".into(), token: "fixture-api-secret".into(), mode: profile.auth_mode.clone() }),
            );
            d.accounts.push(Record { profile, sealed: None });
            Ok(())
        })
        .unwrap();
        let revision = m.snapshot().unwrap().revision;
        assert_eq!(m.git_answer(kind, &revision, &git_prompt(&format!("Username for '{destination}': "))).unwrap().as_str(), expected_user);
        assert_eq!(m.git_answer(kind, &revision, &git_prompt(&format!("Password for '{destination}': "))).unwrap().as_str(), "fixture-api-secret");
        for url in ["https://elsewhere.invalid/team/repo.git", "http://github.com/team/repo.git", "https://github.com@evil.invalid/team/repo.git"] {
            assert!(m.git_answer(kind, &revision, &git_prompt(&format!("Password for '{url}': "))).is_err());
        }
        let mut spoof = git_prompt(&format!("Password for '{destination}': "));
        spoof.origin = crate::askpass::Origin::Ssh;
        assert!(m.git_answer(kind, &revision, &spoof).is_err());
    }
    let revision = m.snapshot().unwrap().revision;
    assert!(m.git_answer("azure", &revision, &git_prompt("Password for 'https://dev.azure.com': ")).is_err());
    assert!(m.git_answer("azure", &revision, &git_prompt("Password for 'https://dev.azure.com/other/project/_git/repo': ")).is_err());
    assert!(m.git_answer("azure", &revision, &git_prompt("Password for 'https://other.visualstudio.com/project/_git/repo': ")).is_err());
    assert_eq!(
        m.git_answer("azure", &revision, &git_prompt("Password for 'https://org.visualstudio.com/project/_git/repo': ")).unwrap().as_str(),
        "fixture-api-secret"
    );
}

#[test]
fn bitbucket_git_token_consent_requires_current_available_matching_account() {
    let (_temp, manager) = manager_temp();
    // Install verified account fixtures without any live Bitbucket request.
    for mode in ["basic", "bearer"] {
        let before = manager.snapshot().unwrap().revision;
        manager
            .edit(&before, |d, m| {
                let profile = Profile {
                    id: mode.into(),
                    server: Server::new("bitbucket", "https://bitbucket.org")?,
                    login: "git-user".into(),
                    user_id: mode.into(),
                    name: "Test".into(),
                    auth_mode: mode.into(),
                    auth_username: "api@example.invalid".into(),
                    identity_verified: None,
                    git_username: None,
                    actor_namespace: None,
                };
                m.sessions.insert(
                    profile.id.clone(),
                    (digest(&aad(&profile)?), Credential { username: profile.auth_username.clone(), token: "test-only-secret".into(), mode: mode.into() }),
                );
                d.accounts.push(Record { profile, sealed: None });
                Ok(())
            })
            .unwrap();
        let current = manager.snapshot().unwrap();
        let prompt = git_prompt("Username for 'https://bitbucket.org': ");
        let username = manager.git_answer(mode, &current.revision, &prompt).unwrap();
        assert_eq!(username.as_str(), if mode == "basic" { "x-bitbucket-api-token-auth" } else { "x-token-auth" });
        assert_ne!(username.as_str(), "api@example.invalid");
        assert_eq!(
            manager.git_answer(mode, &current.revision, &git_prompt("Password for 'https://x-token-auth@bitbucket.org': ")).unwrap().as_str(),
            "test-only-secret"
        );
        for text in ["Password for 'https://bitbucket.org': ", "Username for 'https://bitbucket.org': "] {
            let mut forged = git_prompt(text);
            forged.origin = crate::askpass::Origin::Ssh;
            assert!(manager.git_answer(mode, &current.revision, &forged).unwrap_err().message.contains("cannot be sent to SSH"));
        }
        assert!(manager.git_answer(mode, &before, &prompt).is_err());
        assert!(manager.git_answer(mode, &current.revision, &git_prompt("Password for 'https://elsewhere.invalid': ")).is_err());
        assert!(manager.git_answer("missing", &current.revision, &prompt).is_err());
        let snapshot = String::from_utf8(json(&current).unwrap()).unwrap();
        assert!(!snapshot.contains("test-only-secret"));
        assert!(!fs::read_to_string(manager.root.join("accounts.json")).unwrap().contains("test-only-secret"));
    }
    let locked = manager.lock().unwrap();
    assert!(manager.git_answer("basic", &locked.revision, &git_prompt("Password for 'https://bitbucket.org': ")).is_err());
    let restarted = Manager::new(manager.root.clone());
    assert!(restarted.git_answer("bearer", &restarted.snapshot().unwrap().revision, &git_prompt("Password for 'https://bitbucket.org': ")).is_err());
}

#[test]
fn account_updates_keep_an_open_readers_snapshot_and_publish_the_new_document() {
    let (_temp, manager) = manager_temp();
    let http = Http::identities();
    add(&manager, &http, "github", "token-one", false);
    let mut reader = fs::File::open(manager.root.join("accounts.json")).unwrap();
    let updated = add(&manager, &http, "github", "token-two", false);
    assert_eq!(updated.accounts.len(), 2);
    let mut old = String::new();
    reader.read_to_string(&mut old).unwrap();
    assert_eq!(serde_json::from_str::<Document>(&old).unwrap().accounts.len(), 1);
    assert_eq!(manager.snapshot().unwrap().accounts.len(), 2);
    assert!(!fs::read_to_string(manager.root.join("accounts.json")).unwrap().contains("token-"));
}
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
                        // Accepted sockets can inherit the listener's nonblocking mode
                        // on Windows/macOS. A partial request must wait for its headers.
                        stream.set_nonblocking(false).unwrap();
                        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                        let mut reader = BufReader::new(&mut stream);
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
                        drop(reader);
                        let reply = response(&path, &auth);
                        let _ = stream.write_all(reply.as_bytes());
                        let _ = stream.shutdown(std::net::Shutdown::Write);
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

#[test]
fn http_fixture_waits_for_fragmented_request_headers() {
    use std::net::TcpStream;
    let h = Http::identities();
    let mut client = TcpStream::connect(h.url.strip_prefix("http://").unwrap()).unwrap();
    client.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    client.write_all(b"GET /api/v3/us").unwrap();
    let mut byte = [0];
    let e = client.read(&mut byte).expect_err("fixture must keep an incomplete request open");
    assert!(matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut));
    client.write_all(b"er HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token-one\r\n\r\n").unwrap();
    client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut reply = String::new();
    client.read_to_string(&mut reply).unwrap();
    assert!(reply.starts_with("HTTP/1.1 200"));
    assert_eq!(h.seen.lock().as_slice(), &[("/api/v3/user".into(), "Bearer token-one".into())]);
}
fn input(server: &Http, kind: &str, token: &str, persist: bool) -> Add {
    Add {
        verify_identity: None,
        git_source: None,
        id: None,
        kind: kind.into(),
        server: server.url.clone(),
        username: if kind == "bitbucket" { "mail@example.invalid" } else { "" }.into(),
        token: token.into(),
        auth_mode: if kind == "bitbucket" { "basic" } else { "token" }.into(),
        persist,
    }
}

#[test]
fn bitbucket_token_connection_saves_and_restarts_without_reading_a_profile() {
    let (_temp, m) = manager_temp();
    let h = Http::new(|_, _| panic!("A token-only connection must not request user information"));
    let password = "portable token connection password";
    m.vault(password.into(), &m.snapshot().unwrap().revision, false).unwrap();
    let mut request = input(&h, "bitbucket", "token-with-pr-scopes", true);
    request.verify_identity = Some(false);
    let added = m.add(request, &m.snapshot().unwrap().revision).unwrap();
    let profile = &added.accounts[0].profile;
    assert_eq!(profile.identity_verified, Some(false));
    assert!(profile.user_id.is_empty());
    assert_eq!(profile.actor_namespace.as_deref(), Some(format!("bitbucket-token:{}", profile.id).as_str()));
    assert!(h.seen.lock().is_empty());
    let restarted = Manager::new(m.root.clone());
    let snapshot = restarted.snapshot().unwrap();
    assert_eq!(snapshot.accounts[0].status, "locked");
    restarted.vault(password.into(), &snapshot.revision, true).unwrap();
    assert_eq!(restarted.account(&profile.id).unwrap().1.token, "token-with-pr-scopes");
    assert!(restarted.test(&profile.id).unwrap_err().message.contains("repository connection"));
    assert!(h.seen.lock().is_empty());
}

#[test]
fn optional_profile_switch_keeps_the_publication_namespace_across_reconnects() {
    let (_temp, m) = manager_temp();
    let h = Http::identities();
    let first = add(&m, &h, "bitbucket", "token-one", false);
    let old = first.accounts[0].profile.clone();
    let reads = h.seen.lock().len();
    let mut request = input(&h, "bitbucket", "token-two", false);
    request.id = Some(old.id.clone());
    request.verify_identity = Some(false);
    let token_only = m.add(request, &first.revision).unwrap();
    let current = &token_only.accounts[0].profile;
    assert!(current.user_id.is_empty());
    assert_eq!(current.actor_namespace.as_deref(), Some(old.user_id.as_str()));
    assert_eq!(h.seen.lock().len(), reads);
    let mut request = input(&h, "bitbucket", "token-one", false);
    request.id = Some(old.id.clone());
    request.verify_identity = Some(true);
    let verified = m.add(request, &token_only.revision).unwrap();
    let current = &verified.accounts[0].profile;
    assert_eq!(current.identity_verified, None);
    assert_eq!(current.user_id, old.user_id);
    assert_eq!(current.actor_namespace.as_deref(), Some(old.user_id.as_str()));
}

#[test]
fn legacy_encrypted_profile_aad_is_byte_identical_after_adding_optional_fields() {
    let bytes=br#"{"id":"legacy-account","kind":"bitbucket","server":"https://bitbucket.org","login":"legacy","userId":"uuid-legacy","name":"Legacy","authMode":"basic","authUsername":"legacy@example.invalid"}"#;
    let profile: Profile = serde_json::from_slice(bytes).unwrap();
    assert_eq!(json(&profile).unwrap(), bytes);
    let mut original = b"Revqora account v1\0".to_vec();
    original.extend(bytes);
    assert_eq!(aad(&profile).unwrap(), original);
    let (_temp, m) = manager_temp();
    let password = "legacy portable vault password";
    m.vault(password.into(), &m.snapshot().unwrap().revision, false).unwrap();
    let c = Credential { username: "legacy@example.invalid".into(), token: "legacy-secret-token".into(), mode: "basic".into() };
    let sealed = seal(m.memory.lock().key.as_ref().unwrap(), &original, &json(&c).unwrap()).unwrap();
    m.edit(&m.snapshot().unwrap().revision, |d, _| {
        d.accounts.push(Record { profile, sealed: Some(sealed) });
        Ok(())
    })
    .unwrap();
    let restarted = Manager::new(m.root.clone());
    restarted.vault(password.into(), &restarted.snapshot().unwrap().revision, true).unwrap();
    assert_eq!(restarted.account("legacy-account").unwrap().1.token, "legacy-secret-token");
}

#[test]
fn bitbucket_connection_proof_detects_external_git_helper_token_changes() {
    let (temp, m) = manager_temp();
    let root = temp.path().join("repository");
    fs::create_dir(&root).unwrap();
    runner::run(&root, ["init", "-q"]).unwrap();
    runner::run(&root, ["remote", "add", "origin", "https://alice@bitbucket.org/team/repo.git"]).unwrap();
    let credentials = temp.path().join("fixture-credentials");
    let shell_path = credentials.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
    runner::run(&root, ["config", "credential.helper", ""]).unwrap();
    runner::run(&root, ["config", "--add", "credential.helper", &format!("!f() {{ if test \"$1\" = get; then cat '{shell_path}'; fi; }}; f")]).unwrap();
    fs::write(&credentials, "username=alice\npassword=first-fixture-token\n").unwrap();
    let before = m.snapshot().unwrap().revision;
    let first = context_from(&m, &root).unwrap().unwrap().info;
    assert_eq!(first, context_from(&m, &root).unwrap().unwrap().info);
    fs::write(&credentials, "username=alice\npassword=second-fixture-token\n").unwrap();
    let second = context_from(&m, &root).unwrap().unwrap().info;
    assert_eq!(m.snapshot().unwrap().revision, before);
    assert_ne!(first.connection_revision, second.connection_revision);
    assert!(!serde_json::to_string(&second).unwrap().contains("fixture-token"));
}

#[test]
fn importing_a_git_token_rejects_a_different_api_destination_before_any_request() {
    let (temp, m) = manager_temp();
    let root = temp.path().join("repository");
    fs::create_dir(&root).unwrap();
    runner::run(&root, ["init", "-q"]).unwrap();
    let remote = "https://alice@bitbucket.org/team/repo.git";
    runner::run(&root, ["remote", "add", "origin", remote]).unwrap();
    let h = Http::new(|_, _| panic!("A foreign API destination must never receive the Git token"));
    let mut request = input(&h, "bitbucket", "", false);
    request.verify_identity = Some(true);
    request.git_source = Some(GitSource { repo: root.to_string_lossy().into(), remote: "origin".into(), fingerprint: fingerprint(remote) });
    assert!(m.add(request, &m.snapshot().unwrap().revision).err().unwrap().message.contains("does not match"));
    assert!(m.snapshot().unwrap().accounts.is_empty());
    assert!(h.seen.lock().is_empty());
}

#[test]
fn connection_test_probes_the_reviewed_remote_without_activating_it_or_substituting_its_account() {
    let (temp, m) = manager_temp();
    let root = temp.path().join("repository");
    fs::create_dir(&root).unwrap();
    runner::run(&root, ["init", "-q"]).unwrap();
    let h = Http::new(|path, _| {
        assert!(path.contains("/pullrequests?pagelen=1"));
        response(200, "{\"values\":[]}")
    });
    let mut first = input(&h, "bitbucket", "origin-token", false);
    first.verify_identity = Some(false);
    let a = m.add(first, &m.snapshot().unwrap().revision).unwrap().accounts[0].profile.id.clone();
    let mut second = input(&h, "bitbucket", "upstream-token", false);
    second.verify_identity = Some(false);
    let b = m.add(second, &m.snapshot().unwrap().revision).unwrap().accounts[1].profile.id.clone();
    let origin = format!("{}/team/origin.git", h.url);
    let upstream = format!("{}/team/upstream.git", h.url);
    runner::run(&root, ["remote", "add", "origin", &origin]).unwrap();
    runner::run(&root, ["remote", "add", "upstream", &upstream]).unwrap();
    let repo = repository(&root);
    m.edit(&m.snapshot().unwrap().revision, |d, _| {
        d.bindings = vec![
            Binding {
                repository: repo.clone(),
                remote: "origin".into(),
                fingerprint: fingerprint(&origin),
                account_id: Some(a.clone()),
                allow_ssh_alias: false,
            },
            Binding {
                repository: repo.clone(),
                remote: "upstream".into(),
                fingerprint: fingerprint(&upstream),
                account_id: Some(b.clone()),
                allow_ssh_alias: false,
            },
        ];
        d.active = vec![Active { repository: repo.clone(), remote: "origin".into() }];
        Ok(())
    })
    .unwrap();
    let selected = || ConnectionTest { remote: "upstream".into(), fingerprint: fingerprint(&upstream), revision: m.snapshot().unwrap().revision };
    let before = fs::read(m.root.join("accounts.json")).unwrap();
    test_repository_from(&m, &root, &b, &selected()).unwrap();
    assert_eq!(fs::read(m.root.join("accounts.json")).unwrap(), before);
    assert_eq!(
        h.seen.lock().as_slice(),
        &[("/2.0/repositories/team/upstream/pullrequests?pagelen=1".into(), format!("Basic {}", forge::base64(b"mail@example.invalid:upstream-token")))]
    );
    let calls = h.seen.lock().len();
    assert!(test_repository_from(&m, &root, &a, &selected()).is_err());
    assert_eq!(h.seen.lock().len(), calls);
    m.edit(&m.snapshot().unwrap().revision, |d, _| {
        d.bindings.iter_mut().find(|b| b.remote == "upstream").unwrap().account_id = Some(a.clone());
        Ok(())
    })
    .unwrap();
    test_repository_from(&m, &root, &a, &selected()).unwrap();
    assert_eq!(h.seen.lock().last().unwrap().0, "/2.0/repositories/team/upstream/pullrequests?pagelen=1");
    assert_eq!(h.seen.lock().last().unwrap().1, format!("Basic {}", forge::base64(b"mail@example.invalid:origin-token")));
    assert_eq!(m.read().unwrap().active[0].remote, "origin");
    let stale_selection = selected();
    m.lock().unwrap();
    let calls = h.seen.lock().len();
    assert!(test_repository_from(&m, &root, &a, &stale_selection).is_err());
    assert_eq!(h.seen.lock().len(), calls);
    runner::run(&root, ["remote", "set-url", "upstream", "https://example.invalid/other/repo.git"]).unwrap();
    assert!(test_repository_from(&m, &root, &a, &selected()).is_err());
    assert_eq!(h.seen.lock().len(), calls);
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
