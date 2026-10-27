//! Queue and optimistic preconditions exercised against disposable real repositories.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use revqora_lib::git::{operations, runner, status};

struct Repo {
    dir: tempfile::TempDir,
    path: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo");
        fs::create_dir_all(&path).unwrap();
        let r = Self { dir, path };
        r.git(&["init", "-q", "-b", "main"]);
        r.git(&["config", "user.name", "Tester"]);
        r.git(&["config", "user.email", "tester@example.com"]);
        r.git(&["config", "commit.gpgsign", "false"]);
        r.git(&["config", "core.autocrlf", "false"]);
        fs::write(r.p().join("file.txt"), "initial\n").unwrap();
        r.git(&["add", "file.txt"]);
        r.git(&["commit", "-qm", "Initial"]);
        r
    }
    fn p(&self) -> &Path {
        &self.path
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(self.p(), args).unwrap().trim().into()
    }
    fn token(&self) -> String {
        status::status(self.p()).unwrap().state_token.unwrap()
    }
}

fn receive<T>(rx: &mpsc::Receiver<T>) -> T {
    rx.recv_timeout(Duration::from_secs(15)).expect("queue did not make progress")
}

#[test]
fn whole_operations_are_fifo_and_nested_git_calls_do_not_deadlock() {
    let r = Repo::new();
    let order = Arc::new(Mutex::new(Vec::new()));
    let (started, started_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let (queued, queued_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let order_a = order.clone();
        let path = r.p();
        scope.spawn(move || {
            operations::run(
                path,
                "test",
                None,
                |_, _| {},
                || {
                    runner::run(path, ["branch", "first-half"])?;
                    started.send(()).unwrap();
                    receive(&release_rx);
                    runner::run(path, ["branch", "second-half"])?;
                    order_a.lock().unwrap().push(0);
                    Ok(())
                },
            )
            .unwrap()
        });
        receive(&started_rx);
        for i in 1..=2 {
            let queued = queued.clone();
            let order = order.clone();
            scope.spawn(move || {
                operations::run(
                    path,
                    "test",
                    None,
                    |phase, ahead| {
                        if phase == "queued" {
                            queued.send((i, ahead)).unwrap();
                        }
                    },
                    || {
                        assert!(!runner::run(path, ["branch", "--list", "second-half"])?.is_empty());
                        order.lock().unwrap().push(i);
                        Ok(())
                    },
                )
                .unwrap()
            });
            let (ticket, ahead) = receive(&queued_rx);
            assert_eq!(ticket, i);
            assert_eq!(ahead, i);
        }
        release.send(()).unwrap();
    });
    assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
}

#[test]
fn linked_worktrees_share_a_queue_but_independent_repositories_do_not() {
    let r = Repo::new();
    let other = Repo::new();
    let linked = r.dir.path().join("linked");
    r.git(&["worktree", "add", "-q", "-b", "linked", linked.to_str().unwrap()]);
    fs::create_dir_all(linked.join("subdir")).unwrap();
    assert_eq!(operations::repository_key(r.p()), operations::repository_key(&linked.join("subdir")));
    let (started, started_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let (queued, queued_rx) = mpsc::channel();
    let (independent, independent_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let path = r.p();
        scope.spawn(move || {
            operations::run(
                path,
                "test",
                None,
                |_, _| {},
                || {
                    started.send(()).unwrap();
                    receive(&release_rx);
                    Ok(())
                },
            )
            .unwrap()
        });
        receive(&started_rx);
        scope.spawn(|| {
            operations::run(
                &linked,
                "test",
                None,
                |phase, ahead| {
                    if phase == "queued" {
                        queued.send(ahead).unwrap();
                    }
                },
                || runner::run(&linked, ["branch", "from-linked"]),
            )
            .unwrap()
        });
        assert_eq!(receive(&queued_rx), 1);
        scope.spawn(|| {
            operations::run(other.p(), "test", None, |_, _| {}, || runner::run(other.p(), ["branch", "independent"])).unwrap();
            independent.send(()).unwrap();
        });
        receive(&independent_rx);
        assert!(!r.p().join(".git/refs/heads/from-linked").exists());
        release.send(()).unwrap();
    });
    assert!(!r.git(&["branch", "--list", "from-linked"]).is_empty());
}

#[test]
fn queued_operation_rechecks_external_changes_after_waiting() {
    let r = Repo::new();
    let expected = r.token();
    let (started, started_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let (queued, queued_rx) = mpsc::channel();
    let (done, done_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let path = r.p();
        scope.spawn(move || {
            operations::run(
                path,
                "test",
                None,
                |_, _| {},
                || {
                    started.send(()).unwrap();
                    receive(&release_rx);
                    Ok(())
                },
            )
            .unwrap()
        });
        receive(&started_rx);
        scope.spawn(move || {
            let result = operations::run(
                path,
                "discard",
                Some(&expected),
                |phase, _| {
                    if phase == "queued" {
                        queued.send(()).unwrap();
                    }
                },
                || {
                    fs::write(path.join("file.txt"), "must never run")?;
                    Ok(())
                },
            );
            done.send(result).unwrap();
        });
        receive(&queued_rx);
        // Bypass the application's runner, exactly as an IDE or external CLI would.
        fs::write(path.join("file.txt"), "external changes\n").unwrap();
        let output = runner::command(path).args(["add", "file.txt"]).output().unwrap();
        assert!(output.status.success());
        release.send(()).unwrap();
        assert_eq!(receive(&done_rx).unwrap_err().kind, "stale-operation");
    });
    assert_eq!(fs::read_to_string(r.p().join("file.txt")).unwrap(), "external changes\n");
}

#[test]
fn content_changes_with_identical_size_and_timestamp_invalidate_the_token() {
    let r = Repo::new();
    let file = r.p().join("file.txt");
    fs::write(&file, "version one\n").unwrap();
    let modified = fs::metadata(&file).unwrap().modified().unwrap();
    let expected = r.token();
    fs::write(&file, "version two\n").unwrap();
    fs::File::options().write(true).open(&file).unwrap().set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
    let error = operations::run::<()>(r.p(), "discard", Some(&expected), |_, _| {}, || panic!("stale mutation ran")).unwrap_err();
    assert_eq!(error.kind, "stale-operation");
    assert_eq!(fs::read_to_string(file).unwrap(), "version two\n");
}

#[test]
fn external_ref_updates_are_detected_even_with_unchanged_head_and_files() {
    let r = Repo::new();
    let expected = r.token();
    let output = runner::command(r.p()).args(["branch", "external"]).output().unwrap();
    assert!(output.status.success());
    assert_eq!(operations::run(r.p(), "reset", Some(&expected), |_, _| {}, || Ok(())).unwrap_err().kind, "stale-operation");
}

#[test]
fn index_storage_layout_does_not_invalidate_unchanged_staged_contents() {
    let r = Repo::new();
    let before = r.token();
    r.git(&["update-index", "--index-version", "4"]);
    assert_eq!(before, r.token());
}

#[test]
fn status_reads_have_monotonic_versions_even_without_a_mutation() {
    let r = Repo::new();
    let before = status::status(r.p()).unwrap();
    let after = status::status(r.p()).unwrap();
    assert_eq!(before.state_token, after.state_token);
    assert!(after.state_version > before.state_version);
}

#[test]
fn failure_and_panic_release_the_queue_and_thread_scope() {
    let r = Repo::new();
    assert!(operations::run(r.p(), "test", None, |_, _| {}, || Err::<(), _>(runner::GitError::new("expected"))).is_err());
    let panic = std::panic::catch_unwind(|| {
        let _ = operations::run(r.p(), "test", None, |_, _| {}, || -> runner::GitResult<()> { panic!("expected panic") });
    });
    assert!(panic.is_err());
    operations::run(r.p(), "test", None, |_, _| {}, || runner::run(r.p(), ["branch", "after-failure"])).unwrap();
}

#[test]
fn status_does_not_rewrite_index_and_read_scopes_cannot_upgrade() {
    let r = Repo::new();
    let index = r.p().join(".git/index");
    let before = fs::read(&index).unwrap();
    let modified = fs::metadata(&index).unwrap().modified().unwrap();
    r.token();
    assert_eq!(before, fs::read(&index).unwrap());
    assert_eq!(modified, fs::metadata(&index).unwrap().modified().unwrap());
    let result = operations::read(r.p(), || runner::run(r.p(), ["branch", "not-allowed"]));
    assert_eq!(result.unwrap_err().kind, "operation-scope");
}

#[test]
fn ordinary_commit_cannot_complete_a_pending_merge_without_confirmation() {
    let r = Repo::new();
    fs::write(r.p().join(".git/MERGE_HEAD"), r.git(&["rev-parse", "HEAD"])).unwrap();
    assert_eq!(
        operations::run(r.p(), "commit", None, |_, _| {}, || revqora_lib::git::ops::commit(r.p(), "unexpected merge", &Default::default())).unwrap_err().kind,
        "operation-in-progress"
    );
    operations::run(r.p(), "op_continue", None, |_, _| {}, || Ok(())).unwrap();
}

#[test]
fn inspected_views_capture_current_state_instead_of_a_preceding_ui_cache() {
    let r = Repo::new();
    let old = r.token();
    fs::write(r.p().join("file.txt"), "new editor contents\n").unwrap();
    let (contents, observed) = operations::inspect(r.p(), || Ok(fs::read_to_string(r.p().join("file.txt"))?)).unwrap();
    assert_eq!(contents, "new editor contents\n");
    assert_ne!(old, observed);
    operations::run(r.p(), "test", Some(&observed), |_, _| {}, || Ok(())).unwrap();
}

#[test]
fn external_changes_during_view_loading_require_a_reload() {
    let r = Repo::new();
    let result = operations::inspect(r.p(), || {
        fs::write(r.p().join("file.txt"), "external IDE update\n")?;
        Ok(())
    });
    assert_eq!(result.unwrap_err().kind, "stale-operation");
}
