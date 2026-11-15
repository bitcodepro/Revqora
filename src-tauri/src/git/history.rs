//! Physical history for safety decisions: ignore local replacement objects and grafts.
use super::runner::{self, GitError, GitResult};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) fn require_actual_history(root: &Path) -> GitResult<()> {
    // Query the actual configured path before our per-command null override.
    let grafts = runner::run(root, ["rev-parse", "--git-path", "info/grafts"])?;
    if !run(root, ["for-each-ref", "--format=%(refname)", "refs/replace/"])?.trim().is_empty()
        || root.join(grafts.trim()).try_exists()?
        || std::env::var_os("GIT_REPLACE_REF_BASE").is_some()
        || std::env::var_os("GIT_GRAFT_FILE").is_some()
    {
        return Err(GitError::new("This operation requires original commit history. Local replacement refs, legacy grafts or history override environment variables are configured; use individual Git actions after reviewing their effects."));
    }
    Ok(())
}

/// An ephemeral command-scoped remote has no fetch mappings. Git must not
/// opportunistically update configured refs before our checks (Git 2.56+).
pub(super) fn isolated_remote(root: &Path, url: &str) -> GitResult<(Vec<String>, String)> {
    static IDS: AtomicU64 = AtomicU64::new(0);
    let name = format!("revqora-remote-{}-{}", std::process::id(), IDS.fetch_add(1, Ordering::Relaxed));
    if run(root, ["remote"])?.lines().any(|n| n == name) || exec(root, ["config", "--get-all", &format!("remotes.{name}")])?.code != 1 {
        return Err(GitError::new("Cannot allocate an isolated Git transport."));
    }
    let args = vec!["-c".into(), format!("remote.{name}.url={url}"), "-c".into(), format!("remote.{name}.pushurl={url}")];
    // Reject a second URL rewrite or an existing remote used as a URL alias.
    // `remote get-url` does not recognize command-scoped remotes on older
    // supported Git versions. ls-remote --get-url resolves fetch rewriting
    // without contacting the server; explicit pushurl disables pushInsteadOf.
    let mut check = args.clone();
    check.extend(["ls-remote".into(), "--get-url".into(), "--".into(), name.clone()]);
    if run(root, &check)?.lines().collect::<Vec<_>>() != vec![url] {
        return Err(GitError::new("URL rewriting makes the remote destination ambiguous."));
    }
    Ok((args, name))
}

const ENV: [(&str, &str); 2] = [("GIT_NO_REPLACE_OBJECTS", "1"), ("GIT_GRAFT_FILE", if cfg!(windows) { "NUL" } else { "/dev/null" })];
pub fn run<I, S>(root: &Path, args: I) -> GitResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    runner::run_env(root, args, &ENV, None)
}
pub(super) fn run_with_input<I, S>(root: &Path, args: I, input: &[u8]) -> GitResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    runner::run_env(root, args, &ENV, Some(input))
}

pub fn exec<I, S>(root: &Path, args: I) -> GitResult<runner::Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    runner::exec_full(root, args, &ENV, None)
}
