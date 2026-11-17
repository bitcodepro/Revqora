//! Repository locking while Git waits on a remote.
//!
//! A writer waiting for the network holds the repository lock shared: reads (status, history,
//! diffs) continue, other writers keep waiting in FIFO order, and the writer takes the lock
//! exclusively again before its next local step. These tests use a local remote whose
//! upload-pack/receive-pack first sleeps, so every network phase is long and observable.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

use revqora_lib::git::{operations, ops, runner, status};

const DELAY: u64 = 4;

struct Fixture {
    _tmp: tempfile::TempDir,
    remote: PathBuf,
    /// Another clone that pushes upstream changes.
    other: PathBuf,
    /// The clone the app works in.
    work: PathBuf,
}

fn git(dir: &Path, args: &[&str]) -> String {
    runner::run(dir, args.iter().copied()).unwrap_or_else(|e| panic!("git {args:?}: {e:?}"))
}

fn commit(dir: &Path, message: &str) -> String {
    std::fs::write(dir.join(format!("{message}.txt")), message).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (remote, other, work) = (root.join("remote.git"), root.join("other"), root.join("work"));
    git(root, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(root, &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]);
    commit(&other, "first");
    git(&other, &["push", "-q", "origin", "HEAD:main"]);
    git(root, &["clone", "-q", remote.to_str().unwrap(), work.to_str().unwrap()]);
    git(&work, &["config", "user.name", "T"]);
    git(&work, &["config", "user.email", "t@example.invalid"]);
    git(&work, &["config", "commit.gpgsign", "false"]);
    Fixture { _tmp: tmp, remote, other, work }
}

/// Every fetch and push of `work` first waits `DELAY` seconds on the "server".
fn slow_remote(work: &Path) {
    git(work, &["config", "remote.origin.uploadpack", &format!("sleep {DELAY}; git-upload-pack")]);
    git(work, &["config", "remote.origin.receivepack", &format!("sleep {DELAY}; git-receive-pack")]);
}

fn wait_for(what: &str, condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < Duration::from_secs(60), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Starts `op` on a thread and returns once it waits on the remote.
fn start_network_op(
    work: &Path,
    command: &'static str,
    op: impl FnOnce(&Path) -> Result<(), runner::GitError> + Send + 'static,
) -> (std::thread::JoinHandle<Result<(), runner::GitError>>, Arc<AtomicBool>) {
    let done = Arc::new(AtomicBool::new(false));
    let (path, finished) = (work.to_owned(), done.clone());
    let handle = std::thread::spawn(move || {
        operations::run(
            &path,
            command,
            None,
            |_, _| {},
            || {
                let result = op(&path);
                // Set while the writer still holds its turn, so the next writer always sees it.
                finished.store(true, Ordering::SeqCst);
                result
            },
        )
    });
    wait_for("the network phase", || operations::network_active(work) || done.load(Ordering::SeqCst));
    assert!(!done.load(Ordering::SeqCst), "{command} finished before its network phase was observed");
    (handle, done)
}

/// Reads during the network phase finish while the network operation is still running.
fn assert_reads_continue(work: &Path, network_done: &AtomicBool) {
    let started = Instant::now();
    let s = status::status(work).expect("status during the network phase");
    assert!(s.state_token.is_some());
    runner::run(work, ["log", "--oneline", "-5", "--all"]).expect("history during the network phase");
    runner::run(work, ["for-each-ref"]).expect("refs during the network phase");
    assert!(!network_done.load(Ordering::SeqCst), "reads waited for the network ({:?})", started.elapsed());
}

fn no_lock_files(dir: &Path) {
    for entry in walk(dir) {
        let name = entry.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.ends_with(".lock"), "left a lock file: {}", entry.display());
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[test]
fn reads_continue_while_fetch_waits_for_the_remote() {
    let f = fixture();
    let upstream = commit(&f.other, "upstream");
    git(&f.other, &["push", "-q", "origin", "HEAD:main"]);
    slow_remote(&f.work);
    let (handle, done) = start_network_op(&f.work, "fetch", |w| ops::fetch(w, None, true, |_| {}).map(drop));
    assert_reads_continue(&f.work, &done);
    handle.join().unwrap().unwrap();
    assert_eq!(git(&f.work, &["rev-parse", "origin/main"]).trim(), upstream);
    assert!(!operations::network_active(&f.work) && !operations::writer_active(&f.work));
    no_lock_files(&f.work.join(".git"));
}

#[test]
fn reads_continue_while_push_waits_for_the_remote() {
    let f = fixture();
    let local = commit(&f.work, "local");
    slow_remote(&f.work);
    let push = ops::PushOptions {
        remote: Some("origin".into()),
        branch: Some("main".into()),
        remote_branch: Some("main".into()),
        set_upstream: false,
        force_with_lease: false,
        tags: false,
    };
    let (handle, done) = start_network_op(&f.work, "push", move |w| ops::push(w, &push, |_| {}).map(drop));
    assert_reads_continue(&f.work, &done);
    handle.join().unwrap().unwrap();
    assert_eq!(git(&f.remote, &["rev-parse", "main"]).trim(), local);
    assert_eq!(git(&f.work, &["rev-parse", "origin/main"]).trim(), local);
    no_lock_files(&f.work.join(".git"));
}

#[test]
fn reads_continue_while_pull_fetches_and_the_pull_still_applies_safely() {
    let f = fixture();
    let upstream = commit(&f.other, "upstream");
    git(&f.other, &["push", "-q", "origin", "HEAD:main"]);
    std::fs::write(f.work.join("notes.txt"), "uncommitted work").unwrap();
    slow_remote(&f.work);
    let (handle, done) = start_network_op(&f.work, "pull", |w| ops::pull_with_prune(w, "ff-only", true, |_| {}).map(drop));
    assert_reads_continue(&f.work, &done);
    handle.join().unwrap().unwrap();
    assert_eq!(git(&f.work, &["rev-parse", "HEAD"]).trim(), upstream);
    assert_eq!(std::fs::read_to_string(f.work.join("notes.txt")).unwrap(), "uncommitted work");
    assert!(!operations::network_active(&f.work) && !operations::writer_active(&f.work));
    no_lock_files(&f.work.join(".git"));
}

#[test]
fn reads_continue_while_background_fetch_waits_for_the_remote() {
    let f = fixture();
    let upstream = commit(&f.other, "upstream");
    git(&f.other, &["push", "-q", "origin", "HEAD:main"]);
    slow_remote(&f.work);
    let (handle, done) = start_network_op(&f.work, "fetch_background", |w| ops::fetch_background(w).map(drop));
    assert_reads_continue(&f.work, &done);
    handle.join().unwrap().unwrap();
    assert_eq!(git(&f.work, &["rev-parse", "origin/main"]).trim(), upstream);
}

#[test]
fn writers_wait_for_a_network_operation_in_fifo_order() {
    let f = fixture();
    slow_remote(&f.work);
    let (handle, done) = start_network_op(&f.work, "fetch", |w| ops::fetch(w, None, true, |_| {}).map(drop));
    let order = Arc::new(Mutex::new(vec![]));
    let mut writers = vec![];
    for name in ["second", "third"] {
        let (path, order, done) = (f.work.clone(), order.clone(), done.clone());
        writers.push(std::thread::spawn(move || {
            operations::run(
                &path,
                "checkout",
                None,
                |_, _| {},
                || {
                    // A writer never runs while the network operation is unfinished.
                    assert!(done.load(Ordering::SeqCst), "{name} ran during another writer's network phase");
                    assert!(!operations::network_active(&path));
                    runner::run(&path, ["update-ref", &format!("refs/heads/{name}"), "HEAD"])?;
                    order.lock().unwrap().push(name);
                    Ok(())
                },
            )
        }));
        // Queue `second` before `third`.
        wait_for("the writer to queue", || operations::writer_active(&f.work));
        std::thread::sleep(Duration::from_millis(200));
    }
    handle.join().unwrap().unwrap();
    for w in writers {
        w.join().unwrap().unwrap();
    }
    assert_eq!(*order.lock().unwrap(), ["second", "third"]);
    assert!(!operations::writer_active(&f.work));
}

#[test]
fn a_state_token_read_during_a_fetch_is_refused_after_the_refs_moved() {
    let f = fixture();
    commit(&f.other, "upstream");
    git(&f.other, &["push", "-q", "origin", "HEAD:main"]);
    slow_remote(&f.work);
    let before = git(&f.work, &["rev-parse", "HEAD"]);
    let (handle, done) = start_network_op(&f.work, "fetch", |w| ops::fetch(w, None, true, |_| {}).map(drop));
    let token = status::status(&f.work).unwrap().state_token.unwrap();
    assert!(!done.load(Ordering::SeqCst));
    handle.join().unwrap().unwrap();
    let applied = AtomicBool::new(false);
    let error = operations::run(
        &f.work,
        "checkout",
        Some(&token),
        |_, _| {},
        || {
            applied.store(true, Ordering::SeqCst);
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, "stale-operation");
    assert!(!applied.load(Ordering::SeqCst));
    assert_eq!(git(&f.work, &["rev-parse", "HEAD"]), before);
}

#[test]
fn local_steps_after_the_network_block_reads_again() {
    let f = fixture();
    slow_remote(&f.work);
    let leaving = Arc::new(AtomicBool::new(false));
    let local_step = Arc::new(AtomicBool::new(false));
    let (path, leaving2, local2) = (f.work.clone(), leaving.clone(), local_step.clone());
    let op = std::thread::spawn(move || {
        operations::run(
            &path,
            "pull",
            None,
            |_, _| {},
            || {
                ops::fetch(&path, None, true, |_| {})?;
                local2.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(1500));
                leaving2.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
    });
    wait_for("the local step", || local_step.load(Ordering::SeqCst));
    status::status(&f.work).unwrap();
    assert!(leaving.load(Ordering::SeqCst), "a read ran during the writer's exclusive local step");
    op.join().unwrap().unwrap();
}

#[test]
fn a_panic_while_waiting_on_the_remote_restores_the_lock() {
    let f = fixture();
    let path = f.work.clone();
    let result = std::panic::catch_unwind(move || {
        operations::run(&path, "fetch", None, |_, _| {}, || -> Result<(), runner::GitError> { operations::network(&path, || panic!("network failure")) })
    });
    assert!(result.is_err());
    assert!(!operations::network_active(&f.work));
    assert!(!operations::writer_active(&f.work));
    // Both a writer and a reader get the lock at once.
    let start = Instant::now();
    operations::run(&f.work, "checkout", None, |_, _| {}, || runner::run(&f.work, ["update-ref", "refs/heads/after", "HEAD"]).map(drop)).unwrap();
    status::status(&f.work).unwrap();
    assert!(start.elapsed() < Duration::from_secs(20));
}

#[test]
fn nested_and_parallel_network_sections_restore_the_exclusive_lock_once() {
    let f = fixture();
    let path = f.work.clone();
    let leaving = Arc::new(AtomicBool::new(false));
    let after_sections = Arc::new(AtomicBool::new(false));
    let (leaving2, after2) = (leaving.clone(), after_sections.clone());
    let op = std::thread::spawn(move || {
        operations::run(
            &path,
            "fetch",
            None,
            |_, _| {},
            || {
                // Nested sections on one thread.
                operations::network(&path, || {
                    operations::network(&path, || {
                        let reader = path.clone();
                        std::thread::spawn(move || status::status(&reader).unwrap()).join().unwrap();
                    })
                });
                // Parallel sections on helper threads of the same transaction.
                let parent = operations::Inherited::of(&path);
                let barrier = Barrier::new(2);
                std::thread::scope(|scope| {
                    for _ in 0..2 {
                        scope.spawn(|| {
                            parent.run(|| {
                                operations::network(&path, || {
                                    barrier.wait();
                                    let reader = path.clone();
                                    std::thread::spawn(move || status::status(&reader).unwrap()).join().unwrap();
                                })
                            })
                        });
                    }
                });
                assert!(!operations::network_active(&path));
                after2.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(1000));
                leaving2.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
    });
    wait_for("the sections to end", || after_sections.load(Ordering::SeqCst));
    status::status(&f.work).unwrap();
    assert!(leaving.load(Ordering::SeqCst), "the exclusive lock was not restored after the network sections");
    op.join().unwrap().unwrap();
}

#[test]
fn network_sections_outside_a_write_transaction_change_nothing() {
    let f = fixture();
    assert_eq!(operations::network(&f.work, || 7), 7);
    let value = operations::read(&f.work, || Ok(operations::network(&f.work, || 42))).unwrap();
    assert_eq!(value, 42);
    assert!(!operations::network_active(&f.work));
    // A fetch called without an enclosing operation takes the writer turn itself and still
    // lets reads run while it waits.
    slow_remote(&f.work);
    let done = Arc::new(AtomicBool::new(false));
    let (path, finished) = (f.work.clone(), done.clone());
    let fetch = std::thread::spawn(move || {
        let result = ops::fetch(&path, None, true, |_| {});
        finished.store(true, Ordering::SeqCst);
        result
    });
    wait_for("the network phase", || operations::network_active(&f.work));
    assert_reads_continue(&f.work, &done);
    fetch.join().unwrap().unwrap();
}

#[test]
fn a_timed_out_background_fetch_releases_the_repository_without_lock_files() {
    let f = fixture();
    commit(&f.other, "upstream");
    git(&f.other, &["push", "-q", "origin", "HEAD:main"]);
    let before = git(&f.work, &["rev-parse", "origin/main"]);
    git(&f.work, &["config", "remote.origin.uploadpack", "sleep 30; git-upload-pack"]);
    let start = Instant::now();
    let path = f.work.clone();
    let error =
        operations::run(&f.work, "fetch_background", None, |_, _| {}, || ops::fetch_background_with_deadline(&path, Duration::from_secs(2))).unwrap_err();
    assert_eq!(error.kind, "git-timeout", "{error:?}");
    assert!(start.elapsed() < Duration::from_secs(25));
    assert!(!operations::writer_active(&f.work) && !operations::network_active(&f.work));
    assert_eq!(git(&f.work, &["rev-parse", "origin/main"]), before);
    no_lock_files(&f.work.join(".git"));
    operations::run(&f.work, "checkout", None, |_, _| {}, || runner::run(&f.work, ["update-ref", "refs/heads/after", "HEAD"]).map(drop)).unwrap();
}

#[test]
fn writer_active_reports_running_and_queued_writers() {
    let f = fixture();
    assert!(!operations::writer_active(&f.work));
    let started = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let (path, started2, release2) = (f.work.clone(), started.clone(), release.clone());
    let op = std::thread::spawn(move || {
        operations::run(
            &path,
            "checkout",
            None,
            |_, _| {},
            || {
                started2.store(true, Ordering::SeqCst);
                while !release2.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(())
            },
        )
    });
    wait_for("the writer", || started.load(Ordering::SeqCst));
    assert!(operations::writer_active(&f.work));
    release.store(true, Ordering::SeqCst);
    op.join().unwrap().unwrap();
    assert!(!operations::writer_active(&f.work));
}

#[test]
fn a_background_fetch_and_a_pull_at_the_same_time_both_complete() {
    let f = fixture();
    let upstream = commit(&f.other, "upstream");
    git(&f.other, &["push", "-q", "origin", "HEAD:main"]);
    slow_remote(&f.work);
    let (a, b) = (f.work.clone(), f.work.clone());
    let background = std::thread::spawn(move || operations::run(&a, "fetch_background", None, |_, _| {}, || ops::fetch_background(&a)));
    let pull = std::thread::spawn(move || operations::run(&b, "pull", None, |_, _| {}, || ops::pull_with_prune(&b, "ff-only", true, |_| {})));
    background.join().unwrap().unwrap();
    pull.join().unwrap().unwrap();
    assert_eq!(git(&f.work, &["rev-parse", "HEAD"]).trim(), upstream);
    no_lock_files(&f.work.join(".git"));
}

#[test]
fn runner_recognizes_network_commands() {
    assert!(runner::is_network(&["fetch", "--all"]));
    assert!(runner::is_network(&["-c", "a=b", "push", "origin"]));
    assert!(runner::is_network(&["ls-remote", "origin"]));
    assert!(!runner::is_network(&["status"]));
    assert!(!runner::is_network(&["-c", "remote.origin.url=fetch", "config", "--get", "x"]));
    assert!(!runner::is_network(&["clone", "x"]));
}

/// Many readers (status, refs, history) run while writers fetch, commit, push and fetch in the
/// background against a slow remote. Nothing may deadlock: a writer that waits for readers to
/// leave after its network section must never be waited for by those readers.
#[test]
fn mixed_reads_writes_and_network_waits_never_deadlock() {
    let f = fixture();
    git(&f.work, &["config", "remote.origin.uploadpack", "sleep 1; git-upload-pack"]);
    git(&f.work, &["config", "remote.origin.receivepack", "sleep 1; git-receive-pack"]);
    let stop = Arc::new(AtomicBool::new(false));
    let (done, finished) = std::sync::mpsc::channel::<String>();
    let mut workers = vec![];
    for reader in 0..4 {
        let (path, stop, done) = (f.work.clone(), stop.clone(), done.clone());
        workers.push(std::thread::spawn(move || {
            let mut rounds = 0;
            while !stop.load(Ordering::SeqCst) {
                status::status(&path).expect("status");
                revqora_lib::git::refs::snapshot(&path).expect("refs");
                revqora_lib::git::repo::head(&path).expect("head");
                revqora_lib::git::graph::load_commits(&path, None, 50, false).expect("history");
                rounds += 1;
            }
            done.send(format!("reader {reader}: {rounds} rounds")).unwrap();
        }));
    }
    {
        let (path, stop, done) = (f.work.clone(), stop.clone(), done.clone());
        workers.push(std::thread::spawn(move || {
            let mut rounds = 0;
            while !stop.load(Ordering::SeqCst) {
                operations::run(&path, "fetch", None, |_, _| {}, || ops::fetch(&path, None, true, |_| {}).map(drop)).expect("fetch");
                operations::run(
                    &path,
                    "commit",
                    None,
                    |_, _| {},
                    || {
                        std::fs::write(path.join(format!("stress-{rounds}.txt")), "x").unwrap();
                        runner::run(&path, ["add", "-A"])?;
                        runner::run(&path, ["commit", "-qm", "stress"]).map(drop)
                    },
                )
                .expect("commit");
                let push = ops::PushOptions {
                    remote: Some("origin".into()),
                    branch: Some("main".into()),
                    remote_branch: Some("main".into()),
                    set_upstream: false,
                    force_with_lease: false,
                    tags: false,
                };
                operations::run(&path, "push", None, |_, _| {}, || ops::push(&path, &push, |_| {}).map(drop)).expect("push");
                rounds += 1;
                // Leave gaps, as a user does, so automatic fetch also gets turns.
                std::thread::sleep(Duration::from_millis(700));
            }
            done.send(format!("writer: {rounds} rounds")).unwrap();
        }));
    }
    {
        let (path, stop, done) = (f.work.clone(), stop.clone(), done.clone());
        workers.push(std::thread::spawn(move || {
            let (mut fetched, mut skipped) = (0, 0);
            while !stop.load(Ordering::SeqCst) {
                // As the app does: automatic fetch skips while another writer is active.
                if operations::writer_active(&path) {
                    skipped += 1;
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                operations::run(&path, "fetch_background", None, |_, _| {}, || ops::fetch_background(&path)).expect("background fetch");
                fetched += 1;
            }
            done.send(format!("background fetch: {fetched} fetched, {skipped} skipped")).unwrap();
        }));
    }
    std::thread::sleep(Duration::from_secs(12));
    stop.store(true, Ordering::SeqCst);
    for _ in 0..workers.len() {
        match finished.recv_timeout(Duration::from_secs(90)) {
            Ok(report) => eprintln!("{report}"),
            Err(_) => panic!("a reader or writer did not finish: the repository lock deadlocked"),
        }
    }
    for w in workers {
        w.join().unwrap();
    }
    assert!(!operations::writer_active(&f.work) && !operations::network_active(&f.work));
    assert_eq!(git(&f.work, &["rev-parse", "HEAD"]), git(&f.remote, &["rev-parse", "main"]));
    assert_eq!(git(&f.work, &["rev-parse", "origin/main"]), git(&f.remote, &["rev-parse", "main"]));
    no_lock_files(&f.work.join(".git"));
}
