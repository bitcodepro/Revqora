//! Local overhead of Fetch, Pull and Push compared with plain Git, against a local remote so the
//! network does not hide it. Ignored by default:
//! `cargo test --test remote_ops_timing -- --ignored --nocapture`
//! Set REVQORA_TIMING_BRANCHES / REVQORA_TIMING_DIRTY to change the fixture size.

use std::path::Path;
use std::time::Instant;

use revqora_lib::git::{operations, ops, runner};

fn git(dir: &Path, args: &[&str]) -> String {
    runner::run(dir, args.iter().copied()).unwrap_or_else(|e| panic!("git {args:?}: {e:?}"))
}
fn commit(dir: &Path, message: &str) {
    git(dir, &["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", message]);
}
fn env_count(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Runs `f` and returns (milliseconds, git processes started), counted with a trace2 directory.
fn measure(traces: &Path, f: impl FnOnce()) -> (u128, usize) {
    let _ = std::fs::remove_dir_all(traces);
    std::fs::create_dir_all(traces).unwrap();
    std::env::set_var("GIT_TRACE2_EVENT", traces);
    let t = Instant::now();
    f();
    let ms = t.elapsed().as_millis();
    std::env::remove_var("GIT_TRACE2_EVENT");
    let files: Vec<_> = std::fs::read_dir(traces).unwrap().flatten().collect();
    if std::env::var_os("REVQORA_TIMING_DETAIL").is_some() {
        // One line per git process: its elapsed time and arguments.
        let mut rows = vec![];
        for f in &files {
            let text = std::fs::read_to_string(f.path()).unwrap_or_default();
            let mut argv = String::new();
            let mut secs = 0.0;
            let mut started = String::new();
            for line in text.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                match v["event"].as_str() {
                    Some("start") if argv.is_empty() => {
                        started = v["time"].as_str().unwrap_or_default().to_string();
                        argv = v["argv"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .skip(1)
                                    .filter_map(|x| x.as_str())
                                    .filter(|x| !x.starts_with("-c") && !x.contains('='))
                                    .take(5)
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            })
                            .unwrap_or_default()
                    }
                    Some("exit") => secs = v["t_abs"].as_f64().unwrap_or(0.0),
                    _ => {}
                }
            }
            rows.push((started, secs, argv));
        }
        // In start order: gaps between processes are time spent in Revqora itself.
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        for (started, secs, argv) in rows.iter().take(100) {
            println!("    {} {:>6.0} ms  {argv}", started.get(11..23).unwrap_or(""), secs * 1000.0);
        }
    }
    (ms, files.len())
}

#[test]
#[ignore]
fn remote_operation_overhead() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (remote, work, other, traces) = (root.join("remote.git"), root.join("work"), root.join("other"), root.join("traces"));
    git(root, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(root, &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]);
    commit(&other, "first");
    git(&other, &["push", "-q", "origin", "HEAD:main"]);
    let branches = env_count("REVQORA_TIMING_BRANCHES", 400);
    let refs: String = (0..branches).map(|i| format!("create refs/heads/topic/{i} HEAD\n")).collect();
    std::fs::write(root.join("refs.txt"), refs).unwrap();
    let status = std::process::Command::new("git")
        .current_dir(&other)
        .args(["update-ref", "--stdin"])
        .stdin(std::fs::File::open(root.join("refs.txt")).unwrap())
        .status()
        .unwrap();
    assert!(status.success());
    git(&other, &["push", "-q", "origin", "refs/heads/*:refs/heads/*"]);
    git(root, &["clone", "-q", remote.to_str().unwrap(), work.to_str().unwrap()]);
    for i in 0..env_count("REVQORA_TIMING_DIRTY", 40) {
        std::fs::write(work.join(format!("untracked-{i}.txt")), format!("data {i}\n").repeat(200)).unwrap();
    }
    println!("fixture: {branches} remote branches, dirty worktree");
    let report = |label: &str, (ms, spawns): (u128, usize)| println!("{label:<34} {ms:>6} ms {spawns:>4} git processes");

    for round in 0..3 {
        println!("round {round}");
        // Fetch with nothing new, then with one new upstream commit.
        report(
            "git fetch --all --prune --tags",
            measure(&traces, || {
                git(&work, &["fetch", "--all", "--prune", "--no-prune-tags", "--tags", "--quiet"]);
            }),
        );
        report(
            "app fetch",
            measure(&traces, || {
                operations::run(&work, "fetch", None, |_, _| {}, || ops::fetch(&work, None, true, |_| {})).unwrap();
            }),
        );
        report(
            "app background fetch",
            measure(&traces, || {
                operations::run(&work, "fetch_background", None, |_, _| {}, || ops::fetch_background(&work)).unwrap();
            }),
        );
        commit(&other, &format!("upstream {round}"));
        git(&other, &["push", "-q", "origin", "HEAD:main"]);
        report(
            "app pull (one new commit)",
            measure(&traces, || {
                operations::run(&work, "pull", None, |_, _| {}, || ops::pull_with_prune(&work, "ff-only", true, |_| {})).unwrap();
            }),
        );
        commit(&work, &format!("local {round}"));
        let push = ops::PushOptions {
            remote: Some("origin".into()),
            branch: Some("main".into()),
            remote_branch: Some("main".into()),
            set_upstream: false,
            force_with_lease: false,
            tags: false,
        };
        report(
            "app push (one new commit)",
            measure(&traces, || {
                operations::run(&work, "push", None, |_, _| {}, || ops::push(&work, &push, |_| {})).unwrap();
            }),
        );
        git(&other, &["pull", "-q", "--ff-only", "origin", "main"]);
        commit(&work, &format!("raw {round}"));
        report(
            "git push (one new commit)",
            measure(&traces, || {
                git(&work, &["push", "-q", "origin", "main"]);
            }),
        );
        git(&other, &["pull", "-q", "--ff-only", "origin", "main"]);
    }
}
