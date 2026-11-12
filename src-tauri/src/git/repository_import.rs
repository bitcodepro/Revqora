//! Discover working copies, including repositories nested in other working copies.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use parking_lot::Mutex;
use serde::Serialize;

use super::ops::path_is_link;
use super::repo;
use super::runner::{GitError, GitResult};

const GENERATED_FOLDERS: &[&str] = &["node_modules", ".pnpm-store", ".venv", "__pycache__", ".cache", ".next", ".nuxt", ".turbo", ".gradle"];

#[derive(Default)]
pub(crate) struct FolderScans {
    next_id: AtomicU32,
    jobs: Mutex<HashMap<u32, ScanJob>>,
}

#[derive(Default)]
struct ScanJob {
    cancelled: Arc<AtomicBool>,
    started: bool,
}

impl FolderScans {
    pub(crate) fn prepare(&self) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.jobs.lock().insert(id, ScanJob::default());
        id
    }

    pub(crate) fn start(&self, id: u32) -> GitResult<Arc<AtomicBool>> {
        let mut jobs = self.jobs.lock();
        let job = jobs.get_mut(&id).ok_or_else(cancelled_scan)?;
        if job.started {
            return Err(GitError::new("Folder scan is already running."));
        }
        job.started = true;
        Ok(job.cancelled.clone())
    }

    pub(crate) fn cancel(&self, id: u32) {
        if let Some(job) = self.jobs.lock().remove(&id) {
            job.cancelled.store(true, Ordering::Relaxed);
        }
    }

    pub(crate) fn finish(&self, id: u32) {
        self.jobs.lock().remove(&id);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepository {
    pub root: String,
    pub relative_path: String,
    pub workspace_folder: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
    pub repositories: Vec<FoundRepository>,
    pub skipped: usize,
    pub excluded: usize,
}

#[derive(Default)]
struct FolderContents {
    children: Vec<PathBuf>,
    repository: Option<FoundRepository>,
    skipped: usize,
    excluded: usize,
}

fn cancelled_scan() -> GitError {
    GitError::new("Folder scan stopped.").kind("scan-cancelled")
}

fn check_cancelled(cancelled: &AtomicBool) -> GitResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(cancelled_scan());
    }
    Ok(())
}

fn named(actual: &str, expected: &str) -> bool {
    actual == expected || cfg!(windows) && actual.eq_ignore_ascii_case(expected)
}

pub(crate) fn scan(root: &Path, include_generated: bool, cancelled: &AtomicBool) -> GitResult<FolderScan> {
    check_cancelled(cancelled)?;
    if !root.is_absolute() {
        return Err(GitError::new("Choose an absolute folder path."));
    }
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || path_is_link(&metadata) {
        return Err(GitError::new("Choose a folder directly to scan it for repositories."));
    }

    let workers = thread::available_parallelism().map_or(2, |n| n.get()).clamp(2, 8);
    let mut result = thread::scope(|scope| -> GitResult<FolderScan> {
        let (queue, jobs) = mpsc::channel::<PathBuf>();
        let jobs = Arc::new(Mutex::new(jobs));
        let (finished, folders) = mpsc::channel();
        for _ in 0..workers {
            let jobs = jobs.clone();
            let finished = finished.clone();
            scope.spawn(move || loop {
                let job = jobs.lock().recv();
                let Ok(folder) = job else { break };
                let contents = scan_folder(root, &folder, include_generated, cancelled);
                if finished.send(contents).is_err() {
                    break;
                }
            });
        }
        drop(finished);

        let mut pending = vec![root.to_path_buf()];
        let mut active = 0;
        let mut result = FolderScan::default();
        loop {
            check_cancelled(cancelled)?;
            while active < workers && !pending.is_empty() {
                queue.send(pending.pop().unwrap()).map_err(|_| GitError::new("Folder scan workers stopped."))?;
                active += 1;
            }
            if active == 0 {
                return Ok(result);
            }
            let contents = folders.recv().map_err(|_| GitError::new("Folder scan workers stopped."))??;
            active -= 1;
            pending.extend(contents.children);
            result.repositories.extend(contents.repository);
            result.skipped += contents.skipped;
            result.excluded += contents.excluded;
        }
    })?;
    check_cancelled(cancelled)?;
    result.repositories.sort_by(|a, b| Path::new(&a.relative_path).cmp(Path::new(&b.relative_path)));
    Ok(result)
}

fn scan_folder(root: &Path, folder: &Path, include_generated: bool, cancelled: &AtomicBool) -> GitResult<FolderContents> {
    check_cancelled(cancelled)?;
    let mut result = FolderContents::default();
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if folder == root => return Err(error.into()),
        Err(_) => {
            result.skipped += 1;
            return Ok(result);
        }
    };
    let mut has_git = false;
    for entry in entries {
        check_cancelled(cancelled)?;
        let Ok(entry) = entry else {
            result.skipped += 1;
            continue;
        };
        let name = entry.file_name();
        if name.to_str().is_some_and(|name| named(name, ".git")) {
            has_git = true;
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            result.skipped += 1;
            continue;
        };
        if kind.is_symlink() {
            result.skipped += 1;
        } else if kind.is_dir() {
            let Some(name) = name.to_str() else {
                result.skipped += 1;
                continue;
            };
            if !include_generated && GENERATED_FOLDERS.iter().any(|expected| named(name, expected)) {
                result.excluded += 1;
                continue;
            }
            // Windows directory reparse points include more than symbolic links.
            #[cfg(windows)]
            if !entry.metadata().is_ok_and(|metadata| !path_is_link(&metadata)) {
                result.skipped += 1;
                continue;
            }
            result.children.push(entry.path());
        }
    }
    check_cancelled(cancelled)?;
    if has_git {
        if let Some(found_root) = exact_repository(folder) {
            let workspace_folder = Path::new(&found_root).parent().and_then(Path::to_str).map(str::to_owned);
            let relative_path = folder.strip_prefix(root).ok().and_then(Path::to_str).unwrap_or(&found_root).to_owned();
            result.repository = Some(FoundRepository { root: found_root, relative_path, workspace_folder });
        } else {
            result.skipped += 1;
        }
    }
    Ok(result)
}

fn exact_repository(folder: &Path) -> Option<String> {
    let root = repo::discover(folder).ok()?;
    if fs::canonicalize(folder).ok()? != fs::canonicalize(&root).ok()? {
        return None;
    }
    root.to_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner;

    fn search(path: &Path) -> GitResult<FolderScan> {
        scan(path, false, &AtomicBool::new(false))
    }

    fn init(path: &Path) {
        fs::create_dir_all(path).unwrap();
        runner::run(path, ["init", "-b", "main"]).unwrap();
    }

    #[test]
    fn scans_nested_working_copies_and_uses_each_immediate_parent() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        init(&root.join("api"));
        init(&root.join("api/nested/worker"));
        init(&root.join("backend/service one"));
        init(&root.join("frontend/deeper/web"));
        fs::create_dir(root.join("empty")).unwrap();
        fs::create_dir(root.join("broken")).unwrap();
        fs::write(root.join("broken/.git"), "invalid").unwrap();
        let result = search(root).unwrap();
        let paths: Vec<_> = result
            .repositories
            .iter()
            .map(|repo| {
                let name = Path::new(&repo.root).file_name().unwrap().to_str().unwrap();
                let workspace = repo.workspace_folder.as_deref().map(|path| Path::new(path).file_name().unwrap().to_str().unwrap());
                (name, workspace)
            })
            .collect();
        let name = root.file_name().unwrap().to_str().unwrap();
        assert_eq!(paths, [("api", Some(name)), ("worker", Some("nested")), ("service one", Some("backend")), ("web", Some("deeper"))]);
        assert_eq!(result.skipped, 1);
        assert_eq!(search(&root.join("api")).unwrap().repositories.len(), 2);
        let aliased = search(&root.join("empty/..")).unwrap();
        assert_eq!(aliased.repositories[1].workspace_folder, result.repositories[1].workspace_folder);
    }

    #[test]
    fn recognizes_a_gitfile_working_copy() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let repo = root.join("projects/repo");
        fs::create_dir_all(&repo).unwrap();
        runner::run(&repo, ["init", "--separate-git-dir", root.join("metadata").to_str().unwrap()]).unwrap();
        assert!(repo.join(".git").is_file());
        let found = search(&root.join("projects")).unwrap().repositories;
        assert_eq!(found.len(), 1);
        assert!(Path::new(found[0].workspace_folder.as_deref().unwrap()).ends_with("projects"));
    }

    #[test]
    fn finds_a_repository_beyond_the_old_depth_limit() {
        let fixture = tempfile::tempdir().unwrap();
        let deepest = fixture.path().join("a/".repeat(30)).join("group/project");
        init(&deepest);
        let found = search(fixture.path()).unwrap().repositories;
        assert_eq!(found.len(), 1);
        assert!(Path::new(found[0].workspace_folder.as_deref().unwrap()).ends_with("group"));
    }

    #[test]
    fn generated_folders_are_skipped_unless_requested() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        init(&root.join("project"));
        init(&root.join("project/node_modules/dependency"));
        init(&root.join("cache/.venv/nested"));
        fs::write(root.join("node_modules"), "ordinary file").unwrap();

        let result = search(root).unwrap();
        assert_eq!(result.repositories.len(), 1);
        assert_eq!(result.excluded, 2);
        let full = scan(root, true, &AtomicBool::new(false)).unwrap();
        assert_eq!(full.repositories.len(), 3);
        assert_eq!(full.excluded, 0);
        assert_eq!(search(&root.join("project/node_modules")).unwrap().repositories.len(), 1);
    }

    #[test]
    fn cancellation_is_scoped_and_covers_prepared_and_running_requests() {
        let fixture = tempfile::tempdir().unwrap();
        let scans = FolderScans::default();
        let prepared = scans.prepare();
        scans.cancel(prepared);
        assert_eq!(scans.start(prepared).unwrap_err().kind, "scan-cancelled");

        let running = scans.prepare();
        let cancelled = scans.start(running).unwrap();
        assert!(scans.start(running).is_err());
        scans.cancel(running);
        assert_eq!(scan(fixture.path(), false, &cancelled).err().unwrap().kind, "scan-cancelled");

        let next = scans.prepare();
        let token = scans.start(next).unwrap();
        assert!(scan(fixture.path(), false, &token).is_ok());
        scans.finish(next);
        assert!(scans.start(next).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_directory_symlinks() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        init(&root.join("external"));
        fs::create_dir(root.join("import")).unwrap();
        std::os::unix::fs::symlink(root.join("external"), root.join("import/link")).unwrap();
        let result = search(&root.join("import")).unwrap();
        assert!(result.repositories.is_empty());
        assert_eq!(result.skipped, 1);
    }
}
