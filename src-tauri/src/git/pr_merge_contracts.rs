use super::super::{
    forge_accounts as accounts,
    forge_test_http::{metadata, Http, SERIAL},
    runner,
};
use super::*;
use parking_lot::Mutex;
use std::{fs, sync::Arc};
#[test]
fn ci_link_headers_continue_a_short_page_instead_of_reporting_a_false_green() {
    let _serial = SERIAL.lock();
    let f = Fixture::new("github");
    {
        let mut s = f.state.lock();
        s.late = true;
        s.short_page = true;
    }
    let p = f.plan();
    assert_eq!(p.checks.len(), 2);
    assert_eq!(p.checks[1].state, "failure");
    assert!(!p.blockers.is_empty());
}
#[test]
fn a_server_tip_change_after_local_cleanup_keeps_remote_and_returns_the_deleted_sha_checkpoint() {
    let _serial = SERIAL.lock();
    let f = Fixture::new("github");
    f.merged();
    let repo = f.dir.path();
    let d = f.detail();
    let mut input = CleanupInput { local: true, remote: true, force: true, protection_rules: vec!["main".into()], review_token: String::new() };
    let review = cleanup_plan(repo, 7, &f.connection, &d.revision, &input).unwrap();
    input.review_token = review.token;
    // ls-remote stays at the reviewed source while the receive-pack advert moves
    // immediately before push. The exact-SHA lease must reject the remote delete.
    f.state.lock().remote_advance = true;
    let result = cleanup_act(repo, 7, &f.connection, &d.revision, input).unwrap();
    assert_eq!(result.state, "partial");
    assert!(result.local_deleted);
    assert!(!result.remote_deleted);
    assert!(result.warning.as_deref().unwrap().contains("remote cleanup did not complete"));
    let saved = super::super::recovery::detail(repo, &result.checkpoint.unwrap().id).unwrap();
    let source = f.state.lock().source.clone();
    assert_eq!(saved.refs.iter().find(|r| r.name == "refs/heads/topic").unwrap().oid, source);
    assert_eq!(saved.refs.iter().find(|r| r.name == "push/origin/topic").unwrap().oid, source);
    assert!(!runner::exec(repo, ["show-ref", "--verify", "refs/heads/topic"]).unwrap().ok());
    assert!(f.http.seen.lock().iter().all(|r| !r.path.ends_with("/git-receive-pack") || r.method != "POST"));
    assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "Keep local work\n");
}
struct State {
    pr: Value,
    source: String,
    target: String,
    rules: Value,
    policies: Value,
    late: bool,
    broken: bool,
    uncertain: bool,
    accepted: bool,
    queue: bool,
    queued: bool,
    flip: bool,
    identities: usize,
    writes: usize,
    remote_advance: bool,
    short_page: bool,
    base_url: String,
}
struct Fixture {
    dir: tempfile::TempDir,
    http: Http,
    state: Arc<Mutex<State>>,
    connection: String,
    account: String,
}
impl Fixture {
    fn new(kind: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            vec!["init", "-qb", "main"],
            vec!["config", "user.name", "Merger"],
            vec!["config", "user.email", "merge@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            runner::run(repo, args).unwrap();
        }
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        runner::run(repo, ["add", "."]).unwrap();
        runner::run(repo, ["commit", "-qm", "Base"]).unwrap();
        let target = runner::run(repo, ["rev-parse", "HEAD"]).unwrap().trim().to_string();
        runner::run(repo, ["switch", "-c", "topic"]).unwrap();
        fs::write(repo.join("topic.txt"), "Source change\n").unwrap();
        runner::run(repo, ["add", "."]).unwrap();
        runner::run(repo, ["commit", "-qm", "Source"]).unwrap();
        let source = runner::run(repo, ["rev-parse", "HEAD"]).unwrap().trim().to_string();
        runner::run(repo, ["switch", "main"]).unwrap();
        fs::write(repo.join("file.txt"), "Keep local work\n").unwrap();
        let mut pr = metadata(kind, "Merge fixture", "Description", "main", 1);
        match kind {
            "github" => {
                pr["head"]["sha"] = json!(source);
                pr["base"]["sha"] = json!(target);
                for field in ["head", "base"] {
                    pr[field]["repo"] = json!({"id":10,"full_name":"team/repo"});
                }
            }
            "gitlab" => {
                pr["sha"] = json!(source);
                pr["diff_refs"] = json!({"head_sha":source,"start_sha":target,"base_sha":target});
                pr["source_project_id"] = json!(10);
                pr["target_project_id"] = json!(10);
                pr["user"] = json!({"can_merge":true});
                pr["detailed_merge_status"] = json!("mergeable");
            }
            "azure" => {
                pr["lastMergeSourceCommit"] = json!({"commitId":source});
                pr["lastMergeTargetCommit"] = json!({"commitId":target});
                pr["repository"] = json!({"id":"repo-id","project":{"id":"project-id"}});
                pr["mergeStatus"] = json!("succeeded");
            }
            _ => {
                pr["source"]["commit"]["hash"] = json!(source);
                pr["destination"]["commit"]["hash"] = json!(target);
            }
        }
        let state = Arc::new(Mutex::new(State {
            pr,
            source: source.clone(),
            target: target.clone(),
            rules: json!([]),
            policies: json!([]),
            late: false,
            broken: false,
            uncertain: false,
            accepted: false,
            queue: false,
            queued: false,
            flip: false,
            identities: 0,
            writes: 0,
            remote_advance: false,
            short_page: false,
            base_url: String::new(),
        }));
        let server = state.clone();
        let provider = kind.to_string();
        let http = Http::new(move |r| {
            let headers = "Content-Type: application/json\r\n".to_string();
            let mut s = server.lock();
            let path = r.path.split('?').next().unwrap();
            let q = r.body["query"].as_str().unwrap_or("");
            if path.ends_with(".git/info/refs") {
                let receive = r.path.contains("git-receive-pack");
                let service = if receive { "git-receive-pack" } else { "git-upload-pack" };
                let sha = if receive && s.remote_advance { &s.target } else { &s.source };
                let packet = |v: &str| format!("{:04x}{}", v.len() + 4, v);
                let caps = if receive { "report-status delete-refs" } else { "multi_ack" };
                let format = if sha.len() == 40 { "sha1" } else { "sha256" };
                let body =
                    packet(&format!("# service={service}\n")) + "0000" + &packet(&format!("{sha} refs/heads/topic\0{caps} object-format={format}\n")) + "0000";
                return (200, format!("Content-Type: application/x-{service}-advertisement\r\n"), body);
            }

            if path.ends_with("/user") || path.contains("connectionData") {
                s.identities += 1;
                let bad = s.flip && s.identities > 1;
                return(200,headers,json!({"id":if bad{2}else{1},"login":"merger","username":"merger","name":"Merger","display_name":"Merger","nickname":"merger","uuid":if bad{"other"}else{"merger"},"authenticatedUser":{"id":if bad{"other"}else{"merger"},"providerDisplayName":"Merger","properties":{"Account":{"$value":"Merger"}}}}).to_string());
            }
            if path.contains("/rules/branches/") {
                return (200, headers, if s.queue { json!([{"type":"merge_queue"}]) } else { s.rules.clone() }.to_string());
            }
            if path.contains("/policy/evaluations") {
                return (200, headers, json!({"value":s.policies}).to_string());
            }
            if path.ends_with("/api/graphql") && q.starts_with("query") {
                return(200,headers,json!({"data":{"repository":{"pullRequest":{"id":"PR7","headRefOid":s.source,"baseRefOid":s.target,"mergeable":"MERGEABLE","mergeStateStatus":if s.queue{"BLOCKED"}else{"CLEAN"},"reviewDecision":"APPROVED","mergeQueueEntry":if s.queued{json!({"id":"Q7","state":"QUEUED","position":1})}else{Value::Null},"baseRef":{"branchProtectionRule":null}}}}}).to_string());
            }
            if path.contains("/check-runs") {
                if s.broken {
                    return (200, headers, "{}".into());
                }
                if s.short_page && s.late && !r.path.contains("page=2") {
                    let next = format!("{}{}", s.base_url, r.path.replace("page=1", "page=2"));
                    return (
                        200,
                        format!("{headers}Link: <{next}>; rel=\"next\"\r\n"),
                        json!({"check_runs":[{"name":"Short page build","status":"completed","conclusion":"success"}]}).to_string(),
                    );
                }
                let checks = if s.late {
                    if r.path.contains("page=2") {
                        vec![json!({"name":"Late failing test","status":"completed","conclusion":"failure"})]
                    } else {
                        (0..100).map(|i| json!({"name":format!("Check {i}"),"status":"completed","conclusion":"success"})).collect()
                    }
                } else {
                    vec![]
                };
                return (200, headers, json!({"check_runs":checks}).to_string());
            }
            if path.ends_with("/status") {
                return (200, headers, json!({"statuses":[]}).to_string());
            }
            if path.ends_with("/statuses") {
                return (
                    200,
                    headers,
                    match provider.as_str() {
                        "gitlab" => json!([]),
                        "bitbucket" => json!({"values":[]}),
                        _ => json!({"value":[]}),
                    }
                    .to_string(),
                );
            }
            if path.ends_with("/branches/topic") {
                return (200, headers, json!({"protected":false}).to_string());
            }
            if ["/api/v3/repos/team/repo", "/api/v4/projects/team%2Frepo", "/2.0/repositories/team/repo", "/team/_apis/git/repositories/repo"].contains(&path) {
                return(200,headers,json!({"id":10,"archived":false,"permissions":{"push":true},"allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":true,"default_branch":"main","defaultBranch":"refs/heads/main","mainbranch":{"name":"main"},"merge_method":"merge","squash_option":"default_off"}).to_string());
            }
            if path.ends_with("/api/graphql") && q.starts_with("mutation")
                || path.ends_with("/merge") && r.method == "PUT"
                || provider == "azure" && r.method == "PATCH"
            {
                s.writes += 1;
                let expected = match provider.as_str() {
                    "github" => text(&r.body, "/variables/head"),
                    "gitlab" => text(&r.body, "/sha"),
                    _ => text(&r.body, "/lastMergeSourceCommit/commitId"),
                };
                if expected != s.source {
                    return (409, headers, "{}".into());
                }
                if s.uncertain {
                    return (500, headers, "{}".into());
                }
                if q.contains("enqueuePullRequest") {
                    s.queued = true;
                    return (200, headers, json!({"data":{"enqueuePullRequest":{"mergeQueueEntry":{"id":"Q7","state":"QUEUED","position":1}}}}).to_string());
                }
                if provider == "azure" && s.accepted {
                    return (200, headers, json!({"status":"active","mergeStatus":"queued"}).to_string());
                }
                match provider.as_str() {
                    "github" => {
                        s.pr["state"] = json!("closed");
                        s.pr["merged_at"] = json!("2026-01-01");
                        return (200, headers, json!({"data":{"mergePullRequest":{"pullRequest":{"merged":true,"mergeCommit":{"oid":s.target}}}}}).to_string());
                    }
                    "gitlab" => {
                        s.pr["state"] = json!("merged");
                        s.pr["merge_commit_sha"] = json!(s.target);
                    }
                    _ => {
                        s.pr["status"] = json!("completed");
                        s.pr["lastMergeCommit"] = json!({"commitId":s.target});
                    }
                }
            }
            if path.contains("/pulls/7") || path.contains("/merge_requests/7") || path.contains("/pullrequests/7") {
                return (200, headers, s.pr.to_string());
            }
            (404, headers, "{}".into())
        });
        state.lock().base_url = http.url.clone();
        let url = if kind == "azure" { format!("{}/team/_git/repo", http.url) } else { format!("{}/team/repo.git", http.url) };
        runner::run(repo, ["remote", "add", "origin", &url]).unwrap();
        runner::run(repo, ["update-ref", "refs/remotes/origin/topic", &source]).unwrap();
        let m = accounts::manager().unwrap();
        let added = m
            .add(
                accounts::Add {
                    id: None,
                    kind: kind.into(),
                    server: http.url.clone(),
                    username: if kind == "bitbucket" { "merger@example.invalid" } else { "" }.into(),
                    token: "stage15-fixture-token".into(),
                    auth_mode: if kind == "bitbucket" { "basic" } else { "token" }.into(),
                    persist: false,
                },
                &m.snapshot().unwrap().revision,
            )
            .unwrap();
        let account = added.accounts.iter().find(|a| a.profile.server.server == http.url).unwrap().profile.id.clone();
        let c = accounts::connections(repo).unwrap();
        accounts::select(
            repo,
            accounts::Selection {
                remote: "origin".into(),
                fingerprint: c.remotes[0].fingerprint.clone(),
                account_id: Some(account.clone()),
                allow_ssh_alias: false,
            },
            &c.revision,
        )
        .unwrap();
        let connection = forge::detect(repo).unwrap().unwrap().connection_revision.unwrap();
        state.lock().identities = 0;
        Self { dir, http, state, connection, account }
    }
    fn detail(&self) -> Detail {
        pr_center::detail(self.dir.path(), 7, &self.connection).unwrap()
    }
    fn plan(&self) -> Plan {
        let d = self.detail();
        plan(self.dir.path(), 7, &self.connection, &d.revision).unwrap()
    }
    fn send(&self, p: &Plan, method: &str) -> GitResult<MergeResult> {
        merge(
            self.dir.path(),
            7,
            &self.connection,
            &p.detail_revision,
            MergeInput { plan_revision: p.revision.clone(), method: method.into(), message: String::new() },
        )
    }
    fn merged(&self) {
        let mut s = self.state.lock();
        s.pr["state"] = json!("closed");
        s.pr["merged_at"] = json!("2026-01-01");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let m = accounts::manager().unwrap();
        m.remove(&self.account, &m.snapshot().unwrap().revision).unwrap();
    }
}
#[test]
fn conditional_contracts_pin_heads_disable_bypass_and_keep_local_work() {
    let _serial = SERIAL.lock();
    for kind in ["github", "gitlab", "azure", "bitbucket"] {
        let f = Fixture::new(kind);
        let repo = f.dir.path();
        let head = runner::run(repo, ["rev-parse", "HEAD"]).unwrap();
        let index = fs::read(repo.join(".git/index")).unwrap();
        let p = f.plan();
        if kind == "bitbucket" {
            assert!(p.methods.is_empty());
            assert!(!p.blockers.is_empty());
            assert!(f.send(&p, "merge").is_err());
            assert_eq!(f.state.lock().writes, 0);
        } else {
            assert!(p.blockers.is_empty(), "{kind}: {:?}", p.blockers);
            assert_eq!(
                f.send(
                    &p,
                    match kind {
                        "gitlab" => "configured",
                        "azure" => "squash",
                        _ => "merge",
                    }
                )
                .unwrap()
                .state,
                "merged"
            );
            assert_eq!(f.state.lock().writes, 1);
            let seen = f.http.seen.lock();
            let write = seen
                .iter()
                .rev()
                .find(|r| r.method == "PUT" || r.method == "PATCH" || r.body["query"].as_str().is_some_and(|q| q.starts_with("mutation")))
                .unwrap();
            if kind == "azure" {
                assert_eq!(write.body["completionOptions"]["bypassPolicy"], false);
                assert_eq!(write.body["completionOptions"]["deleteSourceBranch"], false);
                assert!(write.body["completionOptions"].get("mergeCommitMessage").is_none());
            } else if kind == "gitlab" {
                assert_eq!(write.body["should_remove_source_branch"], false);
                assert_eq!(write.body["auto_merge"], false);
                assert!(write.body.get("merge_commit_message").is_none());
            }
        }
        assert_eq!(runner::run(repo, ["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "Keep local work\n");
    }
}
#[test]
fn late_failing_checks_changed_policies_identity_and_unknown_data_block_merge() {
    let _serial = SERIAL.lock();
    let f = Fixture::new("github");
    let p = f.plan();
    f.state.lock().late = true;
    let later = f.plan();
    assert_eq!(later.checks.len(), 101);
    assert!(!later.blockers.is_empty());
    assert_eq!(f.send(&p, "merge").err().unwrap().kind, "stale-operation");
    assert_eq!(f.state.lock().writes, 0);
    f.state.lock().late = false;
    let p = f.plan();
    f.state.lock().rules = json!([{"type":"required_linear_history"}]);
    assert!(!f.plan().methods.iter().any(|m| m.id == "merge"));
    assert_eq!(f.send(&p, "merge").err().unwrap().kind, "stale-operation");
    f.state.lock().rules = json!([]);
    let p = f.plan();
    {
        let mut s = f.state.lock();
        s.flip = true;
        s.identities = 0;
    }
    assert_eq!(f.send(&p, "merge").err().unwrap().kind, "stale-operation");
    assert_eq!(f.state.lock().writes, 0);
    {
        let mut s = f.state.lock();
        s.flip = false;
        s.broken = true;
    }
    let d = f.detail();
    assert!(plan(f.dir.path(), 7, &f.connection, &d.revision).is_err());
}
#[test]
fn queue_and_pending_azure_completion_are_not_a_merged_pr_and_writes_never_retry() {
    let _serial = SERIAL.lock();
    let f = Fixture::new("github");
    f.state.lock().queue = true;
    let p = f.plan();
    assert!(p.blockers.is_empty(), "{:?}", p.blockers);
    assert_eq!(p.methods[0].id, "queue");
    assert_eq!(p.methods.len(), 1);
    assert_eq!(f.send(&p, "queue").unwrap().state, "queued");
    assert!(f.send(&p, "queue").is_err());
    assert_eq!(f.state.lock().writes, 1);
    assert_eq!(f.detail().pull.state, "open");
    drop(f);
    let f = Fixture::new("azure");
    f.state.lock().accepted = true;
    assert_eq!(f.send(&f.plan(), "squash").unwrap().state, "accepted");
    assert_eq!(f.detail().pull.state, "open");
    drop(f);
    let f = Fixture::new("gitlab");
    f.state.lock().uncertain = true;
    assert_eq!(f.send(&f.plan(), "configured").err().unwrap().kind, "forge-write-uncertain");
    assert_eq!(f.state.lock().writes, 1);
}
#[test]
fn azure_required_policies_fail_closed_and_filter_strategies() {
    let _serial = SERIAL.lock();
    let f = Fixture::new("azure");
    f.state.lock().policies =
        json!([{"status":"rejected","configuration":{"isEnabled":true,"isBlocking":true,"type":{"displayName":"Build validation"},"settings":{}}}]);
    assert!(!f.plan().blockers.is_empty());
    f.state.lock().policies = json!([{"status":"approved","configuration":{"isEnabled":true,"isBlocking":true,"type":{"displayName":"Merge strategies"},"settings":{"allowSquash":true,"allowNoFastForward":false,"allowRebase":false,"allowRebaseMerge":false}}}]);
    assert_eq!(f.plan().methods.len(), 1);
    assert_eq!(f.plan().methods[0].id, "squash");
    f.state.lock().policies = json!([{"status":"approved","configuration":{"isEnabled":true}}]);
    let d = f.detail();
    assert!(plan(f.dir.path(), 7, &f.connection, &d.revision).is_err());
}
#[test]
fn cleanup_preserves_forks_protected_moved_and_occupied_branches_and_requires_checkpoint_consent() {
    let _serial = SERIAL.lock();
    let f = Fixture::new("github");
    let repo = f.dir.path();
    let mut input = CleanupInput { local: true, remote: false, force: false, protection_rules: vec!["main".into()], review_token: String::new() };
    let d = f.detail();
    assert!(cleanup_plan(repo, 7, &f.connection, &d.revision, &input).is_err());
    f.merged();
    let d = f.detail();
    input.protection_rules.push("topic".into());
    input.force = true;
    assert!(cleanup_plan(repo, 7, &f.connection, &d.revision, &input).is_err());
    input.protection_rules.pop();
    input.force = false;
    let r = cleanup_plan(repo, 7, &f.connection, &d.revision, &input).unwrap();
    input.review_token = r.token;
    assert_eq!(cleanup_act(repo, 7, &f.connection, &d.revision, input.clone()).err().unwrap().kind, "not-merged");
    f.state.lock().pr["head"]["repo"]["id"] = json!(11);
    let changed = f.detail();
    assert!(cleanup_plan(repo, 7, &f.connection, &changed.revision, &input).is_err());
    f.state.lock().pr["head"]["repo"]["id"] = json!(10);
    let old = f.state.lock().source.clone();
    let target = f.state.lock().target.clone();
    runner::run(repo, ["update-ref", "refs/heads/topic", &target]).unwrap();
    assert!(cleanup_act(repo, 7, &f.connection, &d.revision, input.clone()).is_err());
    runner::run(repo, ["update-ref", "refs/heads/topic", &old]).unwrap();
    runner::run(repo, ["symbolic-ref", "HEAD", "refs/heads/topic"]).unwrap();
    assert!(cleanup_plan(repo, 7, &f.connection, &d.revision, &input).is_err());
    runner::run(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]).unwrap();
    let r = cleanup_plan(repo, 7, &f.connection, &d.revision, &input).unwrap();
    input.review_token = r.token;
    input.force = true;
    let done = cleanup_act(repo, 7, &f.connection, &d.revision, input).unwrap();
    assert!(done.local_deleted);
    assert!(!done.remote_deleted);
    assert!(done.checkpoint.is_some());
    assert!(!runner::exec(repo, ["show-ref", "--verify", "refs/heads/topic"]).unwrap().ok());
    assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "Keep local work\n");
}
