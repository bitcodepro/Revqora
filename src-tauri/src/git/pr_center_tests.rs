use super::*;

fn f(kind: &str) -> ForgeInfo {
    ForgeInfo {
        kind: kind.into(),
        host: "example.invalid".into(),
        project: "team/repo".into(),
        remote: "origin".into(),
        web_url: "https://example.invalid/team/repo".into(),
        api: match kind {
            "github" => "https://example.invalid/api/v3",
            "gitlab" => "https://example.invalid/api/v4",
            "bitbucket" => "https://api.bitbucket.org/2.0",
            _ => "https://example.invalid/org",
        }
        .into(),
        connection_revision: Some("connection".into()),
        account_login: Some("reviewer".into()),
    }
}

#[test]
fn provider_metadata_normalizes_states_and_never_opens_server_supplied_urls() {
    let v = json!({"number":7,"title":"Read me","user":{"login":"author"},"head":{"ref":"topic","sha":"a".repeat(40)},"base":{"ref":"main","sha":"b".repeat(40)},"state":"closed","merged_at":"2026-01-01","html_url":"file:///unsafe.exe","body":"Description","updated_at":"now"});
    let d = detail_value(&f("github"), &v).unwrap();
    assert_eq!(d.pull.state, "merged");
    assert_eq!(d.pull.url, "https://example.invalid/team/repo/pull/7");
    assert_eq!(d.body, "Description");
    let mut changed = v.clone();
    changed["body"] = json!("New description");
    assert_ne!(d.revision, detail_value(&f("github"), &changed).unwrap().revision);
    let mut connection = f("github");
    connection.connection_revision = Some("other account".into());
    assert_ne!(d.revision, detail_value(&connection, &v).unwrap().revision);
}

#[test]
fn raw_paths_preserve_quoted_unicode_spaces_binary_and_mode_only_changes() {
    let patch=b"diff --git \"a/\\320\\242\\320\\265\\321\\201\\321\\202.txt\" \"b/\\320\\242\\320\\265\\321\\201\\321\\202.txt\"\n--- \"a/\\320\\242\\320\\265\\321\\201\\321\\202.txt\"\n+++ \"b/\\320\\242\\320\\265\\321\\201\\321\\202.txt\"\n@@ -1 +1 @@\n-before\n+after\ndiff --git a/folder b/name.bin b/folder b/name.bin\nBinary files a/folder b/name.bin and b/folder b/name.bin differ\ndiff --git a/mode.txt b/mode.txt\nold mode 100644\nnew mode 100755\n";
    let mut files = diff::parse(patch);
    for raw in &mut files {
        normalize_raw(raw).unwrap();
    }
    assert_eq!(files[0].new_path.as_deref(), Some("Тест.txt"));
    assert_eq!(files[0].old_path.as_deref(), Some("Тест.txt"));
    assert!(complete(&files[0]));
    assert_eq!(files[1].new_path.as_deref(), Some("folder b/name.bin"));
    assert!(files[1].binary);
    assert_eq!(files[2].new_path.as_deref(), Some("mode.txt"));
    assert_eq!(files[2].new_mode.as_deref(), Some("100755"));
}

#[test]
fn incomplete_hunks_are_not_represented_as_complete_diffs() {
    let raw = diff::parse(b"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-one\n+two\n");
    assert!(!complete(&raw[0]));
}

#[test]
fn bitbucket_diff_redirect_is_limited_to_the_same_repo_and_reviewed_pair() {
    let f = f("bitbucket");
    let d = Detail {
        pull: PullRequest {
            number: 7,
            title: "T".into(),
            author: "A".into(),
            head: "topic".into(),
            base: "main".into(),
            url: String::new(),
            draft: false,
            state: "open".into(),
            created: String::new(),
            head_sha: "a".repeat(40),
        },
        body: String::new(),
        updated: String::new(),
        base_sha: "b".repeat(40),
        diff_base_sha: String::new(),
        revision: "r".into(),
        file_count: None,
    };
    let good = format!("https://api.bitbucket.org/2.0/repositories/team/repo/diff/{}..{}?topic=true&from_pullrequest_id=7", d.pull.head_sha, d.base_sha);
    assert!(bitbucket_redirect(&f, 7, &d, &good).unwrap().starts_with("/repositories/team/repo/diff/"));
    for bad in [
        good.replace("api.bitbucket.org", "third-party.invalid"),
        good.replace("team/repo/", "team/other/"),
        good.replace(&d.base_sha, &"c".repeat(40)),
        format!("{good}&access_token=bad"),
    ] {
        assert!(bitbucket_redirect(&f, 7, &d, &bad).is_err());
    }
}

#[test]
fn template_locations_are_provider_specific() {
    for p in [".github/pull_request_template.md", "docs/PULL_REQUEST_TEMPLATE/security.md", "PULL_REQUEST_TEMPLATE/feature.md"] {
        assert!(template_path("github", p));
    }
    assert!(!template_path("github", "src/pull_request_template.md"));
    assert!(template_path("gitlab", ".gitlab/merge_request_templates/Feature.md"));
    assert!(!template_path("gitlab", ".github/pull_request_template.md"));
    assert!(template_path("azure", ".azuredevops/pull_request_template/branches/main.md"));
    assert!(template_path("bitbucket", ".bitbucket/pull_request_template.md"));
}

#[derive(Clone)]
struct Request {
    method: String,
    path: String,
    accept: String,
    body: Value,
}
struct Http {
    url: String,
    seen: Arc<Mutex<Vec<Request>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Http {
    fn new(reply: impl Fn(&Request) -> (u16, String, String) + Send + 'static) -> Self {
        use std::{
            io::{BufRead, BufReader, Read},
            net::TcpListener,
            sync::atomic::Ordering,
            thread,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let seen = Arc::new(Mutex::new(vec![]));
        let capture = seen.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = stop.clone();
        let handle = thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let words = line.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
                if words.len() < 2 {
                    continue;
                }
                let mut r = Request { method: words[0].clone(), path: words[1].clone(), accept: String::new(), body: Value::Null };
                let mut size = 0;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':') {
                        match key.to_ascii_lowercase().as_str() {
                            "content-length" => size = value.trim().parse().unwrap(),
                            "accept" => r.accept = value.trim().into(),
                            _ => {}
                        }
                    }
                }
                let mut body = vec![0; size];
                reader.read_exact(&mut body).unwrap();
                drop(reader);
                if !body.is_empty() {
                    r.body = serde_json::from_slice(&body).unwrap();
                }
                capture.lock().push(r.clone());
                let (code, headers, body) = reply(&r);
                let response = format!("HTTP/1.1 {code} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
            }
        });
        Self { url, seen, stop, thread: Some(handle) }
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
const PATCH:&str="diff --git a/old.txt b/new.txt\nsimilarity index 60%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-before\n+after\n";
fn metadata(kind: &str, title: &str, body: &str, base: &str, stamp: u64) -> Value {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    match kind {
        "github" => {
            json!({"number":7,"title":title,"body":body,"updated_at":stamp.to_string(),"head":{"ref":"topic","sha":a},"base":{"ref":base,"sha":b},"user":{"login":"author"},"state":"open","changed_files":1})
        }
        "gitlab" => {
            json!({"iid":7,"title":title,"description":body,"updated_at":stamp.to_string(),"source_branch":"topic","target_branch":base,"sha":a,"diff_refs":{"head_sha":a,"start_sha":b,"base_sha":"c".repeat(40)},"author":{"username":"author"},"state":"opened","changes_count":"1"})
        }
        "bitbucket" => {
            json!({"id":7,"title":title,"description":body,"updated_on":stamp.to_string(),"source":{"branch":{"name":"topic"},"commit":{"hash":a}},"destination":{"branch":{"name":base},"commit":{"hash":b}},"author":{"display_name":"author"},"state":"OPEN"})
        }
        "bitbucket-server" => {
            json!({"id":7,"version":stamp,"title":title,"description":body,"updatedDate":stamp,"fromRef":{"displayId":"topic","id":"refs/heads/topic","latestCommit":a},"toRef":{"displayId":base,"id":format!("refs/heads/{base}"),"latestCommit":b,"repository":{"slug":"repo","project":{"key":"team"}}},"author":{"user":{"displayName":"author"}},"state":"OPEN"})
        }
        _ => {
            json!({"pullRequestId":7,"title":title,"description":body,"sourceRefName":"refs/heads/topic","targetRefName":format!("refs/heads/{base}"),"lastMergeSourceCommit":{"commitId":a},"lastMergeTargetCommit":{"commitId":b},"createdBy":{"displayName":"author"},"status":"active","creationDate":"2026-01-01"})
        }
    }
}

#[test]
fn real_provider_contracts_preserve_git_state_and_reject_stale_edits_and_connections() {
    use super::super::forge_accounts::{self as accounts, Add, Selection};
    use std::fs;
    let manager = accounts::manager().unwrap();
    for fixture in ["github", "gitlab", "bitbucket", "azure", "azure-mode-only"] {
        let mode_only = fixture == "azure-mode-only";
        let kind = if mode_only { "azure" } else { fixture };
        // A mode-only pair has different tree-entry modes but the same blob.
        // Azure's Items response exposes that blob; modes belong to Trees.
        let before_entry = json!({"relativePath":"new.txt","mode":"100644","objectType":"blob","objectId":"d".repeat(40)});
        let after_entry = json!({"relativePath":"new.txt","mode":if mode_only{"100755"}else{"100644"},"objectType":"blob","objectId":if mode_only{"d".repeat(40)}else{"e".repeat(40)}});
        if mode_only {
            assert_eq!(before_entry["objectId"], after_entry["objectId"]);
            assert_ne!(before_entry["mode"], after_entry["mode"]);
        }
        let state = Arc::new(Mutex::new(metadata(kind, "Before", "Description", "main", 1)));
        let current = state.clone();
        let h = Http::new(move |r| {
            let json_headers = "Content-Type: application/json\r\n".to_string();
            if r.path.ends_with("/user") || r.path.contains("connectionData") || r.path.contains("whoami") {
                return (200,json_headers,json!({"id":1,"login":"tester","username":"tester","name":"tester","nickname":"tester","uuid":"tester","authenticatedUser":{"id":"tester","providerDisplayName":"tester","properties":{"Account":{"$value":"tester"}}}}).to_string());
            }
            if r.path.contains("diffs/commits?") {
                return (
                    200,
                    json_headers,
                    json!({"commonCommit":"c".repeat(40),"allChangesIncluded":true,"changes":[{"changeType":"edit","item":{"path":"/new.txt"}}]}).to_string(),
                );
            }
            if r.path.contains("/items?") {
                let entry = if r.path.contains(&"c".repeat(40)) { &before_entry } else { &after_entry };
                return (200, json_headers, json!({"objectId":entry["objectId"],"gitObjectType":"blob"}).to_string());
            }
            if r.path.contains("/trees/") {
                let entry = if r.path.contains(&"c".repeat(40)) { &before_entry } else { &after_entry };
                return (200, json_headers, json!({"treeEntries":[entry]}).to_string());
            }
            if r.path.contains("/blobs/") {
                return (
                    200,
                    "Content-Type: application/octet-stream\r\n".into(),
                    if r.path.contains(&"d".repeat(40)) { "before\n".into() } else { "after\n".into() },
                );
            }
            if r.accept.contains("diff") || r.path.ends_with("/raw_diffs") || r.path.ends_with("/diff") || r.path.ends_with("/7.diff") {
                return (200, "Content-Type: text/plain\r\n".into(), PATCH.into());
            }
            if r.method != "GET" {
                let title = r.body["title"].as_str().unwrap();
                let body = r.body[if kind == "github" { "body" } else { "description" }].as_str().unwrap();
                let base = match kind {
                    "github" => r.body["base"].as_str(),
                    "gitlab" => r.body["target_branch"].as_str(),
                    "bitbucket" => r.body.pointer("/destination/branch/name").and_then(Value::as_str),
                    "bitbucket-server" => r.body.pointer("/toRef/id").and_then(Value::as_str).map(|s| s.trim_start_matches("refs/heads/")),
                    _ => Some("main"),
                }
                .unwrap();
                if kind == "bitbucket-server" && r.method == "PUT" {
                    assert_eq!(r.body["version"], 1);
                    assert_eq!(r.body.pointer("/toRef/repository/slug").unwrap(), "repo");
                }
                *current.lock() = metadata(kind, title, body, base, 2);
                return (200, json_headers, current.lock().to_string());
            }
            let item = current.lock().clone();
            if r.path.split('?').next().unwrap().ends_with("/7") {
                return (200, json_headers, item.to_string());
            }
            let rows = vec![item];
            let page = match kind {
                "github" | "gitlab" => json!(rows),
                "bitbucket" => json!({"values":rows}),
                "bitbucket-server" => json!({"values":rows,"isLastPage":true}),
                _ => json!({"value":rows}),
            };
            (200, json_headers, page.to_string())
        });
        let t = tempfile::tempdir().unwrap();
        let repo = t.path();
        runner::run(repo, ["init", "-qb", "main"]).unwrap();
        runner::run(repo, ["config", "user.name", "Tester"]).unwrap();
        runner::run(repo, ["config", "user.email", "tester@example.invalid"]).unwrap();
        runner::run(repo, ["config", "commit.gpgsign", "false"]).unwrap();
        fs::create_dir_all(repo.join(".github/PULL_REQUEST_TEMPLATE")).unwrap();
        fs::write(repo.join(".github/PULL_REQUEST_TEMPLATE/Feature.md"), "Committed template Тест\n").unwrap();
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        runner::run(repo, ["add", "."]).unwrap();
        runner::run(repo, ["commit", "-qm", "Base"]).unwrap();
        fs::write(repo.join("file.txt"), "unsaved local work\n").unwrap();
        fs::write(repo.join(".github/PULL_REQUEST_TEMPLATE/Feature.md"), "uncommitted template\n").unwrap();
        let remote = if kind == "azure" {
            format!("{}/team/_git/repo", h.url)
        } else if kind == "bitbucket-server" {
            format!("{}/scm/team/repo.git", h.url)
        } else {
            format!("{}/team/repo.git", h.url)
        };
        runner::run(repo, ["remote", "add", "origin", &remote]).unwrap();
        let s = manager
            .add(
                Add {
                    id: None,
                    kind: kind.into(),
                    server: h.url.clone(),
                    username: if kind == "bitbucket" { "test@example.invalid" } else { "" }.into(),
                    token: "stage13-fixture-token".into(),
                    auth_mode: if kind == "bitbucket" { "basic" } else { "token" }.into(),
                    persist: false,
                },
                &manager.snapshot().unwrap().revision,
            )
            .unwrap();
        let id = s.accounts.iter().find(|a| a.profile.server.server == h.url).unwrap().profile.id.clone();
        let connections = accounts::connections(repo).unwrap();
        let remote = &connections.remotes[0];
        accounts::select(
            repo,
            Selection { remote: "origin".into(), fingerprint: remote.fingerprint.clone(), account_id: Some(id.clone()), allow_ssh_alias: false },
            &connections.revision,
        )
        .unwrap();
        let before_head = runner::run(repo, ["rev-parse", "HEAD"]).unwrap();
        let index = fs::read(repo.join(".git/index")).unwrap();
        let p = page(repo, "open", None).unwrap();
        assert_eq!(p.items.len(), 1);
        assert!(p.next_cursor.is_none());
        let connection = p.forge.connection_revision.unwrap();
        let d = detail(repo, 7, &connection).unwrap();
        assert_eq!(d.body, "Description");
        if kind == "github" {
            let templates = templates(repo, &connection).unwrap();
            assert_eq!(templates.items[0].body, "Committed template Тест\n");
        }
        let files = files(repo, 7, &connection, &d.revision, 0).unwrap();
        assert_eq!(files.items.len(), 1, "{kind}");
        let v = file(repo, 7, &connection, &d.revision, &files.items[0].id).unwrap();
        if kind == "azure" {
            assert!(files.notice.as_deref().unwrap().contains("file modes"));
            assert!(v.notice.as_deref().unwrap().contains("symlinks"));
            assert_eq!(v.notice, files.notice);
        } else {
            assert!(files.notice.is_none());
            assert!(v.notice.is_none());
        }
        let rendered = v.diff.unwrap();
        if mode_only {
            assert!(rendered.empty);
            assert!(rendered.hunks.is_empty());
        } else {
            assert!(!rendered.hunks.is_empty(), "{fixture}");
            assert!(rendered.hunks.iter().flat_map(|h| &h.lines).any(|l| l.text == "after"), "{fixture}");
        }
        let saved =
            edit(repo, 7, &connection, &d.revision, Edit { title: "Updated".into(), body: "Long description 😀\n".into(), base: "develop".into() }).unwrap();
        assert_eq!(saved.detail.pull.title, "Updated");
        assert_eq!(saved.notice.is_some(), kind == "azure");
        let count = h.seen.lock().iter().filter(|r| r.method != "GET").count();
        assert!(edit(repo, 7, &connection, &d.revision, Edit { title: "Stale".into(), body: "".into(), base: "main".into() }).is_err());
        assert_eq!(h.seen.lock().iter().filter(|r| r.method != "GET").count(), count);
        let created = create(repo, "Created", "Body", "topic", "main", false, &connection).unwrap();
        assert_eq!(created.number, 7);
        let request = h.seen.lock().iter().find(|r| r.method == "POST").unwrap().clone();
        assert_eq!(request.body["title"], "Created");
        let cursor = serde_json::to_string(&Cursor { connection: "other".into(), state: "open".into(), offset: 50 }).unwrap();
        let count = h.seen.lock().len();
        assert!(page(repo, "open", Some(&cursor)).is_err());
        assert_eq!(h.seen.lock().len(), count);
        runner::run(repo, ["remote", "set-url", "origin", &format!("{}/other/repo.git", h.url)]).unwrap();
        assert!(file(repo, 7, &connection, &d.revision, &files.items[0].id).is_err());
        assert!(detail(repo, 7, &connection).is_err());
        assert_eq!(h.seen.lock().len(), count);
        assert_eq!(runner::run(repo, ["rev-parse", "HEAD"]).unwrap(), before_head);
        assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "unsaved local work\n");
        manager.remove(&id, &manager.snapshot().unwrap().revision).unwrap();
    }
}
