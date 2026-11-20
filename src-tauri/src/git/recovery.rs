//! Local recovery checkpoints. Restoring a workspace always creates a new worktree.
//! Saved Git objects are pinned; file bytes and the index are kept outside the worktree.
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{operations, repo, runner, status};
use runner::{GitError, GitResult};

const MAX_SNAPSHOT: u64 = 100 * 1024 * 1024;
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
const MAX_COUNT: usize = 100;
const MAX_FILES: usize = 20_000;
const RETENTION: i64 = 30 * 24 * 3600 * 1000;
pub(crate) const PREFIX: &str = "refs/revqora/recovery/";

fn fail(message: impl Into<String>) -> GitError {
    GitError::new(message).kind("recovery")
}
fn oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_id(id: &str) -> bool {
    id.starts_with("cp-") && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn base(root: &Path) -> GitResult<PathBuf> {
    Ok(super::storage::common(root)?.join("recovery"))
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(disk) = value.strip_prefix(r"\\?\") {
            return disk.into();
        }
    }
    value.into_owned()
}
fn regular(path: &Path) -> GitResult<fs::Metadata> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err(fail("A checkpoint file was replaced by a link or directory."));
    }
    Ok(m)
}
fn digest(path: &Path) -> GitResult<String> {
    regular(path)?;
    let mut reader = File::open(path)?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 64 * 1024];
    loop {
        let n = reader.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn copy_file(source: &Path, target: &Path, budget: &mut u64) -> GitResult<String> {
    let m = regular(source)?;
    if m.len() > MAX_SNAPSHOT.saturating_sub(*budget) {
        return Err(fail("Recovery checkpoint exceeds 100 MiB. Commit or stash large changes before this action."));
    }
    let mut input = File::open(source)?.take(MAX_SNAPSHOT.saturating_sub(*budget) + 1);
    let mut output = OpenOptions::new().create_new(true).write(true).open(target)?;
    let size = std::io::copy(&mut input, &mut output)?;
    *budget += size;
    if *budget > MAX_SNAPSHOT {
        return Err(fail("A growing file exceeded the recovery checkpoint size limit."));
    }
    output.sync_all()?;
    digest(target)
}
fn git(root: &Path, args: &[String], input: Option<&[u8]>) -> GitResult<String> {
    let out = runner::exec_full(root, args, &[], input)?;
    if !out.ok() {
        return Err(runner::to_error("Git recovery", &out));
    }
    Ok(out.text().trim().to_owned())
}
/// Let Git normalize true/yes/on/1 (and valueless keys), and fail closed on
/// malformed configuration rather than silently capturing a different layout.
fn config_bool(root: &Path, key: &str) -> GitResult<bool> {
    let out = super::config_cache::exec(root, &["config", "--bool", "--get", key])?;
    if out.ok() {
        return Ok(out.text().trim() == "true");
    }
    if out.code == 1 {
        return Ok(false);
    }
    Err(runner::to_error("git config --bool --get", &out))
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).into()).collect()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub created_at: i64,
    pub command: String,
    pub label: String,
    pub source_root: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub workspace: bool,
    pub includes_ignored: bool,
    pub files: usize,
    pub references: usize,
    pub bytes: u64,
    /// Result of the operation the checkpoint was saved for (listing only; never stored in the
    /// manifest): running, succeeded, attention, failed or interrupted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_status: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRef {
    pub name: String,
    pub oid: String,
    pub kind: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPath {
    pub path: String,
    pub kind: String,
    pub sha256: Option<String>,
    pub target: Option<String>,
    pub directory_link: bool,
    pub mode: u32,
}
#[derive(Clone, Serialize, Deserialize)]
struct IndexFile {
    name: String,
    sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    #[serde(flatten)]
    pub summary: Summary,
    pub version: u32,
    pub common_dir: String,
    pub pin: String,
    pub base_commit: String,
    pub refs: Vec<SavedRef>,
    pub paths: Vec<SavedPath>,
    index_files: Vec<IndexFile>,
    pub sparse: bool,
    pub sparse_cone: bool,
    pub sparse_patterns: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub checkpoints: Vec<Summary>,
    pub storage_path: String,
    pub warning: Option<String>,
    pub max_checkpoint_bytes: u64,
    pub max_total_bytes: u64,
    pub max_count: usize,
    pub retention_days: u32,
}

fn read(root: &Path, id: &str) -> GitResult<Checkpoint> {
    if !valid_id(id) {
        return Err(fail("Invalid recovery checkpoint ID."));
    }
    let dir = base(root)?.join(id);
    for path in [base(root)?.parent().unwrap().to_owned(), base(root)?, dir.clone(), dir.join("files"), dir.join("meta")] {
        let m = fs::symlink_metadata(path)?;
        if !m.is_dir() || m.file_type().is_symlink() {
            return Err(fail("Checkpoint directories cannot be symbolic links."));
        }
    }
    let file = dir.join("checkpoint.json");
    if regular(&file)?.len() > 16 * 1024 * 1024 {
        return Err(fail("Checkpoint manifest is too large."));
    }
    let cp: Checkpoint = serde_json::from_slice(&fs::read(file)?).map_err(|e| fail(format!("Unreadable checkpoint: {e}")))?;
    if cp.version != 1
        || cp.summary.id != id
        || cp.common_dir != operations::repository_key(root).to_string_lossy()
        || !oid(&cp.pin)
        || !oid(&cp.base_commit)
        || cp.paths.len() > MAX_FILES
        || cp.refs.len() > MAX_FILES
        || cp.summary.files != cp.paths.len()
        || cp.summary.references != cp.refs.len()
        || cp.summary.bytes > MAX_SNAPSHOT
    {
        return Err(fail("This checkpoint is incompatible with this repository."));
    }
    if cp.refs.iter().any(|r| !oid(&r.oid)) {
        return Err(fail("Invalid checkpoint reference."));
    }
    for item in &cp.paths {
        relative(&item.path)?;
        if !matches!(item.kind.as_str(), "file" | "missing" | "link" | "directory") {
            return Err(fail("Invalid checkpoint file type."));
        }
    }
    for item in &cp.index_files {
        if item.name != "index" && !(item.name.starts_with("sharedindex.") && oid(&item.name[12..])) {
            return Err(fail("Invalid checkpoint index file."));
        }
    }
    Ok(cp)
}

pub fn list(root: &Path) -> GitResult<Catalog> {
    if fs::symlink_metadata(base(root)?).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(fail("Recovery storage cannot be a symbolic link."));
    }
    let mut items = Vec::new();
    let mut skipped = 0;
    match fs::read_dir(base(root)?) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                let id = entry.file_name().to_string_lossy().into_owned();
                if !valid_id(&id) {
                    continue;
                }
                match read(root, &id) {
                    Ok(cp) => {
                        let mut summary = cp.summary;
                        summary.operation_status = outcome::listed_status(root, &id);
                        items.push(summary);
                    }
                    Err(_) => skipped += 1,
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    Ok(Catalog {
        checkpoints: items,
        storage_path: base(root)?.to_string_lossy().into_owned(),
        warning: (skipped > 0).then(|| format!("{skipped} incomplete or unreadable checkpoints were preserved and omitted.")),
        max_checkpoint_bytes: MAX_SNAPSHOT,
        max_total_bytes: MAX_TOTAL,
        max_count: MAX_COUNT,
        retention_days: 30,
    })
}

pub fn detail(root: &Path, id: &str) -> GitResult<Checkpoint> {
    read(root, id)
}

fn lock(root: &Path) -> GitResult<File> {
    let common = super::storage::common(root)?;
    for dir in [common.clone(), base(root)?] {
        if dir.exists() && fs::symlink_metadata(&dir)?.file_type().is_symlink() {
            return Err(fail("Recovery storage cannot be a symbolic link."));
        }
        fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    let lock_path = common.join("recovery.lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(fail("Recovery lock cannot be a symbolic link."));
    }
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(lock_path)?;
    file.lock_exclusive()?;
    Ok(file)
}

fn relative(path: &str) -> GitResult<&Path> {
    let p = Path::new(path);
    if p.as_os_str().is_empty()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
        || p.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
    {
        return Err(fail("Unsafe checkpoint path."));
    }
    Ok(p)
}
fn source_path(root: &Path, path: &str) -> GitResult<PathBuf> {
    let p = relative(path)?;
    let mut current = root.to_owned();
    if let Some(parent) = p.parent() {
        for component in parent.components() {
            current.push(component.as_os_str());
            if let Ok(m) = fs::symlink_metadata(&current) {
                if m.file_type().is_symlink() {
                    return Err(fail("Checkpoint paths cannot traverse directory links."));
                }
            }
        }
    }
    Ok(root.join(p))
}

fn refs(root: &Path) -> GitResult<Vec<SavedRef>> {
    // Both reads are independent: run them side by side (each Git start costs 60–100 ms on
    // Windows). The helper joins the caller's repository transaction.
    let parent = operations::Inherited::of(root);
    let (raw, stashes) = std::thread::scope(|scope| {
        let stashes = scope.spawn(|| parent.run(|| runner::run(root, ["stash", "list", "--format=%H"])));
        let raw = runner::run(
            root,
            ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(objecttype)", "refs/heads", "refs/remotes", "refs/worktree/revqora", "refs/stash"],
        );
        (raw, stashes.join().unwrap_or_else(|_| Err(fail("Reading the stash list failed."))))
    });
    let (raw, stashes) = (raw?, stashes?);
    let mut refs = Vec::new();
    for line in raw.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() == 3 && fields[2] == "commit" {
            let kind = if fields[0].starts_with("refs/heads/") {
                "branch"
            } else if fields[0].starts_with("refs/remotes/") {
                "remote"
            } else {
                "layer"
            };
            refs.push(SavedRef { name: fields[0].into(), oid: fields[1].into(), kind: kind.into() });
        }
    }
    for (i, value) in stashes.lines().enumerate() {
        refs.push(SavedRef { name: format!("stash@{{{i}}}"), oid: value.into(), kind: "stash".into() });
    }
    if refs.len() > MAX_FILES {
        return Err(fail("Too many references for a recovery checkpoint."));
    }
    Ok(refs)
}

fn commit(root: &Path, tree: &str, parents: &[String]) -> GitResult<String> {
    let mut args = strings(&["-c", "commit.gpgsign=false", "commit-tree", tree]);
    for parent in parents {
        args.extend(["-p".into(), parent.clone()]);
    }
    let out = runner::exec_full(
        root,
        args,
        &[
            ("GIT_AUTHOR_NAME", "Revqora Recovery"),
            ("GIT_AUTHOR_EMAIL", "recovery@revqora.invalid"),
            ("GIT_COMMITTER_NAME", "Revqora Recovery"),
            ("GIT_COMMITTER_EMAIL", "recovery@revqora.invalid"),
        ],
        Some(b"Revqora local recovery checkpoint\n"),
    )?;
    if !out.ok() {
        return Err(runner::to_error("Create recovery object", &out));
    }
    Ok(out.text().trim().into())
}

pub fn create(root: &Path, command: &str, label: &str, workspace: bool, ignored: bool) -> GitResult<Summary> {
    create_expected(root, command, label, workspace, ignored, None)
}

pub(crate) fn create_expected(root: &Path, command: &str, label: &str, workspace: bool, ignored: bool, expected: Option<&str>) -> GitResult<Summary> {
    create_expected_refs(root, command, label, workspace, ignored, expected, &[])
}

/// Also protect a reviewed push-server tip that may not have a tracking ref
/// (for example when fetch and push point at different servers).
pub fn reference_checkpoint(root: &Path, command: &str, label: &str, references: &[SavedRef], expected: Option<&str>) -> GitResult<Summary> {
    crate::journal::suspend(|| create_expected_refs(root, command, label, false, false, expected, references)).map_err(|e| {
        if e.kind == "stale-operation" {
            e
        } else {
            fail(format!("Recovery checkpoint could not be saved: {}. The requested action was not started.", e.message)).kind("checkpoint-failed")
        }
    })
}

fn create_expected_refs(
    root: &Path,
    command: &str,
    label: &str,
    workspace: bool,
    ignored: bool,
    expected: Option<&str>,
    references: &[SavedRef],
) -> GitResult<Summary> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let observed = match expected {
                Some(value) => Some(value.to_owned()),
                None => status::status(root)?.state_token,
            };
            create_locked(root, command, label, workspace, ignored, observed.as_deref(), Capture { references, paths: &[] })
        },
    )
}

/// A workspace checkpoint that also keeps the given ignored files.
fn create_with_ignored(root: &Path, command: &str, label: &str, expected: Option<&str>, paths: &[String]) -> GitResult<Summary> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let observed = match expected {
                Some(value) => Some(value.to_owned()),
                None => status::status(root)?.state_token,
            };
            create_locked(root, command, label, true, false, observed.as_deref(), Capture { references: &[], paths })
        },
    )
}

// ───────────── ignored-file safety net ─────────────
//
// Git overwrites or deletes ignored files in more ways than can be predicted path by path
// (renames, re-created merges, conflict names, sparse cleanup). The guards in `ops` refuse the
// cases they can preview; this net covers the rest. Before an operation that writes the working
// tree, the individual ignored files (not the content of wholly ignored folders such as
// node_modules or build output) are recorded (size, hash) and copied into the operation's
// checkpoint, which lives on disk and stays listed in Recovery. If the copy cannot be made, the
// operation is refused until the user accepts exactly that list of unprotected files. After the
// operation (finished or failed), files that changed or disappeared are reported to that
// operation only.

const WATCH_MAX_HASH: u64 = 100 * 1024 * 1024;

/// One ignored file as it was at a point in time.
#[derive(Clone, PartialEq)]
struct Watched {
    path: String,
    len: u64,
    modified: Option<std::time::SystemTime>,
    sha256: Option<String>,
}

struct Watch {
    command: String,
    checkpoint: Option<String>,
    files: Vec<Watched>,
}

/// An ignored file Git changed, and what it looked like right after the operation.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredChange {
    pub path: String,
    /// False when Git deleted it.
    pub exists: bool,
    /// Content hash after the operation (None when deleted or too large to hash).
    pub sha256: Option<String>,
    pub len: u64,
}

/// Ignored files Git changed or removed during one operation.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredReport {
    pub command: String,
    /// The checkpoint holding the previous content; None when the user accepted running without one.
    pub checkpoint: Option<String>,
    pub paths: Vec<String>,
    pub changes: Vec<IgnoredChange>,
}

thread_local! {
    // An operation runs start to finish on one thread (`operations::run` inside the command's
    // blocking task), and the command takes its report on that thread before returning. A
    // queued operation runs on another thread, so it can never replace or take this report.
    static WATCH: std::cell::RefCell<Option<Watch>> = const { std::cell::RefCell::new(None) };
    static REPORT: std::cell::RefCell<Option<IgnoredReport>> = const { std::cell::RefCell::new(None) };
    // The user's decisions for the operation running on this thread (taken in `begin`).
    static ACTIVE: std::cell::RefCell<Option<Consent>> = const { std::cell::RefCell::new(None) };
    // The consent token the request running on this thread carries (set by the command).
    static REQUEST: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// A user's decision to continue although Git may overwrite these local paths.
#[derive(Clone)]
struct AcceptedCollisions {
    /// Absolute, normalized paths the decision covers.
    covered: BTreeSet<String>,
    /// Paths (relative to the repository) to copy into the checkpoint first; empty when the
    /// user chose to continue without a copy.
    copy: Vec<String>,
}

/// Everything the user decided for one request: the retry that carries its one-shot token. Any
/// other request, even the same command in the same repository, never sees it.
#[derive(Clone)]
struct Consent {
    repo: PathBuf,
    command: String,
    collisions: Option<AcceptedCollisions>,
    /// Paths the user accepted to run without a saved copy (sorted).
    unprotected: Option<Vec<String>>,
}

/// Pending decisions by token, oldest first. A token whose request never arrives is dropped
/// once newer ones push it out; it can never be used by another request.
type ConsentList = std::sync::Mutex<Vec<(String, Consent)>>;
const MAX_PENDING: usize = 32;

fn pending() -> &'static ConsentList {
    static P: std::sync::OnceLock<ConsentList> = std::sync::OnceLock::new();
    P.get_or_init(Default::default)
}

fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(N.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let mut h2 = std::collections::hash_map::RandomState::new().build_hasher();
    h2.write_u64(h.finish());
    format!("{:016x}{:016x}", h.finish(), h2.finish())
}

fn absolute_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/');
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_owned()
    }
}

fn store(consent: Consent) -> String {
    let mut all = pending().lock().unwrap_or_else(|e| e.into_inner());
    let token = new_token();
    all.push((token.clone(), consent));
    if all.len() > MAX_PENDING {
        all.remove(0);
    }
    token
}

/// The user continues `command` in `root` although Git may overwrite `paths` (repository-
/// relative, as the collision listed them). With `copy`, they are saved in the operation's
/// checkpoint first. Returns the one-shot token the retry must carry. A new decision never
/// inherits an older consent to run without a copy.
pub fn accept_collisions(root: &Path, command: &str, paths: &[String], copy: bool) -> String {
    let repo = watch_key(root);
    let collisions = Some(collision_decision(&repo, paths, copy));
    store(Consent { repo, command: command.to_owned(), collisions, unprotected: None })
}

fn collision_decision(base: &Path, paths: &[String], copy: bool) -> AcceptedCollisions {
    let covered = paths.iter().map(|p| absolute_key(&base.join(p))).collect();
    AcceptedCollisions { covered, copy: if copy { paths.to_vec() } else { Vec::new() } }
}

/// The user accepts that `command` in `root` runs although these paths could not be saved. It
/// applies only if that run finds exactly this list. `collision` repeats the collision decision
/// the same request made earlier (its token was used up by the attempt that failed to save), so
/// the returned new token carries both decisions.
pub fn accept_unprotected(root: &Path, command: &str, paths: &[String], collision: Option<(&[String], bool)>) -> String {
    let mut paths = paths.to_vec();
    paths.sort();
    let repo = watch_key(root);
    let collisions = collision.map(|(local, copy)| collision_decision(&repo, local, copy));
    store(Consent { repo, command: command.to_owned(), collisions, unprotected: Some(paths) })
}

/// The consent token of the request about to run on this thread (None: it carries none).
pub fn set_request_consent(token: Option<String>) {
    REQUEST.with(|r| *r.borrow_mut() = token);
}

/// Start of an operation that owns `root`: takes the decisions of the token its request carries.
/// They apply only if they were made for this repository and command; either way the token is
/// used up.
pub fn begin(root: &Path, command: &str) {
    let token = REQUEST.with(|r| r.borrow_mut().take());
    let taken = token.and_then(|t| {
        let mut all = pending().lock().unwrap_or_else(|e| e.into_inner());
        all.iter().position(|(k, _)| *k == t).map(|i| all.remove(i).1)
    });
    let base = watch_key(root);
    ACTIVE.with(|a| *a.borrow_mut() = taken.filter(|c| c.command == command && c.repo == base));
    outcome::enter(command);
}

/// End of the running operation's work: records its result beside each checkpoint saved for it.
pub(crate) fn record_outcome(status: &str, error: Option<&str>) {
    outcome::record(status, error);
}

/// Ends the operation started by `begin` on every exit path, unwinding included: reports changed
/// ignored files and drops the watch and every decision of this operation.
pub struct Finish(pub PathBuf);

impl Drop for Finish {
    fn drop(&mut self) {
        finish_watch(&self.0);
        ACTIVE.with(|a| a.borrow_mut().take());
        outcome::leave();
    }
}

/// True when the user accepted every one of `paths` (relative to `repo`, which may be a
/// submodule of the repository the decision was made for) for the running operation.
pub fn collisions_accepted(repo: &Path, paths: &[String]) -> bool {
    let base = watch_key(repo);
    let wanted: Vec<String> = paths.iter().map(|p| absolute_key(&base.join(p))).collect();
    ACTIVE.with(|a| a.borrow().as_ref().and_then(|c| c.collisions.as_ref()).is_some_and(|c| wanted.iter().all(|w| c.covered.contains(w))))
}

/// Git's ignored-file protection flag for the running operation. Git keeps refusing to replace
/// ignored files unless the user decided to continue past the listed collisions.
pub fn ignored_flag(_repo: &Path) -> &'static str {
    if ACTIVE.with(|a| a.borrow().as_ref().is_some_and(|c| c.collisions.is_some())) {
        "--overwrite-ignore"
    } else {
        "--no-overwrite-ignore"
    }
}

/// Files under `path` (a file, or a folder walked without following links), repository-relative.
/// Fails rather than skip anything it cannot save: an unreadable folder or entry, a link, a
/// special file or a name that is not valid UTF-8.
fn files_under(root: &Path, path: &str, out: &mut Vec<String>) -> Result<(), String> {
    let path = path.trim_end_matches('/');
    let full = root.join(path);
    let m = match fs::symlink_metadata(&full) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{path}: {e}")),
    };
    if m.file_type().is_symlink() {
        return Err(format!("{path} is a link"));
    }
    if m.is_file() {
        out.push(path.to_owned());
        return Ok(());
    }
    if !m.is_dir() {
        return Err(format!("{path} is not a regular file or folder"));
    }
    for entry in fs::read_dir(&full).map_err(|e| format!("{path}: {e}"))? {
        let entry = entry.map_err(|e| format!("{path}: {e}"))?;
        let name = entry.file_name().into_string().map_err(|_| format!("{path} contains a name that is not valid UTF-8"))?;
        files_under(root, &format!("{path}/{name}"), out)?;
    }
    Ok(())
}

fn watch_key(root: &Path) -> PathBuf {
    fs::canonicalize(root).unwrap_or_else(|_| root.to_owned())
}

/// Commands that write the working tree, so Git may overwrite or delete ignored files.
fn writes_worktree(command: &str) -> bool {
    matches!(
        command,
        "reset"
            | "op_continue"
            | "op_abort"
            | "op_skip"
            | "undo_commit"
            | "rebase_onto"
            | "interactive_rebase"
            | "rewrite"
            | "cherry_pick"
            | "cherry_pick_compared_commit"
            | "revert"
            | "merge_start"
            | "pull"
            | "pull_branches"
            | "checkout"
            | "pull_request_checkout"
            | "stash_apply"
            | "stash_branch"
            | "apply_patch"
            | "apply_from_commit"
            | "bisect_start"
            | "bisect_mark"
            | "bisect_reset"
            | "sparse_checkout_set"
            | "sparse_checkout_add"
            | "sparse_checkout_disable"
            | "sparse_checkout_reapply"
    )
}

/// Ignored files outside wholly ignored folders (Git lists those folders as one `dir/` entry).
fn individual_ignored(root: &Path) -> GitResult<Vec<String>> {
    let raw = runner::run_bytes(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"])?;
    let raw = String::from_utf8(raw).map_err(|_| fail("Non-UTF-8 filenames cannot be captured safely."))?;
    let mut files: Vec<String> = raw.split('\0').filter(|p| !p.is_empty() && !p.ends_with('/')).map(str::to_owned).collect();
    files.sort();
    Ok(files)
}

fn snapshot(root: &Path, path: &str) -> Option<Watched> {
    let full = source_path(root, path).ok()?;
    let m = fs::symlink_metadata(&full).ok()?;
    if !m.is_file() {
        return None;
    }
    let sha256 = (m.len() <= WATCH_MAX_HASH).then(|| digest(&full).ok()).flatten();
    Some(Watched { path: path.to_owned(), len: m.len(), modified: m.modified().ok(), sha256 })
}

fn same(before: &Watched, now: &Watched) -> bool {
    now.len == before.len
        && match (&now.sha256, &before.sha256) {
            (Some(a), Some(b)) => a == b,
            _ => now.modified == before.modified,
        }
}

/// Records the individual ignored files and copies them into the operation's checkpoint, before
/// `command`. Returns true when that checkpoint was created (it replaces the ordinary one).
fn watch_ignored(root: &Path, command: &str, expected: Option<&str>, keep: Option<&dyn Fn(&str) -> bool>) -> GitResult<bool> {
    WATCH.with(|w| w.borrow_mut().take());
    REPORT.with(|r| r.borrow_mut().take());
    let (copy, approved) = ACTIVE.with(|a| {
        let mut a = a.borrow_mut();
        let copy = a.as_ref().and_then(|c| c.collisions.as_ref()).map(|c| c.copy.clone()).unwrap_or_default();
        (copy, a.as_mut().and_then(|c| c.unprotected.take()))
    });
    let mut files = individual_ignored(root)?;
    if let Some(keep) = keep {
        files.retain(|path| keep(path));
    }
    // Paths the user asked to save before continuing past a collision (files in wholly ignored
    // folders included). If they cannot be listed completely, none of them counts as saved.
    let mut unprotected: Vec<String> = Vec::new();
    let mut reasons: Vec<String> = Vec::new();
    let mut listed = Vec::new();
    match copy.iter().try_for_each(|path| files_under(root, path, &mut listed)) {
        Ok(()) => files.extend(listed),
        Err(reason) => {
            unprotected.extend(copy.iter().map(|p| p.trim_end_matches('/').to_owned()));
            reasons.push(reason);
        }
    }
    files.sort();
    files.dedup();
    let mut checkpoint = None;
    if !files.is_empty() {
        let label = format!("Before {}", command.replace('_', " "));
        match crate::journal::suspend(|| create_with_ignored(root, command, &label, expected, &files)) {
            Ok(summary) => checkpoint = Some(summary.id),
            Err(e) if e.kind == "stale-operation" => return Err(e),
            Err(e) => {
                unprotected.extend(files.iter().cloned());
                reasons.push(e.message.trim_end_matches('.').to_owned());
            }
        }
    }
    if !unprotected.is_empty() {
        unprotected.sort();
        unprotected.dedup();
        if approved.as_deref() != Some(unprotected.as_slice()) {
            return Err(fail(format!(
                "{} path{} could not be saved before this operation ({}). Git may overwrite or delete them, and they could not be restored. Nothing was changed.",
                unprotected.len(),
                if unprotected.len() == 1 { "" } else { "s" },
                reasons.join("; ")
            ))
            .kind("ignored-backup-unavailable")
            .details(unprotected));
        }
    }
    if files.is_empty() {
        return Ok(false);
    }
    let watched: Vec<Watched> = files.iter().filter_map(|p| snapshot(root, p)).collect();
    let created = checkpoint.is_some();
    WATCH.with(|w| *w.borrow_mut() = Some(Watch { command: command.to_owned(), checkpoint, files: watched }));
    Ok(created)
}

/// Pulls know what they change only after their fetch. They protect ignored files then (see
/// [`watch_ignored_for`]), instead of saving every ignored file before the fetch.
fn ignored_net_after_fetch(command: &str) -> bool {
    matches!(command, "pull" | "pull_branches")
}

/// The ignored-file net for an operation whose changes are known: only the individual ignored
/// files in the way of `changed` (the paths Git will write) are recorded and saved. Returns true
/// when that created the operation's checkpoint.
///
/// Saving every ignored file before each pull made pulls slow (every file was hashed and
/// copied) and impossible past the checkpoint's 100 MiB, although Git writes only these paths.
pub fn watch_ignored_for(root: &Path, command: &str, changed: &[String]) -> GitResult<bool> {
    let fold = cfg!(windows) || config_bool(root, "core.ignorecase")?;
    let touched = TouchedPaths::new(changed, fold);
    watch_ignored(root, command, None, Some(&|path: &str| touched.contains(path)))
}

/// The paths an integration writes, and which ignored files are in their way.
struct TouchedPaths {
    files: BTreeSet<String>,
    folders: BTreeSet<String>,
    fold: bool,
}

impl TouchedPaths {
    fn new(changed: &[String], fold: bool) -> Self {
        let files: BTreeSet<String> = changed.iter().map(|path| Self::key(path, fold)).collect();
        let folders = files.iter().flat_map(|path| folders_of(path)).map(str::to_owned).collect();
        TouchedPaths { files, folders, fold }
    }

    fn key(path: &str, fold: bool) -> String {
        let path = path.trim_end_matches('/');
        if fold {
            path.to_lowercase()
        } else {
            path.to_owned()
        }
    }

    /// The same path; a file where a folder must be created; a file in a folder that becomes a
    /// file; or one of Git's conflict copies ("path~branch").
    fn contains(&self, path: &str) -> bool {
        let path = Self::key(path, self.fold);
        self.files.contains(&path)
            || self.folders.contains(&path)
            || folders_of(&path).any(|folder| self.files.contains(folder))
            || path.rsplit_once('~').is_some_and(|(base, _)| self.files.contains(base))
    }
}

/// "a/b/c" → "a", "a/b".
fn folders_of(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/').map(move |(at, _)| &path[..at])
}

/// After the operation (finished, failed or unwinding): records which watched ignored files changed.
pub fn finish_watch(root: &Path) {
    let Some(watch) = WATCH.with(|w| w.borrow_mut().take()) else { return };
    let mut changes = Vec::new();
    for before in &watch.files {
        match snapshot(root, &before.path) {
            Some(now) if same(before, &now) => {}
            Some(now) => changes.push(IgnoredChange { path: now.path, exists: true, sha256: now.sha256, len: now.len }),
            None => changes.push(IgnoredChange { path: before.path.clone(), exists: false, sha256: None, len: 0 }),
        }
    }
    if !changes.is_empty() {
        let paths = changes.iter().map(|c| c.path.clone()).collect();
        REPORT.with(|r| *r.borrow_mut() = Some(IgnoredReport { command: watch.command, checkpoint: watch.checkpoint, paths, changes }));
    }
}

/// The report of the operation that just ran on this thread, once.
pub fn take_ignored_report(_root: &Path) -> Option<IgnoredReport> {
    REPORT.with(|r| r.borrow_mut().take())
}

/// Differences between the saved copy of `path` in checkpoint `id` and the file now.
pub fn compare_saved(root: &Path, id: &str, path: &str) -> GitResult<super::diff::FileDiff> {
    let root = fs::canonicalize(repo::discover(root)?)?;
    let cp = read(&root, id)?;
    let Some((index, saved)) = cp.paths.iter().enumerate().find(|(_, s)| s.path == path) else {
        return Err(fail(format!("{path} is not in this checkpoint.")));
    };
    if saved.kind != "file" {
        return Err(fail(format!("{path} was not a regular file in this checkpoint.")));
    }
    let stored = base(&root)?.join(id).join("files").join(index.to_string());
    if Some(digest(&stored)?) != saved.sha256 {
        return Err(fail(format!("The saved copy of {path} is damaged.")));
    }
    let current = source_path(&root, path)?;
    let now = if fs::symlink_metadata(&current).is_ok_and(|m| m.is_file()) { display_path(&current) } else { "/dev/null".to_owned() };
    let args = strings(&["diff", "--no-index", "--no-color", "--full-index", "--", &display_path(&stored), &now]);
    let out = runner::exec_full(&root, &args, &[], None)?;
    if !matches!(out.code, 0 | 1) {
        return Err(runner::to_error("compare the saved copy", &out));
    }
    let raw = super::diff::parse(&out.stdout);
    let Some(first) = raw.first() else {
        return Err(fail(format!("The saved copy of {path} and the current file are identical.")).kind("identical"));
    };
    Ok(super::diff::to_display(first, path, super::diff::fingerprint(&out.stdout)))
}

/// Puts the saved copies of the ignored files an operation changed back in place (see
/// `restore_paths`).
pub fn restore_files(root: &Path, id: &str, changes: &[IgnoredChange]) -> GitResult<RestoreOutcome> {
    restore_paths(root, id, &changes.iter().map(|c| c.path.clone()).collect::<Vec<_>>())
}

struct Capture<'a> {
    references: &'a [SavedRef],
    paths: &'a [String],
}

/// Complete, bounded workspace capture for worktree removal, including files
/// hidden by assume-unchanged/skip-worktree and ordinary clean tracked files.
pub fn complete_workspace(root: &Path, command: &str, label: &str, expected: &str, paths: &[String]) -> GitResult<Summary> {
    crate::journal::suspend(|| {
        operations::access(root, true, |_, _| {}, || create_locked(root, command, label, true, true, Some(expected), Capture { references: &[], paths }))
    })
    .map_err(|e| {
        if e.kind == "stale-operation" {
            e
        } else {
            fail(format!("Complete recovery checkpoint could not be saved: {}. The worktree was kept.", e.message)).kind("checkpoint-failed")
        }
    })
}

fn create_locked(root: &Path, command: &str, label: &str, workspace: bool, ignored: bool, expected: Option<&str>, capture: Capture<'_>) -> GitResult<Summary> {
    // Capture is a mutation: pinning objects must never occur in a read path.
    let _lock = lock(root)?;
    let root = fs::canonicalize(repo::discover(root)?)?;
    // The file name check, the status and the reference list are independent reads: run them
    // side by side (each Git start costs 60–150 ms on Windows). The helpers join the caller's
    // repository transaction.
    let parent = operations::Inherited::of(&root);
    let (names, before, saved_refs) = std::thread::scope(|scope| {
        let names =
            workspace.then(|| scope.spawn(|| parent.run(|| runner::run_bytes(&root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))));
        let saved_refs = scope.spawn(|| parent.run(|| refs(&root)));
        let before = status::status(&root);
        let joined = |name: &str| fail(format!("Reading {name} for the checkpoint failed."));
        (
            names.map(|handle| handle.join().unwrap_or_else(|_| Err(joined("the file names")))),
            before,
            saved_refs.join().unwrap_or_else(|_| Err(joined("the references"))),
        )
    });
    if let Some(filenames) = names {
        std::str::from_utf8(&filenames?).map_err(|_| fail("Non-UTF-8 filenames cannot be captured safely."))?;
    }
    let before = before?;
    if expected.is_some_and(|expected| before.state_token.as_deref() != Some(expected)) {
        return Err(fail(
            "The repository changed while waiting to save its checkpoint. Refresh and review the action again. The requested action was not started.",
        )
        .kind("stale-operation"));
    }
    let mut aliases: BTreeSet<String> = before
        .files
        .iter()
        .filter_map(|f| {
            f.orig_path
                .as_ref()
                .filter(|old| *old != &f.path && old.to_lowercase() == f.path.to_lowercase() && !before.files.iter().any(|entry| &entry.path == *old))
                .cloned()
        })
        .collect();
    if workspace && before.files.iter().any(|f| f.submodule) {
        return Err(fail("Modified submodules are not included in workspace checkpoints. Commit or stash their changes before this action."));
    }
    let folder = tempfile::Builder::new().prefix("cp-").tempdir_in(base(&root)?)?;
    let id = folder.path().file_name().unwrap().to_string_lossy().into_owned();
    fs::create_dir(folder.path().join("files"))?;
    fs::create_dir(folder.path().join("meta"))?;
    let mut budget = 0;
    let gd = repo::git_dir(&root)?;
    let mut cp = Checkpoint {
        summary: Summary {
            id,
            created_at: crate::journal::now(),
            command: command.into(),
            label: label.chars().take(128).collect(),
            source_root: display_path(&root),
            branch: before.branch.clone(),
            head: before.oid.clone(),
            workspace,
            includes_ignored: ignored,
            files: 0,
            references: 0,
            bytes: 0,
            operation_status: None,
        },
        version: 1,
        common_dir: operations::repository_key(&root).to_string_lossy().into_owned(),
        pin: String::new(),
        base_commit: String::new(),
        refs: saved_refs?,
        paths: Vec::new(),
        index_files: Vec::new(),
        sparse: false,
        sparse_cone: false,
        sparse_patterns: None,
    };
    for reference in capture.references {
        if !oid(&reference.oid) || !runner::exec(&root, ["cat-file", "-e", &format!("{}^{{commit}}", reference.oid)])?.ok() {
            return Err(fail("A reviewed recovery reference is unavailable."));
        }
        if !cp.refs.iter().any(|r| r.name == reference.name && r.oid == reference.oid) {
            cp.refs.push(reference.clone());
        }
    }
    if cp.refs.len() > MAX_FILES {
        return Err(fail("Too many references for a recovery checkpoint."));
    }
    if workspace {
        let mut index_paths = Vec::new();
        if gd.join("index").exists() {
            index_paths.push(gd.join("index"));
        }
        // A split index keeps its shared part as `sharedindex.<oid>` beside the index. Without
        // such a file there is nothing to copy, so Git is not asked.
        let may_split = fs::read_dir(&gd).map_or(true, |entries| entries.flatten().any(|e| e.file_name().to_string_lossy().starts_with("sharedindex.")));
        let shared = if may_split { runner::run(&root, ["rev-parse", "--shared-index-path"])? } else { String::new() };
        if !shared.trim().is_empty() {
            let path = root.join(shared.trim());
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            if !name.starts_with("sharedindex.") || !oid(&name[12..]) {
                return Err(fail("Unsupported shared index path."));
            }
            index_paths.push(path);
        }
        for source in index_paths {
            let name = source.file_name().unwrap().to_string_lossy().into_owned();
            let sha256 = copy_file(&source, &folder.path().join("meta").join(&name), &mut budget)?;
            cp.index_files.push(IndexFile { name, sha256 });
        }
        cp.sparse = config_bool(&root, "core.sparseCheckout")?;
        cp.sparse_cone = config_bool(&root, "core.sparseCheckoutCone")?;
        if cp.sparse && gd.join("info/sparse-checkout").is_file() {
            cp.sparse_patterns = Some(fs::read_to_string(gd.join("info/sparse-checkout"))?);
        }
        let mut paths: BTreeSet<String> = capture.paths.iter().cloned().collect();
        for file in &before.files {
            // Git never overwrites or deletes untracked files in a pull (it refuses instead), so
            // the checkpoint before one keeps tracked changes. Copying large untracked data made
            // every pull slow, and impossible past 100 MiB.
            if file.untracked && ignored_net_after_fetch(command) {
                continue;
            }
            paths.insert(file.path.clone());
            if let Some(old) = &file.orig_path {
                paths.insert(old.clone());
            }
        }
        if ignored {
            let raw = runner::run_bytes(&root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])?;
            let raw = String::from_utf8(raw).map_err(|_| fail("Non-UTF-8 filenames cannot be captured safely."))?;
            for path in raw.split('\0').filter(|p| !p.is_empty()) {
                aliases.remove(path);
                paths.insert(path.to_owned());
            }
        }
        if paths.len() > MAX_FILES {
            return Err(fail("Recovery checkpoint exceeds 20,000 changed paths."));
        }
        for path in paths {
            if path.ends_with('/') {
                return Err(fail("Nested repositories cannot be captured as ordinary files."));
            }
            let source = source_path(&root, &path)?;
            let mut saved = SavedPath { path, kind: "missing".into(), sha256: None, target: None, directory_link: false, mode: 0 };
            if aliases.contains(&saved.path) {
                cp.paths.push(saved);
                continue;
            }
            match fs::symlink_metadata(&source) {
                Ok(m) if m.file_type().is_symlink() => {
                    saved.kind = "link".into();
                    saved.target = Some(fs::read_link(&source)?.into_os_string().into_string().map_err(|_| fail("Non-UTF-8 link target."))?);
                    saved.directory_link = fs::metadata(&source).is_ok_and(|m| m.is_dir());
                    budget += saved.target.as_ref().unwrap().len() as u64;
                }
                Ok(m) if m.is_file() => {
                    saved.kind = "file".into();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        saved.mode = m.permissions().mode() & 0o777;
                    }
                    saved.sha256 = Some(copy_file(&source, &folder.path().join("files").join(cp.paths.len().to_string()), &mut budget)?);
                }
                Ok(m) if m.is_dir() => saved.kind = "directory".into(),
                Ok(_) => return Err(fail("Special files cannot be captured in a recovery checkpoint.")),
                Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {}
                Err(e) => return Err(e.into()),
            }
            cp.paths.push(saved);
        }
    }
    // A flat tree pins every index object, including unmerged stages. The raw
    // index itself is copied, so split indexes and conflict stages survive recovery.
    let mut objects = BTreeMap::new();
    let raw = if workspace {
        // Writing the empty blob and listing the index do not depend on each other. The helper
        // only reads; the write stays on this thread, inside its transaction.
        let (written, raw) = std::thread::scope(|scope| {
            let raw = scope.spawn(|| parent.run(|| runner::run(&root, ["ls-files", "--stage", "-z"])));
            let written = git(&root, &strings(&["hash-object", "-w", "--stdin"]), Some(&[]));
            (written, raw.join().unwrap_or_else(|_| Err(fail("Listing the index for the checkpoint failed."))))
        });
        written?;
        raw?
    } else {
        String::new()
    };
    for item in raw.split('\0').filter(|s| !s.is_empty()) {
        let fields: Vec<_> = item.split_once('\t').map(|(h, _)| h.split_whitespace().collect()).unwrap_or_default();
        if fields.len() != 3 || !oid(fields[1]) {
            return Err(fail("Invalid index entry."));
        }
        if fields[0] != "160000" {
            objects.insert(fields[1].to_owned(), if fields[0] == "040000" { "040000 tree" } else { "100644 blob" });
        }
    }
    let tree_input: String = objects.iter().map(|(oid, kind)| format!("{kind} {oid}\t{oid}\0")).collect();
    let tree = git(&root, &strings(&["mktree", "-z"]), Some(tree_input.as_bytes()))?;
    cp.base_commit = match &cp.summary.head {
        Some(head) => head.clone(),
        // Only a repository without commits needs an empty tree for its base commit.
        None => commit(&root, &git(&root, &strings(&["mktree", "-z"]), Some(&[]))?, &[])?,
    };
    let mut parents: BTreeSet<String> = cp.refs.iter().map(|r| r.oid.clone()).collect();
    parents.insert(cp.base_commit.clone());
    let parents: Vec<_> = parents.into_iter().collect();
    let mut previous = None;
    for chunk in parents.chunks(80) {
        let mut batch = chunk.to_vec();
        if let Some(previous) = previous {
            batch.push(previous);
        }
        previous = Some(commit(&root, &tree, &batch)?);
    }
    cp.pin = previous.unwrap();
    if status::status(&root)?.state_token != before.state_token {
        return Err(fail("The repository changed during checkpoint creation. Refresh before retrying."));
    }
    for (i, item) in cp.paths.iter().enumerate() {
        let source = source_path(&root, &item.path)?;
        let unchanged = match item.kind.as_str() {
            "file" => digest(&source)? == item.sha256.as_deref().unwrap_or(""),
            "link" => fs::read_link(&source)?.to_str() == item.target.as_deref(),
            "directory" => fs::symlink_metadata(&source).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()),
            "missing" => {
                aliases.contains(&item.path)
                    || fs::symlink_metadata(&source).is_err_and(|e| matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory))
            }
            _ => false,
        };
        if !unchanged {
            return Err(fail("A file changed during checkpoint creation."));
        }
        if item.kind == "file" && digest(&folder.path().join("files").join(i.to_string()))? != item.sha256.as_deref().unwrap_or("") {
            return Err(fail("Checkpoint verification failed."));
        }
    }
    cp.summary.files = cp.paths.len();
    cp.summary.references = cp.refs.len();
    cp.summary.bytes = budget;
    let data = loop {
        let data = serde_json::to_vec_pretty(&cp).map_err(|e| fail(e.to_string()))?;
        if data.len() > 16 * 1024 * 1024 || budget + data.len() as u64 > MAX_SNAPSHOT {
            return Err(fail("Recovery checkpoint exceeds its metadata or size limit."));
        }
        let size = budget + data.len() as u64;
        if cp.summary.bytes == size {
            break data;
        }
        cp.summary.bytes = size;
    };
    let tracked = outcome::started(folder.path(), &cp.summary);
    let mut manifest = File::create(folder.path().join("checkpoint.pending"))?;
    manifest.write_all(&data)?;
    manifest.sync_all()?;
    let reference = format!("{PREFIX}{}", cp.summary.id);
    runner::run(&root, ["update-ref", &reference, &cp.pin, &"0".repeat(cp.pin.len())])?;
    drop(manifest);
    let kept = folder.keep();
    fs::rename(kept.join("checkpoint.pending"), kept.join("checkpoint.json"))?;
    if tracked {
        outcome::registered(&root, &cp.summary.id);
    }
    prune_locked(&root, Some(&cp.summary.id))?;
    Ok(cp.summary)
}

fn verify(root: &Path, id: &str) -> GitResult<Checkpoint> {
    let cp = read(root, id)?;
    let pin = runner::run(root, ["rev-parse", "--verify", &format!("{PREFIX}{id}")])?;
    if pin.trim() != cp.pin {
        return Err(fail("The checkpoint's protected Git reference is missing or changed."));
    }
    Ok(cp)
}

fn verify_files(root: &Path, cp: &Checkpoint) -> GitResult<()> {
    let id = &cp.summary.id;
    for item in &cp.index_files {
        if digest(&base(root)?.join(id).join("meta").join(&item.name))? != item.sha256 {
            return Err(fail("Checkpoint index checksum mismatch."));
        }
    }
    for (i, item) in cp.paths.iter().enumerate() {
        if item.kind == "file" && digest(&base(root)?.join(id).join("files").join(i.to_string()))? != item.sha256.as_deref().unwrap_or("") {
            return Err(fail("Checkpoint file checksum mismatch."));
        }
    }
    Ok(())
}

fn delete_locked(root: &Path, id: &str) -> GitResult<()> {
    let cp = read(root, id)?;
    let reference = format!("{PREFIX}{id}");
    let out = runner::exec(root, ["rev-parse", "--verify", &reference])?;
    if out.ok() {
        if out.text().trim() != cp.pin {
            return Err(fail("Checkpoint reference changed; it was preserved."));
        }
        runner::run(root, ["update-ref", "-d", &reference, &cp.pin])?;
    }
    let parent = fs::canonicalize(base(root)?)?;
    let target = fs::canonicalize(parent.join(id))?;
    if target.parent() != Some(parent.as_path()) {
        return Err(fail("Unsafe checkpoint directory."));
    }
    fs::remove_dir_all(target)?;
    Ok(())
}
type PinList = std::sync::Mutex<Vec<(PathBuf, String)>>;
fn pinned() -> &'static PinList {
    static P: std::sync::OnceLock<PinList> = std::sync::OnceLock::new();
    P.get_or_init(Default::default)
}

/// Keeps a checkpoint out of retention pruning while it is being read from, for example while a
/// restore first saves the current files in a new checkpoint. `root` must be canonical.
pub(super) struct Pin(PathBuf, String);
pub(super) fn pin(root: &Path, id: &str) -> Pin {
    pinned().lock().unwrap_or_else(|e| e.into_inner()).push((root.to_path_buf(), id.to_owned()));
    Pin(root.to_path_buf(), id.to_owned())
}
impl Drop for Pin {
    fn drop(&mut self) {
        let mut list = pinned().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = list.iter().position(|(root, id)| *root == self.0 && *id == self.1) {
            list.remove(i);
        }
    }
}
fn is_pinned(root: &Path, id: &str) -> bool {
    pinned().lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(r, i)| r == root && i == id)
}

fn prune_locked(root: &Path, keep: Option<&str>) -> GitResult<()> {
    let items = list(root)?.checkpoints;
    let mut bytes = 0;
    for (i, item) in items.iter().enumerate() {
        bytes += item.bytes;
        if Some(item.id.as_str()) != keep
            && !is_pinned(root, &item.id)
            && (i >= MAX_COUNT || bytes > MAX_TOTAL || item.created_at < crate::journal::now() - RETENTION)
        {
            delete_locked(root, &item.id)?;
        }
    }
    Ok(())
}
pub fn delete(root: &Path, id: &str) -> GitResult<()> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let _lock = lock(root)?;
            delete_locked(root, id)
        },
    )
}

fn branch_name(root: &Path, name: &str) -> GitResult<String> {
    let reference = format!("refs/heads/{name}");
    runner::run(root, ["check-ref-format", &reference])?;
    if name.starts_with('-') || name.is_empty() || name == "HEAD" {
        return Err(fail("Choose a new local branch name."));
    }
    if runner::exec(root, ["show-ref", "--verify", "--quiet", &reference])?.ok() {
        return Err(fail("That branch already exists. Recovery never overwrites existing branches."));
    }
    Ok(reference)
}
pub fn restore_branch(root: &Path, id: &str, index: Option<usize>, name: &str) -> GitResult<()> {
    operations::access(root, true, |_, _| {}, || restore_branch_locked(root, id, index, name))
}
fn restore_branch_locked(root: &Path, id: &str, index: Option<usize>, name: &str) -> GitResult<()> {
    let _lock = lock(root)?;
    let cp = verify(root, id)?;
    let target = match index {
        Some(i) => &cp.refs.get(i).ok_or_else(|| fail("Select a saved reference."))?.oid,
        None => cp.summary.head.as_ref().ok_or_else(|| fail("This checkpoint has no committed HEAD."))?,
    };
    let reference = branch_name(root, name)?;
    runner::run(root, ["update-ref", &reference, target, &"0".repeat(target.len())])?;
    Ok(())
}
pub fn restore_stash(root: &Path, id: &str, index: usize) -> GitResult<()> {
    operations::access(root, true, |_, _| {}, || restore_stash_locked(root, id, index))
}
fn restore_stash_locked(root: &Path, id: &str, index: usize) -> GitResult<()> {
    let _lock = lock(root)?;
    let cp = verify(root, id)?;
    let item = cp.refs.get(index).filter(|r| r.kind == "stash").ok_or_else(|| fail("Select a saved stash."))?;
    runner::run(root, ["stash", "store", "-m", "Recovered by Revqora", &item.oid])?;
    Ok(())
}

fn erase(path: &Path) -> GitResult<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            #[cfg(windows)]
            {
                if m.is_dir() {
                    fs::remove_dir(path)?;
                } else {
                    fs::remove_file(path)?;
                }
            }
            #[cfg(not(windows))]
            fs::remove_file(path)?;
        }
        Ok(m) if m.is_dir() => fs::remove_dir_all(path)?,
        Ok(_) => fs::remove_file(path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}
fn prepare_parent(root: &Path, relative: &Path) -> GitResult<()> {
    let mut current = root.to_owned();
    if let Some(parent) = relative.parent() {
        for part in parent.components() {
            current.push(part.as_os_str());
            if let Ok(m) = fs::symlink_metadata(&current) {
                if !m.is_dir() || m.file_type().is_symlink() {
                    erase(&current)?;
                }
            }
            fs::create_dir_all(&current)?;
        }
    }
    Ok(())
}

pub fn restore_workspace(root: &Path, id: &str, destination: &Path, name: &str) -> GitResult<String> {
    operations::access(root, true, |_, _| {}, || restore_workspace_locked(root, id, destination, name))
}
fn restore_workspace_locked(root: &Path, id: &str, destination: &Path, name: &str) -> GitResult<String> {
    let _lock = lock(root)?;
    let cp = verify(root, id)?;
    verify_files(root, &cp)?;
    if !cp.summary.workspace {
        return Err(fail("This checkpoint contains references only."));
    }
    let reference = branch_name(root, name)?;
    if destination.exists() || fs::symlink_metadata(destination).is_ok() {
        return Err(fail("Choose a new, empty destination path that does not exist yet."));
    }
    let parent = fs::canonicalize(destination.parent().ok_or_else(|| fail("Choose a destination folder."))?)?;
    let destination = parent.join(destination.file_name().ok_or_else(|| fail("Choose a destination folder."))?);
    if parent.starts_with(operations::repository_key(root)) {
        return Err(fail("Recovery must be outside Git metadata."));
    }
    for line in runner::run(root, ["worktree", "list", "--porcelain", "-z"])?.split('\0') {
        if let Some(path) = line.strip_prefix("worktree ") {
            if fs::canonicalize(path).is_ok_and(|p| parent.starts_with(p)) {
                return Err(fail("Choose a destination outside existing worktrees."));
            }
        }
    }
    if destination.to_str().is_none() {
        return Err(fail("Destination must be valid Unicode."));
    }
    let target = display_path(&destination);
    runner::run(root, ["worktree", "add", "--no-checkout", "-b", name, &target, &cp.base_commit])?;
    let recover = || -> GitResult<()> {
        if fs::canonicalize(repo::discover(&destination)?)? != fs::canonicalize(&destination)? {
            return Err(fail("Unexpected recovery worktree root."));
        }
        let gd = repo::git_dir(&destination)?;
        // Legacy shared sparse settings cannot describe an independent restored
        // layout. Git upgrades to per-worktree config and migrates core.worktree /
        // core.bare safely; the original worktree's effective settings stay intact.
        if !config_bool(root, "extensions.worktreeConfig")? && (cp.sparse || config_bool(&destination, "core.sparseCheckout")?) {
            runner::run(&destination, ["sparse-checkout", "init", if cp.sparse_cone { "--cone" } else { "--no-cone" }, "--no-sparse-index"])?;
        }
        if config_bool(&destination, "extensions.worktreeConfig")? {
            runner::run(&destination, ["config", "--worktree", "core.sparseCheckout", if cp.sparse { "true" } else { "false" }])?;
            runner::run(&destination, ["config", "--worktree", "core.sparseCheckoutCone", if cp.sparse_cone { "true" } else { "false" }])?;
        }
        if cp.sparse {
            fs::create_dir_all(gd.join("info"))?;
            let patterns_file = gd.join("info/sparse-checkout");
            if let Some(patterns) = &cp.sparse_patterns {
                fs::write(&patterns_file, patterns)?;
            } else {
                // Absence is meaningful: Git treats it as a full checkout. Remove
                // patterns copied by worktree add or generated by sparse init.
                match fs::remove_file(&patterns_file) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
        }
        // Always materialize using captured settings, including a full checkpoint
        // restored after shared sparsity was enabled. Never change the source index.
        let sparse = format!("core.sparseCheckout={}", cp.sparse);
        let cone = format!("core.sparseCheckoutCone={}", cp.sparse_cone);
        runner::run(&destination, ["-c", &sparse, "-c", &cone, "read-tree", "--reset", "-u", &cp.base_commit])?;
        let index_lock = gd.join("index.lock");
        let mut index = OpenOptions::new().create_new(true).write(true).open(&index_lock)?;
        struct Unlock {
            path: PathBuf,
            armed: bool,
        }
        impl Drop for Unlock {
            fn drop(&mut self) {
                if self.armed {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }
        let mut unlock = Unlock { path: index_lock.clone(), armed: true };
        let mut order: Vec<usize> = (0..cp.paths.len()).collect();
        order.sort_by_key(|i| std::cmp::Reverse(Path::new(&cp.paths[*i].path).components().count()));
        for i in &order {
            let path = relative(&cp.paths[*i].path)?;
            prepare_parent(&destination, path)?;
            erase(&destination.join(path))?;
        }
        order.reverse();
        for i in order {
            let item = &cp.paths[i];
            let path = relative(&item.path)?;
            if item.kind == "missing" {
                continue;
            }
            prepare_parent(&destination, path)?;
            let target = destination.join(path);
            match item.kind.as_str() {
                "file" => {
                    fs::copy(base(root)?.join(id).join("files").join(i.to_string()), &target)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&target, fs::Permissions::from_mode(item.mode))?;
                    }
                }
                "directory" => fs::create_dir_all(&target)?,
                "link" => {
                    let link = item.target.as_deref().ok_or_else(|| fail("Missing link target."))?;
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(link, &target)?;
                    #[cfg(windows)]
                    if item.directory_link {
                        std::os::windows::fs::symlink_dir(link, &target)?;
                    } else {
                        std::os::windows::fs::symlink_file(link, &target)?;
                    }
                }
                _ => return Err(fail("Unsupported checkpoint file type.")),
            }
        }
        for saved in &cp.index_files {
            let source = base(root)?.join(id).join("meta").join(&saved.name);
            if saved.name == "index" {
                std::io::copy(&mut File::open(source)?, &mut index)?;
            } else {
                fs::copy(source, gd.join(&saved.name))?;
            }
        }
        index.sync_all()?;
        drop(index);
        if cp.index_files.iter().any(|f| f.name == "index") {
            fs::rename(&index_lock, gd.join("index"))?;
        } else {
            if gd.join("index").exists() {
                fs::remove_file(gd.join("index"))?;
            }
            fs::remove_file(&index_lock)?;
        }
        unlock.armed = false;
        // Monitor/cache tokens belong to the original worktree. Keep semantic
        // staging flags, but never trust its filesystem cache in a new directory.
        if cp.index_files.iter().any(|f| f.name == "index") {
            runner::run(&destination, ["-c", "core.fsmonitor=false", "update-index", "--no-fsmonitor", "--no-untracked-cache"])?;
        }
        if cp.summary.head.is_none() {
            runner::run(root, ["update-ref", "-d", &reference, &cp.base_commit])?;
        }
        Ok(())
    };
    if let Err(e) = recover() {
        return Err(fail(format!(
            "Recovery stopped: {}. The new worktree was preserved at {} for inspection. Your original worktree was not replaced.",
            e.message,
            destination.display()
        ))
        .kind("recovery-partial"));
    }
    Ok(display_path(&destination))
}

pub fn before(root: &Path, command: &str, expected: Option<&str>) -> GitResult<()> {
    if writes_worktree(command) && !ignored_net_after_fetch(command) && watch_ignored(root, command, expected, None)? {
        return Ok(());
    }
    let workspace = matches!(
        command,
        "reset"
            | "op_abort"
            | "op_skip"
            | "undo_commit"
            | "rebase_onto"
            | "interactive_rebase"
            | "rewrite"
            | "cherry_pick"
            | "cherry_pick_compared_commit"
            | "revert"
            | "merge_start"
            | "pull"
            | "discard"
            | "layer_discard"
            | "layer_commit"
            | "stash_apply"
            | "stash_selection"
            | "apply_patch"
            | "checkout_file"
            | "apply_from_commit"
            | "stash_restore_file"
            | "conflict_take"
            | "conflict_unresolve"
            | "conflict_validation"
            | "conflict_save"
            | "conflict_external"
            | "stash_branch"
    );
    let refs = matches!(command, "branch_delete" | "branch_delete_remote" | "push" | "push_ref");
    if matches!(command, "sparse_checkout_set" | "sparse_checkout_add" | "sparse_checkout_disable" | "sparse_checkout_reapply") {
        // The workspace checkpoint records the sparse patterns and local edits. Git itself keeps
        // modified files that leave the sparse set, so a working tree the snapshot cannot
        // capture falls back to a reference checkpoint instead of blocking the change.
        return match automatic_expected(root, command, true, false, expected) {
            Err(e) if e.kind == "checkpoint-failed" => automatic_expected(root, command, false, false, expected),
            other => other,
        };
    }
    if workspace && finishes_operation(command) {
        // Getting out of a merge/rebase or resolving its conflicts must never be blocked by a
        // working tree the snapshot cannot capture (a submodule entry, a nested repository,
        // more than the size limit). Fall back to a reference checkpoint for these.
        return match automatic_expected(root, command, true, false, expected) {
            Err(e) if e.kind == "checkpoint-failed" => automatic_expected(root, command, false, false, expected),
            other => other,
        };
    }
    if workspace || refs {
        automatic_expected(root, command, workspace, false, expected)?;
    }
    Ok(())
}

/// Commands that leave or resolve an operation in progress; they must stay available.
fn finishes_operation(command: &str) -> bool {
    matches!(command, "op_abort" | "op_skip" | "conflict_take" | "conflict_unresolve" | "conflict_validation" | "conflict_save" | "conflict_external")
}
pub fn automatic(root: &Path, command: &str, workspace: bool, ignored: bool) -> GitResult<()> {
    automatic_expected(root, command, workspace, ignored, None)
}
pub fn automatic_expected(root: &Path, command: &str, workspace: bool, ignored: bool, expected: Option<&str>) -> GitResult<()> {
    crate::journal::suspend(|| create_expected(root, command, &format!("Before {}", command.replace('_', " ")), workspace, ignored, expected))
        .map(|_| ())
        .map_err(|e| {
            if e.kind == "stale-operation" {
                e
            } else {
                fail(format!("Recovery checkpoint could not be saved: {}. The requested action was not started.", e.message)).kind("checkpoint-failed")
            }
        })
}

/// Native Git mirror/wildcard mappings can publish or prune private recovery refs.
/// Ordinary branch/tag refspecs are unaffected. External CLI mirror operations
/// remain outside this client's control.
pub fn protect_transport(root: &Path, push: bool, remote: Option<&str>, explicit: Option<&str>, all: bool) -> GitResult<()> {
    // Checked before anything else: fetch and push pass the remote name as an argument, and a
    // leading '-' would be read as an option even when no recovery refs need protecting.
    if remote.is_some_and(|name| name.starts_with('-')) {
        return Err(fail("Choose a remote name that does not start with '-'."));
    }
    let protected = runner::run(root, ["for-each-ref", "--format=%(refname)", PREFIX])?;
    if protected.trim().is_empty() {
        return Ok(());
    }
    let matches = |pattern: &str| {
        protected.lines().any(|reference| match pattern.split_once('*') {
            Some((start, end)) => reference.starts_with(start) && reference.ends_with(end),
            None => reference == pattern,
        })
    };
    let unsafe_spec = |spec: &str| {
        let spec = spec.trim().trim_start_matches('+');
        let (source, target) = spec.split_once(':').unwrap_or((spec, spec));
        matches(if push { source } else { target }) || (push && target.starts_with(PREFIX))
    };
    let reject = || {
        fail("This mirror or wildcard refspec includes private recovery references. Use branch/tag refspecs when operating through Revqora. Recovery references were preserved and no network operation was started.").kind("recovery-protected")
    };
    if explicit.is_some_and(unsafe_spec) {
        return Err(reject());
    }
    let config = |key: &str| super::config_cache::run(root, &["config", "--get", key]).unwrap_or_default().trim().to_owned();
    let names = if let Some(remote) = remote {
        vec![remote.to_owned()]
    } else if all {
        super::config_cache::run(root, &["remote"])?.lines().map(str::to_owned).collect()
    } else {
        let head = repo::head(root)?.branch.unwrap_or_default();
        let mut candidates = Vec::new();
        if push {
            candidates.extend([config(&format!("branch.{head}.pushRemote")), config("remote.pushDefault")]);
        }
        let remotes: Vec<_> = super::config_cache::run(root, &["remote"])?.lines().map(str::to_owned).collect();
        let fallback = if remotes.len() == 1 { remotes[0].clone() } else { "origin".into() };
        candidates.extend([config(&format!("branch.{head}.remote")), fallback]);
        vec![candidates.into_iter().find(|s| !s.is_empty()).unwrap()]
    };
    for name in names {
        if name.starts_with('-') {
            return Err(reject());
        }
        if push && super::config_cache::run(root, &["config", "--bool", "--get", &format!("remote.{name}.mirror")]).unwrap_or_default().trim() == "true" {
            return Err(reject());
        }
        if !push || explicit.is_none() {
            let values =
                super::config_cache::run(root, &["config", "--get-all", &format!("remote.{name}.{}", if push { "push" } else { "fetch" })]).unwrap_or_default();
            if values.lines().any(unsafe_spec) {
                return Err(reject());
            }
        }
    }
    Ok(())
}

mod outcome;
pub use outcome::{files, restore_paths, CheckpointFiles, FileState, KeptBoth, OperationRecord, OperationView, RestoreOutcome, RestoreSummary, SavedFile};

#[cfg(test)]
mod tests;
