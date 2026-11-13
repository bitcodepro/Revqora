//! In-process repository transactions. Linked worktrees share one FIFO writer queue.
//! External Git/IDE processes do not take this lock: optimistic state checks and Git's
//! own lock files remain necessary. This is deliberately not a recovery/checkpoint store.
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
}

thread_local! {
    static SCOPES: RefCell<Vec<(PathBuf, bool)>> = const { RefCell::new(Vec::new()) };
}

fn enter_scope(key: PathBuf, write: bool) -> impl Drop {
    SCOPES.with(|s| s.borrow_mut().push((key, write)));
    DropGuard::new((), |()| {
        SCOPES.with(|s| {
            s.borrow_mut().pop();
        });
    })
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
        // Advance the FIFO only after the thread scope and the write lock are released.
        let _turn = DropGuard::new(gate.as_ref(), |gate| {
            gate.tickets.lock().serving += 1;
            gate.changed.notify_all();
        });
        let _access = gate.access.write();
        let _scope = enter_scope(key, true);
        phase("running", 0);
        f()
    } else {
        let _access = gate.access.read();
        let _scope = enter_scope(key, false);
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
        super::recovery::before(repo, command, expected)?;
        f()
    })
}

fn hash_file(hash: &mut Sha256, path: &Path) -> GitResult<[u8; 32]> {
    // One content read supplies both the repository guard and the path's display token.
    let mut content = Sha256::new();
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            content.update(b"symlink");
            let target = fs::read_link(path)?;
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
            let mut file = fs::File::open(path)?;
            let mut buf = [0; 64 * 1024];
            loop {
                let len = file.read(&mut buf)?;
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
        Err(e) => return Err(e.into()),
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
            let out = runner::exec(repo, ["var", name])?;
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
        let out = runner::exec(repo, ["config", "--null", "--path", "--get", "core.attributesFile"])?;
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
    let mut attributes = Sha256::new();
    for path in external_attribute_files(repo)? {
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
pub fn state_tokens(repo: &Path, raw_status: &str, files: &mut [super::status::FileStatus]) -> GitResult<StateTokens> {
    let mut hash = Sha256::new();
    hash.update(raw_status.as_bytes());
    let gd = super::repo::git_dir(repo)?;
    let common = repository_key(repo);
    hash_file(&mut hash, &gd.join("HEAD"))?;
    let config = hash_file(&mut hash, &common.join("config"))?;
    let info_attributes = hash_file(&mut hash, &common.join("info/attributes"))?;
    let external_attributes = hash_external_attributes(&mut hash, repo)?;
    // Cache-tree/stat extensions and packed-ref layout can change without changing
    // what the user staged. Compare semantic index entries and resolved refs instead.
    let index = runner::run_bytes(repo, ["ls-files", "--stage", "-v", "-z"])?;
    hash.update(&index);
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
    for reference in runner::run(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)"])?.lines() {
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
    // Stashes and their reflog are shared, including entries below refs/stash.
    // Removing a middle entry changes stash@{n} without changing the top OID.
    hash_file(&mut hash, &common.join("logs/refs/stash"))?;
    hash_file(&mut hash, &super::storage::dir(repo)?.join("squash-target"))?;
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
        hash.update(file.path.as_bytes());
        let content = hash_file(&mut hash, &repo.join(&file.path))?;
        let mut display = Sha256::new();
        // The porcelain seed includes index/base OIDs, modes and submodule state:
        // editing an already-MM file or staging different bytes must still refresh it.
        display.update(file.diff_token.as_bytes());
        display.update(content);
        display.update(config);
        display.update(info_attributes);
        display.update(external_attributes);
        if file.submodule {
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
        file.diff_token = format!("{:x}", display.finalize());
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
