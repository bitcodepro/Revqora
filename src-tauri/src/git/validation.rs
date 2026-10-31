//! Explicit, cancellable user checks. Never auto-execute repository configuration.
use super::{
    operations,
    runner::{GitError, GitResult},
    status,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 128 * 1024;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub repository_root: String,
    pub command: String,
    pub phase: String,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub before_state: Option<String>,
    pub after_state: Option<String>,
    pub error: Option<String>,
}
struct Job {
    report: Mutex<Report>,
    output: Mutex<(Vec<u8>, Vec<u8>)>,
    cancel: AtomicBool,
    finished: AtomicBool,
    started: Instant,
}
fn jobs() -> &'static Mutex<HashMap<PathBuf, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<PathBuf, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}
fn active(phase: &str) -> bool {
    matches!(phase, "queued" | "running")
}
fn snapshot(job: &Job) -> Report {
    let mut r = job.report.lock().clone();
    let out = job.output.lock();
    r.stdout = String::from_utf8_lossy(&out.0).into_owned();
    r.stderr = String::from_utf8_lossy(&out.1).into_owned();
    if !job.finished.load(Ordering::Acquire) {
        r.elapsed_ms = job.started.elapsed().as_millis() as u64;
        if !active(&r.phase) {
            r.phase = "running".into();
        }
    }
    r
}
pub fn report(root: &Path) -> Option<Report> {
    jobs().lock().get(&operations::repository_key(root)).map(|j| snapshot(j))
}
pub fn cancel(root: &Path, id: &str) -> GitResult<()> {
    let all = jobs().lock();
    let job = all.get(&operations::repository_key(root)).ok_or_else(|| GitError::new("No check is running."))?;
    if job.report.lock().id != id {
        return Err(GitError::new("The check changed. Refresh before cancelling."));
    }
    job.cancel.store(true, Ordering::Release);
    Ok(())
}
pub fn cancel_all() {
    let all: Vec<_> = jobs().lock().values().cloned().collect();
    for job in &all {
        job.cancel.store(true, Ordering::Release);
    }
    // Give active workers time to terminate their process groups before normal app exit.
    let deadline = Instant::now() + Duration::from_secs(2);
    while all.iter().any(|j| !j.finished.load(Ordering::Acquire)) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
}

pub fn start(root: PathBuf, command: String, expected: String, timeout_seconds: u64) -> GitResult<Report> {
    if command.trim().is_empty() || command.len() > 8192 || command.contains('\0') || expected.is_empty() || !(1..=1800).contains(&timeout_seconds) {
        return Err(GitError::new("Enter a command, a current repository state and a timeout between 1 and 1800 seconds."));
    }
    if !root.is_absolute() || !root.is_dir() {
        return Err(GitError::new("The check needs an existing absolute repository path."));
    }
    static IDS: AtomicU64 = AtomicU64::new(0);
    let job = Arc::new(Job {
        report: Mutex::new(Report {
            id: format!("check-{}", IDS.fetch_add(1, Ordering::Relaxed)),
            repository_root: root.to_string_lossy().into_owned(),
            command: command.clone(),
            phase: "queued".into(),
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
            exit_code: None,
            elapsed_ms: 0,
            before_state: None,
            after_state: None,
            error: None,
        }),
        output: Mutex::new((Vec::new(), Vec::new())),
        cancel: AtomicBool::new(false),
        finished: AtomicBool::new(false),
        started: Instant::now(),
    });
    {
        let mut all = jobs().lock();
        let key = operations::repository_key(&root);
        if all.get(&key).is_some_and(|j| !j.finished.load(Ordering::Acquire)) {
            return Err(GitError::new("A check is already queued or running for this repository or a linked worktree."));
        }
        // Keep one result per repository, with a bound for long-lived app sessions.
        if all.len() >= 64 {
            all.retain(|_, j| !j.finished.load(Ordering::Acquire));
        }
        all.insert(key, job.clone());
    }
    let initial = snapshot(&job);
    thread::spawn(move || {
        let log = crate::journal::begin(&root, "conflict_validation");
        let result = operations::run(
            &root,
            "conflict_validation",
            Some(&expected),
            |phase, _| {
                if let Some(log) = &log {
                    log.phase(phase, &root);
                }
            },
            || {
                if job.cancel.load(Ordering::Acquire) {
                    job.report.lock().phase = "cancelled".into();
                    return Ok(());
                }
                job.report.lock().before_state = status::status(&root)?.state_token;
                job.report.lock().phase = "running".into();
                let outcome = execute(&root, &command, Duration::from_secs(timeout_seconds), &job);
                // Capture state even on spawn/read/wait failure; a check may have changed files.
                job.report.lock().after_state = status::status(&root)?.state_token;
                outcome
            },
        );
        if let Some(log) = log {
            log.after(&root);
            let phase = job.report.lock().phase.clone();
            let logged = match &result {
                Err(e) => Err(GitError::new(&e.message).kind(&e.kind)),
                Ok(()) if phase == "passed" => Ok(()),
                Ok(()) => Err(GitError::new(format!("Validation {phase}; exit code {:?}.", job.report.lock().exit_code)).kind("validation-result")),
            };
            log.finish(&logged);
        }
        let mut r = job.report.lock();
        if let Err(e) = result {
            r.error = Some(e.message);
            r.phase = "failed".into();
        }
        if active(&r.phase) {
            r.phase = "failed".into();
            r.error = Some("The check ended without an exit status.".into());
        }
        r.elapsed_ms = job.started.elapsed().as_millis() as u64;
        job.finished.store(true, Ordering::Release);
    });
    Ok(initial)
}

fn execute(root: &Path, command: &str, timeout: Duration, job: &Arc<Job>) -> GitResult<()> {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd.exe");
        c.args(["/D", "/S", "/C"]).raw_arg(format!("\"{command}\""));
        c
    };
    #[cfg(unix)]
    let mut cmd = {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("NO_COLOR", "1").env("TERM", "dumb");
    let (mut child, tree) = process_tree::spawn(&mut cmd)?;
    let stop = Arc::new(AtomicBool::new(false));
    let out = reader(child.stdout.take().unwrap(), job.clone(), false, stop.clone());
    let err = reader(child.stderr.take().unwrap(), job.clone(), true, stop.clone());
    let started = Instant::now();
    let outcome = (|| -> GitResult<()> {
        loop {
            let cancelled = job.cancel.load(Ordering::Acquire);
            let timed_out = started.elapsed() >= timeout;
            if cancelled || timed_out {
                tree.terminate();
                let _ = child.wait();
                let mut r = job.report.lock();
                r.phase = if cancelled { "cancelled" } else { "timed-out" }.into();
                break;
            }
            if process_tree::exited(&mut child)? {
                // Stop background descendants before releasing the repository queue.
                tree.terminate();
                let status = child.wait()?;
                let mut r = job.report.lock();
                r.exit_code = status.code();
                r.phase = if status.success() { "passed" } else { "failed" }.into();
                break;
            }
            thread::sleep(Duration::from_millis(35));
        }
        Ok(())
    })();
    tree.terminate();
    let _ = child.wait();
    // Producers have stopped, but a reader may not have been scheduled yet.
    // Ask it to drain queued pipe bytes rather than cutting it off after a sleep.
    stop.store(true, Ordering::Release);
    let _ = out.join();
    let _ = err.join();
    outcome
}

#[cfg(unix)]
fn available<T: std::os::fd::AsRawFd>(pipe: &T) -> std::io::Result<bool> {
    unsafe {
        let fd = pipe.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(true)
}
#[cfg(windows)]
fn available<T: std::os::windows::io::AsRawHandle>(pipe: &T) -> std::io::Result<bool> {
    let mut bytes = 0;
    let ok = unsafe {
        windows_sys::Win32::System::Pipes::PeekNamedPipe(pipe.as_raw_handle(), std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut bytes, std::ptr::null_mut())
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(bytes > 0)
}
#[cfg(windows)]
trait Pipe: Read + std::os::windows::io::AsRawHandle + Send + 'static {}
#[cfg(windows)]
impl<T: Read + std::os::windows::io::AsRawHandle + Send + 'static> Pipe for T {}
#[cfg(unix)]
trait Pipe: Read + std::os::fd::AsRawFd + Send + 'static {}
#[cfg(unix)]
impl<T: Read + std::os::fd::AsRawFd + Send + 'static> Pipe for T {}
fn reader(mut pipe: impl Pipe, job: Arc<Job>, stderr: bool, stop: Arc<AtomicBool>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0; 8192];
        let mut drained = 0;
        loop {
            let stopping = stop.load(Ordering::Acquire);
            // Escaped descendants must not keep a finished check alive by writing
            // forever. This still preserves every byte within the display limit.
            if stopping && drained > OUTPUT_LIMIT {
                break;
            }
            match available(&pipe) {
                Ok(true) => {}
                Ok(false) => {
                    if stopping {
                        break;
                    }
                    thread::sleep(Duration::from_millis(15));
                    continue;
                }
                Err(_) => break,
            }
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if stopping {
                        drained += n;
                    }
                    let kept = {
                        let mut output = job.output.lock();
                        let dest = if stderr { &mut output.1 } else { &mut output.0 };
                        let kept = n.min(OUTPUT_LIMIT.saturating_sub(dest.len()));
                        dest.extend_from_slice(&buf[..kept]);
                        kept
                    };
                    if kept < n {
                        job.report.lock().truncated = true;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if stopping {
                        break;
                    }
                    thread::sleep(Duration::from_millis(15));
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    })
}

#[cfg(unix)]
mod process_tree {
    use super::*;
    use std::os::unix::process::CommandExt;
    pub struct Tree(u32, AtomicBool);
    impl Tree {
        pub fn terminate(&self) {
            if !self.1.swap(true, Ordering::AcqRel) {
                unsafe {
                    libc::kill(-(self.0 as i32), libc::SIGKILL);
                }
            }
        }
    }
    pub fn spawn(cmd: &mut Command) -> std::io::Result<(Child, Tree)> {
        cmd.process_group(0);
        let child = cmd.spawn()?;
        let tree = Tree(child.id(), AtomicBool::new(false));
        Ok((child, tree))
    }
    pub fn exited(child: &mut Child) -> std::io::Result<bool> {
        // WNOWAIT keeps the leader's PID reserved until its group has been killed.
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        let ok = unsafe { libc::waitid(libc::P_PID, child.id(), &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
        if ok < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(info.si_signo != 0)
    }
}

#[cfg(windows)]
mod process_tree {
    use super::*;
    use std::os::windows::{io::AsRawHandle, process::CommandExt};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*},
    };
    pub struct Tree(HANDLE);
    impl Tree {
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    pub fn exited(child: &mut Child) -> std::io::Result<bool> {
        Ok(child.try_wait()?.is_some())
    }
    pub fn spawn(cmd: &mut Command) -> std::io::Result<(Child, Tree)> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let tree = Tree(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Assign before any user code can create descendants.
            let mut child = cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED).spawn()?;
            let resumed = (|| {
                if AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                if snap == INVALID_HANDLE_VALUE {
                    return Err(std::io::Error::last_os_error());
                }
                let mut entry: THREADENTRY32 = std::mem::zeroed();
                entry.dwSize = std::mem::size_of_val(&entry) as u32;
                let mut found = false;
                let mut next = Thread32First(snap, &mut entry);
                while next != 0 {
                    if entry.th32OwnerProcessID == child.id() {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                        if !thread.is_null() {
                            found = ResumeThread(thread) != u32::MAX;
                            CloseHandle(thread);
                        }
                        break;
                    }
                    next = Thread32Next(snap, &mut entry);
                }
                CloseHandle(snap);
                if found {
                    Ok(())
                } else {
                    Err(std::io::Error::other("Could not resume the validation process."))
                }
            })();
            if let Err(e) = resumed {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
            Ok((child, tree))
        }
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;
    #[test]
    fn readers_scheduled_after_process_exit_still_capture_buffered_output() {
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new("cmd.exe");
            c.creation_flags(0x08000000);
            c.args(["/D", "/C", "echo buffered-stdout && echo buffered-stderr >&2"]);
            c
        };
        #[cfg(unix)]
        let mut command = {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", "printf buffered-stdout; printf buffered-stderr >&2"]);
            c
        };
        let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        assert!(child.wait().unwrap().success());
        let job = Arc::new(Job {
            report: Mutex::new(Report {
                id: String::new(),
                repository_root: String::new(),
                command: String::new(),
                phase: "running".into(),
                stdout: String::new(),
                stderr: String::new(),
                truncated: false,
                exit_code: None,
                elapsed_ms: 0,
                before_state: None,
                after_state: None,
                error: None,
            }),
            output: Mutex::new((vec![], vec![])),
            cancel: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            started: Instant::now(),
        });
        // Deterministically emulate a scheduler that runs the worker only after
        // execute has reaped the process and signalled its readers to finish.
        let stop = Arc::new(AtomicBool::new(true));
        let out = reader(child.stdout.take().unwrap(), job.clone(), false, stop.clone());
        let err = reader(child.stderr.take().unwrap(), job.clone(), true, stop);
        out.join().unwrap();
        err.join().unwrap();
        let output = job.output.lock();
        assert!(String::from_utf8_lossy(&output.0).contains("buffered-stdout"));
        assert!(String::from_utf8_lossy(&output.1).contains("buffered-stderr"));
    }
}
