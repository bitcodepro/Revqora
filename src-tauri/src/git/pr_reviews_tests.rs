use super::super::{
    forge_accounts as accounts,
    forge_test_http::{metadata, Http, PATCH, SERIAL},
    runner,
};
use super::*;
#[test]
fn bitbucket_root_reads_are_explicitly_partial_and_preserve_fresh_resolution() {
    let mut v = discussion("bitbucket");
    let root = bb_thread(&v);
    assert!(!root.complete);
    assert_eq!(root.comments.len(), 1);
    v["resolution"] = json!({"type":"comment_resolution"});
    v["content"]["raw"] = json!("Edited root");
    let refreshed = bb_thread(&v);
    assert!(!refreshed.complete);
    assert_eq!(refreshed.resolved, Some(true));
    assert_eq!(refreshed.comments[0].body, "Edited root");
    assert_ne!(root.revision, refreshed.revision);
}
#[test]
fn github_comment_ids_preserve_64_bit_ids_and_gitlab_marks_older_source_discussions() {
    let mut github = discussion("github");
    github["comments"]["nodes"][0]["fullDatabaseId"] = json!("6543478096");
    github["comments"]["nodes"][0]["databaseId"] = Value::Null;
    assert_eq!(gh_thread(&github).unwrap().comments[0].id, "6543478096");
    github["line"] = Value::Null;
    github["originalLine"] = json!(8);
    assert_eq!(gh_thread(&github).unwrap().line, Some(8));
    let gitlab = discussion("gitlab");
    let mut t = gl_thread(&gitlab).unwrap();
    gitlab_outdated(&mut t, &gitlab, &"b".repeat(40));
    assert!(t.outdated);
    gitlab_outdated(&mut t, &gitlab, &"a".repeat(40));
    assert!(!t.outdated);
}
use parking_lot::Mutex;
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
#[test]
fn bodies_are_bounded_and_never_silently_modified() {
    assert!(validate_body("", true).is_err());
    assert!(validate_body("", false).is_ok());
    assert!(validate_body(&"😀".repeat(16385), true).is_err());
    assert!(validate_body("text\0", true).is_err());
    assert!(validate_body("Review\nТест 😀", true).is_ok());
}
#[test]
fn deleted_and_resolved_azure_threads_preserve_state_and_do_not_render_html() {
    let t=az_thread(&json!({"id":4,"status":"fixed","isDeleted":true,"threadContext":{"filePath":"/src/a.ts","leftFileStart":{"line":12}},"comments":[{"id":1,"author":{"displayName":"User"},"content":"<img src=x>","publishedDate":"now","commentType":"text"}]})).unwrap();
    assert_eq!(t.path.as_deref(), Some("src/a.ts"));
    assert_eq!(t.side, "LEFT");
    assert_eq!(t.line, Some(12));
    assert_eq!(t.resolved, Some(true));
    assert!(!t.can_resolve);
    assert!(!t.can_reply);
    assert_eq!(t.comments[0].body, "<img src=x>");
}
#[test]
fn gitlab_discussion_proofs_change_with_replies_and_resolution() {
    let v = json!({"id":"a","individual_note":false,"notes":[{"id":1,"body":"First","author":{"username":"u"},"resolvable":true,"resolved":false,"position":{"new_path":"new.txt","new_line":2,"head_sha":"a"}}]});
    let t = gl_thread(&v).unwrap();
    let mut changed = v.clone();
    changed["notes"][0]["resolved"] = json!(true);
    assert_ne!(t.revision, gl_thread(&changed).unwrap().revision);
    assert!(t.can_reply);
    assert!(t.can_resolve);
    assert_eq!(t.side, "RIGHT");
    assert!(gl_thread(&json!({"notes":[]})).is_err());
}

fn discussion(kind: &str) -> Value {
    match kind {
        "github" => {
            json!({"id":"T7","path":"new.txt","diffSide":"RIGHT","line":1,"originalLine":1,"isOutdated":false,"isResolved":false,"viewerCanReply":true,"viewerCanResolve":true,"viewerCanUnresolve":true,"comments":{"nodes":[{"databaseId":11,"author":{"login":"reviewer"},"body":"First","createdAt":"2026-01-01","pullRequestReview":{"state":"COMMENTED"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}})
        }
        "gitlab" => {
            json!({"id":"d7","individual_note":false,"notes":[{"id":11,"author":{"username":"reviewer"},"body":"First","created_at":"2026-01-01","resolvable":true,"resolved":false,"position":{"new_path":"new.txt","new_line":1,"head_sha":"a".repeat(40)}}]})
        }
        "bitbucket" => {
            json!({"id":7,"user":{"display_name":"reviewer"},"content":{"raw":"First"},"created_on":"2026-01-01","inline":{"path":"new.txt","to":1},"resolution":null})
        }
        _ => {
            json!({"id":7,"status":"active","isDeleted":false,"threadContext":{"filePath":"/new.txt","rightFileStart":{"line":1}},"comments":[{"id":11,"author":{"displayName":"reviewer"},"content":"First","publishedDate":"2026-01-01","commentType":"text"}]})
        }
    }
}
fn action(kind: &str, actor: &str) -> Action {
    Action {
        kind: kind.into(),
        body: if matches!(kind, "resolve" | "reopen") { String::new() } else { "Review Тест 😀".into() },
        expected_actor: actor.into(),
        thread: None,
        thread_revision: None,
        anchor: None,
    }
}
#[test]
fn real_review_contracts_pin_lines_and_identity_and_preserve_git_and_failed_drafts() {
    let _serial = SERIAL.lock();
    let manager = accounts::manager().unwrap();
    for kind in ["github", "gitlab", "bitbucket", "azure"] {
        let state = Arc::new(Mutex::new(discussion(kind)));
        let server_state = state.clone();
        let deny = Arc::new(AtomicBool::new(false));
        let denied = deny.clone();
        let uncertain = Arc::new(AtomicBool::new(false));
        let ambiguous = uncertain.clone();
        let flip = Arc::new(AtomicBool::new(false));
        let flipping = flip.clone();
        let identities = Arc::new(AtomicUsize::new(0));
        let identity_calls = identities.clone();
        let h = Http::new(move |r| {
            let headers = "Content-Type: application/json\r\n".to_string();
            if r.path.ends_with("/user") || r.path.contains("connectionData") {
                let wrong = flipping.load(Ordering::SeqCst) && identity_calls.fetch_add(1, Ordering::SeqCst) > 0;
                return(200,headers,json!({"id":if wrong{2}else{1},"login":"tester","username":"tester","name":"Tester","display_name":"Tester","nickname":"tester","uuid":if wrong{"other"}else{"tester"},"authenticatedUser":{"id":if wrong{"other"}else{"tester"},"providerDisplayName":"Tester","properties":{"Account":{"$value":"Tester"}}}}).to_string());
            }
            if r.path.ends_with("/repos/team/repo") {
                return (200, headers, json!({"archived":false,"permissions":{"push":true}}).to_string());
            }
            if r.path.ends_with("/approvals") {
                return (200, headers, json!({"user_can_approve":true,"approved_by":[]}).to_string());
            }
            if r.path.contains("diffs/commits?") {
                return (
                    200,
                    headers,
                    json!({"commonCommit":"c".repeat(40),"allChangesIncluded":true,"changes":[{"changeType":"edit","item":{"path":"/new.txt"}}]}).to_string(),
                );
            }
            if r.path.contains("/iterations/2/changes?") {
                return (200, headers, json!({"changeEntries":[{"changeTrackingId":9,"item":{"path":"/new.txt"}}],"nextSkip":0}).to_string());
            }
            if r.path.contains("/iterations?") {
                return(200,headers,json!({"value":[{"id":2,"sourceRefCommit":{"commitId":"a".repeat(40)},"targetRefCommit":{"commitId":"b".repeat(40)},"commonRefCommit":{"commitId":"c".repeat(40)}}]}).to_string());
            }
            if r.path.contains("/items?") {
                return (200, headers, json!({"objectId":if r.path.contains(&"c".repeat(40)){"d".repeat(40)}else{"e".repeat(40)}}).to_string());
            }
            if r.path.contains("/blobs/") {
                return (200, "Content-Type: text/plain\r\n".into(), if r.path.contains(&"d".repeat(40)) { "before\n".into() } else { "after\n".into() });
            }
            if r.accept.contains("diff") || r.path.ends_with("/raw_diffs") || r.path.ends_with("/diff") {
                return (200, "Content-Type: text/plain\r\n".into(), PATCH.into());
            }
            let query = r.body["query"].as_str().unwrap_or("");
            if r.path.ends_with("/api/graphql") && query.starts_with("query") {
                let t = server_state.lock().clone();
                if query.contains("reviewThreads") {
                    return(200,headers,json!({"data":{"repository":{"pullRequest":{"headRefOid":"a".repeat(40),"reviewThreads":{"nodes":[t],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}).to_string());
                }
                let mut t = t;
                t["pullRequest"] = json!({"number":if r.body["variables"]["id"]=="foreign"{8}else{7},"repository":{"nameWithOwner":"team/repo"}});
                return (200, headers, json!({"data":{"node":t}}).to_string());
            }
            let is_write = r.method != "GET";
            if is_write && denied.load(Ordering::SeqCst) {
                return (403, headers, "{}".into());
            }
            if is_write && ambiguous.swap(false, Ordering::SeqCst) {
                return (500, headers, "{}".into());
            }
            if is_write {
                let mut t = server_state.lock();
                if query.starts_with("mutation") {
                    let resolved = !query.contains("unresolveReviewThread");
                    t["isResolved"] = json!(resolved);
                    let mut response = json!({"data":{}});
                    response["data"][if resolved { "resolveReviewThread" } else { "unresolveReviewThread" }] =
                        json!({"thread":{"id":"T7","isResolved":resolved}});
                    return (200, headers, response.to_string());
                }
                if r.body.get("resolved").is_some() {
                    t["notes"][0]["resolved"] = r.body["resolved"].clone();
                }
                if r.path.ends_with("/resolve") {
                    t["resolution"] = if r.method == "DELETE" { Value::Null } else { json!({"user":{"uuid":"tester"}}) };
                }
                if r.method == "PATCH" && r.body.get("status").is_some() {
                    t["status"] = json!(if r.body["status"] == 2 { "fixed" } else { "active" });
                }
                return (204, String::new(), String::new());
            }
            let clean = r.path.split('?').next().unwrap();
            let t = server_state.lock().clone();
            if clean.ends_with("/discussions/d7") || clean.ends_with("/comments/7") || clean.ends_with("/threads/7") {
                return (200, headers, t.to_string());
            }
            if clean.ends_with("/discussions") {
                return (200, headers, json!([t]).to_string());
            }
            if clean.ends_with("/comments") {
                return (200, headers, json!({"values":[t]}).to_string());
            }
            if clean.ends_with("/threads") {
                return (200, headers, json!({"value":[t]}).to_string());
            }
            (200, headers, metadata(kind, "Review PR", "Description", "main", 1).to_string())
        });
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        for args in [
            vec!["init", "-qb", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "tester@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            runner::run(repo, args).unwrap();
        }
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        runner::run(repo, ["add", "."]).unwrap();
        runner::run(repo, ["commit", "-qm", "Base"]).unwrap();
        fs::write(repo.join("file.txt"), "Keep local work\n").unwrap();
        let head = runner::run(repo, ["rev-parse", "HEAD"]).unwrap();
        let index = fs::read(repo.join(".git/index")).unwrap();
        let url = if kind == "azure" { format!("{}/team/_git/repo", h.url) } else { format!("{}/team/repo.git", h.url) };
        runner::run(repo, ["remote", "add", "origin", &url]).unwrap();
        let s = manager
            .add(
                accounts::Add {
                    id: None,
                    kind: kind.into(),
                    server: h.url.clone(),
                    username: if kind == "bitbucket" { "tester@example.invalid" } else { "" }.into(),
                    token: "stage14-fixture-token".into(),
                    auth_mode: if kind == "bitbucket" { "basic" } else { "token" }.into(),
                    persist: false,
                },
                &manager.snapshot().unwrap().revision,
            )
            .unwrap();
        let aid = s.accounts.iter().find(|a| a.profile.server.server == h.url).unwrap().profile.id.clone();
        let bindings = accounts::connections(repo).unwrap();
        accounts::select(
            repo,
            accounts::Selection {
                remote: "origin".into(),
                fingerprint: bindings.remotes[0].fingerprint.clone(),
                account_id: Some(aid.clone()),
                allow_ssh_alias: false,
            },
            &bindings.revision,
        )
        .unwrap();
        let connection = forge::detect(repo).unwrap().unwrap().connection_revision.unwrap();
        let d = pr_center::detail(repo, 7, &connection).unwrap();
        let c = capabilities(repo, 7, &connection, &d.revision).unwrap();
        assert!(c.approve, "{kind}");
        assert_eq!(c.request_changes, kind != "gitlab");
        let listed = page(repo, 7, &connection, &d.revision, "threads", None).unwrap();
        assert_eq!(listed.items.len(), 1, "{kind}");
        let t = thread(repo, 7, &connection, &d.revision, &listed.items[0].id).unwrap();
        assert_eq!(t.comments[0].body, "First");
        let mut reply = action("reply", &c.actor_id);
        reply.thread = Some(t.id.clone());
        reply.thread_revision = Some(t.revision.clone());
        act(repo, 7, &connection, &d.revision, reply).unwrap();
        let mut resolve = action("resolve", &c.actor_id);
        resolve.thread = Some(t.id.clone());
        resolve.thread_revision = Some(t.revision.clone());
        act(repo, 7, &connection, &d.revision, resolve).unwrap();
        let done = thread(repo, 7, &connection, &d.revision, &t.id).unwrap();
        assert_eq!(done.resolved, Some(true));
        let before = h.seen.lock().len();
        let mut stale_action = action("reopen", &c.actor_id);
        stale_action.thread = Some(t.id.clone());
        stale_action.thread_revision = Some(t.revision.clone());
        assert_eq!(act(repo, 7, &connection, &d.revision, stale_action).unwrap_err().kind, "stale-operation");
        assert!(h.seen.lock()[before..].iter().all(|r| r.method == "GET" || r.body["query"].as_str().is_some_and(|q| q.starts_with("query"))));
        let files = pr_center::files(repo, 7, &connection, &d.revision, 0).unwrap();
        let mut inline = action("comment", &c.actor_id);
        inline.anchor = Some(Anchor { file_id: files.items[0].id.clone(), side: "LEFT".into(), line: 1 });
        act(repo, 7, &connection, &d.revision, inline).unwrap();
        let write = h.seen.lock().last().unwrap().clone();
        match kind {
            "github" => {
                assert_eq!(write.body["commit_id"], "a".repeat(40));
                assert_eq!(write.body["side"], "LEFT");
            }
            "gitlab" => {
                assert_eq!(write.body["position"]["old_line"], 1);
                assert_eq!(write.body["position"]["base_sha"], "c".repeat(40));
            }
            "bitbucket" => assert_eq!(write.body["inline"]["from"], 1),
            _ => {
                assert_eq!(write.body["threadContext"]["leftFileStart"]["line"], 1);
                assert_eq!(write.body["pullRequestThreadContext"]["changeTrackingId"], 9);
                assert_eq!(write.body["pullRequestThreadContext"]["iterationContext"]["firstComparingIteration"], 2);
            }
        }
        let mut approve = action("approve", &c.actor_id);
        if kind != "github" {
            approve.body.clear();
        }
        act(repo, 7, &connection, &d.revision, approve).unwrap();
        identities.store(0, Ordering::SeqCst);
        flip.store(true, Ordering::SeqCst);
        let before = h.seen.lock().len();
        assert_eq!(act(repo, 7, &connection, &d.revision, action("comment", &c.actor_id)).unwrap_err().kind, "stale-operation");
        assert!(h.seen.lock()[before..].iter().all(|r| r.method == "GET"));
        flip.store(false, Ordering::SeqCst);
        deny.store(true, Ordering::SeqCst);
        assert_eq!(act(repo, 7, &connection, &d.revision, action("comment", &c.actor_id)).unwrap_err().kind, "auth");
        deny.store(false, Ordering::SeqCst);
        uncertain.store(true, Ordering::SeqCst);
        assert_eq!(act(repo, 7, &connection, &d.revision, action("comment", &c.actor_id)).unwrap_err().kind, "forge-write-uncertain");
        if kind == "github" {
            let mut a = action("reply", &c.actor_id);
            a.thread = Some("foreign".into());
            a.thread_revision = Some(t.revision);
            assert!(act(repo, 7, &connection, &d.revision, a).unwrap_err().message.contains("another PR"));
        }
        assert_eq!(runner::run(repo, ["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "Keep local work\n");
        manager.remove(&aid, &manager.snapshot().unwrap().revision).unwrap();
    }
}
