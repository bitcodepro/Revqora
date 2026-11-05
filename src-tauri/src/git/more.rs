//! Branch recovery, patches, cross-commit file transfer, stash contents, tree browsing,
//! working-tree comparison, commit message helpers and hook detection.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::commit::{changed_files, ChangedFile};
use super::diff::{self, DiffOptions, FileDiff};
use super::repo;
use super::runner::{self, GitError, GitResult};

// ───────────── branch reflog & recovery ─────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedBranch {
    pub name: String,
    pub oid: String,
    pub time: i64,
    pub subject: String,
    /// "revqora" (deleted in the app) or "reflog" (found in HEAD's history).
    pub source: String,
}

fn deleted_file(repo: &Path) -> GitResult<std::path::PathBuf> {
    let dir = super::storage::dir(repo)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("deleted-branches.json"))
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Remembers a branch tip before it is deleted so it can be restored later.
pub fn record_deleted(repo: &Path, name: &str) -> GitResult<()> {
    let Ok(oid) = runner::run(repo, ["rev-parse", "--verify", &format!("refs/heads/{name}")]) else { return Ok(()) };
    let subject = runner::run(repo, ["log", "-1", "--format=%s", oid.trim()]).unwrap_or_default();
    let file = deleted_file(repo)?;
    let mut list: Vec<DeletedBranch> = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    list.retain(|b| b.name != name);
    list.insert(0, DeletedBranch { name: name.into(), oid: oid.trim().into(), time: now(), subject: subject.trim().into(), source: "revqora".into() });
    list.truncate(100);
    std::fs::write(file, serde_json::to_string_pretty(&list).unwrap_or_default())?;
    Ok(())
}

/// Preserve the legacy deleted-branches list without spawning Git per row.
pub(super) fn record_deleted_tips(repo: &Path, tips: &[(&str, &str)]) -> GitResult<()> {
    let mut args = vec!["log", "--no-walk", "--format=%H%x00%s"];
    args.extend(tips.iter().map(|(_, oid)| *oid));
    args.push("--");
    let subjects = runner::run(repo, &args).unwrap_or_default();
    let subjects: std::collections::HashMap<_, _> = subjects.lines().filter_map(|line| line.split_once('\0')).collect();
    let file = deleted_file(repo)?;
    let mut list: Vec<DeletedBranch> = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    list.retain(|b| !tips.iter().any(|(name, _)| *name == b.name));
    for (name, oid) in tips.iter().rev() {
        list.insert(
            0,
            DeletedBranch {
                name: (*name).into(),
                oid: (*oid).into(),
                time: now(),
                subject: subjects.get(oid).copied().unwrap_or("").into(),
                source: "revqora".into(),
            },
        );
    }
    list.truncate(100);
    let mut temporary = super::atomic_file::new_in(file.parent().ok_or_else(|| GitError::new("Invalid deleted-branch history path"))?)?;
    serde_json::to_writer_pretty(&mut temporary, &list).map_err(|_| GitError::new("Could not encode deleted-branch history"))?;
    temporary.as_file().sync_all()?;
    super::atomic_file::replace(temporary, &file)?;
    Ok(())
}

/// Branches that no longer exist: deleted in Revqora, or last seen in HEAD's reflog.
pub fn deleted_branches(repo: &Path) -> GitResult<Vec<DeletedBranch>> {
    let existing: HashSet<String> = runner::run(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])?.lines().map(|s| s.to_string()).collect();
    let mut out: Vec<DeletedBranch> = std::fs::read_to_string(deleted_file(repo)?).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    out.retain(|b| !existing.contains(&b.name));
    // "checkout: moving from A to B" lines name branches; the entry's oid is where we left A
    // only for the previous line, so read pairs (newest first).
    let raw = runner::exec(repo, ["reflog", "show", "-n", "2000", "--format=%H%x1f%gs%x1f%ct", "HEAD"])?.text();
    let entries: Vec<(String, String, i64)> = raw
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(3, '\x1f').collect();
            (f.len() == 3).then(|| (f[0].to_string(), f[1].to_string(), f[2].parse().unwrap_or(0)))
        })
        .collect();
    for (i, (_, msg, time)) in entries.iter().enumerate() {
        let Some(rest) = msg.strip_prefix("checkout: moving from ") else { continue };
        let Some((from, _)) = rest.split_once(" to ") else { continue };
        if matches!(from.len(), 40 | 64) && from.bytes().all(|b| b.is_ascii_hexdigit()) || existing.contains(from) || out.iter().any(|b| b.name == from) {
            continue;
        }
        // HEAD before this checkout = the next (older) entry's oid.
        if let Some((oid, _, _)) = entries.get(i + 1) {
            let subject = runner::run(repo, ["log", "-1", "--format=%s", oid]).unwrap_or_default();
            out.push(DeletedBranch { name: from.to_string(), oid: oid.clone(), time: *time, subject: subject.trim().into(), source: "reflog".into() });
        }
    }
    Ok(out)
}

pub fn restore_branch(repo: &Path, name: &str, oid: &str) -> GitResult<()> {
    runner::run(repo, ["branch", name, oid])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLogEntry {
    pub oid: String,
    pub message: String,
    pub time: i64,
}

pub fn branch_reflog(repo: &Path, name: &str) -> GitResult<Vec<RefLogEntry>> {
    let out = runner::exec(repo, ["reflog", "show", "-n", "300", "--format=%H%x1f%gs%x1f%ct", &format!("refs/heads/{name}")])?;
    Ok(out
        .text()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(3, '\x1f').collect();
            (f.len() == 3).then(|| RefLogEntry { oid: f[0].into(), message: f[1].into(), time: f[2].parse().unwrap_or(0) })
        })
        .collect())
}

// ───────────── patches ─────────────

/// Writes the commits as one mbox patch file (oldest first).
pub fn create_patch(repo: &Path, oids: &[String], file: &str) -> GitResult<usize> {
    if oids.is_empty() {
        return Err(GitError::new("Select at least one commit."));
    }
    let mut out = Vec::new();
    for oid in oids {
        let one = runner::run_bytes(repo, ["format-patch", "-1", "--stdout", "--no-signature", oid])?;
        out.extend_from_slice(&one);
    }
    std::fs::write(file, out)?;
    Ok(oids.len())
}

/// Applies a patch file: mbox (`git am -3`) or a plain diff (`git apply -3` into the working tree).
pub fn apply_patch(repo: &Path, file: &str) -> GitResult<super::ops::OpOutcome> {
    let head = std::fs::read(file)?;
    let text = String::from_utf8_lossy(&head[..head.len().min(2000)]).to_string();
    let mbox = text.starts_with("From ") && text.contains("Subject:");
    let out = if mbox { runner::exec(repo, ["am", "-3", "--keep-cr", file])? } else { runner::exec(repo, ["apply", "-3", "--whitespace=nowarn", file])? };
    if out.ok() {
        return Ok(super::ops::OpOutcome {
            status: "done".into(),
            conflicts: Vec::new(),
            message: if mbox { "Commits applied".into() } else { "Patch applied to the working tree".into() },
        });
    }
    let conflicts: Vec<String> = super::status::status(repo)?.files.into_iter().filter(|f| f.conflict.is_some()).map(|f| f.path).collect();
    if !conflicts.is_empty() {
        return Ok(super::ops::OpOutcome { status: "conflicts".into(), conflicts, message: out.stderr });
    }
    if mbox && repo::git_dir(repo)?.join("rebase-apply").exists() {
        return Ok(super::ops::OpOutcome { status: "stopped".into(), conflicts: Vec::new(), message: out.stderr });
    }
    Err(runner::to_error(if mbox { "git am" } else { "git apply" }, &out))
}

// ───────────── taking changes from other commits ─────────────

/// Replaces a working-tree file with its version at `rev` (also staged).
pub fn checkout_file(repo: &Path, rev: &str, path: &str) -> GitResult<()> {
    super::ops::backup_files(repo, &[path.to_string()])?;
    runner::run_env(repo, ["checkout", rev, "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
    Ok(())
}

/// Applies (selected lines of) the change a commit made to a file onto the working tree.
pub fn apply_from_commit(repo: &Path, from: Option<&str>, to: &str, path: &str, selection: Option<&[(usize, usize)]>) -> GitResult<()> {
    let opts = diff::DiffOptions::default();
    let hash = diff::rev_diff(repo, from, to, path, &opts)?.hash;
    apply_from_commit_reviewed(repo, from, to, path, selection, &opts, Some(&hash))
}

pub fn apply_from_commit_reviewed(
    repo: &Path,
    from: Option<&str>,
    to: &str,
    path: &str,
    selection: Option<&[(usize, usize)]>,
    opts: &diff::DiffOptions,
    expected_hash: Option<&str>,
) -> GitResult<()> {
    let base = match from {
        Some(from) => from.to_owned(),
        None => diff::empty_tree(repo)?,
    };
    let patch = match selection {
        Some(sel) if !sel.is_empty() => {
            let raw = diff::rev_raw(repo, Some(&base), to, path, opts)?;
            if expected_hash != Some(diff::fingerprint(&raw).as_str()) {
                return Err(GitError::new("The displayed diff changed. Reload it before applying selected lines.").kind("stale-diff"));
            }
            let files = diff::parse(&raw);
            let file = files.into_iter().next().ok_or_else(|| GitError::new("Nothing to apply."))?;
            let set: HashSet<(usize, usize)> = sel.iter().copied().collect();
            diff::build_partial_patch(&file, &set, false).ok_or_else(|| GitError::new("No changed lines selected."))?
        }
        _ => runner::exec_full(repo, ["diff", "--no-color", "--no-ext-diff", "--binary", &base, to, "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)
            .and_then(|out| if out.ok() { Ok(out.stdout) } else { Err(runner::to_error("git diff", &out)) })?,
    };
    let out = runner::exec_full(repo, ["apply", "-3", "--recount", "--unidiff-zero", "--whitespace=nowarn", "-"], &[], Some(&patch))?;
    if !out.ok() {
        return Err(runner::to_error("git apply", &out));
    }
    Ok(())
}

// ───────────── stash contents ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashContents {
    pub oid: String,
    pub base: String,
    pub files: Vec<ChangedFile>,
    /// Untracked files saved with --include-untracked (diffed against the empty tree).
    pub untracked: Vec<ChangedFile>,
    pub untracked_commit: Option<String>,
}

pub fn stash_contents(repo: &Path, index: u32) -> GitResult<StashContents> {
    let name = format!("stash@{{{index}}}");
    let oid = runner::run(repo, ["rev-parse", "--verify", &name])?.trim().to_string();
    stash_contents_at(repo, &oid)
}

pub fn stash_contents_at(repo: &Path, oid: &str) -> GitResult<StashContents> {
    let oid = stash_oid(repo, oid)?;
    let base = runner::run(repo, ["rev-parse", &format!("{oid}^1")])?.trim().to_string();
    let files = changed_files(repo, &base, &oid)?;
    let u = runner::exec(repo, ["rev-parse", "-q", "--verify", &format!("{oid}^3")])?;
    let (untracked, untracked_commit) = if u.ok() {
        let uc = u.text().trim().to_string();
        (changed_files(repo, &diff::empty_tree(repo)?, &uc)?, Some(uc))
    } else {
        (Vec::new(), None)
    };
    Ok(StashContents { oid, base, files, untracked, untracked_commit })
}

/// Restores one file from a stash into the working tree.
pub fn stash_restore_file(repo: &Path, index: u32, path: &str, untracked: bool) -> GitResult<()> {
    let oid = runner::run(repo, ["rev-parse", "--verify", &format!("stash@{{{index}}}")])?;
    stash_restore_file_at(repo, oid.trim(), path, untracked)
}

/// Pin the displayed snapshot before making a backup or touching the working tree.
pub fn stash_restore_file_at(repo: &Path, oid: &str, path: &str, untracked: bool) -> GitResult<()> {
    let oid = stash_oid(repo, oid)?;
    let rev = if untracked { format!("{oid}^3") } else { oid };
    super::ops::backup_files(repo, &[path.to_string()])?;
    let out = runner::exec_full(repo, ["restore", &format!("--source={rev}"), "--worktree", "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
    if !out.ok() {
        return Err(runner::to_error("git restore", &out));
    }
    Ok(())
}

fn stash_oid(repo: &Path, oid: &str) -> GitResult<String> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::new("The stash snapshot is missing. Reopen the stash before trying again."));
    }
    Ok(runner::run(repo, ["rev-parse", "--verify", "--end-of-options", &format!("{oid}^{{commit}}")])?.trim().to_string())
}

// ───────────── tree browser & grep ─────────────

pub fn list_tree(repo: &Path, rev: &str) -> GitResult<Vec<String>> {
    let raw = runner::run(repo, ["ls-tree", "-r", "-z", "--name-only", rev])?;
    Ok(runner::split_nul(&raw).map(|s| s.to_string()).collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

pub fn grep(repo: &Path, rev: &str, query: &str, ignore_case: bool, regex: bool) -> GitResult<Vec<GrepHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["grep".to_string(), "-n".into(), "-I".into(), "--full-name".into(), "--null".into(), "--max-count=200".into()];
    if ignore_case {
        args.push("-i".into());
    }
    args.push(if regex { "-E".into() } else { "-F".into() });
    args.push("-e".into());
    args.push(query.into());
    args.push(rev.into());
    let out = runner::exec(repo, &args)?;
    if out.code == 1 {
        return Ok(Vec::new());
    }
    if !out.ok() {
        return Err(runner::to_error("git grep", &out));
    }
    let prefix = format!("{rev}:");
    Ok(out
        .text()
        .lines()
        .take(2000)
        .filter_map(|l| {
            // "<rev>:<path>\0<line>\0<text>"
            let mut it = l.splitn(3, '\0');
            let p = it.next()?;
            let n = it.next()?.parse().ok()?;
            let t = it.next().unwrap_or("");
            Some(GrepHit { path: p.strip_prefix(&prefix).unwrap_or(p).to_string(), line: n, text: t.chars().take(400).collect() })
        })
        .collect())
}

// ───────────── working tree vs any revision ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeComparison {
    pub from: String,
    pub files: Vec<ChangedFile>,
}

pub fn compare_worktree(repo: &Path, from: &str) -> GitResult<WorktreeComparison> {
    let oid = runner::run(repo, ["rev-parse", "--verify", &format!("{from}^{{commit}}")])
        .map_err(|_| GitError::new(format!("'{from}' is not a commit.")))?
        .trim()
        .to_string();
    let ns = runner::run(repo, ["diff", "-z", "--name-status", "--find-renames", &oid])?;
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut it = ns.split('\0').filter(|s| !s.is_empty());
    while let Some(st) = it.next() {
        let code = st.chars().next().unwrap_or('M').to_string();
        if code == "R" || code == "C" {
            let old = it.next().unwrap_or("").to_string();
            let new = it.next().unwrap_or("").to_string();
            files.push(ChangedFile { path: new, old_path: Some(old), status: code, additions: None, deletions: None, binary: false });
        } else if let Some(p) = it.next() {
            files.push(ChangedFile { path: p.into(), old_path: None, status: code, additions: None, deletions: None, binary: false });
        }
    }
    let stat = runner::run(repo, ["diff", "--numstat", "-z", "--find-renames", &oid])?;
    let mut it = stat.split('\0');
    while let Some(rec) = it.next() {
        let mut parts = rec.splitn(3, '\t');
        let (a, d, mut p) = (parts.next().unwrap_or("-"), parts.next().unwrap_or("-"), parts.next().unwrap_or("").to_string());
        if p.is_empty() {
            let _ = it.next();
            p = it.next().unwrap_or("").to_string();
        }
        if let Some(f) = files.iter_mut().find(|f| f.path == p) {
            f.binary = a == "-";
            f.additions = a.parse().ok();
            f.deletions = d.parse().ok();
        }
    }
    Ok(WorktreeComparison { from: oid, files })
}

pub fn worktree_file_diff(repo: &Path, from: &str, path: &str, opts: &DiffOptions) -> GitResult<FileDiff> {
    let mut args = vec!["diff".to_string(), "--no-color".into(), "--no-ext-diff".into(), "--find-renames".into(), format!("-U{}", opts.context.unwrap_or(3))];
    if opts.ignore_whitespace {
        args.push("-w".into());
    }
    args.push(from.into());
    args.push("--".into());
    args.push(path.into());
    let raw = runner::run_bytes(repo, &args)?;
    let hash = diff::fingerprint(&raw);
    let files = diff::parse(&raw);
    Ok(match files.first() {
        Some(f) => diff::to_display(f, path, hash),
        None => FileDiff { path: path.into(), hash, empty: true, ..Default::default() },
    })
}

// ───────────── commit message helpers & hooks ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitHelpers {
    /// Content of `commit.template`, if configured.
    pub template: Option<String>,
    /// Recent subjects for autocompletion (newest first, unique).
    pub recent: Vec<String>,
    /// Hooks that run on commit (pre-commit, commit-msg, …).
    pub hooks: Vec<String>,
}

pub fn commit_helpers(repo: &Path) -> GitResult<CommitHelpers> {
    let template = repo::config_get(repo, "commit.template").and_then(|p| {
        let path = if let Some(rest) = p.strip_prefix("~/") {
            std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map(|h| Path::new(&h).join(rest)).ok()?
        } else {
            repo.join(&p)
        };
        std::fs::read_to_string(path).ok()
    });
    let mut seen = HashSet::new();
    let recent: Vec<String> = runner::run(repo, ["log", "-n", "400", "--format=%s"])
        .unwrap_or_default()
        .lines()
        .filter(|s| seen.insert(s.to_string()))
        .take(200)
        .map(|s| s.to_string())
        .collect();
    let hooks_dir = match repo::config_get(repo, "core.hooksPath") {
        Some(p) => repo.join(p),
        None => runner::run(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
            .map(|s| repo::normalize(s.trim().into()))
            .unwrap_or_else(|_| repo.join(".git/hooks")),
    };
    let hooks = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-push"]
        .iter()
        .filter(|h| hooks_dir.join(h).is_file())
        .map(|h| h.to_string())
        .collect();
    Ok(CommitHelpers { template, recent, hooks })
}

#[cfg(test)]
mod tests {
    #[test]
    fn grep_line_format() {
        let l = "HEAD:src/a.rs\u{0}12\u{0}let x = 1;";
        let mut it = l.splitn(3, '\0');
        assert_eq!(it.next(), Some("HEAD:src/a.rs"));
        assert_eq!(it.next(), Some("12"));
    }
}
