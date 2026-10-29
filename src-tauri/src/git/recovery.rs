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
    let out = runner::exec(root, ["config", "--bool", "--get", key])?;
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
                    Ok(cp) => items.push(cp.summary),
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
    let raw = runner::run(
        root,
        ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(objecttype)", "refs/heads", "refs/remotes", "refs/worktree/revqora", "refs/stash"],
    )?;
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
    for (i, value) in runner::run(root, ["stash", "list", "--format=%H"])?.lines().enumerate() {
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
            create_locked(root, command, label, workspace, ignored, observed.as_deref(), references)
        },
    )
}

fn create_locked(
    root: &Path,
    command: &str,
    label: &str,
    workspace: bool,
    ignored: bool,
    expected: Option<&str>,
    references: &[SavedRef],
) -> GitResult<Summary> {
    // Capture is a mutation: pinning objects must never occur in a read path.
    let _lock = lock(root)?;
    let root = fs::canonicalize(repo::discover(root)?)?;
    if workspace {
        let filenames = runner::run_bytes(&root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])?;
        std::str::from_utf8(&filenames).map_err(|_| fail("Non-UTF-8 filenames cannot be captured safely."))?;
    }
    let before = status::status(&root)?;
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
        },
        version: 1,
        common_dir: operations::repository_key(&root).to_string_lossy().into_owned(),
        pin: String::new(),
        base_commit: String::new(),
        refs: refs(&root)?,
        paths: Vec::new(),
        index_files: Vec::new(),
        sparse: false,
        sparse_cone: false,
        sparse_patterns: None,
    };
    for reference in references {
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
        let shared = runner::run(&root, ["rev-parse", "--shared-index-path"])?;
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
        let mut paths = BTreeSet::new();
        for file in &before.files {
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
    if workspace {
        git(&root, &strings(&["hash-object", "-w", "--stdin"]), Some(&[]))?;
    }
    let raw = if workspace { runner::run(&root, ["ls-files", "--stage", "-z"])? } else { String::new() };
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
    let empty = git(&root, &strings(&["mktree", "-z"]), Some(&[]))?;
    cp.base_commit = match &cp.summary.head {
        Some(head) => head.clone(),
        None => commit(&root, &empty, &[])?,
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
    let mut manifest = File::create(folder.path().join("checkpoint.pending"))?;
    manifest.write_all(&data)?;
    manifest.sync_all()?;
    let reference = format!("{PREFIX}{}", cp.summary.id);
    runner::run(&root, ["update-ref", &reference, &cp.pin, &"0".repeat(cp.pin.len())])?;
    drop(manifest);
    let kept = folder.keep();
    fs::rename(kept.join("checkpoint.pending"), kept.join("checkpoint.json"))?;
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
fn prune_locked(root: &Path, keep: Option<&str>) -> GitResult<()> {
    let items = list(root)?.checkpoints;
    let mut bytes = 0;
    for (i, item) in items.iter().enumerate() {
        bytes += item.bytes;
        if Some(item.id.as_str()) != keep && (i >= MAX_COUNT || bytes > MAX_TOTAL || item.created_at < crate::journal::now() - RETENTION) {
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
    );
    let refs = matches!(command, "branch_delete" | "branch_delete_remote" | "stash_drop" | "push" | "push_ref");
    if workspace || refs {
        automatic_expected(root, command, workspace, false, expected)?;
    }
    Ok(())
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
    let config = |key: &str| runner::run(root, ["config", "--get", key]).unwrap_or_default().trim().to_owned();
    let names = if let Some(remote) = remote {
        vec![remote.to_owned()]
    } else if all {
        runner::run(root, ["remote"])?.lines().map(str::to_owned).collect()
    } else {
        let head = repo::head(root)?.branch.unwrap_or_default();
        let mut candidates = Vec::new();
        if push {
            candidates.extend([config(&format!("branch.{head}.pushRemote")), config("remote.pushDefault")]);
        }
        let remotes: Vec<_> = runner::run(root, ["remote"])?.lines().map(str::to_owned).collect();
        let fallback = if remotes.len() == 1 { remotes[0].clone() } else { "origin".into() };
        candidates.extend([config(&format!("branch.{head}.remote")), fallback]);
        vec![candidates.into_iter().find(|s| !s.is_empty()).unwrap()]
    };
    for name in names {
        if name.starts_with('-') {
            return Err(reject());
        }
        if push && runner::run(root, ["config", "--bool", "--get", &format!("remote.{name}.mirror")]).unwrap_or_default().trim() == "true" {
            return Err(reject());
        }
        if !push || explicit.is_none() {
            let values = runner::run(root, ["config", "--get-all", &format!("remote.{name}.{}", if push { "push" } else { "fetch" })]).unwrap_or_default();
            if values.lines().any(unsafe_spec) {
                return Err(reject());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
