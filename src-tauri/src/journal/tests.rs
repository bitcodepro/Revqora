use super::*;
use crate::git::runner;

struct Fixture {
    log: Arc<Journal>,
    root: PathBuf,
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Проект-quoted'");
        fs::create_dir(&root).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
            vec!["commit", "--allow-empty", "-qm", "Initial"],
        ] {
            runner::run(&root, args).unwrap();
        }
        let log = Journal::open(&dir.path().join("journal")).unwrap();
        Self { log, root, dir }
    }
    fn done(&self, command: &str) -> String {
        let op = self.log.begin(&self.root, command).unwrap();
        let id = op.context.id.clone();
        op.phase("running", &self.root);
        op.after(&self.root);
        op.finish(&Ok(()));
        drop(op);
        id
    }
}

#[test]
fn real_git_actions_keep_commands_heads_and_result_after_reopen() {
    let f = Fixture::new();
    fs::write(f.root.join("file.txt"), "Private file content\n").unwrap();
    runner::run(&f.root, ["config", "test.private", "PrivateConfigValue"]).unwrap();
    let op = f.log.begin(&f.root, "commit").unwrap();
    let id = op.context.id.clone();
    op.phase("running", &f.root);
    let result = operations::run(
        &f.root,
        "commit",
        None,
        |_, _| {},
        || {
            runner::run(&f.root, ["add", "file.txt"])?;
            runner::run(&f.root, ["commit", "-qm", "Private message is never an argument in the log"])?;
            runner::run(&f.root, ["config", "--get", "test.private"])?;
            runner::run(&f.root, ["show", "HEAD:file.txt"])
        },
    );
    op.after(&f.root);
    op.finish(&result);
    drop(op);
    let detail = f.log.detail(&id).unwrap();
    assert_eq!(detail.entry.status, "succeeded");
    assert_ne!(detail.entry.before_head, detail.entry.after_head);
    assert_eq!(detail.steps.len(), 4);
    assert!(detail.steps.iter().all(|s| s.exit_code == Some(0)));
    let encoded = serde_json::to_string(&detail).unwrap();
    assert!(!encoded.contains("Private message"));
    assert!(!encoded.contains("Private file content"));
    assert!(!encoded.contains("PrivateConfigValue"));
    let index = fs::read(f.root.join(".git/index")).unwrap();
    f.log.list(&Filter::default(), 50).unwrap();
    f.log.detail(&id).unwrap();
    assert_eq!(index, fs::read(f.root.join(".git/index")).unwrap(), "journal reads never rewrite the Git index");
    let reopened = Journal::open(&f.dir.path().join("journal")).unwrap();
    assert_eq!(reopened.detail(&id).unwrap().entry.status, "succeeded");
}

#[test]
fn active_sessions_are_not_interrupted_or_cleared_by_another_instance() {
    let f = Fixture::new();
    let op = f.log.begin(&f.root, "fetch").unwrap();
    let id = op.context.id.clone();
    op.phase("running", &f.root);
    let second = Journal::open(&f.dir.path().join("journal")).unwrap();
    assert_eq!(second.list(&Filter::default(), 50).unwrap().entries[0].status, "running");
    assert_eq!(second.clear(&Filter::default()).unwrap(), 0);
    op.finish(&Ok("done"));
    drop(op);
    assert_eq!(second.detail(&id).unwrap().entry.status, "succeeded");
}

#[test]
fn abandoned_session_is_recovered_with_unknown_outcome_and_trace() {
    let dir = tempfile::tempdir().unwrap();
    let log = Journal::open(dir.path()).unwrap();
    let op = log.begin(dir.path(), "fetch").unwrap();
    let id = op.context.id.clone();
    log.db
        .lock()
        .execute(
            "INSERT INTO commands(operation,sequence,cwd,args,started_at,output_omitted) VALUES(?1,0,?2,'[\"fetch\",\"origin\"]',?3,0)",
            params![id, dir.path().to_string_lossy(), now()],
        )
        .unwrap();
    let lock = log._lock.path().to_owned();
    op.context.closed.store(true, Ordering::Relaxed);
    drop(op);
    drop(log);
    fs::write(&lock, b"stale OS lock file").unwrap();
    let restarted = Journal::open(dir.path()).unwrap();
    let entry = restarted.list(&Filter::default(), 50).unwrap().entries.remove(0);
    assert_eq!(entry.id, id);
    assert_eq!(entry.status, "interrupted");
    assert!(entry.error.unwrap().contains("unknown"));
    assert_eq!(entry.duration_ms, None);
    let detail = restarted.detail(&id).unwrap();
    assert_eq!(detail.steps.len(), 1);
    assert_eq!(detail.steps[0].exit_code, None);
}

#[test]
fn logging_failure_does_not_change_successful_git_result() {
    let f = Fixture::new();
    fs::write(f.root.join("file.txt"), "keep staged\n").unwrap();
    let running = f.log.begin(&f.root, "fetch").unwrap();
    running.phase("running", &f.root);
    let queued = f.log.begin(&f.root, "branch_create").unwrap();
    let op = f.log.begin(&f.root, "stage").unwrap();
    let id = op.context.id.clone();
    op.phase("running", &f.root);
    f.log.db.lock().execute_batch("PRAGMA query_only=ON").unwrap();
    let result = runner::run(&f.root, ["add", "file.txt"]);
    op.after(&f.root);
    op.finish(&result);
    drop(op);
    assert!(result.is_ok());
    assert!(runner::run(&f.root, ["diff", "--cached", "--name-only"]).unwrap().contains("file.txt"));
    assert_eq!(f.log.detail(&id).unwrap().entry.status, "running", "the terminal SQLite write failed");
    assert!(f.log.retry().is_err(), "retry still fails while storage is read-only");
    assert_eq!(f.log.completions.lock().pending.len(), 1, "failed retry must retain the result");
    f.log.db.lock().execute_batch("PRAGMA query_only=OFF").unwrap();
    f.log.retry().unwrap();
    let completed = f.log.detail(&id).unwrap().entry;
    assert_eq!(completed.status, "succeeded");
    assert!(completed.finished_at.is_some());
    assert!(completed.duration_ms.is_some());
    assert_eq!(f.log.detail(&running.context.id).unwrap().entry.status, "running");
    assert_eq!(f.log.detail(&queued.context.id).unwrap().entry.status, "queued");
    f.log.retry().unwrap();
    assert_eq!(f.log.detail(&id).unwrap().entry.finished_at, completed.finished_at, "retry is idempotent");
    assert_eq!(f.log.clear(&Filter::default()).unwrap(), 1, "reconciled entries can be cleared, live actions cannot");
    queued.finish(&Ok(()));
    running.finish(&Ok(()));
}

#[test]
fn retry_restores_failed_and_paused_results_and_handles_missing_terminal_metadata() {
    let f = Fixture::new();
    let failed = f.log.begin(&f.root, "push").unwrap();
    let paused = f.log.begin(&f.root, "merge_start").unwrap();
    let abandoned = f.log.begin(&f.root, "reset").unwrap();
    let abandoned_id = abandoned.context.id.clone();
    let uncached = f.log.begin(&f.root, "fetch").unwrap();
    f.log.db.lock().execute_batch("PRAGMA query_only=ON").unwrap();
    failed.finish(&Err::<(), _>(GitError::new("Authorization: Bearer privateRetryToken").kind("auth")));
    paused.finish(&Ok(serde_json::json!({"status":"conflicts"})));
    drop(abandoned);
    uncached.finish(&Ok(()));
    // A bounded cache cannot retain every result indefinitely. Reconciliation
    // must also handle a completed row whose exact terminal metadata is absent.
    f.log.completions.lock().pending.remove(&uncached.context.id);
    f.log.db.lock().execute_batch("PRAGMA query_only=OFF").unwrap();
    f.log
        .db
        .lock()
        .execute_batch(
            "CREATE TEMP TRIGGER fail_completion BEFORE UPDATE OF status ON operations
        WHEN OLD.command='merge_start' BEGIN SELECT RAISE(ABORT,'injected journal failure'); END;",
        )
        .unwrap();
    assert!(f.log.retry().is_err());
    for id in [&failed.context.id, &paused.context.id, &abandoned_id, &uncached.context.id] {
        assert_eq!(f.log.detail(id).unwrap().entry.status, "queued", "a partially failed reconciliation is rolled back");
    }
    f.log.db.lock().execute_batch("DROP TRIGGER fail_completion").unwrap();
    f.log.retry().unwrap();
    let failure = f.log.detail(&failed.context.id).unwrap().entry;
    assert_eq!(failure.status, "failed");
    assert_eq!(failure.error_kind.as_deref(), Some("auth"));
    assert!(!failure.error.unwrap().contains("privateRetryToken"));
    let attention = f.log.detail(&paused.context.id).unwrap().entry;
    assert_eq!(attention.status, "attention");
    assert_eq!(attention.outcome.as_deref(), Some("conflicts"));
    for id in [&abandoned_id, &uncached.context.id] {
        let entry = f.log.detail(id).unwrap().entry;
        assert_eq!(entry.status, "interrupted");
        assert!(entry.error.unwrap().contains("unknown"));
    }
    assert_eq!(f.log.list(&Filter::default(), 50).unwrap().total, 4);
    assert!(runner::run(&f.root, ["status", "--porcelain"]).unwrap().is_empty(), "retry never replays Git actions");
}

#[test]
fn filters_pagination_and_export_use_literal_search_and_keep_scope() {
    let f = Fixture::new();
    for _ in 0..6 {
        f.done("branch_create");
    }
    f.done("fetch");
    let filter = Filter { repo: Some(f.root.to_string_lossy().into_owned()), search: Some("ПРОЕКТ".into()), ..Default::default() };
    let first = f.log.list(&filter, 3).unwrap();
    assert_eq!(first.total, 7);
    assert_eq!(first.entries.len(), 3);
    let mut next_filter = filter.clone();
    next_filter.before = first.next;
    let second = f.log.list(&next_filter, 3).unwrap();
    assert_eq!(second.entries.len(), 3);
    assert!(first.entries.iter().all(|a| second.entries.iter().all(|b| a.id != b.id)));
    next_filter.before = second.next;
    let third = f.log.list(&next_filter, 3).unwrap();
    assert_eq!(third.entries.len(), 1);
    assert!(third.next.is_none());
    assert_eq!(f.log.list(&Filter { search: Some("%' OR 1=1 --".into()), ..Default::default() }, 50).unwrap().total, 0);
    assert!(f.log.list(&Filter { before: Some("not a cursor".into()), ..Default::default() }, 50).is_err());
    let selected = Filter { search: Some("branch create".into()), ..filter };
    let export = f.dir.path().join("export.json");
    assert_eq!(f.log.export(&selected, &export).unwrap(), 6);
    let value: serde_json::Value = serde_json::from_slice(&fs::read(export).unwrap()).unwrap();
    assert_eq!(value["operations"].as_array().unwrap().len(), 6);
    assert_eq!(value["truncated"], false);
    assert!(f.log.export(&Filter::default(), &f.log.path).is_err());
    assert_eq!(f.log.clear(&selected).unwrap(), 6);
    assert_eq!(f.log.list(&Filter::default(), 50).unwrap().total, 1);
}

#[test]
fn linked_worktrees_share_repository_filter_but_keep_their_paths() {
    let f = Fixture::new();
    let linked = f.dir.path().join("linked");
    runner::run(&f.root, ["worktree", "add", "-qb", "linked", linked.to_str().unwrap()]).unwrap();
    f.done("stage");
    let op = f.log.begin(&linked, "stage").unwrap();
    op.finish(&Ok(()));
    drop(op);
    let page = f.log.list(&Filter { repo: Some(linked.to_string_lossy().into_owned()), ..Default::default() }, 50).unwrap();
    assert_eq!(page.entries.len(), 2);
    assert_ne!(page.entries[0].repo, page.entries[1].repo);
    assert_eq!(page.entries[0].repository_key, page.entries[1].repository_key);
}

#[test]
fn diagnostic_limits_and_redaction_apply_to_database_and_exports() {
    let f = Fixture::new();
    let op = f.log.begin(&f.root, "fetch").unwrap();
    let id = op.context.id.clone();
    for _ in 0..80 {
        if let Some(mut step) = command(&f.root, &["fetch".into(), "https://user:privatePassword@example.com/repo?token=privateToken".into()]) {
            step.finish(Some(1), vec![b'x'; 12000].as_slice(), &format!("Authorization: Bearer privateHeader\n{}", "error output\n".repeat(3000)));
        }
    }
    op.finish(&Err::<(), _>(GitError::new("Failed https://user:privatePassword@example.com/?token=privateToken").kind("auth")));
    drop(op);
    let detail = f.log.detail(&id).unwrap();
    assert!(detail.entry.truncated);
    assert_eq!(detail.steps.len(), MAX_COMMANDS as usize);
    assert!(detail.steps.iter().map(|s| s.stdout.len() + s.stderr.len()).sum::<usize>() <= OUTPUT_BUDGET as usize);
    let all = serde_json::to_string(&detail).unwrap();
    for secret in ["privatePassword", "privateToken", "privateHeader"] {
        assert!(!all.contains(secret));
    }
    let export = f.dir.path().join("redacted.json");
    f.log.export(&Filter::default(), &export).unwrap();
    let exported = fs::read_to_string(export).unwrap();
    for secret in ["privatePassword", "privateToken", "privateHeader"] {
        assert!(!exported.contains(secret));
    }
}

#[test]
fn retention_limits_age_count_and_payload_without_removing_active_actions() {
    let f = Fixture::new();
    let active = f.log.begin(&f.root, "fetch").unwrap();
    let active_id = active.context.id.clone();
    let stamp = now();
    f.log
        .db
        .lock()
        .execute(
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2005)
        INSERT INTO operations(id,session,repo,repository_key,command,search_text,status,requested_at,finished_at,bytes)
        SELECT printf('retained-%05d',x),?1,'repo','key','stage','stage','succeeded',?2+x,?2+x,100 FROM n",
            params![f.log.session, stamp],
        )
        .unwrap();
    f.log.prune().unwrap();
    assert_eq!(f.log.list(&Filter::default(), 200).unwrap().total, MAX_ENTRIES + 1);
    f.log.db.lock().execute("UPDATE operations SET bytes=?1 WHERE id IN ('retained-02004','retained-02005')", [MAX_BYTES / 2 + 1]).unwrap();
    f.log.prune().unwrap();
    assert_eq!(f.log.list(&Filter::default(), 50).unwrap().total, 2);
    f.log.db.lock().execute("UPDATE operations SET finished_at=?1 WHERE status='succeeded'", [stamp - RETENTION_MS - 1]).unwrap();
    f.log.prune().unwrap();
    let remaining = f.log.list(&Filter::default(), 50).unwrap();
    assert_eq!(remaining.total, 1);
    assert_eq!(remaining.entries[0].id, active_id);
    active.finish(&Ok(()));
    drop(active);
}

#[test]
fn paused_workflows_are_distinct_from_success_and_failed_preflight() {
    let f = Fixture::new();
    let op = f.log.begin(&f.root, "merge_start").unwrap();
    let id = op.context.id.clone();
    op.finish(&Ok(serde_json::json!({"status":"pending"})));
    drop(op);
    assert_eq!(f.log.detail(&id).unwrap().entry.status, "attention");
    let op = f.log.begin(&f.root, "reset").unwrap();
    let id = op.context.id.clone();
    op.finish(&Err::<(), _>(GitError::new("Stale selection").kind("stale-operation")));
    drop(op);
    let detail = f.log.detail(&id).unwrap();
    assert_eq!(detail.entry.status, "failed");
    assert_eq!(detail.entry.error_kind.as_deref(), Some("stale-operation"));
    assert!(detail.steps.is_empty());
}

#[test]
fn corrupt_or_future_databases_are_preserved_instead_of_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("operations.sqlite3");
    fs::write(&path, b"Not a database").unwrap();
    assert!(Journal::open(dir.path()).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"Not a database");
    fs::remove_file(&path).unwrap();
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 999).unwrap();
    drop(db);
    assert!(Journal::open(dir.path()).is_err());
    assert_eq!(Connection::open(path).unwrap().pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 999);
}

#[test]
fn panic_and_finished_scopes_cannot_capture_later_actions() {
    let f = Fixture::new();
    let mut abandoned = String::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let op = f.log.begin(&f.root, "stage").unwrap();
        abandoned = op.context.id.clone();
        runner::run(&f.root, ["status", "--short"]).unwrap();
        panic!("simulated failure");
    }));
    assert!(result.is_err());
    assert!(CURRENT.with(|c| c.borrow().is_empty()));
    assert_eq!(f.log.detail(&abandoned).unwrap().entry.status, "interrupted");
    let op = f.log.begin(&f.root, "fetch").unwrap();
    let id = op.context.id.clone();
    op.finish(&Ok(()));
    runner::run(&f.root, ["status", "--short"]).unwrap();
    drop(op);
    assert!(f.log.detail(&id).unwrap().steps.is_empty());
    assert_eq!(f.log.detail(&abandoned).unwrap().steps.len(), 1);
}
