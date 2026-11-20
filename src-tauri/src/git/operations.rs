//! In-process repository transactions. Linked worktrees share one FIFO writer queue.
//! External Git/IDE processes do not take this lock: optimistic state checks and Git's
//! own lock files remain necessary. This is deliberately not a recovery/checkpoint store.
//!
//! Locking model:
//! - Writers take a FIFO ticket, then the exclusive lock: one writer at a time, in order.
//! - Readers take the shared lock.
//! - While a writer waits on a remote (`fetch`, `push`, `ls-remote`; see [`network`]) it
//!   keeps its ticket but holds the lock shared. Reads (status, history, diffs) run instead of
//!   waiting for the network; other writers still wait for their turn. The writer takes the
//!   exclusive lock back before its next local step.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::mem::DropGuard;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::{Condvar, Mutex, RwLock};
use sha2::{Digest, Sha256};

use super::runner::{self, GitError, GitResult};

#[derive(Default)]
struct Tickets {
    next: u64,
    serving: u64,
}

#[derive(Default)]
struct Gate {
    tickets: Mutex<Tickets>,
    changed: Condvar,
    access: RwLock<()>,
    version: AtomicU64,
    /// Network sections of the current writer (see [`network`]): while non-zero, the writer
    /// holds `access` shared instead of exclusive.
    network: Mutex<usize>,
    /// Transfer id of optional work holding the queue (see [`yielding`]): the next writer
    /// stops it instead of waiting for the network.
    yielding: Mutex<Option<String>>,
}

thread_local! {
    static SCOPES: RefCell<Vec<(PathBuf, bool)>> = const { RefCell::new(Vec::new()) };
}

/// Whether the calling thread is inside any repository transaction (it may hold a gate, so it
/// must never wait for another thread's Git command).
pub fn in_any_transaction() -> bool {
    SCOPES.with(|s| !s.borrow().is_empty())
}

fn enter_scope(key: PathBuf, write: bool) -> impl Drop {
    SCOPES.with(|s| s.borrow_mut().push((key, write)));
    DropGuard::new((), |()| {
        SCOPES.with(|s| {
            s.borrow_mut().pop();
        });
    })
}

/// The calling thread's repository transaction and Operation log entry, for helper
/// threads that read on its behalf.
pub struct Inherited {
    scope: Option<(PathBuf, bool)>,
    journal: crate::journal::Shared,
}

impl Inherited {
    pub fn of(repo: &Path) -> Self {
        let key = repository_key(repo);
        Self { scope: SCOPES.with(|s| s.borrow().iter().rev().find(|(k, _)| k == &key).cloned()), journal: crate::journal::share() }
    }

    /// Runs `f` on a helper thread as part of its parent's transaction. A helper that took
    /// the repository gate again could wait behind a queued writer that waits for the parent.
    /// The parent must keep its transaction until the helper is joined (`std::thread::scope`).
    pub fn run<T>(&self, f: impl FnOnce() -> T) -> T {
        let _scope = self.scope.clone().map(|(key, write)| enter_scope(key, write));
        self.journal.enter(f)
    }
}

fn canonical(path: &Path) -> PathBuf {
    let p =
        fs::canonicalize(path).unwrap_or_else(|_| if path.is_absolute() { path.to_owned() } else { std::env::current_dir().unwrap_or_default().join(path) });
    #[cfg(windows)]
    {
        PathBuf::from(p.to_string_lossy().to_lowercase())
    }
    #[cfg(not(windows))]
    {
        p
    }
}

/// Resolve without calling the locking Git runner (which would recurse).
/// Reading the .git/commondir files also avoids a subprocess for every Git command.
pub fn repository_key(repo: &Path) -> PathBuf {
    let root = canonical(repo);
    for dir in root.ancestors() {
        let marker = dir.join(".git");
        let git_dir = if marker.is_dir() {
            Some(marker)
        } else if marker.is_file() {
            fs::read_to_string(&marker).ok().and_then(|s| s.trim().strip_prefix("gitdir:").map(|p| dir.join(p.trim())))
        } else if dir.join("HEAD").is_file() && dir.join("objects").is_dir() && dir.join("config").is_file() {
            Some(dir.to_owned())
        } else {
            None
        };
        if let Some(gd) = git_dir {
            let common = fs::read_to_string(gd.join("commondir")).ok().map(|s| gd.join(s.trim())).unwrap_or(gd);
            return canonical(&common);
        }
    }
    root
}

fn gate(key: &Path) -> Arc<Gate> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<Gate>>>> = OnceLock::new();
    GATES.get_or_init(Default::default).lock().entry(key.to_owned()).or_default().clone()
}

pub fn next_version(repo: &Path) -> u64 {
    gate(&repository_key(repo)).version.fetch_add(1, Ordering::Relaxed) + 1
}

/// Nested runner calls on the same thread reuse the transaction. A read scope must
/// never silently upgrade to a write scope: that would deadlock or mutate a read path.
pub fn access<T>(repo: &Path, write: bool, mut phase: impl FnMut(&str, usize), f: impl FnOnce() -> GitResult<T>) -> GitResult<T> {
    let key = repository_key(repo);
    let nested = SCOPES.with(|s| s.borrow().iter().rev().find(|(k, _)| k == &key).map(|(_, w)| *w));
    if let Some(parent_write) = nested {
        if write && !parent_write {
            return Err(GitError::new("A read-only repository transaction attempted to write.").kind("operation-scope"));
        }
        return f();
    }
    let gate = gate(&key);
    // Opt-in diagnostics (REVQORA_STAGE_TIMINGS): how long this call waited for the repository.
    let waiting = super::stage_timings::enabled().then(std::time::Instant::now);
    if write {
        let ticket = {
            let mut q = gate.tickets.lock();
            let ticket = q.next;
            q.next += 1;
            phase("queued", (ticket - q.serving) as usize);
            ticket
        };
        // Optional work (automatic fetch) must not make the user's operation wait for a server.
        if let Some(id) = gate.yielding.lock().clone() {
            super::runner::transfers::cancel(&id);
        }
        let mut q = gate.tickets.lock();
        while q.serving != ticket {
            gate.changed.wait(&mut q);
        }
        drop(q);
        // Advance the FIFO only after the thread scope and the write lock are released.
        let _turn = DropGuard::new(gate.as_ref(), |gate| {
            gate.tickets.lock().serving += 1;
            gate.changed.notify_all();
        });
        let _access = gate.access.write();
        note_wait(repo, "write", waiting);
        let _scope = enter_scope(key, true);
        phase("running", 0);
        f()
    } else {
        let _access = gate.access.read();
        note_wait(repo, "read", waiting);
        let _scope = enter_scope(key, false);
        f()
    }
}

/// Records a wait of at least a millisecond for the repository gate (queue time in baselines).
fn note_wait(repo: &Path, kind: &str, started: Option<std::time::Instant>) {
    let Some(waited) = started.map(|started| started.elapsed()) else { return };
    if waited >= std::time::Duration::from_millis(1) {
        let mut stages = super::stage_timings::Stages::default();
        stages.add("wait", waited);
        super::stage_timings::record("repository_wait", repo, &stages, kind);
    }
}

/// Runs optional work `f` inside a write transaction so that the next writer of the repository
/// stops it (its network commands are cancelled) instead of queueing behind it. A stopped run
/// fails with kind `repository-busy`; nothing it did not finish is applied.
pub fn yielding<T>(repo: &Path, f: impl FnOnce() -> GitResult<T>) -> GitResult<T> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let gate = gate(&repository_key(repo));
    let id = format!("yielding-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    *gate.yielding.lock() = Some(id.clone());
    let _clear = DropGuard::new(gate.as_ref(), |gate| *gate.yielding.lock() = None);
    // A writer that queued before this point would wait for the whole transfer.
    let queued = {
        let q = gate.tickets.lock();
        q.next > q.serving + 1
    };
    if queued {
        return Err(
            GitError::new("Another operation is waiting for this repository. Automatic fetch will try again at the next interval.").kind("repository-busy")
        );
    }
    super::runner::transfers::for_operation(&id, f).map_err(|error| {
        if error.kind == "cancelled" {
            GitError::new("Automatic fetch stopped for another operation in this repository. It will try again at the next interval.").kind("repository-busy")
        } else {
            error
        }
    })
}

pub fn read<T>(repo: &Path, f: impl FnOnce() -> GitResult<T>) -> GitResult<T> {
    access(repo, false, |_, _| {}, f)
}

/// Runs `f`, a Git command that waits on a remote, without blocking reads of the repository.
///
/// Inside a write transaction, the exclusive lock is downgraded to shared for the duration of
/// `f` and taken back afterwards (also when `f` panics). The writer keeps its FIFO ticket, so
/// no other writer can start in between: Git's ref updates at the end of a fetch or push never
/// interleave with a commit, checkout or another fetch from this app. Reads that run meanwhile
/// may see remote-tracking refs before or after the update; a state token taken then no longer
/// matches afterwards, so an action prepared from it is refused as stale instead of applied.
///
/// Outside a write transaction (a read scope, or no transaction) `f` runs unchanged.
///
/// Helper threads that join the writer (see [`Inherited`]) share the downgrade: while any of
/// them is in a network section, none of them may change the repository locally.
pub fn network<T>(repo: &Path, f: impl FnOnce() -> T) -> T {
    let key = repository_key(repo);
    let writer = SCOPES.with(|s| s.borrow().iter().rev().find(|(k, _)| k == &key).map(|(_, write)| *write));
    if writer != Some(true) {
        return f();
    }
    use parking_lot::lock_api::{RawRwLock as _, RawRwLockDowngrade as _};
    let gate = gate(&key);
    {
        let mut sections = gate.network.lock();
        if *sections == 0 {
            // SAFETY: a write scope exists only inside `access(.., write = true)` (or a helper
            // the writer joins before leaving it), which holds `gate.access` exclusively.
            unsafe { gate.access.raw().downgrade() };
        }
        *sections += 1;
    }
    let _exclusive_again = DropGuard::new(gate.as_ref(), |gate| {
        let mut sections = gate.network.lock();
        *sections -= 1;
        if *sections == 0 {
            // SAFETY: the shared lock taken by `downgrade` above is still held. The writer's
            // ticket keeps other writers out; readers finish and new ones wait.
            unsafe {
                gate.access.raw().unlock_shared();
                gate.access.raw().lock_exclusive();
            }
        }
    });
    f()
}

/// [`network`] when `enabled`, otherwise `f()`.
pub fn network_when<T>(repo: &Path, enabled: bool, f: impl FnOnce() -> T) -> T {
    if enabled {
        network(repo, f)
    } else {
        f()
    }
}

/// Whether a writer holds or waits for this repository (diagnostics and optional work that
/// should not queue in front of the user).
pub fn writer_active(repo: &Path) -> bool {
    let gate = gate(&repository_key(repo));
    let tickets = gate.tickets.lock();
    tickets.next != tickets.serving
}

/// Whether a writer of this repository is currently waiting on a remote (see [`network`]).
pub fn network_active(repo: &Path) -> bool {
    *gate(&repository_key(repo)).network.lock() > 0
}

/// Bind editor data to the state it loaded, rather than an older UI cache.
pub fn inspect<T>(repo: &Path, f: impl FnOnce() -> GitResult<T>) -> GitResult<(T, String)> {
    read(repo, || {
        let before = super::status::status(repo)?.state_token.unwrap_or_default();
        let value = f()?;
        let after = super::status::status(repo)?.state_token.unwrap_or_default();
        if before != after {
            return Err(GitError::new("The repository changed while loading this view. Reopen it to review the current state.").kind("stale-operation"));
        }
        Ok((value, after))
    })
}

/// Check the UI's last observed state AFTER reaching the front of the queue.
pub fn run<T: serde::Serialize>(
    repo: &Path,
    command: &str,
    expected: Option<&str>,
    phase: impl FnMut(&str, usize),
    f: impl FnOnce() -> GitResult<T>,
) -> GitResult<T> {
    access(repo, true, phase, || {
        // The user's decisions belong to this operation only; they and its watch are dropped on
        // every exit, a rejected precondition or a panic included.
        super::recovery::begin(repo, command);
        let _finish = super::recovery::Finish(repo.to_owned());
        if let Some(expected) = expected {
            let current = super::status::status(repo)?;
            if current.state_token.as_deref() != Some(expected) {
                return Err(GitError::new(
                    "The repository changed since this action was prepared. Refresh and reopen the confirmation or editor before trying again. Nothing was changed by this operation.",
                )
                .kind("stale-operation"));
            }
        }
        if matches!(
            command,
            "checkout"
                | "merge_start"
                | "pull"
                | "pull_all_branches"
                | "rebase_onto"
                | "interactive_rebase"
                | "rewrite"
                | "cherry_pick"
                | "cherry_pick_compared_commit"
                | "revert"
                | "apply_patch"
                | "layer_commit"
                | "undo_commit"
        ) {
            let gd = super::repo::git_dir(repo)?;
            let state = super::repo::op_state(repo, &gd);
            if state.kind != "none" && !(command == "checkout" && state.kind == "bisect") {
                return Err(GitError::new(format!("Finish or abort the current {} operation first.", state.kind)).kind("operation-in-progress"));
            }
        }
        let result = super::recovery::before(repo, command, expected).and_then(|()| f());
        // The checkpoints saved for this operation keep its result and what it changed.
        super::recovery::record_outcome(crate::journal::result_status(&result).0, result.as_ref().err().map(|e| e.message.as_str()));
        result
    })
}

fn fingerprint_io(action: &str, path: &Path, error: std::io::Error) -> GitError {
    let mut result = GitError::from(error).kind("status-file-io");
    result.message = format!("{action} {} ({})", path.display(), result.message);
    result
}

fn retry_fingerprint_io<T>(mut read: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    #[cfg(windows)]
    for _ in 0..3 {
        match read() {
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) => std::thread::sleep(std::time::Duration::from_millis(40)),
            result => return result,
        }
    }
    read()
}

#[cfg(all(test, windows))]
#[test]
fn status_fingerprint_retries_a_temporary_windows_file_lock() {
    use std::os::windows::fs::OpenOptionsExt;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("locked.txt");
    fs::write(&path, "content").unwrap();
    let lock = || fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
    let handle = lock();
    let error = hash_file(&mut Sha256::new(), &path).unwrap_err();
    assert_eq!(error.kind, "status-file-io");
    assert!(error.message.contains("locked.txt"));
    assert!(error.details.iter().any(|detail| matches!(detail.as_str(), "os_error=5" | "os_error=32" | "os_error=33")));
    std::thread::scope(|scope| {
        scope.spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            drop(handle);
        });
        hash_file(&mut Sha256::new(), &path).unwrap();
    });
}

fn hash_file(hash: &mut Sha256, path: &Path) -> GitResult<[u8; 32]> {
    // One content read supplies both the repository guard and the path's display token.
    let mut content = Sha256::new();
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            content.update(b"symlink");
            let target = fs::read_link(path).map_err(|error| fingerprint_io("Read link", path, error))?;
            let bytes = target.as_os_str().as_encoded_bytes();
            content.update((bytes.len() as u64).to_le_bytes());
            content.update(bytes);
        }
        Ok(meta) if meta.is_file() => {
            content.update(b"file");
            content.update(meta.len().to_le_bytes());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                content.update((meta.permissions().mode() & 0o111).to_le_bytes());
            }
            let mut file = retry_fingerprint_io(|| fs::File::open(path)).map_err(|error| fingerprint_io("Open file for status", path, error))?;
            let mut buf = [0; 64 * 1024];
            loop {
                let len = retry_fingerprint_io(|| file.read(&mut buf)).map_err(|error| fingerprint_io("Read file for status", path, error))?;
                if len == 0 {
                    break;
                }
                content.update(&buf[..len]);
            }
        }
        Ok(_) => {
            content.update(b"directory");
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            content.update(b"missing");
        }
        Err(error) => return Err(fingerprint_io("Inspect file for status", path, error)),
    }
    let digest = content.finalize().into();
    hash.update(digest);
    Ok(digest)
}

fn hash_attribute(hash: &mut Sha256, path: &Path, indexed: Option<&[u8]>) -> GitResult<[u8; 32]> {
    let mut attribute = Sha256::new();
    attribute.update(hash_file(hash, path)?);
    if let Some(indexed) = indexed {
        attribute.update(indexed);
    }
    Ok(attribute.finalize().into())
}

pub struct StateTokens {
    pub state: String,
    pub diff_context: String,
}

pub(super) fn external_attribute_files(repo: &Path) -> GitResult<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if runner::version_at_least(2, 42) {
        // Git resolves configured paths, ~/ and its platform-specific defaults.
        // Query only these variables: `var -l` also exposes arbitrary config.
        for name in ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"] {
            let out = super::config_cache::exec(repo, &["var", name])?;
            if out.ok() {
                let value = out.text();
                let value = value.strip_suffix('\n').unwrap_or(&value).trim_end_matches('\r');
                if !value.is_empty() {
                    paths.push(repo.join(value));
                }
            } else if out.code != 1 {
                return Err(runner::to_error("Resolve Git attributes file", &out));
            }
        }
    } else {
        let out = super::config_cache::exec(repo, &["config", "--null", "--path", "--get", "core.attributesFile"])?;
        if out.ok() {
            let path = out.text();
            let path = path.trim_end_matches('\0');
            if !path.is_empty() {
                paths.push(repo.join(path));
            }
        } else if out.code == 1 {
            let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
            let config =
                std::env::var_os("XDG_CONFIG_HOME").filter(|s| !s.is_empty()).map(PathBuf::from).or_else(|| home.map(|p| PathBuf::from(p).join(".config")));
            if let Some(config) = config {
                paths.push(config.join("git/attributes"));
            }
        } else {
            return Err(runner::to_error("Resolve configured attributes file", &out));
        }
    }
    Ok(paths)
}

fn hash_external_attributes(hash: &mut Sha256, repo: &Path) -> GitResult<[u8; 32]> {
    hash_attribute_files(hash, external_attribute_files(repo)?)
}

fn hash_attribute_files(hash: &mut Sha256, files: Vec<PathBuf>) -> GitResult<[u8; 32]> {
    let mut attributes = Sha256::new();
    for path in files {
        let name = path.as_os_str().as_encoded_bytes();
        attributes.update((name.len() as u64).to_le_bytes());
        attributes.update(name);
        attributes.update(hash_file(hash, &path)?);
        // Unlike worktree .gitattributes, a configured global file can be a
        // symlink; its target's contents also affect Git's interpretation.
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            match fs::canonicalize(&path) {
                Ok(target) => {
                    attributes.update(hash_file(hash, &target)?);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    let digest = attributes.finalize().into();
    hash.update(digest);
    Ok(digest)
}

fn submodule_fingerprint(module: &Path) -> GitResult<[u8; 32]> {
    let mut hash = Sha256::new();
    let mut pending = vec![module.to_owned()];
    let mut seen = std::collections::BTreeSet::new();
    let mut attributes = std::collections::BTreeSet::new();
    while let Some(root) = pending.pop() {
        if !seen.insert(canonical(&root)) {
            return Err(GitError::new("A cyclic submodule worktree cannot be inspected.").kind("submodule-cycle"));
        }
        if !root.join(".git").exists() {
            hash.update(b"uninitialized\0");
            continue;
        }
        // Explicit Git dir prevents fallback to the parent after deinitializing.
        // --branch captures the actual checked-out OID, including detached HEAD.
        let out = runner::exec_full(
            &root,
            ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=no", "--ignore-submodules=none"],
            &[("GIT_DIR", ".git")],
            None,
        )?;
        if !out.ok() {
            return Err(runner::to_error("git status submodule", &out));
        }
        hash.update(&out.stdout);
        let common = repository_key(&root);
        hash_file(&mut hash, &common.join("config"))?;
        hash_file(&mut hash, &common.join("info/attributes"))?;
        hash_external_attributes(&mut hash, &root)?;
        // Inline submodule diffs can change while HEAD and dirty flags stay the
        // same. Stream tracked dirty contents instead of materializing a patch.
        for file in super::status::parse(&out.text()).files {
            if file.untracked {
                continue; // Git's inline diff does not display untracked contents.
            }
            let path = root.join(&file.path);
            hash_file(&mut hash, &path)?;
            for parent in path.parent().into_iter().flat_map(Path::ancestors).take_while(|p| p.starts_with(&root)) {
                let attr = parent.join(".gitattributes");
                if attributes.insert(attr.clone()) {
                    hash_file(&mut hash, &attr)?;
                }
            }
            if file.submodule {
                pending.push(path);
            }
        }
    }
    Ok(hash.finalize().into())
}

/// No write-tree, index refresh or snapshots. Hash changed files and Git attributes,
/// not the entire worktree. The display context never substitutes for the full guard.
/// The Git reads behind a state token. They do not depend on `git status` output, so a
/// status read starts them alongside `git status` (three processes in about the time of one).
pub struct StateReads {
    gd: GitResult<PathBuf>,
    external_files: GitResult<Vec<PathBuf>>,
    index: GitResult<Vec<u8>>,
    references: Option<GitResult<String>>,
}

impl StateReads {
    /// The `ls-files --stage -v -z` listing read for the token (whole index when no display path).
    pub fn index(&self) -> Option<&[u8]> {
        self.index.as_deref().ok()
    }
}

pub fn state_reads(repo: &Path, display_path: Option<&str>) -> StateReads {
    // Cache-tree/stat extensions and packed-ref layout can change without changing
    // what the user staged. Compare semantic index entries and resolved refs instead.
    let mut index_args = vec!["ls-files", "--stage", "-v", "-z"];
    if display_path.is_some() {
        index_args.extend(["--", ":(glob)**/.gitattributes"]);
    }
    // The Git reads below are independent of each other: run them side by side inside
    // this transaction, then hash their results in a fixed order.
    let parent = Inherited::of(repo);
    let failed = || GitError::new("Background status task failed.");
    let dirs = super::repo::git_dir(repo).ok().map(|gd| {
        let common = super::graph::common_dir(repo).unwrap_or_else(|| gd.clone());
        (gd, common)
    });
    std::thread::scope(|sc| {
        let external_files = sc.spawn(|| parent.run(|| external_attribute_files(repo)));
        let index = sc.spawn(|| {
            parent.run(|| {
                let stamp = dirs.as_ref().and_then(|(gd, _)| state_cache::index_stamp(gd));
                state_cache::remembered(repo, "index", &index_args, stamp, || runner::run_bytes(repo, &index_args))
            })
        });
        let references = display_path.is_none().then(|| {
            sc.spawn(|| {
                parent.run(|| {
                    let stamp = dirs.as_ref().and_then(|(gd, common)| state_cache::refs_stamp(gd, common));
                    state_cache::refs_listing(repo, stamp)
                })
            })
        });
        let gd = super::repo::git_dir(repo);
        StateReads {
            gd,
            external_files: external_files.join().unwrap_or_else(|_| Err(failed())),
            index: index.join().unwrap_or_else(|_| Err(failed())),
            references: references.map(|task| task.join().unwrap_or_else(|_| Err(failed()))),
        }
    })
}

/// Outputs of the state-token reads that depend only on the index or only on the refs, reused
/// while those files keep their size and modification time. A file changed within the last
/// two seconds is never trusted (Git's own racy-timestamp rule: a second change in the same
/// clock tick can keep both), so the read runs again then.
pub mod state_cache {
    use super::*;
    use std::time::{Duration, SystemTime};

    pub type Stamp = u64;
    const RACY: Duration = Duration::from_secs(2);
    const KEPT: usize = 16;

    fn settled(modified: SystemTime, now: SystemTime) -> bool {
        now.duration_since(modified).is_ok_and(|age| age >= RACY)
    }

    fn hash_meta(hasher: &mut impl std::hash::Hasher, path: &Path, now: SystemTime) -> Option<()> {
        use std::hash::Hash;
        path.hash(hasher);
        match fs::metadata(path) {
            Ok(meta) => {
                let modified = meta.modified().ok()?;
                if !settled(modified, now) {
                    return None;
                }
                meta.len().hash(hasher);
                modified.hash(hasher);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0u8.hash(hasher),
            Err(_) => return None,
        }
        Some(())
    }

    /// The index file, or None when it changed recently or cannot be read.
    pub fn index_stamp(gd: &Path) -> Option<Stamp> {
        let now = SystemTime::now();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        hash_meta(&mut hasher, &gd.join("index"), now)?;
        // A split index keeps entries in a shared file as well.
        if let Ok(entries) = fs::read_dir(gd) {
            let mut shared: Vec<PathBuf> =
                entries.flatten().map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("sharedindex."))).collect();
            shared.sort();
            for file in shared {
                hash_meta(&mut hasher, &file, now)?;
            }
        }
        Some(std::hash::Hasher::finish(&hasher))
    }

    /// Every ref file (loose refs of the repository and of this worktree, packed-refs, HEAD),
    /// or None for reftable, for a recent change, or when a folder cannot be read.
    pub fn refs_stamp(gd: &Path, common: &Path) -> Option<Stamp> {
        if common.join("reftable").exists() || gd.join("reftable").exists() {
            return None;
        }
        let now = SystemTime::now();
        let mut files = vec![common.join("packed-refs"), gd.join("HEAD"), common.join("HEAD")];
        let mut stack = vec![common.join("refs")];
        if gd != common {
            stack.push(gd.join("refs"));
        }
        while let Some(dir) = stack.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return None,
            };
            // A folder whose entries changed recently may hide a renamed ref.
            if !settled(fs::metadata(&dir).ok()?.modified().ok()?, now) {
                return None;
            }
            for entry in entries.flatten() {
                match entry.file_type() {
                    Ok(t) if t.is_dir() => stack.push(entry.path()),
                    Ok(_) => files.push(entry.path()),
                    Err(_) => return None,
                }
            }
        }
        files.sort();
        files.dedup();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for file in &files {
            hash_meta(&mut hasher, file, now)?;
        }
        Some(std::hash::Hasher::finish(&hasher))
    }

    /// Everything `worktree list` reads: the ref files (each worktree's commit), the repository
    /// configuration (bare, core.worktree), and per linked worktree its HEAD, lock, recorded
    /// location and whether that location still exists (prunable). None as [`refs_stamp`].
    pub fn worktrees_stamp(gd: &Path, common: &Path) -> Option<Stamp> {
        use std::hash::Hash;
        let refs = refs_stamp(gd, common)?;
        let now = SystemTime::now();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        refs.hash(&mut hasher);
        hash_meta(&mut hasher, &common.join("config"), now)?;
        // With extensions.worktreeConfig, core.bare and core.worktree can live per worktree.
        hash_meta(&mut hasher, &common.join("config.worktree"), now)?;
        hash_meta(&mut hasher, &gd.join("config.worktree"), now)?;
        let folder = common.join("worktrees");
        let mut linked: Vec<PathBuf> = match fs::read_dir(&folder) {
            Ok(entries) => {
                // A worktree added or removed just now changes the folder.
                if !settled(fs::metadata(&folder).ok()?.modified().ok()?, now) {
                    return None;
                }
                entries.flatten().map(|e| e.path()).collect()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => return None,
        };
        linked.sort();
        for dir in linked {
            for name in ["HEAD", "locked", "gitdir", "commondir", "config.worktree"] {
                hash_meta(&mut hasher, &dir.join(name), now)?;
            }
            // The worktree's own `.git` file: a folder deleted outside Git becomes prunable.
            if let Ok(target) = fs::read_to_string(dir.join("gitdir")) {
                hash_meta(&mut hasher, Path::new(target.trim()), now)?;
            }
        }
        Some(std::hash::Hasher::finish(&hasher))
    }

    type Key = (PathBuf, &'static str, Vec<String>);
    type Entry = (Key, Stamp, Vec<u8>);

    fn entries() -> &'static Mutex<Vec<Entry>> {
        static ENTRIES: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
        ENTRIES.get_or_init(Default::default)
    }

    /// `read`'s output, reused while `stamp` (None: always read) is unchanged.
    pub fn remembered<S: AsRef<str>>(
        repo: &Path,
        kind: &'static str,
        args: &[S],
        stamp: Option<Stamp>,
        read: impl FnOnce() -> GitResult<Vec<u8>>,
    ) -> GitResult<Vec<u8>> {
        let key: Key = (repo.to_path_buf(), kind, args.iter().map(|a| a.as_ref().to_owned()).collect());
        let Some(stamp) = stamp else { return read() };
        if let Some((_, _, out)) = entries().lock().iter().find(|(k, s, _)| k == &key && *s == stamp) {
            return Ok(out.clone());
        }
        let out = read()?;
        let mut list = entries().lock();
        list.retain(|(k, _, _)| k != &key);
        if list.len() >= KEPT {
            list.remove(0);
        }
        list.push((key, stamp, out.clone()));
        Ok(out)
    }

    /// Every ref with its object (`for-each-ref`), reused while `stamp` is unchanged.
    pub fn refs_listing(repo: &Path, stamp: Option<Stamp>) -> GitResult<String> {
        let args = ["for-each-ref", "--format=%(refname)%00%(objectname)"];
        remembered(repo, "refs", &args, stamp, || runner::run_bytes(repo, args)).map(|out| String::from_utf8_lossy(&out).into_owned())
    }

    /// [`refs_listing`] with the stamp of `repo`'s ref files.
    pub fn current_refs(repo: &Path) -> GitResult<String> {
        let stamp = super::super::repo::git_dir(repo).ok().and_then(|gd| {
            let common = super::super::graph::common_dir(repo).unwrap_or_else(|| gd.clone());
            refs_stamp(&gd, &common)
        });
        refs_listing(repo, stamp)
    }

    /// Forgets every remembered output (tests that count Git processes).
    pub fn forget() {
        entries().lock().clear();
    }
}

pub fn state_tokens(repo: &Path, raw_status: &str, files: &mut [super::status::FileStatus], display_path: Option<&str>) -> GitResult<StateTokens> {
    state_tokens_from(repo, raw_status, files, display_path, state_reads(repo, display_path))
}

pub fn state_tokens_from(
    repo: &Path,
    raw_status: &str,
    files: &mut [super::status::FileStatus],
    display_path: Option<&str>,
    reads: StateReads,
) -> GitResult<StateTokens> {
    let mut hash = Sha256::new();
    hash.update(raw_status.as_bytes());
    let StateReads { gd, external_files, index, references } = reads;
    let gd = gd?;
    let common = repository_key(repo);
    hash_file(&mut hash, &gd.join("HEAD"))?;
    let config = hash_file(&mut hash, &common.join("config"))?;
    let info_attributes = hash_file(&mut hash, &common.join("info/attributes"))?;
    let external_attributes = hash_attribute_files(&mut hash, external_files?)?;
    let index = index?;
    if display_path.is_none() {
        hash.update(&index);
    }
    // Git falls back to indexed .gitattributes when the worktree copy is absent.
    let mut indexed_attributes: BTreeMap<PathBuf, Vec<u8>> = BTreeMap::new();
    for entry in String::from_utf8_lossy(&index).split('\0') {
        if let Some((_, name)) = entry.split_once('\t') {
            if Path::new(name).file_name().is_some_and(|name| name == ".gitattributes") {
                indexed_attributes.entry(repo.join(name)).or_default().extend_from_slice(entry.as_bytes());
            }
        }
    }
    // Recovery pins are app metadata, not changes to the user's prepared Git
    // state. A rejected action may save a checkpoint before offering force
    // consent. Recovery itself verifies each pin independently with exact OIDs.
    if let Some(references) = references {
        for reference in references?.lines() {
            if !reference.starts_with(super::recovery::PREFIX) {
                hash.update(reference.as_bytes());
                hash.update(b"\n");
            }
        }
        for name in [
            "MERGE_HEAD",
            "MERGE_MSG",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "SQUASH_MSG",
            "BISECT_LOG",
            "rebase-merge/git-rebase-todo",
            "rebase-merge/done",
            "rebase-apply/next",
            "sequencer/todo",
        ] {
            hash_file(&mut hash, &gd.join(name))?;
        }
        // Stash reflog entries below the tip are part of the mutation proof.
        hash_file(&mut hash, &common.join("logs/refs/stash"))?;
        hash_file(&mut hash, &super::storage::dir_for(&gd)?.join("squash-target"))?;
    }
    let mut attributes = BTreeMap::new();
    // Indexed attributes may affect a sealed layer even if later layers cancel
    // that file's net index change and it is absent from the ordinary status list.
    for path in indexed_attributes
        .keys()
        .cloned()
        .chain(files.iter().filter(|f| Path::new(&f.path).file_name().is_some_and(|name| name == ".gitattributes")).map(|f| repo.join(&f.path)))
    {
        if let std::collections::btree_map::Entry::Vacant(entry) = attributes.entry(path) {
            let path = entry.key();
            let digest = hash_attribute(&mut hash, path, indexed_attributes.get(path).map(Vec::as_slice))?;
            entry.insert(digest);
        }
    }
    for file in files {
        let track_content = display_path.is_none_or(|path| path == file.path);
        let content = if track_content {
            hash.update(file.path.as_bytes());
            Some(hash_file(&mut hash, &repo.join(&file.path))?)
        } else {
            None
        };
        let mut display = Sha256::new();
        // The porcelain seed includes index/base OIDs, modes and submodule state:
        // editing an already-MM file or staging different bytes must still refresh it.
        display.update(file.diff_token.as_bytes());
        if let Some(content) = content {
            display.update(content);
        }
        display.update(config);
        display.update(info_attributes);
        display.update(external_attributes);
        if track_content && file.submodule {
            let module = submodule_fingerprint(&repo.join(&file.path))?;
            hash.update(module);
            display.update(module);
        }
        for name in [Some(file.path.as_str()), file.orig_path.as_deref()].into_iter().flatten() {
            let path = repo.join(name);
            for parent in path.parent().into_iter().flat_map(Path::ancestors).take_while(|p| p.starts_with(repo)) {
                let path = parent.join(".gitattributes");
                let digest = match attributes.get(&path) {
                    Some(digest) => *digest,
                    None => {
                        let digest = hash_attribute(&mut hash, &path, indexed_attributes.get(&path).map(Vec::as_slice))?;
                        attributes.insert(path, digest);
                        digest
                    }
                };
                display.update(digest);
            }
        }
        if track_content {
            file.diff_token = format!("{:x}", display.finalize());
        }
    }
    let mut context = Sha256::new();
    context.update(config);
    context.update(info_attributes);
    context.update(external_attributes);
    for (path, digest) in attributes {
        // Missing candidates discovered because an unrelated file appeared must
        // not change the interpretation generation (e.g. a new SQLite WAL).
        if indexed_attributes.contains_key(&path) || path.exists() {
            let name = path.as_os_str().as_encoded_bytes();
            context.update((name.len() as u64).to_le_bytes());
            context.update(name);
            context.update(digest);
        }
    }
    Ok(StateTokens { state: format!("{:x}", hash.finalize()), diff_context: format!("{:x}", context.finalize()) })
}
