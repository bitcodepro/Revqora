//! In-process repository transactions. Linked worktrees share one FIFO writer queue.
//! External Git/IDE processes do not take this lock: optimistic state checks and Git's
//! own lock files remain necessary. This is deliberately not a recovery/checkpoint store.
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
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
}

thread_local! {
    static SCOPES: RefCell<Vec<(PathBuf, bool)>> = const { RefCell::new(Vec::new()) };
}

struct Scope;
impl Drop for Scope {
    fn drop(&mut self) {
        SCOPES.with(|s| {
            s.borrow_mut().pop();
        });
    }
}

struct Turn<'a>(&'a Gate);
impl Drop for Turn<'_> {
    fn drop(&mut self) {
        self.0.tickets.lock().serving += 1;
        self.0.changed.notify_all();
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
    if write {
        let ticket = {
            let mut q = gate.tickets.lock();
            let ticket = q.next;
            q.next += 1;
            phase("queued", (ticket - q.serving) as usize);
            ticket
        };
        let mut q = gate.tickets.lock();
        while q.serving != ticket {
            gate.changed.wait(&mut q);
        }
        drop(q);
        let _turn = Turn(&gate);
        let _access = gate.access.write();
        SCOPES.with(|s| s.borrow_mut().push((key, true)));
        let _scope = Scope;
        phase("running", 0);
        f()
    } else {
        let _access = gate.access.read();
        SCOPES.with(|s| s.borrow_mut().push((key, false)));
        let _scope = Scope;
        f()
    }
}

pub fn read<T>(repo: &Path, f: impl FnOnce() -> GitResult<T>) -> GitResult<T> {
    access(repo, false, |_, _| {}, f)
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
pub fn run<T>(repo: &Path, command: &str, expected: Option<&str>, phase: impl FnMut(&str, usize), f: impl FnOnce() -> GitResult<T>) -> GitResult<T> {
    access(repo, true, phase, || {
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
                | "rebase_onto"
                | "interactive_rebase"
                | "rewrite"
                | "cherry_pick"
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
        f()
    })
}

fn hash_file(hash: &mut Sha256, path: &Path) -> GitResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            hash.update(b"symlink");
            let target = fs::read_link(path)?;
            let bytes = target.as_os_str().as_encoded_bytes();
            hash.update((bytes.len() as u64).to_le_bytes());
            hash.update(bytes);
        }
        Ok(meta) if meta.is_file() => {
            hash.update(b"file");
            hash.update(meta.len().to_le_bytes());
            let mut file = fs::File::open(path)?;
            let mut buf = [0; 64 * 1024];
            loop {
                let len = file.read(&mut buf)?;
                if len == 0 {
                    break;
                }
                hash.update(&buf[..len]);
            }
        }
        Ok(_) => {
            hash.update(b"directory");
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            hash.update(b"missing");
        }
        Err(e) => return Err(e.into()),
    }
    hash.update([0]);
    Ok(())
}

/// No write-tree, index refresh or snapshots. Hash changed files, not the entire repo.
pub fn state_token(repo: &Path, raw_status: &str, files: &[super::status::FileStatus]) -> GitResult<String> {
    let mut hash = Sha256::new();
    hash.update(raw_status.as_bytes());
    let gd = super::repo::git_dir(repo)?;
    let common = repository_key(repo);
    for p in [gd.join("HEAD"), common.join("config")] {
        hash_file(&mut hash, &p)?;
    }
    // Cache-tree/stat extensions and packed-ref layout can change without changing
    // what the user staged. Compare semantic index entries and resolved refs instead.
    hash.update(runner::run_bytes(repo, ["ls-files", "--stage", "-v", "-z"])?);
    hash.update(runner::run(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)"])?);
    for name in [
        "MERGE_HEAD",
        "MERGE_MSG",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "SQUASH_MSG",
        "revqora-squash",
        "BISECT_LOG",
        "rebase-merge/git-rebase-todo",
        "rebase-merge/done",
        "rebase-apply/next",
        "sequencer/todo",
        "logs/refs/stash",
    ] {
        hash_file(&mut hash, &gd.join(name))?;
    }
    for file in files {
        hash.update(file.path.as_bytes());
        hash_file(&mut hash, &repo.join(&file.path))?;
    }
    Ok(format!("{:x}", hash.finalize()))
}
