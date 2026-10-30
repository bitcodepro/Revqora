//! Reviewed worktree operations. Native Git owns registration and removal;
//! previews are immutable and never authorize force-unlocking or branch deletion.
use super::{
    extras::{self, Worktree},
    operations, recovery, repo,
    runner::{self, GitError, GitResult},
    status,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_PATHS: usize = 20_000;
const MAX_BYTES: u64 = 100 * 1024 * 1024;
fn fail(message: impl Into<String>) -> GitError {
    GitError::new(message).kind("worktree-review")
}
fn stale() -> GitError {
    GitError::new("The worktree or its registration changed. Refresh and prepare a new review before another action.").kind("stale-operation")
}
fn display_path(path: &Path) -> String {
    let s = repo::normalize(path.to_path_buf()).to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        s.strip_prefix(r"\\?\UNC\").map(|p| format!(r"\\{p}")).unwrap_or_else(|| s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned())
    }
    #[cfg(not(windows))]
    {
        s
    }
}
fn key(path: &Path) -> String {
    let value = display_path(path);
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}
fn inside(path: &Path, parent: &Path) -> bool {
    let p = key(path);
    let root = key(parent);
    p == root || p.starts_with(&format!("{}{}", root.trim_end_matches(std::path::MAIN_SEPARATOR), std::path::MAIN_SEPARATOR))
}
fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
fn absolute(value: &str) -> GitResult<PathBuf> {
    let p = repo::normalize(PathBuf::from(value));
    if value.contains('\0') || !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err(fail("Use a complete absolute folder path without . or .. components."));
    }
    Ok(p)
}
fn oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|c| c.is_ascii_hexdigit()) && value.bytes().any(|c| c != b'0')
}
fn bytes(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value);
}
// Hash small administrative files without following links supplied by a replaced registration.
fn metadata_hash(hash: &mut Sha256, path: &Path) -> GitResult<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if linked(&m) => {
            bytes(hash, b"link");
            bytes(hash, fs::read_link(path)?.as_os_str().as_encoded_bytes());
        }
        Ok(m) if m.is_file() => {
            if m.len() > 128 * 1024 {
                return Err(fail("A worktree registration file is unexpectedly large."));
            }
            bytes(hash, b"file");
            bytes(hash, &fs::read(path)?);
        }
        Ok(_) => bytes(hash, b"directory"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => bytes(hash, b"missing"),
        Err(e) => return Err(e.into()),
    }
    Ok(())
}
struct Registry {
    rows: Vec<Worktree>,
    token: String,
}
fn registry(root: &Path) -> GitResult<Registry> {
    let raw = runner::run_bytes(root, ["worktree", "list", "--porcelain", "-z", "--expire=now"])?;
    let text = std::str::from_utf8(&raw).map_err(|_| fail("Non-UTF-8 worktree paths cannot be managed safely."))?;
    let rows = extras::parse_worktrees(text, root);
    if rows.is_empty() || rows.len() > 1000 {
        return Err(fail("Worktree inventory is empty or exceeds 1000 entries."));
    }
    let common = operations::repository_key(root);
    let admin = common.join("worktrees");
    let mut h = Sha256::new();
    bytes(&mut h, &raw);
    if let Ok(m) = fs::symlink_metadata(&admin) {
        if linked(&m) || !m.is_dir() {
            return Err(fail("The worktree registration directory is a link or is invalid."));
        }
        let mut dirs = fs::read_dir(&admin)?.map(|e| e.map(|e| e.path())).collect::<Result<Vec<_>, _>>()?;
        dirs.sort();
        if dirs.len() > 1000 {
            return Err(fail("Too many worktree registrations."));
        }
        for dir in dirs {
            bytes(&mut h, dir.file_name().unwrap_or_default().as_encoded_bytes());
            let m = fs::symlink_metadata(&dir)?;
            if linked(&m) || !m.is_dir() {
                return Err(fail("A worktree registration was replaced by a link or file."));
            }
            for name in ["HEAD", "gitdir", "commondir", "locked", "config.worktree"] {
                metadata_hash(&mut h, &dir.join(name))?;
            }
        }
    }
    for w in &rows {
        let p = Path::new(&w.path);
        metadata_hash(&mut h, p)?;
        if fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !linked(&m)) {
            metadata_hash(&mut h, &p.join(".git"))?;
        }
    }
    Ok(Registry { rows, token: format!("{:x}", h.finalize()) })
}
fn find<'a>(r: &'a Registry, input: &str) -> GitResult<(usize, &'a Worktree)> {
    let p = absolute(input)?;
    r.rows
        .iter()
        .enumerate()
        .find(|(_, w)| key(Path::new(&w.path)) == key(&p))
        .or_else(|| {
            fs::canonicalize(&p).ok().and_then(|p| r.rows.iter().enumerate().find(|(_, w)| fs::canonicalize(&w.path).is_ok_and(|q| key(&q) == key(&p))))
        })
        .ok_or_else(|| fail("This folder is not a registered worktree of the selected repository."))
}
fn direct_directory(path: &Path) -> GitResult<()> {
    // Operate only on Git's registered physical path. Parent links are resolved
    // in Git's list; a later replacement must not redirect a destructive command.
    for part in path.ancestors() {
        let m = fs::symlink_metadata(part)?;
        if linked(&m) || !m.is_dir() {
            return Err(fail("A worktree path or parent is a directory link/junction. Review the physical folder outside the manager."));
        }
    }
    Ok(())
}
fn validate_folder(root: &Path, w: &Worktree) -> GitResult<()> {
    let path = Path::new(&w.path);
    direct_directory(path)?;
    let marker = path.join(".git");
    let m = fs::symlink_metadata(&marker)?;
    if linked(&m) || !m.is_file() {
        return Err(fail("The worktree's .git marker is not a regular file."));
    }
    let gd = fs::canonicalize(repo::git_dir(path)?)?;
    let common = operations::repository_key(root);
    if gd.parent().map(key) != Some(key(&common.join("worktrees"))) || operations::repository_key(path) != common {
        return Err(fail("The folder's Git identity no longer matches its worktree registration."));
    }
    let back = fs::read_to_string(gd.join("gitdir"))?;
    let back = back.strip_suffix('\n').unwrap_or(&back).trim_end_matches('\r');
    if key(&fs::canonicalize(gd.join(back))?) != key(&fs::canonicalize(&marker)?) {
        return Err(fail("The worktree registration points to a different folder."));
    }
    Ok(())
}
fn protect_application(path: &Path) -> GitResult<()> {
    let path = fs::canonicalize(path)?;
    let mut owned = vec![std::env::current_exe()?];
    if let Some(p) = crate::portable::webview_dir() {
        owned.push(p);
    }
    owned.push(crate::portable::runtime_dir()?);
    if owned.iter().any(|p| inside(&fs::canonicalize(p).unwrap_or_else(|_| p.clone()), &path)) {
        return Err(fail("Revqora or its portable data is inside this worktree. Run Revqora from another folder before removing it."));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    #[serde(flatten)]
    pub worktree: Worktree,
    pub is_main: bool,
    pub exists: bool,
    pub changed_files: Option<usize>,
    pub staged: Option<u32>,
    pub untracked: Option<usize>,
    pub ignored: Option<usize>,
    pub operation: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub error: Option<String>,
}
fn row(root: &Path, w: Worktree, is_main: bool) -> Row {
    let presence = fs::symlink_metadata(&w.path);
    let exists = !presence.as_ref().is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
    let error = presence.err().filter(|e| e.kind() != std::io::ErrorKind::NotFound).map(|e| format!("Could not inspect this folder: {e}"));
    let mut row = Row {
        worktree: w,
        is_main,
        exists,
        changed_files: None,
        staged: None,
        untracked: None,
        ignored: None,
        operation: None,
        ahead: None,
        behind: None,
        error,
    };
    if row.error.is_some() {
        return row;
    }
    if !exists || row.worktree.bare {
        return row;
    }
    let result: GitResult<()> = (|| {
        let p = Path::new(&row.worktree.path);
        if !is_main {
            validate_folder(root, &row.worktree)?;
        }
        let raw = runner::run(p, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=none"])?;
        let s = status::parse(&raw);
        let ignored = super::workspace_files::ignored(p)?;
        row.changed_files = Some(s.files.len());
        row.staged = Some(s.staged_count);
        row.untracked = Some(s.files.iter().filter(|f| f.untracked).count());
        row.ignored = Some(ignored.paths.len());
        row.ahead = Some(s.ahead);
        row.behind = Some(s.behind);
        row.operation = Some(repo::op_state(p, &repo::git_dir(p)?).kind);
        Ok(())
    })();
    if let Err(e) = result {
        row.error = Some(e.message);
    }
    row
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub worktrees: Vec<Row>,
    pub registry_token: String,
    pub state_token: String,
}
pub fn snapshot(root: &Path) -> GitResult<Snapshot> {
    let ((rows, registry_token), state_token) = operations::inspect(root, || {
        let r = registry(root)?;
        let token = r.token.clone();
        let rows = r.rows.into_iter().enumerate().map(|(i, w)| row(root, w, i == 0)).collect();
        if registry(root)?.token != token {
            return Err(stale());
        }
        Ok((rows, token))
    })?;
    Ok(Snapshot { worktrees: rows, registry_token, state_token })
}

struct Contents {
    token: String,
    paths: Vec<String>,
    bytes: u64,
}
fn contents(root: &Path) -> GitResult<Contents> {
    let mut pending = vec![root.to_owned()];
    let mut paths = Vec::new();
    let mut total = 0u64;
    let mut h = Sha256::new();
    while let Some(dir) = pending.pop() {
        let mut entries = fs::read_dir(&dir)?.map(|e| e.map(|e| e.path())).collect::<Result<Vec<_>, _>>()?;
        entries.sort();
        for p in entries {
            if dir == root && p.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            let rel = p
                .strip_prefix(root)
                .map_err(|_| fail("Invalid worktree path."))?
                .to_str()
                .ok_or_else(|| fail("Non-UTF-8 filenames cannot be recovered safely."))?
                .to_owned();
            #[cfg(windows)]
            let rel = rel.replace('\\', "/");
            paths.push(rel.clone());
            if paths.len() > MAX_PATHS {
                return Err(fail("A complete recovery snapshot exceeds 20,000 paths. Move large generated folders out before reviewing removal."));
            }
            bytes(&mut h, rel.as_bytes());
            let m = fs::symlink_metadata(&p)?;
            if linked(&m) {
                #[cfg(windows)]
                let directory_link = {
                    use std::os::windows::fs::MetadataExt;
                    m.file_attributes() & 0x10 != 0
                };
                #[cfg(not(windows))]
                let directory_link = fs::metadata(&p).is_ok_and(|m| m.is_dir());
                if directory_link {
                    return Err(fail("Directory links/junctions are not removed by the manager. Move the link out and review again."));
                }
                bytes(&mut h, b"link");
                bytes(&mut h, fs::read_link(&p)?.as_os_str().as_encoded_bytes());
            } else if m.is_dir() {
                if fs::symlink_metadata(p.join(".git")).is_ok() || (p.join("HEAD").is_file() && p.join("objects").is_dir()) {
                    return Err(fail("Nested repositories must be moved out before removing this worktree."));
                }
                bytes(&mut h, b"dir");
                pending.push(p);
            } else if m.is_file() {
                bytes(&mut h, b"file");
                h.update(m.len().to_le_bytes());
                let mut f = fs::File::open(&p)?;
                let mut buf = [0u8; 65536];
                loop {
                    let n = f.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    total += n as u64;
                    if total > MAX_BYTES {
                        return Err(fail("A complete recovery snapshot exceeds 100 MiB. Move large files out before reviewing removal."));
                    }
                    h.update(&buf[..n]);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    h.update(m.permissions().mode().to_le_bytes());
                }
            } else {
                return Err(fail("Special files cannot be included in a complete recovery snapshot."));
            }
        }
    }
    // Include missing tracked paths too (in particular hidden skip-worktree /
    // assume-unchanged deletions); restore must reproduce their absence.
    let tracked = runner::run_bytes(root, ["ls-files", "--cached", "-z"])?;
    let tracked = std::str::from_utf8(&tracked).map_err(|_| fail("Non-UTF-8 index paths cannot be recovered safely."))?;
    paths.extend(tracked.split('\0').filter(|s| !s.is_empty()).map(str::to_owned));
    paths.sort();
    paths.dedup();
    if paths.len() > MAX_PATHS {
        return Err(fail("A complete recovery snapshot exceeds 20,000 paths."));
    }
    Ok(Contents { token: format!("{:x}", h.finalize()), paths, bytes: total })
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub path: String,
    pub registry_token: String,
    pub target_state: String,
    pub contents_token: String,
    pub state_token: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReview {
    pub target: Row,
    pub proof: Proof,
    pub files: usize,
    pub bytes: u64,
    pub requires_force: bool,
    pub state_token: String,
}
fn removable(root: &Path, r: &Registry, path: &str) -> GitResult<Worktree> {
    let (i, w) = find(r, path)?;
    if i == 0 || w.bare {
        return Err(fail("The main worktree cannot be removed."));
    }
    if w.is_current {
        return Err(fail("Open another worktree before removing this one."));
    }
    if w.locked {
        return Err(fail("Unlock the worktree explicitly before reviewing removal."));
    }
    validate_folder(root, w)?;
    protect_application(Path::new(&w.path))?;
    let p = Path::new(&w.path);
    if repo::op_state(p, &repo::git_dir(p)?).kind != "none" {
        return Err(fail("Finish or abort the worktree's current Git operation before removing it."));
    }
    if runner::run(p, ["ls-files", "--stage", "-z"])?.split('\0').any(|s| s.starts_with("160000 ")) {
        return Err(fail("Worktrees containing submodules are not removed by this manager."));
    }
    Ok(w.clone())
}
pub fn removal_review(root: &Path, path: &str) -> GitResult<RemovalReview> {
    let ((target, mut proof, files, bytes, requires_force), state_token) = operations::inspect(root, || {
        let r = registry(root)?;
        let w = removable(root, &r, path)?;
        let p = Path::new(&w.path);
        let before = status::status(p)?.state_token.unwrap_or_default();
        let c = contents(p)?;
        let target = row(root, w.clone(), false);
        if let Some(error) = &target.error {
            return Err(fail(error));
        }
        let flags = runner::run(p, ["ls-files", "-v", "-z"])?;
        let flagged = flags.split('\0').any(|s| s.as_bytes().first().is_some_and(|c| c.is_ascii_lowercase() || *c == b'S'));
        let requires_force = target.changed_files.unwrap_or(0) > 0 || target.ignored.unwrap_or(0) > 0 || flagged;
        if status::status(p)?.state_token.as_deref() != Some(before.as_str()) || registry(root)?.token != r.token || contents(p)?.token != c.token {
            return Err(stale());
        }
        let proof = Proof { path: w.path, registry_token: r.token, target_state: before, contents_token: c.token, state_token: String::new() };
        Ok((target, proof, c.paths.len(), c.bytes, requires_force))
    })?;
    proof.state_token = state_token.clone();
    Ok(RemovalReview { target, proof, files, bytes, requires_force, state_token })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub path: String,
    pub removed: Option<bool>,
    pub checkpoint: recovery::Summary,
    pub warning: Option<String>,
}
pub fn remove(root: &Path, proof: &Proof, allow_dirty: bool) -> GitResult<Removal> {
    let fresh = removal_review(root, &proof.path)?;
    if fresh.proof.registry_token != proof.registry_token
        || fresh.proof.target_state != proof.target_state
        || fresh.proof.contents_token != proof.contents_token
    {
        return Err(stale());
    }
    if fresh.requires_force && !allow_dirty {
        return Err(fail("Confirm removal of local/ignored changes after reviewing the recovery snapshot."));
    }
    let p = Path::new(&proof.path);
    let c = contents(p)?;
    let cp = recovery::complete_workspace(p, "worktree_remove", "Before removing worktree", &proof.target_state, &c.paths)?;
    // Check again after capture; ignored paths are outside the ordinary status token.
    if registry(root)?.token != proof.registry_token
        || status::status(p)?.state_token.as_deref() != Some(proof.target_state.as_str())
        || contents(p)?.token != proof.contents_token
    {
        return Err(stale());
    }
    let mut args = vec!["worktree", "remove"];
    if allow_dirty {
        args.push("--force");
    }
    args.extend(["--", proof.path.as_str()]);
    let out = runner::exec(root, args)?;
    let mut warning = if out.ok() { None } else { Some(runner::to_error("git worktree remove", &out).message) };
    // A refresh failure after Git ran must retain the checkpoint and must not
    // masquerade as a fresh, retryable confirmation.
    let removed = match registry(root) {
        Ok(after) => Some(!after.rows.iter().any(|w| key(Path::new(&w.path)) == key(p))),
        Err(e) => {
            warning = Some(format!("{} Refresh the manager before another action: {}", warning.unwrap_or_default(), e.message));
            if out.ok() {
                Some(true)
            } else {
                None
            }
        }
    };
    Ok(Removal { path: proof.path.clone(), removed, checkpoint: cp, warning })
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CreateMode {
    Existing,
    New,
    Detached,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub path: String,
    pub mode: CreateMode,
    pub branch: String,
    pub start: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreationReview {
    pub request: CreateRequest,
    pub path: String,
    pub start_oid: String,
    pub registry_token: String,
    pub parent_token: String,
    pub state_token: String,
}
fn destination(root: &Path, r: &Registry, value: &str) -> GitResult<(PathBuf, String)> {
    let requested = absolute(value)?;
    let name = requested.file_name().ok_or_else(|| fail("Choose a new worktree folder, not a drive root."))?;
    let parent = fs::canonicalize(requested.parent().ok_or_else(|| fail("Choose a parent folder."))?)?;
    direct_directory(&parent)?;
    let dest = parent.join(name);
    match fs::symlink_metadata(&dest) {
        Ok(_) => return Err(fail("The destination already exists. Choose a new folder.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let common = operations::repository_key(root);
    if inside(&dest, &common) {
        return Err(fail("A worktree cannot be created inside Git metadata."));
    }
    for w in &r.rows {
        let p = Path::new(&w.path);
        if inside(&dest, p) || inside(p, &dest) {
            return Err(fail("Choose a folder outside every existing worktree, including missing registrations."));
        }
    }
    let m = fs::metadata(&parent)?;
    let token = format!("{}:{:?}:{:?}", key(&parent), m.created().ok(), m.modified().ok());
    Ok((dest, token))
}
fn branch_available(root: &Path, branch: &str, new: bool, r: &Registry) -> GitResult<()> {
    if branch.is_empty() || branch.starts_with('-') || !runner::exec(root, ["check-ref-format", "--branch", branch])?.ok() {
        return Err(fail("Enter a valid local branch name."));
    }
    let reference = format!("refs/heads/{branch}");
    if runner::exec(root, ["symbolic-ref", "-q", &reference])?.ok() {
        return Err(fail("Symbolic branch aliases cannot be used for worktree creation."));
    }
    let exists = runner::exec(root, ["show-ref", "--verify", "--quiet", &reference])?.ok();
    if new && exists {
        return Err(fail("That local branch already exists."));
    }
    if !new && !exists {
        return Err(fail("The selected local branch no longer exists."));
    }
    if !new && runner::run(root, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", branch])?.trim() != reference {
        return Err(fail("The branch name is ambiguous as a Git revision. Rename the conflicting reference or use a detached worktree at an exact commit."));
    }
    if !new && r.rows.iter().any(|w| w.branch.as_deref() == Some(branch)) {
        return Err(fail("The branch is already assigned to a worktree. Open it or review its missing registration first."));
    }
    Ok(())
}
pub fn creation_review(root: &Path, request: CreateRequest) -> GitResult<CreationReview> {
    let ((path, start_oid, registry_token, parent_token), state_token) = operations::inspect(root, || {
        let r = registry(root)?;
        let (path, parent_token) = destination(root, &r, &request.path)?;
        if request.mode != CreateMode::Detached {
            branch_available(root, &request.branch, request.mode == CreateMode::New, &r)?;
        }
        let start = if request.mode == CreateMode::Existing { format!("refs/heads/{}", request.branch) } else { request.start.clone() };
        if start.is_empty() || start.starts_with('-') {
            return Err(fail("Choose an existing start commit or branch."));
        }
        let start_oid = runner::run(root, ["rev-parse", "--verify", "--end-of-options", &format!("{start}^{{commit}}")])?.trim().to_owned();
        if !oid(&start_oid) {
            return Err(fail("The start point is not a commit."));
        }
        if registry(root)?.token != r.token {
            return Err(stale());
        }
        Ok((display_path(&path), start_oid, r.token, parent_token))
    })?;
    Ok(CreationReview { request, path, start_oid, registry_token, parent_token, state_token })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub path: String,
    pub head: Option<String>,
    pub warning: Option<String>,
}
pub fn create(root: &Path, review: &CreationReview) -> GitResult<Created> {
    if creation_review(root, review.request.clone())? != *review {
        return Err(stale());
    }
    let mut args = vec!["worktree".to_owned(), "add".into(), "--no-guess-remote".into()];
    if review.request.mode == CreateMode::New {
        args.extend(["-b".into(), review.request.branch.clone()]);
    }
    if review.request.mode == CreateMode::Detached {
        args.push("--detach".into());
    }
    args.extend([
        "--".into(),
        review.path.clone(),
        if review.request.mode == CreateMode::Existing { review.request.branch.clone() } else { review.start_oid.clone() },
    ]);
    let out = runner::exec(root, args)?;
    if !out.ok() {
        let mut e = runner::to_error("git worktree add", &out);
        e.message.push_str(" Git may have created a branch or folder. Refresh the manager before retrying; no automatic retry was attempted.");
        return Err(e);
    }
    let head = repo::head(Path::new(&review.path))?.oid;
    let warning = (head.as_deref() != Some(&review.start_oid))
        .then(|| "The branch changed during Git execution. The new folder is kept; inspect its actual HEAD before use.".into());
    Ok(Created { path: review.path.clone(), head, warning })
}

pub fn lock(root: &Path, path: &str, expected_registry: &str, locked: bool, reason: &str) -> GitResult<()> {
    let r = registry(root)?;
    if r.token != expected_registry {
        return Err(stale());
    }
    let (i, w) = find(&r, path)?;
    if i == 0 || w.bare {
        return Err(fail("The main worktree cannot be locked."));
    }
    if w.locked == locked {
        return Err(stale());
    }
    if reason.len() > 1000 || reason.contains('\0') {
        return Err(fail("Lock reasons must be at most 1000 bytes."));
    }
    let mut args = vec!["worktree", if locked { "lock" } else { "unlock" }];
    if locked && !reason.trim().is_empty() {
        args.extend(["--reason", reason.trim()]);
    }
    args.extend(["--", &w.path]);
    runner::run(root, args)?;
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Missing {
    pub path: String,
    pub head: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReview {
    pub entries: Vec<Missing>,
    pub registry_token: String,
    pub state_token: String,
    pub remaining: usize,
}
pub fn prune_review(root: &Path) -> GitResult<PruneReview> {
    let ((entries, registry_token, remaining), state_token) = operations::inspect(root, || {
        let r = registry(root)?;
        let mut entries: Vec<_> = r
            .rows
            .iter()
            .skip(1)
            .filter(|w| {
                !w.bare && !w.is_current && !w.locked && w.prunable && fs::symlink_metadata(&w.path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            })
            .map(|w| Missing { path: w.path.clone(), head: w.head.clone().filter(|h| oid(h)) })
            .collect();
        let remaining = entries.len().saturating_sub(50);
        entries.truncate(50);
        Ok((entries, r.token, remaining))
    })?;
    Ok(PruneReview { entries, registry_token, state_token, remaining })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    pub removed: Vec<String>,
    pub kept: Vec<String>,
    pub unknown: Vec<String>,
    pub checkpoint: recovery::Summary,
    pub warning: Option<String>,
}
fn missing_unchanged(r: &Registry, item: &Missing) -> GitResult<()> {
    let (i, w) = find(r, &item.path)?;
    if i == 0
        || w.is_current
        || w.bare
        || w.locked
        || !w.prunable
        || w.head.clone().filter(|h| oid(h)) != item.head
        || !fs::symlink_metadata(&w.path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    {
        return Err(stale());
    }
    Ok(())
}
pub fn prune(root: &Path, review: &PruneReview, mut progress: impl FnMut(&str)) -> GitResult<PruneResult> {
    if review.entries.is_empty() || review.entries.len() > 50 {
        return Err(fail("Review between 1 and 50 missing worktree entries."));
    }
    let r = registry(root)?;
    if r.token != review.registry_token {
        return Err(stale());
    }
    let mut seen = BTreeSet::new();
    for item in &review.entries {
        if !seen.insert(key(Path::new(&item.path))) {
            return Err(fail("A registration was selected twice."));
        }
        missing_unchanged(&r, item)?;
    }
    let refs = review
        .entries
        .iter()
        .filter_map(|e| e.head.as_ref().map(|oid| recovery::SavedRef { name: format!("Worktree HEAD: {}", e.path), oid: oid.clone(), kind: "worktree".into() }))
        .collect::<Vec<_>>();
    let cp = recovery::reference_checkpoint(root, "worktree_prune", "Before removing missing worktree registrations", &refs, Some(&review.state_token))?;
    let mut expected = review.registry_token.clone();
    let mut removed = Vec::new();
    let mut unknown = Vec::new();
    let mut warning = None;
    for item in &review.entries {
        progress(&item.path);
        let result = (|| {
            let current = registry(root)?;
            if current.token != expected {
                return Err(stale());
            }
            missing_unchanged(&current, item)?;
            // Scoped native removal, without --force: unrelated registrations are
            // never swept up by a global prune. A reappeared dirty folder is kept.
            let out = runner::exec(root, ["worktree", "remove", "--", &item.path])?;
            match registry(root) {
                Ok(after) => {
                    if !after.rows.iter().any(|w| key(Path::new(&w.path)) == key(Path::new(&item.path))) {
                        removed.push(item.path.clone());
                    } else if out.ok() {
                        return Err(fail("The path is registered again. Inspect the new registration before another action."));
                    }
                    expected = after.token;
                }
                Err(e) => {
                    if out.ok() {
                        removed.push(item.path.clone());
                    } else {
                        unknown.push(item.path.clone());
                    }
                    return Err(fail(format!("Git ran but refreshing the registry failed: {}", e.message)));
                }
            }
            if !out.ok() {
                return Err(runner::to_error("git worktree remove", &out));
            }
            Ok(())
        })();
        match result {
            Ok(()) => {}
            Err(e) => {
                warning = Some(e.message);
                break;
            }
        }
    }
    let kept = review.entries.iter().filter(|e| !removed.contains(&e.path) && !unknown.contains(&e.path)).map(|e| e.path.clone()).collect();
    Ok(PruneResult { removed, kept, unknown, checkpoint: cp, warning })
}
