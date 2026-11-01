//! Saved, explicitly reviewed workflows. Each step has a durable no-replay marker.
//! No automatic rollback, retry, merge or resumption after an uncertain result.
use super::session_lease::SessionLease;
use super::{
    operations,
    runner::{GitError, GitResult},
    storage, validation,
};
use parking_lot::Mutex;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
mod actions;
use actions::{build_review, execute_action};
const LIMIT: usize = 8 * 1024 * 1024;
pub(super) fn fail(s: impl Into<String>) -> GitError {
    GitError::new(s).kind("workflow")
}
fn stale() -> GitError {
    GitError::new("The workflow, reviewed step or repository changed. Refresh and review again; this action was not replayed.").kind("stale-operation")
}
pub(super) fn digest<T: Serialize>(v: &T) -> GitResult<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(v).map_err(|e| fail(e.to_string()))?)))
}
fn id() -> GitResult<String> {
    let mut b = [0; 16];
    SystemRandom::new().fill(&mut b).map_err(|_| fail("Cannot generate a workflow ID."))?;
    Ok(b.iter().map(|v| format!("{v:02x}")).collect())
}
fn valid_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
pub(super) fn direct(path: &Path) -> GitResult<()> {
    for p in path.ancestors() {
        let m = fs::symlink_metadata(p)?;
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            m.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let linked = m.file_type().is_symlink();
        if linked {
            return Err(fail("Workflow storage cannot contain links or junctions."));
        }
    }
    Ok(())
}
fn dir(root: &Path) -> GitResult<PathBuf> {
    let d = storage::common(root)?.join("workflows");
    direct(d.parent().unwrap())?;
    fs::create_dir_all(&d)?;
    direct(&d)?;
    Ok(d)
}
fn lock(dir: &Path, name: &str) -> GitResult<SessionLease> {
    let p = dir.join(name);
    match fs::symlink_metadata(&p) {
        Ok(_) => direct(&p)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let f = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&p)?;
    SessionLease::acquire(f).map_err(|e| {
        let mut error = GitError::from(e).kind("workflow");
        error.message = format!("Cannot acquire workflow lease [path={p:?}]: {}. Another request or window may still be active.", error.message);
        error
    })
}
fn read<T: serde::de::DeserializeOwned>(path: &Path) -> GitResult<T> {
    direct(path)?;
    let mut b = Vec::new();
    File::open(path)?.take(LIMIT as u64 + 1).read_to_end(&mut b)?;
    if b.len() > LIMIT {
        return Err(fail("Workflow data exceeds the 8 MiB serialized limit."));
    }
    serde_json::from_slice(&b).map_err(|e| fail(format!("Cannot read workflow data: {e}")))
}
fn write<T: Serialize>(path: &Path, value: &T) -> GitResult<()> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            if b.len() > LIMIT.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("Workflow serialized limit exceeded"));
            }
            self.0.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut b = Bounded(vec![]);
    serde_json::to_writer(&mut b, value).map_err(|e| fail(e.to_string()))?;
    let parent = path.parent().unwrap();
    direct(parent)?;
    if path.exists() {
        direct(path)?;
    }
    let mut f = super::atomic_file::new_in(parent)?;
    f.write_all(&b.0)?;
    f.as_file().sync_all()?;
    super::atomic_file::replace(f, path).map_err(|e| {
        let mut error = GitError::from(e);
        error.message = format!("workflow::state.replace [path={path:?}]: {}", error.message);
        error
    })?;
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub kind: String,
    pub label: String,
    pub value: String,
    pub extra: String,
    pub body: String,
    pub timeout_seconds: u64,
    pub when: String,
    pub on_false: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    pub id: String,
    pub name: String,
    pub steps: Vec<Step>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub revision: String,
    pub definitions: Vec<Definition>,
}
fn validate(d: &Definition) -> GitResult<()> {
    if !valid_id(&d.id) || d.name.trim().is_empty() || d.name.len() > 200 || d.steps.is_empty() || d.steps.len() > 16 {
        return Err(fail("Name a workflow and include between 1 and 16 steps."));
    }
    for s in &d.steps {
        if !matches!(s.kind.as_str(), "checkClean" | "checkBranch" | "branch" | "cherryPick" | "command" | "publish" | "pr")
            || !matches!(s.when.as_str(), "always" | "clean" | "dirty")
            || !matches!(s.on_false.as_str(), "stop" | "skip")
            || s.label.len() > 200
            || s.value.len() > 8192
            || s.extra.len() > 1024
            || s.body.len() > 16384
            || s.value.contains('\0')
            || s.extra.contains('\0')
            || s.body.contains('\0')
            || !(1..=1800).contains(&s.timeout_seconds)
        {
            return Err(fail("Invalid step type, condition or fields. Commands: 8 KiB; descriptions: 16 KiB; timeout: 1–1800 seconds."));
        }
    }
    Ok(())
}
pub fn catalog(root: &Path) -> GitResult<Catalog> {
    let p = dir(root)?.join("definitions.json");
    let definitions: Vec<Definition> = if p.exists() { read(&p)? } else { vec![] };
    if definitions.len() > 50 {
        return Err(fail("Too many workflow definitions."));
    }
    for d in &definitions {
        validate(d)?;
    }
    Ok(Catalog { revision: digest(&definitions)?, definitions })
}
pub fn save_definition(root: &Path, mut definition: Definition, expected: &str) -> GitResult<Catalog> {
    let d = dir(root)?;
    let _lock = lock(&d, "definitions.lock")?;
    let mut c = catalog(root)?;
    if c.revision != expected {
        return Err(stale());
    }
    if definition.id.is_empty() {
        definition.id = id()?;
    }
    validate(&definition)?;
    if let Some(old) = c.definitions.iter_mut().find(|v| v.id == definition.id) {
        *old = definition;
    } else {
        if c.definitions.len() >= 50 {
            return Err(fail("Keep at most 50 workflow definitions. Remove one explicitly first."));
        }
        c.definitions.push(definition);
    }
    write(&d.join("definitions.json"), &c.definitions)?;
    catalog(root)
}
pub fn delete_definition(root: &Path, id: &str, expected: &str) -> GitResult<Catalog> {
    let d = dir(root)?;
    let _lock = lock(&d, "definitions.lock")?;
    let mut c = catalog(root)?;
    if c.revision != expected {
        return Err(stale());
    }
    c.definitions.retain(|v| v.id != id);
    write(&d.join("definitions.json"), &c.definitions)?;
    catalog(root)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameters {
    pub branch: String,
    pub base: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultRow {
    pub phase: String,
    pub message: String,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub exit_code: Option<i32>,
}
impl ResultRow {
    fn pending() -> Self {
        Self { phase: "pending".into(), message: String::new(), stdout: String::new(), stderr: String::new(), truncated: false, exit_code: None }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub repository: String,
    pub definition: Definition,
    pub parameters: Parameters,
    pub phase: String,
    pub cursor: usize,
    pub created_at: u64,
    pub results: Vec<ResultRow>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub phase: String,
    pub cursor: usize,
    pub total: usize,
    pub created_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub run_id: String,
    pub cursor: usize,
    pub run_revision: String,
    pub state_token: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub step: Step,
    pub resolved: Vec<String>,
    pub connection: String,
    pub remote_fingerprint: String,
    pub remote_head: Option<String>,
    pub skip: bool,
    pub condition_met: bool,
    pub consent_required: bool,
    pub explanation: String,
}
struct Job {
    run: Mutex<Run>,
    cancel: AtomicBool,
    finished: AtomicBool,
}
fn jobs() -> &'static Mutex<HashMap<PathBuf, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<PathBuf, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}
fn path(root: &Path, id: &str) -> GitResult<PathBuf> {
    if !valid_id(id) {
        return Err(fail("Invalid workflow run ID."));
    }
    Ok(dir(root)?.join(format!("run-{id}.json")))
}
fn ensure_finished(root: &Path) -> GitResult<()> {
    if jobs().lock().get(&operations::repository_key(root)).is_some_and(|j| !j.finished.load(Ordering::Acquire)) {
        return Err(fail("The previous workflow step is still finishing. Refresh its result before continuing."));
    }
    Ok(())
}
fn active(s: &str) -> bool {
    matches!(s, "ready" | "running" | "stopping" | "interrupted" | "external" | "uncertain")
}
pub fn get(root: &Path, id: &str) -> GitResult<Run> {
    let p = path(root, id)?;
    let mut r: Run = read(&p)?;
    validate(&r.definition)?;
    if r.id != id || r.results.len() != r.definition.steps.len() || r.cursor > r.results.len() || r.phase == "ready" && r.cursor == r.results.len() {
        return Err(fail("Workflow record identity or progress is invalid."));
    }
    if let Some(job) = jobs().lock().get(&operations::repository_key(root)).filter(|j| j.run.lock().id == id) {
        let mut live = job.run.lock().clone();
        if !job.finished.load(Ordering::Acquire) {
            live.phase = if job.cancel.load(Ordering::Acquire) { "stopping" } else { "running" }.into();
        }
        return Ok(live);
    }
    if matches!(r.phase.as_str(), "running" | "stopping") {
        // The worker may have persisted completion and removed its live entry
        // since our first file read. Never label that old snapshot interrupted.
        let lease = lock(p.parent().unwrap(), "run.lock");
        r = settled_record(&p, r, lease.is_ok())?;
    }
    Ok(r)
}
fn settled_record(path: &Path, old: Run, free: bool) -> GitResult<Run> {
    let mut current: Run = read(path)?;
    if current.id != old.id {
        return Err(fail("Workflow identity changed while reading progress."));
    }
    if matches!(current.phase.as_str(), "running" | "stopping") {
        current.phase = if free { "interrupted" } else { "external" }.into();
    }
    Ok(current)
}
pub fn runs(root: &Path) -> GitResult<Vec<Summary>> {
    let mut rows = vec![];
    for e in fs::read_dir(dir(root)?)? {
        let p = e?.path();
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        let Some(id) = name.strip_prefix("run-").and_then(|s| s.strip_suffix(".json")) else { continue };
        if !valid_id(id) {
            continue;
        }
        let r = get(root, id)?;
        rows.push(Summary { id: r.id, name: r.definition.name, phase: r.phase, cursor: r.cursor, total: r.results.len(), created_at: r.created_at });
        if rows.len() > 50 {
            return Err(fail("Workflow history exceeds 50 runs."));
        }
    }
    rows.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(rows)
}
pub fn begin(root: &Path, definition_id: &str, expected: &str, parameters: Parameters) -> GitResult<Run> {
    let d = dir(root)?;
    let _lock = lock(&d, "run.lock")?;
    ensure_finished(root)?;
    let existing = runs(root)?;
    if existing.iter().any(|r| active(&r.phase)) {
        return Err(fail("Finish, stop or acknowledge the existing workflow before starting another."));
    }
    if existing.len() >= 50 {
        return Err(fail("Forget an old completed workflow before creating another (50 runs)."));
    }
    let c = catalog(root)?;
    if c.revision != expected {
        return Err(stale());
    }
    let definition = c.definitions.into_iter().find(|d| d.id == definition_id).ok_or_else(|| fail("Workflow definition not found."))?;
    validate(&definition)?;
    if parameters.branch.len() > 1024 || parameters.base.len() > 1024 || parameters.branch.contains('\0') || parameters.base.contains('\0') {
        return Err(fail("Invalid workflow parameters."));
    }
    let r = Run {
        id: id()?,
        repository: fs::canonicalize(root)?.to_string_lossy().into_owned(),
        results: definition.steps.iter().map(|_| ResultRow::pending()).collect(),
        definition,
        parameters,
        phase: "ready".into(),
        cursor: 0,
        created_at: now(),
        error: None,
    };
    write(&path(root, &r.id)?, &r)?;
    Ok(r)
}
pub fn review(root: &Path, id: &str) -> GitResult<Review> {
    let r = get(root, id)?;
    if r.phase != "ready" {
        return Err(fail("Only a waiting step can be reviewed. Running, failed and unknown actions are never replayed."));
    }
    if fs::canonicalize(root)?.to_string_lossy() != r.repository {
        return Err(fail("Open the workflow's original working directory before continuing."));
    }
    build_review(root, &r)
}
pub fn execute(root: PathBuf, prepared: Review, consent: bool) -> GitResult<Run> {
    let p = path(&root, &prepared.run_id)?;
    let lease = lock(p.parent().unwrap(), "run.lock")?;
    ensure_finished(&root)?;
    let mut r = get(&root, &prepared.run_id)?;
    if fs::canonicalize(&root)?.to_string_lossy() != r.repository {
        return Err(fail("Open the original workflow working directory."));
    }
    if r.phase != "ready" || digest(&r)? != prepared.run_revision || prepared.consent_required && !consent {
        return Err(stale());
    }
    // Consume the reviewed step durably before dispatch. Lost IPC responses and
    // app restarts cannot turn a running action back into an executable review.
    r.phase = "running".into();
    r.results[r.cursor].phase = "running".into();
    write(&p, &r)?;
    let job = Arc::new(Job { run: Mutex::new(r.clone()), cancel: AtomicBool::new(false), finished: AtomicBool::new(false) });
    jobs().lock().insert(operations::repository_key(&root), job.clone());
    let initial = r.clone();
    let key = operations::repository_key(&root);
    let spawned = thread::Builder::new().name("revqora-workflow".into()).spawn(move || {
        let log = crate::journal::begin(&root, "workflow_step");
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute_action(&root, &r, &prepared, &job)))
            .unwrap_or_else(|_| Err(fail("Workflow worker stopped unexpectedly. Check Git/server state before another run.").kind("workflow-write-uncertain")));
        {
            let mut state = job.run.lock();
            let index = state.cursor;
            match &outcome {
                Ok(result) => {
                    state.results[index] = result.clone();
                    state.cursor += 1;
                    state.phase = if job.cancel.load(Ordering::Acquire) {
                        "cancelled"
                    } else if state.cursor == state.results.len() {
                        "completed"
                    } else {
                        "ready"
                    }
                    .into();
                }
                Err(error) => {
                    let remote = matches!(error.kind.as_str(), "workflow-write-uncertain" | "forge-write-uncertain");
                    state.phase = if remote {
                        "uncertain"
                    } else if job.cancel.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    state.results[index].phase = state.phase.clone();
                    state.results[index].message = error.message.clone();
                    state.error = Some(error.message.clone());
                }
            }
        }
        if let Some(log) = log {
            log.after(&root);
            log.finish(&outcome.map(|_| ()));
        }
        let final_state = job.run.lock().clone();
        let saved = write(&p, &final_state);
        if let Err(error) = &saved {
            let mut state = job.run.lock();
            state.phase = "uncertain".into();
            state.error = Some(format!("Could not persist the step result: {}. Inspect Git/server state before another workflow.", error.message));
        }
        let released = lease.release();
        if let Err(error) = &released {
            let mut state = job.run.lock();
            state.phase = "uncertain".into();
            let message = format!(
                "Could not release workflow lease [path={:?}]: {error}. Inspect the result before another workflow.",
                p.parent().unwrap().join("run.lock")
            );
            state.error = Some(match state.error.take() {
                Some(old) => format!("{old}\n{message}"),
                None => message,
            });
            drop(state);
            let _ = write(&p, &job.run.lock().clone());
        }
        job.finished.store(true, Ordering::Release);
        if saved.is_ok() && released.is_ok() {
            let mut all = jobs().lock();
            let key = operations::repository_key(&root);
            if all.get(&key).is_some_and(|current| Arc::ptr_eq(current, &job)) {
                all.remove(&key);
            }
        }
    });
    if let Err(error) = spawned {
        jobs().lock().remove(&key);
        return Err(fail(format!("Could not start workflow worker: {error}. Inspect the interrupted run before continuing.")));
    }
    Ok(initial)
}
pub fn stop(root: &Path, id: &str) -> GitResult<Run> {
    let job = jobs().lock().get(&operations::repository_key(root)).cloned();
    if let Some(job) = job.filter(|j| j.run.lock().id == id && !j.finished.load(Ordering::Acquire)) {
        let mut r = job.run.lock();
        if !matches!(r.phase.as_str(), "running" | "stopping") {
            return Err(fail("The step is finishing. Refresh before stopping the waiting run; no later step runs automatically."));
        }
        job.cancel.store(true, Ordering::Release);
        r.phase = "stopping".into();
        return Ok(r.clone());
    }
    let p = path(root, id)?;
    let _lease = lock(p.parent().unwrap(), "run.lock")?;
    ensure_finished(root)?;
    let mut r = get(root, id)?;
    if r.phase != "ready" {
        return Err(fail("This run is not waiting. Inspect an unknown result instead of replaying it."));
    }
    r.phase = "cancelled".into();
    write(&p, &r)?;
    Ok(r)
}
pub fn acknowledge(root: &Path, id: &str, checked: bool) -> GitResult<Run> {
    if !checked {
        return Err(fail("Confirm that processes stopped and any Git/server result was checked."));
    }
    let p = path(root, id)?;
    let _lease = lock(p.parent().unwrap(), "run.lock")?;
    let mut r = get(root, id)?;
    if !matches!(r.phase.as_str(), "interrupted" | "external" | "uncertain") {
        return Err(fail("Only an interrupted or unknown result can be acknowledged."));
    }
    r.phase = "abandoned".into();
    r.error = Some("Result was checked manually. No step was replayed or marked successful.".into());
    write(&p, &r)?;
    jobs().lock().remove(&operations::repository_key(root));
    Ok(r)
}
pub fn forget(root: &Path, id: &str) -> GitResult<()> {
    let p = path(root, id)?;
    let _lease = lock(p.parent().unwrap(), "run.lock")?;
    if active(&get(root, id)?.phase) {
        return Err(fail("Stop or acknowledge this workflow before forgetting its record."));
    }
    fs::remove_file(p)?;
    Ok(())
}
pub fn cancel_all() {
    let all: Vec<_> = jobs().lock().values().cloned().collect();
    for j in &all {
        j.cancel.store(true, Ordering::Release);
    }
    let end = std::time::Instant::now() + Duration::from_secs(2);
    while all.iter().any(|j| !j.finished.load(Ordering::Acquire)) && std::time::Instant::now() < end {
        thread::sleep(Duration::from_millis(20));
    }
}
pub(super) fn clip(s: &str) -> (String, bool) {
    let mut end = s.len().min(8192);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_owned(), end < s.len())
}
#[cfg(test)]
#[path = "workflows_tests.rs"]
mod tests;
