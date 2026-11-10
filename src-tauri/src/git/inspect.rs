//! Read-only inspection: blame, comparing two revisions, raw file contents (image diffs).

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::commit::{changed_files, ChangedFile};
use super::runner::{self, GitError, GitResult};

// ───────────── blame ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub oid: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub summary: String,
    pub previous: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub oid: String,
    /// Line number in the original commit.
    pub orig_line: u32,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub path: String,
    pub rev: Option<String>,
    pub lines: Vec<BlameLine>,
    pub commits: HashMap<String, BlameCommit>,
}

pub fn parse_blame(raw: &str) -> (Vec<BlameLine>, HashMap<String, BlameCommit>) {
    let mut lines = Vec::new();
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    let mut cur: Option<(String, u32, u32)> = None;
    for l in raw.split('\n') {
        if let Some(text) = l.strip_prefix('\t') {
            if let Some((oid, orig, fin)) = cur.take() {
                lines.push(BlameLine { oid, orig_line: orig, line: fin, text: text.trim_end_matches('\r').to_string() });
            }
            continue;
        }
        let mut parts = l.split(' ');
        let first = parts.next().unwrap_or("");
        if matches!(first.len(), 40 | 64) && first.bytes().all(|c| c.is_ascii_hexdigit()) {
            let orig = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let fin = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            commits.entry(first.to_string()).or_insert_with(|| BlameCommit {
                oid: first.to_string(),
                author: String::new(),
                email: String::new(),
                time: 0,
                summary: String::new(),
                previous: None,
            });
            cur = Some((first.to_string(), orig, fin));
            continue;
        }
        let Some((oid, _, _)) = &cur else { continue };
        let Some(c) = commits.get_mut(oid) else { continue };
        let rest = l.split_once(' ').map(|(_, r)| r).unwrap_or("");
        match first {
            "author" => c.author = rest.to_string(),
            "author-mail" => c.email = rest.trim_matches(['<', '>']).to_string(),
            "author-time" => c.time = rest.parse().unwrap_or(0),
            "summary" => c.summary = rest.to_string(),
            "previous" => c.previous = rest.split(' ').next().map(|s| s.to_string()),
            _ => {}
        }
    }
    (lines, commits)
}

/// Line-by-line authorship of a file at `rev` (None = the working tree version).
pub fn blame(repo: &Path, path: &str, rev: Option<&str>) -> GitResult<Blame> {
    let mut args: Vec<String> = vec!["blame".into(), "--porcelain".into(), "-w".into()];
    if let Some(r) = rev {
        args.push(r.to_string());
    }
    args.push("--".into());
    args.push(path.into());
    let raw = runner::run(repo, &args)?;
    let (lines, commits) = parse_blame(&raw);
    Ok(Blame { path: path.to_string(), rev: rev.map(|s| s.to_string()), lines, commits })
}

// ───────────── compare ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeCommit {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
}

pub const BRANCH_COMPARE_PAGE: usize = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCommitComparison {
    pub from_oid: String,
    pub to_oid: String,
    pub from_count: usize,
    pub to_count: usize,
    pub from_only: Vec<RangeCommit>,
    pub to_only: Vec<RangeCommit>,
}

fn range_commits(repo: &Path, from: &str, to: &str, offset: usize, limit: usize) -> GitResult<Vec<RangeCommit>> {
    // Use the same symmetric range as the counts so clock skew cannot make a shared ancestor appear here.
    let log = runner::run(
        repo,
        [
            "log",
            "--no-show-signature",
            "--right-only",
            "--format=%H%x00%an%x00%at%x00%s",
            &format!("--max-count={limit}"),
            &format!("--skip={offset}"),
            &format!("{from}...{to}"),
            "--",
        ],
    )?;
    log.lines()
        .map(|line| {
            let fields: Vec<_> = line.splitn(4, '\0').collect();
            if let [oid, author, time, subject] = fields.as_slice() {
                let time = time.parse().map_err(|_| GitError::new("Git returned an invalid commit date."))?;
                Ok(RangeCommit { oid: (*oid).into(), author: (*author).into(), time, subject: (*subject).into() })
            } else {
                Err(GitError::new("Git returned an invalid commit record."))
            }
        })
        .collect()
}

pub(super) fn branch_tip(repo: &Path, reference: &str) -> GitResult<String> {
    if !(reference.starts_with("refs/heads/") || reference.starts_with("refs/remotes/")) {
        return Err(GitError::new("Choose a local or remote branch."));
    }
    let output = runner::exec(repo, ["show-ref", "--verify", "--hash", "--", reference])?;
    if !output.ok() {
        return Err(GitError::new(format!("Branch '{reference}' no longer exists. Refresh and choose another branch.")));
    }
    Ok(output.text().trim().to_string())
}

pub fn branch_commit_comparison(repo: &Path, from: &str, to: &str) -> GitResult<BranchCommitComparison> {
    super::operations::read(repo, || {
        let from_oid = branch_tip(repo, from)?;
        let to_oid = branch_tip(repo, to)?;
        let counts = runner::run(repo, ["rev-list", "--left-right", "--count", &format!("{from_oid}...{to_oid}"), "--"])?;
        let invalid = || GitError::new("Git returned invalid branch comparison counts.");
        let (from_count, to_count) = counts.trim().split_once('\t').ok_or_else(invalid)?;
        let from_count = from_count.parse().map_err(|_| invalid())?;
        let to_count = to_count.parse().map_err(|_| invalid())?;
        let from_only = if from_count == 0 { Vec::new() } else { range_commits(repo, &to_oid, &from_oid, 0, BRANCH_COMPARE_PAGE)? };
        let to_only = if to_count == 0 { Vec::new() } else { range_commits(repo, &from_oid, &to_oid, 0, BRANCH_COMPARE_PAGE)? };
        Ok(BranchCommitComparison { from_oid, to_oid, from_count, to_count, from_only, to_only })
    })
}

pub fn branch_commit_page(repo: &Path, from: &str, to: &str, offset: usize) -> GitResult<Vec<RangeCommit>> {
    if ![from, to].iter().all(|oid| matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Err(GitError::new("Load the branch comparison before requesting more commits."));
    }
    range_commits(repo, from, to, offset, BRANCH_COMPARE_PAGE)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub from: String,
    pub to: String,
    /// Revision the file diffs start from (merge base for three-dot comparisons).
    pub base: String,
    pub merge_base: Option<String>,
    pub files: Vec<ChangedFile>,
    /// Commits in `to` that are not in `from`.
    pub ahead: Vec<RangeCommit>,
    /// Number of commits in `from` that are not in `to`.
    pub behind: u32,
}

fn resolve(repo: &Path, rev: &str) -> GitResult<String> {
    let out = runner::exec(repo, ["rev-parse", "--verify", "-q", &format!("{rev}^{{commit}}")])?;
    if !out.ok() {
        return Err(GitError::new(format!("'{rev}' is not a commit, branch or tag.")));
    }
    Ok(out.text().trim().to_string())
}

/// Compares two revisions. `three_dot` = what `to` changed since it diverged from `from`.
pub fn compare(repo: &Path, from: &str, to: &str, three_dot: bool) -> GitResult<Comparison> {
    let a = resolve(repo, from)?;
    let b = resolve(repo, to)?;
    let mb = runner::exec(repo, ["merge-base", &a, &b])?;
    let merge_base = if mb.ok() { Some(mb.text().trim().to_string()).filter(|s| !s.is_empty()) } else { None };
    let base = if three_dot { merge_base.clone().unwrap_or_else(|| a.clone()) } else { a.clone() };
    let files = changed_files(repo, &base, &b)?;
    let ahead = range_commits(repo, &a, &b, 0, 1000)?;
    let behind = runner::run(repo, ["rev-list", "--count", &format!("{b}..{a}")])?.trim().parse().unwrap_or(0);
    Ok(Comparison { from: a, to: b, base, merge_base, files, ahead, behind })
}

// ───────────── raw contents ─────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobSpec {
    /// `<rev>:<path>` or `:<path>` (index).
    pub rev: Option<String>,
    /// Path relative to the repository root, read from the working tree.
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobData {
    pub base64: String,
    pub size: usize,
    pub mime: String,
}

const MAX_BLOB: usize = 25 * 1024 * 1024;

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

pub fn blob(repo: &Path, spec: &BlobSpec) -> GitResult<Option<BlobData>> {
    let (data, path) = if let Some(p) = &spec.worktree {
        let full = repo.join(p);
        // Stay inside the repository.
        let canon_root = repo.canonicalize()?;
        match full.canonicalize() {
            Ok(c) if c.starts_with(&canon_root) => {
                let mut data = Vec::new();
                std::fs::File::open(c)?.take(MAX_BLOB as u64 + 1).read_to_end(&mut data)?;
                (data, p.clone())
            }
            Ok(_) => return Err(GitError::new("Path is outside the repository.")),
            Err(_) => return Ok(None),
        }
    } else if let Some(r) = &spec.rev {
        let out = runner::exec_limited(repo, ["cat-file", "blob", r], MAX_BLOB)?;
        if !out.ok() {
            return Ok(None);
        }
        let path = r.split_once(':').map(|(_, p)| p.to_string()).unwrap_or_default();
        (out.stdout, path)
    } else {
        return Ok(None);
    };
    if data.len() > MAX_BLOB {
        return Err(GitError::new("The file is too large to preview."));
    }
    Ok(Some(BlobData { size: data.len(), mime: mime_for(&path).to_string(), base64: base64(&data) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn parses_porcelain_blame() {
        let raw = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2\nauthor Ada\nauthor-mail <ada@x>\nauthor-time 100\nsummary First\nfilename f\n\tline one\n\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2\n\tline two\n\
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1\nauthor Bob\nauthor-mail <bob@x>\nauthor-time 200\nsummary Second\nprevious aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa f\nfilename f\n\tline three\n";
        let (lines, commits) = parse_blame(raw);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1].text, "line two");
        assert_eq!(lines[2].line, 3);
        assert_eq!(commits["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"].author, "Ada");
        assert_eq!(commits["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"].email, "bob@x");
        assert!(commits["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"].previous.is_some());
    }
}
