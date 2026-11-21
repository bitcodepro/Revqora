//! What happened to the files a checkpoint saved, kept beside the checkpoint so it survives a
//! restart: the operation the checkpoint was made for (its result and the state of every saved
//! path right after it), and each restore from the checkpoint, file by file.
//!
//! A checkpoint made inside an operation starts with a record in the "running" state. The
//! operation's end replaces it with the result. A record still "running" when no operation of
//! this app holds it means the app stopped first: what the operation did is unknown, so every
//! saved path that now differs from its copy needs a manual check.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::{base, create_with_ignored, digest, fail, lock, read, repo, source_path, SavedPath, Summary, WATCH_MAX_HASH};
use crate::git::runner::GitResult;

const RECORD: &str = "operation.json";
const RESTORES: &str = "restores.jsonl";
const MAX_RECORD: u64 = 32 * 1024 * 1024;
const MAX_LOG: u64 = 64 * 1024 * 1024;

/// A path in the working tree at one moment.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    /// file, link, directory, missing, other or unreadable.
    pub kind: String,
    #[serde(default)]
    pub len: u64,
    /// Content hash of a file (None when larger than 100 MiB or unreadable).
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
}

pub(super) fn state_of(root: &Path, path: &str) -> FileState {
    let Ok(full) = source_path(root, path) else {
        return FileState { kind: "unreadable".into(), ..Default::default() };
    };
    match fs::symlink_metadata(&full) {
        Ok(m) if m.file_type().is_symlink() => {
            FileState { kind: "link".into(), target: fs::read_link(&full).ok().and_then(|t| t.into_os_string().into_string().ok()), ..Default::default() }
        }
        Ok(m) if m.is_file() => {
            FileState { kind: "file".into(), len: m.len(), sha256: if m.len() <= WATCH_MAX_HASH { digest(&full).ok() } else { None }, target: None }
        }
        Ok(m) if m.is_dir() => FileState { kind: "directory".into(), ..Default::default() },
        Ok(_) => FileState { kind: "other".into(), ..Default::default() },
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
            FileState { kind: "missing".into(), ..Default::default() }
        }
        Err(_) => FileState { kind: "unreadable".into(), ..Default::default() },
    }
}

/// The path looks exactly as the checkpoint saved it.
fn matches_saved(saved: &SavedPath, now: &FileState) -> bool {
    match saved.kind.as_str() {
        "file" => now.kind == "file" && now.sha256.is_some() && now.sha256 == saved.sha256,
        "link" => now.kind == "link" && now.target == saved.target,
        kind => now.kind == kind,
    }
}

/// Two observations of a path are the same content (unknown hashes never match).
fn same_state(a: &FileState, b: &FileState) -> bool {
    a.kind == b.kind
        && match a.kind.as_str() {
            "file" => a.len == b.len && a.sha256.is_some() && a.sha256 == b.sha256,
            "link" => a.target == b.target,
            "unreadable" | "other" => false,
            _ => true,
        }
}

/// The operation a checkpoint was saved for.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub version: u32,
    /// Its Operation log entry, when the journal was available.
    pub operation: Option<String>,
    pub command: String,
    /// running, succeeded, attention or failed. Views report "interrupted" for a record still
    /// running that no operation of this app holds.
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
    /// Saved paths the operation left different from their saved copy, as they were right after it.
    #[serde(default)]
    pub changed: BTreeMap<String, FileState>,
}

fn read_record(dir: &Path) -> Option<OperationRecord> {
    let path = dir.join(RECORD);
    let m = fs::symlink_metadata(&path).ok()?;
    if !m.is_file() || m.len() > MAX_RECORD {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_record(dir: &Path, record: &OperationRecord) -> GitResult<()> {
    let data = serde_json::to_vec_pretty(record).map_err(|e| fail(e.to_string()))?;
    let mut temporary = crate::git::atomic_file::new_in(dir)?;
    temporary.write_all(&data)?;
    temporary.as_file().sync_all()?;
    crate::git::atomic_file::replace(temporary, &dir.join(RECORD))?;
    Ok(())
}

/// Checkpoints whose operation is still running in this app.
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

fn effective_status(id: &str, record: &OperationRecord) -> String {
    if record.status == "running" && !running().lock().unwrap_or_else(|e| e.into_inner()).contains(id) {
        "interrupted".into()
    } else {
        record.status.clone()
    }
}

/// The result shown in the checkpoint list, read from disk.
pub(super) fn listed_status(root: &Path, id: &str) -> Option<String> {
    let record = read_record(&base(root).ok()?.join(id))?;
    Some(effective_status(id, &record))
}

/// One operation running on this thread, and the checkpoints saved for it.
struct Frame {
    journal: Option<String>,
    command: String,
    created: Vec<(PathBuf, String)>,
}

thread_local! {
    // Operations can nest (a confirmation that runs another queued operation), so the innermost
    // one owns the checkpoints saved while it runs.
    static FRAMES: RefCell<Vec<Frame>> = const { RefCell::new(Vec::new()) };
}

/// Start of an operation on this thread.
pub(super) fn enter(command: &str) {
    let journal = crate::journal::current_id();
    FRAMES.with(|f| f.borrow_mut().push(Frame { journal, command: command.to_owned(), created: Vec::new() }));
}

/// The command of the innermost operation running on this thread.
pub(super) fn current_command() -> Option<String> {
    FRAMES.with(|f| f.borrow().last().map(|frame| frame.command.clone()))
}

/// End of the operation started by `enter`, on every exit path. Checkpoints whose result was not
/// recorded (the operation unwound) are marked failed.
pub(super) fn leave() {
    let Some(frame) = FRAMES.with(|f| f.borrow_mut().pop()) else { return };
    for (root, id) in frame.created {
        finish_one(&root, &id, "failed", Some("The operation stopped unexpectedly before it finished.".into()));
    }
}

/// Called while a checkpoint is created, before it becomes visible: an operation's checkpoint gets
/// its "running" record. Manual checkpoints belong to no operation.
pub(super) fn started(folder: &Path, summary: &Summary) -> bool {
    if summary.command == "manual" {
        return false;
    }
    let Some((journal, command)) = FRAMES.with(|f| f.borrow().last().map(|frame| (frame.journal.clone(), frame.command.clone()))) else {
        return false;
    };
    let record = OperationRecord {
        version: 1,
        operation: journal,
        command,
        status: "running".into(),
        started_at: crate::journal::now(),
        finished_at: None,
        error: None,
        changed: BTreeMap::new(),
    };
    // Without the record the checkpoint still protects the files; Recovery then shows no result.
    write_record(folder, &record).is_ok()
}

/// The checkpoint `started` prepared is now in place.
pub(super) fn registered(root: &Path, id: &str) {
    running().lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_owned());
    let journal = FRAMES.with(|f| {
        let mut frames = f.borrow_mut();
        let frame = frames.last_mut()?;
        frame.created.push((root.to_owned(), id.to_owned()));
        frame.journal.clone()
    });
    if let Some(journal) = journal {
        crate::journal::link_checkpoint(&journal, id);
    }
}

/// End of the running operation: records its result and what it left in place of each saved path.
pub(super) fn record(status: &str, error: Option<&str>) {
    let created = FRAMES.with(|f| f.borrow_mut().last_mut().map(|frame| std::mem::take(&mut frame.created))).unwrap_or_default();
    let error = error.map(|e| crate::journal::redact::bounded(&crate::journal::redact::text(e), 2048).0);
    for (root, id) in created {
        finish_one(&root, &id, status, error.clone());
    }
}

fn finish_one(root: &Path, id: &str, status: &str, error: Option<String>) {
    let write = || -> GitResult<()> {
        let cp = read(root, id)?;
        let dir = base(root)?.join(id);
        let Some(mut record) = read_record(&dir) else { return Ok(()) };
        record.status = status.to_owned();
        record.finished_at = Some(crate::journal::now());
        record.error = error;
        record.changed = cp
            .paths
            .iter()
            .filter_map(|saved| {
                let now = state_of(root, &saved.path);
                (!matches_saved(saved, &now)).then(|| (saved.path.clone(), now))
            })
            .collect();
        write_record(&dir, &record)
    };
    // A record that cannot be written stays "running" and later reads as interrupted: the
    // saved files are then offered for a manual check instead of trusted blindly.
    let _ = write();
    running().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

/// One line of a checkpoint's restore log.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreEvent {
    pub at: i64,
    /// plan, restored, keptBoth, unchanged, failed or done.
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// For a plan: the checkpoint that keeps the versions this restore replaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
}

fn append(dir: &Path, event: &RestoreEvent) -> GitResult<()> {
    let mut line = serde_json::to_vec(event).map_err(|e| fail(e.to_string()))?;
    line.push(b'\n');
    let path = dir.join(RESTORES);
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
        return Err(fail("The restore log was replaced by a link or folder."));
    }
    // A crash can leave the last record cut short. Drop that fragment first, so this record starts
    // on a line of its own and every later read still reaches it.
    if let Ok(bytes) = fs::read(&path) {
        if bytes.last().is_some_and(|b| *b != b'\n') {
            let keep = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
            OpenOptions::new().write(true).open(&path)?.set_len(keep as u64)?;
        }
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(&line)?;
    file.sync_data()?;
    Ok(())
}

/// A path the restore kept as it was, with the saved copy written beside it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeptBoth {
    pub path: String,
    pub copy: String,
}

/// The most recent restore from a checkpoint, as its log recorded it.
#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub started_at: i64,
    /// False when the app stopped during the restore.
    pub finished: bool,
    pub planned: Vec<String>,
    pub restored: Vec<String>,
    pub kept_both: Vec<KeptBoth>,
    pub unchanged: Vec<String>,
    pub failed: Vec<(String, String)>,
    /// Planned paths with no result: not reached, or interrupted while being written.
    pub not_finished: Vec<String>,
    pub checkpoint: Option<String>,
}

fn last_restore(dir: &Path) -> Option<RestoreSummary> {
    let path = dir.join(RESTORES);
    let m = fs::symlink_metadata(&path).ok()?;
    if !m.is_file() || m.len() > MAX_LOG {
        return None;
    }
    let mut summary: Option<RestoreSummary> = None;
    for line in BufReader::new(File::open(path).ok()?).lines() {
        let Ok(line) = line else { break };
        // A line cut short by a crash is skipped; records written after it still count.
        let Ok(event) = serde_json::from_str::<RestoreEvent>(&line) else { continue };
        if event.event == "plan" {
            summary = Some(RestoreSummary { started_at: event.at, planned: event.paths, checkpoint: event.checkpoint, ..Default::default() });
            continue;
        }
        let Some(current) = summary.as_mut() else { continue };
        let path = event.path.clone().unwrap_or_default();
        match event.event.as_str() {
            "restored" => current.restored.push(path),
            "keptBoth" => current.kept_both.push(KeptBoth { path, copy: event.copy.unwrap_or_default() }),
            "unchanged" => current.unchanged.push(path),
            "failed" => current.failed.push((path, event.error.unwrap_or_default())),
            "done" => current.finished = true,
            _ => {}
        }
    }
    let mut summary = summary?;
    let done: HashSet<&str> = summary
        .restored
        .iter()
        .chain(&summary.unchanged)
        .chain(summary.kept_both.iter().map(|k| &k.path))
        .chain(summary.failed.iter().map(|f| &f.0))
        .map(String::as_str)
        .collect();
    summary.not_finished = summary.planned.iter().filter(|p| !done.contains(p.as_str())).cloned().collect();
    Some(summary)
}

/// The operation a checkpoint belongs to, with its status as seen now.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationView {
    #[serde(flatten)]
    pub record: OperationRecord,
    /// The record's status, or "interrupted" when the app stopped before the operation finished.
    pub effective_status: String,
}

/// A saved path compared with the working tree now.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub path: String,
    pub saved_kind: String,
    /// same (matches the saved copy), operation (as the operation left it), later (changed after
    /// the operation) or unknown (the operation's effect was not recorded).
    pub state: String,
    pub current: FileState,
    /// A saved file that differs from the working tree now.
    pub restorable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFiles {
    pub operation: Option<OperationView>,
    pub files: Vec<SavedFile>,
    pub last_restore: Option<RestoreSummary>,
}

fn classify(saved: &SavedPath, now: &FileState, record: Option<&OperationRecord>, finished: bool) -> &'static str {
    if matches_saved(saved, now) {
        return "same";
    }
    match record.filter(|_| finished) {
        Some(record) => match record.changed.get(&saved.path) {
            Some(after) if same_state(after, now) => "operation",
            _ => "later",
        },
        None => "unknown",
    }
}

/// Every saved path of checkpoint `id` against the working tree now. Reads files only.
pub fn files(root: &Path, id: &str) -> GitResult<CheckpointFiles> {
    let root = fs::canonicalize(repo::discover(root)?)?;
    let cp = read(&root, id)?;
    let dir = base(&root)?.join(id);
    let record = read_record(&dir);
    let operation = record.clone().map(|record| OperationView { effective_status: effective_status(id, &record), record });
    let finished = operation.as_ref().is_some_and(|o| !matches!(o.effective_status.as_str(), "running" | "interrupted"));
    let files = cp
        .paths
        .iter()
        .map(|saved| {
            let current = state_of(&root, &saved.path);
            let state = classify(saved, &current, record.as_ref(), finished);
            SavedFile {
                path: saved.path.clone(),
                saved_kind: saved.kind.clone(),
                state: state.into(),
                restorable: saved.kind == "file" && state != "same",
                current,
            }
        })
        .collect();
    Ok(CheckpointFiles { operation, files, last_restore: last_restore(&dir) })
}

/// Result of putting saved files back in place.
#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub restored: Vec<String>,
    /// Changed after the operation, or its effect is unknown: left as they are, with the saved
    /// copy written beside each (see `kept_both`).
    pub changed_since: Vec<String>,
    pub kept_both: Vec<KeptBoth>,
    /// Already identical to the saved copy.
    pub unchanged: Vec<String>,
    /// The file whose write failed, and why; files after it were not attempted.
    pub failed: Option<(String, String)>,
    pub not_attempted: Vec<String>,
    /// The checkpoint that keeps the versions this restore replaced.
    pub checkpoint: Option<String>,
    /// Why those versions could not be saved; every changed file was then kept and written beside.
    pub checkpoint_error: Option<String>,
}

/// `name.recovered`, or `name.recovered-2`… for the first name not in use.
fn beside(destination: &Path) -> GitResult<(PathBuf, File)> {
    let name = destination.file_name().ok_or_else(|| fail("Invalid path."))?.to_string_lossy().into_owned();
    for n in 1..=100 {
        let candidate = destination.with_file_name(if n == 1 { format!("{name}.recovered") } else { format!("{name}.recovered-{n}") });
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(fail(format!("No free name for the saved copy of {name}.")))
}

fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn set_mode(file: &File, saved: &SavedPath) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if saved.mode != 0 {
        file.set_permissions(fs::Permissions::from_mode(saved.mode))?;
    }
    Ok(())
}
#[cfg(not(unix))]
fn set_mode(_file: &File, _saved: &SavedPath) -> std::io::Result<()> {
    Ok(())
}

/// Puts the saved content and permissions of `paths` from checkpoint `id` back in place.
///
/// A file still as the operation left it is replaced; its current version is saved in a new
/// checkpoint first. A file changed after the operation (or after an operation whose result was
/// never recorded) is never replaced: the saved copy is written beside it. Each step is logged
/// beside the checkpoint, so a restore the app could not finish can be reviewed after a restart.
pub fn restore_paths(root: &Path, id: &str, paths: &[String]) -> GitResult<RestoreOutcome> {
    let root = fs::canonicalize(repo::discover(root)?)?;
    // The safety checkpoint created below may reach the retention limit; this one must survive it.
    let _pin = super::pin(&root, id);
    let cp = read(&root, id)?;
    let dir = base(&root)?.join(id);
    let record = read_record(&dir);
    let finished = record.as_ref().is_some_and(|r| !matches!(effective_status(id, r).as_str(), "running" | "interrupted"));
    // Preflight everything before writing anything.
    let mut plan: Vec<(usize, &SavedPath, PathBuf, &'static str)> = Vec::new();
    for path in paths {
        let Some((index, saved)) = cp.paths.iter().enumerate().find(|(_, s)| &s.path == path) else {
            return Err(fail(format!("{path} is not in this checkpoint.")));
        };
        if saved.kind != "file" {
            return Err(fail(format!("{path} was not a regular file in this checkpoint.")));
        }
        let stored = dir.join("files").join(index.to_string());
        if Some(digest(&stored)?) != saved.sha256 {
            return Err(fail(format!("The saved copy of {path} is damaged. Nothing was restored.")));
        }
        source_path(&root, path)?;
        let class = classify(saved, &state_of(&root, path), record.as_ref(), finished);
        plan.push((index, saved, stored, class));
    }
    let mut outcome = RestoreOutcome::default();
    let replace: Vec<String> = plan.iter().filter(|p| p.3 == "operation").map(|p| p.1.path.clone()).collect();
    if !replace.is_empty() {
        let label = format!("Before restoring files from {}", cp.summary.label);
        match crate::journal::suspend(|| create_with_ignored(&root, "recovery_restore_files", &label, None, &replace)) {
            Ok(summary) => outcome.checkpoint = Some(summary.id),
            Err(e) if e.kind == "stale-operation" => return Err(e),
            Err(e) => outcome.checkpoint_error = Some(e.message),
        }
    }
    let _lock = lock(&root)?;
    append(
        &dir,
        &RestoreEvent {
            at: crate::journal::now(),
            event: "plan".into(),
            path: None,
            copy: None,
            error: None,
            paths: plan.iter().map(|p| p.1.path.clone()).collect(),
            checkpoint: outcome.checkpoint.clone(),
        },
    )?;
    let event = |kind: &str, path: &str| RestoreEvent {
        at: crate::journal::now(),
        event: kind.into(),
        path: Some(path.to_owned()),
        copy: None,
        error: None,
        paths: Vec::new(),
        checkpoint: None,
    };
    let after = |path: &str| record.as_ref().and_then(|r| r.changed.get(path)).cloned();
    let mut rest = plan.into_iter();
    for (_, saved, stored, class) in rest.by_ref() {
        let destination = source_path(&root, &saved.path)?;
        let now = state_of(&root, &saved.path);
        if matches_saved(saved, &now) {
            outcome.unchanged.push(saved.path.clone());
            append(&dir, &event("unchanged", &saved.path))?;
            continue;
        }
        // Checked again right before writing: the file may have changed since the preflight. A
        // path with nothing in it now loses nothing when the saved copy is put back there.
        let replace =
            now.kind == "missing" || (class == "operation" && outcome.checkpoint.is_some() && after(&saved.path).is_some_and(|a| same_state(&a, &now)));
        let write = || -> GitResult<Option<String>> {
            let parent = destination.parent().ok_or_else(|| fail("Invalid path."))?;
            fs::create_dir_all(parent)?;
            if replace {
                let mut temporary = crate::git::atomic_file::new_in(parent)?;
                std::io::copy(&mut File::open(&stored)?, &mut temporary)?;
                set_mode(temporary.as_file(), saved)?;
                temporary.as_file().sync_all()?;
                crate::git::atomic_file::replace(temporary, &destination)?;
                return Ok(None);
            }
            let (copy, mut file) = beside(&destination)?;
            let written = (|| -> std::io::Result<()> {
                std::io::copy(&mut File::open(&stored)?, &mut file)?;
                set_mode(&file, saved)?;
                file.sync_all()
            })();
            if let Err(e) = written {
                drop(file);
                let _ = fs::remove_file(&copy);
                return Err(e.into());
            }
            Ok(Some(relative_to(&root, &copy)))
        };
        match write() {
            Ok(None) => {
                outcome.restored.push(saved.path.clone());
                append(&dir, &event("restored", &saved.path))?;
            }
            Ok(Some(copy)) => {
                outcome.changed_since.push(saved.path.clone());
                outcome.kept_both.push(KeptBoth { path: saved.path.clone(), copy: copy.clone() });
                append(&dir, &RestoreEvent { copy: Some(copy), ..event("keptBoth", &saved.path) })?;
            }
            Err(e) => {
                let _ = append(&dir, &RestoreEvent { error: Some(e.message.clone()), ..event("failed", &saved.path) });
                outcome.failed = Some((saved.path.clone(), e.message));
                break;
            }
        }
    }
    outcome.not_attempted = rest.map(|p| p.1.path.clone()).collect();
    append(&dir, &RestoreEvent { at: crate::journal::now(), event: "done".into(), path: None, copy: None, error: None, paths: Vec::new(), checkpoint: None })?;
    Ok(outcome)
}
