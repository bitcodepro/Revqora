//! Thin, safe wrapper around the `git` executable.
//!
//! Every call runs non-interactively (no pager, no prompts, no console window)
//! with stable, machine-readable output settings.

use std::ffi::OsStr;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
        GitError::new(format!("I/O error: {e}"))
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

pub fn git_exe() -> PathBuf {
    super::locate::exe()
}

/// Builds a configured `git` command rooted at `repo`.
pub fn command(repo: &Path) -> Command {
    let mut c = Command::new(git_exe());
    c.current_dir(repo);
    // Credentials and SSH passphrases are asked through Revqora's own dialog.
    for (k, v) in crate::askpass::env() {
        c.env(k, v);
    }
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
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn describe(args: &[&OsStr]) -> String {
    let mut s = String::from("git");
    for a in args.iter().take(4) {
        s.push(' ');
        s.push_str(&a.to_string_lossy());
    }
    s
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
    let has = |flag: &str| a.iter().any(|x| x == flag);
    match a.first().map(|s| s.as_str()).unwrap_or("") {
        "status" | "diff" | "log" | "show" | "rev-parse" | "cat-file" | "for-each-ref" | "ls-files" | "ls-tree" | "rev-list" | "merge-base" | "blame"
        | "symbolic-ref" | "diff-tree" | "diff-index" | "reflog" | "show-ref" | "check-ref-format" | "version" | "--version" | "ls-remote" | "describe"
        | "count-objects" | "name-rev" | "grep" | "check-ignore" => true,
        // Immutable object creation is safe concurrently; it does not modify refs,
        // the index or the working tree. An enclosing mutation still holds its gate.
        "hash-object" | "commit-tree" | "merge-tree" | "mktree" => true,
        "merge-file" => has("-p") || has("--stdout"),
        "remote" => a.len() == 1 || (a.len() == 2 && a[1] == "-v") || a.get(1).is_some_and(|s| s == "get-url"),
        "stash" => a.get(1).map(|s| s == "list").unwrap_or(false),
        "worktree" => a.get(1).map(|s| s == "list").unwrap_or(false),
        "submodule" => a.get(1).map(|s| s == "status").unwrap_or(false),
        "lfs" => matches!(a.get(1).map(|s| s.as_str()), Some("version" | "ls-files" | "track")) && a.len() == 2,
        "config" => has("--get") || has("--get-all") || has("--get-regexp") || has("-l") || has("--list"),
        "branch" => has("--contains") || has("--list"),
        _ => false,
    }
}

pub fn exec_full<I, S>(repo: &Path, args: I, env: &[(&str, &str)], input: Option<&[u8]>) -> GitResult<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<S> = args.into_iter().collect();
    super::operations::access(
        repo,
        !is_read_only(&args),
        |_, _| {},
        || {
            let diagnostic_args: Vec<String> = args.iter().map(|a| a.as_ref().to_string_lossy().into_owned()).collect();
            let mut capture = crate::journal::command(repo, &diagnostic_args);
            let result: GitResult<Output> = (|| {
                let mut c = command(repo);
                c.args(args.iter().map(|a| a.as_ref()));
                for (k, v) in env {
                    c.env(k, v);
                }
                c.stdout(Stdio::piped()).stderr(Stdio::piped());
                if input.is_some() {
                    c.stdin(Stdio::piped());
                }
                let mut child = c.spawn().map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        GitError::new("Git executable was not found. Install Git and make sure it is on PATH.").kind("git-missing")
                    } else {
                        GitError::from(e)
                    }
                })?;
                // Feed stdin on a separate thread so large inputs cannot deadlock with stdout.
                let writer = input.map(|data| {
                    let data = data.to_vec();
                    let mut stdin = child.stdin.take().expect("stdin piped");
                    std::thread::spawn(move || {
                        let _ = stdin.write_all(&data);
                    })
                });
                let mut stderr_pipe = child.stderr.take().expect("stderr piped");
                let err_thread = std::thread::spawn(move || {
                    let mut buf = Vec::new();
                    let _ = stderr_pipe.read_to_end(&mut buf);
                    buf
                });
                let mut stdout = Vec::new();
                child.stdout.take().expect("stdout piped").read_to_end(&mut stdout)?;
                let status = child.wait()?;
                if let Some(w) = writer {
                    let _ = w.join();
                }
                let stderr = String::from_utf8_lossy(&err_thread.join().unwrap_or_default()).into_owned();
                Ok(Output { stdout, stderr, code: status.code().unwrap_or(-1) })
            })();
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
    let stderr = out.stderr.trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut msg = clean_message(if stderr.is_empty() { &stdout } else { &stderr });
    if msg.is_empty() {
        msg = format!("{args_desc} failed with exit code {}", out.code);
    }
    let kind = classify(&format!("{stderr}\n{stdout}"));
    GitError { message: msg, stderr: format!("{stderr}\n{stdout}").trim().to_string(), code: Some(out.code), kind, details: Vec::new() }
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
    if l.contains("would be overwritten") || l.contains("your local changes") {
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
    super::operations::access(
        repo,
        !is_read_only(args),
        |_, _| {},
        || {
            let mut capture = crate::journal::command(repo, args);
            let result: GitResult<String> = (|| {
                let mut c = command(repo);
                c.args(args);
                for (k, v) in env {
                    c.env(k, v);
                }
                c.stdout(Stdio::piped()).stderr(Stdio::piped());
                let mut child = c.spawn().map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        GitError::new("Git executable was not found. Install Git and make sure it is on PATH.").kind("git-missing")
                    } else {
                        GitError::from(e)
                    }
                })?;
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
                            let line = String::from_utf8_lossy(buf).into_owned();
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
                let status = child.wait()?;
                let stdout = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).into_owned();
                let out = Output { stdout: stdout.clone().into_bytes(), stderr: collected.clone(), code: status.code().unwrap_or(-1) };
                if let Some(trace) = capture.as_mut() {
                    trace.finish(Some(out.code), &out.stdout, &out.stderr);
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
            })();
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
    fn classifies_read_only_commands() {
        assert!(is_read_only(&["status", "--porcelain=v2"]));
        assert!(is_read_only(&["stash", "list"]));
        assert!(is_read_only(&["config", "--get", "user.name"]));
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
