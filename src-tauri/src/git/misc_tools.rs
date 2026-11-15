//! Smaller Git features: rerere, commit notes, archive export and "branch from stash".
use std::path::Path;

use serde::Serialize;

use super::repo;
use super::runner::{self, GitError, GitResult};

fn check_oid(value: &str) -> GitResult<&str> {
    let v = value.trim();
    if !(7..=64).contains(&v.len()) || !v.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("Invalid commit id.").kind("invalid-argument"));
    }
    Ok(v)
}

// ───────────── rerere ─────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rerere {
    /// Git records conflict resolutions and replays them when the same conflict comes back.
    pub enabled: bool,
    /// Replayed resolutions are staged automatically (rerere.autoUpdate).
    pub auto_update: bool,
}

pub fn rerere(repo: &Path) -> Rerere {
    let on = |k: &str| repo::config_get(repo, k).is_some_and(|v| v == "true");
    Rerere { enabled: on("rerere.enabled"), auto_update: on("rerere.autoUpdate") }
}

/// Sets rerere for this repository only.
pub fn set_rerere(repo: &Path, enabled: bool, auto_update: bool) -> GitResult<Rerere> {
    repo::config_set(repo, "rerere.enabled", if enabled { "true" } else { "false" }, false)?;
    repo::config_set(repo, "rerere.autoUpdate", if auto_update && enabled { "true" } else { "false" }, false)?;
    Ok(rerere(repo))
}

// ───────────── notes ─────────────

/// The note attached to a commit (refs/notes/commits), if any.
pub fn note(repo: &Path, oid: &str) -> GitResult<Option<String>> {
    let oid = check_oid(oid)?;
    let out = runner::exec(repo, ["notes", "show", oid])?;
    Ok(out.ok().then(|| out.text().trim_end().to_string()).filter(|t| !t.is_empty()))
}

/// Replaces (or with empty text, removes) the note on a commit. Notes are local until pushed
/// (refs/notes/*); they never change the commit itself.
pub fn set_note(repo: &Path, oid: &str, text: &str) -> GitResult<()> {
    let oid = check_oid(oid)?;
    if text.trim().is_empty() {
        let out = runner::exec(repo, ["notes", "remove", "--ignore-missing", oid])?;
        if !out.ok() {
            return Err(GitError::new(out.text().trim().to_string()));
        }
        return Ok(());
    }
    let mut body = text.trim_end().as_bytes().to_vec();
    body.push(b'\n');
    let out = runner::exec_full(repo, ["notes", "add", "-f", "-F", "-", oid], &[], Some(&body))?;
    if out.code != 0 {
        return Err(GitError::new(out.stderr.trim().to_string()));
    }
    Ok(())
}

// ───────────── archive ─────────────

/// Writes the tree of `rev` to `dest` as a zip or tar.gz (by `format`), with an optional
/// top-level folder name inside the archive.
pub fn archive(repo: &Path, rev: &str, format: &str, dest: &Path, prefix: Option<&str>) -> GitResult<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.chars().any(char::is_whitespace) {
        return Err(GitError::new("Invalid revision.").kind("invalid-argument"));
    }
    let format = match format {
        "zip" => "zip",
        "tar.gz" | "tgz" => "tar.gz",
        _ => return Err(GitError::new("Choose zip or tar.gz.").kind("invalid-argument")),
    };
    if !dest.is_absolute() {
        return Err(GitError::new("Choose where to save the archive.").kind("invalid-argument"));
    }
    let mut args = vec!["archive".to_string(), format!("--format={format}"), "-o".into(), dest.to_string_lossy().into_owned()];
    if let Some(p) = prefix.map(str::trim).filter(|p| !p.is_empty()) {
        if p.contains("..") || p.starts_with('/') || p.contains('\\') {
            return Err(GitError::new("Invalid folder name for the archive.").kind("invalid-argument"));
        }
        args.push(format!("--prefix={}/", p.trim_end_matches('/')));
    }
    args.push(format!("{rev}^{{tree}}"));
    runner::run(repo, &args)?;
    Ok(())
}

// ───────────── branch from stash ─────────────

/// `git stash branch`: a new branch at the stash's base, checked out, with the stash applied
/// (staging included) and dropped on success. `expected` guards against a renumbered stash.
pub fn stash_branch(repo: &Path, name: &str, index: u32, expected: &str) -> GitResult<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || !runner::exec(repo, ["check-ref-format", "--branch", name])?.ok() {
        return Err(GitError::new(format!("{name} is not a valid branch name.")).kind("invalid-branch"));
    }
    super::ops::check_stash(repo, index, expected)?;
    let out = runner::exec(repo, ["stash", "branch", name, &format!("stash@{{{index}}}")])?;
    if !out.ok() {
        return Err(GitError::new(out.text().trim().to_string()));
    }
    Ok(out.text())
}
