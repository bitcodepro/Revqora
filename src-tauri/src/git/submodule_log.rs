//! What a submodule pointer change means: the commits between the old and the new commit.
use std::path::Path;

use serde::Serialize;

use super::runner::{self, GitError, GitResult};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleCommit {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleLog {
    /// Commits the new pointer adds (old..new), newest first, capped.
    pub added: Vec<SubmoduleCommit>,
    /// Commits the new pointer drops (new..old): a rewind or a switch to another branch.
    pub removed: Vec<SubmoduleCommit>,
    pub added_count: usize,
    pub removed_count: usize,
    /// Why the commits cannot be listed (submodule not checked out, commits not fetched).
    pub unavailable: Option<String>,
}

const SHOWN: usize = 50;

fn oid(value: &str) -> GitResult<&str> {
    let v = value.trim();
    if !(7..=64).contains(&v.len()) || !v.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("Invalid commit id.").kind("invalid-argument"));
    }
    Ok(v)
}

fn commits(sub: &Path, range: &str) -> GitResult<(Vec<SubmoduleCommit>, usize)> {
    let count = runner::run(sub, ["rev-list", "--count", range, "--"])?.trim().parse().unwrap_or(0);
    let raw = runner::run(sub, ["log", &format!("--max-count={SHOWN}"), "--format=%H%x1f%an%x1f%at%x1f%s", range, "--"])?;
    let list = raw
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(4, '\x1f').collect();
            (f.len() == 4).then(|| SubmoduleCommit { oid: f[0].into(), author: f[1].into(), time: f[2].parse().unwrap_or(0), subject: f[3].into() })
        })
        .collect();
    Ok((list, count))
}

/// The commits between two pointers of the submodule at `path` (relative to the repository).
pub fn log(repo: &Path, path: &str, from: Option<&str>, to: Option<&str>) -> GitResult<SubmoduleLog> {
    if path.is_empty() || path.split('/').any(|p| p == ".." || p.is_empty()) {
        return Err(GitError::new("Invalid submodule path.").kind("invalid-argument"));
    }
    let empty = |why: &str| SubmoduleLog { added: vec![], removed: vec![], added_count: 0, removed_count: 0, unavailable: Some(why.to_string()) };
    let sub = repo.join(path);
    // Checked out = the folder is the top of its own repository (not just a folder of ours).
    let top = runner::exec(&sub, ["rev-parse", "--show-toplevel"]).ok().filter(|o| o.ok()).map(|o| std::path::PathBuf::from(o.text().trim()));
    let checked_out = match (top.and_then(|t| std::fs::canonicalize(t).ok()), std::fs::canonicalize(&sub).ok()) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    };
    if !checked_out {
        return Ok(empty("The submodule is not checked out, so its commits cannot be listed."));
    }
    let (Some(from), Some(to)) = (from, to) else {
        return Ok(empty("The submodule was added or removed."));
    };
    let (from, to) = (oid(from)?, oid(to)?);
    for c in [from, to] {
        if !runner::exec(&sub, ["cat-file", "-e", &format!("{c}^{{commit}}")])?.ok() {
            return Ok(empty("Some of these commits are not in the submodule yet. Fetch it to see them."));
        }
    }
    let (added, added_count) = commits(&sub, &format!("{from}..{to}"))?;
    let (removed, removed_count) = commits(&sub, &format!("{to}..{from}"))?;
    Ok(SubmoduleLog { added, removed, added_count, removed_count, unavailable: None })
}
