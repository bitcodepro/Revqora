//! Mutating operations: staging, committing, branches, merge/rebase/cherry-pick,
//! history rewriting, stash and remotes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::repo;
use super::runner::{self, GitError, GitResult};
use super::status;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpOutcome {
    /// "done" | "conflicts" | "stopped" | "upToDate" | "fastForward" | "pending"
    pub status: String,
    pub conflicts: Vec<String>,
    pub message: String,
}

impl OpOutcome {
    fn done(message: impl Into<String>) -> Self {
        OpOutcome { status: "done".into(), conflicts: Vec::new(), message: message.into() }
    }
}

fn temp_file(repo: &Path, name: &str, content: &str) -> GitResult<PathBuf> {
    let dir = super::storage::dir(repo)?;
    std::fs::create_dir_all(&dir)?;
    let p = dir.join(name);
    std::fs::write(&p, content)?;
    Ok(p)
}

fn sh_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''")
}

fn nul_join(paths: &[String]) -> Vec<u8> {
    let mut v = Vec::new();
    for p in paths {
        v.extend_from_slice(p.as_bytes());
        v.push(0);
    }
    v
}

/// Runs a git command that takes a pathspec list via stdin (avoids command line limits).
fn with_paths(repo: &Path, args: &[&str], paths: &[String]) -> GitResult<String> {
    if paths.is_empty() {
        return Ok(String::new());
    }
    let mut a: Vec<&str> = args.to_vec();
    a.push("--pathspec-from-file=-");
    a.push("--pathspec-file-nul");
    runner::run_env(repo, &a, &[("GIT_LITERAL_PATHSPECS", "1")], Some(&nul_join(paths)))
}

fn conflicted(repo: &Path) -> Vec<String> {
    status::status(repo).map(|s| s.files.into_iter().filter(|f| f.conflict.is_some()).map(|f| f.path).collect()).unwrap_or_default()
}

fn head_oid(repo: &Path) -> Option<String> {
    runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD"]).ok().filter(|o| o.ok()).map(|o| o.text().trim().to_string())
}

// ───────────────────────────── working copy ─────────────────────────────

pub fn stage_paths(repo: &Path, paths: &[String]) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    if paths.iter().any(|p| Path::new(p).components().any(|c| !matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir))) {
        return Err(GitError::new("Stage paths must be inside the repository."));
    }
    // A plain `git add` silently embeds an unregistered child as a gitlink.
    // Check all selections before adding anything, including Stage all / folders.
    let selected: Vec<_> = paths.iter().filter_map(|p| std::fs::canonicalize(repo.join(p)).ok()).collect();
    let raw = runner::run(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])?;
    // A deliberately configured submodule may have been unstaged; allow it to
    // be staged again, instead of treating it as an accidental embedded repo.
    let registered = if repo.join(".gitmodules").is_file() {
        let config = runner::exec(repo, ["config", "--file", ".gitmodules", "--null", "--get-regexp", r"^submodule\..*\.path$"])?;
        if config.code != 0 && config.code != 1 {
            return Err(runner::to_error("Read .gitmodules", &config));
        }
        config.text().split('\0').filter_map(|r| r.split_once('\n')).filter_map(|(_, p)| std::fs::canonicalize(repo.join(p)).ok()).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    for file in status::parse(&raw).files.into_iter().filter(|f| f.untracked && f.path.ends_with('/')) {
        let child = repo.join(&file.path);
        if child.join(".git").exists() {
            if let Ok(child) = std::fs::canonicalize(child) {
                if !registered.contains(&child) && selected.iter().any(|p| child.starts_with(p)) {
                    return Err(GitError::new(format!("Nested repository {} was not staged. Open it separately, ignore it in the parent, or add it explicitly as a submodule. No selected paths were staged.", file.path)).kind("nested-repository"));
                }
            }
        }
    }
    with_paths(repo, &["add", "-A"], paths)?;
    Ok(())
}

/// Moves paths back out of the index to `base` (HEAD, or the top stage layer).
pub fn unstage_paths(repo: &Path, paths: &[String], base: Option<&str>) -> GitResult<()> {
    match base.map(|s| s.to_string()).or_else(|| head_oid(repo)) {
        Some(b) => {
            let src = format!("--source={b}");
            with_paths(repo, &["restore", "--staged", &src], paths)?;
        }
        None => {
            with_paths(repo, &["rm", "--cached", "-r", "-q", "--ignore-unmatch"], paths)?;
        }
    }
    Ok(())
}

/// Copies files into portable `data/repositories/<id>/trash/<time>/` before destructive operations.
pub fn backup_files(repo: &Path, paths: &[String]) -> GitResult<PathBuf> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dir = super::storage::dir(repo)?.join("trash").join(ts.to_string());
    for p in paths {
        let src = repo.join(p);
        if src.is_file() {
            let dst = dir.join(p);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(dir)
}

pub fn discard_paths(repo: &Path, tracked: &[String], untracked: &[String]) -> GitResult<String> {
    let mut all = tracked.to_vec();
    all.extend_from_slice(untracked);
    let backup = backup_files(repo, &all)?;
    if !tracked.is_empty() {
        with_paths(repo, &["restore", "--worktree"], tracked)?;
    }
    for p in untracked {
        let full = repo.join(p);
        if full.is_dir() {
            std::fs::remove_dir_all(&full)?;
        } else if full.exists() {
            std::fs::remove_file(&full)?;
        }
    }
    Ok(backup.to_string_lossy().into_owned())
}

// ───────────────────────────── commit ─────────────────────────────

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub no_verify: bool,
    #[serde(default)]
    pub sign_off: bool,
    #[serde(default)]
    pub allow_empty: bool,
    /// Some(true) = sign (-S), Some(false) = never sign, None = follow commit.gpgsign.
    #[serde(default)]
    pub sign: Option<bool>,
}

pub fn commit(repo: &Path, message: &str, opts: &CommitOptions) -> GitResult<String> {
    let gd = repo::git_dir(repo)?;
    let state = repo::op_state(repo, &gd);
    if state.kind != "none" && !(state.kind == "rebase" && opts.amend) {
        return Err(GitError::new(format!("Use the explicit confirmation for the current {} operation.", state.kind)).kind("operation-in-progress"));
    }
    commit_confirmed(repo, message, opts)
}

/// Called only after an explicit merge confirmation, or the ordinary commit guard.
fn commit_confirmed(repo: &Path, message: &str, opts: &CommitOptions) -> GitResult<String> {
    if message.trim().is_empty() && !opts.amend {
        return Err(GitError::new("Commit message is empty."));
    }
    let file = temp_file(repo, "COMMIT_MSG", message)?;
    let fp = file.to_string_lossy().into_owned();
    let mut args = vec!["commit", "-F", fp.as_str(), "--cleanup=strip"];
    if opts.amend {
        args.push("--amend");
    }
    if opts.no_verify {
        args.push("--no-verify");
    }
    if opts.sign_off {
        args.push("--signoff");
    }
    if opts.allow_empty {
        args.push("--allow-empty");
    }
    match opts.sign {
        Some(true) => args.push("-S"),
        Some(false) => args.push("--no-gpg-sign"),
        None => {}
    }
    runner::run(repo, &args)?;
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_file(super::storage::dir(repo)?.join("squash-target"));
    Ok(head_oid(repo).unwrap_or_default())
}

pub fn last_message(repo: &Path) -> GitResult<String> {
    runner::run(repo, ["log", "-1", "--format=%B"]).map(|s| s.trim_end().to_string())
}

// ───────────────────────────── branches & tags ─────────────────────────────

pub fn checkout(repo: &Path, target: &str, kind: &str) -> GitResult<String> {
    match kind {
        "remote" => {
            // origin/feature → local feature tracking origin/feature
            let local = target.split_once('/').map(|(_, b)| b).unwrap_or(target);
            let exists = runner::exec(repo, ["show-ref", "--verify", "--quiet", &format!("refs/heads/{local}")])?.ok();
            if exists {
                runner::run(repo, ["switch", "--no-overwrite-ignore", local])?;
            } else {
                runner::run(repo, ["switch", "--no-overwrite-ignore", "-c", local, "--track", target])?;
            }
            Ok(local.to_string())
        }
        "commit" => {
            runner::run(repo, ["switch", "--no-overwrite-ignore", "--detach", target])?;
            Ok(target.to_string())
        }
        _ => {
            runner::run(repo, ["switch", "--no-overwrite-ignore", target])?;
            Ok(target.to_string())
        }
    }
}

pub fn create_branch(repo: &Path, name: &str, start: Option<&str>, checkout: bool) -> GitResult<()> {
    let name = name.trim();
    runner::run(repo, ["check-ref-format", "--branch", name]).map_err(|_| GitError::new(format!("'{name}' is not a valid branch name.")))?;
    let mut args = if checkout { vec!["switch", "--no-overwrite-ignore", "-c", name] } else { vec!["branch", name] };
    if let Some(s) = start {
        if checkout && s.contains('/') && runner::exec(repo, ["show-ref", "--verify", "--quiet", &format!("refs/remotes/{s}")])?.ok() {
            args.push("--no-track");
        }
        args.push(s);
    }
    runner::run(repo, &args)?;
    Ok(())
}

pub fn rename_branch(repo: &Path, old: &str, new: &str) -> GitResult<()> {
    runner::run(repo, ["branch", "-m", old, new.trim()])?;
    Ok(())
}

pub fn delete_branch(repo: &Path, name: &str, force: bool) -> GitResult<()> {
    // Keep the tip so "Recently deleted branches" can bring it back.
    let _ = super::more::record_deleted(repo, name);
    let out = runner::exec(repo, ["branch", if force { "-D" } else { "-d" }, name])?;
    if !out.ok() {
        let e = runner::to_error("git branch -d", &out);
        if out.stderr.contains("not fully merged") {
            return Err(e.kind("not-merged"));
        }
        return Err(e);
    }
    Ok(())
}

pub fn set_upstream(repo: &Path, branch: &str, upstream: Option<&str>) -> GitResult<()> {
    match upstream {
        Some(u) => runner::run(repo, ["branch", &format!("--set-upstream-to={u}"), branch])?,
        None => runner::run(repo, ["branch", "--unset-upstream", branch])?,
    };
    Ok(())
}

pub fn create_tag(repo: &Path, name: &str, target: &str, message: Option<&str>) -> GitResult<()> {
    match message.filter(|m| !m.trim().is_empty()) {
        Some(m) => {
            let f = temp_file(repo, "TAG_MSG", m)?;
            runner::run(repo, ["tag", "-a", name.trim(), "-F", &f.to_string_lossy(), target])?;
        }
        None => {
            runner::run(repo, ["tag", name.trim(), target])?;
        }
    }
    Ok(())
}

pub fn delete_tag(repo: &Path, name: &str) -> GitResult<()> {
    runner::run(repo, ["tag", "-d", name])?;
    Ok(())
}

pub fn reset(repo: &Path, target: &str, mode: &str) -> GitResult<()> {
    let flag = match mode {
        "soft" => "--soft",
        "hard" => "--hard",
        "keep" => "--keep",
        _ => "--mixed",
    };
    runner::run(repo, ["reset", flag, target])?;
    Ok(())
}

/// Undoes the last commit keeping its changes staged.
pub fn undo_last_commit(repo: &Path) -> GitResult<()> {
    let parent = runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD~1"])?;
    if parent.ok() {
        runner::run(repo, ["reset", "--soft", "HEAD~1"])?;
    } else {
        // Root commit: unborn branch again, index untouched.
        runner::run(repo, ["update-ref", "-d", "HEAD"])?;
    }
    Ok(())
}

// ───────────────────────────── remotes ─────────────────────────────

pub fn fetch(repo: &Path, remote: Option<&str>, prune: bool, on_line: impl FnMut(&str)) -> GitResult<String> {
    super::recovery::protect_transport(repo, false, remote, None, true)?;
    let mut args = vec!["fetch".to_string(), "--progress".into()];
    match remote {
        Some(r) => args.push(r.into()),
        None => args.push("--all".into()),
    }
    if prune {
        args.push("--prune".into());
    }
    args.push("--tags".into());
    runner::run_streaming(repo, &args, &[], on_line)
}

/// Environment for fetches nobody is watching: no askpass helpers (git's or Revqora's), no
/// terminal prompts, no interactive credential manager, ssh in batch mode, and stalled HTTP
/// transfers give up. Missing or expired credentials then fail fast instead of asking.
pub fn background_env(ssh_configured: bool) -> Vec<(&'static str, &'static str)> {
    let mut env = vec![
        ("GIT_ASKPASS", ""),
        ("SSH_ASKPASS", ""),
        ("SSH_ASKPASS_REQUIRE", "never"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GCM_INTERACTIVE", "never"),
        ("GIT_CONFIG_COUNT", "2"),
        ("GIT_CONFIG_KEY_0", "credential.interactive"),
        ("GIT_CONFIG_VALUE_0", "never"),
        ("GIT_CONFIG_KEY_1", "core.askPass"),
        ("GIT_CONFIG_VALUE_1", ""),
        ("GIT_HTTP_LOW_SPEED_LIMIT", "1000"),
        ("GIT_HTTP_LOW_SPEED_TIME", "30"),
    ];
    // Keep a user's own ssh command; without one, force batch mode (no passphrase prompts).
    if !ssh_configured {
        env.push(("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=20"));
    }
    env
}

/// Quiet periodic fetch of all remotes; never shows a credential prompt.
pub fn fetch_background(repo: &Path) -> GitResult<String> {
    super::recovery::protect_transport(repo, false, None, None, true)?;
    let ssh_configured = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || runner::run(repo, ["config", "--get", "core.sshCommand"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    runner::run_env(repo, ["fetch", "--all", "--prune", "--tags", "--quiet"], &background_env(ssh_configured), None)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingUpstream {
    pub branch: String,
    pub remote: String,
    pub reference: String,
    pub default_branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    #[serde(flatten)]
    pub operation: OpOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_gone: Option<MissingUpstream>,
}
impl std::ops::Deref for PullOutcome {
    type Target = OpOutcome;
    fn deref(&self) -> &Self::Target {
        &self.operation
    }
}
impl From<OpOutcome> for PullOutcome {
    fn from(operation: OpOutcome) -> Self {
        Self { operation, upstream_gone: None }
    }
}

fn pull_can_prune(repo: &Path, remote: &str) -> GitResult<bool> {
    let specs = runner::exec(repo, ["config", "--get-all", &format!("remote.{remote}.fetch")])?;
    if !specs.ok() && specs.code != 1 {
        return Err(runner::to_error("git config remote fetch", &specs));
    }
    // Git also prunes destinations such as refs/tags/* when they occur in a
    // configured refspec. Automatic cleanup is limited to remote-cache refs.
    let text = specs.text();
    Ok(!text.trim().is_empty() && text.lines().all(|s| s.starts_with('^') || s.split_once(':').is_some_and(|(_, target)| target.starts_with("refs/remotes/"))))
}

fn missing_pull_upstream(error: &GitError, reference: &str) -> bool {
    error.message.contains("no such ref was fetched") || error.stderr.lines().any(|line| line.trim() == format!("fatal: couldn't find remote ref {reference}"))
}

fn deleted_pull_upstream(repo: &Path, branch: &str, remote: &str, reference: &str) -> GitResult<Option<PullOutcome>> {
    if !reference.starts_with("refs/heads/") || !runner::exec(repo, ["check-ref-format", reference])?.ok() {
        return Ok(None);
    }
    // A missing FETCH_HEAD candidate can also mean a restricted fetch refspec.
    // Confirm absence against the server; never infer deletion from a stale cache.
    let advertised = runner::exec(repo, ["ls-remote", "--symref", "--", remote, "HEAD", reference])?;
    if !advertised.ok() {
        return Err(runner::to_error("git ls-remote (verify upstream)", &advertised));
    }
    let text = advertised.text();
    if text.lines().any(|line| line.split_once('\t').is_some_and(|(_, name)| name == reference)) {
        return Ok(None);
    }
    // Also reconcile this one remote-cache ref when a custom tag/local refspec
    // made broad pruning unsafe. Verify its mapping and compare its old SHA.
    let mapping =
        runner::run(repo, ["for-each-ref", "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)", &format!("refs/heads/{branch}")])?;
    let parts: Vec<_> = mapping.trim().split('\0').collect();
    if parts.len() == 3 && parts[0].starts_with("refs/remotes/") && parts[1] == remote && parts[2] == reference {
        let old = runner::exec(repo, ["rev-parse", "--verify", "--end-of-options", parts[0]])?;
        if old.ok() {
            runner::run(repo, ["update-ref", "--no-deref", "-d", parts[0], old.text().trim()])?;
        }
    }
    let default_branch = text.lines().find_map(|line| {
        let (target, name) = line.split_once('\t')?;
        (name == "HEAD").then(|| target.strip_prefix("ref: refs/heads/")).flatten().map(str::to_owned)
    });
    Ok(Some(PullOutcome {
        operation: OpOutcome {
            status: "upstreamGone".into(),
            conflicts: Vec::new(),
            message: format!("Upstream {reference} is no longer available from {remote}. Its absence was verified with the server and stale tracking references were reconciled. Local branch {branch} and its working changes are kept; no merge was performed."),
        },
        upstream_gone: Some(MissingUpstream { branch: branch.into(), remote: remote.into(), reference: reference.into(), default_branch }),
    }))
}

pub fn pull(repo: &Path, mode: &str, mut on_line: impl FnMut(&str)) -> GitResult<PullOutcome> {
    super::recovery::protect_transport(repo, false, None, None, false)?;
    let before = status::status(repo)?;
    let branch = before.branch.as_deref().ok_or_else(|| GitError::new("Choose a branch with an upstream before pulling."))?;
    let config_key = format!("branch.{branch}.merge");
    let merges = runner::exec(repo, ["config", "--get-all", &config_key])?;
    let merge_text = merges.text();
    let configured: Vec<_> = merge_text.lines().filter(|s| !s.is_empty()).collect();
    if !merges.ok() || configured.len() != 1 {
        return Err(GitError::new("Configure one upstream for this branch before pulling."));
    }
    let remote_key = format!("branch.{branch}.remote");
    let remote_config = runner::exec(repo, ["config", "--get", &remote_key])?;
    if !remote_config.ok() && remote_config.code != 1 {
        return Err(runner::to_error("git config branch remote", &remote_config));
    }
    let remote = if remote_config.ok() { remote_config.text() } else { "origin".into() };
    let remote = remote.trim();
    let prune = pull_can_prune(repo, remote)?;
    let index_before = runner::run_bytes(repo, ["ls-files", "--stage", "-v", "-z"])?;
    let unchanged = || -> GitResult<bool> {
        let after = status::status(repo)?;
        Ok(before.branch == after.branch
            && before.oid == after.oid
            && before.files == after.files
            && before.diff_context_token == after.diff_context_token
            && runner::exec(repo, ["config", "--get-all", &config_key])?.text() == merge_text
            && runner::exec(repo, ["config", "--get", &remote_key])?.text() == remote_config.text()
            && index_before == runner::run_bytes(repo, ["ls-files", "--stage", "-v", "-z"])?)
    };
    if mode != "rebase" {
        // Parse before fetching/merging, including Git's yes/on/1 spellings.
        // Invalid configuration must fail before a partially completed pull.
        let recurse = runner::exec(repo, ["config", "--bool", "--get", "submodule.recurse"])?;
        if !recurse.ok() && recurse.code != 1 {
            return Err(runner::to_error("git config submodule.recurse", &recurse));
        }
        let recurse = recurse.ok() && recurse.text().trim() == "true";
        // Fetch cannot confirm a merge or overwrite working files. Resolve the
        // fetched upstream only after it succeeds, then use our reviewed merge
        // path (including ignored-file protection and explicit commit control).
        let fetched = runner::run_streaming(
            repo,
            &[
                "fetch".into(),
                "--progress".into(),
                if prune { "--prune" } else { "--no-prune" }.into(),
                "--no-prune-tags".into(),
                "--write-fetch-head".into(),
                remote.into(),
            ],
            &[],
            &mut on_line,
        );
        // Authentication/network failures remain failures. Only a precise
        // missing-ref report is eligible for a second server-side check.
        if let Err(error) = &fetched {
            if !missing_pull_upstream(error, configured[0]) {
                return Err(error.clone());
            }
        }
        if !unchanged()? {
            return Err(GitError::new(
                "Pull stopped because the working tree, current branch or upstream configuration changed. Review it before pulling again.",
            )
            .kind("stale-operation"));
        }
        if let Err(error) = fetched {
            if repo::op_state(repo, &repo::git_dir(repo)?).kind == "none" {
                if let Some(outcome) = deleted_pull_upstream(repo, branch, remote, configured[0])? {
                    return Ok(outcome);
                }
            }
            return Err(error);
        }
        let raw = std::fs::read_to_string(repo::git_dir(repo)?.join("FETCH_HEAD"))?;
        let targets: Vec<_> = raw
            .lines()
            .filter_map(|line| {
                let mut fields = line.splitn(3, '\t');
                let oid = fields.next()?;
                let merge = fields.next()?;
                (merge.is_empty() && matches!(oid.len(), 40 | 64) && oid.bytes().all(|c| c.is_ascii_hexdigit())).then_some(oid)
            })
            .collect();
        if targets.len() != 1 {
            if targets.is_empty() {
                if let Some(outcome) = deleted_pull_upstream(repo, branch, remote, configured[0])? {
                    return Ok(outcome);
                }
            }
            return Err(GitError::new(format!("Fetch completed, but upstream {} on {remote} was not fetched unambiguously. Check the remote's fetch refspecs. Local branch {branch} was not merged.", configured[0])).kind("upstream-not-fetched"));
        }
        let mut outcome = merge_start_with_autostash(repo, targets[0], if mode == "merge" { "ff" } else { "ff-only" }, mode == "merge")?;
        if recurse && outcome.status != "conflicts" {
            // Native `git pull` does this after a successful merge, including
            // --no-commit. No --init or --force: preserve uninitialized modules
            // and let checkout reject dirty tracked/untracked collisions.
            let args = ["submodule", "update", "--recursive", "--checkout"].map(String::from);
            match runner::run_streaming(repo, &args, &[], &mut on_line) {
                Ok(output) => {
                    if !output.trim().is_empty() {
                        outcome.message.push('\n');
                        outcome.message.push_str(output.trim());
                    }
                }
                Err(mut error) => {
                    error.message = format!("Pull integrated the parent repository, but updating submodules failed. Inspect its current state before retrying; the parent update has not been rolled back. {}", error.message);
                    error.kind = "partial-operation".into();
                    error.details.push(format!("parent_head_before={}", before.oid.as_deref().unwrap_or("unborn")));
                    error.details.push(format!("parent_head_after={}", head_oid(repo).as_deref().unwrap_or("unborn")));
                    error.details.push(format!("parent_outcome={}", outcome.status));
                    return Err(error);
                }
            }
        }
        return Ok(outcome.into());
    }
    let mut args = vec![
        "-c".into(),
        "fetch.all=false".into(),
        "-c".into(),
        format!("fetch.prune={prune}"),
        "-c".into(),
        format!("remote.{remote}.prune={prune}"),
        "-c".into(),
        "fetch.pruneTags=false".into(),
        "-c".into(),
        format!("remote.{remote}.pruneTags=false"),
        "pull".into(),
        "--progress".into(),
    ];
    match mode {
        "rebase" => {
            args.push("--rebase".into());
            args.push("--autostash".into());
        }
        "merge" => {
            args.push("--no-rebase".into());
            args.push("--autostash".into());
        }
        _ => args.push("--ff-only".into()),
    }
    // Pruning was reviewed only for this remote. A configured fetch.all must
    // never expand Pull to other remotes with unreviewed destination refspecs.
    args.push("--".into());
    args.push(remote.into());
    match runner::run_streaming(repo, &args, &[], on_line) {
        Ok(out) => Ok(OpOutcome::done(out).into()),
        Err(e) => {
            let c = conflicted(repo);
            if !c.is_empty() {
                Ok(OpOutcome { status: "conflicts".into(), conflicts: c, message: e.message }.into())
            } else {
                if missing_pull_upstream(&e, configured[0]) && unchanged()? && repo::op_state(repo, &repo::git_dir(repo)?).kind == "none" {
                    if let Some(outcome) = deleted_pull_upstream(repo, branch, remote, configured[0])? {
                        return Ok(outcome);
                    }
                }
                Err(e)
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PushOptions {
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub remote_branch: Option<String>,
    #[serde(default)]
    pub set_upstream: bool,
    #[serde(default)]
    pub force_with_lease: bool,
    #[serde(default)]
    pub tags: bool,
}

pub fn push(repo: &Path, o: &PushOptions, on_line: impl FnMut(&str)) -> GitResult<String> {
    let explicit = o.remote.as_ref().and(o.branch.as_ref()).map(|b| format!("refs/heads/{b}:refs/heads/{}", o.remote_branch.as_deref().unwrap_or(b)));
    super::recovery::protect_transport(repo, true, o.remote.as_deref(), explicit.as_deref(), false)?;
    let mut args = vec!["push".to_string(), "--progress".into()];
    if o.set_upstream {
        args.push("--set-upstream".into());
    }
    if o.force_with_lease {
        args.push("--force-with-lease".into());
    }
    if o.tags {
        args.push("--tags".into());
    }
    if let Some(r) = &o.remote {
        args.push(r.clone());
        if let Some(b) = &o.branch {
            let rb = o.remote_branch.clone().unwrap_or_else(|| b.clone());
            args.push(format!("refs/heads/{b}:refs/heads/{rb}"));
        }
    }
    runner::run_streaming(repo, &args, &[], on_line)
}

pub fn push_ref(repo: &Path, remote: &str, refspec: &str, on_line: impl FnMut(&str)) -> GitResult<String> {
    if refspec.starts_with('-') {
        return Err(GitError::new("Choose an explicit branch or tag refspec."));
    }
    super::recovery::protect_transport(repo, true, Some(remote), Some(refspec), false)?;
    runner::run_streaming(repo, &["push".into(), "--progress".into(), remote.into(), refspec.into()], &[], on_line)
}

pub fn clone(parent: &Path, url: &str, dir_name: &str, on_line: impl FnMut(&str)) -> GitResult<PathBuf> {
    std::fs::create_dir_all(parent)?;
    runner::run_streaming(parent, &["clone".into(), "--progress".into(), url.into(), dir_name.into()], &[], on_line)?;
    Ok(parent.join(dir_name))
}

pub fn remote_add(repo: &Path, name: &str, url: &str) -> GitResult<()> {
    runner::run(repo, ["remote", "add", name.trim(), url.trim()])?;
    Ok(())
}

pub fn remote_remove(repo: &Path, name: &str) -> GitResult<()> {
    runner::run(repo, ["remote", "remove", name])?;
    Ok(())
}

pub fn remote_set_url(repo: &Path, name: &str, url: &str) -> GitResult<()> {
    runner::run(repo, ["remote", "set-url", name, url.trim()])?;
    Ok(())
}

// ───────────────────────────── merge ─────────────────────────────

fn guard_ignored_merge(repo: &Path, target: &str, head: Option<&str>) -> GitResult<()> {
    // Some merge-ort versions overwrite ignored collisions even with
    // --no-overwrite-ignore (unlike switch / the fast-forward checkout path).
    // Inspect collapsed ignored folders, without scanning their build caches.
    let ignored = super::workspace_files::ignored(repo)?;
    if ignored.truncated {
        return Err(GitError::new("Ignored-file inspection was truncated; no merge was started."));
    }
    if ignored.paths.is_empty() {
        return Ok(());
    }
    let target = runner::run(repo, ["rev-parse", "--verify", "--end-of-options", &format!("{target}^{{commit}}")])?;
    let target = target.trim();
    let paths = match head {
        Some(head) => runner::run(repo, ["diff", "--name-only", "--no-renames", "--diff-filter=ACMRT", "-z", head, target, "--"]),
        None => runner::run(repo, ["ls-tree", "-r", "-z", "--name-only", target]),
    }?;
    let ignore_case = cfg!(windows) || runner::exec(repo, ["config", "--bool", "--get", "core.ignorecase"])?.text().trim() == "true";
    let normalize = |p: &str| {
        let p = p.trim_end_matches('/');
        if ignore_case {
            p.to_lowercase()
        } else {
            p.to_owned()
        }
    };
    let ignored: std::collections::BTreeSet<_> = ignored.paths.iter().map(|p| normalize(p)).collect();
    for path in paths.split('\0').filter(|p| !p.is_empty()) {
        let p = normalize(path);
        let prefix = format!("{p}/");
        let ancestor = p.match_indices('/').any(|(index, _)| ignored.contains(&p[..index]));
        let descendant = ignored.range(prefix.clone()..).next().is_some_and(|i| i.starts_with(&prefix));
        if ignored.contains(&p) || ancestor || descendant {
            return Err(GitError::new(format!(
                "Merge may overwrite ignored data at {path}. Move the overlapping ignored file or folder aside before merging."
            )));
        }
    }
    Ok(())
}

/// Starts a merge but never creates the merge commit: the user reviews and confirms.
pub fn merge_start(repo: &Path, target: &str, strategy: &str) -> GitResult<OpOutcome> {
    merge_start_with_autostash(repo, target, strategy, false)
}

fn merge_start_with_autostash(repo: &Path, target: &str, strategy: &str, autostash: bool) -> GitResult<OpOutcome> {
    let gd = repo::git_dir(repo)?;
    let before = head_oid(repo);
    guard_ignored_merge(repo, target, before.as_deref())?;
    // Branch mergeOptions are defaults, not the user's reviewed mode. In
    // particular an inherited --squash must not turn a fast-forward into staged
    // edits, and an inherited --commit must never confirm a merge for the user.
    let mut args: Vec<&str> = vec!["merge", "--no-squash", "--no-commit", "--no-overwrite-ignore"];
    if autostash {
        args.push("--autostash");
    }
    match strategy {
        "squash" => args.push("--squash"),
        "ff" => {
            args.push("--ff");
            args.push("--no-commit");
        }
        "ff-only" => args.push("--ff-only"),
        _ => {
            args.push("--no-ff");
            args.push("--no-commit");
        }
    }
    args.push(target);
    let out = runner::exec(repo, &args)?;
    let text = format!("{}\n{}", out.text(), out.stderr);
    if text.contains("Already up to date") || text.contains("Already up-to-date") {
        return Ok(OpOutcome { status: "upToDate".into(), conflicts: Vec::new(), message: format!("Already up to date with {target}.") });
    }
    let merging = gd.join("MERGE_HEAD").exists();
    let conflicts = conflicted(repo);
    if strategy == "squash" && (out.ok() || !conflicts.is_empty()) {
        std::fs::write(super::storage::dir(repo)?.join("squash-target"), target)?;
        return Ok(OpOutcome {
            status: if conflicts.is_empty() { "pending".into() } else { "conflicts".into() },
            conflicts,
            message: format!("Squashed changes of {target} are staged."),
        });
    }
    if merging {
        return Ok(OpOutcome {
            status: if conflicts.is_empty() { "pending".into() } else { "conflicts".into() },
            conflicts,
            message: format!("Merging {target}."),
        });
    }
    if out.ok() && head_oid(repo) != before {
        return Ok(OpOutcome { status: "fastForward".into(), conflicts: Vec::new(), message: format!("Fast-forwarded to {target}.") });
    }
    if out.ok() {
        return Ok(OpOutcome::done(text.trim().to_string()));
    }
    Err(runner::to_error("git merge", &out))
}

pub fn abort_op(repo: &Path, kind: &str) -> GitResult<()> {
    let gd = repo::git_dir(repo)?;
    match kind {
        "merge" => {
            runner::run(repo, ["merge", "--abort"])?;
        }
        "squash" => {
            runner::run(repo, ["reset", "--merge"])?;
            let _ = std::fs::remove_file(gd.join("SQUASH_MSG"));
            let _ = std::fs::remove_file(super::storage::dir(repo)?.join("squash-target"));
        }
        "rebase" => {
            runner::run(repo, ["rebase", "--abort"])?;
        }
        "cherry-pick" => {
            runner::run(repo, ["cherry-pick", "--abort"])?;
        }
        "revert" => {
            runner::run(repo, ["revert", "--abort"])?;
        }
        "am" => {
            runner::run(repo, ["am", "--abort"])?;
        }
        _ => return Err(GitError::new("Nothing to abort.")),
    }
    Ok(())
}

/// Finishes a paused merge / cherry-pick / revert / rebase step.
pub fn continue_op(repo: &Path, kind: &str, message: Option<&str>) -> GitResult<OpOutcome> {
    let pending = conflicted(repo);
    if !pending.is_empty() {
        return Err(GitError::new(format!("{} file(s) still have conflicts.", pending.len())).kind("conflict").details(pending));
    }
    let gd = repo::git_dir(repo)?;
    match kind {
        "merge" | "squash" => {
            if repo::op_state(repo, &gd).kind != kind {
                return Err(GitError::new("The pending operation changed. Refresh before confirming.").kind("operation-in-progress"));
            }
            let msg = message
                .map(|m| m.to_string())
                .or_else(|| std::fs::read_to_string(gd.join(if kind == "merge" { "MERGE_MSG" } else { "SQUASH_MSG" })).ok())
                .unwrap_or_else(|| "Merge".into());
            let oid = commit_confirmed(repo, &msg, &CommitOptions::default())?;
            Ok(OpOutcome::done(oid))
        }
        "cherry-pick" | "revert" | "rebase" | "am" => {
            if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
                if kind != "rebase" && kind != "am" {
                    std::fs::write(gd.join("MERGE_MSG"), m)?;
                }
            }
            let out = runner::exec(repo, [kind, "--continue"])?;
            if out.ok() {
                return Ok(OpOutcome::done(out.text()));
            }
            let c = conflicted(repo);
            if !c.is_empty() || repo::op_state(repo, &gd).kind != "none" {
                return Ok(OpOutcome { status: if c.is_empty() { "stopped".into() } else { "conflicts".into() }, conflicts: c, message: out.stderr });
            }
            Err(runner::to_error(&format!("git {kind} --continue"), &out))
        }
        _ => Err(GitError::new("No operation in progress.")),
    }
}

pub fn skip_op(repo: &Path, kind: &str) -> GitResult<OpOutcome> {
    let out = runner::exec(repo, [kind, "--skip"])?;
    let c = conflicted(repo);
    if out.ok() && c.is_empty() {
        return Ok(OpOutcome::done(out.text()));
    }
    if !c.is_empty() {
        return Ok(OpOutcome { status: "conflicts".into(), conflicts: c, message: out.stderr });
    }
    Err(runner::to_error(&format!("git {kind} --skip"), &out))
}

fn sequence_outcome(repo: &Path, out: runner::Output, what: &str) -> GitResult<OpOutcome> {
    if out.ok() {
        let gd = repo::git_dir(repo)?;
        let st = repo::op_state(repo, &gd);
        if st.kind == "rebase" {
            return Ok(OpOutcome { status: "stopped".into(), conflicts: Vec::new(), message: "Stopped for editing.".into() });
        }
        return Ok(OpOutcome::done(out.text()));
    }
    let c = conflicted(repo);
    if !c.is_empty() {
        return Ok(OpOutcome { status: "conflicts".into(), conflicts: c, message: out.stderr });
    }
    let gd = repo::git_dir(repo)?;
    if repo::op_state(repo, &gd).kind != "none" {
        return Ok(OpOutcome { status: "stopped".into(), conflicts: Vec::new(), message: out.stderr });
    }
    Err(runner::to_error(what, &out))
}

fn is_merge_commit(repo: &Path, oid: &str) -> bool {
    runner::run(repo, ["rev-list", "--parents", "-n", "1", oid]).map(|s| s.split_whitespace().count() > 2).unwrap_or(false)
}

pub fn cherry_pick(repo: &Path, oids: &[String], no_commit: bool) -> GitResult<OpOutcome> {
    let mut args: Vec<String> = vec!["cherry-pick".into()];
    if no_commit {
        args.push("--no-commit".into());
    }
    if oids.iter().any(|o| is_merge_commit(repo, o)) {
        args.push("-m".into());
        args.push("1".into());
    }
    args.extend(oids.iter().cloned());
    let out = runner::exec(repo, &args)?;
    sequence_outcome(repo, out, "git cherry-pick")
}

pub fn revert(repo: &Path, oid: &str, no_commit: bool) -> GitResult<OpOutcome> {
    let mut args: Vec<String> = vec!["revert".into(), "--no-edit".into()];
    if no_commit {
        args.push("--no-commit".into());
    }
    if is_merge_commit(repo, oid) {
        args.push("-m".into());
        args.push("1".into());
    }
    args.push(oid.into());
    let out = runner::exec(repo, &args)?;
    sequence_outcome(repo, out, "git revert")
}

pub fn rebase_onto(repo: &Path, upstream: &str) -> GitResult<OpOutcome> {
    let out = runner::exec(repo, ["rebase", "--autostash", upstream])?;
    sequence_outcome(repo, out, "git rebase")
}

// ───────────────────────────── history rewriting ─────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum RewriteAction {
    Reword { oid: String, message: String },
    Drop { oids: Vec<String> },
    Squash { oids: Vec<String>, message: String },
    Edit { oid: String },
    Move { oid: String, delta: i32 },
}

fn ensure_rewritable(repo: &Path, oldest: &str) -> GitResult<Option<String>> {
    let anc = runner::exec(repo, ["merge-base", "--is-ancestor", oldest, "HEAD"])?;
    if !anc.ok() {
        return Err(GitError::new("Only commits on the current branch can be edited."));
    }
    let parent = runner::exec(repo, ["rev-parse", "-q", "--verify", &format!("{oldest}^")])?;
    let base = if parent.ok() { Some(parent.text().trim().to_string()) } else { None };
    let range = match &base {
        Some(b) => format!("{b}..HEAD"),
        None => "HEAD".into(),
    };
    let merges = runner::run(repo, ["rev-list", "--merges", &range])?;
    if !merges.trim().is_empty() {
        return Err(GitError::new("The history after this commit contains merge commits; editing it would flatten them. Rebase manually instead."));
    }
    Ok(base)
}

/// Commits from `base` (exclusive) to HEAD, oldest first.
fn commits_since(repo: &Path, base: Option<&str>) -> GitResult<Vec<String>> {
    let range = match base {
        Some(b) => format!("{b}..HEAD"),
        None => "HEAD".into(),
    };
    Ok(runner::run(repo, ["rev-list", "--reverse", &range])?.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

fn run_todo(repo: &Path, base: Option<&str>, todo: &str) -> GitResult<OpOutcome> {
    run_todo_logged(repo, base, todo, None)
}
fn run_todo_logged(repo: &Path, base: Option<&str>, todo: &str, reflog: Option<&str>) -> GitResult<OpOutcome> {
    let file = temp_file(repo, "rebase-todo", todo)?;
    let editor = format!("cp '{}'", sh_path(&file));
    // The UI supplies an explicit todo. User defaults must not rewrite other
    // refs or silently rearrange that reviewed plan.
    let mut args = vec!["-c", "rebase.updateRefs=false", "-c", "rebase.autoSquash=false", "rebase", "-i", "--autostash", "--keep-empty", "--no-autosquash"];
    match base {
        Some(b) => args.push(b),
        None => args.push("--root"),
    }
    let mut env = vec![("GIT_SEQUENCE_EDITOR", editor.as_str())];
    if let Some(action) = reflog {
        env.push(("GIT_REFLOG_ACTION", action));
    }
    let out = runner::exec_full(repo, &args, &env, None)?;
    let res = sequence_outcome(repo, out, "git rebase -i");
    let _ = std::fs::remove_file(&file);
    res
}

fn full_oid(repo: &Path, rev: &str) -> GitResult<String> {
    Ok(runner::run(repo, ["rev-parse", "--verify", &format!("{rev}^{{commit}}")])?.trim().to_string())
}

pub fn rewrite(repo: &Path, action: &RewriteAction) -> GitResult<OpOutcome> {
    let gd = repo::git_dir(repo)?;
    if repo::op_state(repo, &gd).kind != "none" {
        return Err(GitError::new("Finish or abort the operation in progress first."));
    }
    let head = head_oid(repo).ok_or_else(|| GitError::new("There are no commits yet."))?;
    match action {
        RewriteAction::Reword { oid, message } => {
            let oid = full_oid(repo, oid)?;
            if message.trim().is_empty() {
                return Err(GitError::new("Commit message is empty."));
            }
            let msg_file = temp_file(repo, "REWORD_MSG", message)?;
            if oid == head {
                runner::run(repo, ["commit", "--amend", "--only", "--allow-empty", "--cleanup=strip", "-F", &msg_file.to_string_lossy()])?;
                return Ok(OpOutcome::done("Message updated."));
            }
            let base = ensure_rewritable(repo, &oid)?;
            let mut todo = String::new();
            for c in commits_since(repo, base.as_deref())? {
                todo.push_str(&format!("pick {c}\n"));
                if c == oid {
                    todo.push_str(&format!("exec git commit --amend --only --allow-empty --cleanup=strip -F '{}'\n", sh_path(&msg_file)));
                }
            }
            run_todo(repo, base.as_deref(), &todo)
        }
        RewriteAction::Drop { oids } => {
            let oids: Vec<String> = oids.iter().map(|o| full_oid(repo, o)).collect::<GitResult<_>>()?;
            let all = commits_since(repo, None)?;
            let oldest = all.iter().find(|c| oids.contains(c)).cloned().ok_or_else(|| GitError::new("Commit is not on the current branch."))?;
            let base = ensure_rewritable(repo, &oldest)?;
            let list = commits_since(repo, base.as_deref())?;
            let kept: Vec<&String> = list.iter().filter(|c| !oids.contains(c)).collect();
            if kept.is_empty() {
                // Dropping everything after base: a plain reset is equivalent.
                match &base {
                    Some(b) => runner::run(repo, ["reset", "--keep", b])?,
                    None => return Err(GitError::new("Cannot drop every commit of the branch.")),
                };
                return Ok(OpOutcome::done("Commits dropped."));
            }
            let todo: String = kept.iter().map(|c| format!("pick {c}\n")).collect();
            run_todo(repo, base.as_deref(), &todo)
        }
        RewriteAction::Squash { oids, message } => {
            if oids.len() < 2 {
                return Err(GitError::new("Select at least two commits to squash."));
            }
            let oids: Vec<String> = oids.iter().map(|o| full_oid(repo, o)).collect::<GitResult<_>>()?;
            let all = commits_since(repo, None)?;
            let positions: Vec<usize> = oids.iter().filter_map(|o| all.iter().position(|c| c == o)).collect();
            if positions.len() != oids.len() {
                return Err(GitError::new("All commits must be on the current branch."));
            }
            let (min, max) = (*positions.iter().min().unwrap(), *positions.iter().max().unwrap());
            if max - min + 1 != oids.len() {
                return Err(GitError::new("Squash needs a contiguous range of commits."));
            }
            let oldest = all[min].clone();
            let base = ensure_rewritable(repo, &oldest)?;
            let msg_file = temp_file(repo, "SQUASH_MSG_RQ", message)?;
            let mut todo = String::new();
            let newest = &all[max];
            for c in commits_since(repo, base.as_deref())? {
                if c == oldest {
                    todo.push_str(&format!("pick {c}\n"));
                } else if oids.contains(&c) {
                    todo.push_str(&format!("fixup {c}\n"));
                } else {
                    todo.push_str(&format!("pick {c}\n"));
                }
                if &c == newest {
                    todo.push_str(&format!("exec git commit --amend --only --allow-empty --cleanup=strip -F '{}'\n", sh_path(&msg_file)));
                }
            }
            run_todo(repo, base.as_deref(), &todo)
        }
        RewriteAction::Edit { oid } => {
            let oid = full_oid(repo, oid)?;
            let base = ensure_rewritable(repo, &oid)?;
            let todo: String =
                commits_since(repo, base.as_deref())?.iter().map(|c| if *c == oid { format!("edit {c}\n") } else { format!("pick {c}\n") }).collect();
            run_todo(repo, base.as_deref(), &todo)
        }
        RewriteAction::Move { oid, delta } => {
            let oid = full_oid(repo, oid)?;
            let all = commits_since(repo, None)?;
            let pos = all.iter().position(|c| *c == oid).ok_or_else(|| GitError::new("Commit is not on the current branch."))?;
            // delta > 0 moves the commit newer (up in the graph).
            let target = pos as i64 + *delta as i64;
            if target < 0 || target >= all.len() as i64 {
                return Err(GitError::new("Cannot move the commit further."));
            }
            let lo = pos.min(target as usize);
            let base = ensure_rewritable(repo, &all[lo])?;
            let mut list = commits_since(repo, base.as_deref())?;
            let p = list.iter().position(|c| *c == oid).unwrap();
            let item = list.remove(p);
            let np = (p as i64 + *delta as i64).clamp(0, list.len() as i64) as usize;
            list.insert(np, item);
            let todo: String = list.iter().map(|c| format!("pick {c}\n")).collect();
            run_todo(repo, base.as_deref(), &todo)
        }
    }
}

// ───────────────────────────── interactive rebase ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub oid: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    /// Parent of the oldest commit (None = the root commit is included).
    pub base: Option<String>,
    /// Oldest first, like a rebase todo list.
    pub commits: Vec<PlanCommit>,
}

/// Commits from `oldest` up to HEAD that an interactive rebase would rewrite.
pub fn rebase_plan(repo: &Path, oldest: &str) -> GitResult<RebasePlan> {
    let oldest = full_oid(repo, oldest)?;
    let base = ensure_rewritable(repo, &oldest)?;
    let commits = read_plan_commits(repo, base.as_deref(), "HEAD")?;
    Ok(RebasePlan { base, commits })
}

/// Read fixed snapshots without signature checks or record separators present in
/// ordinary commit text. Git commit messages cannot contain NUL bytes.
pub fn read_plan_commits(repo: &Path, base: Option<&str>, head: &str) -> GitResult<Vec<PlanCommit>> {
    let range = base.map(|b| format!("{b}..{head}")).unwrap_or_else(|| head.into());
    let raw = runner::run(
        repo,
        ["log", "--no-show-signature", "--no-notes", "--reverse", "--max-count=501", "--format=%H%x00%an%x00%at%x00%s%x00%b%x00", &range, "--"],
    )?;
    let fields: Vec<_> = raw.split('\0').collect();
    let mut commits = Vec::new();
    let (records, tail) = fields.as_chunks::<5>();
    if tail.iter().any(|field| !field.trim().is_empty()) {
        return Err(GitError::new("Cannot safely parse this commit range."));
    }
    for f in records {
        let oid = f[0].trim_start_matches(['\n', '\r']);
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(GitError::new("Cannot safely parse this commit range."));
        }
        commits.push(PlanCommit {
            oid: oid.into(),
            author: f[1].into(),
            time: f[2].parse().map_err(|_| GitError::new("Invalid commit timestamp."))?,
            subject: f[3].into(),
            body: f[4].trim().into(),
        });
    }
    if commits.len() > 500 {
        return Err(GitError::new("Choose at most 500 commits for an editable rebase plan."));
    }
    Ok(commits)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseItem {
    pub oid: String,
    /// "pick" | "reword" | "edit" | "squash" | "fixup" | "drop"
    pub action: String,
    /// New message for reword, or the combined message of a squash group (set on its first commit).
    pub message: Option<String>,
}

/// Builds the todo list for an interactive rebase (oldest first). Returns (todo, message files).
pub fn build_todo(repo: &Path, items: &[RebaseItem]) -> GitResult<String> {
    let mut todo = String::new();
    // Message to apply once the current group (head + following squash/fixup) is complete.
    let mut pending: Option<String> = None;
    let mut group_has_squash = false;
    let mut head_message: Option<String> = None;
    let mut seen_head = false;
    let mut n = 0;
    let mut flush = |todo: &mut String, pending: &mut Option<String>| -> GitResult<()> {
        if let Some(m) = pending.take() {
            n += 1;
            let f = temp_file(repo, &format!("ri-msg-{n}"), &m)?;
            todo.push_str(&format!("exec git commit --amend --only --allow-empty --cleanup=strip -F '{}'\n", sh_path(&f)));
        }
        Ok(())
    };
    for it in items {
        match it.action.as_str() {
            "drop" => {}
            "pick" | "reword" | "edit" => {
                // Close the previous group.
                if group_has_squash || pending.is_some() {
                    if group_has_squash && pending.is_none() {
                        pending = head_message.clone();
                    }
                    flush(&mut todo, &mut pending)?;
                }
                group_has_squash = false;
                seen_head = true;
                head_message = it.message.clone().filter(|m| !m.trim().is_empty());
                let verb = if it.action == "edit" { "edit" } else { "pick" };
                todo.push_str(&format!("{verb} {}\n", it.oid));
                if it.action == "reword" {
                    pending = Some(head_message.clone().ok_or_else(|| GitError::new("A reworded commit needs a message."))?);
                }
            }
            "squash" | "fixup" => {
                if !seen_head {
                    return Err(GitError::new("The first commit cannot be squashed: there is nothing before it to squash into."));
                }
                if it.action == "squash" {
                    group_has_squash = true;
                }
                todo.push_str(&format!("fixup {}\n", it.oid));
            }
            other => return Err(GitError::new(format!("Unknown rebase action '{other}'."))),
        }
    }
    if group_has_squash && pending.is_none() {
        pending = head_message.clone();
    }
    flush(&mut todo, &mut pending)?;
    if !seen_head {
        return Err(GitError::new("Keep at least one commit, or reset the branch instead."));
    }
    Ok(todo)
}

/// Runs an interactive rebase over `base..HEAD` with the given plan (oldest first).
pub fn interactive_rebase(repo: &Path, base: Option<&str>, items: &[RebaseItem]) -> GitResult<OpOutcome> {
    interactive_rebase_logged(repo, base, items, None)
}
pub fn interactive_rebase_logged(repo: &Path, base: Option<&str>, items: &[RebaseItem], reflog: Option<&str>) -> GitResult<OpOutcome> {
    let gd = repo::git_dir(repo)?;
    if repo::op_state(repo, &gd).kind != "none" {
        return Err(GitError::new("Finish or abort the operation in progress first."));
    }
    // The plan must cover exactly the commits after base, in any order.
    let mut expected = commits_since(repo, base)?;
    if let Some(oldest) = expected.first() {
        // Refuses ranges with merge commits (they would be flattened).
        ensure_rewritable(repo, oldest)?;
    }
    let mut got: Vec<String> = items.iter().map(|i| full_oid(repo, &i.oid)).collect::<GitResult<_>>()?;
    expected.sort();
    got.sort();
    if expected != got {
        return Err(GitError::new("The branch changed since the plan was made. Reopen the rebase dialog.").kind("stale"));
    }
    let todo = build_todo(repo, items)?;
    run_todo_logged(repo, base, &todo, reflog)
}

// ───────────────────────────── stash ─────────────────────────────

pub fn stash_save(repo: &Path, message: &str, include_untracked: bool, keep_index: bool, paths: &[String]) -> GitResult<()> {
    let mut args: Vec<String> = vec!["stash".into(), "push".into()];
    if include_untracked {
        args.push("--include-untracked".into());
    }
    if keep_index {
        args.push("--keep-index".into());
    }
    if !message.trim().is_empty() {
        args.push("-m".into());
        args.push(message.trim().into());
    }
    if !paths.is_empty() {
        args.push("--".into());
        args.extend(paths.iter().cloned());
    }
    let out = runner::run(repo, &args)?;
    if out.contains("No local changes to save") {
        return Err(GitError::new("No local changes to stash."));
    }
    Ok(())
}

pub fn stash_apply(repo: &Path, index: u32, pop: bool) -> GitResult<OpOutcome> {
    let name = format!("stash@{{{index}}}");
    let before = status::status(repo)?.state_token;
    let out = runner::exec(repo, ["stash", if pop { "pop" } else { "apply" }, "--index", &name])?;
    if out.ok() {
        return Ok(OpOutcome::done(out.text()));
    }
    let c = conflicted(repo);
    if !c.is_empty() {
        return Ok(OpOutcome { status: "conflicts".into(), conflicts: c, message: "Stash applied with conflicts; it was kept in the list.".into() });
    }
    // Git may have already applied tracked edits before an untracked collision
    // fails. Never replay that partially completed mutation automatically.
    if status::status(repo)?.state_token != before {
        return Err(GitError::new(
            "The repository changed during the failed stash attempt. The stash was kept and was not applied again; inspect the working tree before another action.",
        )
        .kind("partial-operation")
        .details(vec![out.stderr]));
    }
    // A different index strategy is safe only if the first attempt changed nothing.
    let out2 = runner::exec(repo, ["stash", if pop { "pop" } else { "apply" }, &name])?;
    if out2.ok() {
        return Ok(OpOutcome::done(out2.text()));
    }
    let c = conflicted(repo);
    if !c.is_empty() {
        return Ok(OpOutcome { status: "conflicts".into(), conflicts: c, message: "Stash applied with conflicts; it was kept in the list.".into() });
    }
    Err(runner::to_error("git stash apply", &out2))
}

pub fn check_stash(repo: &Path, index: u32, expected_oid: &str) -> GitResult<()> {
    let actual = runner::run(repo, ["rev-parse", "--verify", &format!("stash@{{{index}}}")])?;
    if actual.trim() != expected_oid {
        return Err(GitError::new("The stash list changed. Reopen the stash before trying again.").kind("stale-operation"));
    }
    Ok(())
}

pub fn stash_apply_reviewed(repo: &Path, index: u32, expected_oid: &str, pop: bool) -> GitResult<OpOutcome> {
    check_stash(repo, index, expected_oid)?;
    stash_apply(repo, index, pop)
}

pub fn stash_drop_reviewed(repo: &Path, index: u32, expected_oid: &str) -> GitResult<()> {
    check_stash(repo, index, expected_oid)?;
    stash_drop(repo, index)
}

pub fn stash_drop(repo: &Path, index: u32) -> GitResult<()> {
    runner::run(repo, ["stash", "drop", &format!("stash@{{{index}}}")])?;
    Ok(())
}

// ───────────────────────────── reflog ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub oid: String,
    pub selector: String,
    pub message: String,
    pub time: i64,
}

pub fn reflog(repo: &Path, limit: usize) -> GitResult<Vec<ReflogEntry>> {
    let out = runner::exec(repo, ["reflog", "show", &format!("-n{limit}"), "--format=%H%x1f%gd%x1f%gs%x1f%ct", "HEAD"])?;
    if !out.ok() {
        return Ok(Vec::new());
    }
    Ok(out
        .text()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(4, '\x1f').collect();
            (f.len() == 4).then(|| ReflogEntry { oid: f[0].into(), selector: f[1].into(), message: f[2].into(), time: f[3].parse().unwrap_or(0) })
        })
        .collect())
}
