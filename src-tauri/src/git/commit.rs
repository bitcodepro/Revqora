//! Commit details, file lists and file history.

use std::path::Path;

use serde::Serialize;

use super::diff::EMPTY_TREE;
use super::runner::{self, GitResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    /// A, M, D, R, C, T
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<ChangedFile>,
    /// Revision the file diffs are computed against (first parent or the empty tree).
    pub diff_base: Option<String>,
    pub contained_in_remote: bool,
}

/// Lists files changed between two trees with line statistics.
pub fn changed_files(repo: &Path, from: &str, to: &str) -> GitResult<Vec<ChangedFile>> {
    let ns = runner::run(repo, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "--find-renames", from, to])?;
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut it = ns.split('\0').filter(|s| !s.is_empty());
    while let Some(status) = it.next() {
        let code = status.chars().next().unwrap_or('M').to_string();
        if code == "R" || code == "C" {
            let old = it.next().unwrap_or("").to_string();
            let new = it.next().unwrap_or("").to_string();
            files.push(ChangedFile { path: new, old_path: Some(old), status: code, additions: None, deletions: None, binary: false });
        } else if let Some(p) = it.next() {
            files.push(ChangedFile { path: p.to_string(), old_path: None, status: code, additions: None, deletions: None, binary: false });
        }
    }
    // Line statistics.
    let stat = runner::run(repo, ["diff", "--numstat", "-z", "--find-renames", "--no-ext-diff", from, to])?;
    let mut it = stat.split('\0');
    while let Some(rec) = it.next() {
        if rec.is_empty() {
            continue;
        }
        let mut parts = rec.splitn(3, '\t');
        let add = parts.next().unwrap_or("-");
        let del = parts.next().unwrap_or("-");
        let mut path = parts.next().unwrap_or("").to_string();
        if path.is_empty() {
            // rename: "\0old\0new"
            let _old = it.next();
            path = it.next().unwrap_or("").to_string();
        }
        if let Some(f) = files.iter_mut().find(|f| f.path == path) {
            f.binary = add == "-";
            f.additions = add.parse().ok();
            f.deletions = del.parse().ok();
        }
    }
    Ok(files)
}

pub fn details(repo: &Path, oid: &str) -> GitResult<CommitDetails> {
    let raw = runner::run(repo, ["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B", oid])?;
    let f: Vec<&str> = raw.splitn(9, '\x1f').collect();
    let parents: Vec<String> = f.get(1).unwrap_or(&"").split_whitespace().map(|s| s.to_string()).collect();
    let message = f.get(8).unwrap_or(&"").trim_end().to_string();
    let (subject, body) = match message.split_once('\n') {
        Some((s, b)) => (s.trim().to_string(), b.trim_start_matches(['\n', '\r']).to_string()),
        None => (message.clone(), String::new()),
    };
    let base = parents.first().cloned();
    let files = changed_files(repo, base.as_deref().unwrap_or(EMPTY_TREE), oid)?;
    let contained = runner::run(repo, ["branch", "-r", "--contains", oid, "--format=%(refname)"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    Ok(CommitDetails {
        oid: f.first().unwrap_or(&"").trim().to_string(),
        parents,
        author: f.get(2).unwrap_or(&"").to_string(),
        author_email: f.get(3).unwrap_or(&"").to_string(),
        author_time: f.get(4).and_then(|s| s.parse().ok()).unwrap_or(0),
        committer: f.get(5).unwrap_or(&"").to_string(),
        committer_email: f.get(6).unwrap_or(&"").to_string(),
        commit_time: f.get(7).and_then(|s| s.parse().ok()).unwrap_or(0),
        subject,
        body,
        files,
        diff_base: base,
        contained_in_remote: contained,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
    pub path: String,
}

pub fn file_history(repo: &Path, path: &str, limit: usize) -> GitResult<Vec<FileHistoryEntry>> {
    let raw = runner::run(repo, ["log", "--follow", &format!("--max-count={limit}"), "--name-only", "--format=%x1e%H%x1f%an%x1f%at%x1f%s", "--", path])?;
    let mut out = Vec::new();
    for rec in raw.split('\x1e') {
        let rec = rec.trim();
        if rec.is_empty() {
            continue;
        }
        let mut lines = rec.lines();
        let head = lines.next().unwrap_or("");
        let f: Vec<&str> = head.splitn(4, '\x1f').collect();
        if f.len() < 4 {
            continue;
        }
        let p = lines.find(|l| !l.trim().is_empty()).unwrap_or(path).to_string();
        out.push(FileHistoryEntry { oid: f[0].to_string(), author: f[1].to_string(), time: f[2].parse().unwrap_or(0), subject: f[3].to_string(), path: p });
    }
    Ok(out)
}

/// Contents of a file at a revision ("" = index stage 0, ":2" etc. allowed via `spec`).
pub fn blob_text(repo: &Path, spec: &str) -> GitResult<Option<String>> {
    let out = runner::exec(repo, ["show", spec])?;
    if !out.ok() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}
