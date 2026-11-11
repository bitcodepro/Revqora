//! Working tree status (`git status --porcelain=v2`).

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::runner::{self, GitError, GitResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageReview {
    branch: Option<String>,
    oid: Option<String>,
    operation: StageOperation,
    files: std::collections::HashMap<String, String>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StageOperation {
    kind: String,
    incoming: Option<String>,
    step: Option<u32>,
    stopped_at: Option<String>,
}

impl StageReview {
    pub fn verify(&self, repo: &Path, paths: &[String]) -> GitResult<()> {
        let observed = status(repo)?;
        let operation = super::repo::op_state(repo, &super::repo::git_dir(repo)?);
        let actual = StageOperation { kind: operation.kind, incoming: operation.incoming, step: operation.step, stopped_at: operation.stopped_at };
        if observed.branch != self.branch || observed.oid != self.oid || actual != self.operation {
            return Err(GitError::new("The branch, HEAD or Git operation changed. Review the stage request again.").kind("stale-operation"));
        }
        let files: std::collections::HashMap<_, _> = observed.files.into_iter().map(|file| (file.path, file.diff_token)).collect();
        if paths.len() != self.files.len() || paths.iter().any(|path| !self.files.get(path).is_some_and(|token| files.get(path) == Some(token))) {
            return Err(GitError::new("A selected file or its staged version changed. Review the stage request again.").kind("stale-operation"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// Display invalidation for this path, separate from the repository-wide mutation guard.
    pub diff_token: String,
    pub path: String,
    pub orig_path: Option<String>,
    /// Index (staged) status letter: '.', 'M', 'A', 'D', 'R', 'C', 'T', 'U'
    pub index: String,
    /// Worktree (unstaged) status letter: '.', 'M', 'A', 'D', 'T', '?', 'U'
    pub worktree: String,
    /// Conflict code like "UU", "AA", "DU" when unmerged.
    pub conflict: Option<String>,
    pub untracked: bool,
    pub submodule: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusSummary {
    /// Optimistic precondition for mutations queued from this displayed state.
    pub state_token: Option<String>,
    /// Attribute/configuration interpretation, independent of ordinary file edits.
    pub diff_context_token: Option<String>,
    pub state_version: u64,
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub conflict_count: u32,
}

pub fn parse(raw: &str) -> StatusSummary {
    let mut s = StatusSummary::default();
    let mut parts = raw.split('\0').peekable();
    while let Some(rec) = parts.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.oid ") {
                if v != "(initial)" {
                    s.oid = Some(v.to_string());
                }
            } else if let Some(v) = h.strip_prefix("branch.head ") {
                if v != "(detached)" {
                    s.branch = Some(v.to_string());
                }
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                s.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                for t in v.split(' ') {
                    if let Some(n) = t.strip_prefix('+') {
                        s.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = t.strip_prefix('-') {
                        s.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let kind = rec.as_bytes()[0];
        match kind {
            b'1' | b'2' => {
                // 1 XY sub mH mI mW hH hI path
                // 2 XY sub mH mI mW hH hI Xscore path  (+ NUL origPath)
                let nfields = if kind == b'1' { 9 } else { 10 };
                let fields: Vec<&str> = rec.splitn(nfields, ' ').collect();
                if fields.len() < nfields {
                    continue;
                }
                let xy = fields[1].as_bytes();
                let path = fields[nfields - 1].to_string();
                let orig = if kind == b'2' { parts.next().map(|p| p.to_string()) } else { None };
                s.files.push(FileStatus {
                    diff_token: format!("{:x}", Sha256::digest(rec.as_bytes())),
                    path,
                    orig_path: orig,
                    index: (xy[0] as char).to_string(),
                    worktree: (xy[1] as char).to_string(),
                    conflict: None,
                    untracked: false,
                    submodule: fields[2].starts_with('S'),
                });
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let fields: Vec<&str> = rec.splitn(11, ' ').collect();
                if fields.len() < 11 {
                    continue;
                }
                s.files.push(FileStatus {
                    diff_token: format!("{:x}", Sha256::digest(rec.as_bytes())),
                    path: fields[10].to_string(),
                    orig_path: None,
                    index: "U".into(),
                    worktree: "U".into(),
                    conflict: Some(fields[1].to_string()),
                    untracked: false,
                    submodule: fields[2].starts_with('S'),
                });
            }
            b'?' => {
                s.files.push(FileStatus {
                    diff_token: format!("{:x}", Sha256::digest(rec.as_bytes())),
                    path: rec[2..].to_string(),
                    orig_path: None,
                    index: ".".into(),
                    worktree: "?".into(),
                    conflict: None,
                    untracked: true,
                    submodule: false,
                });
            }
            _ => {}
        }
    }
    for f in &s.files {
        if f.conflict.is_some() {
            s.conflict_count += 1;
        } else {
            if f.index != "." {
                s.staged_count += 1;
            }
            if f.worktree != "." {
                s.unstaged_count += 1;
            }
        }
    }
    s.files.sort_by_cached_key(|f| f.path.to_lowercase());
    s
}

pub fn status(repo: &Path) -> GitResult<StatusSummary> {
    super::operations::read(repo, || {
        let version = super::operations::next_version(repo);
        let raw = runner::run(repo, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--find-renames"])?;
        let mut status = parse(&raw);
        let tokens = super::operations::state_tokens(repo, &raw, &mut status.files)?;
        status.state_token = Some(tokens.state);
        status.diff_context_token = Some(tokens.diff_context);
        status.state_version = version;
        Ok(status)
    })
}

/// Sidebar-only observation. Do not hash every dirty file or build mutation proofs
/// for dozens of inactive repositories. Callers must never use this as a guard.
pub fn sidebar_status(repo: &Path) -> GitResult<StatusSummary> {
    super::operations::read(repo, || {
        let version = super::operations::next_version(repo);
        let raw = runner::run(repo, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--find-renames"])?;
        Ok(StatusSummary { state_version: version, ..parse(&raw) })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa aaa src/a file.rs\0\
2 R. N... 100644 100644 100644 bbb bbb R100 new.txt\0old.txt\0\
u UU N... 100644 100644 100644 100644 c1 c2 c3 conflict.txt\0\
? untracked dir/x.md\0";
        let s = parse(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!(s.files.len(), 4);
        let a = s.files.iter().find(|f| f.path == "src/a file.rs").unwrap();
        assert_eq!((a.index.as_str(), a.worktree.as_str()), (".", "M"));
        let r = s.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(r.orig_path.as_deref(), Some("old.txt"));
        assert_eq!(r.index, "R");
        let c = s.files.iter().find(|f| f.path == "conflict.txt").unwrap();
        assert_eq!(c.conflict.as_deref(), Some("UU"));
        let u = s.files.iter().find(|f| f.path == "untracked dir/x.md").unwrap();
        assert!(u.untracked);
        assert_eq!((s.staged_count, s.unstaged_count, s.conflict_count), (1, 2, 1));
    }
}
