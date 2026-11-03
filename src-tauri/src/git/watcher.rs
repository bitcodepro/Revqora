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

pub fn watch<F>(root: PathBuf, git_dir: PathBuf, on_change: F) -> notify::Result<RepoWatcher>
where
    F: Fn(bool, bool) + Send + 'static,
{
    let ignored = owned_paths(&root, &git_dir);
    let common = super::operations::repository_key(&root);
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    if !git_dir.starts_with(&root) {
        // Linked worktrees keep their git dir elsewhere.
        let _ = watcher.watch(&git_dir, RecursiveMode::Recursive);
    }
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    if comparable(&common) != comparable(&git_dir) && !common.starts_with(&root) {
        watcher.watch(&common, RecursiveMode::Recursive)?;
    }
    std::thread::spawn(move || {
        let debounce = Duration::from_millis(350);
        let mut pending_git = false;
        let mut pending_wt = false;
        let mut first: Option<Instant> = None;
        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(120)) {
                // File reads must not cause feedback refreshes. Still reach the
                // debounce flush below when access events arrive continuously.
                Ok(Ok(ev)) if !matches!(ev.kind, notify::EventKind::Access(_)) => {
                    for p in &ev.paths {
                        // Shared refs/config/stash live outside a linked worktree's git dir.
                        let metadata = if p.starts_with(&git_dir) { &git_dir } else { &common };
                        match classify_owned(&root, metadata, &ignored, p) {
                            Some(true) => pending_git = true,
                            Some(false) => pending_wt = true,
                            None => {}
                        }
                    }
                    if (pending_git || pending_wt) && first.is_none() {
                        first = Some(Instant::now());
                    }
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if let Some(t) = first {
                if t.elapsed() >= debounce {
                    on_change(pending_git, pending_wt);
                    pending_git = false;
                    pending_wt = false;
                    first = None;
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
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("main");
        fs::create_dir(&root).unwrap();
        for args in [
            vec!["init", "-qb", "main"],
            vec!["config", "user.name", "T"],
            vec!["config", "user.email", "t@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            runner::run(&root, args).unwrap();
        }
        fs::write(root.join("f.txt"), b"base").unwrap();
        runner::run(&root, ["add", "."]).unwrap();
        runner::run(&root, ["commit", "-qm", "base"]).unwrap();
        let linked = tmp.path().join("linked");
        runner::run(&root, ["worktree", "add", "-qb", "linked", linked.to_str().unwrap()]).unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = watch(linked.clone(), repo::git_dir(&linked).unwrap(), move |git, _| {
            if git {
                let _ = tx.send(());
            }
        })
        .unwrap();
        runner::run(&root, ["branch", "external-branch"]).unwrap();
        rx.recv_timeout(Duration::from_secs(10)).expect("Shared refs did not refresh the linked worktree");
        drop(watcher);
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
