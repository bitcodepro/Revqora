use super::*;
use crate::git::runner;
fn output_job(root: &Path) -> Job {
    Job {
        task: Mutex::new(Task {
            id: "a".repeat(32),
            title: "Output fixture".into(),
            prompt: "Fixture".into(),
            provider: "custom".into(),
            repository: root.to_string_lossy().into_owned(),
            path: root.join("retained-copy").to_string_lossy().into_owned(),
            branch: "fixture".into(),
            base_oid: "b".repeat(40),
            executable: String::new(),
            args: vec![],
            profile_path: String::new(),
            phase: "completed".into(),
            created_at: 1,
            elapsed_ms: 0,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
            exit_code: Some(0),
            error: None,
        }),
        output: Mutex::new((vec![], vec![])),
        cancel: AtomicBool::new(false),
        done: AtomicBool::new(true),
        clock: Instant::now(),
    }
}

#[test]
fn stopped_reader_drains_buffered_bytes_but_does_not_wait_for_an_open_pipe() {
    // This exercises the Unix WouldBlock path on every platform. A second read
    // deliberately panics, so a regression fails promptly instead of hanging CI.
    struct OpenPipe(bool);
    impl Read for OpenPipe {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            assert!(!self.0, "Reader waited again after stop + WouldBlock");
            self.0 = true;
            Err(std::io::ErrorKind::WouldBlock.into())
        }
    }
    let job = output_job(Path::new("unused"));
    let stop = AtomicBool::new(true);
    collect_output(&mut OpenPipe(false), |_| Ok(true), &job, false, &stop);
    collect_output(&mut std::io::Cursor::new(b"buffered after exit"), |_| Ok(true), &job, false, &stop);
    assert_eq!(snapshot(&job).stdout, "buffered after exit");
    struct InfinitePipe;
    impl Read for InfinitePipe {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            bytes.fill(b'x');
            Ok(bytes.len())
        }
    }
    collect_output(&mut InfinitePipe, |_| Ok(true), &job, true, &stop);
    assert_eq!(snapshot(&job).stderr.len(), OUTPUT_LIMIT);
    assert!(snapshot(&job).truncated);
}

#[test]
fn escaped_control_and_invalid_output_history_remains_readable_deletable_and_launchable() {
    let r = repo();
    let dir = store(r.path()).unwrap();
    let job = output_job(r.path());
    for (out, err) in [(0, 0), (1, 255)] {
        *job.output.lock() = (vec![out; OUTPUT_LIMIT], vec![err; OUTPUT_LIMIT]);
        let task = snapshot(&job);
        save(&dir, &task).unwrap();
        let path = dir.join(format!("{}.json", task.id));
        assert!(fs::metadata(&path).unwrap().len() > 1024 * 1024, "Fixture must exceed the old read limit");
        assert!(fs::metadata(&path).unwrap().len() <= RECORD_LIMIT as u64);
        let loaded = list(r.path()).unwrap().remove(0);
        assert_eq!(loaded.stdout, task.stdout);
        assert_eq!(loaded.stderr, task.stderr);
        let before = fs::read(&path).unwrap();
        let mut oversized = task.clone();
        oversized.stdout = "x".repeat(RECORD_LIMIT + 1);
        assert!(save(&dir, &oversized).is_err());
        assert_eq!(fs::read(&path).unwrap(), before, "Rejected serialization must preserve the previous valid record");
        forget(r.path(), &task.id).unwrap();
        assert!(list(r.path()).unwrap().is_empty());
    }
    // A large, valid previous record must not poison start's history preflight.
    save(&dir, &snapshot(&job)).unwrap();
    let task = start(r.path().to_owned(), prepare(r.path(), request("echo history-is-readable")).unwrap(), true).unwrap();
    let task = wait(r.path(), &task.id);
    assert_eq!(task.phase, "completed", "{:?}", task.error);
    forget(r.path(), &snapshot(&job).id).unwrap();
    cleanup(r.path(), &task);
}

#[cfg(unix)]
#[test]
fn detached_descendant_holding_output_cannot_keep_the_agent_queue_locked() {
    struct Escaped(i32);
    impl Drop for Escaped {
        fn drop(&mut self) {
            unsafe {
                libc::kill(self.0, libc::SIGKILL);
            }
        }
    }
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|p| p.join("node"))
        .find(|p| p.is_file())
        .expect("Node is required by the project test setup");
    let node = fs::canonicalize(node).unwrap();
    for mode in ["completed", "cancelled", "timed-out"] {
        let r = repo();
        let fixture = tempfile::tempdir().unwrap();
        let script = fixture.path().join("agent.cjs");
        let pid_file = fixture.path().join("escaped.pid");
        fs::write(&script, "const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});fs.writeFileSync(process.argv[2],String(child.pid));child.unref();if(process.argv[3]!=='completed')setInterval(()=>{},1000);").unwrap();
        let mut req = request("unused");
        req.executable = node.to_string_lossy().into_owned();
        req.args = vec![script.to_string_lossy().into_owned(), pid_file.to_string_lossy().into_owned(), mode.into()];
        req.timeout_seconds = if mode == "timed-out" { 2 } else { 120 };
        let task = start(r.path().to_owned(), prepare(r.path(), req).unwrap(), true).unwrap();
        let until = Instant::now() + Duration::from_secs(60);
        while !pid_file.exists() {
            assert!(Instant::now() < until, "Fixture did not spawn");
            thread::sleep(Duration::from_millis(15));
        }
        let pid = loop {
            if let Ok(pid) = fs::read_to_string(&pid_file).unwrap().parse::<i32>() {
                break pid;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        };
        assert!(pid > 1, "Invalid fixture process ID");
        let escaped = Escaped(pid);
        if mode == "cancelled" {
            stop(r.path(), &task.id).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !jobs().lock().get(&operations::repository_key(r.path())).unwrap().done.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "An inherited open output pipe blocked job completion");
            thread::sleep(Duration::from_millis(15));
        }
        let task = list(r.path()).unwrap().into_iter().find(|t| t.id == task.id).unwrap();
        assert_eq!(task.phase, mode, "{:?}", task.error);
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "Detached descendant must still hold the output channel during this assertion");
        let lease = lease(&store(r.path()).unwrap()).unwrap_or_else(|error| {
            panic!(
                "Agent did not release its session lease; mode={mode}; error={} {:?}; task={}",
                error.message,
                error.details,
                failure_snapshot(r.path(), &task, Path::new(&task.path))
            )
        });
        drop(lease);
        operations::run(r.path(), "agent-queue-probe", None, |_, _| {}, || Ok(())).unwrap();
        drop(escaped);
        cleanup(r.path(), &task);
    }
}
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    runner::run(r, ["init", "-q"]).unwrap();
    runner::run(r, ["config", "user.name", "Agent test"]).unwrap();
    runner::run(r, ["config", "user.email", "agent@example.invalid"]).unwrap();
    fs::write(r.join("base.txt"), "original\n").unwrap();
    runner::run(r, ["add", "."]).unwrap();
    runner::run(r, ["commit", "-qm", "base"]).unwrap();
    d
}
fn request(code: &str) -> Request {
    #[cfg(windows)]
    let (executable, args) = (
        format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", std::env::var("SystemRoot").unwrap()),
        vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), code.into()],
    );
    #[cfg(unix)]
    let (executable, args) = (fs::canonicalize("/bin/sh").unwrap().to_string_lossy().into_owned(), vec!["-c".into(), code.into()]);
    Request {
        title: "Fixture task".into(),
        provider: "custom".into(),
        executable,
        args,
        prompt: "Change only the new worktree.".into(),
        base: "HEAD".into(),
        worktree_path: None,
        timeout_seconds: 10,
    }
}
fn wait(root: &Path, id: &str) -> Task {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let rows = list(root).unwrap_or_else(|error| {
            let local = jobs().lock().get(&operations::repository_key(root)).cloned();
            let diagnostic = local.map(|job| {
                let t = snapshot(&job);
                failure_snapshot(root, &t, Path::new(&t.path))
            });
            panic!("Task history inspection failed: {} {:?}; task={diagnostic:?}", error.message, error.details)
        });
        let t = rows.into_iter().find(|t| t.id == id).unwrap();
        if !active(&t.phase) && jobs().lock().get(&operations::repository_key(root)).is_none_or(|j| j.done.load(Ordering::Acquire)) {
            return t;
        }
        assert!(Instant::now() < until, "task timeout: {}", failure_snapshot(root, &t, Path::new(&t.path)));
        thread::sleep(Duration::from_millis(30));
    }
}
fn failure_snapshot(root: &Path, task: &Task, expected: &Path) -> serde_json::Value {
    // This helper is test-only. Whitelist fields; do not Debug/serialize Task,
    // Request or Command (which contain prompts, arguments and environment).
    let record = store(root).map(|dir| dir.join(format!("{}.json", task.id)));
    let done = jobs().lock().get(&operations::repository_key(root)).is_none_or(|j| j.done.load(Ordering::Acquire));
    let registration = if done {
        crate::git::extras::worktrees(root)
            .ok()
            .map(|rows| rows.iter().any(|w| fs::canonicalize(&w.path).ok() == fs::canonicalize(&task.path).ok() && Path::new(&task.path).is_dir()))
    } else {
        None
    };
    serde_json::json!({
        "id":task.id,"phase":task.phase,"exitCode":task.exit_code,"error":task.error,
        "stdout":task.stdout.chars().take(4096).collect::<String>(),"stderr":task.stderr.chars().take(4096).collect::<String>(),"outputTruncated":task.truncated,
        "expectedPath":expected,"actualPath":task.path,"expectedPathState":path_probe(expected),"actualPathState":path_probe(Path::new(&task.path)),
        "gitMarkerState":path_probe(&Path::new(&task.path).join(".git")),"registrationPresent":registration,"workerFinished":done,
        "recordPath":record.as_ref().ok(),"recordState":record.as_ref().ok().map(|p|path_probe(p)),"recordInspectionError":record.as_ref().err().map(|e|e.message.as_str()),
    })
}
fn path_probe(path: &Path) -> serde_json::Value {
    match fs::symlink_metadata(path) {
        Ok(meta) => serde_json::json!({"exists":true,"directory":meta.is_dir(),"bytes":meta.len()}),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({"exists":false}),
        Err(error) => serde_json::json!({"exists":null,"osError":error.raw_os_error(),"error":error.to_string()}),
    }
}
fn cleanup(root: &Path, t: &Task) {
    if Path::new(&t.path).exists() {
        let _ = runner::run(root, ["worktree", "unlock", "--", &t.path]);
        runner::run(root, ["worktree", "remove", "--force", "--", &t.path]).unwrap();
    }
    let dir = store(root).unwrap();
    forget(root, &t.id).unwrap();
    jobs().lock().remove(&operations::repository_key(root));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn task_uses_separate_worktree_portable_environment_and_keeps_original_changes() {
    let r = repo();
    fs::write(r.path().join("base.txt"), "uncommitted user data\n").unwrap();
    let before = runner::run(r.path(), ["status", "--porcelain=v1"]).unwrap();
    let head = runner::run(r.path(), ["rev-parse", "HEAD"]).unwrap();
    let index = fs::read(r.path().join(".git/index")).unwrap();
    #[cfg(windows)] let code="[Console]::In.ReadToEnd() | Out-Null; [IO.File]::WriteAllText((Join-Path (Get-Location) 'agent.txt'),$env:CODEX_HOME); Write-Output 'agent-done'; [Console]::Error.WriteLine('diagnostic')";
    #[cfg(unix)]
    let code = "cat >/dev/null; printf '%s' \"$CODEX_HOME\" > agent.txt; printf agent-done; printf diagnostic >&2";
    let plan = prepare(r.path(), request(code)).unwrap();
    let t = start(r.path().to_owned(), plan.clone(), true).unwrap();
    assert!(start(r.path().to_owned(), plan.clone(), true).is_err());
    let t = wait(r.path(), &t.id);
    assert_eq!(t.phase, "completed", "{:?}", t.error);
    assert!(t.stdout.contains("agent-done"));
    assert!(t.stderr.contains("diagnostic"));
    assert_eq!(fs::read_to_string(r.path().join("base.txt")).unwrap(), "uncommitted user data\n");
    assert_eq!(runner::run(r.path(), ["status", "--porcelain=v1"]).unwrap(), before);
    assert_eq!(runner::run(r.path(), ["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(fs::read(r.path().join(".git/index")).unwrap(), index);
    assert_eq!(fs::read_to_string(Path::new(&t.path).join("agent.txt")).unwrap(), Path::new(&t.profile_path).join("codex").to_string_lossy());
    assert!(!r.path().join("agent.txt").exists());
    assert!(runner::run(r.path(), ["worktree", "list", "--porcelain"]).unwrap().contains("locked Agent task"));
    jobs().lock().remove(&operations::repository_key(r.path()));
    let restored = list(r.path()).unwrap();
    assert_eq!(restored[0].stdout, t.stdout);
    assert_eq!(restored[0].phase, "completed");
    assert!(start(r.path().to_owned(), plan, true).is_err());
    cleanup(r.path(), &t);
}
#[test]
fn stale_plan_and_missing_consent_never_run_or_create_worktree() {
    let r = repo();
    let plan = prepare(r.path(), request("echo should-not-run")).unwrap();
    assert!(start(r.path().to_owned(), plan.clone(), false).is_err());
    assert!(list(r.path()).unwrap().is_empty());
    fs::write(r.path().join("base.txt"), "changed after review").unwrap();
    let t = start(r.path().to_owned(), plan, true).unwrap();
    let t = wait(r.path(), &t.id);
    assert_eq!(t.phase, "failed");
    assert!(!Path::new(&t.path).exists());
    assert!(t.error.unwrap_or_default().contains("changed"));
    let t = list(r.path()).unwrap().remove(0);
    cleanup(r.path(), &t);
}
#[test]
fn cancellation_and_timeout_stop_process_tree_without_removing_worktree() {
    for cancel in [true, false] {
        let r = repo();
        #[cfg(windows)] let code="[Console]::In.ReadToEnd() | Out-Null; Write-Output 'started'; Start-Sleep -Seconds 20; [IO.File]::WriteAllText((Join-Path (Get-Location) 'late.txt'),'bad')";
        #[cfg(unix)]
        let code = "cat >/dev/null; printf started; sleep 20; printf bad > late.txt";
        let mut req = request(code);
        // Cancellation has its own explicit readiness handshake. Its execution
        // timeout must not race that handshake under the full parallel suite.
        req.timeout_seconds = if cancel { 120 } else { 1 };
        let p = prepare(r.path(), req).unwrap();
        let t = start(r.path().to_owned(), p, true).unwrap();
        if cancel {
            let until = Instant::now() + Duration::from_secs(60);
            loop {
                let observed = list(r.path()).unwrap().remove(0);
                if observed.stdout.contains("started") {
                    break;
                }
                assert!(active(&observed.phase), "Agent failed before its readiness signal: {} {:?}", observed.phase, observed.error);
                assert!(Instant::now() < until, "No readiness signal; phase={} error={:?}", observed.phase, observed.error);
                thread::sleep(Duration::from_millis(30));
            }
            assert!(stop(r.path(), "stale-id").is_err());
            stop(r.path(), &t.id).unwrap();
        }
        let t = wait(r.path(), &t.id);
        assert_eq!(t.phase, if cancel { "cancelled" } else { "timed-out" });
        assert!(!Path::new(&t.path).join("late.txt").exists());
        assert!(Path::new(&t.path).exists());
        cleanup(r.path(), &t);
    }
}
#[test]
fn bounded_outputs_are_drained_and_failed_exit_is_retained() {
    let r = repo();
    #[cfg(windows)]
    let code = "[Console]::In.ReadToEnd() | Out-Null; [Console]::Out.Write(('x'*300000)); [Console]::Error.Write(('y'*300000)); exit 7";
    #[cfg(unix)]
    let code = "cat >/dev/null; head -c 300000 /dev/zero | tr '\\0' x; head -c 300000 /dev/zero | tr '\\0' y >&2; exit 7";
    let t = start(r.path().to_owned(), prepare(r.path(), request(code)).unwrap(), true).unwrap();
    let t = wait(r.path(), &t.id);
    assert_eq!(t.phase, "failed");
    assert_eq!(t.exit_code, Some(7));
    assert!(t.truncated);
    assert_eq!(t.stdout.len(), OUTPUT_LIMIT);
    assert_eq!(t.stderr.len(), OUTPUT_LIMIT);
    cleanup(r.path(), &t);
}
#[test]
fn request_limits_reject_invalid_arguments_and_task_identity() {
    let r = repo();
    let mut req = request("echo harmless");
    req.args = vec!["a\0b".into()];
    assert!(prepare(r.path(), req).is_err());
    assert!(forget(r.path(), "../outside").is_err());
    let mut plan = prepare(r.path(), request("echo harmless")).unwrap();
    plan.creation.request.branch = "main".into();
    assert!(start(r.path().to_owned(), plan, true).is_err());
    assert!(list(r.path()).unwrap().is_empty());
}

#[test]
fn interrupted_history_requires_explicit_process_stop_acknowledgement() {
    let r = repo();
    let plan = prepare(r.path(), request("echo harmless")).unwrap();
    let t = start(r.path().to_owned(), plan, true).unwrap();
    let mut t = wait(r.path(), &t.id);
    jobs().lock().remove(&operations::repository_key(r.path()));
    t.phase = "running".into();
    save(&store(r.path()).unwrap(), &t).unwrap();
    assert_eq!(list(r.path()).unwrap()[0].phase, "interrupted");
    let next = prepare(r.path(), request("echo should-not-start")).unwrap();
    assert!(start(r.path().to_owned(), next, true).is_err());
    assert!(forget(r.path(), &t.id).is_err());
    assert!(acknowledge(r.path(), &t.id, false).is_err());
    acknowledge(r.path(), &t.id, true).unwrap_or_else(|error| {
        panic!(
            "Interrupted task acknowledgement failed; error={} {:?}; task={}",
            error.message,
            error.details,
            failure_snapshot(r.path(), &t, Path::new(&t.path))
        )
    });
    assert_eq!(list(r.path()).unwrap()[0].phase, "abandoned");
    cleanup(r.path(), &t);
}

#[test]
fn explicit_worktree_destination_is_reviewed_and_nested_locations_are_rejected() {
    explicit_destination_case();
}
fn explicit_destination_case() {
    let r = repo();
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("task-copy");
    let mut req = request("echo outside-copy");
    req.worktree_path = Some(target.to_string_lossy().into_owned());
    let p = prepare(r.path(), req).unwrap();
    assert_eq!(Path::new(&p.creation.request.path), target);
    let t = start(r.path().to_owned(), p, true).unwrap();
    let t = wait(r.path(), &t.id);
    assert_eq!(t.phase, "completed", "{}", failure_snapshot(r.path(), &t, &target));
    assert!(target.exists());
    cleanup(r.path(), &t);
    let mut req = request("echo never");
    req.worktree_path = Some(r.path().join("nested-copy").to_string_lossy().into_owned());
    assert!(prepare(r.path(), req).is_err());
}

#[cfg(windows)]
#[test]
fn explicit_worktree_destinations_parallel_keep_diagnostic_failures() {
    let barrier = Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                explicit_destination_case();
            })
        })
        .collect();
    let results: Vec<_> = workers.into_iter().map(|w| w.join()).collect();
    assert!(results.iter().all(Result::is_ok), "A parallel explicit-destination case failed; see its whitelisted task snapshot above");
}

#[test]
fn agent_operation_context_preserves_os_code_without_exposing_prompt_data() {
    let root = repo();
    let job = output_job(root.path());
    job.task.lock().prompt = "PRIVATE_PROMPT_SENTINEL".into();
    job.task.lock().args = vec!["PRIVATE_TOKEN_SENTINEL".into()];
    let error = context_error("stdin.clone_handle", Path::new("safe-file"), GitError::from(std::io::Error::from_raw_os_error(5)));
    job.task.lock().error = Some(error.message.clone());
    assert!(error.message.contains("stdin.clone_handle") && error.message.contains("os_error=5"));
    let snapshot = failure_snapshot(root.path(), &snapshot(&job), &root.path().join("expected"));
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("PRIVATE_"));
    assert_eq!(snapshot["recordState"]["exists"], false);
}

#[test]
fn process_exit_does_not_report_session_completion_before_cleanup_and_unlock() {
    let r = repo();
    let dir = store(r.path()).unwrap();
    let job = Arc::new(output_job(r.path()));
    job.done.store(false, Ordering::Release);
    save(&dir, &snapshot(&job)).unwrap();
    let owner = lease(&dir).unwrap();
    jobs().lock().insert(operations::repository_key(r.path()), job.clone());
    let id = job.task.lock().id.clone();
    assert_eq!(list(r.path()).unwrap()[0].phase, "running");
    assert!(forget(r.path(), &id).is_err());
    owner.release().unwrap();
    assert_eq!(list(r.path()).unwrap()[0].phase, "running", "Final journal cleanup is still active");
    job.done.store(true, Ordering::Release);
    assert_eq!(list(r.path()).unwrap()[0].phase, "completed");
    lease(&dir).unwrap().release().unwrap();
    forget(r.path(), &id).unwrap();
    jobs().lock().remove(&operations::repository_key(r.path()));
}

#[test]
fn acknowledging_a_finished_cleanup_error_clears_the_old_live_snapshot() {
    let r = repo();
    let dir = store(r.path()).unwrap();
    let job = Arc::new(output_job(r.path()));
    {
        let mut task = job.task.lock();
        task.phase = "interrupted".into();
        task.error = Some("Fixture cleanup failure".into());
    }
    let task = snapshot(&job);
    save(&dir, &task).unwrap();
    jobs().lock().insert(operations::repository_key(r.path()), job);
    assert!(acknowledge(r.path(), &task.id, false).is_err());
    acknowledge(r.path(), &task.id, true).unwrap();
    assert_eq!(list(r.path()).unwrap()[0].phase, "abandoned");
    assert!(!jobs().lock().contains_key(&operations::repository_key(r.path())));
    forget(r.path(), &task.id).unwrap();
    assert!(list(r.path()).unwrap().is_empty());
}

#[test]
fn agent_history_is_atomic_with_open_readers() {
    let r = repo();
    let dir = store(r.path()).unwrap();
    let mut task = snapshot(&output_job(r.path()));
    task.phase = "queued".into();
    save(&dir, &task).unwrap();
    let path = dir.join(format!("{}.json", task.id));
    let mut queued = File::open(&path).unwrap();
    task.phase = "running".into();
    save(&dir, &task).expect("A history reader must not prevent recording running before process launch");
    let mut running = File::open(&path).unwrap();
    task.phase = "completed".into();
    task.stdout = "finished output\n".into();
    task.exit_code = Some(0);
    save(&dir, &task).expect("A history reader must not lose an already completed task's final state");
    let old_queued: Task = serde_json::from_reader(&mut queued).unwrap();
    let old_running: Task = serde_json::from_reader(&mut running).unwrap();
    assert_eq!(old_queued.phase, "queued");
    assert_eq!(old_running.phase, "running");
    let latest = read_record(&path).unwrap();
    assert_eq!(latest.phase, "completed");
    assert_eq!(latest.stdout, task.stdout);
    assert_eq!(list(r.path()).unwrap()[0].exit_code, Some(0));
    forget(r.path(), &task.id).unwrap();
    assert!(list(r.path()).unwrap().is_empty());
}
