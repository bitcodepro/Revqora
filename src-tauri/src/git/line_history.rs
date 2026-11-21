//! History of a range of lines (`git log -L`) and of a whole folder.
use std::path::Path;

use serde::Serialize;

use super::diff::{self, FileDiff};
use super::runner::{self, GitError, GitResult};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryEntry {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
    /// The file's name in this commit (line history follows renames).
    pub path: String,
    /// How this commit changed the lines, as a diff limited to them.
    pub diff: FileDiff,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderHistoryEntry {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
    /// Files under the folder this commit changed.
    pub files: Vec<String>,
    /// The first parent, which the commit's diff is shown against (none for a root commit).
    pub parent: Option<String>,
}

const FORMAT: &str = "--format=%x1e%H%x1f%an%x1f%at%x1f%s";

fn check_rev(rev: &str) -> GitResult<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.chars().any(char::is_whitespace) {
        return Err(GitError::new("Invalid revision.").kind("invalid-argument"));
    }
    Ok(())
}

fn check_path(path: &str) -> GitResult<()> {
    if path.is_empty() || path.contains('\n') || path.split('/').any(|p| p == "..") {
        return Err(GitError::new("Invalid path.").kind("invalid-argument"));
    }
    Ok(())
}

fn header(head: &str) -> Option<(String, String, i64, String)> {
    let f: Vec<&str> = head.splitn(4, '\x1f').collect();
    (f.len() == 4 && f[0].len() >= 40).then(|| (f[0].to_string(), f[1].to_string(), f[2].trim().parse().unwrap_or(0), f[3].to_string()))
}

/// Commits that changed lines `start..=end` of `path` as it is at `rev` (default HEAD), newest
/// first, each with the diff of just those lines. Renames are followed.
pub fn line_history(repo: &Path, path: &str, start: u32, end: u32, rev: Option<&str>, limit: usize) -> GitResult<Vec<LineHistoryEntry>> {
    check_path(path)?;
    if start == 0 || end < start {
        return Err(GitError::new("Choose a valid range of lines.").kind("invalid-argument"));
    }
    let rev = rev.unwrap_or("HEAD");
    check_rev(rev)?;
    // -L's argument is "<start>,<end>:<file>": the file part may contain ':' and is not a pathspec.
    let range = format!("-L{start},{end}:{path}");
    let max = format!("--max-count={}", limit.clamp(1, 10_000));
    let raw = runner::run_bytes(repo, ["log", FORMAT, "--no-color", "--no-ext-diff", &max, &range, rev, "--"])?;
    let mut out = Vec::new();
    for record in raw.split(|b| *b == 0x1e).filter(|r| !r.is_empty()) {
        let split = record.iter().position(|b| *b == b'\n').unwrap_or(record.len());
        let Some((oid, author, time, subject)) = header(&String::from_utf8_lossy(&record[..split])) else { continue };
        let patch = &record[split.min(record.len())..];
        let files = diff::parse(patch);
        let Some(file) = files.first() else { continue };
        let name = file.new_path.clone().or_else(|| file.old_path.clone()).unwrap_or_else(|| path.to_string());
        out.push(LineHistoryEntry { diff: diff::to_display(file, &name, diff::fingerprint(patch)), oid, author, time, subject, path: name });
    }
    Ok(out)
}

/// Commits that changed anything under `folder` ("" = the whole repository), newest first,
/// with the files they changed there.
pub fn folder_history(repo: &Path, folder: &str, limit: usize) -> GitResult<Vec<FolderHistoryEntry>> {
    let folder = folder.trim_matches('/');
    if !folder.is_empty() {
        check_path(folder)?;
    }
    let max = format!("--max-count={}", limit.clamp(1, 1_000_000));
    let spec = if folder.is_empty() { ".".to_string() } else { format!("{folder}/") };
    let raw = runner::exec_full(
        repo,
        ["log", "--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s", "--name-only", "--no-renames", &max, "--", &spec],
        &[("GIT_LITERAL_PATHSPECS", "1")],
        None,
    )?;
    if raw.code != 0 {
        return Err(GitError::new(raw.stderr.trim().to_string()));
    }
    let text = String::from_utf8_lossy(&raw.stdout);
    let mut out = Vec::new();
    for record in text.split('\x1e').filter(|r| !r.trim().is_empty()) {
        let mut lines = record.lines();
        // "<oid>\x1f<parents>\x1f<author>...": the parents taken out, the rest as for other logs.
        let Some((oid, rest)) = lines.next().unwrap_or("").split_once('\x1f') else { continue };
        let Some((parents, rest)) = rest.split_once('\x1f') else { continue };
        let Some((oid, author, time, subject)) = header(&format!("{oid}\x1f{rest}")) else { continue };
        let parent = parents.split_whitespace().next().map(str::to_owned);
        let files = lines.map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
        out.push(FolderHistoryEntry { oid, author, time, subject, files, parent });
    }
    Ok(out)
}
