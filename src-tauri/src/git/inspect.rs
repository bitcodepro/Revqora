//! Read-only inspection: blame, comparing two revisions, raw file contents (image diffs).

use std::collections::HashMap;
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
        if first.len() == 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
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
    let log = runner::run(repo, ["log", "--max-count=1000", "--format=%H%x1f%an%x1f%at%x1f%s", &format!("{a}..{b}")])?;
    let ahead = log
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(4, '\x1f').collect();
            (f.len() == 4).then(|| RangeCommit { oid: f[0].into(), author: f[1].into(), time: f[2].parse().unwrap_or(0), subject: f[3].into() })
        })
        .collect();
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
            Ok(c) if c.starts_with(&canon_root) => (std::fs::read(&c)?, p.clone()),
            Ok(_) => return Err(GitError::new("Path is outside the repository.")),
            Err(_) => return Ok(None),
        }
    } else if let Some(r) = &spec.rev {
        let out = runner::exec(repo, ["cat-file", "blob", r])?;
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
