use super::*;
use crate::git::runner;
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    runner::run(r, ["init", "-qb", "main"]).unwrap();
    for (k, v) in [("user.name", "Workflow fixture"), ("user.email", "workflow@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", ".git/hooks")]
    {
        runner::run(r, ["config", k, v]).unwrap();
    }
    fs::write(r.join("base.txt"), "original\n").unwrap();
    runner::run(r, ["add", "."]).unwrap();
    runner::run(r, ["commit", "-qm", "base"]).unwrap();
    d
}
fn step(kind: &str, value: &str, extra: &str) -> Step {
    Step {
        kind: kind.into(),
        label: kind.into(),
        value: value.into(),
        extra: extra.into(),
        body: String::new(),
        timeout_seconds: 15,
        when: "always".into(),
        on_false: "stop".into(),
    }
}
fn recipe(root: &Path, steps: Vec<Step>) -> (Catalog, String) {
    let c = catalog(root).unwrap();
    let c = save_definition(root, Definition { id: String::new(), name: "Fixture workflow".into(), steps }, &c.revision).unwrap();
    let id = c.definitions.last().unwrap().id.clone();
    (c, id)
}
fn start(root: &Path, steps: Vec<Step>) -> Run {
    let (c, id) = recipe(root, steps);
    begin(root, &id, &c.revision, Parameters { branch: "feature/workflow".into(), base: "main".into() }).unwrap()
}
fn wait(root: &Path, id: &str) -> Run {
    let end = std::time::Instant::now() + Duration::from_secs(40);
    loop {
        let r = get(root, id).unwrap();
        let working = jobs().lock().get(&operations::repository_key(root)).is_some_and(|j| !j.finished.load(Ordering::Acquire));
        if !matches!(r.phase.as_str(), "running" | "stopping") && !working {
            return r;
        }
        assert!(std::time::Instant::now() < end, "Workflow stuck: {r:?}");
        thread::sleep(Duration::from_millis(25));
    }
}
fn next(root: &Path, r: &Run) -> Run {
    let p = review(root, &r.id).unwrap();
    execute(root.to_owned(), p, true).unwrap();
    wait(root, &r.id)
}

#[test]
fn definitions_are_validated_and_compare_and_swap_preserves_other_editors() {
    let r = repo();
    let before = catalog(r.path()).unwrap();
    let (c, id) = recipe(r.path(), vec![step("checkClean", "", "")]);
    let mut d = c.definitions[0].clone();
    d.steps.push(step("command", "echo test", ""));
    assert!(save_definition(r.path(), d.clone(), &before.revision).is_err());
    d.steps[1].when = "unknown".into();
    assert!(save_definition(r.path(), d, &c.revision).is_err());
    assert_eq!(catalog(r.path()).unwrap().definitions[0].steps.len(), 1);
    assert!(delete_definition(r.path(), &id, &before.revision).is_err());
    delete_definition(r.path(), &id, &c.revision).unwrap();
    assert!(catalog(r.path()).unwrap().definitions.is_empty());
}
#[test]
fn ordered_checks_branch_and_command_keep_base_and_reject_replayed_reviews() {
    let r = repo();
    let head = runner::run(r.path(), ["rev-parse", "main"]).unwrap();
    let run = start(r.path(), vec![step("checkClean", "", ""), step("branch", "${branch}", "${base}"), step("command", "echo workflow-passed", "")]);
    let proof = review(r.path(), &run.id).unwrap();
    execute(r.path().into(), proof.clone(), false).unwrap();
    let run = wait(r.path(), &run.id);
    assert_eq!(run.cursor, 1);
    assert!(execute(r.path().into(), proof, true).is_err());
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "ready", "{run:?}");
    assert_eq!(runner::run(r.path(), ["branch", "--show-current"]).unwrap().trim(), "feature/workflow");
    let proof = review(r.path(), &run.id).unwrap();
    assert!(execute(r.path().into(), proof, false).is_err());
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "completed", "{run:?}");
    assert!(run.results[2].stdout.contains("workflow-passed"));
    assert_eq!(runner::run(r.path(), ["rev-parse", "main"]).unwrap(), head);
    // Completed cache must not resurrect a previous ready run after stop/forget.
    forget(r.path(), &run.id).unwrap();
    assert!(runs(r.path()).unwrap().is_empty());
}
#[test]
fn false_command_conditions_never_start_the_process_and_stop_is_terminal() {
    let r = repo();
    let mut s = step("command", "echo forbidden > sentinel.txt", "");
    s.when = "dirty".into();
    s.on_false = "skip".into();
    let run = start(r.path(), vec![s.clone(), step("checkBranch", "wrong", "")]);
    let run = next(r.path(), &run);
    assert_eq!(run.results[0].phase, "skipped");
    assert!(!r.path().join("sentinel.txt").exists());
    assert!(validation::report(r.path()).is_none());
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed");
    assert_eq!(run.cursor, 1);
    assert!(review(r.path(), &run.id).is_err());
    s.on_false = "stop".into();
    let run = start(r.path(), vec![s]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed");
    assert!(!r.path().join("sentinel.txt").exists());
    assert!(validation::report(r.path()).is_none());
    let run = start(r.path(), vec![step("checkClean", "", "")]);
    stop(r.path(), &run.id).unwrap();
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "cancelled");
}
#[test]
fn stale_working_files_invalidate_review_before_any_branch_creation() {
    let r = repo();
    let run = start(r.path(), vec![step("branch", "${branch}", "main")]);
    let p = review(r.path(), &run.id).unwrap();
    fs::write(r.path().join("external.txt"), "IDE change").unwrap();
    execute(r.path().into(), p, true).unwrap();
    let run = wait(r.path(), &run.id);
    assert_eq!(run.phase, "failed", "{run:?}");
    assert!(!runner::exec(r.path(), ["show-ref", "--verify", "--quiet", "refs/heads/feature/workflow"]).unwrap().ok());
    assert_eq!(fs::read_to_string(r.path().join("external.txt")).unwrap(), "IDE change");
}
#[test]
fn linked_worktree_cannot_use_another_working_directorys_review() {
    let r = repo();
    let parent = tempfile::tempdir().unwrap();
    let other = parent.path().join("copy");
    runner::run(r.path(), ["worktree", "add", "--detach", other.to_str().unwrap(), "HEAD"]).unwrap();
    let run = start(r.path(), vec![step("checkClean", "", "")]);
    let p = review(r.path(), &run.id).unwrap();
    assert!(review(&other, &run.id).is_err());
    assert!(execute(other, p, true).is_err());
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "ready");
}
#[test]
fn failed_checks_keep_logs_and_do_not_run_later_steps() {
    let r = repo();
    let run = start(r.path(), vec![step("command", "echo failed-check && exit 7", ""), step("branch", "must-not-exist", "main")]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed", "{run:?}");
    assert_eq!(run.results[0].exit_code, Some(7));
    assert!(run.results[0].stdout.contains("failed-check"));
    assert_eq!(run.results[1].phase, "pending");
    assert!(review(r.path(), &run.id).is_err());
}
#[test]
fn interrupted_marker_blocks_replay_and_requires_manual_acknowledgement() {
    let r = repo();
    let mut run = start(r.path(), vec![step("command", "echo must-not-run", "")]);
    run.phase = "running".into();
    run.results[0].phase = "running".into();
    write(&path(r.path(), &run.id).unwrap(), &run).unwrap();
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "interrupted");
    assert!(review(r.path(), &run.id).is_err());
    assert!(forget(r.path(), &run.id).is_err());
    assert!(start_result(r.path()).is_err());
    assert!(acknowledge(r.path(), &run.id, false).is_err());
    acknowledge(r.path(), &run.id, true).unwrap();
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "abandoned");
    assert!(start_result(r.path()).is_ok());
}
fn start_result(root: &Path) -> GitResult<Run> {
    let c = catalog(root)?;
    begin(root, &c.definitions[0].id, &c.revision, Parameters { branch: String::new(), base: String::new() })
}
#[test]
fn escaped_logs_roundtrip_and_oversize_write_preserves_previous_record() {
    let r = repo();
    let mut run = start(r.path(), vec![step("checkClean", "", ""); 16]);
    for row in &mut run.results {
        row.stdout = "\0".repeat(8192);
        row.stderr = "\u{1}".repeat(8192);
    }
    let p = path(r.path(), &run.id).unwrap();
    write(&p, &run).unwrap();
    assert_eq!(get(r.path(), &run.id).unwrap().results[15].stderr, run.results[15].stderr);
    let old = fs::read(&p).unwrap();
    run.results[0].stdout = "x".repeat(LIMIT + 1);
    assert!(write(&p, &run).is_err());
    assert_eq!(fs::read(p).unwrap(), old);
    let (text, truncated) = clip(&"🌿".repeat(3000));
    assert!(text.len() <= 8192 && truncated);
}
#[test]
fn publication_uses_exact_source_and_destination_without_following_tags_or_rewriting_history() {
    let r = repo();
    let server = tempfile::tempdir().unwrap();
    runner::run(server.path(), ["init", "--bare", "-q"]).unwrap();
    runner::run(r.path(), ["remote", "add", "origin", server.path().to_str().unwrap()]).unwrap();
    runner::run(r.path(), ["config", "push.followTags", "true"]).unwrap();
    runner::run(r.path(), ["tag", "-a", "private-tag", "-m", "keep local"]).unwrap();
    let run = start(r.path(), vec![step("publish", "origin", "feature/workflow")]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "completed", "{run:?}");
    assert_eq!(runner::run(server.path(), ["rev-parse", "feature/workflow"]).unwrap(), runner::run(r.path(), ["rev-parse", "HEAD"]).unwrap());
    assert!(runner::run(server.path(), ["tag"]).unwrap().is_empty());
    // Even a locally replaced parent cannot turn unrelated history into a safe push.
    let run = start(r.path(), vec![step("publish", "origin", "feature/workflow")]);
    let p = review(r.path(), &run.id).unwrap();
    let blob = runner::run(r.path(), ["hash-object", "base.txt"]).unwrap();
    runner::run(r.path(), ["update-ref", "refs/heads/main", p.head.as_ref().unwrap()]).unwrap();
    runner::run(r.path(), ["update-ref", "refs/replace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", blob.trim()]).unwrap();
    assert!(review(r.path(), &run.id).is_err());
}

#[test]
fn cherry_pick_conflict_stops_later_steps_and_keeps_a_recovery_checkpoint() {
    let r = repo();
    runner::run(r.path(), ["switch", "-c", "topic"]).unwrap();
    fs::write(r.path().join("base.txt"), "topic edit\n").unwrap();
    runner::run(r.path(), ["commit", "-am", "topic edit"]).unwrap();
    let topic = runner::run(r.path(), ["rev-parse", "HEAD"]).unwrap();
    runner::run(r.path(), ["switch", "main"]).unwrap();
    fs::write(r.path().join("base.txt"), "main edit\n").unwrap();
    runner::run(r.path(), ["commit", "-am", "main edit"]).unwrap();
    let run = start(r.path(), vec![step("cherryPick", topic.trim(), ""), step("command", "echo forbidden > sentinel.txt", "")]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed", "{run:?}");
    assert!(!r.path().join("sentinel.txt").exists());
    assert_eq!(run.results[1].phase, "pending");
    assert!(runner::run(r.path(), ["ls-files", "--unmerged"]).unwrap().contains("base.txt"));
    assert!(!crate::git::recovery::list(r.path()).unwrap().checkpoints.is_empty());
}
#[test]
fn branch_checkout_does_not_overwrite_ignored_files() {
    let r = repo();
    runner::run(r.path(), ["switch", "-c", "with-collision"]).unwrap();
    fs::write(r.path().join("ignored.txt"), "committed elsewhere").unwrap();
    runner::run(r.path(), ["add", "ignored.txt"]).unwrap();
    runner::run(r.path(), ["commit", "-m", "collision"]).unwrap();
    runner::run(r.path(), ["switch", "main"]).unwrap();
    fs::write(r.path().join(".git/info/exclude"), "ignored.txt\n").unwrap();
    fs::write(r.path().join("ignored.txt"), "keep ignored").unwrap();
    let run = start(r.path(), vec![step("branch", "new-branch", "with-collision")]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed", "{run:?}");
    assert_eq!(fs::read_to_string(r.path().join("ignored.txt")).unwrap(), "keep ignored");
    assert_eq!(runner::run(r.path(), ["branch", "--show-current"]).unwrap().trim(), "main");
}
#[test]
fn stop_cancels_commands_without_waiting_for_the_common_git_writer_gate() {
    let r = repo();
    #[cfg(windows)]
    let command = "echo running && powershell.exe -NoProfile -NonInteractive -Command Start-Sleep 30";
    #[cfg(unix)]
    let command = "echo running; sleep 30";
    let run = start(r.path(), vec![step("command", command, "")]);
    let p = review(r.path(), &run.id).unwrap();
    execute(r.path().into(), p, true).unwrap();
    let end = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let snapshot = get(r.path(), &run.id).unwrap();
        if snapshot.results[0].stdout.contains("running") {
            break;
        }
        assert!(
            !matches!(snapshot.phase.as_str(), "failed" | "uncertain" | "interrupted" | "completed"),
            "Command ended before its readiness marker: {snapshot:?}"
        );
        assert!(std::time::Instant::now() < end, "Command did not reach its readiness marker: {snapshot:?}");
        thread::sleep(Duration::from_millis(25));
    }
    stop(r.path(), &run.id).unwrap();
    let run = wait(r.path(), &run.id);
    assert_eq!(run.phase, "cancelled", "{run:?}");
    assert!(operations::run(r.path(), "workflow_step", None, |_, _| {}, || Ok(())).is_ok());
}

#[test]
fn a_completed_durable_record_wins_over_a_previously_read_running_snapshot() {
    let r = repo();
    let mut run = start(r.path(), vec![step("checkClean", "", "")]);
    run.phase = "running".into();
    let old = run.clone();
    run.phase = "completed".into();
    run.cursor = 1;
    run.results[0].phase = "completed".into();
    let p = path(r.path(), &run.id).unwrap();
    write(&p, &run).unwrap();
    for free in [true, false] {
        assert_eq!(settled_record(&p, old.clone(), free).unwrap().phase, "completed");
    }
}

#[test]
fn dangling_symbolic_destination_is_rejected_without_updating_its_target() {
    let r = repo();
    runner::run(r.path(), ["symbolic-ref", "refs/heads/alias", "refs/heads/missing"]).unwrap();
    let run = start(r.path(), vec![step("branch", "alias", "main")]);
    assert!(review(r.path(), &run.id).is_err());
    assert_eq!(runner::run(r.path(), ["symbolic-ref", "refs/heads/alias"]).unwrap().trim(), "refs/heads/missing");
    assert!(!runner::exec(r.path(), ["show-ref", "--verify", "--quiet", "refs/heads/missing"]).unwrap().ok());
}

#[test]
fn workflow_history_is_atomic_with_open_readers() {
    let r = repo();
    let command="node -e \"const fs=require('fs');process.stdout.write('ready');const t=setInterval(()=>{if(fs.existsSync('.workflow-release')){clearInterval(t);process.stdout.write('done');}},10)\"";
    let mut command = step("command", command, "");
    command.timeout_seconds = 30;
    let run = start(r.path(), vec![command]);
    let proof = review(r.path(), &run.id).unwrap();
    execute(r.path().into(), proof, true).unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let current = get(r.path(), &run.id).unwrap();
        if current.results[0].stdout.contains("ready") {
            break;
        }
        assert!(!matches!(current.phase.as_str(), "failed" | "uncertain" | "completed"), "Command ended before its ready marker: {current:?}");
        if std::time::Instant::now() >= until {
            let _ = stop(r.path(), &run.id);
            panic!("Command did not become ready: {current:?}");
        }
        thread::sleep(Duration::from_millis(25));
    }
    let record = path(r.path(), &run.id).unwrap();
    let mut running_reader = File::open(&record).unwrap();
    fs::write(r.path().join(".workflow-release"), "continue").unwrap();
    let completed = wait(r.path(), &run.id);
    assert_eq!(completed.phase, "completed", "Reader prevented the final save after the command already ran: {completed:?}");
    assert_eq!(completed.results[0].exit_code, Some(0));
    assert!(completed.results[0].stdout.contains("done"));
    let old: Run = serde_json::from_reader(&mut running_reader).unwrap();
    assert_eq!(old.phase, "running");
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "completed");
    assert_eq!(runs(r.path()).unwrap()[0].cursor, 1);
}

#[test]
fn workflow_catalog_is_atomic_with_open_readers() {
    let r = repo();
    let (c, _) = recipe(r.path(), vec![step("checkClean", "", "")]);
    let path = dir(r.path()).unwrap().join("definitions.json");
    let mut reader = File::open(&path).unwrap();
    let mut changed = c.definitions[0].clone();
    changed.name = "Updated recipe".into();
    let next = save_definition(r.path(), changed, &c.revision).expect("A catalogue reader must not prevent an atomic edit");
    let old: Vec<Definition> = serde_json::from_reader(&mut reader).unwrap();
    assert_eq!(old[0].name, "Fixture workflow");
    assert_eq!(next.definitions[0].name, "Updated recipe");
    assert_eq!(catalog(r.path()).unwrap().revision, next.revision);
}

#[test]
fn automated_ci_gate_never_treats_missing_partial_or_non_success_results_as_green() {
    let check = |state: &str| crate::git::forge::Check { name: "check".into(), state: state.into(), url: None };
    assert!(!pull_requests::checks_pass(&[]).unwrap());
    assert!(!pull_requests::checks_pass(&[check("success"), check("pending")]).unwrap());
    for state in ["failure", "cancelled", "neutral", "skipped", "unknown"] {
        assert!(pull_requests::checks_pass(&[check("success"), check(state)]).is_err());
    }
    assert!(pull_requests::checks_pass(&[check("success")]).unwrap());
}

#[test]
fn pr_agent_tests_and_commit_use_the_isolated_working_copy_and_review_requests_cannot_replay() {
    use crate::git::{
        forge, forge_accounts as accounts,
        forge_test_http::{metadata, Http, SERIAL},
    };
    use serde_json::json;
    let _serial = SERIAL.lock();
    let source = repo();
    let root = source.path();
    let source_head = runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim().to_owned();
    let served = Arc::new(Mutex::new(source_head.clone()));
    let server_head = served.clone();
    let feedback_changed = Arc::new(AtomicBool::new(false));
    let server_feedback = feedback_changed.clone();
    let deny = Arc::new(AtomicBool::new(false));
    let server_deny = deny.clone();
    let forked = Arc::new(AtomicBool::new(false));
    let server_forked = forked.clone();
    let http = Http::new(move |req| {
        let headers = "Content-Type: application/json\r\n".to_owned();
        let path = req.path.split('?').next().unwrap();
        if path.ends_with("/user") {
            return (200, headers, json!({"id":18,"login":"workflow-reviewer","name":"Fixture"}).to_string());
        }
        if path.ends_with("/repos/team/repo") {
            return (200, headers, json!({"archived":false,"permissions":{"push":true}}).to_string());
        }
        if path.ends_with("/pulls/7") {
            let mut v = metadata("github", "Fixture follow-up", "", "main", 1);
            v["head"]["sha"] = json!(*server_head.lock());
            v["base"]["sha"] = json!(*server_head.lock());
            v["head"]["repo"] =
                if server_forked.load(Ordering::Acquire) { json!({"id":20,"full_name":"other/repo"}) } else { json!({"id":10,"full_name":"team/repo"}) };
            v["base"]["repo"] = json!({"id":10,"full_name":"team/repo"});
            return (200, headers, v.to_string());
        }
        if path.ends_with("/api/graphql") {
            let text = if server_feedback.load(Ordering::Acquire) { "Changed feedback" } else { "Fix the parser issue" };
            return(200,headers,json!({"data":{"repository":{"pullRequest":{"headRefOid":*server_head.lock(),"reviewThreads":{"nodes":[{"id":"T18","path":"base.txt","diffSide":"RIGHT","line":1,"isOutdated":false,"isResolved":false,"viewerCanReply":true,"viewerCanResolve":true,"comments":{"nodes":[{"fullDatabaseId":"18","author":{"login":"reviewer"},"body":text,"createdAt":"now","pullRequestReview":{"state":"COMMENTED"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}).to_string());
        }
        if path.ends_with("/comments") || path.ends_with("/reviews") {
            return (200, headers, "[]".into());
        }
        if path.ends_with("/requested_reviewers") {
            if server_deny.load(Ordering::Acquire) {
                return (500, headers, "{}".into());
            }
            return (200, headers, "{}".into());
        }
        if path.ends_with("/check-runs") {
            return (200, headers, json!({"check_runs":[{"name":"build","status":"completed","conclusion":"success"}]}).to_string());
        }
        if path.ends_with("/status") {
            return (200, headers, json!({"statuses":[]}).to_string());
        }
        (404, headers, "{}".into())
    });
    runner::run(root, ["remote", "add", "origin", &format!("{}/team/repo.git", http.url)]).unwrap();
    let manager = accounts::manager().unwrap();
    let snapshot = manager
        .add(
            accounts::Add {
                id: None,
                kind: "github".into(),
                server: http.url.clone(),
                username: String::new(),
                token: "offline-workflow-token".into(),
                auth_mode: "token".into(),
                persist: false,
            },
            &manager.snapshot().unwrap().revision,
        )
        .unwrap();
    let account = snapshot.accounts.iter().find(|a| a.profile.server.server == http.url).unwrap().profile.id.clone();
    let c = accounts::connections(root).unwrap();
    accounts::select(
        root,
        accounts::Selection {
            remote: "origin".into(),
            fingerprint: c.remotes[0].fingerprint.clone(),
            account_id: Some(account.clone()),
            allow_ssh_alias: false,
        },
        &c.revision,
    )
    .unwrap();
    let mut agent = step("prAgent", "7", "");
    #[cfg(windows)]
    let (executable, args) = (
        format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", std::env::var("SystemRoot").unwrap()),
        vec!["-NoProfile", "-NonInteractive", "-Command", "Set-Content -LiteralPath agent-fix.txt -Value 'review fixed'; Write-Output 'agent done'"],
    );
    #[cfg(unix)]
    let (executable, args) =
        (fs::canonicalize("/bin/sh").unwrap().to_string_lossy().into_owned(), vec!["-c", "printf 'review fixed' > agent-fix.txt; echo 'agent done'"]);
    agent.body=json!({"provider":"custom","executable":executable,"argsText":serde_json::to_string(&args).unwrap(),"prompt":"Fix only actionable feedback","worktreePath":null}).to_string();
    agent.timeout_seconds = 30;
    let run = start(
        root,
        vec![agent, step("command", "echo checked > validation-proof.txt", ""), step("commit", "fix: apply reviewed changes", ""), step("prChecks", "7", "")],
    );
    forked.store(true, Ordering::Release);
    assert!(review(root, &run.id).unwrap_err().message.contains("source branch in the selected repository"));
    assert!(crate::git::agents::list(root).unwrap().is_empty(), "A fork cannot inherit the template's push destination");
    forked.store(false, Ordering::Release);
    let proof = review(root, &run.id).unwrap();
    assert!(proof.resolved[3].contains("Fix the parser issue"));
    feedback_changed.store(true, Ordering::Release);
    execute(root.into(), proof.clone(), true).unwrap();
    let stopped = wait(root, &run.id);
    assert_eq!(stopped.phase, "failed");
    assert!(crate::git::agents::list(root).unwrap().is_empty());
    feedback_changed.store(false, Ordering::Release);
    let run = start(root, stopped.definition.steps.clone());
    let after = next(root, &run);
    assert_eq!(after.phase, "ready", "{after:?}");
    let copy = PathBuf::from(after.workspace.clone().unwrap());
    assert!(!root.join("agent-fix.txt").exists());
    assert!(copy.join("agent-fix.txt").exists());
    let mut dirty_check = after.clone();
    dirty_check.definition.steps[dirty_check.cursor] = step("prChecks", "7", "");
    assert!(build_review(&copy, &dirty_check).unwrap_err().message.contains("Commit or stash"));
    // Continuing from the new tab must still find the same durable run and use its copy.
    let after = next(&copy, &after);
    assert!(copy.join("validation-proof.txt").exists());
    assert!(!root.join("validation-proof.txt").exists());
    let committed = next(root, &after);
    assert_eq!(committed.phase, "ready", "{committed:?}");
    assert_eq!(runner::run(root, ["rev-parse", "main"]).unwrap().trim(), source_head);
    assert!(crate::git::status::status(&copy).unwrap().files.is_empty());
    let mut wrong_destination = committed.clone();
    wrong_destination.definition.steps[wrong_destination.cursor] = step("publish", "origin", "unrelated-topic");
    assert!(build_review(&copy, &wrong_destination).unwrap_err().message.contains("selected PR source branch origin/topic"));
    // Green checks still refer to the old source until publication is reflected
    // by the authoritative PR API. They cannot authorize merging the old code.
    assert!(review(root, &committed.id).unwrap_err().message.contains("PR source does not match"));
    *served.lock() = runner::run(&copy, ["rev-parse", "HEAD"]).unwrap().trim().into();
    let finished = next(root, &committed);
    assert_eq!(finished.phase, "completed", "{finished:?}");
    let request = start(root, vec![step("prRequestReview", "7", "reviewer")]);
    let proof = review(root, &request.id).unwrap();
    deny.store(true, Ordering::Release);
    execute(root.into(), proof.clone(), true).unwrap();
    let outcome = wait(root, &request.id);
    assert_eq!(outcome.phase, "uncertain", "{outcome:?}");
    assert!(execute(root.into(), proof, true).is_err());
    let writes = http.seen.lock().iter().filter(|r| r.path.ends_with("/requested_reviewers") && r.method == "POST").count();
    assert_eq!(writes, 1);
    let c = catalog(root).unwrap();
    assert!(
        begin(root, &outcome.definition.id, &c.revision, outcome.parameters.clone()).is_err(),
        "A lost server result must block a new workflow until acknowledged"
    );
    if outcome.phase == "uncertain" {
        acknowledge(root, &outcome.id, true).unwrap();
    }
    let waiting = start(root, vec![step("prChecks", "7", "")]);
    let p = review(root, &waiting.id).unwrap();
    *served.lock() = "b".repeat(40);
    execute(root.into(), p, false).unwrap();
    assert_eq!(wait(root, &waiting.id).phase, "failed");
    *served.lock() = source_head;
    let waiting = start(root, vec![step("prChecks", "7", "")]);
    assert_eq!(next(root, &waiting).phase, "completed");
    assert!(forge::detect(root).unwrap().is_some());
    manager.remove(&account, &manager.snapshot().unwrap().revision).unwrap();
}
