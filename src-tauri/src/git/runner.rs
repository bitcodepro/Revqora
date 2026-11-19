//! Thin, safe wrapper around the `git` executable.
//!
//! Every call runs non-interactively (no pager, no prompts, no console window)
//! with stable, machine-readable output settings.

use std::ffi::OsStr;
use std::io::{BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct GitError {
    pub message: String,
    pub stderr: String,
    pub code: Option<i32>,
    /// Machine readable kind so the UI can offer the right recovery action.
    pub kind: String,
    /// Optional structured payload (e.g. conflicting paths).
    pub details: Vec<String>,
}

impl GitError {
    pub fn new(message: impl Into<String>) -> Self {
        GitError { message: message.into(), stderr: String::new(), code: None, kind: "error".into(), details: Vec::new() }
    }
    pub fn kind(mut self, kind: &str) -> Self {
        self.kind = kind.into();
        self
    }
    pub fn details(mut self, details: Vec<String>) -> Self {
        self.details = details;
        self
    }
}

impl From<std::io::Error> for GitError {
    fn from(e: std::io::Error) -> Self {
        // Keep native OS codes separate from `code`, which is a Git exit code.
        let mut result = GitError::new(format!("I/O error: {e}"));
        result.details.push(format!("io_kind={:?}", e.kind()));
        if let Some(code) = e.raw_os_error() {
            result.details.push(format!("os_error={code}"));
        }
        result
    }
}

pub type GitResult<T> = Result<T, GitError>;

/// Output of a finished git process.
#[derive(Debug, Clone)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn ok(&self) -> bool {
        self.code == 0
    }
}

/// Builds a configured `git` command rooted at `repo`.
pub fn command(repo: &Path) -> Command {
    let mut c = super::locate::command();
    c.current_dir(repo);
    // Credentials and SSH passphrases are asked through Revqora's own dialog.
    for (k, v) in crate::askpass::env() {
        c.env(k, v);
        if k == crate::git_credentials::HELPER_VAR {
            c.args(["-c", &format!("credential.helper={v}")]);
        }
    }
    c.env(crate::git_credentials::REPO_VAR, std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_owned()));
    c.env(crate::git_credentials::EPOCH_VAR, crate::git_credentials::epoch().to_string());
    static CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    c.env(crate::git_credentials::CALL_VAR, format!("{}-{}", std::process::id(), CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    c.args([
        "-c",
        "core.quotepath=false",
        "-c",
        "color.ui=false",
        "-c",
        "core.pager=cat",
        "-c",
        "advice.detachedHead=false",
        "-c",
        "advice.statusHints=false",
        "-c",
        "i18n.logOutputEncoding=UTF-8",
    ]);
    c.env("GIT_TERMINAL_PROMPT", "0");
    // Read cached credentials normally, but keep new sign-in/token choices in
    // Revqora's authenticated askpass UI instead of opening a GCM browser flow.
    c.env("GCM_INTERACTIVE", "never");
    c.env("GCM_GUI_PROMPT", "0");
    c.env("GIT_OPTIONAL_LOCKS", "0");
    c.env("LANGUAGE", "en");
    c.env("LC_MESSAGES", "C");
    // Never block waiting for an editor; we always pass messages explicitly.
    c.env("GIT_EDITOR", "true");
    c.env("GIT_MERGE_AUTOEDIT", "no");
    c.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        let priority = if BACKGROUND.with(std::cell::Cell::get) { BELOW_NORMAL_PRIORITY_CLASS } else { 0 };
        c.creation_flags(CREATE_NO_WINDOW | priority);
    }
    c
}

thread_local! {
    static BACKGROUND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Runs `f` with every Git process it starts on this thread at below-normal CPU
/// priority (Windows), so optional background work yields to what the user waits for.
pub fn in_background<T>(f: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        // Pool threads are reused: restore the flag even if `f` panics.
        fn drop(&mut self) {
            BACKGROUND.with(|b| b.set(self.0));
        }
    }
    let _restore = Restore(BACKGROUND.with(|b| b.replace(true)));
    f()
}

fn describe(args: &[&OsStr]) -> String {
    let mut s = String::from("git");
    for a in args.iter().take(4) {
        s.push(' ');
        s.push_str(&a.to_string_lossy());
    }
    s
}

/// The process tree of a command with a time limit; network commands are also registered as
/// transfers so they can be cancelled.
enum Limited {
    Tree(super::validation::process_tree::Tree),
    Transfer(transfers::Registration),
}

/// Clears remembered configuration answers when a writing command ends (even on error): of
/// the repository it ran in (and its other worktrees), or of every repository when the command
/// can change configuration outside it (see [`changes_shared_configuration`]).
struct ClearConfigCache(Option<std::path::PathBuf>);

impl ClearConfigCache {
    fn after<S: AsRef<OsStr>>(repo: &Path, args: &[S]) -> Self {
        ClearConfigCache((!changes_shared_configuration(args)).then(|| repo.to_path_buf()))
    }
}

impl Drop for ClearConfigCache {
    fn drop(&mut self) {
        match &self.0 {
            Some(repo) => super::config_cache::clear_repository(repo),
            None => super::config_cache::clear(),
        }
    }
}

/// Writing commands that may change configuration other repositories read: global, system or
/// explicit configuration files, credentials, and commands that create or set up repositories.
pub fn changes_shared_configuration<S: AsRef<OsStr>>(args: &[S]) -> bool {
    let a: Vec<String> = args.iter().map(|s| s.as_ref().to_string_lossy().into_owned()).collect();
    let mut start = 0;
    while a.get(start).is_some_and(|v| v == "-c") && a.get(start + 1).is_some() {
        start += 2;
    }
    if a.get(start).is_some_and(|v| v == "--literal-pathspecs") {
        start += 1;
    }
    let a = &a[start..];
    let has = |flag: &str| a.iter().any(|x| x == flag || x.starts_with(&format!("{flag}=")));
    match a.first().map(|s| s.as_str()).unwrap_or("") {
        "config" => has("--global") || has("--system") || has("--file") || has("-f") || has("--blob"),
        "restore" | "switch" | "checkout" | "branch" | "remote" | "rebase" | "worktree" | "symbolic-ref" | "sparse-checkout" | "bisect" => false,
        _ => true,
    }
}

/// Runs git and returns the raw output regardless of exit code.
pub fn exec<I, S>(repo: &Path, args: I) -> GitResult<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    exec_full(repo, args, &[], None)
}

/// True for git invocations that never modify the working tree, the index or refs.
pub fn is_read_only<S: AsRef<OsStr>>(args: &[S]) -> bool {
    let a: Vec<String> = args.iter().map(|s| s.as_ref().to_string_lossy().into_owned()).collect();
    let mut prefix = 0;
    loop {
        if a.get(prefix).is_some_and(|v| v == "-c") && a.get(prefix + 1).is_some() {
            prefix += 2;
        } else if a.get(prefix).is_some_and(|v| v == "--literal-pathspecs") {
            prefix += 1;
        } else {
            break;
        }
    }
    let a = &a[prefix..];
    let has = |flag: &str| a.iter().any(|x| x == flag);
    match a.first().map(|s| s.as_str()).unwrap_or("") {
        "credential" => a.len() == 2 && a.get(1).is_some_and(|s| s == "fill"),
        "var" => true,
        "sparse-checkout" => a.len() == 2 && a[1] == "list",
        "symbolic-ref" => {
            let operands: Vec<_> =
                a[1..].iter().filter(|s| !matches!(s.as_str(), "-q" | "--quiet" | "--short" | "--recurse" | "--no-recurse" | "--")).collect();
            operands.len() == 1 && !operands[0].starts_with('-')
        }
        "reflog" => a.len() == 1 || a.get(1).is_some_and(|s| matches!(s.as_str(), "show" | "list" | "exists") || s.starts_with('-')),
        "status" | "diff" | "log" | "show" | "rev-parse" | "cat-file" | "for-each-ref" | "ls-files" | "ls-tree" | "range-diff" | "rev-list" | "merge-base"
        | "blame" | "diff-tree" | "diff-index" | "show-ref" | "check-ref-format" | "version" | "--version" | "ls-remote" | "describe" | "count-objects"
        | "name-rev" | "grep" | "check-ignore" => true,
        // Immutable object creation is safe concurrently; it does not modify refs,
        // the index or the working tree. An enclosing mutation still holds its gate.
        "hash-object" | "commit-tree" | "merge-tree" | "mktree" => true,
        // Git's commit-graph cache is written under its own lock and changes no ref,
        // the index or the working tree (fetch and `gc --auto` write it concurrently too).
        "commit-graph" => a.get(1).is_some_and(|s| s == "write" || s == "verify"),
        "merge-file" => has("-p") || has("--stdout"),
        // A dry run only asks the server; no ref, object or remote-tracking branch changes.
        "push" => has("--dry-run") || has("-n"),
        "remote" => a.len() == 1 || (a.len() == 2 && a[1] == "-v") || a.get(1).is_some_and(|s| s == "get-url"),
        "stash" => a.get(1).map(|s| s == "list").unwrap_or(false),
        "notes" => matches!(a.get(1).map(|s| s.as_str()), Some("show" | "list")),
        "worktree" => a.get(1).map(|s| s == "list").unwrap_or(false),
        "submodule" => a.get(1).map(|s| s == "status").unwrap_or(false),
        "lfs" => matches!(a.get(1).map(|s| s.as_str()), Some("version" | "ls-files" | "track")) && a.len() == 2,
        "config" => has("--get") || has("--get-all") || has("--get-regexp") || has("-l") || has("--list"),
        "branch" => has("--contains") || has("--list"),
        _ => false,
    }
}

/// Commands that wait on a remote. Inside a write transaction they run with the repository
/// lock shared (see `operations::network`), so reads are not blocked by the network.
pub fn is_network<S: AsRef<OsStr>>(args: &[S]) -> bool {
    let mut start = 0;
    while args.get(start).is_some_and(|v| v.as_ref() == "-c") && args.get(start + 1).is_some() {
        start += 2;
    }
    if args.get(start).is_some_and(|v| v.as_ref() == "--literal-pathspecs") {
        start += 1;
    }
    args.get(start).is_some_and(|v| matches!(v.as_ref().to_str(), Some("fetch" | "push" | "ls-remote")))
}

/// Writing commands that never change Git configuration or which branch HEAD names. Their end
/// keeps remembered configuration answers: a pull runs about twenty of them, and each clear
/// cost several `config`/`var` processes (70–100 ms each on Windows) on the next read.
/// Anything not listed here (config, remote, branch, checkout, switch, rebase, submodule,
/// worktree, clone, init, ...) still clears.
pub fn keeps_configuration<S: AsRef<OsStr>>(args: &[S]) -> bool {
    let a: Vec<String> = args.iter().map(|s| s.as_ref().to_string_lossy().into_owned()).collect();
    let mut start = 0;
    while a.get(start).is_some_and(|v| v == "-c") && a.get(start + 1).is_some() {
        start += 2;
    }
    if a.get(start).is_some_and(|v| v == "--literal-pathspecs") {
        start += 1;
    }
    let a = &a[start..];
    let has = |flag: &str| a.iter().any(|x| x == flag);
    match a.first().map(|s| s.as_str()).unwrap_or("") {
        "fetch" => !has("--set-upstream"),
        "push" => !has("-u") && !has("--set-upstream"),
        "maintenance" => a.get(1).is_some_and(|s| s == "run"),
        "update-ref" | "merge" | "commit" | "reset" | "update-index" | "read-tree" | "add" | "rm" | "apply" | "pack-refs" | "gc" | "tag" | "cherry-pick"
        | "revert" | "stash" | "reflog" | "notes" | "prune" | "repack" | "checkout-index" | "restore" | "write-tree" | "clean" | "archive" | "mktree"
        | "hash-object" => true,
        _ => false,
    }
}

pub fn exec_full<I, S>(repo: &Path, args: I, env: &[(&str, &str)], input: Option<&[u8]>) -> GitResult<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    exec_capture(repo, args, env, input, None, None)
}

/// Like `exec_full`, with Git connection settings selected for this command (for example a
/// clone's choice before it is saved) instead of the repository's saved settings.
pub fn exec_full_with_connection<I, S>(
    repo: &Path,
    args: I,
    env: &[(&str, &str)],
    input: Option<&[u8]>,
    connection: Option<&super::connection::Options>,
) -> GitResult<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    exec_capture_mode(repo, args, env, input, None, None, false, connection)
}

/// Bound captured output while draining both pipes and reaping the Git process.
pub fn exec_limited<I, S>(repo: &Path, args: I, limit: usize) -> GitResult<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    exec_capture(repo, args, &[], None, Some(limit), None)
}

pub(super) fn exec_preview(repo: &Path, args: &[String], env: &[(&str, &str)], limit: usize) -> GitResult<(Output, bool)> {
    let mut out = exec_capture_mode(repo, args, env, None, Some(limit), None, true, None)?;
    let truncated = out.stdout.len() > limit;
    if truncated {
        // A cut line must never be parsed as a real changed line.
        let end = out.stdout[..limit].iter().rposition(|&byte| byte == b'\n').map_or(0, |index| index + 1);
        out.stdout.truncate(end);
    }
    Ok((out, truncated))
}

pub(super) fn run_with_deadline(repo: &Path, args: &[&str], env: &[(&str, &str)], timeout: Duration) -> GitResult<String> {
    let out = exec_capture(repo, args, env, None, None, Some(timeout))?;
    if out.ok() {
        Ok(out.text())
    } else {
        Err(fail(describe(&args.iter().map(OsStr::new).collect::<Vec<_>>()), &out))
    }
}

fn wait_for_deadline(child: &mut std::process::Child, timeout: Duration) -> GitResult<()> {
    use super::validation::{poll_process, ProcessState};

    let start = Instant::now();
    loop {
        match poll_process(child, false, start.elapsed() >= timeout)? {
            ProcessState::Exited => return Ok(()),
            ProcessState::TimedOut => return Err(GitError::new(format!("Git exceeded its {} second time limit.", timeout.as_secs())).kind("git-timeout")),
            _ => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn capture_bytes(mut pipe: impl Read, limit: Option<usize>) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    match limit {
        Some(limit) => {
            Read::by_ref(&mut pipe).take(limit.saturating_add(1) as u64).read_to_end(&mut bytes)?;
            std::io::copy(&mut pipe, &mut std::io::sink())?;
        }
        None => {
            pipe.read_to_end(&mut bytes)?;
        }
    }
    Ok(bytes)
}

fn exec_capture<I, S>(repo: &Path, args: I, env: &[(&str, &str)], input: Option<&[u8]>, limit: Option<usize>, timeout: Option<Duration>) -> GitResult<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    exec_capture_mode(repo, args, env, input, limit, timeout, false, None)
}

#[allow(clippy::too_many_arguments)] // One private capture path for every variant.
fn exec_capture_mode<I, S>(
    repo: &Path,
    args: I,
    env: &[(&str, &str)],
    input: Option<&[u8]>,
    limit: Option<usize>,
    timeout: Option<Duration>,
    allow_truncated: bool,
    connection: Option<&super::connection::Options>,
) -> GitResult<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<S> = args.into_iter().collect();
    let writes = !is_read_only(&args);
    // Any writing command may change configuration (remote, config, submodule, ...): drop
    // remembered configuration answers afterwards instead of trusting file timestamps alone.
    let _forget = (writes && !keeps_configuration(&args)).then(|| ClearConfigCache::after(repo, &args));
    super::operations::access(
        repo,
        writes,
        |_, _| {},
        || {
            let network = is_network(&args);
            let diagnostic_args: Vec<String> = args.iter().map(|a| a.as_ref().to_string_lossy().into_owned()).collect();
            let mut capture = crate::journal::command(repo, &diagnostic_args);
            let result: GitResult<Output> = super::operations::network_when(repo, network, || {
                let mut c = command(repo);
                super::connection::apply(repo, &mut c, connection, &diagnostic_args)?;
                c.args(args.iter().map(|a| a.as_ref()));
                for (k, v) in env {
                    c.env(k, v);
                }
                super::connection::finish(&mut c);
                c.stdout(Stdio::piped()).stderr(Stdio::piped());
                if input.is_some() {
                    c.stdin(Stdio::piped());
                }
                let spawn_error = |e: std::io::Error| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        GitError::new("Git executable was not found. Install Git and make sure it is on PATH.").kind("git-missing")
                    } else {
                        GitError::from(e)
                    }
                };
                let (mut child, tree) = if timeout.is_some() {
                    c.stdin(Stdio::null());
                    let (child, tree) = super::validation::process_tree::spawn(&mut c)?;
                    (child, Some(tree))
                } else {
                    (c.spawn().map_err(spawn_error)?, None)
                };
                // A network command with a time limit (automatic fetch) can be cancelled as well:
                // the next writer of the repository stops it (operations::yielding).
                let tree = match tree {
                    Some(tree) if network => Some(Limited::Transfer(transfers::register(repo, tree))),
                    tree => tree.map(Limited::Tree),
                };
                // Feed stdin on a separate thread so large inputs cannot deadlock with stdout.
                let writer = input.map(|data| {
                    let data = data.to_vec();
                    let mut stdin = child.stdin.take().expect("stdin piped");
                    std::thread::spawn(move || {
                        let _ = stdin.write_all(&data);
                    })
                });
                let stderr_pipe = child.stderr.take().expect("stderr piped");
                let err_thread = std::thread::spawn(move || capture_bytes(stderr_pipe, limit.map(|_| 128 * 1024)));
                let stdout_pipe = child.stdout.take().expect("stdout piped");
                let mut cancelled = false;
                let (stdout, status): (_, GitResult<ExitStatus>) = if let Some((timeout, tree)) = timeout.zip(tree) {
                    let out_thread = std::thread::spawn(move || capture_bytes(stdout_pipe, limit));
                    let outcome = wait_for_deadline(&mut child, timeout);
                    // Descendants can still hold the output pipes when the Git leader exits.
                    match tree {
                        Limited::Tree(tree) => tree.terminate(),
                        Limited::Transfer(registration) => {
                            registration.terminate();
                            cancelled = registration.finish();
                        }
                    }
                    let status = child.wait();
                    let stdout = out_thread.join().unwrap_or_else(|_| Err(std::io::Error::other("Git stdout reader failed")));
                    (stdout, outcome.and(status.map_err(GitError::from)))
                } else {
                    let stdout = capture_bytes(stdout_pipe, limit);
                    (stdout, child.wait().map_err(GitError::from))
                };
                if let Some(w) = writer {
                    let _ = w.join();
                }
                let stderr = err_thread.join().unwrap_or_else(|_| Err(std::io::Error::other("Git stderr reader failed")))?;
                #[cfg(test)]
                let status = status.map_err(|mut error| {
                    if error.kind == "git-timeout" {
                        error.stderr = crate::journal::redact::bounded(&crate::journal::redact::text(&String::from_utf8_lossy(&stderr)), 4096).0;
                    }
                    error
                });
                let status = status?;
                let stdout = stdout?;
                if !allow_truncated && limit.is_some_and(|limit| stdout.len() > limit) {
                    return Err(GitError::new("Git output exceeds the preview size limit.").kind("output-limit"));
                }
                let stderr = String::from_utf8_lossy(&stderr).into_owned();
                let out = Output { stdout, stderr, code: status.code().unwrap_or(-1) };
                if cancelled && !out.ok() {
                    return Err(transfers::cancelled_error());
                }
                Ok(out)
            });
            if let Some(trace) = capture.as_mut() {
                match &result {
                    Ok(out) => trace.finish(Some(out.code), &out.stdout, &out.stderr),
                    Err(e) => trace.finish(e.code, &[], &e.message),
                }
            }
            result
        },
    )
}

fn fail(args_desc: String, out: &Output) -> GitError {
    let stderr = strip_ansi(out.stderr.trim());
    let stdout = strip_ansi(String::from_utf8_lossy(&out.stdout).trim());
    let mut msg = clean_message(if stderr.is_empty() { &stdout } else { &stderr });
    if msg.is_empty() {
        msg = format!("{args_desc} failed with exit code {}", out.code);
    }
    let kind = classify(&format!("{stderr}\n{stdout}"));
    if kind == "network-stalled" {
        msg = "The server stopped sending data, so Git gave up. Check your network, VPN or proxy and try again.".into();
    }
    GitError { message: msg, stderr: format!("{stderr}\n{stdout}").trim().to_string(), code: Some(out.code), kind, details: Vec::new() }
}

/// Removes terminal control sequences. Some servers (Bitbucket among them) colour their
/// `remote:` messages; the escape codes used to show up as text such as `[38;5;226m`.
pub fn strip_ansi(text: &str) -> String {
    if !text.contains('\u{1b}') && !text.contains('\u{9b}') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let csi = match c {
            '\u{9b}' => true,
            '\u{1b}' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    true
                }
                Some(']') => {
                    // Operating system command: ends with BEL or ESC \.
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || c == '\u{1b}' && chars.next_if_eq(&'\\').is_some() {
                            break;
                        }
                    }
                    continue;
                }
                Some(_) => {
                    // Other escapes: intermediates (space../), then one final character.
                    while chars.next_if(|c| (' '..='/').contains(c)).is_some() {}
                    chars.next();
                    continue;
                }
                None => continue,
            },
            _ => {
                out.push(c);
                continue;
            }
        };
        if csi {
            // Parameters and intermediates, then one final byte in @..~.
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

/// Network transfers (fetch, push, ls-remote) that the user can cancel, by operation.
///
/// Cancel names one operation (the id the interface gave its Fetch, Pull or Push). Another
/// operation of the same repository, running or queued, is never touched. An operation
/// cancelled while it still waits in the queue ends as cancelled when its turn comes, before
/// it changes anything.
pub mod transfers {
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use super::super::validation::process_tree::Tree;
    use super::{GitError, GitResult};

    struct Active {
        id: u64,
        operation: Option<String>,
        repo: PathBuf,
        tree: Arc<Tree>,
        cancelled: Arc<AtomicBool>,
    }

    static ACTIVE: Mutex<Vec<Active>> = Mutex::new(Vec::new());
    static NEXT: AtomicU64 = AtomicU64::new(1);
    /// Operations the user cancelled that have not ended yet (or never started). Locked
    /// after `ACTIVE` when both are needed.
    static CANCELLED: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
    /// Remembered cancellations of operations that never run are dropped after this many.
    const REMEMBERED: usize = 64;

    thread_local! {
        static OPERATION: RefCell<Option<String>> = const { RefCell::new(None) };
    }

    fn key(repo: &Path) -> PathBuf {
        std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_owned())
    }

    fn active() -> std::sync::MutexGuard<'static, Vec<Active>> {
        ACTIVE.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cancelled() -> std::sync::MutexGuard<'static, VecDeque<String>> {
        CANCELLED.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(in crate::git) fn cancelled_error() -> GitError {
        GitError::new("Transfer cancelled.").kind("cancelled")
    }

    /// Runs operation `operation` on this thread: its network commands can be cancelled by
    /// [`cancel`] with the same id. Fails as cancelled without running `f` when it was
    /// cancelled while queued.
    pub fn for_operation<T>(operation: &str, f: impl FnOnce() -> GitResult<T>) -> GitResult<T> {
        struct Restore(Option<String>, String);
        impl Drop for Restore {
            fn drop(&mut self) {
                OPERATION.with(|current| *current.borrow_mut() = self.0.take());
                cancelled().retain(|id| id != &self.1);
            }
        }
        if cancelled().iter().any(|id| id == operation) {
            cancelled().retain(|id| id != operation);
            return Err(cancelled_error());
        }
        let previous = OPERATION.with(|current| current.borrow_mut().replace(operation.to_owned()));
        let _restore = Restore(previous, operation.to_owned());
        f()
    }

    pub(in crate::git) struct Registration {
        id: u64,
        tree: Arc<Tree>,
        cancelled: Arc<AtomicBool>,
    }

    impl Registration {
        /// Stops the transfer's whole process tree.
        pub(in crate::git) fn terminate(&self) {
            self.tree.terminate();
        }

        /// Ends the registration once the leader has exited; returns whether Cancel stopped it.
        pub(in crate::git) fn finish(self) -> bool {
            active().retain(|a| a.id != self.id);
            let cancelled = self.cancelled.load(Ordering::Acquire);
            if !cancelled {
                self.tree.keep_descendants();
            }
            cancelled
        }
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            active().retain(|a| a.id != self.id);
        }
    }

    pub(in crate::git) fn register(repo: &Path, tree: Tree) -> Registration {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let tree = Arc::new(tree);
        let operation = OPERATION.with(|current| current.borrow().clone());
        let mut list = active();
        // Cancel may have arrived between the operation's start and this command.
        let stop = operation.as_ref().is_some_and(|op| cancelled().iter().any(|id| id == op));
        let flag = Arc::new(AtomicBool::new(stop));
        if stop {
            tree.terminate();
        }
        list.push(Active { id, operation, repo: key(repo), tree: tree.clone(), cancelled: flag.clone() });
        Registration { id, tree, cancelled: flag }
    }

    /// Cancels operation `operation`: stops its running transfer (with the helpers it started)
    /// or, when it has not started yet, makes it end as cancelled when its turn comes. Returns
    /// whether a running transfer was stopped.
    pub fn cancel(operation: &str) -> bool {
        let list = active();
        {
            let mut ids = cancelled();
            if !ids.iter().any(|id| id == operation) {
                if ids.len() >= REMEMBERED {
                    ids.pop_front();
                }
                ids.push_back(operation.to_owned());
            }
        }
        let mut stopped = false;
        for transfer in list.iter().filter(|a| a.operation.as_deref() == Some(operation)) {
            transfer.cancelled.store(true, Ordering::Release);
            transfer.tree.terminate();
            stopped = true;
        }
        stopped
    }

    /// Whether a transfer is running for `repo`.
    pub fn running(repo: &Path) -> bool {
        let key = key(repo);
        active().iter().any(|a| a.repo == key)
    }
}

fn clean_message(s: &str) -> String {
    s.lines()
        .map(|l| l.trim_end())
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .map(|l| l.strip_prefix("fatal: ").or_else(|| l.strip_prefix("error: ")).unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n")
}

fn classify(s: &str) -> String {
    let l = s.to_lowercase();
    if l.contains("operation too slow") {
        "network-stalled".into()
    } else if l.contains("not possible to fast-forward") {
        "diverged".into()
    } else if l.contains("would be overwritten") || l.contains("your local changes") {
        "dirty-worktree".into()
    } else if l.contains("conflict") {
        "conflict".into()
    } else if l.contains("authentication failed")
        || l.contains("could not read username")
        || l.contains("could not read password")
        || l.contains("unable to get password from user")
        || l.contains("permission denied (publickey)")
    {
        "auth".into()
    } else if l.contains("non-fast-forward") || l.contains("[rejected]") || l.contains("fetch first") {
        "rejected".into()
    } else if l.contains("not a git repository") {
        "not-a-repo".into()
    } else if l.contains("please tell me who you are") || l.contains("unable to auto-detect email") {
        "identity".into()
    } else {
        "error".into()
    }
}

/// Runs git, failing on non-zero exit. Returns stdout as (lossy) UTF-8.
pub fn run<I, S>(repo: &Path, args: I) -> GitResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_bytes(repo, args).map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn run_bytes<I, S>(repo: &Path, args: I) -> GitResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<S> = args.into_iter().collect();
    let desc = describe(&args.iter().map(|a| a.as_ref()).collect::<Vec<_>>());
    let out = exec(repo, args)?;
    if out.ok() {
        Ok(out.stdout)
    } else {
        Err(fail(desc, &out))
    }
}

pub fn run_env<I, S>(repo: &Path, args: I, env: &[(&str, &str)], input: Option<&[u8]>) -> GitResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<S> = args.into_iter().collect();
    let desc = describe(&args.iter().map(|a| a.as_ref()).collect::<Vec<_>>());
    let out = exec_full(repo, args, env, input)?;
    if out.ok() {
        Ok(out.text())
    } else {
        Err(fail(desc, &out))
    }
}

/// Converts a failed [`Output`] into an error (for callers that inspect exit codes themselves).
pub fn to_error(what: &str, out: &Output) -> GitError {
    fail(what.to_string(), out)
}

/// Runs a long operation (fetch/push/clone…) streaming progress lines from stderr.
pub fn run_streaming<F>(repo: &Path, args: &[String], env: &[(&str, &str)], mut on_line: F) -> GitResult<String>
where
    F: FnMut(&str),
{
    run_streaming_with_connection(repo, args, env, &mut on_line, None)
}
pub fn run_streaming_with_connection<F>(
    repo: &Path,
    args: &[String],
    env: &[(&str, &str)],
    mut on_line: F,
    connection: Option<&super::connection::Options>,
) -> GitResult<String>
where
    F: FnMut(&str),
{
    let _forget = (!is_read_only(args) && !keeps_configuration(args)).then(|| ClearConfigCache::after(repo, args));
    super::operations::access(
        repo,
        !is_read_only(args),
        |_, _| {},
        || {
            let mut capture = crate::journal::command(repo, args);
            let result: GitResult<String> = super::operations::network_when(repo, is_network(args), || {
                let mut c = command(repo);
                super::connection::apply(repo, &mut c, connection, args)?;
                c.args(args);
                for (k, v) in env {
                    c.env(k, v);
                }
                super::connection::finish(&mut c);
                c.stdout(Stdio::piped()).stderr(Stdio::piped());
                // A transfer runs in its own process tree so Cancel can stop it (and the
                // git-remote-https, ssh or credential helper it started).
                let (mut child, registration) = if is_network(args) {
                    let (child, tree) = super::validation::process_tree::spawn(&mut c)?;
                    (child, Some(transfers::register(repo, tree)))
                } else {
                    let child = c.spawn().map_err(|e| {
                        if e.kind() == std::io::ErrorKind::NotFound {
                            GitError::new("Git executable was not found. Install Git and make sure it is on PATH.").kind("git-missing")
                        } else {
                            GitError::from(e)
                        }
                    })?;
                    (child, None)
                };
                let mut out_pipe = child.stdout.take().expect("stdout piped");
                let out_thread = std::thread::spawn(move || {
                    let mut buf = Vec::new();
                    let _ = out_pipe.read_to_end(&mut buf);
                    buf
                });
                let mut collected = String::new();
                {
                    // git progress uses '\r' to redraw lines; split on both separators.
                    let reader = BufReader::new(child.stderr.take().expect("stderr piped"));
                    let mut buf = Vec::new();
                    let mut flush = |buf: &mut Vec<u8>, collected: &mut String| {
                        if !buf.is_empty() {
                            let line = strip_ansi(&String::from_utf8_lossy(buf));
                            on_line(&line);
                            collected.push_str(&line);
                            collected.push('\n');
                            buf.clear();
                        }
                    };
                    for byte in reader.bytes() {
                        match byte {
                            Ok(b'\n') | Ok(b'\r') => flush(&mut buf, &mut collected),
                            Ok(b) => buf.push(b),
                            Err(_) => break,
                        }
                    }
                    flush(&mut buf, &mut collected);
                }
                let cancelled = match registration {
                    Some(registration) => {
                        // Leave the leader unreaped until the registration is gone, so Cancel
                        // can never signal a reused process ID.
                        while !super::validation::process_tree::exited(&mut child)? {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        registration.finish()
                    }
                    None => false,
                };
                let status = child.wait()?;
                let stdout = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).into_owned();
                let out = Output { stdout: stdout.clone().into_bytes(), stderr: collected.clone(), code: status.code().unwrap_or(-1) };
                if let Some(trace) = capture.as_mut() {
                    trace.finish(Some(out.code), &out.stdout, &out.stderr);
                }
                if cancelled && !out.ok() {
                    return Err(transfers::cancelled_error());
                }
                if out.ok() {
                    Ok(format!("{stdout}{collected}"))
                } else {
                    // Keep only meaningful lines (drop progress counters) in the error.
                    let filtered: String =
                        collected.lines().filter(|l| !l.contains('%') || l.contains("error") || l.contains("fatal")).collect::<Vec<_>>().join("\n");
                    let out = Output { stdout: stdout.into_bytes(), stderr: filtered, code: out.code };
                    Err(fail(format!("git {}", args.first().cloned().unwrap_or_default()), &out))
                }
            });
            if let (Some(trace), Err(e)) = (capture.as_mut(), &result) {
                trace.finish(e.code, &[], &e.message);
            }
            result
        },
    )
}

/// Splits NUL-separated output, dropping the trailing empty element.
pub fn split_nul(s: &str) -> impl Iterator<Item = &str> {
    s.split('\0').filter(|p| !p.is_empty())
}

/// Version triple of the selected git.
pub fn version() -> GitResult<(u32, u32, u32, String)> {
    let (a, b, c) = super::locate::version();
    if (a, b, c) == (0, 0, 0) {
        return Err(GitError::new("Git executable was not found.").kind("git-missing"));
    }
    let full = super::locate::selection().map(|s| s.version).unwrap_or_else(|| format!("{a}.{b}.{c}"));
    Ok((a, b, c, full))
}

pub fn version_at_least(major: u32, minor: u32) -> bool {
    let (a, b, _) = super::locate::version();
    (a, b) >= (major, minor)
}

#[cfg(test)]
mod tests {
    use super::is_read_only;

    #[test]
    fn bounded_capture_drains_the_pipe_without_retaining_the_full_payload() {
        let mut input = std::io::Cursor::new(vec![b'x'; 1024 * 1024]);
        let captured = super::capture_bytes(&mut input, Some(1024)).unwrap();
        assert_eq!(captured.len(), 1025);
        assert_eq!(input.position(), 1024 * 1024);
    }

    #[test]
    fn native_os_error_survives_conversion_without_becoming_a_git_exit_code() {
        let error = super::GitError::from(std::io::Error::from_raw_os_error(5));
        assert!(error.details.iter().any(|d| d == "os_error=5"));
        assert_eq!(error.code, None);
        assert!(serde_json::to_string(&error).unwrap().contains("os_error=5"));
    }

    #[test]
    fn classifies_noninteractive_credential_failures() {
        // Older Git reports the disabled prompt; newer Git uses the generic password error.
        for stderr in [
            "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
            "fatal: could not read Password for 'https://test@example.com': terminal prompts disabled",
            "fatal: unable to get password from user",
            "fatal: Authentication failed for 'https://example.com/repo.git/'",
            "git@example.com: Permission denied (publickey).",
        ] {
            let out = super::Output { stdout: Vec::new(), stderr: stderr.into(), code: 128 };
            let err = super::to_error("git fetch", &out);
            assert_eq!(err.kind, "auth", "{stderr}");
            assert_eq!(err.code, Some(128));
            assert_eq!(err.stderr, stderr);
        }
        // Network and filesystem errors must still be retried/handled as ordinary errors.
        assert_eq!(super::classify("fatal: Could not resolve host: example.com"), "error");
        assert_eq!(super::classify("fatal: unable to access repository: Permission denied"), "error");
    }
    #[test]
    fn stalled_and_diverged_transfers_have_their_own_kinds() {
        let stalled = "fatal: unable to access 'https://example.invalid/r.git/': Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds";
        let err = super::to_error("git fetch", &super::Output { stdout: Vec::new(), stderr: stalled.into(), code: 128 });
        assert_eq!(err.kind, "network-stalled");
        assert!(err.message.starts_with("The server stopped sending data"), "{}", err.message);
        assert_eq!(super::classify("hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting."), "diverged");
    }
    #[test]
    fn terminal_codes_are_removed_from_git_text() {
        assert_eq!(super::strip_ansi("remote: \u{1b}[38;5;226mPolicy: blocked\u{1b}[0m"), "remote: Policy: blocked");
        assert_eq!(super::strip_ansi("\u{1b}]0;title\u{7}done \u{1b}]8;;https://x\u{1b}\\link\u{1b}]8;;\u{1b}\\"), "done link");
        assert_eq!(super::strip_ansi("a\u{9b}31mb\u{1b}(Bc"), "abc");
        assert_eq!(super::strip_ansi("plain text, 100% done"), "plain text, 100% done");
        assert_eq!(super::strip_ansi("cut \u{1b}"), "cut ");
    }
    #[test]
    fn classifies_read_only_commands() {
        assert!(is_read_only(&["status", "--porcelain=v2"]));
        assert!(is_read_only(&["notes", "show", "HEAD"]));
        assert!(is_read_only(&["push", "--dry-run", "--porcelain", "--", "origin", "HEAD:refs/heads/x"]));
        assert!(!is_read_only(&["push", "origin", "HEAD"]));
        assert!(!is_read_only(&["notes", "add", "-m", "x", "HEAD"]));
        assert!(is_read_only(&["commit-graph", "write", "--reachable"]));
        assert!(!is_read_only(&["pack-refs", "--all"]));
        assert!(is_read_only(&["--literal-pathspecs", "log", "--", "file"]));
        assert!(is_read_only(&["--literal-pathspecs", "-c", "core.quotePath=false", "ls-tree", "HEAD"]));
        assert!(!is_read_only(&["-c", "advice.detachedHead=false", "--literal-pathspecs", "reset", "--hard"]));
        assert!(is_read_only(&["stash", "list"]));
        assert!(is_read_only(&["config", "--get", "user.name"]));
        assert!(is_read_only(&["-c", "credential.interactive=false", "credential", "fill"]));
        assert!(!is_read_only(&["credential", "approve"]));
        assert!(!is_read_only(&["-c", "advice.detachedHead=false", "reset", "--hard"]));
        assert!(!is_read_only(&["fetch", "--all"]));
        assert!(!is_read_only(&["push", "origin"]));
        assert!(is_read_only(&["commit-tree", "HEAD^{tree}"]));
        assert!(is_read_only(&["hash-object", "-w", "file"]));
        assert!(!is_read_only(&["merge-file", "ours", "base", "theirs"]));
        assert!(is_read_only(&["merge-file", "-p", "ours", "base", "theirs"]));
        assert!(is_read_only(&["hash-object", "file"]));
        assert!(!is_read_only(&["stash", "push"]));
        assert!(!is_read_only(&["checkout", "main"]));
        assert!(!is_read_only(&["config", "user.name", "x"]));
        assert!(!is_read_only(&["write-tree"]));
        assert!(!is_read_only(&["lfs", "track", "*.psd"]));
    }
}
