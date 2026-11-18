//! Time to fill the Explorer's Incoming and Outgoing filters for a library of repositories:
//! the refs-only branch tracking against the full sidebar status. Ignored by default:
//! `cargo test --test library_tracking_timing -- --ignored --nocapture`
//! Set REVQORA_TIMING_REPOSITORIES / REVQORA_TIMING_FILES to change the fixture size.

use std::path::{Path, PathBuf};
use std::time::Instant;

use revqora_lib::git::{runner, status, tracking};

fn git(dir: &Path, args: &[&str]) {
    runner::run(dir, args.iter().copied()).unwrap_or_else(|e| panic!("git {args:?}: {e:?}"));
}
fn env_count(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Runs `read` for every repository, six at a time like the UI, and returns milliseconds.
fn sweep(repos: &[PathBuf], read: fn(&Path)) -> u128 {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let started = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..6 {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let Some(repo) = repos.get(index) else { break };
                read(repo);
            });
        }
    });
    started.elapsed().as_millis()
}

#[test]
#[ignore]
fn library_tracking_compared_with_sidebar_status() {
    let count = env_count("REVQORA_TIMING_REPOSITORIES", 40);
    let files = env_count("REVQORA_TIMING_FILES", 2_000);
    let fixture = tempfile::tempdir().unwrap();
    let origin = fixture.path().join("origin.git");
    git(fixture.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    let seed = fixture.path().join("seed");
    std::fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-qb", "main"]);
    for i in 0..files {
        let dir = seed.join(format!("dir{}", i % 50));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("file{i}.txt")), format!("{i}\n")).unwrap();
    }
    git(&seed, &["add", "-A"]);
    git(&seed, &["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "seed"]);
    git(&seed, &["push", "-q", origin.to_str().unwrap(), "main"]);
    let repos: Vec<PathBuf> = (0..count)
        .map(|i| {
            let repo = fixture.path().join(format!("repo-{i:02}"));
            git(fixture.path(), &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]);
            // Some untracked files, as in a real working copy.
            for j in 0..20 {
                std::fs::write(repo.join(format!("untracked-{j}.log")), "x").unwrap();
            }
            if i % 13 == 0 {
                git(&repo, &["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "to push"]);
            }
            repo
        })
        .collect();
    // Warm the file system cache once, then measure each sweep three times.
    sweep(&repos, |repo| drop(status::sidebar_status(repo).unwrap()));
    for round in 1..=3 {
        let status_ms = sweep(&repos, |repo| drop(status::sidebar_status(repo).unwrap()));
        let tracking_ms = sweep(&repos, |repo| assert!(tracking::branch_tracking(repo).unwrap().branch.is_some()));
        println!("round {round}: {count} repositories × {files} files: sidebar status {status_ms} ms, branch tracking {tracking_ms} ms");
    }
    let outgoing = repos.iter().filter(|repo| tracking::branch_tracking(repo).unwrap().ahead > 0).count();
    assert_eq!(outgoing, count.div_ceil(13));
}
