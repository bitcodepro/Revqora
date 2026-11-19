//! Remembers the output of Git commands that depend only on configuration
//! (`remote -v`, `var GIT_ATTR_GLOBAL`, `config --get user.email`, ...).
//!
//! Starting Git costs 35–100 ms on Windows; the same answers were asked several times per
//! refresh. An entry is reused only while every configuration file Git read for this
//! repository (repository, worktree, global, XDG, system and included files) and HEAD
//! (for `includeIf "onbranch:"`) keep their size and modification time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use parking_lot::{Condvar, Mutex};

use super::runner::{self, GitResult, Output};

type Stamp = Vec<(PathBuf, Option<(SystemTime, u64)>)>;

struct RepoEntry {
    /// Configuration files that affect this repository (from `--show-origin`).
    files: Vec<PathBuf>,
    /// Their size and modification time when `files` was learned.
    stamp: Stamp,
    /// What `repo/.git` was (see `repo::dot_git_identity`): a reused worktree path is
    /// another repository even when every watched file is unchanged.
    identity: Option<String>,
    results: HashMap<Vec<String>, Output>,
}

fn entries() -> &'static Mutex<HashMap<PathBuf, RepoEntry>> {
    static ENTRIES: OnceLock<Mutex<HashMap<PathBuf, RepoEntry>>> = OnceLock::new();
    ENTRIES.get_or_init(Default::default)
}

fn stamp(files: &[PathBuf]) -> Stamp {
    files
        .iter()
        .map(|f| {
            let meta = std::fs::metadata(f).ok();
            (f.clone(), meta.and_then(|m| Some((m.modified().ok()?, m.len()))))
        })
        .collect()
}

/// Files whose change can alter configuration answers for `repo`.
fn config_files(repo: &Path) -> Option<Vec<PathBuf>> {
    let git_dir = super::repo::git_dir(repo).ok()?;
    let common = super::graph::common_dir(repo).unwrap_or_else(|| git_dir.clone());
    let mut files = vec![common.join("config"), git_dir.join("config.worktree"), common.join("config.worktree"), git_dir.join("HEAD")];
    // Default global locations, even when missing: creating one must invalidate.
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    if let Some(home) = &home {
        files.push(home.join(".gitconfig"));
    }
    match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(xdg) => files.push(PathBuf::from(xdg).join("git").join("config")),
        None => {
            if let Some(home) = &home {
                files.push(home.join(".config").join("git").join("config"));
            }
        }
    }
    for name in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] {
        if let Some(path) = std::env::var_os(name).filter(|v| !v.is_empty()) {
            files.push(PathBuf::from(path));
        }
    }
    // Every file Git actually read, including system and `include.path` files.
    let raw = runner::run_bytes(repo, ["config", "--list", "--show-origin", "-z"]).ok()?;
    let raw = String::from_utf8_lossy(&raw);
    let mut fields = raw.split('\0');
    while let Some(origin) = fields.next() {
        let Some(entry) = fields.next() else { break };
        let Some(file) = origin.strip_prefix("file:") else { continue };
        let path = PathBuf::from(file);
        let source = if path.is_absolute() { path } else { repo.join(path) };
        // Include targets are watched even while missing or empty: Git reports no origin for
        // them until they contribute a value, yet creating or filling one changes answers.
        // Nested includes appear here once their parent file is read.
        let (name, value) = entry.split_once('\n').unwrap_or((entry, ""));
        let name = name.to_ascii_lowercase();
        if (name == "include.path" || (name.starts_with("includeif.") && name.ends_with(".path"))) && !value.is_empty() {
            let target = match value.strip_prefix("~/") {
                Some(rest) => home.as_ref().map(|h| h.join(rest)),
                None => {
                    let target = PathBuf::from(value);
                    Some(if target.is_absolute() { target } else { source.parent().unwrap_or(repo).join(target) })
                }
            };
            files.extend(target);
        }
        files.push(source);
    }
    files.sort();
    files.dedup();
    Some(files)
}

/// One read that is running; callers asking the same question meanwhile wait for its answer.
struct Flight {
    /// [`CLEARS`] when it started: a caller after Revqora changed configuration reads again.
    clears: u64,
    answer: Mutex<Option<GitResult<Output>>>,
    done: Condvar,
}

type FlightKey = (PathBuf, Vec<String>);

fn flights() -> &'static Mutex<HashMap<FlightKey, Arc<Flight>>> {
    static FLIGHTS: OnceLock<Mutex<HashMap<FlightKey, Arc<Flight>>>> = OnceLock::new();
    FLIGHTS.get_or_init(Default::default)
}

/// Runs a configuration-only read, reusing the previous answer while no configuration
/// file changed. Only successful and "not found" (exit 1) answers are remembered.
///
/// A refresh reads status, branches and repository details side by side, and each asks some
/// of the same questions: while one read runs, the same question waits for its answer instead
/// of starting another Git process. A thread inside a repository transaction never waits (it
/// may hold the gate the running read waits for); it reads by itself.
pub fn exec(repo: &Path, args: &[&str]) -> GitResult<Output> {
    let key: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    if let Some(out) = fresh(repo, &key) {
        return Ok(out);
    }
    in_flight((repo.to_path_buf(), key.clone()), || read(repo, args, key))
}

/// Runs `read` unless the same read already runs; then waits for and returns its answer.
fn in_flight(flight_key: FlightKey, read: impl FnOnce() -> GitResult<Output>) -> GitResult<Output> {
    let clears = CLEARS.load(std::sync::atomic::Ordering::SeqCst);
    let lead = {
        let mut running = flights().lock();
        match running.get(&flight_key) {
            Some(flight) if flight.clears == clears && !super::operations::in_any_transaction() => Err(flight.clone()),
            Some(_) => Ok(None),
            None => {
                let flight = Arc::new(Flight { clears, answer: Mutex::new(None), done: Condvar::new() });
                running.insert(flight_key.clone(), flight.clone());
                Ok(Some(flight))
            }
        }
    };
    let flight = match lead {
        Err(flight) => {
            let mut answer = flight.answer.lock();
            while answer.is_none() {
                flight.done.wait(&mut answer);
            }
            return answer.clone().unwrap_or_else(|| Err(super::runner::GitError::new("Configuration read failed.")));
        }
        Ok(flight) => flight,
    };
    // Publishes the answer (also when the read panics) and ends the flight.
    struct Finish<'a> {
        flight: Option<Arc<Flight>>,
        key: &'a FlightKey,
        answer: Option<GitResult<Output>>,
    }
    impl Drop for Finish<'_> {
        fn drop(&mut self) {
            let Some(flight) = self.flight.take() else { return };
            {
                let mut running = flights().lock();
                if running.get(self.key).is_some_and(|current| Arc::ptr_eq(current, &flight)) {
                    running.remove(self.key);
                }
            }
            *flight.answer.lock() = Some(self.answer.take().unwrap_or_else(|| Err(super::runner::GitError::new("Configuration read failed."))));
            flight.done.notify_all();
        }
    }
    let mut finish = Finish { flight, key: &flight_key, answer: None };
    let result = read();
    finish.answer = Some(result.clone());
    drop(finish);
    result
}

fn read(repo: &Path, args: &[&str], key: Vec<String>) -> GitResult<Output> {
    let Some((files, before)) = learn(repo) else { return runner::exec(repo, args) };
    let out = runner::exec(repo, args)?;
    // Remember only answers read while no configuration file changed.
    if (out.ok() || out.code == 1) && stamp(&files) == before {
        if let Some(entry) = entries().lock().get_mut(repo).filter(|e| e.stamp == before) {
            entry.results.insert(key, out.clone());
        }
    }
    Ok(out)
}

/// The configuration files of `repo` and their stamp, learning them when unknown or changed.
/// No lock is held while Git runs: a caller inside a repository transaction must never wait
/// for another thread that waits for that repository's gate.
fn learn(repo: &Path) -> Option<(Vec<PathBuf>, Stamp)> {
    if let Some(entry) = entries().lock().get(repo).filter(|e| valid(repo, e)) {
        return Some((entry.files.clone(), entry.stamp.clone()));
    }
    let identity = super::repo::dot_git_identity(repo);
    let files = config_files(repo)?;
    let stamp = stamp(&files);
    entries().lock().insert(repo.to_path_buf(), RepoEntry { files: files.clone(), stamp: stamp.clone(), identity, results: HashMap::new() });
    Some((files, stamp))
}

fn valid(repo: &Path, entry: &RepoEntry) -> bool {
    stamp(&entry.files) == entry.stamp && super::repo::dot_git_identity(repo) == entry.identity
}

fn fresh(repo: &Path, key: &[String]) -> Option<Output> {
    let map = entries().lock();
    let entry = map.get(repo)?;
    let out = entry.results.get(key)?;
    valid(repo, entry).then(|| out.clone())
}

/// `run` over [`exec`]: fails on a non-zero exit.
pub fn run(repo: &Path, args: &[&str]) -> GitResult<String> {
    let out = exec(repo, args)?;
    if !out.ok() {
        return Err(runner::to_error(&format!("git {}", args.join(" ")), &out));
    }
    Ok(out.text())
}

/// Forgets the answers of `repo` and of every repository that shares its configuration file
/// (its other worktrees). Global and system files are watched by their stamps.
pub fn clear_repository(repo: &Path) {
    CLEARS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let Some(shared) = super::graph::common_dir(repo).map(|common| common.join("config")) else {
        entries().lock().clear();
        return;
    };
    // Every entry whose answers read this repository's configuration file.
    entries().lock().retain(|path, entry| path != repo && !entry.files.contains(&shared));
}

/// Forgets remembered answers (after Revqora itself changes configuration).
pub fn clear() {
    CLEARS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    entries().lock().clear();
}

/// How many times the cache was cleared (tests tell their own read from a parallel write).
static CLEARS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) {
        assert!(runner::exec(root, args).unwrap().ok(), "{args:?}");
    }

    #[test]
    fn cached_answers_follow_configuration_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        assert_eq!(run(root, &["remote"]).unwrap(), "");
        git(root, &["remote", "add", "origin", "https://example.invalid/a.git"]);
        assert_eq!(run(root, &["remote"]).unwrap().trim(), "origin");
        assert_eq!(exec(root, &["config", "--get", "revqora.missing"]).unwrap().code, 1);
        git(root, &["config", "revqora.missing", "now"]);
        assert_eq!(run(root, &["config", "--get", "revqora.missing"]).unwrap().trim(), "now");
        // An included file is tracked too.
        std::fs::write(root.join("extra.cfg"), "[revqora]\n\tincluded = one\n").unwrap();
        git(root, &["config", "include.path", "../extra.cfg"]);
        assert_eq!(run(root, &["config", "--get", "revqora.included"]).unwrap().trim(), "one");
        std::fs::write(root.join("extra.cfg"), "[revqora]\n\tincluded = two, longer\n").unwrap();
        assert_eq!(run(root, &["config", "--get", "revqora.included"]).unwrap().trim(), "two, longer");
    }

    #[test]
    fn the_same_read_asked_meanwhile_waits_for_the_running_one() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let clears = || CLEARS.load(Ordering::SeqCst);
        // Writes in parallel tests clear the cache, and a caller after a clear reads again by
        // design: judge only an attempt that no clear overlapped.
        for attempt in 0..50 {
            let reads = AtomicUsize::new(0);
            let key: FlightKey = (PathBuf::from(format!("/flight-test-{attempt}")), vec!["config".into(), "--get".into(), "revqora.flight".into()]);
            let read = || {
                reads.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(300));
                Ok(Output {
                    code: 0,
                    stdout: b"answer
"
                    .to_vec(),
                    stderr: String::new(),
                })
            };
            let before = clears();
            let answers: Vec<String> = std::thread::scope(|scope| {
                let first = scope.spawn(|| in_flight(key.clone(), read));
                std::thread::sleep(std::time::Duration::from_millis(50));
                let others: Vec<_> = (0..3).map(|_| scope.spawn(|| in_flight(key.clone(), read))).collect();
                std::iter::once(first).chain(others).map(|task| task.join().unwrap().unwrap().text()).collect()
            });
            assert!(
                answers.iter().all(|answer| answer
                    == "answer
"),
                "{answers:?}"
            );
            if clears() != before {
                continue;
            }
            assert_eq!(reads.load(Ordering::SeqCst), 1, "the same question started more than one read");
            // Finished: the next question reads again (the cache, not the flight, keeps answers).
            in_flight(key, read).unwrap();
            assert_eq!(reads.load(Ordering::SeqCst), 2);
            return;
        }
        panic!("every attempt overlapped a configuration change of another test");
    }

    #[test]
    fn a_repeated_read_is_answered_from_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        let key = vec!["config".to_string(), "--get".to_string(), "revqora.cached".to_string()];
        // Writes in parallel tests clear the shared cache. Judge only an attempt no other clear
        // overlapped: a read that clears its own entry (an eager guard) never keeps an answer.
        let clears = || CLEARS.load(std::sync::atomic::Ordering::SeqCst);
        let mut judged = None;
        for _ in 0..200 {
            let before = clears();
            exec(root, &["config", "--get", "revqora.cached"]).unwrap();
            let cached = fresh(root, &key).is_some();
            if clears() == before {
                judged = Some(cached);
                break;
            }
        }
        assert_eq!(judged, Some(true), "a configuration read must stay cached for the next identical read");
    }

    #[test]
    fn a_missing_or_empty_include_is_watched() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "include.path", "../later.cfg"]);
        git(&root, &["config", "--add", "include.path", "../empty.cfg"]);
        std::fs::write(root.join("empty.cfg"), "# nothing yet\n").unwrap();
        let read = |key: &str| exec(&root, &["config", "--get", key]).unwrap().text().trim().to_string();
        assert_eq!(read("revqora.later"), "");
        assert_eq!(read("revqora.later"), "");
        std::fs::write(root.join("later.cfg"), "[revqora]\n	later = created\n").unwrap();
        assert_eq!(read("revqora.later"), "created");
        assert_eq!(read("revqora.empty"), "");
        std::fs::write(root.join("empty.cfg"), "[revqora]\n	empty = filled\n").unwrap();
        assert_eq!(read("revqora.empty"), "filled");
    }
}
