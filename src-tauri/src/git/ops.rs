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
    let dir = repo::git_dir(repo)?.join("revqora");
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
    runner::run_env(repo, &a, &[], Some(&nul_join(paths)))
}

fn conflicted(repo: &Path) -> Vec<String> {
    status::status(repo).map(|s| s.files.into_iter().filter(|f| f.conflict.is_some()).map(|f| f.path).collect()).unwrap_or_default()
}

fn head_oid(repo: &Path) -> Option<String> {
    runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD"]).ok().filter(|o| o.ok()).map(|o| o.text().trim().to_string())
}

// ───────────────────────────── working copy ─────────────────────────────

pub fn stage_paths(repo: &Path, paths: &[String]) -> GitResult<()> {
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

/// Copies files into `.git/revqora/trash/<time>/` before destructive operations.
pub fn backup_files(repo: &Path, paths: &[String]) -> GitResult<PathBuf> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dir = repo::git_dir(repo)?.join("revqora").join("trash").join(ts.to_string());
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
    if let Ok(gd) = repo::git_dir(repo) {
        let _ = std::fs::remove_file(gd.join("revqora-squash"));
    }
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
                runner::run(repo, ["switch", local])?;
            } else {
                runner::run(repo, ["switch", "-c", local, "--track", target])?;
            }
            Ok(local.to_string())
        }
        "commit" => {
            runner::run(repo, ["switch", "--detach", target])?;
            Ok(target.to_string())
        }
        _ => {
            runner::run(repo, ["switch", target])?;
            Ok(target.to_string())
        }
    }
}

pub fn create_branch(repo: &Path, name: &str, start: Option<&str>, checkout: bool) -> GitResult<()> {
    let name = name.trim();
    runner::run(repo, ["check-ref-format", "--branch", name]).map_err(|_| GitError::new(format!("'{name}' is not a valid branch name.")))?;
    let mut args = if checkout { vec!["switch", "-c", name] } else { vec!["branch", name] };
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

pub fn pull(repo: &Path, mode: &str, on_line: impl FnMut(&str)) -> GitResult<OpOutcome> {
    let mut args = vec!["pull".to_string(), "--progress".into()];
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
    match runner::run_streaming(repo, &args, &[], on_line) {
        Ok(out) => Ok(OpOutcome::done(out)),
        Err(e) => {
            let c = conflicted(repo);
            if !c.is_empty() {
                Ok(OpOutcome { status: "conflicts".into(), conflicts: c, message: e.message })
            } else {
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

/// Starts a merge but never creates the merge commit: the user reviews and confirms.
pub fn merge_start(repo: &Path, target: &str, strategy: &str) -> GitResult<OpOutcome> {
    let gd = repo::git_dir(repo)?;
    let before = head_oid(repo);
    let mut args: Vec<&str> = vec!["merge"];
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
        std::fs::write(gd.join("revqora-squash"), target)?;
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
            let _ = std::fs::remove_file(gd.join("revqora-squash"));
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
            let msg = message
                .map(|m| m.to_string())
                .or_else(|| std::fs::read_to_string(gd.join(if kind == "merge" { "MERGE_MSG" } else { "SQUASH_MSG" })).ok())
                .unwrap_or_else(|| "Merge".into());
            let oid = commit(repo, &msg, &CommitOptions::default())?;
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
    let file = temp_file(repo, "rebase-todo", todo)?;
    let editor = format!("cp '{}'", sh_path(&file));
    let mut args = vec!["rebase", "-i", "--autostash", "--keep-empty"];
    match base {
        Some(b) => args.push(b),
        None => args.push("--root"),
    }
    let out = runner::exec_full(repo, &args, &[("GIT_SEQUENCE_EDITOR", editor.as_str())], None)?;
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub oid: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
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
    let range = match &base {
        Some(b) => format!("{b}..HEAD"),
        None => "HEAD".into(),
    };
    let raw = runner::run(repo, ["log", "--reverse", "--format=%H%x1f%an%x1f%at%x1f%s%x1f%b%x1e", &range])?;
    let commits = raw
        .split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            let f: Vec<&str> = rec.splitn(5, '\x1f').collect();
            (f.len() == 5).then(|| PlanCommit {
                oid: f[0].to_string(),
                author: f[1].to_string(),
                time: f[2].parse().unwrap_or(0),
                subject: f[3].to_string(),
                body: f[4].trim().to_string(),
            })
        })
        .collect();
    Ok(RebasePlan { base, commits })
}

#[derive(Debug, Clone, Deserialize)]
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
    run_todo(repo, base, &todo)
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
    let out = runner::exec(repo, ["stash", if pop { "pop" } else { "apply" }, "--index", &name])?;
    if out.ok() {
        return Ok(OpOutcome::done(out.text()));
    }
    let c = conflicted(repo);
    if !c.is_empty() {
        return Ok(OpOutcome { status: "conflicts".into(), conflicts: c, message: "Stash applied with conflicts; it was kept in the list.".into() });
    }
    // Retry without restoring the index (fails when staged changes conflict).
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
