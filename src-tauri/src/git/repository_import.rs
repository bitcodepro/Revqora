//! Discover working copies, including repositories nested in other working copies.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use parking_lot::Mutex;
use serde::Serialize;

use super::ops::path_is_link;
use super::repo;
use super::runner::{self, GitError, GitResult};

const GENERATED_FOLDERS: &[&str] = &["node_modules", ".pnpm-store", ".venv", "__pycache__", ".cache", ".next", ".nuxt", ".turbo", ".gradle", ".build"];

/// Folders the enclosing working copy ignores (`bin`, `obj`, `target`, `dist`…), as the scan
/// spells their paths. Build output can hold hundreds of thousands of folders and test
/// repositories the user never works in.
type Ignored = Arc<HashSet<PathBuf>>;
/// A folder holding this file is a cache (Cache Directory Tagging Specification): Cargo writes it
/// into every `target`, and other build tools into theirs. Such folders can hold hundreds of
/// thousands of subfolders and never a repository the user works in.
const CACHE_TAG: &str = "CACHEDIR.TAG";
const CACHE_TAG_SIGNATURE: &[u8] = b"Signature: 8a477f597d28d172789f06886806bc55";

/// What a running scan has done so far, read by the dialog while it waits.
#[derive(Default, Debug)]
pub(crate) struct ScanProgress {
    folders: AtomicU64,
    repositories: AtomicU32,
    current: Mutex<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScanProgress {
    pub folders: u64,
    pub repositories: u32,
    pub current: String,
}

impl ScanProgress {
    fn snapshot(&self) -> FolderScanProgress {
        FolderScanProgress {
            folders: self.folders.load(Ordering::Relaxed),
            repositories: self.repositories.load(Ordering::Relaxed),
            current: self.current.lock().clone(),
        }
    }
}

#[derive(Default)]
pub(crate) struct FolderScans {
    next_id: AtomicU32,
    jobs: Mutex<HashMap<u32, ScanJob>>,
}

#[derive(Default)]
struct ScanJob {
    cancelled: Arc<AtomicBool>,
    progress: Arc<ScanProgress>,
    started: bool,
}

impl FolderScans {
    pub(crate) fn prepare(&self) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.jobs.lock().insert(id, ScanJob::default());
        id
    }

    pub(crate) fn start(&self, id: u32) -> GitResult<(Arc<AtomicBool>, Arc<ScanProgress>)> {
        let mut jobs = self.jobs.lock();
        let job = jobs.get_mut(&id).ok_or_else(cancelled_scan)?;
        if job.started {
            return Err(GitError::new("Folder scan is already running."));
        }
        job.started = true;
        Ok((job.cancelled.clone(), job.progress.clone()))
    }

    /// Progress of a running scan; None once it finished or was cancelled.
    pub(crate) fn progress(&self, id: u32) -> Option<FolderScanProgress> {
        self.jobs.lock().get(&id).map(|job| job.progress.snapshot())
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
    folder: PathBuf,
    children: Vec<PathBuf>,
    /// The ignored folders that apply to `children`.
    ignored: Option<Ignored>,
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

pub(crate) fn scan(root: &Path, include_generated: bool, cancelled: &AtomicBool, progress: &ScanProgress) -> GitResult<FolderScan> {
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
        let (queue, jobs) = mpsc::channel::<(PathBuf, Option<Ignored>)>();
        let jobs = Arc::new(Mutex::new(jobs));
        let (finished, folders) = mpsc::channel();
        for _ in 0..workers {
            let jobs = jobs.clone();
            let finished = finished.clone();
            scope.spawn(move || loop {
                let job = jobs.lock().recv();
                let Ok((folder, ignored)) = job else { break };
                let contents = scan_folder(root, &folder, ignored, include_generated, cancelled);
                if finished.send(contents).is_err() {
                    break;
                }
            });
        }
        drop(finished);

        let mut pending = vec![(root.to_path_buf(), None)];
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
            progress.folders.fetch_add(1, Ordering::Relaxed);
            if let Some(path) = contents.folder.to_str() {
                path.clone_into(&mut progress.current.lock());
            }
            if contents.repository.is_some() {
                progress.repositories.fetch_add(1, Ordering::Relaxed);
            }
            let ignored = contents.ignored;
            pending.extend(contents.children.into_iter().map(|child| (child, ignored.clone())));
            result.repositories.extend(contents.repository);
            result.skipped += contents.skipped;
            result.excluded += contents.excluded;
        }
    })?;
    check_cancelled(cancelled)?;
    result.repositories.sort_by(|a, b| Path::new(&a.relative_path).cmp(Path::new(&b.relative_path)));
    Ok(result)
}

fn scan_folder(root: &Path, folder: &Path, inherited: Option<Ignored>, include_generated: bool, cancelled: &AtomicBool) -> GitResult<FolderContents> {
    check_cancelled(cancelled)?;
    let mut result = FolderContents { folder: folder.to_path_buf(), ..FolderContents::default() };
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if folder == root => return Err(error.into()),
        Err(_) => {
            result.skipped += 1;
            return Ok(result);
        }
    };
    let mut has_git = false;
    let mut cache_tag = false;
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
        if kind.is_file() && name.to_str().is_some_and(|name| named(name, CACHE_TAG)) {
            cache_tag = true;
            continue;
        }
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
    // A tagged cache folder (a Rust `target`, for example): its subfolders are never walked.
    if cache_tag && !include_generated && folder != root && is_cache_tag(&folder.join(CACHE_TAG)) {
        result.children.clear();
        result.excluded += 1;
    }
    let mut ignored = inherited;
    if has_git {
        if let Some(found_root) = exact_repository(folder) {
            let workspace_folder = Path::new(&found_root).parent().and_then(Path::to_str).map(str::to_owned);
            let relative_path = folder.strip_prefix(root).ok().and_then(Path::to_str).unwrap_or(&found_root).to_owned();
            result.repository = Some(FoundRepository { root: found_root, relative_path, workspace_folder });
            // Inside a working copy its own ignore rules apply, not those of a repository around it.
            if !include_generated {
                ignored = ignored_folders(folder).map(Arc::new);
            }
        } else {
            result.skipped += 1;
        }
    }
    if let Some(set) = ignored.as_ref().filter(|set| !set.is_empty()) {
        // An ignored folder that is itself a working copy (a clone kept inside another) is still found.
        let before = result.children.len();
        result.children.retain(|child| !set.contains(child) || child.join(".git").exists());
        result.excluded += before - result.children.len();
    }
    result.ignored = ignored;
    Ok(result)
}

/// Folders `folder`'s working copy ignores, collapsed to the topmost ignored folder.
fn ignored_folders(folder: &Path) -> Option<HashSet<PathBuf>> {
    let out = runner::exec(folder, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).ok()?;
    if !out.ok() {
        return None;
    }
    let listed = out.stdout.split(|byte| *byte == 0).filter_map(|entry| std::str::from_utf8(entry).ok()?.strip_suffix('/'));
    Some(listed.filter(|path| !path.is_empty()).map(|path| path.split('/').fold(folder.to_path_buf(), |full, part| full.join(part))).collect())
}

fn is_cache_tag(path: &Path) -> bool {
    let mut start = [0; CACHE_TAG_SIGNATURE.len()];
    fs::File::open(path).and_then(|mut file| file.read_exact(&mut start)).is_ok() && start == CACHE_TAG_SIGNATURE
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
        scan(path, false, &AtomicBool::new(false), &ScanProgress::default())
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
        let full = scan(root, true, &AtomicBool::new(false), &ScanProgress::default()).unwrap();
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
        let (cancelled, progress) = scans.start(running).unwrap();
        assert!(scans.start(running).is_err());
        scans.cancel(running);
        assert!(scans.progress(running).is_none());
        assert_eq!(scan(fixture.path(), false, &cancelled, &progress).err().unwrap().kind, "scan-cancelled");

        let next = scans.prepare();
        let (token, progress) = scans.start(next).unwrap();
        assert!(scan(fixture.path(), false, &token, &progress).is_ok());
        assert_eq!(scans.progress(next).unwrap().folders, 1);
        scans.finish(next);
        assert!(scans.start(next).is_err());
        assert!(scans.progress(next).is_none());
    }

    #[test]
    fn tagged_cache_folders_are_not_walked_unless_requested() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        init(&root.join("app"));
        let target = root.join("app/target");
        init(&target.join("debug/build/vendored"));
        fs::write(target.join(CACHE_TAG), "Signature: 8a477f597d28d172789f06886806bc55\n# Cargo build cache\n").unwrap();
        // A file with that name but without the signature is not a cache tag.
        init(&root.join("notes/project"));
        fs::write(root.join("notes").join(CACHE_TAG), "my notes").unwrap();

        let progress = ScanProgress::default();
        let result = scan(root, false, &AtomicBool::new(false), &progress).unwrap();
        let names: Vec<_> = result.repositories.iter().map(|repo| Path::new(&repo.root).file_name().unwrap().to_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["app", "project"]);
        assert_eq!(result.excluded, 1);
        let snapshot = progress.snapshot();
        assert_eq!(snapshot.repositories, 2);
        assert!(snapshot.folders >= 5, "{}", snapshot.folders);
        assert!(!snapshot.current.is_empty());

        let full = scan(root, true, &AtomicBool::new(false), &ScanProgress::default()).unwrap();
        assert_eq!(full.repositories.len(), 3);
        // Chosen directly, the cache folder itself is scanned.
        assert_eq!(search(&target).unwrap().repositories.len(), 1);
    }

    #[test]
    fn folders_a_repository_ignores_are_not_walked_unless_requested() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let app = root.join("app");
        init(&app);
        fs::write(app.join(".gitignore"), "bin/\nobj/\nvendor/\n").unwrap();
        // .NET test output with test repositories inside: never walked.
        init(&app.join("src/Tests/bin/Release/work/fixture"));
        fs::create_dir_all(app.join("src/Tests/obj/Debug")).unwrap();
        fs::write(app.join("src/Tests/obj/Debug/Tests.dll"), "build output").unwrap();
        fs::write(app.join("src/Tests/Tests.cs"), "source").unwrap();
        // A clone kept in an ignored folder is a working copy of its own and stays.
        init(&app.join("vendor"));
        init(&app.join("tools/helper"));

        let result = search(root).unwrap();
        let names: Vec<_> = result.repositories.iter().map(|repo| repo.relative_path.replace('\\', "/")).collect();
        assert_eq!(names, ["app", "app/tools/helper", "app/vendor"]);
        assert_eq!(result.excluded, 2);

        let full = scan(root, true, &AtomicBool::new(false), &ScanProgress::default()).unwrap();
        assert_eq!(full.repositories.len(), 4);
        assert_eq!(full.excluded, 0);
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
