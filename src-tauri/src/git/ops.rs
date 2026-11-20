//! Mutating operations: staging, committing, branches, merge/rebase/cherry-pick,
//! history rewriting, stash and remotes.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
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

/// Paths with unmerged index entries, in index order. One `ls-files` instead of a full status
/// (status, index and reference reads), which every merge used to run, fast-forwards included.
fn conflicted(repo: &Path) -> Vec<String> {
    let Ok(raw) = runner::run_bytes(repo, ["ls-files", "--unmerged", "-z"]) else { return Vec::new() };
    let mut paths: Vec<String> = Vec::new();
    for entry in raw.split(|&b| b == 0) {
        if let Some(tab) = entry.iter().position(|&b| b == b'\t') {
            let path = String::from_utf8_lossy(&entry[tab + 1..]).into_owned();
            if paths.last() != Some(&path) {
                paths.push(path);
            }
        }
    }
    paths
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

pub(super) fn path_is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT, including junctions
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

/// Normalize away trailing slashes and never traverse a directory link while
/// backing up/removing a selected leaf. Paths originate in Git, not the trash.
pub(super) fn local_leaf_path(repo: &Path, path: &str) -> GitResult<PathBuf> {
    let relative = Path::new(path);
    if relative.as_os_str().is_empty()
        || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_)) || c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
    {
        return Err(GitError::new("Unsafe working-tree path."));
    }
    let mut full = repo.to_path_buf();
    let parts: Vec<_> = relative.components().collect();
    for (index, part) in parts.iter().enumerate() {
        full.push(part.as_os_str());
        if index + 1 < parts.len() && std::fs::symlink_metadata(&full).is_ok_and(|m| path_is_link(&m)) {
            return Err(GitError::new("Working-tree paths cannot traverse directory links."));
        }
    }
    Ok(full)
}

/// Copies regular files and preserves link targets without reading their contents.
/// Backups live in portable `data/repositories/<id>/trash/<time>/`.
pub fn backup_files(repo: &Path, paths: &[String]) -> GitResult<PathBuf> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let trash = super::storage::dir(repo)?.join("trash");
    std::fs::create_dir_all(&trash)?;
    // Never reuse a previous backup path, especially one containing a saved
    // link: a later regular-file copy must not follow that destination link.
    let folder = tempfile::Builder::new().prefix(&format!("{ts}-")).tempdir_in(trash)?;
    let dir = folder.path();
    for p in paths {
        let src = local_leaf_path(repo, p)?;
        let metadata = match std::fs::symlink_metadata(&src) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.is_file() || path_is_link(&metadata) {
            let dst = dir.join(Path::new(p).components().collect::<PathBuf>());
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if path_is_link(&metadata) {
                let target = std::fs::read_link(&src)?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(target, &dst)?;
                #[cfg(windows)]
                if metadata.is_dir() {
                    std::os::windows::fs::symlink_dir(target, &dst)?;
                } else {
                    std::os::windows::fs::symlink_file(target, &dst)?;
                }
            } else {
                std::fs::copy(&src, &dst)?;
            }
        }
    }
    Ok(folder.keep())
}

pub fn discard_paths(repo: &Path, tracked: &[String], untracked: &[String]) -> GitResult<String> {
    let mut all = tracked.to_vec();
    all.extend_from_slice(untracked);
    let backup = backup_files(repo, &all)?;
    if !tracked.is_empty() {
        with_paths(repo, &["restore", "--worktree"], tracked)?;
    }
    for p in untracked {
        let full = local_leaf_path(repo, p)?;
        match std::fs::symlink_metadata(&full) {
            Ok(metadata) if path_is_link(&metadata) => {
                #[cfg(windows)]
                if metadata.is_dir() {
                    std::fs::remove_dir(&full)?;
                } else {
                    std::fs::remove_file(&full)?;
                }
                #[cfg(not(windows))]
                std::fs::remove_file(&full)?;
            }
            Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&full)?,
            Ok(_) => std::fs::remove_file(&full)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(backup.to_string_lossy().into_owned())
}

// ───────────────────────────── commit ─────────────────────────────

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    #[serde(default)]
    pub verbatim_message: bool,
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
    // This message comes from a Revqora editor or an explicitly approved
    // request. Git's strip mode would treat a leading # as a template comment.
    let cleanup = if opts.verbatim_message { "--cleanup=verbatim" } else { "--cleanup=whitespace" };
    let mut args = vec!["commit", "-F", fp.as_str(), cleanup];
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

/// A person from recent history, for the co-author picker.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitAuthor {
    pub name: String,
    pub email: String,
    pub commits: usize,
}

/// Authors of the last `scan` commits, de-duplicated by e-mail (case-insensitive),
/// most frequent first, ties broken by the most recent commit.
pub fn commit_authors(repo: &Path, scan: usize, limit: usize) -> GitResult<Vec<CommitAuthor>> {
    if head_oid(repo).is_none() {
        return Ok(Vec::new());
    }
    let n = scan.clamp(1, 10_000).to_string();
    let out = runner::run(repo, ["log", "-n", n.as_str(), "--no-color", "--format=%an%x1f%ae"])?;
    let mut found: Vec<(CommitAuthor, usize)> = Vec::new();
    let mut index = std::collections::HashMap::<String, usize>::new();
    for (pos, line) in out.lines().enumerate() {
        let Some((name, email)) = line.split_once('\u{1f}') else { continue };
        let (name, email) = (name.trim(), email.trim());
        if name.is_empty() || email.is_empty() {
            continue;
        }
        let key = email.to_lowercase();
        if let Some(&i) = index.get(&key) {
            found[i].0.commits += 1;
        } else {
            index.insert(key, found.len());
            found.push((CommitAuthor { name: name.into(), email: email.into(), commits: 1 }, pos));
        }
    }
    found.sort_by(|a, b| b.0.commits.cmp(&a.0.commits).then(a.1.cmp(&b.1)));
    Ok(found.into_iter().take(limit).map(|(a, _)| a).collect())
}

/// Full messages of recent commits authored by the configured `user.email`, newest first, unique.
pub fn own_recent_messages(repo: &Path, limit: usize) -> GitResult<Vec<String>> {
    let Some(email) = repo::config_get(repo, "user.email").filter(|e| !e.trim().is_empty()) else { return Ok(Vec::new()) };
    if head_oid(repo).is_none() {
        return Ok(Vec::new());
    }
    // A fixed string, not a regex: e-mail addresses contain '+', '.' and other regex characters.
    let author = format!("--author=<{}>", email.trim());
    let out = runner::run(repo, ["log", "-n", "300", "--no-color", "-i", "--fixed-strings", author.as_str(), "--format=%B%x00"])?;
    let mut seen = std::collections::HashSet::new();
    Ok(out.split('\0').map(|m| m.trim().to_string()).filter(|m| !m.is_empty() && seen.insert(m.clone())).take(limit).collect())
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FixupOptions {
    /// "fixup" or "squash".
    pub kind: String,
    /// Extra message for squash! commits (appended after the subject line).
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub no_verify: bool,
    #[serde(default)]
    pub sign: Option<bool>,
}

/// Commits the staged changes as `fixup! <subject>` / `squash! <subject>` for `oid`.
pub fn fixup_commit(repo: &Path, oid: &str, opts: &FixupOptions) -> GitResult<String> {
    let oid = oid.trim();
    if oid.is_empty() || oid.starts_with('-') || !oid.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::new("Choose a commit by its object ID.").kind("invalid-input"));
    }
    if opts.kind != "fixup" && opts.kind != "squash" {
        return Err(GitError::new("Unknown fixup kind.").kind("invalid-input"));
    }
    let gd = repo::git_dir(repo)?;
    let state = repo::op_state(repo, &gd);
    if state.kind != "none" {
        return Err(GitError::new(format!("Finish or abort the current {} operation first.", state.kind)).kind("operation-in-progress"));
    }
    let spec = format!("{oid}^{{commit}}");
    let verified = runner::exec(repo, ["rev-parse", "-q", "--verify", "--end-of-options", spec.as_str()])?;
    if !verified.ok() {
        return Err(GitError::new("That commit does not exist in this repository.").kind("invalid-input"));
    }
    let full = verified.text().trim().to_string();
    if runner::exec(repo, ["diff", "--cached", "--quiet", "--no-ext-diff"])?.ok() {
        return Err(GitError::new("Stage the changes for this commit first.").kind("nothing-staged"));
    }
    let target = format!("--{}={full}", opts.kind);
    let mut args: Vec<String> = vec!["commit".into(), target, "--cleanup=whitespace".into()];
    let extra = opts.message.as_deref().map(str::trim).filter(|m| !m.is_empty() && opts.kind == "squash");
    let file = match extra {
        Some(m) => Some(temp_file(repo, "FIXUP_MSG", m)?),
        None => None,
    };
    match &file {
        Some(f) => {
            args.push("-F".into());
            args.push(f.to_string_lossy().into_owned());
        }
        None => args.push("--no-edit".into()),
    }
    if opts.no_verify {
        args.push("--no-verify".into());
    }
    match opts.sign {
        Some(true) => args.push("-S".into()),
        Some(false) => args.push("--no-gpg-sign".into()),
        None => {}
    }
    let result = runner::run(repo, &args);
    if let Some(f) = &file {
        let _ = std::fs::remove_file(f);
    }
    result?;
    Ok(head_oid(repo).unwrap_or_default())
}

// ───────────────────────────── branches & tags ─────────────────────────────

pub fn checkout(repo: &Path, target: &str, kind: &str) -> GitResult<String> {
    match kind {
        "remote" => {
            // origin/feature → local feature tracking origin/feature
            let local = target.split_once('/').map(|(_, b)| b).unwrap_or(target);
            let exists = runner::exec(repo, ["show-ref", "--verify", "--quiet", &format!("refs/heads/{local}")])?.ok();
            if exists {
                runner::run(repo, ["switch", super::recovery::ignored_flag(repo), local])?;
            } else {
                runner::run(repo, ["switch", super::recovery::ignored_flag(repo), "-c", local, "--track", target])?;
            }
            Ok(local.to_string())
        }
        "commit" => {
            runner::run(repo, ["switch", super::recovery::ignored_flag(repo), "--detach", target])?;
            Ok(target.to_string())
        }
        _ => {
            runner::run(repo, ["switch", super::recovery::ignored_flag(repo), target])?;
            Ok(target.to_string())
        }
    }
}

pub fn create_branch(repo: &Path, name: &str, start: Option<&str>, checkout: bool) -> GitResult<()> {
    let name = name.trim();
    runner::run(repo, ["check-ref-format", "--branch", name]).map_err(|_| GitError::new(format!("'{name}' is not a valid branch name.")))?;
    let qualified = start.map(|s| super::branch_origin::branch_start(repo, s)).transpose()?;
    let mut args = if checkout {
        let mut args = super::branch_origin::RECORD_CREATION_REFLOG.to_vec();
        args.extend(["switch", super::recovery::ignored_flag(repo), "-c", name]);
        args
    } else {
        vec!["branch", "--create-reflog", name]
    };
    if let Some(s) = start {
        if checkout && qualified.as_deref().is_some_and(|reference| reference.starts_with("refs/remotes/")) {
            args.push("--no-track");
        }
        args.push(qualified.as_deref().unwrap_or(s));
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
    if target.is_empty() || target.starts_with('-') {
        return Err(GitError::new("Invalid reset target.").kind("invalid-argument"));
    }
    // Git writes the target's files over untracked (--hard) and ignored (--hard, --keep) files
    // without asking, and recovery checkpoints do not keep ignored files.
    if matches!(flag, "--hard" | "--keep") {
        guard_untracked_tree(repo, target)?;
    }
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
    args.extend(prune_args(repo, remote, prune)?);
    args.push("--tags".into());
    let out = settle_fetch(repo, remote, runner::run_streaming(repo, &args, &LOG_TRACKING, on_line))?;
    if prune {
        prune_tracking_separately(repo, remote, &LOG_TRACKING, None)?;
    }
    repair_remote_heads(repo, remote, &out);
    Ok(out)
}

/// Turns what Git reported into the fetch's result.
///
/// * A tag that moved on the server makes Git fail the whole fetch ("would clobber existing
///   tag"), although every branch was fetched. Every later fetch failed the same way. The fetch
///   now succeeds, keeps the local tag, and names the tag (see [`update_tags_from_remote`]).
/// * When some remotes of a fetch of all remotes fail, the result names the ones that were
///   fetched and the ones that were not (kind `partial-fetch`) instead of one failure.
fn settle_fetch(repo: &Path, remote: Option<&str>, result: GitResult<String>) -> GitResult<String> {
    let (text, error) = match result {
        Ok(out) => (out, None),
        Err(error) if error.kind == "cancelled" => return Err(error),
        Err(error) => (error.stderr.clone(), Some(error)),
    };
    let report = super::fetch_report::parse(&text);
    let remotes = if report.clobbered.iter().any(|(_, from)| from.is_none()) || !report.failed.is_empty() { remotes_of(repo, remote)? } else { Vec::new() };
    let only = remote.map(str::to_owned).or_else(|| (remotes.len() == 1).then(|| remotes[0].clone()));
    let moved: Vec<(String, String)> =
        report.clobbered.iter().filter_map(|(tag, from)| from.clone().or_else(|| only.clone()).map(|from| (tag.clone(), from))).collect();
    // A fetch that failed outright (sign-in, network) says nothing about tags: keep the list.
    if error.is_none() || report.trailing.is_none() {
        super::fetch_report::record(repo, remote, &moved);
    }
    let with_notice = |mut text: String| {
        if !moved.is_empty() {
            if !text.ends_with('\n') && !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&super::fetch_report::notice(&moved));
        }
        text
    };
    let Some(error) = error else { return Ok(with_notice(text)) };
    if report.failed.is_empty() && report.trailing.is_none() && !report.clobbered.is_empty() {
        return Ok(with_notice(text));
    }
    if remote.is_none() && !report.failed.is_empty() && report.trailing.is_none() {
        let fetched: Vec<&str> = remotes.iter().map(String::as_str).filter(|r| !report.failed.iter().any(|(failed, _)| failed == r)).collect();
        if !fetched.is_empty() {
            let failures: Vec<String> = report.failed.iter().map(|(name, problem)| format!("Could not fetch {name}: {problem}")).collect();
            let mut partial = GitError::new(format!("Fetched {}. {}", fetched.join(", "), failures.join(" ")));
            partial.kind = "partial-fetch".into();
            partial.stderr = error.stderr;
            partial.code = error.code;
            partial.details = report.failed.iter().map(|(name, _)| name.clone()).collect();
            return Err(partial);
        }
    }
    Err(error)
}

/// Tags that moved on the server since they were fetched; the local versions were kept.
pub fn moved_tags(repo: &Path) -> GitResult<Vec<String>> {
    Ok(super::fetch_report::moved(repo).into_iter().map(|(tag, _)| tag).collect())
}

/// Replaces local tags with the server's versions (after [`moved_tags`] named them). The old
/// targets stay in the tags' reflogs.
pub fn update_tags_from_remote(repo: &Path, remote: &str, tags: &[String], on_line: impl FnMut(&str)) -> GitResult<String> {
    if tags.is_empty() {
        return Ok(String::new());
    }
    for tag in tags {
        let valid = !tag.starts_with('-') && runner::exec(repo, ["check-ref-format", &format!("refs/tags/{tag}")])?.ok();
        if !valid {
            return Err(GitError::new(format!("{tag} is not a valid tag name.")).kind("invalid-argument"));
        }
    }
    let specs: Vec<String> = tags.iter().map(|tag| format!("+refs/tags/{tag}:refs/tags/{tag}")).collect();
    super::recovery::protect_transport(repo, false, Some(remote), None, false)?;
    for spec in &specs {
        super::recovery::protect_transport(repo, false, Some(remote), Some(spec), false)?;
    }
    let mut args: Vec<String> = ["fetch", "--progress", "--no-tags", "--no-prune", "--no-write-fetch-head", remote].map(String::from).to_vec();
    args.extend(specs);
    let env = [("GIT_CONFIG_COUNT", "1"), ("GIT_CONFIG_KEY_0", "core.logAllRefUpdates"), ("GIT_CONFIG_VALUE_0", "always")];
    let out = runner::run_streaming(repo, &args, &env, on_line)?;
    super::fetch_report::forget(repo, tags);
    Ok(out)
}

/// Updates every moved tag from the remote that reported it.
pub fn update_moved_tags(repo: &Path, mut on_line: impl FnMut(&str)) -> GitResult<String> {
    let mut by_remote: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for (tag, remote) in super::fetch_report::moved(repo) {
        by_remote.entry(remote).or_default().push(tag);
    }
    let mut out = String::new();
    for (remote, tags) in by_remote {
        out.push_str(&update_tags_from_remote(repo, &remote, &tags, &mut on_line)?);
    }
    Ok(out)
}

/// After the server deleted the branch its HEAD named (a renamed default branch, with prune),
/// `refs/remotes/<remote>/HEAD` pointed nowhere. Point it at the server's current default
/// branch. Only runs when the fetch deleted something. The ref changes only on the server's
/// own answer: a failed query (network, sign-in) or a default branch that was not fetched
/// leaves it as it was; it is removed only when the server answered and names no default
/// branch (empty repository or detached HEAD).
fn repair_remote_heads(repo: &Path, remote: Option<&str>, output: &str) {
    if !output.contains("[deleted]") {
        return;
    }
    let Ok(remotes) = remotes_of(repo, remote) else { return };
    for name in remotes {
        let head = format!("refs/remotes/{name}/HEAD");
        let Ok(target) = runner::exec(repo, ["symbolic-ref", "-q", &head]) else { continue };
        let target = target.text().trim().to_owned();
        if target.is_empty() || runner::exec(repo, ["rev-parse", "--verify", "-q", &target]).is_ok_and(|out| out.ok()) {
            continue;
        }
        let listing = match runner::exec(repo, ["ls-remote", "--symref", "--", &name, "HEAD"]) {
            Ok(listing) if listing.ok() => listing.text(),
            // No answer from the server is no evidence about its default branch.
            _ => continue,
        };
        match listing.lines().find_map(|line| line.strip_prefix("ref: refs/heads/")?.strip_suffix("\tHEAD").map(str::to_owned)) {
            Some(branch) => {
                let tracking = format!("refs/remotes/{name}/{branch}");
                if runner::exec(repo, ["rev-parse", "--verify", "-q", &tracking]).is_ok_and(|out| out.ok()) {
                    let _ = runner::exec(repo, ["symbolic-ref", "-m", "Revqora: follow the remote's default branch", &head, &tracking]);
                }
            }
            None => {
                let _ = runner::exec(repo, ["symbolic-ref", "--delete", &head]);
            }
        }
    }
}

#[cfg(test)]
#[test]
fn a_failed_default_branch_query_keeps_the_remote_head() {
    let fixture = tempfile::tempdir_in(crate::portable::temp_dir().unwrap()).unwrap();
    let repo = fixture.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    runner::run(&repo, ["init", "-qb", "main"]).unwrap();
    // The server cannot be reached (as after a network or sign-in failure).
    let missing = fixture.path().join("missing.git");
    runner::run(&repo, ["remote", "add", "origin", &missing.to_string_lossy()]).unwrap();
    runner::run(&repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]).unwrap();
    repair_remote_heads(&repo, Some("origin"), " - [deleted]         (none)     -> origin/main");
    assert_eq!(runner::run(&repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]).unwrap().trim(), "refs/remotes/origin/main");
}

/// Forget saved login: drops the saved sign-in for a remote's address from every configured
/// credential helper (Git Credential Manager, the store, Revqora's own) by running
/// `git credential reject`. A failed transfer never does this on its own (see
/// `connection::guard`); the user asks for it, for example to sign in with another account.
pub fn forget_saved_login(repo: &Path, remote: &str) -> GitResult<()> {
    if remote.starts_with('-') {
        return Err(GitError::new("Choose a remote name that does not start with '-'.").kind("invalid-argument"));
    }
    let mut urls: Vec<String> = Vec::new();
    for args in [["remote", "get-url", "--all", remote].as_slice(), ["remote", "get-url", "--push", "--all", remote].as_slice()] {
        let out = runner::exec(repo, args)?;
        if !out.ok() {
            return Err(runner::to_error("git remote get-url", &out));
        }
        urls.extend(out.text().lines().map(str::trim).filter(|u| !u.is_empty()).map(str::to_owned));
    }
    urls.dedup();
    let web: Vec<&String> = urls.iter().filter(|u| u.starts_with("https://") || u.starts_with("http://")).collect();
    if web.is_empty() {
        return Err(GitError::new(format!(
            "{remote} does not use HTTPS, so there is no saved sign-in to forget. SSH keys are managed in Git connection settings."
        ))
        .kind("not-https"));
    }
    for url in web {
        if url.contains(['\n', '\0']) {
            continue;
        }
        let input = format!("url={url}\n\n");
        let out = runner::exec_full(repo, ["credential", "reject"], &[], Some(input.as_bytes()))?;
        if !out.ok() {
            return Err(runner::to_error("git credential reject", &out));
        }
    }
    Ok(())
}

pub fn is_shallow(repo: &Path) -> GitResult<bool> {
    Ok(runner::run(repo, ["rev-parse", "--is-shallow-repository"])?.trim() == "true")
}

/// Fetches more history into a shallow clone: `deepen = Some(n)` adds n commits, `None` unshallows.
pub fn fetch_more_history(repo: &Path, deepen: Option<u32>, on_line: impl FnMut(&str)) -> GitResult<String> {
    if !is_shallow(repo)? {
        return Err(GitError::new("This repository already has its full history.").kind("not-shallow"));
    }
    let arg = match deepen {
        Some(0) => return Err(GitError::new("Depth must be a positive whole number.").kind("invalid-depth")),
        Some(n) => format!("--deepen={n}"),
        None => "--unshallow".into(),
    };
    super::recovery::protect_transport(repo, false, None, None, true)?;
    // Only history is wanted: never prune here, whatever fetch.prune / fetch.pruneTags say
    // (pruning could delete local-only tags or branches mapped by a refspec).
    runner::run_streaming(repo, &["fetch".into(), "--progress".into(), "--no-prune".into(), "--no-prune-tags".into(), arg], &LOG_TRACKING, on_line)
}

/// `--prune` removes refs under every destination of the fetch refspecs, including local tags
/// or branches when a refspec maps there (e.g. `+refs/tags/*:refs/tags/*`), and `fetch.pruneTags`
/// adds local tags. Only prune when every refspec of the fetched remotes targets
/// `refs/remotes/`, and never prune tags.
fn prune_args(repo: &Path, remote: Option<&str>, requested: bool) -> GitResult<Vec<String>> {
    let safe = requested && {
        let mut all = true;
        for r in remotes_of(repo, remote)? {
            all &= pull_can_prune(repo, &r)?;
        }
        all
    };
    Ok(if safe { vec!["--prune".into(), "--no-prune-tags".into()] } else { vec!["--no-prune".into(), "--no-prune-tags".into()] })
}

fn remotes_of(repo: &Path, remote: Option<&str>) -> GitResult<Vec<String>> {
    Ok(match remote {
        Some(r) => vec![r.to_string()],
        None => super::config_cache::run(repo, &["remote"])?.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
    })
}

/// Remotes whose refspecs also map outside `refs/remotes/` were fetched without `--prune`.
/// Clean their remote-tracking branches separately: a second fetch with only the refspecs
/// that target `refs/remotes/` prunes branches deleted on the server and nothing else.
fn prune_tracking_separately(repo: &Path, remote: Option<&str>, env: &[(&str, &str)], deadline: Option<std::time::Duration>) -> GitResult<()> {
    for r in remotes_of(repo, remote)? {
        if pull_can_prune(repo, &r)? {
            continue;
        }
        let specs = super::config_cache::exec(repo, &["config", "--get-all", &format!("remote.{r}.fetch")])?;
        let tracking: Vec<String> = specs
            .text()
            .lines()
            .map(str::trim)
            .filter(|s| !s.starts_with('^') && s.split_once(':').is_some_and(|(_, target)| target.starts_with("refs/remotes/")))
            .map(String::from)
            .collect();
        if tracking.is_empty() {
            continue;
        }
        let mut args: Vec<String> =
            ["fetch", "--prune", "--no-prune-tags", "--no-tags", "--quiet", "--no-write-fetch-head", "--", &r].map(String::from).to_vec();
        args.extend(tracking);
        match deadline {
            Some(timeout) => {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                runner::run_with_deadline(repo, &args, env, timeout)?;
            }
            None => {
                runner::run_streaming(repo, &args, env, |_| {})?;
            }
        }
    }
    Ok(())
}

/// Keeps a reflog for remote-tracking refs on user fetches too (see `background_env`).
const LOG_TRACKING: [(&str, &str); 3] = [("GIT_CONFIG_COUNT", "1"), ("GIT_CONFIG_KEY_0", "core.logAllRefUpdates"), ("GIT_CONFIG_VALUE_0", "true")];

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
        ("GIT_CONFIG_COUNT", "3"),
        ("GIT_CONFIG_KEY_0", "credential.interactive"),
        ("GIT_CONFIG_VALUE_0", "never"),
        ("GIT_CONFIG_KEY_1", "core.askPass"),
        ("GIT_CONFIG_VALUE_1", ""),
        // Record every remote-tracking update even when the user turned the reflog off, so a
        // later force push can tell fetched commits from integrated ones (--force-if-includes).
        ("GIT_CONFIG_KEY_2", "core.logAllRefUpdates"),
        ("GIT_CONFIG_VALUE_2", "true"),
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
/// What an automatic fetch did.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundFetch {
    pub output: String,
    /// Whether any ref (branch, remote branch, tag) moved, appeared or disappeared. Without a
    /// change there is nothing new to read: most automatic fetches bring nothing.
    pub refs_changed: bool,
}

pub fn fetch_background(repo: &Path) -> GitResult<BackgroundFetch> {
    // Usually remembered from the last status read: no Git process while the ref files keep
    // their size and time, and none afterwards when the fetch changed nothing.
    let before = super::operations::state_cache::current_refs(repo).ok();
    let output = fetch_background_with_deadline(repo, std::time::Duration::from_secs(30))?;
    let after = super::operations::state_cache::current_refs(repo).ok();
    Ok(BackgroundFetch { output, refs_changed: before.is_none() || before != after })
}

/// [`fetch_background`] with its time limit (tests use a short one).
pub fn fetch_background_with_deadline(repo: &Path, timeout: std::time::Duration) -> GitResult<String> {
    super::recovery::protect_transport(repo, false, None, None, true)?;
    let ssh_configured = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || super::connection::managed_ssh(repo)?
        || super::config_cache::run(repo, &["config", "--get", "core.sshCommand"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let mut args: Vec<String> = ["fetch", "--all"].map(String::from).to_vec();
    args.extend(prune_args(repo, None, true)?);
    // Not --quiet: it also hides the lines that name a moved tag or a failed remote, and the
    // fetch then failed with only "exit code 1".
    args.extend(["--tags", "--no-write-fetch-head", "--no-auto-maintenance"].map(String::from));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let env = background_env(ssh_configured);
    let out = settle_fetch(repo, None, runner::run_with_deadline(repo, &args, &env, timeout))?;
    prune_tracking_separately(repo, None, &env, Some(timeout))?;
    Ok(out)
}

#[cfg(test)]
#[test]
fn a_user_write_stops_a_background_fetch_instead_of_waiting_for_it() {
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    // A server that accepts the fetch and never answers: the fetch would wait 40 s.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/repository.git", listener.local_addr().unwrap());
    let fixture = tempfile::tempdir().unwrap();
    let repo = fixture.path().to_path_buf();
    runner::run(&repo, ["init", "-qb", "main"]).unwrap();
    runner::run(&repo, ["remote", "add", "origin", &url]).unwrap();
    runner::run(&repo, ["config", "--local", "remote.origin.proxy", ""]).unwrap();
    listener.set_nonblocking(true).unwrap();
    let (release, released) = std::sync::mpsc::channel::<()>();
    // Holds every connection open until released; it may also see none (stopped earlier).
    let server = std::thread::spawn(move || {
        let mut held = Vec::new();
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(60) {
            if let Ok((stream, _)) = listener.accept() {
                held.push(stream);
            }
            if !matches!(released.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let fetching = repo.clone();
    let background = std::thread::spawn(move || {
        super::operations::access(
            &fetching,
            true,
            |_, _| {},
            || super::operations::yielding(&fetching, || fetch_background_with_deadline(&fetching, Duration::from_secs(40))),
        )
    });
    let started = Instant::now();
    while !runner::transfers::running(&repo) {
        assert!(started.elapsed() < Duration::from_secs(20), "The background fetch never reached the server");
        std::thread::sleep(Duration::from_millis(20));
    }
    // The user's own change to the repository starts at once instead of after the fetch.
    let began = Instant::now();
    runner::run(&repo, ["config", "--local", "revqora.probe", "1"]).unwrap();
    let waited = began.elapsed();
    let result = background.join().unwrap();
    let _ = release.send(());
    server.join().unwrap();
    assert_eq!(result.unwrap_err().kind, "repository-busy");
    assert!(waited < Duration::from_secs(10), "the write waited {waited:?} for the background fetch");
}

#[cfg(test)]
#[test]
fn stalled_background_fetch_times_out_and_releases_the_repository() {
    use std::io::Read;
    use std::net::TcpListener;
    use std::time::Duration;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/repository.git", listener.local_addr().unwrap());
    let fixture = tempfile::tempdir().unwrap();
    let repo = fixture.path();
    runner::run(repo, ["init", "-qb", "main"]).unwrap();
    runner::run(repo, ["remote", "add", "origin", &url]).unwrap();
    runner::run(repo, ["config", "--local", "remote.origin.proxy", ""]).unwrap();
    let deadline = Duration::from_secs(15);
    let server_watchdog = 2 * deadline;
    let (release, done) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || -> std::io::Result<usize> {
        let start = std::time::Instant::now();
        while start.elapsed() < server_watchdog {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    // Winsock inherits the listener's nonblocking mode on accept.
                    stream.set_nonblocking(false)?;
                    stream.set_read_timeout(Some(deadline))?;
                    let bytes = stream.read(&mut [0; 1024])?;
                    // Only the Git runner should end the stalled request. A
                    // socket close at the same deadline can make Git exit first.
                    done.recv_timeout(server_watchdog).map_err(|error| std::io::Error::other(format!("Fetch did not release the fixture: {error}")))?;
                    return Ok(bytes);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if !matches!(done.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::other("Git never connected to the fixture remote"))
    });
    let start = std::time::Instant::now();
    let result = fetch_background_with_deadline(repo, deadline);
    let elapsed = start.elapsed();
    let _ = release.send(());
    let observed = server.join().unwrap();
    assert!(matches!(observed, Ok(bytes) if bytes > 0), "Fixture {url}: {observed:?}; fetch elapsed {elapsed:?}, result {result:?}");
    assert!(matches!(&result, Err(error) if error.kind == "git-timeout"), "Fixture {url}: fetch elapsed {elapsed:?}, result {result:?}");
    runner::run(repo, ["config", "--local", "user.name", "After fetch"]).unwrap();
    assert_eq!(runner::run(repo, ["config", "--get", "user.name"]).unwrap().trim(), "After fetch");
    assert!(!repo.join(".git/FETCH_HEAD").exists());
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
    let specs = super::config_cache::exec(repo, &["config", "--get-all", &format!("remote.{remote}.fetch")])?;
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

fn deleted_pull_upstream(repo: &Path, branch: &str, remote: &str, reference: &str, prune_remote: bool) -> GitResult<Option<PullOutcome>> {
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
    if prune_remote && parts.len() == 3 && parts[0].starts_with("refs/remotes/") && parts[1] == remote && parts[2] == reference {
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
            message: format!("Upstream {reference} is no longer available from {remote}. Its absence was verified with the server. Local branch {branch} and its working changes are kept; no merge was performed."),
        },
        upstream_gone: Some(MissingUpstream { branch: branch.into(), remote: remote.into(), reference: reference.into(), default_branch }),
    }))
}

pub fn pull(repo: &Path, mode: &str, on_line: impl FnMut(&str)) -> GitResult<PullOutcome> {
    pull_with_prune(repo, mode, true, on_line)
}

pub fn pull_with_prune(repo: &Path, mode: &str, prune_remote: bool, on_line: impl FnMut(&str)) -> GitResult<PullOutcome> {
    super::recovery::protect_transport(repo, false, None, None, false)?;
    // Local edits never block a pull. Staged work is saved here, with its staging, in a stash
    // named after the branch; every other edit is set aside by Git's autostash only when the
    // pull integrates something. Both come back afterwards, and a conflict shows the files.
    // Both reads are independent; run them side by side. Without a commit, `diff HEAD` fails
    // (not exit 1), so an unborn branch counts as having nothing to set aside.
    let parent = super::operations::Inherited::of(repo);
    let (name, dirty) = std::thread::scope(|scope| {
        let name = scope.spawn(|| parent.run(|| pull_stash_name(repo)));
        let dirty = runner::exec(repo, ["diff", "HEAD", "--quiet", "--ignore-submodules=dirty"]).map(|out| out.code == 1);
        (name.join().unwrap_or_else(|_| Err(GitError::new("Reading the current branch failed."))), dirty)
    });
    let (name, dirty) = (name?, dirty?);
    // Staged work is set aside only right before the pull integrates, after its recovery
    // checkpoint: that checkpoint must hold the staging as the user left it.
    let mut saved = None;
    let mut top = stash_top(repo)?;
    let set_aside = || -> GitResult<()> {
        saved = stash_staged_as(repo, &name)?;
        top = stash_top(repo)?;
        Ok(())
    };
    match pull_unsaved(repo, mode, prune_remote, set_aside, on_line) {
        Ok(mut outcome) => {
            let set_aside = dirty && matches!(outcome.operation.status.as_str(), "done" | "fastForward");
            name_autostash(repo, top.as_deref(), &name)?;
            restore_saved(repo, saved, &mut outcome.operation)?;
            if set_aside && outcome.operation.status != "conflicts" && !outcome.operation.message.contains("Your local changes") {
                outcome.operation.message.push_str("\nYour local changes were set aside during the pull and restored.");
            }
            Ok(outcome)
        }
        Err(error) => {
            if let Some(oid) = saved {
                apply_saved(repo, &oid)?;
            }
            Err(error)
        }
    }
}

/// What Fetch, Pull or Push of several branches did in one repository.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchesSync {
    /// Pull: branches moved forward to their upstream. Push: branches the remote accepted.
    /// Fetch: fetched branches that now have incoming commits.
    pub updated: Vec<BranchUpdate>,
    /// Branches that were left as they are, and why.
    pub skipped: Vec<BranchSkip>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchUpdate {
    pub branch: String,
    /// Commits the branch received (Pull), sent (Push) or can receive (Fetch).
    pub commits: usize,
    /// The checked-out branch (its files were updated too).
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSkip {
    pub branch: String,
    pub reason: String,
}

/// Ahead and behind counts from `%(upstream:track,nobracket)` ("ahead 1, behind 2", "gone", "").
fn track_counts(track: &str) -> Option<(usize, usize)> {
    if track == "gone" {
        return None;
    }
    let count = |word: &str| track.split(", ").find_map(|part| part.strip_prefix(word).and_then(|n| n.trim().parse().ok())).unwrap_or(0);
    Some((count("ahead "), count("behind ")))
}

/// Local and incoming commits between `oid` and exactly `target` (`rev-list --left-right`).
fn ahead_behind(repo: &Path, oid: &str, target: &str) -> GitResult<(usize, usize)> {
    let counts = runner::run(repo, ["rev-list", "--left-right", "--count", &format!("{oid}...{target}")])?;
    let mut parts = counts.split_whitespace().map(|n| n.parse::<usize>().unwrap_or(0));
    Ok((parts.next().unwrap_or(0), parts.next().unwrap_or(0)))
}

/// Branches that must not move under a worktree, read now from the Git directories (no Git
/// start, so it is read again right before each move):
/// - `operations`: the branches an unfinished rebase or bisect in any worktree works on,
///   including the other branches `rebase --update-refs` will rewrite when it finishes. Their
///   worktree's HEAD is detached meanwhile, so `%(worktreepath)` does not name them.
/// - `checked_out`: the branch of each worktree's HEAD.
struct BusyBranches {
    operations: HashSet<String>,
    checked_out: HashSet<String>,
}

fn busy_branches(repo: &Path) -> GitResult<BusyBranches> {
    let git_dir = repo::git_dir(repo)?;
    let common = super::graph::common_dir(repo).unwrap_or_else(|| git_dir.clone());
    let mut dirs = vec![common.clone()];
    if let Ok(entries) = std::fs::read_dir(common.join("worktrees")) {
        dirs.extend(entries.flatten().map(|entry| entry.path()));
    }
    let full = |name: &str| if name.starts_with("refs/") { name.to_owned() } else { format!("refs/heads/{name}") };
    let mut busy = BusyBranches { operations: HashSet::new(), checked_out: HashSet::new() };
    // A bare repository's own HEAD names a branch that no worktree has checked out.
    let bare = super::config_cache::exec(repo, &["config", "--bool", "--get", "core.bare"])?;
    let bare = bare.ok() && bare.text().trim() == "true";
    for dir in dirs {
        for file in ["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"] {
            let Ok(text) = std::fs::read_to_string(dir.join(file)) else { continue };
            let name = text.trim();
            if name.is_empty() || name == "detached HEAD" {
                continue;
            }
            busy.operations.insert(full(name));
        }
        // "<ref>\n<old>\n<new>\n" for each branch the rebase moves when it finishes.
        if let Ok(text) = std::fs::read_to_string(dir.join("rebase-merge/update-refs")) {
            busy.operations.extend(text.lines().map(str::trim).filter(|line| line.starts_with("refs/")).map(str::to_owned));
        }
        let head = if bare && dir == common { None } else { std::fs::read_to_string(dir.join("HEAD")).ok() };
        if let Some(name) = head.as_deref().and_then(|text| text.trim().strip_prefix("ref:")) {
            busy.checked_out.insert(name.trim().to_owned());
        }
    }
    Ok(busy)
}

/// Why `name` must not move now, if it must not.
fn busy_now(repo: &Path, name: &str) -> GitResult<Option<String>> {
    let busy = busy_branches(repo)?;
    Ok(if busy.operations.contains(name) {
        Some("A rebase or bisect in progress works on this branch. Finish or abort it first.".into())
    } else if busy.checked_out.contains(name) {
        Some("The branch was checked out meanwhile. Pull it there.".into())
    } else {
        None
    })
}

/// One local branch with its upstream, as Fetch, Pull and Push of several branches read it.
struct LocalBranch {
    /// `refs/heads/…`
    name: String,
    oid: String,
    /// The remote-tracking branch (`refs/remotes/…`), or empty without an upstream.
    upstream: String,
    /// `%(upstream:track,nobracket)`: "ahead 1, behind 2", "gone" or "".
    track: String,
    worktree: String,
    /// The upstream's remote ("." for a branch that tracks another local branch).
    remote: String,
    /// The branch on the remote (`refs/heads/…`).
    remote_ref: String,
}

impl LocalBranch {
    fn short(&self) -> String {
        self.name.strip_prefix("refs/heads/").unwrap_or(&self.name).to_owned()
    }
}

fn local_branches(repo: &Path) -> GitResult<Vec<LocalBranch>> {
    let format =
        "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(upstream:remotename)%00%(upstream:remoteref)";
    let listing = runner::run(repo, ["for-each-ref", format, "refs/heads"])?;
    Ok(listing
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\0').collect();
            let [name, oid, upstream, track, worktree, remote, remote_ref] = fields[..] else { return None };
            Some(LocalBranch {
                name: name.into(),
                oid: oid.into(),
                upstream: upstream.into(),
                track: track.into(),
                worktree: worktree.into(),
                remote: remote.into(),
                remote_ref: remote_ref.into(),
            })
        })
        .collect())
}

/// The branches named for Fetch, Pull or Push: local ones (`refs/heads/…`, or `HEAD` for the
/// checked-out branch) and remote-tracking ones (`refs/remotes/…`). A detached HEAD is reported.
fn chosen_branches(repo: &Path, branches: &[String], result: &mut BranchesSync) -> GitResult<(HashSet<String>, Vec<String>)> {
    let (mut local, mut remote) = (HashSet::new(), Vec::new());
    for name in branches {
        if name == "HEAD" {
            let head = runner::exec(repo, ["symbolic-ref", "--quiet", "HEAD"])?;
            if head.ok() {
                local.insert(head.text().trim().to_owned());
            } else {
                result.skipped.push(BranchSkip { branch: "HEAD".into(), reason: "No branch is checked out (detached HEAD).".into() });
            }
        } else if name.starts_with("refs/heads/") {
            local.insert(name.clone());
        } else if name.starts_with("refs/remotes/") {
            remote.push(name.clone());
        } else {
            return Err(GitError::new(format!("Choose a branch instead of {name}.")));
        }
    }
    Ok((local, remote))
}

/// Fetches only the upstreams of the chosen local branches and the chosen remote-tracking
/// branches: one `git fetch <remote> <branches>` per remote, which also moves their
/// remote-tracking branches. Returns the local branches whose upstream was fetched.
fn fetch_chosen(
    repo: &Path,
    local: &HashSet<String>,
    remote: &[String],
    result: &mut BranchesSync,
    on_line: &mut impl FnMut(&str),
) -> GitResult<HashSet<String>> {
    // Remote → (shown name, branch on the remote, local branch it is the upstream of).
    let mut by_remote: BTreeMap<String, Vec<(String, String, Option<String>)>> = BTreeMap::new();
    let branches = local_branches(repo)?;
    for name in local {
        let Some(branch) = branches.iter().find(|b| &b.name == name) else {
            let shown = name.strip_prefix("refs/heads/").unwrap_or(name).to_owned();
            result.skipped.push(BranchSkip { branch: shown, reason: "The branch no longer exists.".into() });
            continue;
        };
        if branch.upstream.is_empty() || branch.remote.is_empty() || branch.remote_ref.is_empty() {
            result.skipped.push(BranchSkip { branch: branch.short(), reason: "No upstream branch.".into() });
        } else if branch.remote != "." {
            by_remote.entry(branch.remote.clone()).or_default().push((branch.short(), branch.remote_ref.clone(), Some(branch.name.clone())));
        }
    }
    if !remote.is_empty() {
        let remotes = runner::run(repo, ["remote"])?;
        for name in remote {
            let rest = name.strip_prefix("refs/remotes/").unwrap_or(name);
            // The longest remote name wins: "origin/team" before "origin" for "origin/team/main".
            let owner = remotes.lines().map(str::trim).filter(|r| !r.is_empty() && rest.starts_with(&format!("{r}/"))).max_by_key(|r| r.len());
            match owner {
                Some(owner) if &rest[owner.len() + 1..] != "HEAD" => {
                    let on_remote = format!("refs/heads/{}", &rest[owner.len() + 1..]);
                    by_remote.entry(owner.to_owned()).or_default().push((rest.to_owned(), on_remote, None));
                }
                Some(_) => {}
                None => result.skipped.push(BranchSkip { branch: rest.to_owned(), reason: "No remote of this repository has this branch.".into() }),
            }
        }
    }
    let mut fetched = HashSet::new();
    for (remote, items) in by_remote {
        // A remote that cannot be reached (sign-in, network, a removed fork) only stops its own
        // branches: they are reported and the other remotes are still fetched.
        let missing = match fetch_remote_refs(repo, &remote, &items, on_line) {
            Ok(missing) => missing,
            Err(error) if error.kind == "cancelled" => return Err(error),
            Err(error) => {
                let reason = format!("Could not fetch {remote}: {}", first_line(&error.message, "the fetch failed."));
                result.skipped.extend(items.into_iter().map(|(branch, _, _)| BranchSkip { branch, reason: reason.clone() }));
                continue;
            }
        };
        for (shown, on_remote, local) in items {
            if missing.contains(&on_remote) {
                result.skipped.push(BranchSkip { branch: shown, reason: format!("The branch no longer exists on {remote}.") });
            } else if let Some(local) = local {
                fetched.insert(local);
            }
        }
    }
    Ok(fetched)
}

/// Fetches the remote branches of `items` from `remote`; returns those the remote no longer has.
fn fetch_remote_refs(repo: &Path, remote: &str, items: &[(String, String, Option<String>)], on_line: &mut impl FnMut(&str)) -> GitResult<Vec<String>> {
    super::recovery::protect_transport(repo, false, Some(remote), None, false)?;
    let mut refs: Vec<String> = items.iter().map(|(_, on_remote, _)| on_remote.clone()).collect();
    refs.sort();
    refs.dedup();
    // One deleted branch fails the whole fetch, and Git names only the first one it misses:
    // leave that one out and fetch the rest again (one more round trip per deleted branch).
    // Should Git not name it, fetch the rest one by one.
    let mut missing: Vec<String> = Vec::new();
    let mut rest = refs;
    while !rest.is_empty() {
        let error = match fetch_refs(repo, remote, &rest, on_line) {
            Ok(()) => break,
            Err(error) if missing_remote_ref(&error) => error,
            Err(error) => return Err(error),
        };
        match missing_remote_name(&error).and_then(|name| rest.iter().position(|r| *r == name)) {
            Some(at) => missing.push(rest.remove(at)),
            None => {
                for reference in std::mem::take(&mut rest) {
                    match fetch_refs(repo, remote, std::slice::from_ref(&reference), on_line) {
                        Ok(()) => {}
                        Err(error) if missing_remote_ref(&error) => missing.push(reference),
                        Err(error) => return Err(error),
                    }
                }
            }
        }
    }
    Ok(missing)
}

fn fetch_refs(repo: &Path, remote: &str, refs: &[String], on_line: &mut impl FnMut(&str)) -> GitResult<()> {
    let mut args = vec!["fetch".to_string(), "--progress".into(), remote.into()];
    args.extend(refs.iter().cloned());
    settle_fetch(repo, Some(remote), runner::run_streaming(repo, &args, &LOG_TRACKING, on_line)).map(|_| ())
}

fn missing_remote_ref(error: &GitError) -> bool {
    error.stderr.contains("couldn't find remote ref") || error.message.contains("couldn't find remote ref")
}

/// The ref named in "couldn't find remote ref <name>".
fn missing_remote_name(error: &GitError) -> Option<String> {
    [&error.stderr, &error.message].into_iter().find_map(|text| {
        let (_, after) = text.split_once("couldn't find remote ref ")?;
        after.lines().next().map(|name| name.trim().to_owned()).filter(|name| !name.is_empty())
    })
}

/// Fetch for chosen branches (see [`chosen_branches`]): only their upstreams are fetched.
/// `updated` lists the local branches that now have incoming commits.
pub fn fetch_branches(repo: &Path, branches: &[String], mut on_line: impl FnMut(&str)) -> GitResult<BranchesSync> {
    let mut result = BranchesSync::default();
    let (local, remote) = chosen_branches(repo, branches, &mut result)?;
    let fetched = fetch_chosen(repo, &local, &remote, &mut result, &mut on_line)?;
    let head = runner::exec(repo, ["symbolic-ref", "--quiet", "HEAD"])?;
    let head = head.ok().then(|| head.text().trim().to_owned());
    for branch in local_branches(repo)?.into_iter().filter(|b| fetched.contains(&b.name)) {
        if let Some((_, behind)) = track_counts(&branch.track).filter(|(_, behind)| *behind > 0) {
            let current = head.as_deref() == Some(branch.name.as_str());
            result.updated.push(BranchUpdate { branch: branch.short(), commits: behind, current });
        }
    }
    Ok(result)
}

/// Pull all for one repository: fetches every remote once, then fast-forwards every local
/// branch that only lacks commits of its upstream. Never merges, rebases or creates a commit.
pub fn pull_all_branches(repo: &Path, on_line: impl FnMut(&str)) -> GitResult<BranchesSync> {
    pull_branches(repo, None, on_line)
}

/// Pull for chosen branches, or for every local branch with `None`. Fetches first (only the
/// chosen branches' upstreams), then fast-forwards each branch that only lacks commits of its
/// upstream. Never merges, rebases or creates a commit.
///
/// Each branch moves exactly to the upstream commit that was checked: its ancestry is verified
/// for that commit, and nothing is fetched again before the update.
/// - The checked-out branch is fast-forwarded (`merge --ff-only`, with the regular protection of
///   ignored files) when no local change touches a file the incoming commits change. It is left
///   alone while an operation or a conflict is in progress.
/// - Other branches only move their ref (`update-ref` with the old commit, so a branch that
///   changed meanwhile is not overwritten). A branch checked out in another worktree, or being
///   rebased or bisected in any worktree, is left as it is.
/// - Diverged branches are reported, never changed.
pub fn pull_branches(repo: &Path, branches: Option<&[String]>, mut on_line: impl FnMut(&str)) -> GitResult<BranchesSync> {
    let mut result = BranchesSync::default();
    // Remotes a Pull all could not fetch: their branches keep stale remote-tracking branches,
    // are reported and never moved; the other remotes' branches are still pulled.
    let mut unfetched: Vec<(String, String)> = Vec::new();
    let only = match branches {
        None => {
            match fetch(repo, None, true, &mut on_line) {
                Ok(_) => {}
                Err(error) if error.kind == "partial-fetch" => {
                    let problems: HashMap<&str, &str> = error
                        .message
                        .split("Could not fetch ")
                        .skip(1)
                        .filter_map(|part| part.split_once(": "))
                        .map(|(name, problem)| (name, problem.trim()))
                        .collect();
                    for remote in &error.details {
                        let problem = problems.get(remote.as_str()).copied().unwrap_or("the fetch failed.");
                        let reason = format!("Could not fetch {remote}: {problem}");
                        // Named even when none of its branches had incoming commits.
                        result.skipped.push(BranchSkip { branch: format!("{remote} (remote)"), reason: reason.clone() });
                        unfetched.push((remote.clone(), reason));
                    }
                }
                Err(error) => return Err(error),
            }
            None
        }
        Some(branches) => {
            let (local, remote) = chosen_branches(repo, branches, &mut result)?;
            for name in remote {
                let branch = name.strip_prefix("refs/remotes/").unwrap_or(&name).to_owned();
                result.skipped.push(BranchSkip { branch, reason: "A remote branch: pull the local branch that tracks it.".into() });
            }
            let fetched = fetch_chosen(repo, &local, &[], &mut result, &mut on_line)?;
            // A branch whose upstream was not fetched (deleted on the remote) keeps its old
            // remote-tracking branch: it is reported above and never moved there. Branches that
            // track another local branch need no fetch.
            let listed = local_branches(repo)?;
            let local_upstream = |name: &String| listed.iter().any(|b| &b.name == name && b.remote == ".");
            Some(local.into_iter().filter(|name| fetched.contains(name) || local_upstream(name)).collect::<HashSet<_>>())
        }
    };
    let head = runner::exec(repo, ["symbolic-ref", "--quiet", "HEAD"])?;
    let head = head.ok().then(|| head.text().trim().to_owned());
    let busy = busy_branches(repo)?.operations;
    let mut current = None;
    for local in local_branches(repo)? {
        let LocalBranch { name, upstream, track, .. } = &local;
        // Branches without an upstream were reported by the fetch of chosen branches.
        if only.as_ref().is_some_and(|only| !only.contains(name)) || upstream.is_empty() {
            continue;
        }
        // The listing only picks candidates; every decision below uses the exact commit.
        if !track_counts(track).is_some_and(|(_, behind)| behind > 0) {
            continue;
        }
        if let Some((_, reason)) = unfetched.iter().find(|(remote, _)| *remote == local.remote) {
            result.skipped.push(BranchSkip { branch: local.short(), reason: reason.clone() });
            continue;
        }
        // A failure on one branch is reported for it; branches already moved stay in the report.
        match pull_one(repo, &local, head.as_deref(), &busy) {
            Ok(PullOne::Nothing) => {}
            Ok(PullOne::Moved(behind)) => result.updated.push(BranchUpdate { branch: local.short(), commits: behind, current: false }),
            Ok(PullOne::Skipped(reason)) => result.skipped.push(BranchSkip { branch: local.short(), reason }),
            Ok(PullOne::Current(behind, target)) => current = Some((local.name.clone(), local.short(), local.oid.clone(), behind, target)),
            Err(error) if error.kind == "cancelled" => return Err(error),
            Err(error) => result.skipped.push(BranchSkip { branch: local.short(), reason: first_line(&error.message, "The pull failed.") }),
        }
    }
    if let Some((name, branch, oid, behind, target)) = current {
        let blocked = match current_branch_blocked(repo, &name, &oid, &target) {
            Ok(blocked) => blocked,
            Err(error) if error.kind == "cancelled" => return Err(error),
            Err(error) => Some(first_line(&error.message, "The pull failed.")),
        };
        match blocked {
            Some(reason) => result.skipped.push(BranchSkip { branch, reason }),
            None => match fast_forward_current(repo, &oid, &target, &mut on_line) {
                Ok(()) => result.updated.push(BranchUpdate { branch, commits: behind, current: true }),
                Err(error) if error.kind == "cancelled" => return Err(error),
                Err(error) => result.skipped.push(BranchSkip { branch, reason: error.message }),
            },
        }
    }
    Ok(result)
}

enum PullOne {
    Nothing,
    Moved(usize),
    Skipped(String),
    /// The checked-out branch: fast-forwarded last, to this commit.
    Current(usize, String),
}

/// Decides and, for a branch that is not checked out, performs the fast-forward of one branch
/// of a Pull of several branches.
fn pull_one(repo: &Path, local: &LocalBranch, head: Option<&str>, busy: &HashSet<String>) -> GitResult<PullOne> {
    let LocalBranch { name, oid, upstream, worktree, .. } = local;
    let target = runner::exec(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{upstream}^{{commit}}")])?;
    if !target.ok() {
        return Ok(PullOne::Nothing);
    }
    let target = target.text().trim().to_owned();
    let (ahead, behind) = ahead_behind(repo, oid, &target)?;
    Ok(if behind == 0 {
        PullOne::Nothing
    } else if ahead > 0 {
        PullOne::Skipped(format!("Diverged: {ahead} local and {behind} incoming commits. Pull it on its own to merge or rebase."))
    } else if busy.contains(name) {
        PullOne::Skipped("A rebase or bisect in progress works on this branch. Finish or abort it first.".into())
    } else if head == Some(name.as_str()) {
        PullOne::Current(behind, target)
    } else if !worktree.is_empty() {
        PullOne::Skipped(format!("Checked out in the worktree {worktree}."))
    } else if let Some(reason) = busy_now(repo, name)? {
        // Checked out or taken by a rebase since the listing: moving the ref would leave
        // that worktree's files behind.
        PullOne::Skipped(reason)
    } else if runner::exec(repo, ["update-ref", "-m", "pull: fast-forward (Pull all)", name, &target, oid])?.ok() {
        PullOne::Moved(behind)
    } else {
        PullOne::Skipped("The branch changed meanwhile.".into())
    })
}

/// The settings that decide where a plain `git push` sends a branch.
#[derive(Default)]
struct PushRules {
    /// `push.default` ("simple" when unset).
    default: String,
    /// `remote.pushDefault`.
    push_default: Option<String>,
    /// `branch.<name>.pushRemote`, by branch name.
    push_remote: HashMap<String, String>,
    /// Remotes with `remote.<name>.push` refspecs.
    mapped: HashSet<String>,
}

impl PushRules {
    fn read(repo: &Path) -> GitResult<Self> {
        let out =
            super::config_cache::exec(repo, &["config", "--get-regexp", r"^(push\.default|remote\.pushdefault|branch\..*\.pushremote|remote\..*\.push)$"])?;
        if !out.ok() && out.code != 1 {
            return Err(runner::to_error("git config --get-regexp", &out));
        }
        let mut rules = PushRules { default: "simple".into(), ..PushRules::default() };
        for line in out.text().lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            let value = value.trim().to_owned();
            if key == "push.default" {
                rules.default = value.to_ascii_lowercase();
            } else if key == "remote.pushdefault" {
                rules.push_default = Some(value);
            } else if let Some(branch) = key.strip_prefix("branch.").and_then(|k| k.strip_suffix(".pushremote")) {
                rules.push_remote.insert(branch.to_owned(), value);
            } else if let Some(remote) = key.strip_prefix("remote.").and_then(|k| k.strip_suffix(".push")) {
                rules.mapped.insert(remote.to_owned());
            }
        }
        Ok(rules)
    }

    /// Why a plain `git push` of `branch` would not go to its upstream, if it would not. Push
    /// of several branches only sends a branch where Git itself would send it.
    fn elsewhere(&self, branch: &LocalBranch) -> Option<String> {
        let short = branch.short();
        let target = self.push_remote.get(&short).or(self.push_default.as_ref()).unwrap_or(&branch.remote);
        if *target != branch.remote {
            return Some(format!("Pushes of this branch go to {target}, not to its upstream on {}. Push it on its own with Push….", branch.remote));
        }
        if self.mapped.contains(&branch.remote) {
            return Some(format!("{} has its own push rules (remote.{}.push). Push it on its own with Push….", branch.remote, branch.remote));
        }
        let same_name = branch.remote_ref == format!("refs/heads/{short}");
        match self.default.as_str() {
            "upstream" | "tracking" => None,
            "nothing" => Some("push.default is \"nothing\": Git pushes no branch without a destination. Push it on its own with Push….".into()),
            _ if same_name => None,
            _ => {
                let upstream = branch.upstream.strip_prefix("refs/remotes/").unwrap_or(&branch.upstream);
                Some(format!("Its upstream {upstream} has another name, so Git would not push it there. Push it on its own with Push… to choose."))
            }
        }
    }
}

/// Push for chosen branches, or for every local branch with `None`: each branch with commits
/// its upstream lacks goes to that upstream (one `git push` per remote, never forced). A branch
/// whose upstream has commits it lacks is reported instead; so is a branch the remote refused.
/// Branches without an upstream are only reported when they were chosen.
///
/// A branch is only sent where a plain `git push` would send it (same name, or
/// `push.default=upstream`; no other push remote; no push refspecs), and exactly at the commit
/// that was checked. Several branches with one destination are reported, not pushed: Git would
/// refuse the whole push. A remote that fails leaves the other remotes' branches to be pushed.
pub fn push_branches(repo: &Path, branches: Option<&[String]>, mut on_line: impl FnMut(&str)) -> GitResult<BranchesSync> {
    let mut result = BranchesSync::default();
    let only = match branches {
        None => None,
        Some(branches) => {
            let (local, remote) = chosen_branches(repo, branches, &mut result)?;
            for name in remote {
                let branch = name.strip_prefix("refs/remotes/").unwrap_or(&name).to_owned();
                result.skipped.push(BranchSkip { branch, reason: "A remote branch: push the local branch that tracks it.".into() });
            }
            Some(local)
        }
    };
    let head = runner::exec(repo, ["symbolic-ref", "--quiet", "HEAD"])?;
    let head = head.ok().then(|| head.text().trim().to_owned());
    let mut by_remote: BTreeMap<String, Vec<(LocalBranch, usize)>> = BTreeMap::new();
    let rules = PushRules::read(repo)?;
    let listed = local_branches(repo)?;
    if let Some(only) = &only {
        for name in only.iter().filter(|name| !listed.iter().any(|b| &b.name == *name)) {
            let branch = name.strip_prefix("refs/heads/").unwrap_or(name).to_owned();
            result.skipped.push(BranchSkip { branch, reason: "The branch no longer exists.".into() });
        }
    }
    for local in listed {
        let chosen = match &only {
            Some(only) if !only.contains(&local.name) => continue,
            Some(_) => true,
            None => false,
        };
        let mut skip = |reason: String| result.skipped.push(BranchSkip { branch: local.short(), reason });
        if local.upstream.is_empty() || local.remote.is_empty() || local.remote_ref.is_empty() {
            if chosen {
                skip("No upstream branch. Push it on its own once to publish it.".into());
            }
            continue;
        }
        if local.remote == "." {
            if chosen {
                let upstream = local.remote_ref.strip_prefix("refs/heads/").unwrap_or(&local.remote_ref);
                skip(format!("It tracks the local branch {upstream}: nothing goes to a remote."));
            }
            continue;
        }
        let Some((ahead, behind)) = track_counts(&local.track) else {
            if chosen {
                skip("The upstream branch was deleted on the remote.".into());
            }
            continue;
        };
        if ahead == 0 {
            continue;
        }
        if behind > 0 {
            skip(format!("Diverged: {ahead} local and {behind} incoming commits. Pull it first."));
            continue;
        }
        if let Some(reason) = rules.elsewhere(&local) {
            skip(reason);
            continue;
        }
        by_remote.entry(local.remote.clone()).or_default().push((local, ahead));
    }
    // Two branches pushed to one remote branch make Git refuse the whole push.
    for (remote, list) in &mut by_remote {
        let mut destinations: HashMap<String, usize> = HashMap::new();
        for (local, _) in list.iter() {
            *destinations.entry(local.remote_ref.clone()).or_default() += 1;
        }
        list.retain(|(local, _)| {
            let shared = destinations[&local.remote_ref];
            if shared > 1 {
                let target = local.remote_ref.strip_prefix("refs/heads/").unwrap_or(&local.remote_ref);
                let reason = format!("{shared} local branches push to {remote}/{target}. Push one of them on its own.");
                result.skipped.push(BranchSkip { branch: local.short(), reason });
            }
            shared == 1
        });
    }
    by_remote.retain(|_, list| !list.is_empty());
    // The checkpoint a single Push takes first, only when something will be sent: most
    // repositories have nothing to push, and a checkpoint each would bury the list.
    if !by_remote.is_empty() {
        super::recovery::automatic(repo, "push_branches", false, false)?;
    }
    for (remote, list) in by_remote {
        // The exact commit that was checked: a branch that moves meanwhile sends nothing unseen.
        let specs: Vec<String> = list.iter().map(|(b, _)| format!("{}:{}", b.oid, b.remote_ref)).collect();
        let error = match specs.iter().try_for_each(|spec| super::recovery::protect_transport(repo, true, Some(&remote), Some(spec), false)) {
            Err(error) => Some(error),
            Ok(()) => {
                // Only the listed branches: `push.followTags` would also publish annotated tags
                // that the report never shows.
                let mut args = vec!["push".to_string(), "--progress".into(), "--no-follow-tags".into(), remote.clone()];
                args.extend(specs);
                match runner::run_streaming(repo, &args, &[], &mut on_line) {
                    Ok(_) => None,
                    Err(error) if error.kind == "cancelled" => return Err(error),
                    Err(error) => Some(error),
                }
            }
        };
        // Git moves the remote-tracking branch of every branch the remote accepted.
        for (local, ahead) in list {
            let tip = runner::exec(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", &local.upstream]);
            if tip.as_ref().is_ok_and(|tip| tip.ok() && tip.text().trim() == local.oid) {
                let current = head.as_deref() == Some(local.name.as_str());
                result.updated.push(BranchUpdate { branch: local.short(), commits: ahead, current });
                continue;
            }
            let reason = match &error {
                // "[remote rejected]" is a hook or a protection rule, not missing commits.
                Some(error) if error.kind == "rejected" && !error.message.contains("remote rejected") && !error.stderr.contains("remote rejected") => {
                    "The remote branch has commits this branch lacks. Pull it first.".to_owned()
                }
                Some(error) => first_line(&error.message, "The push failed."),
                None => "The remote branch did not move.".to_owned(),
            };
            result.skipped.push(BranchSkip { branch: local.short(), reason });
        }
    }
    Ok(result)
}

fn first_line(text: &str, fallback: &str) -> String {
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or(fallback).to_owned()
}

/// Moves the checked-out branch exactly to `target`, a verified descendant of HEAD. Local
/// changes stay where they are (they touch none of the incoming files), so nothing is stashed.
fn fast_forward_current(repo: &Path, oid: &str, target: &str, on_line: &mut impl FnMut(&str)) -> GitResult<()> {
    let recurse = super::config_cache::exec(repo, &["config", "--bool", "--get", "submodule.recurse"])?;
    if !recurse.ok() && recurse.code != 1 {
        return Err(runner::to_error("git config submodule.recurse", &recurse));
    }
    let recurse = recurse.ok() && recurse.text().trim() == "true";
    if recurse {
        super::pull_guard::submodules(repo, target, "ff-only")?;
    }
    // The recovery checkpoint a single Pull takes first, only when files will change: most
    // repositories have nothing to pull, and a checkpoint each would bury the list. When ignored
    // files are in the way of the incoming commits, their checkpoint is that one.
    if !protect_ignored_files(repo, "pull_branches", Some(oid), target)? {
        super::recovery::automatic(repo, "pull_branches", true, false)?;
    }
    let outcome = merge_start_with_autostash(repo, target, "ff-only", false)?;
    if !matches!(outcome.status.as_str(), "done" | "fastForward") {
        return Err(GitError::new(outcome.message));
    }
    if recurse {
        let args = ["submodule", "update", "--recursive", "--checkout"].map(String::from);
        runner::run_streaming(repo, &args, &[], on_line)?;
    }
    Ok(())
}

/// Paths integrating `target` into `head` can write: every path that differs between them and,
/// for a rebase, the paths of the local commits that are replayed (`target...head`).
fn integration_paths(repo: &Path, head: Option<&str>, target: &str) -> GitResult<Vec<String>> {
    let names = |args: &[&str]| -> GitResult<Option<Vec<String>>> {
        let out = runner::exec(repo, args)?;
        if !out.ok() {
            return Ok(None);
        }
        let text = super::workspace_files::path_list(&out.stdout)?;
        Ok(Some(text.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect()))
    };
    let all_of = |rev: &str| names(&["ls-tree", "-r", "-z", "--name-only", "--end-of-options", rev]);
    let Some(head) = head else {
        return all_of(target)?.ok_or_else(|| GitError::new("Listing the incoming files failed."));
    };
    let mut paths: BTreeSet<String> = names(&["diff", "--name-only", "--no-renames", "-z", head, target, "--"])?
        .ok_or_else(|| GitError::new("Listing the incoming changes failed."))?
        .into_iter()
        .collect();
    // Unrelated histories have no merge base: then every local file may be written.
    let local = match names(&["diff", "--name-only", "--no-renames", "-z", &format!("{target}...{head}"), "--"])? {
        Some(local) => local,
        None => all_of(head)?.unwrap_or_default(),
    };
    paths.extend(local);
    Ok(paths.into_iter().collect())
}

/// Saves the individual ignored files in the way of integrating `target` (see
/// [`super::recovery::watch_ignored_for`]). Returns true when that created a checkpoint.
fn protect_ignored_files(repo: &Path, command: &str, head: Option<&str>, target: &str) -> GitResult<bool> {
    if head == Some(target) {
        return Ok(false);
    }
    let paths = integration_paths(repo, head, target)?;
    if paths.is_empty() {
        return Ok(false);
    }
    super::recovery::watch_ignored_for(repo, command, &paths)
}

/// Why Pull all leaves the checked-out branch alone, if it does.
fn current_branch_blocked(repo: &Path, name: &str, oid: &str, target: &str) -> GitResult<Option<String>> {
    if repo::op_state(repo, &repo::git_dir(repo)?).kind != "none" {
        return Ok(Some("An operation is in progress. Finish or abort it first.".into()));
    }
    // The same branch must still be checked out: a fast-forward moves whatever HEAD names.
    let head = runner::exec(repo, ["symbolic-ref", "--quiet", "HEAD"])?;
    if !head.ok() || head.text().trim() != name {
        return Ok(Some("Another branch was checked out meanwhile.".into()));
    }
    // HEAD must still be the commit the counts were made for.
    if runner::run(repo, ["rev-parse", "HEAD"])?.trim() != oid {
        return Ok(Some("The branch changed meanwhile.".into()));
    }
    let names = |args: &[&str]| -> GitResult<std::collections::HashSet<String>> {
        Ok(runner::run(repo, args)?.split('\0').filter(|s| !s.is_empty()).map(str::to_owned).collect())
    };
    let changed = names(&["diff", "--name-only", "-z", "--no-renames", "HEAD"])?;
    if !names(&["diff", "--name-only", "-z", "--diff-filter=U"])?.is_empty() {
        return Ok(Some("Conflicts need attention.".into()));
    }
    let untracked = names(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    if changed.is_empty() && untracked.is_empty() {
        return Ok(None);
    }
    let incoming = names(&["diff", "--name-only", "-z", "--no-renames", oid, target])?;
    let mut touched: Vec<&String> = incoming.iter().filter(|path| changed.contains(*path) || untracked.contains(*path)).collect();
    if touched.is_empty() {
        // The incoming commits change other files: the local changes stay as they are.
        return Ok(None);
    }
    touched.sort();
    let shown: Vec<&str> = touched.iter().take(3).map(|s| s.as_str()).collect();
    let more = if touched.len() > 3 { format!(" and {} more", touched.len() - 3) } else { String::new() };
    Ok(Some(format!("Local changes in files the incoming commits change: {}{more}.", shown.join(", "))))
}

/// "Revqora: changes on <branch> saved before pull", so the stash list says what a kept copy is.
fn pull_stash_name(repo: &Path) -> GitResult<String> {
    let branch = runner::exec(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let branch = if branch.ok() { branch.text().trim().to_owned() } else { "detached HEAD".into() };
    Ok(format!("Revqora: changes on {branch} saved before pull"))
}

fn stash_top(repo: &Path) -> GitResult<Option<String>> {
    let top = runner::exec(repo, ["rev-parse", "--quiet", "--verify", "refs/stash"])?;
    Ok(top.ok().then(|| top.text().trim().to_owned()))
}

/// When restoring Git's autostash conflicted, Git keeps the changes as a stash called
/// "autostash". Give that entry the pull's name. Older entries are never touched.
fn name_autostash(repo: &Path, before: Option<&str>, name: &str) -> GitResult<()> {
    let Some(oid) = stash_top(repo)? else { return Ok(()) };
    if Some(oid.as_str()) == before {
        return Ok(());
    }
    let subject = runner::run(repo, ["log", "-g", "-1", "--format=%gs", "refs/stash"])?;
    if subject.trim() != "autostash" {
        return Ok(());
    }
    // Storing the commit that is already on top adds no entry, so drop the unnamed one first.
    // The commit stays in the repository; if storing fails, the error names it.
    runner::run(repo, ["stash", "drop", "-q", "stash@{0}"])?;
    runner::run(repo, ["stash", "store", "-m", name, &oid])
        .map_err(|e| GitError::new(format!("Your changes are kept in commit {oid}, but naming its stash failed: {}", e.message)))?;
    Ok(())
}

/// `set_aside` saves the staged work; it runs once, right before Git integrates the upstream
/// (never when the pull stops earlier).
fn pull_unsaved(
    repo: &Path,
    mode: &str,
    prune_remote: bool,
    set_aside: impl FnOnce() -> GitResult<()>,
    mut on_line: impl FnMut(&str),
) -> GitResult<PullOutcome> {
    // The status read already lists the index; compare that listing after the fetch.
    let (before, index_before) = status::status_with_index(repo)?;
    let branch = before.branch.as_deref().ok_or_else(|| GitError::new("Choose a branch with an upstream before pulling."))?;
    let config_key = format!("branch.{branch}.merge");
    // Configuration answers are remembered between reads; `.git/config` is also part of
    // the diff context token compared below.
    let merges = super::config_cache::exec(repo, &["config", "--get-all", &config_key])?;
    let merge_text = merges.text();
    let configured: Vec<_> = merge_text.lines().filter(|s| !s.is_empty()).collect();
    if !merges.ok() || configured.len() != 1 {
        return Err(GitError::new("Configure one upstream for this branch before pulling."));
    }
    let remote_key = format!("branch.{branch}.remote");
    let remote_config = super::config_cache::exec(repo, &["config", "--get", &remote_key])?;
    if !remote_config.ok() && remote_config.code != 1 {
        return Err(runner::to_error("git config branch remote", &remote_config));
    }
    let remote = if remote_config.ok() { remote_config.text() } else { "origin".into() };
    let remote = remote.trim();
    let prune = prune_remote && pull_can_prune(repo, remote)?;
    let unchanged = || -> GitResult<bool> {
        let (after, index_after) = status::status_with_index(repo)?;
        Ok(before.branch == after.branch
            && before.oid == after.oid
            && before.files == after.files
            && before.diff_context_token == after.diff_context_token
            && super::config_cache::exec(repo, &["config", "--get-all", &config_key])?.text() == merge_text
            && super::config_cache::exec(repo, &["config", "--get", &remote_key])?.text() == remote_config.text()
            && index_before == index_after)
    };
    let fork_point = if mode == "rebase" && before.oid.is_some() {
        let point = runner::exec(repo, ["merge-base", "--fork-point", "@{upstream}", "HEAD"])?;
        point.ok().then(|| point.text().trim().to_owned())
    } else {
        None
    };
    // Parse before fetching/merging, including Git's yes/on/1 spellings.
    // Invalid configuration must fail before a partially completed pull.
    let recurse = super::config_cache::exec(repo, &["config", "--bool", "--get", "submodule.recurse"])?;
    if !recurse.ok() && recurse.code != 1 {
        return Err(runner::to_error("git config submodule.recurse", &recurse));
    }
    let recurse = recurse.ok() && recurse.text().trim() == "true";
    // All Pull modes fetch once, resolve exactly that target, and inspect
    // ignored collisions before any merge/rebase/autostash changes working files.
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
        &LOG_TRACKING,
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
        return Err(GitError::new("Pull stopped because the working tree, current branch or upstream configuration changed. Review it before pulling again.")
            .kind("stale-operation"));
    }
    if let Err(error) = fetched {
        if repo::op_state(repo, &repo::git_dir(repo)?).kind == "none" {
            if let Some(outcome) = deleted_pull_upstream(repo, branch, remote, configured[0], prune_remote)? {
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
            if let Some(outcome) = deleted_pull_upstream(repo, branch, remote, configured[0], prune_remote)? {
                return Ok(outcome);
            }
        }
        return Err(GitError::new(format!("Fetch completed, but upstream {} on {remote} was not fetched unambiguously. Check the remote's fetch refspecs. Local branch {branch} was not merged.", configured[0])).kind("upstream-not-fetched"));
    }
    if recurse {
        super::pull_guard::submodules(repo, targets[0], mode)?;
        if !unchanged()? {
            return Err(
                GitError::new("Pull stopped because the repository changed during submodule inspection. Review it before retrying.").kind("stale-operation")
            );
        }
    }
    // Now that the target is known, the pull's one recovery checkpoint: with the ignored files
    // in the way of what this pull writes, or the ordinary one when there are none.
    if !protect_ignored_files(repo, "pull", before.oid.as_deref(), targets[0])? && super::recovery::in_operation("pull") {
        super::recovery::automatic(repo, "pull", true, false)?;
    }
    let mut set_aside = Some(set_aside);
    let mut set_aside = move || set_aside.take().map_or(Ok(()), |f| f());
    let mut outcome = if mode == "rebase" {
        let can_ff = match before.oid.as_deref() {
            Some(head) => {
                let result = runner::exec(repo, ["merge-base", "--is-ancestor", head, targets[0]])?;
                if !result.ok() && result.code != 1 {
                    return Err(runner::to_error("git merge-base", &result));
                }
                result.ok()
            }
            None => true,
        };
        if can_ff {
            set_aside()?;
            let mut result = merge_start_with_autostash(repo, targets[0], "ff-only", true)?;
            // Preserve the rebase-Pull API's success status, including when
            // native Git can integrate it without replaying any commits.
            if matches!(result.status.as_str(), "done" | "fastForward" | "upToDate") {
                result.status = "done".into();
            }
            result
        } else {
            guard_untracked_tree(repo, targets[0])?;
            // Match Git Pull's pre-fetch reflog fork point: rewritten upstream
            // commits must not be replayed as if they were the user's commits.
            let mut upstream = targets[0];
            if let (Some(fork), Some(head)) = (fork_point.as_deref(), before.oid.as_deref()) {
                let base = runner::exec(repo, ["merge-base", "--octopus", head, targets[0], fork])?;
                if !base.ok() && base.code != 1 {
                    return Err(runner::to_error("git merge-base", &base));
                }
                if !base.ok() || base.text().trim() != fork {
                    upstream = fork;
                }
            }
            super::pull_guard::replayed_paths(repo, upstream, recurse)?;
            if !unchanged()? {
                return Err(
                    GitError::new("Pull stopped because the repository changed during rebase inspection. Review it before retrying.").kind("stale-operation")
                );
            }
            set_aside()?;
            let args = ["rebase", "--autostash", "--onto", targets[0], upstream].map(String::from);
            match runner::run_streaming(repo, &args, &[], &mut on_line) {
                Ok(output) if autostash_conflict(repo, &output) => autostash_outcome(repo),
                Ok(output) => OpOutcome::done(output),
                Err(error) => {
                    let conflicts = conflicted(repo);
                    if conflicts.is_empty() && repo::op_state(repo, &repo::git_dir(repo)?).kind != "rebase" {
                        return Err(error);
                    }
                    OpOutcome { status: if conflicts.is_empty() { "stopped" } else { "conflicts" }.into(), conflicts, message: error.message }
                }
            }
        }
    } else {
        set_aside()?;
        merge_start_with_autostash(repo, targets[0], if mode == "merge" { "ff" } else { "ff-only" }, true).map_err(|mut error| {
            if error.kind == "diverged" {
                // Git's own text is a hint list about pull.rebase configuration.
                error.message = format!(
                    "Your branch and {remote}/{} have diverged, so a fast-forward is not possible. Pull with merge or rebase.",
                    configured[0].strip_prefix("refs/heads/").unwrap_or(configured[0])
                );
            }
            error
        })?
    };
    if recurse && !matches!(outcome.status.as_str(), "conflicts" | "stopped") {
        // Native `git pull` does this after a successful merge, including
        // --no-commit. No --init or --force: preserve uninitialized modules
        // and let checkout reject dirty tracked/untracked collisions.
        let args = ["submodule", "update", "--recursive", if mode == "rebase" { "--rebase" } else { "--checkout" }].map(String::from);
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
    Ok(outcome.into())
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
        // A bare lease compares with the remote-tracking ref, which background fetch keeps
        // moving, so it would overwrite commits pushed by others. `--force-if-includes` also
        // requires that the remote tip was once part of the local branch (its reflog).
        args.extend(lease_args(repo, o)?);
    }
    if o.tags {
        // All or nothing: without --atomic a refused branch still published its tags.
        args.push("--tags".into());
        args.push("--atomic".into());
    }
    if let Some(r) = &o.remote {
        args.push(r.clone());
        if let Some(b) = &o.branch {
            let rb = o.remote_branch.clone().unwrap_or_else(|| b.clone());
            args.push(format!("refs/heads/{b}:refs/heads/{rb}"));
        }
    }
    let mut on_line = on_line;
    match runner::run_streaming(repo, &args, &[], &mut on_line) {
        // A server without atomic push support refuses before anything is sent.
        Err(error) if o.tags && error.stderr.contains("does not support --atomic") => {
            args.retain(|a| a != "--atomic");
            runner::run_streaming(repo, &args, &[], &mut on_line)
        }
        result => result,
    }
}

/// Lease arguments for a force push. With entries in the remote-tracking ref's reflog (it gets
/// them once anything is fetched or pushed), `--force-if-includes` refuses remote tips that never
/// reached the local branch. Without them (fresh clone; nothing has moved the ref) the lease
/// names the exact remote tip, or requires the remote branch to be absent.
/// Whether `oid` was ever part of local branch `branch`: reachable from its tip or from one of
/// its reflog entries (an amended or rebased-away commit stays in the reflog).
fn integrated_locally(repo: &Path, branch: &str, oid: &str) -> GitResult<bool> {
    let reference = format!("refs/heads/{branch}");
    let mut candidates = vec![reference.clone()];
    if let Ok(log) = runner::run(repo, ["reflog", "show", "--format=%H", "-n", "200", &reference]) {
        candidates.extend(log.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()));
    }
    for candidate in candidates {
        if runner::exec(repo, ["merge-base", "--is-ancestor", oid, &candidate])?.ok() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn lease_args(repo: &Path, o: &PushOptions) -> GitResult<Vec<String>> {
    let (Some(remote), Some(b)) = (&o.remote, &o.branch) else {
        return Ok(vec!["--force-with-lease".into(), "--force-if-includes".into()]);
    };
    let rb = o.remote_branch.as_deref().unwrap_or(b);
    let tracking = format!("refs/remotes/{remote}/{rb}");
    let tip =
        runner::run(repo, ["rev-parse", "--verify", "--quiet", &format!("{tracking}^{{commit}}")]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    // A fresh clone may leave an empty reflog file; only real entries make the check meaningful.
    let has_reflog = runner::run(repo, ["reflog", "show", "--format=%H", "-n", "1", &tracking]).map(|out| !out.trim().is_empty()).unwrap_or(false);
    // Git's `--force-if-includes` looks for a local branch named like the remote branch, so it
    // refuses every push from `main` to `feature/x`. Revqora checks the same proof itself then.
    let renamed = rb != b.as_str();
    // Without tracking reflog entries (fresh clone, or expired/cleared reflogs) the remote tip
    // may have been fetched by anyone. Only lease on it with independent proof that it was part
    // of the local branch: an ancestor of the branch or of one of its reflog entries.
    if let (Some(oid), true) = (&tip, !has_reflog || renamed) {
        if !integrated_locally(repo, b, oid)? {
            return Err(GitError::new(format!(
                "The remote branch has commits that were never part of your local {b}, and Git's history cannot show whether you reviewed them. Pull (or merge {remote}/{rb}) first, then force push."
            ))
            .kind("lease-unverifiable"));
        }
    }
    Ok(match tip {
        // Refname-only form: an explicit expected value would turn --force-if-includes off.
        Some(_) if has_reflog && !renamed => vec![format!("--force-with-lease=refs/heads/{rb}"), "--force-if-includes".into()],
        Some(oid) => vec![format!("--force-with-lease=refs/heads/{rb}:{oid}")],
        None => vec![format!("--force-with-lease=refs/heads/{rb}:")],
    })
}

pub fn push_ref(repo: &Path, remote: &str, refspec: &str, on_line: impl FnMut(&str)) -> GitResult<String> {
    if refspec.starts_with('-') {
        return Err(GitError::new("Choose an explicit branch or tag refspec."));
    }
    super::recovery::protect_transport(repo, true, Some(remote), Some(refspec), false)?;
    runner::run_streaming(repo, &["push".into(), "--progress".into(), remote.into(), refspec.into()], &[], on_line)
}

/// Partial clone filters offered by the clone dialog; free-form filter specs are never accepted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum CloneFilter {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "blob:none")]
    BlobNone,
    #[serde(rename = "tree:0")]
    TreeZero,
}

/// Optional `git clone` arguments. The default reproduces a plain clone with submodules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloneOptions {
    pub branch: Option<String>,
    pub depth: Option<u32>,
    pub no_single_branch: bool,
    pub filter: CloneFilter,
    pub recurse_submodules: bool,
    pub shallow_submodules: bool,
    /// `--sparse`: start with only the top-level files checked out.
    pub sparse: bool,
    /// Folders added with `sparse-checkout set --cone` right after a sparse clone.
    pub sparse_folders: Vec<String>,
}

impl Default for CloneOptions {
    fn default() -> Self {
        Self {
            branch: None,
            depth: None,
            no_single_branch: true,
            filter: CloneFilter::None,
            recurse_submodules: true,
            shallow_submodules: false,
            sparse: false,
            sparse_folders: Vec::new(),
        }
    }
}

/// Validated option arguments placed before `--`; each value is a separate argv entry.
pub fn clone_option_args(parent: &Path, options: &CloneOptions) -> GitResult<Vec<String>> {
    let mut args = Vec::new();
    if let Some(branch) = options.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        if branch.starts_with('-') || branch.chars().any(|c| c.is_control()) {
            return Err(GitError::new("Enter a valid branch name.").kind("invalid-branch"));
        }
        if !runner::exec(parent, ["check-ref-format", "--branch", branch])?.ok() {
            return Err(GitError::new(format!("{branch} is not a valid branch name.")).kind("invalid-branch"));
        }
        args.extend(["--branch".into(), branch.to_string()]);
    }
    if let Some(depth) = options.depth {
        if depth == 0 {
            return Err(GitError::new("Depth must be a positive whole number.").kind("invalid-depth"));
        }
        args.extend(["--depth".into(), depth.to_string()]);
        if options.no_single_branch {
            args.push("--no-single-branch".into());
        }
    }
    match options.filter {
        CloneFilter::None => {}
        CloneFilter::BlobNone => args.push("--filter=blob:none".into()),
        CloneFilter::TreeZero => args.push("--filter=tree:0".into()),
    }
    if options.sparse {
        for folder in &options.sparse_folders {
            super::sparse::normalize_folder(folder)?;
        }
        args.push("--sparse".into());
    }
    if options.recurse_submodules {
        args.push("--recurse-submodules".into());
        if options.depth.is_some() && options.shallow_submodules {
            args.push("--shallow-submodules".into());
        }
    }
    Ok(args)
}

pub fn clone(parent: &Path, url: &str, dir_name: &str, on_line: impl FnMut(&str)) -> GitResult<PathBuf> {
    clone_with_connection(parent, url, dir_name, on_line, None).map(|result| result.0)
}
pub fn clone_with_connection(
    parent: &Path,
    url: &str,
    dir_name: &str,
    on_line: impl FnMut(&str),
    connection: Option<&super::connection::Options>,
) -> GitResult<(PathBuf, Option<String>)> {
    clone_with_options(parent, url, dir_name, &CloneOptions::default(), on_line, connection)
}
pub fn clone_with_options(
    parent: &Path,
    url: &str,
    dir_name: &str,
    options: &CloneOptions,
    on_line: impl FnMut(&str),
    connection: Option<&super::connection::Options>,
) -> GitResult<(PathBuf, Option<String>)> {
    if let Some(options) = connection {
        super::connection::validate_for(parent, options)?;
    }
    std::fs::create_dir_all(parent)?;
    let root = parent.join(dir_name);
    let mut args: Vec<String> = vec!["clone".into(), "--progress".into()];
    args.extend(clone_option_args(parent, options)?);
    // `--`: a pasted "URL" such as --upload-pack=... must never be read as an option.
    args.extend(["--".into(), url.into(), dir_name.into()]);
    runner::run_streaming_with_connection(parent, &args, &[(crate::git_credentials::REPO_VAR, &root.to_string_lossy())], on_line, connection)?;
    // The clone exists; a failure here must not hide it, so it becomes a clone warning.
    let sparse_warning = (options.sparse && options.sparse_folders.iter().any(|f| !f.trim().is_empty()))
        // The selected connection is saved below; the initial folders may already fetch blobs with it.
        .then(|| super::sparse::set_with_connection(&root, true, &options.sparse_folders, connection).err())
        .flatten()
        .map(|e| {
            format!(
                "Repository cloned with only its top-level files, but the folders could not be added: {}. Add them in Repository tools > Sparse checkout.",
                e.message
            )
        });
    // An explicit default selection must replace preferences left by a previous
    // clone at this path too; otherwise Auto silently reuses its old SSH key.
    let warning = connection.and_then(|options| {
        super::connection::snapshot(&root).and_then(|before| super::connection::save(&root, options.clone(), &before.revision)).err().map(|error| {
            format!(
                "Repository cloned. Authentication preferences were not saved: {}. Open Git connection settings before the next network operation.",
                error.message
            )
        })
    });
    let warning = match (sparse_warning, warning) {
        (Some(a), Some(b)) => Some(format!("{a} {b}")),
        (a, b) => a.or(b),
    };
    Ok((root, warning))
}

pub fn remote_add(repo: &Path, name: &str, url: &str) -> GitResult<()> {
    runner::run(repo, ["remote", "add", "--", name.trim(), url.trim()])?;
    Ok(())
}

pub fn remote_remove(repo: &Path, name: &str) -> GitResult<()> {
    runner::run(repo, ["remote", "remove", name])?;
    Ok(())
}

pub fn remote_set_url(repo: &Path, name: &str, url: &str) -> GitResult<()> {
    runner::run(repo, ["remote", "set-url", "--", name, url.trim()])?;
    Ok(())
}

// ───────────────────────────── merge ─────────────────────────────

/// A collapsed ignored directory can contain only ignored siblings (bin/obj),
/// without obstructing an incoming source file. Inspect just the incoming path,
/// without recursively scanning build caches or following link targets.
fn ignored_merge_obstruction(repo: &Path, path: &str, ignore_case: bool) -> GitResult<Option<String>> {
    let parts: Vec<_> = path.split('/').collect();
    let mut local = repo.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        let mut components = Path::new(part).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_))) || components.next().is_some() {
            return Err(GitError::new("Cannot safely inspect an incoming merge path."));
        }
        local.push(part);
        let metadata = match std::fs::symlink_metadata(&local) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // core.ignorecase may be enabled on a case-sensitive filesystem.
                // Do not interpret differently cased local data as absent. Only
                // inspect siblings, never recurse through ignored directories.
                if ignore_case {
                    for entry in std::fs::read_dir(local.parent().unwrap_or(repo))? {
                        let entry = entry?;
                        if entry.file_name().to_string_lossy().to_lowercase() == part.to_lowercase() {
                            let mut obstructing = parts[..index].join("/");
                            if !obstructing.is_empty() {
                                obstructing.push('/');
                            }
                            obstructing.push_str(&entry.file_name().to_string_lossy());
                            return Ok(Some(obstructing));
                        }
                    }
                }
                return Ok(None);
            }
            Err(error) => {
                let mut error = GitError::from(error);
                error.message = format!("Cannot inspect local merge path {}: {}", parts[..=index].join("/"), error.message);
                return Err(error);
            }
        };
        if index + 1 == parts.len() || path_is_link(&metadata) || !metadata.is_dir() {
            return Ok(Some(parts[..=index].join("/")));
        }
    }
    Ok(None)
}

pub(super) fn guard_ignored_merge(repo: &Path, target: &str, head: Option<&str>) -> GitResult<()> {
    guard_transition(repo, target, head, false)
}

pub(super) fn guard_untracked_tree(repo: &Path, target: &str) -> GitResult<()> {
    guard_transition(repo, target, None, true)
}

fn guard_transition(repo: &Path, target: &str, head: Option<&str>, all_untracked: bool) -> GitResult<()> {
    // Some merge-ort versions overwrite ignored collisions even with
    // --no-overwrite-ignore (unlike switch / the fast-forward checkout path).
    // Inspect collapsed ignored folders, without scanning their build caches.
    let ignored = if all_untracked { super::workspace_files::untracked(repo)? } else { super::workspace_files::ignored(repo)? };
    if ignored.truncated {
        return Err(GitError::new("Ignored-file inspection was truncated; no merge was started."));
    }
    if ignored.paths.is_empty() {
        return Ok(());
    }
    let target = runner::run(repo, ["rev-parse", "--verify", "--end-of-options", &format!("{target}^{{commit}}")])?;
    let target = target.trim();
    let paths = match head {
        Some(head) => runner::run_bytes(repo, ["diff", "--name-only", "--no-renames", "--diff-filter=ACMRT", "-z", head, target, "--"]),
        None => runner::run_bytes(repo, ["ls-tree", "-r", "-z", "--name-only", target]),
    }?;
    check_ignored_paths(repo, &ignored, &paths, if all_untracked { "uncommitted" } else { "ignored" })
}

pub(super) fn guard_untracked_paths(repo: &Path, paths: &[u8]) -> GitResult<()> {
    check_ignored_paths(repo, &super::workspace_files::untracked(repo)?, paths, "uncommitted")
}

fn check_ignored_paths(repo: &Path, ignored: &super::workspace_files::IgnoredFiles, paths: &[u8], kind: &str) -> GitResult<()> {
    if ignored.truncated {
        return Err(GitError::new("Ignored-file inspection was truncated; no integration was started."));
    }
    if ignored.paths.is_empty() {
        return Ok(());
    }
    let paths = super::workspace_files::path_list(paths)?;
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
    // Every collision, not just the first: the user decides for the whole list.
    let mut found: Vec<(String, String)> = Vec::new();
    for path in paths.split('\0').filter(|p| !p.is_empty()) {
        let p = normalize(path);
        let prefix = format!("{p}/");
        let ancestor = p.match_indices('/').any(|(index, _)| ignored.contains(&p[..index]));
        let descendant = ignored.range(prefix.clone()..).next().is_some_and(|i| i.starts_with(&prefix));
        if ignored.contains(&p) || ancestor || descendant {
            let Some(obstruction) = ignored_merge_obstruction(repo, path, ignore_case)? else { continue };
            if !found.iter().any(|(_, o)| *o == obstruction) {
                found.push((path.to_owned(), obstruction));
            }
        }
    }
    if found.is_empty() {
        return Ok(());
    }
    let local: Vec<String> = found.iter().map(|(_, o)| o.clone()).collect();
    // The user chose to continue for exactly these paths (with a saved copy, or at their risk).
    if super::recovery::collisions_accepted(repo, &local) {
        return Ok(());
    }
    let (path, obstruction) = &found[0];
    let others = if found.len() > 1 { format!(" and {} more", found.len() - 1) } else { String::new() };
    // Details: incoming and local path pairs, the first pair first.
    let details = found.iter().flat_map(|(path, obstruction)| [path.clone(), obstruction.clone()]).collect();
    Err(GitError::new(format!(
        "Integration may overwrite {kind} data at {obstruction}{others}. Your local data was preserved. Save a copy and continue, continue without a copy, or move the paths outside the repository and retry. Incoming path: {path}."
    ))
    .kind("ignored-collision")
    .details(details))
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
    let mut args: Vec<&str> = vec!["merge", "--no-squash", "--no-commit", super::recovery::ignored_flag(repo)];
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
    if out.ok() && !gd.join("MERGE_HEAD").exists() && autostash_conflict(repo, &text) {
        return Ok(autostash_outcome(repo));
    }
    if text.contains("Already up to date") || text.contains("Already up-to-date") {
        return Ok(OpOutcome { status: "upToDate".into(), conflicts: Vec::new(), message: format!("Already up to date with {target}.") });
    }
    let merging = gd.join("MERGE_HEAD").exists();
    // Only a merge that stopped or a squash can leave conflicts; a fast-forward skips the read.
    let conflicts = if merging || strategy == "squash" { conflicted(repo) } else { Vec::new() };
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
    refuse_hidden_edits(repo, "Abort")?;
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
    finish_saved(repo)?;
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
            let mut outcome = OpOutcome::done(oid);
            finish_into(repo, &mut outcome)?;
            Ok(outcome)
        }
        "cherry-pick" | "revert" | "rebase" | "am" => {
            let out = if kind == "cherry-pick" {
                let state = repo::op_state(repo, &gd);
                if state.kind == "cherry-pick" {
                    let text = match message.filter(|m| !m.trim().is_empty()) {
                        Some(edited) => edited.to_owned(),
                        None => state.message.ok_or_else(|| GitError::new("Could not read the pending cherry-pick message."))?,
                    };
                    // Complete the resolved step through Git so author information and
                    // hooks are preserved. Then let Git resume any remaining picks.
                    let commit = runner::exec_full(repo, ["commit", "--cleanup=verbatim", "-F", "-"], &[], Some(text.as_bytes()))?;
                    if commit.ok() && gd.join("sequencer/todo").is_file() {
                        runner::exec(repo, [kind, "--continue"])?
                    } else {
                        commit
                    }
                } else {
                    runner::exec(repo, [kind, "--continue"])?
                }
            } else {
                if let Some(edited) = message.filter(|m| kind == "revert" && !m.trim().is_empty()) {
                    std::fs::write(gd.join("MERGE_MSG"), edited)?;
                }
                runner::exec(repo, [kind, "--continue"])?
            };
            if out.ok() {
                let mut outcome = OpOutcome::done(out.text());
                finish_into(repo, &mut outcome)?;
                return Ok(outcome);
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
    refuse_hidden_edits(repo, "Skip")?;
    let out = runner::exec(repo, [kind, "--skip"])?;
    let c = conflicted(repo);
    if out.ok() && c.is_empty() {
        let mut outcome = OpOutcome::done(out.text());
        finish_into(repo, &mut outcome)?;
        return Ok(outcome);
    }
    if !c.is_empty() {
        return Ok(OpOutcome { status: "conflicts".into(), conflicts: c, message: out.stderr });
    }
    Err(runner::to_error(&format!("git {kind} --skip"), &out))
}

/// Git's `--autostash` re-applies saved changes without `--index`: everything staged (and with
/// it any stage layers) would come back unstaged. When something is staged, Revqora saves the
/// changes itself (a normal stash keeps the index) and restores them with `--index`.
fn stash_staged(repo: &Path, what: &str) -> GitResult<Option<String>> {
    stash_staged_as(repo, &format!("Revqora: changes saved before {what}"))
}

/// When something is staged, saves all local changes (with their staging) in a stash called `name`.
fn stash_staged_as(repo: &Path, name: &str) -> GitResult<Option<String>> {
    let staged = runner::exec(repo, ["diff", "--cached", "--quiet", "--ignore-submodules=dirty"])?;
    match staged.code {
        0 => return Ok(None),
        1 => {}
        _ => return Err(runner::to_error("git diff --cached", &staged)),
    }
    runner::run(repo, ["stash", "push", "-m", name])?;
    Ok(Some(runner::run(repo, ["rev-parse", "--verify", "refs/stash"])?.trim().to_string()))
}

const SAVED_MARKER: &str = "saved-changes";

/// After an operation: restore the saved changes now if it finished, or remember them until
/// the paused operation is continued, skipped or aborted.
fn restore_saved(repo: &Path, saved: Option<String>, outcome: &mut OpOutcome) -> GitResult<()> {
    let Some(oid) = saved else { return Ok(()) };
    let paused = matches!(outcome.status.as_str(), "conflicts" | "stopped" | "pending") || repo::op_state(repo, &repo::git_dir(repo)?).kind != "none";
    if paused {
        std::fs::write(super::storage::dir(repo)?.join(SAVED_MARKER), &oid)?;
        outcome.message.push_str("\nYour local changes, including what was staged, are saved and come back when you finish or abort this operation.");
        return Ok(());
    }
    if let Some(note) = apply_saved(repo, &oid)? {
        if !conflicted(repo).is_empty() {
            outcome.status = "conflicts".into();
            outcome.conflicts = conflicted(repo);
        }
        outcome.message.push('\n');
        outcome.message.push_str(&note);
    }
    Ok(())
}

/// Re-applies saved changes with their staging; returns a note when that was not fully possible.
fn apply_saved(repo: &Path, oid: &str) -> GitResult<Option<String>> {
    let _ = std::fs::remove_file(super::storage::dir(repo)?.join(SAVED_MARKER));
    const CONFLICTED: &str = "Restoring your saved changes conflicted. Resolve the files; a copy of the changes is kept in Stashes.";
    match restore_exact(repo, oid)? {
        Restore::Done => {
            drop_stash_by_oid(repo, oid)?;
            return Ok(None);
        }
        Restore::Blocked(files) => {
            // Never overwrite work that appeared meanwhile (staged or not, untracked or ignored).
            return Ok(Some(format!(
                "Your saved changes were not restored because these files changed meanwhile: {}. They are kept in Stashes; apply them when ready.",
                files.join(", ")
            )));
        }
        Restore::Merge => {}
    }
    if runner::exec(repo, ["stash", "apply", "--index", oid])?.ok() {
        drop_stash_by_oid(repo, oid)?;
        return Ok(None);
    }
    if !conflicted(repo).is_empty() {
        return Ok(Some(CONFLICTED.into()));
    }
    // `--index` can fail without leaving conflicts; the plain apply may still conflict.
    let plain = runner::exec(repo, ["stash", "apply", oid])?;
    if !conflicted(repo).is_empty() {
        return Ok(Some(CONFLICTED.into()));
    }
    if plain.ok() {
        return Ok(Some(
            "Your changes are back, but their staging could not be restored on the new commit. The original, with its staging, is kept in Stashes.".into(),
        ));
    }
    Ok(Some("Your saved changes could not be restored automatically. They are kept in Stashes.".into()))
}

enum Restore {
    /// Put back exactly.
    Done,
    /// The operation changed saved paths: merge with `stash apply`.
    Merge,
    /// Saved paths hold new work (staged, unstaged, untracked or ignored): restore nothing.
    Blocked(Vec<String>),
}

/// When the operation did not touch any saved path, puts the saved index and working files back
/// exactly, from the stash's own trees, instead of merging (`stash apply --index` behaves
/// differently between Git versions). Nothing is written when a saved path holds new work.
fn restore_exact(repo: &Path, oid: &str) -> GitResult<Restore> {
    let base = format!("{oid}^1");
    let index = format!("{oid}^2");
    let mut paths: Vec<String> = Vec::new();
    for tree in [oid, index.as_str()] {
        let changed = runner::run_bytes(repo, ["diff", "--name-only", "--no-renames", "-z", &base, tree])?;
        for path in String::from_utf8_lossy(&changed).split('\0').filter(|p| !p.is_empty()) {
            if !paths.iter().any(|p| p == path) {
                paths.push(path.to_string());
            }
        }
    }
    if paths.is_empty() {
        return Ok(Restore::Done);
    }
    let literal = [("GIT_LITERAL_PATHSPECS", "1")];
    let names = |extra: &[&str]| -> GitResult<Vec<String>> {
        let mut args: Vec<String> = vec!["diff".into(), "--name-only".into(), "--no-renames".into(), "-z".into()];
        args.extend(extra.iter().map(|a| a.to_string()));
        args.push("--".into());
        args.extend(paths.iter().cloned());
        let out = runner::exec_full(repo, &args, &literal, None)?;
        if out.code != 0 {
            return Err(GitError::new(out.stderr.trim().to_string()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
    };
    // New work on saved paths: staged (index vs HEAD), unstaged (working tree vs index), or a
    // file that appeared where HEAD has none (untracked or ignored).
    let mut blocked = names(&["--cached", "HEAD"])?;
    for path in names(&[])? {
        if !blocked.contains(&path) {
            blocked.push(path);
        }
    }
    let exists = |tree: &str, path: &str| -> GitResult<bool> { Ok(runner::exec(repo, ["cat-file", "-e", &format!("{tree}:{path}")])?.ok()) };
    for path in &paths {
        if !blocked.contains(path) && !exists("HEAD", path)? && std::fs::symlink_metadata(repo.join(path)).is_ok() {
            blocked.push(path.clone());
        }
    }
    // `git diff` trusts index flags: assume-unchanged and skip-worktree files are never compared.
    // Compare the working file's content (through clean filters) with its index entry directly.
    for path in &paths {
        if !blocked.contains(path) && worktree_differs_from_index(repo, path)? {
            blocked.push(path.clone());
        }
    }
    if !blocked.is_empty() {
        return Ok(Restore::Blocked(blocked));
    }
    let mut args = vec!["diff".to_string(), "--quiet".into(), base.clone(), "HEAD".into(), "--".into()];
    args.extend(paths.iter().cloned());
    if runner::exec_full(repo, &args, &literal, None)?.code != 0 {
        return Ok(Restore::Merge); // the operation changed a saved file
    }
    for path in &paths {
        // Index: the saved staged version, or no entry when the path was staged as deleted.
        if exists(&index, path)? {
            runner::run_env(repo, ["restore", "--source", &index, "--staged", "--", path], &literal, None)?;
        } else {
            runner::run_env(repo, ["rm", "--cached", "-q", "--ignore-unmatch", "--", path], &literal, None)?;
        }
        // Working file: the saved one (through checkout filters), or removed.
        if exists(oid, path)? {
            runner::run_env(repo, ["restore", "--source", oid, "--worktree", "--", path], &literal, None)?;
        } else {
            let full = repo.join(path);
            if full.is_file() {
                std::fs::remove_file(full)?;
            }
        }
    }
    Ok(Restore::Done)
}

/// Skip and Abort reset the working tree. Git cannot see edits to files marked assume-unchanged
/// or skip-worktree, so it overwrites them silently (and no checkpoint captures them). Stop
/// before that and say which files, instead of losing them.
fn refuse_hidden_edits(repo: &Path, action: &str) -> GitResult<()> {
    let listing = runner::run(repo, ["ls-files", "-v", "-z"])?;
    let mut hidden = Vec::new();
    for entry in listing.split('\0').filter(|e| e.len() > 2) {
        let (tag, path) = entry.split_at(2);
        let flagged = tag.starts_with(|c: char| c.is_ascii_lowercase()) || tag.starts_with('S');
        if flagged && worktree_differs_from_index(repo, path)? {
            hidden.push(path.to_string());
        }
    }
    if hidden.is_empty() {
        return Ok(());
    }
    let shown = hidden.iter().take(10).cloned().collect::<Vec<_>>().join(", ");
    let more = if hidden.len() > 10 { format!(" and {} more", hidden.len() - 10) } else { String::new() };
    Err(GitError::new(format!(
        "{action} would overwrite edits Git is told to ignore (assume-unchanged or skip-worktree): {shown}{more}. Clear the flag (git update-index --no-assume-unchanged / --no-skip-worktree) or copy the files, then try again."
    ))
    .kind("hidden-changes"))
}

/// Whether the working copy of `path` differs from its index entry, ignoring the
/// assume-unchanged / skip-worktree flags that make `git diff` skip a file: by content, by file
/// type (symlink or file, when `core.symlinks` is on) and by the executable bit (when
/// `core.filemode` is on). A skip-worktree path absent from the working tree is a sparse
/// checkout leaving it out on purpose, not a change.
fn worktree_differs_from_index(repo: &Path, path: &str) -> GitResult<bool> {
    let literal = [("GIT_LITERAL_PATHSPECS", "1")];
    let listing = runner::run_env(repo, ["ls-files", "-v", "-s", "-z", "--", path], &literal, None)?;
    // "<tag> <mode> <oid> <stage>\t<path>"
    let Some(entry) = listing.split('\0').find(|e| !e.is_empty()) else { return Ok(false) }; // untracked: separate check
    let mut fields = entry.split('\t').next().unwrap_or("").split_whitespace();
    let (tag, mode, oid) = (fields.next().unwrap_or(""), fields.next().unwrap_or(""), fields.next().unwrap_or("").to_string());
    let full = repo.join(path);
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        // Missing: deleted meanwhile, unless sparse checkout excludes it. `ls-files -v` shows
        // skip-worktree as "S", or "s" when assume-unchanged is set too.
        return Ok(!tag.eq_ignore_ascii_case("s"));
    };
    if mode == "160000" {
        return Ok(!meta.is_dir()); // a submodule's own changes are its own business
    }
    if meta.is_dir() {
        return Ok(true);
    }
    let symlinks = git_bool(repo, "core.symlinks", true);
    let is_link = meta.file_type().is_symlink();
    if mode == "120000" && symlinks {
        if !is_link {
            return Ok(true); // a symlink replaced by a file
        }
        let target = std::fs::read_link(&full)?;
        let hashed = runner::run_env(repo, ["hash-object", "--stdin"], &[], Some(target.to_string_lossy().as_bytes()))?;
        return Ok(hashed.trim() != oid);
    }
    if is_link {
        return Ok(true); // a file replaced by a symlink (with symlinks off Git writes links as files)
    }
    if mode == "120000" {
        // core.symlinks off: the link is a plain file holding its target, stored without filters.
        let hashed = runner::run_env(repo, ["hash-object", "--no-filters", "--", path], &literal, None)?;
        return Ok(hashed.trim() != oid);
    }
    if cfg!(unix) && git_bool(repo, "core.filemode", true) && executable(&meta) != (mode == "100755") {
        return Ok(true);
    }
    let hashed = runner::run_env(repo, ["hash-object", &format!("--path={path}"), "--", path], &literal, None)?;
    Ok(hashed.trim() != oid)
}

fn git_bool(repo: &Path, key: &str, default: bool) -> bool {
    super::config_cache::run(repo, &["config", "--bool", "--get", key]).map(|v| v.trim() == "true").unwrap_or(default)
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    // Git records 100755 from the owner-execute bit alone (0645 is 100644).
    meta.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false // no executable bit: Git sets core.filemode=false here
}

/// Restores changes saved before a paused operation into a finished outcome: the note is added,
/// and conflicts from the restore make the outcome "conflicts" with the files listed.
fn finish_into(repo: &Path, outcome: &mut OpOutcome) -> GitResult<()> {
    if let Some(note) = finish_saved(repo)? {
        outcome.message = format!("{}\n{note}", outcome.message);
        let conflicts = conflicted(repo);
        if !conflicts.is_empty() {
            outcome.status = "conflicts".into();
            outcome.conflicts = conflicts;
        }
    }
    Ok(())
}

fn drop_stash_by_oid(repo: &Path, oid: &str) -> GitResult<()> {
    let list = runner::run(repo, ["stash", "list", "--format=%H"])?;
    if let Some(index) = list.lines().position(|line| line.trim() == oid) {
        runner::run(repo, ["stash", "drop", "-q", &format!("stash@{{{index}}}")])?;
    }
    Ok(())
}

/// Restores changes saved before an operation once it is no longer in progress.
fn finish_saved(repo: &Path) -> GitResult<Option<String>> {
    let marker = super::storage::dir(repo)?.join(SAVED_MARKER);
    let Ok(oid) = std::fs::read_to_string(&marker) else { return Ok(None) };
    if repo::op_state(repo, &repo::git_dir(repo)?).kind != "none" {
        return Ok(None);
    }
    apply_saved(repo, oid.trim())
}

/// Git exits 0 when re-applying the autostash conflicts; its message differs between
/// versions. After an operation that reported success, conflicted paths can only come from
/// re-applying the autostash, so check the index rather than the text.
fn autostash_conflict(repo: &Path, text: &str) -> bool {
    text.contains("Applying autostash resulted in conflicts") || !conflicted(repo).is_empty()
}

fn autostash_outcome(repo: &Path) -> OpOutcome {
    OpOutcome {
        status: "conflicts".into(),
        conflicts: conflicted(repo),
        message: "The operation finished, but restoring your local changes conflicted. Resolve the conflicted files; a copy of your changes is kept in the stash list.".into(),
    }
}

fn sequence_outcome(repo: &Path, out: runner::Output, what: &str) -> GitResult<OpOutcome> {
    if out.ok() && autostash_conflict(repo, &out.stderr) && repo::op_state(repo, &repo::git_dir(repo)?).kind == "none" {
        return Ok(autostash_outcome(repo));
    }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparedCherryPick {
    pub source: String,
    pub source_oid: String,
    pub destination: String,
    pub destination_oid: String,
    pub oid: String,
}

pub fn cherry_pick_compared(repo: &Path, pick: &ComparedCherryPick) -> GitResult<OpOutcome> {
    let branch = pick
        .destination
        .strip_prefix("refs/heads/")
        .filter(|branch| !branch.is_empty() && !branch.starts_with('-') && *branch != "HEAD")
        .ok_or_else(|| GitError::new("Choose a local destination branch."))?;
    let stale = || GitError::new("The compared branches changed. Compare them again before cherry-picking.").kind("stale-operation");
    let check_tips = || {
        if super::inspect::branch_tip(repo, &pick.source)? != pick.source_oid || super::inspect::branch_tip(repo, &pick.destination)? != pick.destination_oid {
            return Err(stale());
        }
        let symbolic = runner::exec(repo, ["symbolic-ref", "--quiet", "--no-recurse", &pick.destination])?;
        match symbolic.code {
            0 => Err(GitError::new("The destination is a symbolic branch. Select its direct local branch instead.")),
            1 => Ok(()),
            _ => Err(runner::to_error("verify destination branch", &symbolic)),
        }
    };
    check_tips()?;
    if !matches!(pick.oid.len(), 40 | 64) || !pick.oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::new("Choose a commit from the branch comparison."));
    }
    let ancestor = |tip: &str| {
        let result = runner::exec(repo, ["merge-base", "--is-ancestor", &pick.oid, tip])?;
        match result.code {
            0 => Ok(true),
            1 => Ok(false),
            _ => Err(runner::to_error("verify compared commit", &result)),
        }
    };
    if !ancestor(&pick.source_oid)? || ancestor(&pick.destination_oid)? {
        return Err(GitError::new("The selected commit must be unique to the source branch."));
    }

    let clean = || {
        let raw = runner::run(repo, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=none"])?;
        let current = status::parse(&raw);
        if !current.files.is_empty() || super::layers::staged_base(repo).is_some() {
            return Err(GitError::new("Commit or stash local changes before cherry-picking into a compared branch."));
        }
        let flags = runner::run_bytes(repo, ["ls-files", "-v", "-z"])?;
        if flags.split(|byte| *byte == 0).filter_map(|entry| entry.first()).any(|flag| *flag == b'S' || flag.is_ascii_lowercase()) {
            return Err(GitError::new("Clear skip-worktree and assume-unchanged flags before cherry-picking so hidden edits can be checked."));
        }
        Ok(current)
    };
    let current = clean()?;
    runner::run(repo, ["var", "GIT_COMMITTER_IDENT"])?;
    if super::extras::worktrees(repo)?.iter().any(|worktree| !worktree.is_current && worktree.branch.as_deref() == Some(branch)) {
        return Err(GitError::new("This branch is checked out in another worktree. Switch that worktree to a different branch before cherry-picking here."));
    }
    if current.branch.as_deref() != Some(branch) {
        guard_compared_pick_files(repo, pick)?;
        runner::run(repo, ["switch", "--no-guess", super::recovery::ignored_flag(repo), "--no-recurse-submodules", "--", branch])?;
    }
    // Recheck the exact destination and working tree after switch hooks run.
    let head = runner::run(repo, ["symbolic-ref", "--quiet", "--no-recurse", "HEAD"])?;
    if head.trim() != pick.destination || clean()?.oid.as_deref() != Some(pick.destination_oid.as_str()) {
        return Err(stale());
    }
    check_tips()?;
    if repo::op_state(repo, &repo::git_dir(repo)?).kind != "none" {
        return Err(GitError::new("Finish or abort the current Git operation before cherry-picking.").kind("operation-in-progress"));
    }
    guard_compared_pick_files(repo, pick)?;
    cherry_pick(repo, std::slice::from_ref(&pick.oid), false)
}

fn guard_compared_pick_files(repo: &Path, pick: &ComparedCherryPick) -> GitResult<()> {
    let ignored = super::workspace_files::untracked(repo)?;
    if ignored.paths.is_empty() {
        return Ok(());
    }
    // A rename can introduce a path absent from the commit's own patch.
    // Inspect Git's resulting tree before its checkout can overwrite ignored files.
    if !runner::version_at_least(2, 40) {
        return Err(GitError::new("Git 2.40 or newer is required to protect ignored files during this cherry-pick."));
    }
    let parents = runner::run(repo, ["rev-list", "--parents", "-n", "1", &pick.oid])?;
    let base = match parents.split_whitespace().nth(1) {
        Some(parent) => parent.to_owned(),
        None => runner::run_env(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], &[], Some(&[]))?.trim().to_owned(),
    };
    let preview = runner::exec(
        repo,
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", &format!("--merge-base={base}"), &pick.destination_oid, &pick.oid],
    )?;
    if !matches!(preview.code, 0 | 1) {
        return Err(runner::to_error("preview cherry-pick to protect ignored files", &preview));
    }
    let output = super::workspace_files::path_list(&preview.stdout)?;
    let (tree, conflicts) = output.split_once('\0').ok_or_else(|| GitError::new("Git returned an invalid cherry-pick preview."))?;
    if !matches!(tree.len(), 40 | 64) || !tree.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::new("Git returned an invalid cherry-pick preview tree."));
    }
    let paths = runner::run_bytes(repo, ["diff", "--name-only", "--no-renames", "-z", &pick.destination_oid, tree, "--"])?;
    let conflicts: std::collections::BTreeSet<_> = conflicts.split('\0').filter(|path| !path.is_empty()).collect();
    if conflicts.is_empty() {
        return check_ignored_paths(repo, &ignored, &paths, "ignored");
    }
    let mut checked = Vec::new();
    let insensitive = cfg!(windows) || runner::exec(repo, ["config", "--bool", "--get", "core.ignorecase"])?.text().trim() == "true";
    let normalize = |path: &str| if insensitive { path.to_lowercase() } else { path.to_owned() };
    let local: std::collections::BTreeMap<_, _> = ignored.paths.iter().map(|path| (normalize(path.trim_end_matches('/')), path)).collect();
    let candidates: std::collections::BTreeSet<_> =
        super::workspace_files::path_list(&paths)?.split('\0').chain(conflicts.iter().copied()).filter(|path| !path.is_empty()).collect();
    let source = pick.oid.to_ascii_lowercase();
    for path in candidates {
        // A literal tracked path can end with the same suffix as Git's generated names.
        checked.extend_from_slice(path.as_bytes());
        checked.push(0);
        let renamed = if conflicts.contains(path) { preview_conflict_name(path, pick) } else { None };
        let Some((stem, from_head)) = renamed else {
            continue;
        };
        // merge-tree labels generated paths with the supplied full OIDs.
        // cherry-pick uses HEAD or "<abbrev> (<subject>)", with optional _N.
        // Check that family under this specific conflict, including ignored ancestors.
        let prefix = format!("{}~", normalize(stem));
        let ancestors = prefix.match_indices('/').filter_map(|(index, _)| local.get(&prefix[..index]));
        let generated = local.range(prefix.clone()..).take_while(|(path, _)| path.starts_with(&prefix)).filter_map(|(path, original)| {
            let name = path[prefix.len()..].split('/').next().unwrap_or_default();
            let matches = if from_head {
                conflict_suffix(name, if insensitive { "head" } else { "HEAD" })
            } else {
                name.split_once(" (").is_some_and(|(sha, subject)| {
                    !sha.is_empty()
                        && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
                        && source.starts_with(sha)
                        && (subject.ends_with(')') || subject.rsplit_once(')').is_some_and(|(_, tail)| conflict_suffix(tail, "")))
                })
            };
            matches.then_some(original)
        });
        for original in ancestors.chain(generated) {
            checked.extend_from_slice(original.trim_end_matches('/').as_bytes());
            checked.push(0);
        }
    }
    check_ignored_paths(repo, &ignored, &checked, "ignored")
}

fn conflict_suffix(name: &str, label: &str) -> bool {
    name.strip_prefix(label).is_some_and(|tail| {
        tail.is_empty() || tail.strip_prefix('_').is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

fn preview_conflict_name<'a>(path: &'a str, pick: &ComparedCherryPick) -> Option<(&'a str, bool)> {
    let (stem, name) = path.rsplit_once('~')?;
    if conflict_suffix(name, &pick.destination_oid) {
        Some((stem, true))
    } else if conflict_suffix(name, &pick.oid) {
        Some((stem, false))
    } else {
        None
    }
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
    // A revert brings back files the commit deleted; Git writes them over ignored files.
    let commit = runner::run(repo, ["rev-parse", "--verify", "--end-of-options", &format!("{oid}^{{commit}}")])?;
    let commit = commit.trim();
    if let Ok(parent) = runner::run(repo, ["rev-parse", "-q", "--verify", "--end-of-options", &format!("{commit}^1")]) {
        let parent = parent.trim();
        let mut restored = runner::run_bytes(repo, ["diff", "--name-only", "--no-renames", "--diff-filter=ACMRT", "-z", commit, parent, "--"])?;
        // The revert is a merge of the parent into HEAD relative to the commit: it can write to
        // other paths (a restored file follows a later directory rename) and does so even when
        // it then stops on a conflict. Preview that merge and check what it writes.
        let local = super::workspace_files::untracked(repo)?;
        if let (Some(head), false) = (head_oid(repo), local.paths.is_empty() && !local.truncated) {
            if !runner::version_at_least(2, 40) {
                return Err(GitError::new("Git 2.40 or newer is required to protect untracked and ignored files during this revert.").kind("git-too-old"));
            }
            // With --no-commit Git applies the revert to the index, which may differ from HEAD
            // (a staged rename, say). Preview against the index as a tree; an unmerged index
            // cannot be written and is refused.
            let ours = if no_commit {
                let tree = runner::exec(repo, ["write-tree"])?;
                if !tree.ok() {
                    return Err(GitError::new(
                        "The staged changes cannot be checked for untracked and ignored files (unresolved conflicts?). Resolve them first.",
                    )
                    .kind("index-unmerged"));
                }
                tree.text().trim().to_owned()
            } else {
                head
            };
            restored.push(0);
            preview_merge(repo, Some(commit), &ours, parent, &local.paths, &mut restored)?;
        }
        check_ignored_paths(repo, &local, &restored, "uncommitted")?;
    }
    let out = runner::exec(repo, &args)?;
    sequence_outcome(repo, out, "git revert")
}

/// Refuses a rebase onto `upstream` that would write over untracked or ignored files (ignore
/// rules can differ between the replayed commits, so ordinary untracked files count too).
///
/// Checked: the checkout of `upstream`, every file the replayed commits touch, and every file
/// a replay previewed with `git merge-tree` writes. The preview matters because Git's merge
/// can write to paths no commit names, such as a file moved by a directory rename upstream,
/// and it writes them even when the step then stops with a conflict.
fn guard_rebase_files(repo: &Path, upstream: &str, keep_merges: bool) -> GitResult<()> {
    let Some(head) = head_oid(repo) else { return Ok(()) };
    let target = runner::run(repo, ["rev-parse", "--verify", "--end-of-options", &format!("{upstream}^{{commit}}")])?;
    let target = target.trim();
    let untracked = super::workspace_files::untracked(repo)?;
    if untracked.paths.is_empty() && !untracked.truncated {
        return Ok(());
    }
    let mut paths = runner::run_bytes(repo, ["diff", "--name-only", "--no-renames", "--diff-filter=ACMRT", "-z", &head, target, "--"])?;
    paths.push(0);
    paths.extend(runner::run_bytes(
        repo,
        ["log", "--format=", "--name-only", "-m", "--no-renames", "--diff-filter=ACMRT", "-z", &format!("{target}..{head}"), "--"],
    )?);
    paths.push(0);
    paths.extend(rebase_replay_writes(repo, target, &head, keep_merges, &untracked.paths)?);
    check_ignored_paths(repo, &untracked, &paths, "uncommitted")
}

/// Paths a rebase of `head` onto `target` may write, previewed with `git merge-tree` and
/// throw-away commits (`git commit-tree`, never referenced; no working tree, index or ref is
/// touched). The preview follows the rebase's own topology:
/// - plain rebase: the commits (merges dropped) are replayed in order, each on the previous
///   result;
/// - `--rebase-merges`: each commit is replayed on the preview of its own first parent (or on
///   `target` when that parent is outside the range), and each merge is re-created by merging
///   the previewed parents with a real merge base, as Git does. So renames made on one replayed
///   branch also move the files another branch brings in through the re-created merge.
///
/// A conflicting step does not end the preview: the user may resolve and continue, so the
/// conflicted result is used for the following steps. In addition every commit is previewed on
/// its own directly on `target`. Each step's changed paths, conflict files and Git's
/// generated `path~label` names (matched against the `local` untracked paths) are included.
fn rebase_replay_writes(repo: &Path, target: &str, head: &str, keep_merges: bool, local: &[String]) -> GitResult<Vec<u8>> {
    if !runner::version_at_least(2, 40) {
        return Err(GitError::new("Git 2.40 or newer is required to protect untracked and ignored files during this rebase.").kind("git-too-old"));
    }
    let mut list = vec!["rev-list".to_string(), "--reverse".into(), "--topo-order".into(), "--parents".into()];
    if !keep_merges {
        list.push("--no-merges".into());
    }
    list.push(format!("{target}..{head}"));
    let listing = runner::run(repo, &list)?;
    let mut out: Vec<u8> = Vec::new();
    // Original commit -> its previewed replacement.
    let mut replayed: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut previous = target.to_owned();
    let mut empty: Option<String> = None;
    for line in listing.lines() {
        let mut ids = line.split_whitespace();
        let Some(commit) = ids.next() else { continue };
        let parents: Vec<&str> = ids.collect();
        let new_parent = |parent: Option<&str>| parent.and_then(|p| replayed.get(p).cloned()).unwrap_or_else(|| target.to_owned());
        let next = if keep_merges && parents.len() > 1 {
            if parents.len() > 2 {
                return Err(GitError::new(
                    "This branch has an octopus merge; its rebase cannot be checked for untracked and ignored files. Keep merges is not available for it.",
                )
                .kind("rebase-preview-unsupported"));
            }
            let first = new_parent(Some(parents[0]));
            // A merged-in parent outside the range stays as it is.
            let second = replayed.get(parents[1]).cloned().unwrap_or_else(|| parents[1].to_owned());
            let tree = preview_merge(repo, None, &first, &second, local, &mut out)?;
            preview_commit(repo, &tree, &[&first, &second])?
        } else {
            let onto = if keep_merges { new_parent(parents.first().copied()) } else { previous.clone() };
            let base = match parents.first() {
                Some(parent) => parent.to_string(),
                None => match &empty {
                    Some(e) => e.clone(),
                    None => {
                        let e = runner::run_env(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], &[], Some(&[]))?.trim().to_owned();
                        empty = Some(e.clone());
                        e
                    }
                },
            };
            let tree = preview_merge(repo, Some(&base), &onto, commit, local, &mut out)?;
            // Also on its own on the target, for steps the topology above may not reach alike.
            preview_merge(repo, Some(&base), target, commit, local, &mut out)?;
            preview_commit(repo, &tree, &[&onto])?
        };
        replayed.insert(commit.to_owned(), next.clone());
        previous = next;
    }
    Ok(out)
}

/// A throw-away commit with `tree` and `parents`, so later steps can find real merge bases.
fn preview_commit(repo: &Path, tree: &str, parents: &[&str]) -> GitResult<String> {
    let mut args = vec!["commit-tree".to_string(), tree.to_owned()];
    for parent in parents {
        args.push("-p".into());
        args.push((*parent).to_owned());
    }
    args.extend(["-m".into(), "rebase preview".into()]);
    let identity = [
        ("GIT_AUTHOR_NAME", "Revqora"),
        ("GIT_AUTHOR_EMAIL", "preview@revqora.invalid"),
        ("GIT_COMMITTER_NAME", "Revqora"),
        ("GIT_COMMITTER_EMAIL", "preview@revqora.invalid"),
        ("GIT_AUTHOR_DATE", "1700000000 +0000"),
        ("GIT_COMMITTER_DATE", "1700000000 +0000"),
    ];
    Ok(runner::run_env(repo, &args, &identity, None)?.trim().to_owned())
}

/// Previews merging `theirs` into `ours` (commits; with `base`, relative to it as a cherry-pick
/// does, otherwise from their real merge base). Appends the paths written to `out` and returns
/// the resulting tree, conflicted or not.
fn preview_merge(repo: &Path, base: Option<&str>, ours: &str, theirs: &str, local: &[String], out: &mut Vec<u8>) -> GitResult<String> {
    let mut args = vec!["merge-tree".to_string(), "--write-tree".into(), "--name-only".into(), "--no-messages".into(), "-z".into()];
    if let Some(base) = base {
        args.push(format!("--merge-base={base}"));
    }
    args.push(ours.to_owned());
    args.push(theirs.to_owned());
    let preview = runner::exec(repo, &args)?;
    if !matches!(preview.code, 0 | 1) {
        return Err(runner::to_error("preview the rebase to protect untracked and ignored files", &preview));
    }
    let listing = super::workspace_files::path_list(&preview.stdout)?;
    let mut fields = listing.split('\0');
    let next = fields.next().unwrap_or_default().trim().to_owned();
    if !matches!(next.len(), 40 | 64) || !next.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("Git returned an invalid rebase preview tree."));
    }
    out.extend(runner::run_bytes(repo, ["diff", "--name-only", "--no-renames", "-z", &format!("{ours}^{{tree}}"), &next, "--"])?);
    out.push(0);
    for path in fields.filter(|p| !p.is_empty()) {
        out.extend_from_slice(path.as_bytes());
        out.push(0);
        // File/folder conflicts are written beside the path as `path~<label>`.
        let prefix = format!("{path}~").to_lowercase();
        for name in local.iter().filter(|l| l.to_lowercase().starts_with(&prefix)) {
            out.extend_from_slice(name.trim_end_matches('/').as_bytes());
            out.push(0);
        }
    }
    Ok(next)
}

/// Merge commits a rebase onto `upstream` would replay. A plain rebase drops them and leaves
/// their commits in one straight line.
pub fn rebase_merge_count(repo: &Path, upstream: &str) -> GitResult<u32> {
    let target = runner::run(repo, ["rev-parse", "--verify", "--end-of-options", &format!("{upstream}^{{commit}}")])?;
    let count = runner::run(repo, ["rev-list", "--count", "--merges", &format!("{}..HEAD", target.trim())])?;
    Ok(count.trim().parse().unwrap_or(0))
}

pub fn rebase_onto(repo: &Path, upstream: &str) -> GitResult<OpOutcome> {
    rebase_onto_with(repo, upstream, false)
}

/// `keep_merges` re-creates the branch's merge commits (`--rebase-merges`) instead of dropping them.
pub fn rebase_onto_with(repo: &Path, upstream: &str, keep_merges: bool) -> GitResult<OpOutcome> {
    guard_rebase_files(repo, upstream, keep_merges)?;
    let saved = stash_staged(repo, "Rebase")?;
    let mut args = vec!["rebase", "--autostash"];
    if keep_merges {
        args.push("--rebase-merges");
    }
    args.push(upstream);
    let result = runner::exec(repo, &args).and_then(|out| sequence_outcome(repo, out, "git rebase"));
    with_saved(repo, saved, result)
}

/// Restores changes saved by `stash_staged` around an operation's result.
fn with_saved(repo: &Path, saved: Option<String>, result: GitResult<OpOutcome>) -> GitResult<OpOutcome> {
    match result {
        Ok(mut outcome) => {
            restore_saved(repo, saved, &mut outcome)?;
            Ok(outcome)
        }
        Err(error) => {
            if let Some(oid) = saved {
                apply_saved(repo, &oid)?;
            }
            Err(error)
        }
    }
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
    let saved = stash_staged(repo, "editing history")?;
    with_saved(repo, saved, run_todo_logged(repo, base, todo, None))
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
                runner::run(repo, ["commit", "--amend", "--only", "--allow-empty", "--cleanup=whitespace", "-F", &msg_file.to_string_lossy()])?;
                return Ok(OpOutcome::done("Message updated."));
            }
            let base = ensure_rewritable(repo, &oid)?;
            let mut todo = String::new();
            for c in commits_since(repo, base.as_deref())? {
                todo.push_str(&format!("pick {c}\n"));
                if c == oid {
                    todo.push_str(&format!("exec git commit --amend --only --allow-empty --cleanup=whitespace -F '{}'\n", sh_path(&msg_file)));
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
                    todo.push_str(&format!("exec git commit --amend --only --allow-empty --cleanup=whitespace -F '{}'\n", sh_path(&msg_file)));
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
            todo.push_str(&format!("exec git commit --amend --only --allow-empty --cleanup=whitespace -F '{}'\n", sh_path(&f)));
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
    let saved = stash_staged(repo, "interactive rebase")?;
    with_saved(repo, saved, interactive_rebase_logged(repo, base, items, None))
}
/// Rebase Studio entry: the user has explicitly confirmed how autostash treats their working
/// changes, and a full checkpoint (index included) is taken first, so staged work is allowed.
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
    // Paths are file names, not glob patterns: "pages/[id].tsx" must not also match "pages/i.tsx".
    // Only with explicit paths: without any, literal mode breaks stash's own pathspec handling.
    let literal: &[(&str, &str)] = if paths.is_empty() { &[] } else { &[("GIT_LITERAL_PATHSPECS", "1")] };
    let out = runner::run_env(repo, &args, literal, None)?;
    if out.contains("No local changes to save") {
        return Err(GitError::new("No local changes to stash."));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashStagingDifference {
    path: String,
    currently_staged: bool,
    matches_saved_index: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashApplyOutcome {
    #[serde(flatten)]
    pub operation: OpOutcome,
    pub index_restored: bool,
    pub stash_kept: bool,
    pub staging: Option<Vec<StashStagingDifference>>,
}

fn stash_staging_difference(repo: &Path, base: &str, saved_index: &str) -> GitResult<Vec<StashStagingDifference>> {
    use std::collections::HashSet;
    let saved = runner::run(repo, ["diff", "--name-only", "--no-renames", "-z", base, saved_index, "--"])?;
    let actual = runner::run(repo, ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"])?;
    let different = runner::run(repo, ["diff", "--cached", "--name-only", "--no-renames", "-z", saved_index, "--"])?;
    let actual: HashSet<_> = runner::split_nul(&actual).collect();
    let different: HashSet<_> = runner::split_nul(&different).collect();
    Ok(runner::split_nul(&saved)
        .map(|path| StashStagingDifference { path: path.into(), currently_staged: actual.contains(path), matches_saved_index: !different.contains(path) })
        .collect())
}

pub fn stash_apply(repo: &Path, index: u32, pop: bool) -> GitResult<StashApplyOutcome> {
    let name = format!("stash@{{{index}}}");
    stash_apply_ref(repo, &name, pop, true)
}

pub(super) fn stash_apply_ref(repo: &Path, name: &str, pop: bool, restore_index: bool) -> GitResult<StashApplyOutcome> {
    // A stash can add paths over ignored data on the destination branch.
    // Inspect both tracked snapshots and the optional untracked parent.
    let snapshot = runner::run(repo, ["rev-parse", "--verify", name])?;
    let snapshot = snapshot.trim();
    let base = format!("{snapshot}^1");
    let index = format!("{snapshot}^2");
    let untracked = format!("{snapshot}^3");
    let mut paths = runner::run_bytes(repo, ["diff", "--name-only", "--no-renames", "--diff-filter=ACMRT", "-z", &base, snapshot, "--"])?;
    paths.extend(runner::run_bytes(repo, ["diff", "--name-only", "--no-renames", "--diff-filter=ACMRT", "-z", &base, &index, "--"])?);
    if runner::exec(repo, ["rev-parse", "--verify", "--quiet", &untracked])?.ok() {
        paths.extend(runner::run_bytes(repo, ["ls-tree", "-r", "--name-only", "-z", &untracked])?);
    }
    check_ignored_paths(repo, &super::workspace_files::ignored(repo)?, &paths, "ignored")?;
    let before = status::status(repo)?.state_token;
    let mut args = vec!["-c", "stash.index=false", "stash", if pop { "pop" } else { "apply" }];
    if restore_index {
        args.push("--index");
    }
    args.push(if pop { name } else { snapshot });
    let out = runner::exec(repo, args)?;
    if out.ok() {
        return Ok(StashApplyOutcome { operation: OpOutcome::done(out.text()), index_restored: restore_index, stash_kept: !pop, staging: None });
    }
    let conflict_result = |conflicts| StashApplyOutcome {
        operation: OpOutcome { status: "conflicts".into(), conflicts, message: "Stash applied with conflicts; it was kept in the list.".into() },
        index_restored: false,
        stash_kept: true,
        staging: None,
    };
    let conflicts = conflicted(repo);
    if !conflicts.is_empty() {
        return Ok(conflict_result(conflicts));
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
    if !restore_index {
        return Err(runner::to_error("git stash apply", &out));
    }
    // Keep the only saved index even when the caller requested Pop.
    let out2 = runner::exec(repo, ["-c", "stash.index=false", "stash", "apply", snapshot])?;
    if out2.ok() {
        let staging = stash_staging_difference(repo, &base, &index).ok();
        return Ok(StashApplyOutcome {
            operation: OpOutcome {
                status: "index_not_restored".into(),
                conflicts: Vec::new(),
                message: "Working changes were applied, but the saved staging could not be restored. The stash was kept.".into(),
            },
            index_restored: false,
            stash_kept: true,
            staging,
        });
    }
    let c = conflicted(repo);
    if !c.is_empty() {
        return Ok(conflict_result(c));
    }
    Err(runner::to_error("git stash apply", &out2))
}

pub fn check_stash(repo: &Path, index: u32, expected_oid: &str) -> GitResult<()> {
    let actual = runner::exec(repo, ["rev-parse", "--verify", "--quiet", &format!("stash@{{{index}}}")])?;
    match actual.code {
        0 if actual.text().trim().eq_ignore_ascii_case(expected_oid) => Ok(()),
        0 | 1 => Err(GitError::new("The stash list changed. Reopen the stash before trying again.").kind("stale-operation")),
        _ => Err(runner::to_error("git rev-parse", &actual)),
    }
}

pub fn stash_apply_reviewed(repo: &Path, index: u32, expected_oid: &str, pop: bool) -> GitResult<StashApplyOutcome> {
    stash_apply_reviewed_with_index(repo, index, expected_oid, pop, true)
}

pub fn stash_apply_reviewed_with_index(repo: &Path, index: u32, expected_oid: &str, pop: bool, restore_index: bool) -> GitResult<StashApplyOutcome> {
    check_stash(repo, index, expected_oid)?;
    stash_apply_ref(repo, &format!("stash@{{{index}}}"), pop, restore_index)
}

pub fn stash_drop_reviewed(repo: &Path, index: u32, expected_oid: &str) -> GitResult<()> {
    check_stash(repo, index, expected_oid)?;
    stash_drop(repo, index)
}

pub fn stash_drop_with_checkpoint(repo: &Path, index: u32, oid: &str, expected: Option<&str>) -> GitResult<super::recovery::Summary> {
    check_stash(repo, index, oid)?;
    let checkpoint = super::recovery::reference_checkpoint(repo, "stash_drop", "Before stash drop", &[], expected)?;
    stash_drop_reviewed(repo, index, oid)?;
    Ok(checkpoint)
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

#[cfg(test)]
#[test]
fn saved_changes_never_overwrite_work_staged_meanwhile() {
    let fixture = tempfile::tempdir().unwrap();
    let repo = fixture.path();
    for args in [&["init", "-qb", "main"][..], &["config", "user.name", "T"], &["config", "user.email", "t@example.com"], &["config", "core.autocrlf", "false"]]
    {
        runner::run(repo, args).unwrap();
    }
    std::fs::write(
        repo.join("s.txt"),
        "s
",
    )
    .unwrap();
    runner::run(repo, ["add", "s.txt"]).unwrap();
    runner::run(repo, ["commit", "-qm", "base"]).unwrap();
    std::fs::write(
        repo.join("s.txt"),
        "saved
",
    )
    .unwrap();
    runner::run(repo, ["add", "s.txt"]).unwrap();
    let saved = stash_staged(repo, "test").unwrap().expect("stashed");
    // New staged content, with the working copy back at HEAD: `git diff HEAD` sees nothing.
    std::fs::write(
        repo.join("s.txt"),
        "staged meanwhile
",
    )
    .unwrap();
    runner::run(repo, ["add", "s.txt"]).unwrap();
    std::fs::write(
        repo.join("s.txt"),
        "s
",
    )
    .unwrap();
    let note = apply_saved(repo, &saved).unwrap().expect("reported");
    assert!(note.contains("s.txt"), "{note}");
    assert_eq!(
        runner::run(repo, ["show", ":s.txt"]).unwrap(),
        "staged meanwhile
"
    );
    assert!(!runner::run(repo, ["stash", "list"]).unwrap().is_empty(), "the saved changes stay in Stashes");
}
