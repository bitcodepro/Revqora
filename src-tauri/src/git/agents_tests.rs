use super::*;
use crate::git::runner;
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
        let t = list(root).unwrap().into_iter().find(|t| t.id == id).unwrap();
        if !active(&t.phase) && jobs().lock().get(&operations::repository_key(root)).is_none_or(|j| j.done.load(Ordering::Acquire)) {
            return t;
        }
        assert!(Instant::now() < until, "task timeout: {} {:?}", t.phase, t.error);
        thread::sleep(Duration::from_millis(30));
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
    acknowledge(r.path(), &t.id, true).unwrap();
    assert_eq!(list(r.path()).unwrap()[0].phase, "abandoned");
    cleanup(r.path(), &t);
}

#[test]
fn explicit_worktree_destination_is_reviewed_and_nested_locations_are_rejected() {
    let r = repo();
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("task-copy");
    let mut req = request("echo outside-copy");
    req.worktree_path = Some(target.to_string_lossy().into_owned());
    let p = prepare(r.path(), req).unwrap();
    assert_eq!(Path::new(&p.creation.request.path), target);
    let t = start(r.path().to_owned(), p, true).unwrap();
    let t = wait(r.path(), &t.id);
    assert_eq!(t.phase, "completed", "{:?}", t.error);
    assert!(target.exists());
    cleanup(r.path(), &t);
    let mut req = request("echo never");
    req.worktree_path = Some(r.path().join("nested-copy").to_string_lossy().into_owned());
    assert!(prepare(r.path(), req).is_err());
}
