//! Debounced file system watcher that tells the UI when a repository changed.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

pub struct RepoWatcher {
    _watcher: RecommendedWatcher,
    stop: mpsc::Sender<()>,
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

/// Classifies a changed path: Some(true) = git metadata, Some(false) = worktree, None = ignore.
fn classify(root: &Path, git_dir: &Path, p: &Path) -> Option<bool> {
    if let Ok(rel) = p.strip_prefix(git_dir) {
        let s = rel.to_string_lossy().replace('\\', "/");
        if s.starts_with("objects/") || s.starts_with("logs/") || s.ends_with(".lock") || s.starts_with("revqora/") || s.starts_with("hooks/") {
            return None;
        }
        // Staging only touches the index: refresh status, not the whole history.
        if s == "index" || s.starts_with("refs/worktree/") {
            return Some(false);
        }
        return Some(true);
    }
    let rel = p.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    // Common heavy build folders are almost always ignored; skip them to avoid refresh storms.
    for skip in ["node_modules/", "target/", ".vs/", "bin/Debug/", "obj/", ".idea/", "dist/", ".next/", "__pycache__/"] {
        if s.starts_with(skip) || s.contains(&format!("/{skip}")) {
            return None;
        }
    }
    if let Some(dir) = rel.ancestors().find(|p| p.file_name().is_some_and(|name| name == ".git")) {
        // Traditional nested repos/submodules keep Git metadata under the
        // worktree. Apply the same metadata/lock/object rules there too.
        return classify(root, &root.join(dir), p);
    }
    if rel.file_name().is_some_and(|name| name == ".gitattributes") {
        // Attributes can change the interpretation of immutable commit diffs too.
        return Some(true);
    }
    Some(false)
}

fn comparable(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy().replace('\\', "/").to_lowercase();
        let value = if let Some(unc) = value.strip_prefix("//?/unc/") { format!("//{unc}") } else { value.strip_prefix("//?/").unwrap_or(&value).to_owned() };
        PathBuf::from(value)
    }
    #[cfg(not(windows))]
    {
        path.to_owned()
    }
}

fn classify_owned(root: &Path, git_dir: &Path, ignored: &[PathBuf], path: &Path) -> Option<bool> {
    let normalized = comparable(path);
    if ignored.iter().any(|dir| normalized.starts_with(dir)) {
        return None;
    }
    classify(root, git_dir, path)
}

fn owned_paths(root: &Path, git_dir: &Path) -> Vec<PathBuf> {
    let mut watched = vec![comparable(root), comparable(git_dir)];
    for p in [root, git_dir] {
        if let Ok(p) = std::fs::canonicalize(p) {
            watched.push(comparable(&p));
        }
    }
    let mut ignored = Vec::new();
    let mut owned = Vec::new();
    if let Some(data) = crate::portable::data_dir() {
        for name in ["webview", "operation-log", "repositories", "temp", "window.json"] {
            owned.push(data.join(name));
        }
    }
    if let Some(profile) = crate::portable::webview_dir() {
        owned.push(profile);
    }
    if let Ok(runtime) = crate::portable::runtime_dir() {
        owned.push(runtime.join("repositories"));
        owned.push(runtime.join("temp"));
    }
    for path in owned {
        for candidate in [Some(path.clone()), std::fs::canonicalize(&path).ok()].into_iter().flatten() {
            let candidate = comparable(&candidate);
            // Do not disable watching if a user explicitly opened a repo INSIDE
            // an owned folder. Exclude only a known owned child of a watched root.
            if watched.iter().any(|root| candidate != *root && candidate.starts_with(root)) && !ignored.contains(&candidate) {
                ignored.push(candidate);
            }
        }
    }
    ignored
}

/// Folders of the working tree that Git ignores and that hold no tracked file (build output,
/// logs, caches beyond the fixed list in `classify`). A change inside them cannot change the
/// status, so it does not start a refresh. Answers are kept until a `.gitignore` or
/// `info/exclude` changes (which files are ignored) or the index changes (which files are
/// tracked: `git add -f` tracks a file inside an ignored folder); only the top folders (three
/// levels) are checked.
struct QuietFolders {
    root: PathBuf,
    known: std::collections::HashMap<String, bool>,
}

impl QuietFolders {
    const DEPTH: usize = 3;

    fn new(root: &Path) -> Self {
        QuietFolders { root: root.to_path_buf(), known: Default::default() }
    }

    fn forget(&mut self) {
        self.known.clear();
    }

    /// Whether the changed `path` lies in a quiet folder.
    fn contains(&mut self, path: &Path) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else { return false };
        let parts: Vec<String> = rel.parent().map(|dir| dir.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        let folders: Vec<String> = (1..=parts.len().min(Self::DEPTH)).map(|n| parts[..n].join("/")).collect();
        let unknown: Vec<String> = folders.iter().filter(|f| !self.known.contains_key(*f)).cloned().collect();
        if !unknown.is_empty() {
            self.learn(&unknown);
        }
        folders.iter().any(|f| self.known.get(f).copied().unwrap_or(false))
    }

    fn learn(&mut self, folders: &[String]) {
        for folder in folders {
            self.known.insert(folder.clone(), false);
        }
        let input: Vec<u8> = folders.iter().flat_map(|f| format!("{f}/\0").into_bytes()).collect();
        let Ok(out) = super::runner::exec_full(&self.root, ["check-ignore", "-z", "--stdin"], &[], Some(&input)) else { return };
        if out.code > 1 {
            return;
        }
        let ignored: Vec<String> =
            out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).trim_end_matches('/').to_owned()).collect();
        if ignored.is_empty() {
            return;
        }
        // An ignored folder can still hold tracked files, whose changes matter.
        let mut args = vec!["ls-files".to_owned(), "-z".to_owned(), "--cached".to_owned(), "--".to_owned()];
        args.extend(ignored.iter().map(|f| format!(":(literal){f}/")));
        let Ok(tracked) = super::runner::exec_full(&self.root, &args, &[], None) else { return };
        if !tracked.ok() {
            return;
        }
        let tracked: Vec<String> = tracked.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
        for folder in ignored {
            let prefix = format!("{folder}/");
            let quiet = !tracked.iter().any(|path| path.starts_with(&prefix));
            self.known.insert(folder, quiet);
        }
    }
}

/// Whether `path` changes which files Git ignores.
fn changes_ignore_rules(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == ".gitignore") || path.ends_with("info/exclude")
}

/// Whether `path` is this working tree's index (or its shared part, or the lock Git renames
/// over it): the list of tracked files may have changed. `git_dirs` are this working tree's Git
/// directory as given and resolved, in `comparable` form.
fn changes_tracked_files(path: &Path, git_dirs: &[PathBuf]) -> bool {
    let Some(name) = path.file_name().map(|name| name.to_string_lossy()) else { return false };
    (name == "index" || name == "index.lock" || name.starts_with("sharedindex.")) && path.parent().is_some_and(|dir| git_dirs.contains(&comparable(dir)))
}

/// Milliseconds since the Unix epoch (the UI compares it with `Date.now()`).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn watch<F, E>(root: PathBuf, git_dir: PathBuf, on_change: F, on_error: E) -> notify::Result<RepoWatcher>
where
    F: Fn(bool, bool, u64) + Send + 'static,
    E: FnOnce() + Send + 'static,
{
    let ignored = owned_paths(&root, &git_dir);
    let mut quiet = QuietFolders::new(&root);
    // The index lives in this working tree's own Git directory (also for a linked worktree).
    let index_dirs: Vec<PathBuf> = [Some(git_dir.clone()), std::fs::canonicalize(&git_dir).ok()].into_iter().flatten().map(|dir| comparable(&dir)).collect();
    let common = super::operations::repository_key(&root);
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })?;
    let mut register = |path: &Path, _role: &str| {
        #[cfg(test)]
        {
            use std::io::Write;
            let _ = writeln!(std::io::stderr(), "[repository watcher] registering {_role}");
        }
        let result = watcher.watch(path, RecursiveMode::Recursive);
        #[cfg(test)]
        {
            use std::io::Write;
            let _ = writeln!(std::io::stderr(), "[repository watcher] {_role}: {result:?}");
        }
        result
    };
    register(&root, "working directory")?;
    if !git_dir.starts_with(&root) {
        // Linked worktrees keep their git dir elsewhere.
        register(&git_dir, "linked Git directory")?;
    }
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    if comparable(&common) != comparable(&git_dir) && !common.starts_with(&root) {
        register(&common, "shared Git directory")?;
    }
    std::thread::spawn(move || {
        // Report once the burst is over (QUIET without a new change), and at the latest MAX
        // after its first change, so a long Git operation still updates the view.
        const QUIET: Duration = Duration::from_millis(100);
        const MAX: Duration = Duration::from_millis(400);
        const IDLE: Duration = Duration::from_millis(250);
        let mut pending_git = false;
        let mut pending_wt = false;
        let mut first: Option<Instant> = None;
        let mut last: Option<Instant> = None;
        // Wall-clock time of the burst's last change: only a read that started after it sees
        // every change of the burst (one that started between two changes misses the second).
        let mut since: u64 = 0;
        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            let wait = match (first, last) {
                (Some(first), Some(last)) => (QUIET.saturating_sub(last.elapsed())).min(MAX.saturating_sub(first.elapsed())).max(Duration::from_millis(1)),
                _ => IDLE,
            };
            match rx.recv_timeout(wait) {
                // File reads must not cause feedback refreshes. Still reach the
                // debounce flush below when access events arrive continuously.
                Ok(Ok(ev)) if ev.need_rescan() => {
                    pending_git = true;
                    pending_wt = true;
                    first.get_or_insert_with(Instant::now);
                    last = Some(Instant::now());
                    since = now_ms();
                }
                Ok(Ok(ev)) if !matches!(ev.kind, notify::EventKind::Access(_)) => {
                    let mut relevant = false;
                    for p in &ev.paths {
                        if changes_ignore_rules(p) || changes_tracked_files(p, &index_dirs) {
                            quiet.forget();
                        }
                        // Shared refs/config/stash live outside a linked worktree's git dir.
                        let metadata = if p.starts_with(&git_dir) { &git_dir } else { &common };
                        match classify_owned(&root, metadata, &ignored, p) {
                            Some(true) => (pending_git, relevant) = (true, true),
                            Some(false) if !quiet.contains(p) => (pending_wt, relevant) = (true, true),
                            Some(false) | None => {}
                        }
                    }
                    if relevant {
                        first.get_or_insert_with(Instant::now);
                        last = Some(Instant::now());
                        since = now_ms();
                    }
                }
                Ok(Ok(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if stop_rx.try_recv().is_err() {
                        on_error();
                    }
                    break;
                }
            }
            if let (Some(started), Some(latest)) = (first, last) {
                if latest.elapsed() >= QUIET || started.elapsed() >= MAX {
                    on_change(pending_git, pending_wt, since);
                    pending_git = false;
                    pending_wt = false;
                    first = None;
                    last = None;
                }
            }
        }
    });
    Ok(RepoWatcher { _watcher: watcher, stop: stop_tx })
}

#[cfg(test)]
mod tests {
    use super::{classify, classify_owned, comparable};
    use std::path::Path;

    #[test]
    fn linked_worktree_observes_shared_branch_refs_from_external_git() {
        use super::watch;
        use crate::git::{repo, runner};
        use std::{fs, sync::mpsc, time::Duration};
        // Bypass libtest's output capture: if a native watch/Git call stalls,
        // CI must retain its last phase even when the job is forcibly cancelled.
        let started = std::time::Instant::now();
        let phase = |message: &str| {
            use std::io::Write;
            let _ = writeln!(std::io::stderr(), "[linked-worktree watcher +{}ms] {message}", started.elapsed().as_millis());
        };
        phase("creating fixture");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("main");
        fs::create_dir(&root).unwrap();
        for args in [
            vec!["init", "-qb", "main"],
            vec!["config", "user.name", "T"],
            vec!["config", "user.email", "t@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            phase(&format!("git {}", args.join(" ")));
            runner::run(&root, args).unwrap();
        }
        fs::write(root.join("f.txt"), b"base").unwrap();
        phase("git add and commit");
        runner::run(&root, ["add", "."]).unwrap();
        runner::run(&root, ["commit", "-qm", "base"]).unwrap();
        let linked = tmp.path().join("linked");
        phase("creating linked worktree");
        runner::run(&root, ["worktree", "add", "-qb", "linked", linked.to_str().unwrap()]).unwrap();
        let (tx, rx) = mpsc::channel();
        phase("resolving linked git directory");
        let git_dir = repo::git_dir(&linked).unwrap();
        phase("registering filesystem watches");
        let watcher = watch(
            linked.clone(),
            git_dir,
            move |git, _, since| {
                if git {
                    let _ = tx.send(since);
                }
            },
            || {},
        )
        .unwrap();
        phase("creating external branch");
        let before = super::now_ms();
        runner::run(&root, ["branch", "external-branch"]).unwrap();
        phase("awaiting shared ref notification (10s deadline)");
        let since = rx.recv_timeout(Duration::from_secs(10)).expect("Shared refs did not refresh the linked worktree");
        // The batch reports when its last change was seen, after the write began.
        assert!(since >= before && since <= super::now_ms(), "{before} <= {since}");
        phase("dropping watcher");
        drop(watcher);
        phase("removing fixture");
        tmp.close().unwrap();
        phase("complete");
    }

    #[test]
    fn a_batch_reports_its_last_change_so_a_read_between_two_changes_is_not_enough() {
        use super::watch;
        use crate::git::runner;
        use std::{fs, sync::mpsc, time::Duration};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        fs::create_dir(&root).unwrap();
        runner::run(&root, ["init", "-qb", "main"]).unwrap();
        let git_dir = crate::git::repo::git_dir(&root).unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = watch(
            root.clone(),
            git_dir,
            move |_, worktree, since| {
                if worktree {
                    let _ = tx.send(since);
                }
            },
            || {},
        )
        .unwrap();
        // Let the watch settle, then make two changes inside one burst.
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        fs::write(root.join("first.txt"), b"1").unwrap();
        std::thread::sleep(Duration::from_millis(40));
        // A read that starts here sees the first change but not the second.
        let read_started = super::now_ms();
        std::thread::sleep(Duration::from_millis(5));
        fs::write(root.join("second.txt"), b"2").unwrap();
        let mut reported = vec![rx.recv_timeout(Duration::from_secs(10)).expect("The changes were not reported")];
        while let Ok(since) = rx.recv_timeout(Duration::from_millis(600)) {
            reported.push(since);
        }
        // The batch that ends the burst must not count the read above as fresh.
        assert!(reported.last().is_some_and(|since| *since > read_started), "{read_started} vs {reported:?}");
        drop(watcher);
        tmp.close().unwrap();
    }

    #[test]
    fn a_file_added_with_force_inside_a_quiet_ignored_folder_is_watched_again() {
        use super::watch;
        use crate::git::runner;
        use std::{fs, sync::mpsc, time::Duration};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        fs::create_dir_all(root.join("release")).unwrap();
        runner::run(&root, ["init", "-qb", "main"]).unwrap();
        fs::write(root.join(".gitignore"), b"/release/\n").unwrap();
        fs::write(root.join("release/out.txt"), b"1").unwrap();
        let git_dir = crate::git::repo::git_dir(&root).unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = watch(
            root.clone(),
            git_dir,
            move |_, worktree, _| {
                if worktree {
                    let _ = tx.send(());
                }
            },
            || {},
        )
        .unwrap();
        let settle = || while rx.recv_timeout(Duration::from_millis(800)).is_ok() {};
        std::thread::sleep(Duration::from_millis(300));
        settle();
        // Build output in an ignored folder without tracked files does not start a refresh.
        fs::write(root.join("release/out.txt"), b"2").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err(), "a write into a quiet ignored folder was reported");
        // `git add -f` tracks the file: the folder is no longer quiet.
        runner::run(&root, ["add", "-f", "release/out.txt"]).unwrap();
        settle();
        fs::write(root.join("release/out.txt"), b"3").unwrap();
        rx.recv_timeout(Duration::from_secs(10)).expect("a change of a force-added file was not reported");
        drop(watcher);
        tmp.close().unwrap();
    }

    #[test]
    fn only_the_working_trees_own_index_counts_as_a_change_of_tracked_files() {
        let git_dir = Path::new("/work/repo/.git");
        let dirs = [comparable(git_dir)];
        for name in ["index", "index.lock", "sharedindex.0123456789abcdef0123456789abcdef01234567"] {
            assert!(super::changes_tracked_files(&git_dir.join(name), &dirs), "{name}");
        }
        assert!(!super::changes_tracked_files(Path::new("/work/repo/docs/index"), &dirs));
        assert!(!super::changes_tracked_files(&git_dir.join("HEAD"), &dirs));
        assert!(!super::changes_tracked_files(&git_dir.join("worktrees/other/index"), &dirs));
    }

    #[cfg(windows)]
    #[test]
    fn owned_path_comparison_handles_extended_drive_and_unc_paths() {
        assert_eq!(comparable(Path::new(r"\\?\C:\Repo\DATA")), comparable(Path::new(r"c:\repo\data")));
        assert_eq!(comparable(Path::new(r"\\?\UNC\Server\Share\Data")), comparable(Path::new(r"\\server\share\data")));
    }

    #[test]
    fn portable_noise_is_ignored_without_hiding_project_files_or_git_refs() {
        let root = Path::new("/repo");
        let git = Path::new("/repo/.git");
        let ignored = vec![comparable(Path::new("/repo/client/data/webview")), comparable(Path::new("/repo/client/data/operation-log"))];
        assert_eq!(classify_owned(root, git, &ignored, Path::new("/repo/client/data/webview/Cache/entry")), None);
        assert_eq!(classify_owned(root, git, &ignored, Path::new("/repo/client/data/operation-log/journal.sqlite-wal")), None);
        assert_eq!(classify_owned(root, git, &ignored, Path::new("/repo/client/database/user.txt")), Some(false));
        assert_eq!(classify_owned(root, git, &ignored, Path::new("/repo/data/user.txt")), Some(false));
        assert_eq!(classify_owned(root, git, &ignored, Path::new("/repo/client/data/user.txt")), Some(false));
        assert_eq!(classify_owned(root, git, &ignored, Path::new("/repo/.git/config")), Some(true));
        assert_eq!(classify_owned(root, git, &ignored, Path::new("/repo/.git/refs/heads/main")), Some(true));
    }

    #[test]
    fn classifies_changes() {
        let root = Path::new("/r");
        let gd = Path::new("/r/.git");
        assert_eq!(classify(root, gd, Path::new("/r/.git/HEAD")), Some(true));
        assert_eq!(classify(root, gd, gd), Some(true));
        assert_eq!(classify(root, gd, Path::new("/r/node_modules/pkg/.gitattributes")), None);
        assert_eq!(classify(root, gd, Path::new("/r/src/.gitattributes")), Some(true));
        assert_eq!(classify(root, gd, Path::new("/r/.git/refs/heads/main")), Some(true));
        assert_eq!(classify(root, gd, Path::new("/r/.git/index")), Some(false));
        assert_eq!(classify(root, gd, Path::new("/r/.git/refs/worktree/revqora/layers")), Some(false));
        assert_eq!(classify(root, gd, Path::new("/r/.git/objects/ab/cdef")), None);
        assert_eq!(classify(root, gd, Path::new("/r/.git/index.lock")), None);
        assert_eq!(classify(root, gd, Path::new("/r/src/main.rs")), Some(false));
        assert_eq!(classify(root, gd, Path::new("/r/module/.git/info/attributes")), Some(true));
        assert_eq!(classify(root, gd, Path::new("/r/module/.git/HEAD")), Some(true));
        assert_eq!(classify(root, gd, Path::new("/r/module/.git/index")), Some(false));
        assert_eq!(classify(root, gd, Path::new("/r/module/.git/index.lock")), None);
        assert_eq!(classify(root, gd, Path::new("/r/module/.git/objects/ab/cdef")), None);
        assert_eq!(classify(root, gd, Path::new("/r/node_modules/x/index.js")), None);
        assert_eq!(classify(root, gd, Path::new("/r/app/target/debug/x")), None);
    }
}
