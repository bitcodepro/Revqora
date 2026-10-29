use revqora_lib::git::{operations, recovery, runner, status, validation};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("проверка");
        fs::create_dir(&root).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
            vec!["config", "core.autocrlf", "false"],
        ] {
            git(&root, &args);
        }
        fs::write(root.join("f.txt"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "Base"]);
        Self { _temp: temp, root }
    }
    fn token(&self) -> String {
        status::status(&self.root).unwrap().state_token.unwrap()
    }
    fn start(&self, command: &str, timeout: u64) -> validation::Report {
        validation::start(self.root.clone(), command.into(), self.token(), timeout).unwrap()
    }
    fn finish(&self) -> validation::Report {
        wait(|| {
            let r = validation::report(&self.root).unwrap();
            (!matches!(r.phase.as_str(), "queued" | "running")).then_some(r)
        })
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap().trim().into()
}
fn wait<T>(mut f: impl FnMut() -> Option<T>) -> T {
    let start = Instant::now();
    loop {
        if let Some(r) = f() {
            return r;
        }
        assert!(start.elapsed() < Duration::from_secs(30), "Timed out");
        thread::sleep(Duration::from_millis(30));
    }
}
fn child_command(root: &Path) -> String {
    let exe = std::env::current_exe().unwrap().to_string_lossy().into_owned();
    #[cfg(windows)]
    return format!("set \"REVQORA_CHECK_HEARTBEAT={}\" && \"{}\" --ignored --exact validation_child --nocapture", root.join("heartbeat").display(), exe);
    #[cfg(unix)]
    return format!(
        "REVQORA_CHECK_HEARTBEAT='{}' '{}' --ignored --exact validation_child --nocapture",
        root.join("heartbeat").display(),
        exe.replace('\'', "'\\''")
    );
}
#[test]
fn success_failure_output_and_current_state() {
    let r = Repo::new();
    let token = r.token();
    r.start("echo hello && echo warning >&2", 30);
    let done = r.finish();
    assert_eq!(done.phase, "passed", "{:?}", done.error);
    assert_eq!(done.exit_code, Some(0));
    assert!(done.stdout.contains("hello"));
    assert!(done.stderr.contains("warning"));
    assert_eq!(done.before_state.as_deref(), Some(token.as_str()));
    assert_eq!(done.after_state, done.before_state);
    assert_eq!(r.token(), token);
    r.start("exit 7", 30);
    let done = r.finish();
    assert_eq!(done.phase, "failed");
    assert_eq!(done.exit_code, Some(7));
    assert!(recovery::list(&r.root).unwrap().checkpoints.iter().any(|cp| cp.command == "conflict_validation"));
}
#[test]
fn writes_invalidate_check_and_checkpoint_keeps_manual_edits() {
    let r = Repo::new();
    fs::write(r.root.join("f.txt"), "manual edits\n").unwrap();
    r.start("echo changed> f.txt", 30);
    let done = r.finish();
    assert_eq!(done.phase, "passed");
    assert_ne!(done.before_state, done.after_state);
    let catalog = recovery::list(&r.root).unwrap();
    assert!(catalog.checkpoints.iter().any(|c| c.command == "conflict_validation" && c.workspace));
}
#[test]
fn stale_precondition_does_not_execute_user_code() {
    let r = Repo::new();
    let expected = r.token();
    fs::write(r.root.join("f.txt"), "external edit\n").unwrap();
    validation::start(r.root.clone(), "echo should-not-run> marker".into(), expected, 30).unwrap();
    let done = r.finish();
    assert_eq!(done.phase, "failed");
    assert!(done.error.unwrap().contains("repository changed"));
    assert!(!r.root.join("marker").exists());
}
#[test]
fn cancellation_stops_descendants_and_releases_writer_queue() {
    let r = Repo::new();
    let started = r.start(&child_command(&r.root), 30);
    wait(|| {
        let result = validation::report(&r.root).unwrap();
        assert!(matches!(result.phase.as_str(), "queued" | "running"), "{result:?}");
        r.root.join("heartbeat").exists().then_some(())
    });
    assert!(validation::start(r.root.clone(), "echo duplicate".into(), r.token_without_lock(), 30).is_err());
    validation::cancel(&r.root, &started.id).unwrap();
    let done = r.finish();
    assert_eq!(done.phase, "cancelled");
    let beat = fs::read(r.root.join("heartbeat")).unwrap();
    thread::sleep(Duration::from_millis(250));
    assert_eq!(fs::read(r.root.join("heartbeat")).unwrap(), beat);
    operations::access(&r.root, true, |_, _| {}, || Ok(())).unwrap();
}
impl Repo {
    fn token_without_lock(&self) -> String {
        validation::report(&self.root).unwrap().before_state.unwrap()
    }
}
#[test]
fn timeout_stops_command_and_records_result() {
    let r = Repo::new();
    r.start(&child_command(&r.root), 1);
    let done = r.finish();
    assert_eq!(done.phase, "timed-out", "{done:?}");
    let beat = fs::read(r.root.join("heartbeat")).unwrap();
    thread::sleep(Duration::from_millis(250));
    assert_eq!(fs::read(r.root.join("heartbeat")).unwrap(), beat);
}

#[test]
fn bounded_output_is_drained_without_blocking_the_child() {
    let r = Repo::new();
    let command = child_command(&r.root).replace("--exact validation_child", "--exact validation_loud_child");
    r.start(&command, 30);
    let done = r.finish();
    assert_eq!(done.phase, "passed", "{done:?}");
    assert!(done.truncated);
    assert_eq!(done.stdout.len(), 128 * 1024);
    assert_eq!(done.stderr.len(), 128 * 1024);
}

#[test]
#[ignore = "subprocess helper, invoked by validation tests"]
fn validation_loud_child() {
    print!("{}", "x".repeat(300_000));
    eprint!("{}", "y".repeat(300_000));
}
#[test]
#[ignore = "subprocess helper, invoked by validation tests"]
fn validation_child() {
    let path = std::env::var("REVQORA_CHECK_HEARTBEAT").unwrap();
    for n in 0..500 {
        fs::write(&path, n.to_string()).unwrap();
        thread::sleep(Duration::from_millis(30));
    }
}
