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
    Some(false)
}

pub fn watch<F>(root: PathBuf, git_dir: PathBuf, on_change: F) -> notify::Result<RepoWatcher>
where
    F: Fn(bool, bool) + Send + 'static,
{
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
                Ok(Ok(ev)) => {
                    for p in &ev.paths {
                        match classify(&root, &git_dir, p) {
                            Some(true) => pending_git = true,
                            Some(false) => pending_wt = true,
                            None => {}
                        }
                    }
                    if (pending_git || pending_wt) && first.is_none() {
                        first = Some(Instant::now());
                    }
                }
                Ok(Err(_)) => {}
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
    use super::classify;
    use std::path::Path;

    #[test]
    fn classifies_changes() {
        let root = Path::new("/r");
        let gd = Path::new("/r/.git");
        assert_eq!(classify(root, gd, Path::new("/r/.git/HEAD")), Some(true));
        assert_eq!(classify(root, gd, Path::new("/r/.git/refs/heads/main")), Some(true));
        assert_eq!(classify(root, gd, Path::new("/r/.git/index")), Some(false));
        assert_eq!(classify(root, gd, Path::new("/r/.git/refs/worktree/revqora/layers")), Some(false));
        assert_eq!(classify(root, gd, Path::new("/r/.git/objects/ab/cdef")), None);
        assert_eq!(classify(root, gd, Path::new("/r/.git/index.lock")), None);
        assert_eq!(classify(root, gd, Path::new("/r/src/main.rs")), Some(false));
        assert_eq!(classify(root, gd, Path::new("/r/node_modules/x/index.js")), None);
        assert_eq!(classify(root, gd, Path::new("/r/app/target/debug/x")), None);
    }
}
