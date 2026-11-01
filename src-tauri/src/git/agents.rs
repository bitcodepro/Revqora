//! Explicit CLI jobs in newly created worktrees. Worktrees share Git metadata;
//! they are not a security sandbox. Hold the common repository writer queue
//! until the complete process tree stops. Never retry or remove user changes.
use super::{
    operations,
    runner::{GitError, GitResult},
    storage,
    validation::{available, process_tree, Pipe},
    worktree_manager as wm,
};
use fs2::FileExt;
use parking_lot::Mutex;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const OUTPUT_LIMIT: usize = 128 * 1024;
// JSON can expand each raw control byte to six bytes (or invalid UTF-8 to
// three). Two bounded output streams alone can legitimately exceed 1 MiB.
// Every writer and reader uses the same serialized-byte budget.
const RECORD_LIMIT: usize = 4 * 1024 * 1024;
const MAX_TASKS: usize = 100;
fn fail(s: impl Into<String>) -> GitError {
    GitError::new(s).kind("agent-workspace")
}
fn context_error(operation: &str, path: &Path, mut error: GitError) -> GitError {
    let os = error.details.iter().find(|d| d.starts_with("os_error=")).map(String::as_str).unwrap_or("os_error=none");
    // Paths use escaped Debug formatting. Never include the prompt, arguments,
    // environment or Command::Debug in error context.
    error.message = format!("agent::{operation} [path={path:?}; {os}]: {}", error.message);
    error.details.insert(0, format!("operation={operation}; path={path:?}"));
    error
}
fn step<T>(operation: &str, path: &Path, result: GitResult<T>) -> GitResult<T> {
    result.map_err(|e| context_error(operation, path, e))
}
fn io_step<T>(operation: &str, path: &Path, result: std::io::Result<T>) -> GitResult<T> {
    step(operation, path, result.map_err(GitError::from))
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub title: String,
    pub provider: String,
    pub executable: String,
    pub args: Vec<String>,
    pub prompt: String,
    pub base: String,
    #[serde(default)]
    pub worktree_path: Option<String>,
    pub timeout_seconds: u64,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub request: Request,
    pub executable_hash: String,
    pub profile_path: String,
    pub creation: wm::CreationReview,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub provider: String,
    pub repository: String,
    pub path: String,
    pub branch: String,
    pub base_oid: String,
    pub executable: String,
    pub args: Vec<String>,
    pub profile_path: String,
    pub phase: String,
    pub created_at: u64,
    pub elapsed_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}
struct Job {
    task: Mutex<Task>,
    output: Mutex<(Vec<u8>, Vec<u8>)>,
    cancel: AtomicBool,
    done: AtomicBool,
    clock: Instant,
}
fn jobs() -> &'static Mutex<HashMap<PathBuf, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<PathBuf, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}
fn active(phase: &str) -> bool {
    matches!(phase, "queued" | "running" | "stopping")
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn direct(path: &Path) -> GitResult<()> {
    for part in path.ancestors() {
        let m = io_step("path.inspect", part, fs::symlink_metadata(part))?;
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            m.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let linked = m.file_type().is_symlink();
        if linked {
            return Err(fail("Agent storage and executables cannot contain links or junctions. Choose their physical paths."));
        }
    }
    Ok(())
}
fn folder(path: PathBuf) -> GitResult<PathBuf> {
    // Check existing ancestors before creation so a replaced parent cannot redirect writes.
    if let Some(parent) = path.parent() {
        direct(parent)?;
    }
    io_step("directory.create", &path, fs::create_dir_all(&path))?;
    direct(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        io_step("directory.permissions", &path, fs::set_permissions(&path, fs::Permissions::from_mode(0o700)))?;
    }
    Ok(path)
}
fn store(root: &Path) -> GitResult<PathBuf> {
    folder(storage::common(root)?.join("agents"))
}
fn lease(dir: &Path) -> GitResult<File> {
    let p = dir.join("session.lock");
    if p.exists() {
        direct(&p)?;
    }
    let f = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(p)?;
    f.try_lock_exclusive().map_err(|_| fail("An agent session is already active for this repository, possibly in another Revqora window."))?;
    Ok(f)
}
fn profile(provider: &str) -> GitResult<PathBuf> {
    let parent = folder(crate::portable::runtime_dir()?.join("agents"))?;
    let homes = folder(parent.join("profiles"))?;
    let home = folder(homes.join(provider))?;
    for name in ["codex", "claude", "config", "cache", "local", "temp"] {
        folder(home.join(name))?;
    }
    Ok(home)
}
fn executable(request: &Request) -> GitResult<String> {
    if !matches!(request.provider.as_str(), "codex" | "claude" | "custom")
        || request.title.trim().is_empty()
        || request.title.len() > 200
        || request.prompt.trim().is_empty()
        || request.prompt.len() > 32 * 1024
        || request.prompt.contains('\0')
        || request.args.len() > 64
        || request.args.iter().any(|s| s.len() > 8192 || s.contains('\0'))
        || request.args.iter().map(|s| s.len()).sum::<usize>() > 32 * 1024
        || !(1..=14400).contains(&request.timeout_seconds)
    {
        return Err(fail("Enter a title, prompt (up to 32 KiB), valid agent and timeout from 1 to 14400 seconds. Arguments are a bounded JSON string array."));
    }
    let p = Path::new(&request.executable);
    if !p.is_absolute() || !p.is_file() {
        return Err(fail("Choose an absolute path to an installed executable. Nothing is downloaded or launched during review."));
    }
    direct(p)?;
    #[cfg(windows)]
    if p.extension().is_none_or(|s| !s.eq_ignore_ascii_case("exe")) {
        return Err(fail("Select a native .exe. For an npm CLI, select node.exe and put the CLI's absolute .js path first in Arguments; .cmd/.bat wrappers are not executed."));
    }
    let mut file = io_step("executable.open", p, File::open(p))?;
    let mut h = Sha256::new();
    let mut b = [0; 65536];
    loop {
        let n = io_step("executable.read", p, file.read(&mut b))?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub fn prepare(root: &Path, request: Request) -> GitResult<Plan> {
    let hash = executable(&request)?;
    let mut random = [0; 16];
    SystemRandom::new().fill(&mut random).map_err(|_| fail("Cannot generate a unique task ID."))?;
    let id = random.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let dir = store(root)?;
    let worktrees = folder(dir.join("worktrees"))?;
    let creation = wm::creation_review(
        root,
        wm::CreateRequest {
            path: request.worktree_path.clone().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| worktrees.join(&id).to_string_lossy().into_owned()),
            mode: wm::CreateMode::New,
            branch: format!("agent/{id}"),
            start: request.base.clone(),
        },
    )?;
    Ok(Plan { id, profile_path: profile(&request.provider)?.to_string_lossy().into_owned(), request, executable_hash: hash, creation })
}
fn snapshot(job: &Job) -> Task {
    let mut t = job.task.lock().clone();
    let o = job.output.lock();
    t.stdout = String::from_utf8_lossy(&o.0).into_owned();
    t.stderr = String::from_utf8_lossy(&o.1).into_owned();
    if !job.done.load(Ordering::Acquire) {
        t.elapsed_ms = job.clock.elapsed().as_millis() as u64;
    }
    t
}
fn encode_record(t: &Task) -> GitResult<Vec<u8>> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > RECORD_LIMIT.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("Agent history exceeds its serialized byte budget."));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Bounded(Vec::new());
    serde_json::to_writer(&mut output, t).map_err(|e| fail(e.to_string()))?;
    Ok(output.0)
}
fn read_record(path: &Path) -> GitResult<Task> {
    direct(path)?;
    // Bound the actual read as well: metadata can become stale before open/read.
    let mut bytes = Vec::new();
    File::open(path)?.take(RECORD_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > RECORD_LIMIT {
        return Err(fail("An agent record exceeds the serialized history limit."));
    }
    serde_json::from_slice(&bytes).map_err(|e| fail(format!("Cannot read agent history: {e}")))
}
fn save(dir: &Path, t: &Task) -> GitResult<()> {
    // Validate completely before replacing an existing readable record.
    let bytes = step("state.encode", dir, encode_record(t))?;
    direct(dir)?;
    let dest = dir.join(format!("{}.json", t.id));
    if dest.exists() {
        direct(&dest)?;
    }
    let mut f = io_step("state.create_temporary", dir, tempfile::NamedTempFile::new_in(dir))?;
    io_step("state.write", &dest, f.write_all(&bytes))?;
    io_step("state.sync", &dest, f.as_file().sync_all())?;
    io_step("state.persist", &dest, f.persist(&dest).map_err(|e| e.error))?;
    Ok(())
}
pub fn list(root: &Path) -> GitResult<Vec<Task>> {
    let dir = store(root)?;
    let job = jobs().lock().get(&operations::repository_key(root)).cloned();
    let live = job.as_ref().map(|j| snapshot(j));
    // A held lease means another process may still be running. Never claim that
    // a persisted queued/running job was stopped merely because this app restarted.
    let idle = lease(&dir).ok();
    let mut tasks = Vec::new();
    for e in fs::read_dir(&dir)? {
        let e = e?;
        let p = e.path();
        let Some(id) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        if p.extension().is_none_or(|s| s != "json") || !valid_id(id) {
            continue;
        }
        direct(&p)?;
        let mut t = read_record(&p)?;
        if t.id != id {
            return Err(fail("Agent history identity does not match its file."));
        }
        if let Some(l) = live.as_ref().filter(|l| l.id == id) {
            t = l.clone();
        } else if active(&t.phase) {
            t.phase = if idle.is_some() { "interrupted" } else { "external" }.into();
        }
        tasks.push(t);
        if tasks.len() > MAX_TASKS {
            return Err(fail("Agent history exceeds 100 tasks. Remove finished records before starting another."));
        }
    }
    tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    Ok(tasks)
}
pub fn start(root: PathBuf, plan: Plan, consent: bool) -> GitResult<Task> {
    if !consent || !valid_id(&plan.id) {
        return Err(fail("Review the agent command and explicitly allow this task to access code and its configured service."));
    }
    if executable(&plan.request)? != plan.executable_hash || profile(&plan.request.provider)?.to_string_lossy() != plan.profile_path {
        return Err(fail("The executable or portable profile changed. Prepare another review."));
    }
    let dir = store(&root)?;
    let session = lease(&dir)?;
    let history = list(&root)?;
    if history.iter().any(|t| active(&t.phase) || matches!(t.phase.as_str(), "external" | "interrupted")) {
        return Err(fail("A previous task has no confirmed stop. Inspect its process and acknowledge it before starting another agent."));
    }
    if history.len() >= MAX_TASKS {
        return Err(fail("Keep at most 100 tasks. Forget a finished history record first; its worktree will be kept."));
    }
    let expected_path = plan
        .request
        .worktree_path
        .clone()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| dir.join("worktrees").join(&plan.id).to_string_lossy().into_owned());
    if plan.creation.request.path != expected_path
        || plan.creation.request.branch != format!("agent/{}", plan.id)
        || plan.creation.request.mode != wm::CreateMode::New
        || plan.creation.request.start != plan.request.base
        || plan.creation.state_token.is_empty()
    {
        return Err(fail("The task worktree does not match the reviewed plan."));
    }
    let record = dir.join(format!("{}.json", plan.id));
    let t = Task {
        id: plan.id.clone(),
        title: plan.request.title.clone(),
        prompt: plan.request.prompt.clone(),
        provider: plan.request.provider.clone(),
        repository: root.to_string_lossy().into_owned(),
        path: plan.creation.path.clone(),
        branch: plan.creation.request.branch.clone(),
        base_oid: plan.creation.start_oid.clone(),
        executable: plan.request.executable.clone(),
        args: plan.request.args.clone(),
        profile_path: plan.profile_path.clone(),
        phase: "queued".into(),
        created_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        elapsed_ms: 0,
        stdout: String::new(),
        stderr: String::new(),
        truncated: false,
        exit_code: None,
        error: None,
    };
    // Atomically publish a complete, durable no-retry marker before touching Git.
    let mut initial = io_step("state.create_initial", &record, tempfile::NamedTempFile::new_in(&dir))?;
    io_step("state.write_initial", &record, initial.write_all(&encode_record(&t)?))?;
    io_step("state.sync_initial", &record, initial.as_file().sync_all())?;
    initial.persist_noclobber(&record).map_err(|e| context_error("state.publish_initial", &record, GitError::from(e.error)))?;
    let job = Arc::new(Job {
        task: Mutex::new(t.clone()),
        output: Mutex::new((vec![], vec![])),
        cancel: AtomicBool::new(false),
        done: AtomicBool::new(false),
        clock: Instant::now(),
    });
    jobs().lock().insert(operations::repository_key(&root), job.clone());
    thread::spawn(move || {
        let log = crate::journal::begin(&root, "agent_start");
        let outcome = operations::run(
            &root,
            "agent_start",
            Some(&plan.creation.state_token),
            |phase, _| {
                if let Some(l) = &log {
                    l.phase(phase, &root);
                }
            },
            || {
                if job.cancel.load(Ordering::Acquire) {
                    job.task.lock().phase = "cancelled".into();
                    return Ok(());
                }
                if step("executable.verify", Path::new(&plan.request.executable), executable(&plan.request))? != plan.executable_hash {
                    return Err(fail("The reviewed executable changed before launch."));
                }
                let created = step("worktree.create", Path::new(&plan.creation.path), wm::create(&root, &plan.creation))?;
                if let Some(warning) = created.warning {
                    return Err(context_error("worktree.verify_head", Path::new(&created.path), fail(warning)));
                }
                let inventory = step("worktree.inspect", Path::new(&created.path), wm::snapshot(&root))?;
                step(
                    "worktree.lock",
                    Path::new(&created.path),
                    wm::lock(
                        &root,
                        &created.path,
                        &inventory.registry_token,
                        true,
                        &format!("Agent task {} — unlock in Worktree Manager after review", plan.id),
                    ),
                )?;
                job.task.lock().phase = "running".into();
                step("state.save_running", &record, save(&dir, &snapshot(&job)))?;
                execute(&plan, &job, &dir)
            },
        )
        .map_err(|e| context_error("repository.transaction", &root, e));
        {
            let mut t = job.task.lock();
            if let Err(e) = &outcome {
                t.phase = "failed".into();
                t.error = Some(e.message.clone());
            }
            if active(&t.phase) {
                t.phase = "failed".into();
            }
            t.elapsed_ms = job.clock.elapsed().as_millis() as u64;
        }
        if let Some(l) = log {
            l.after(&root);
            let result = outcome.and_then(|_| {
                if job.task.lock().phase == "completed" {
                    Ok(())
                } else {
                    Err(fail("Agent did not complete successfully; inspect the task log."))
                }
            });
            l.finish(&result);
        }
        if let Err(e) = save(&dir, &snapshot(&job)) {
            let message = context_error("state.save_final", &record, e).message;
            let mut task = job.task.lock();
            task.error = Some(match task.error.take() {
                Some(primary) => format!("{primary}\nFinal state persistence also failed: {message}"),
                None => message,
            });
        }
        drop(session);
        job.done.store(true, Ordering::Release);
    });
    Ok(t)
}
pub fn stop(root: &Path, id: &str) -> GitResult<()> {
    let job = jobs()
        .lock()
        .get(&operations::repository_key(root))
        .cloned()
        .ok_or_else(|| fail("No task is running in this app. A task in another window must be stopped there."))?;
    let mut task = job.task.lock();
    if task.id != id || !active(&task.phase) || job.done.load(Ordering::Acquire) {
        return Err(fail("The running task changed. Refresh before stopping."));
    }
    job.cancel.store(true, Ordering::Release);
    task.phase = "stopping".into();
    Ok(())
}
pub fn forget(root: &Path, id: &str) -> GitResult<()> {
    if !valid_id(id) {
        return Err(fail("Invalid task ID."));
    }
    let dir = store(root)?;
    let _lease = lease(&dir)?;
    if list(root)?.iter().any(|t| t.id == id && (active(&t.phase) || matches!(t.phase.as_str(), "external" | "interrupted"))) {
        return Err(fail("Confirm that this interrupted process has stopped before forgetting its history."));
    }
    let path = dir.join(format!("{id}.json"));
    direct(&path)?;
    fs::remove_file(path)?;
    Ok(())
}
pub fn acknowledge(root: &Path, id: &str, stopped: bool) -> GitResult<()> {
    if !stopped || !valid_id(id) {
        return Err(fail("Explicitly confirm that the interrupted task's processes have stopped."));
    }
    let dir = store(root)?;
    let _lease = lease(&dir)?;
    let mut task = list(root)?.into_iter().find(|t| t.id == id).ok_or_else(|| fail("Task not found."))?;
    // list reports external while our lease is held; only a persisted active
    // record with no in-process owner can be acknowledged.
    if jobs().lock().get(&operations::repository_key(root)).is_some_and(|j| j.task.lock().id == id && !j.done.load(Ordering::Acquire))
        || !matches!(task.phase.as_str(), "external" | "interrupted")
    {
        return Err(fail("This task is not an abandoned session. Refresh its actual status."));
    }
    task.phase = "abandoned".into();
    task.error = Some("Completion is unknown. The user confirmed that the interrupted task's processes have stopped; changes were kept.".into());
    save(&dir, &task)
}
pub fn cancel_all() {
    let all: Vec<_> = jobs().lock().values().cloned().collect();
    for j in &all {
        j.cancel.store(true, Ordering::Release);
    }
    let until = Instant::now() + Duration::from_secs(2);
    while all.iter().any(|j| !j.done.load(Ordering::Acquire)) && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
}
fn reader(mut pipe: impl Pipe, job: Arc<Job>, stderr: bool, stop: Arc<AtomicBool>) -> thread::JoinHandle<()> {
    thread::spawn(move || collect_output(&mut pipe, available, &job, stderr, &stop))
}
fn collect_output<R: Read>(pipe: &mut R, mut ready: impl FnMut(&R) -> std::io::Result<bool>, job: &Job, stderr: bool, stop: &AtomicBool) {
    let mut b = [0; 8192];
    let mut drained = 0;
    loop {
        let ending = stop.load(Ordering::Acquire);
        if ending && drained > OUTPUT_LIMIT {
            break;
        }
        match ready(pipe) {
            Ok(true) => {}
            Ok(false) => {
                if ending {
                    break;
                }
                thread::sleep(Duration::from_millis(15));
                continue;
            }
            Err(_) => break,
        }
        match pipe.read(&mut b) {
            Ok(0) => break,
            Ok(n) => {
                if ending {
                    drained += n;
                }
                let kept = {
                    let mut o = job.output.lock();
                    let v = if stderr { &mut o.1 } else { &mut o.0 };
                    let n = n.min(OUTPUT_LIMIT.saturating_sub(v.len()));
                    v.extend_from_slice(&b[..n]);
                    n
                };
                if kept < n {
                    job.task.lock().truncated = true;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // A detached descendant can keep the write end open forever.
                // Drain only bytes already queued; never wait for its EOF.
                if ending {
                    break;
                }
                thread::sleep(Duration::from_millis(15));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}
fn execute(plan: &Plan, job: &Arc<Job>, dir: &Path) -> GitResult<()> {
    let home = Path::new(&plan.profile_path);
    let temp = folder(home.join("temp"))?;
    let codex = folder(home.join("codex"))?;
    let claude = folder(home.join("claude"))?;
    let config = folder(home.join("config"))?;
    let cache = folder(home.join("cache"))?;
    let data = folder(home.join("local"))?;
    // File-backed stdin cannot block the launcher if the CLI ignores its input,
    // or leave an input-writer thread behind an escaped Unix descendant.
    let mut input = io_step("stdin.create", &temp, tempfile::NamedTempFile::new_in(&temp))?;
    let input_path = input.path().to_owned();
    let prompt=format!("Work only in this task's working directory. Leave changes uncommitted for human review. Do not commit, push, merge, change refs or delete worktrees.\n\n{}",plan.request.prompt);
    io_step("stdin.write", &input_path, input.write_all(prompt.as_bytes()))?;
    io_step("stdin.flush", &input_path, input.flush())?;
    io_step("stdin.rewind", &input_path, input.rewind())?;
    let mut cmd = Command::new(&plan.request.executable);
    cmd.args(&plan.request.args)
        .current_dir(&plan.creation.path)
        .stdin(Stdio::from(io_step("stdin.clone_handle", &input_path, input.as_file().try_clone())?))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("CODEX_HOME", codex)
        .env("CLAUDE_CONFIG_DIR", claude)
        .env("XDG_CONFIG_HOME", &config)
        .env("XDG_CACHE_HOME", cache)
        .env("XDG_DATA_HOME", &data)
        .env("APPDATA", config)
        .env("LOCALAPPDATA", data)
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env("TMPDIR", temp)
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("GIT_TERMINAL_PROMPT", "0");
    // Do not inherit repository redirects or Revqora's interactive askpass IPC.
    for (name, _) in std::env::vars_os() {
        let key = name.to_string_lossy();
        if key.starts_with("GIT_") && key != "GIT_TERMINAL_PROMPT" || key.starts_with("REVQORA_") {
            cmd.env_remove(name);
        }
    }
    let worktree = Path::new(&plan.creation.path);
    let (mut child, tree) = step("process.spawn", worktree, process_tree::spawn(&mut cmd))?;
    let end = Arc::new(AtomicBool::new(false));
    let out = reader(child.stdout.take().unwrap(), job.clone(), false, end.clone());
    let err = reader(child.stderr.take().unwrap(), job.clone(), true, end.clone());
    let started = Instant::now();
    let mut saved = Instant::now();
    let outcome = (|| -> GitResult<()> {
        loop {
            if job.cancel.load(Ordering::Acquire) || started.elapsed().as_secs() >= plan.request.timeout_seconds {
                job.task.lock().phase = if job.cancel.load(Ordering::Acquire) { "cancelled" } else { "timed-out" }.into();
                break;
            }
            if io_step("process.poll", worktree, process_tree::exited(&mut child))? {
                tree.terminate();
                let status = io_step("process.wait", worktree, child.wait())?;
                let mut t = job.task.lock();
                t.exit_code = status.code();
                t.phase = if status.success() { "completed" } else { "failed" }.into();
                break;
            }
            if saved.elapsed() > Duration::from_secs(1) {
                step("state.save_periodic", &dir.join(format!("{}.json", plan.id)), save(dir, &snapshot(job)))?;
                saved = Instant::now();
            }
            thread::sleep(Duration::from_millis(35));
        }
        Ok(())
    })();
    tree.terminate();
    let cleanup = io_step("process.wait_after_terminate", worktree, child.wait()).map(|_| ());
    end.store(true, Ordering::Release);
    let _ = out.join();
    let _ = err.join();
    match (outcome, cleanup) {
        (Err(mut primary), Err(secondary)) => {
            primary.message.push_str(&format!("\nCleanup also failed: {}", secondary.message));
            Err(primary)
        }
        (Err(primary), _) => Err(primary),
        (Ok(()), result) => result,
    }
}

#[cfg(test)]
#[path = "agents_tests.rs"]
mod tests;
