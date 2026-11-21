//! Commit details, file lists and file history.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::runner::{self, GitError, GitResult};

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
    /// `None` = not checked by this read. Ask `remote_containment` before relying on it.
    pub contained_in_remote: Option<bool>,
}

/// Lists files changed between two trees with line statistics.
pub fn changed_files(repo: &Path, from: &str, to: &str) -> GitResult<Vec<ChangedFile>> {
    // One tree comparison supplies both status/renames and line counts. Keeping
    // these in one process also avoids resolving mutable revisions twice.
    let raw = runner::run(repo, ["diff", "--raw", "--numstat", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", from, to, "--"])?;
    parse_changed_files(&raw)
}

fn parse_changed_files(raw: &str) -> GitResult<Vec<ChangedFile>> {
    let mut records = raw.split('\0').peekable();
    let mut files = Vec::new();
    let mut by_path = HashMap::new();
    while records.peek().is_some_and(|r| r.starts_with(':')) {
        let header = records.next().unwrap();
        let code = header.split_whitespace().last().and_then(|s| s.chars().next()).unwrap_or('M').to_string();
        let first = records.next().unwrap_or_default();
        let (path, old_path) =
            if code == "R" || code == "C" { (records.next().unwrap_or_default().to_owned(), Some(first.to_owned())) } else { (first.to_owned(), None) };
        by_path.insert(path.clone(), files.len());
        files.push(ChangedFile { path, old_path, status: code, additions: None, deletions: None, binary: false });
    }
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, '\t');
        let add = fields.next().unwrap_or("-");
        let del = fields.next().unwrap_or("-");
        let mut path = fields.next().unwrap_or_default();
        if path.is_empty() {
            records.next(); // renamed source path
            path = records.next().unwrap_or_default();
        }
        if let Some(&index) = by_path.get(path) {
            let f = &mut files[index];
            f.binary = add == "-";
            f.additions = add.parse().ok();
            f.deletions = del.parse().ok();
        }
    }
    Ok(files)
}

pub fn verify_commit_oid(repo: &Path, oid: &str) -> GitResult<()> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("Supply the full commit hash.").kind("invalid-commit"));
    }
    let out = runner::exec(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{oid}^{{commit}}")])?;
    match out.code {
        0 if out.text().trim().eq_ignore_ascii_case(oid) => Ok(()),
        0 | 1 => Err(GitError::new("No commit with that hash was found in this repository.").kind("commit-not-found")),
        _ => Err(runner::to_error("git rev-parse", &out)),
    }
}

/// Signature check result per commit (`%G?`: G good, B bad, U good but unknown validity,
/// X/Y expired signature/key, R revoked key, E cannot be checked, N not signed). Batched for
/// the visible History rows; at most 200 commits per call.
pub fn signature_status(repo: &Path, oids: &[String]) -> GitResult<HashMap<String, String>> {
    let mut args: Vec<String> = vec!["log".into(), "--no-walk=unsorted".into(), "--format=%H %G?".into()];
    for oid in oids.iter().take(200) {
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(GitError::new("Supply full commit hashes.").kind("invalid-commit"));
        }
        args.push(oid.clone());
    }
    if args.len() == 3 {
        return Ok(HashMap::new());
    }
    args.push("--".into());
    let raw = runner::run(repo, &args)?;
    Ok(raw.lines().filter_map(|l| l.split_once(' ').map(|(oid, status)| (oid.to_string(), status.trim().to_string()))).collect())
}

/// Whether any remote-tracking branch contains the commit. Walks history from every
/// remote tip, so it is read separately from the commit header and file list.
pub fn remote_containment(repo: &Path, oid: &str) -> GitResult<bool> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new("Supply the full commit hash.").kind("invalid-commit"));
    }
    runner::run(repo, ["for-each-ref", "--count=1", &format!("--contains={oid}"), "--format=%(refname)", "refs/remotes"]).map(|s| !s.trim().is_empty())
}

/// Commit header, file list and remote containment in one answer.
pub fn details(repo: &Path, oid: &str) -> GitResult<CommitDetails> {
    let mut details = header(repo, oid)?;
    details.contained_in_remote = Some(remote_containment(repo, &details.oid).unwrap_or(false));
    Ok(details)
}

/// Commit header and file list. Remote containment stays unknown (`None`).
pub fn header(repo: &Path, oid: &str) -> GitResult<CommitDetails> {
    // One Git process for the header and the changed files: starting Git is the main cost of a
    // preview on Windows. The diff is against the first parent (`-m --first-parent`, also for
    // merges, as before) or the empty tree for a root commit (`--root`, whatever log.showRoot
    // says). `--end-of-options`: a value such as `--output=<file>` must never be read as an option.
    let raw = runner::run(
        repo,
        [
            "show",
            "--no-show-signature",
            "--no-notes",
            "--no-color",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B",
            "-z",
            "--raw",
            "--numstat",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--root",
            "-m",
            "--first-parent",
            "--end-of-options",
            oid,
        ],
    )?;
    // A commit message cannot contain NUL, so the first NUL ends the header.
    let (head, changes) = raw.split_once('\0').unwrap_or((raw.as_str(), ""));
    let files = parse_changed_files(changes.trim_start_matches('\n'))?;
    let f: Vec<&str> = head.splitn(9, '\x1f').collect();
    let parents: Vec<String> = f.get(1).unwrap_or(&"").split_whitespace().map(|s| s.to_string()).collect();
    let message = f.get(8).unwrap_or(&"").trim_end().to_string();
    let (subject, body) = match message.split_once('\n') {
        Some((s, b)) => (s.trim().to_string(), b.trim_start_matches(['\n', '\r']).to_string()),
        None => (message.clone(), String::new()),
    };
    let base = parents.first().cloned();
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
        contained_in_remote: None,
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
    /// The first parent, which the commit's diff is shown against (none for a root commit).
    pub parent: Option<String>,
}

pub fn file_history(repo: &Path, path: &str, limit: usize) -> GitResult<Vec<FileHistoryEntry>> {
    let raw = runner::run(repo, ["log", "--follow", &format!("--max-count={limit}"), "--name-only", "--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s", "--", path])?;
    let mut out = Vec::new();
    for rec in raw.split('\x1e') {
        let rec = rec.trim();
        if rec.is_empty() {
            continue;
        }
        let mut lines = rec.lines();
        let head = lines.next().unwrap_or("");
        let f: Vec<&str> = head.splitn(5, '\x1f').collect();
        if f.len() < 5 {
            continue;
        }
        let p = lines.find(|l| !l.trim().is_empty()).unwrap_or(path).to_string();
        out.push(FileHistoryEntry {
            oid: f[0].to_string(),
            parent: f[1].split_whitespace().next().map(str::to_owned),
            author: f[2].to_string(),
            time: f[3].parse().unwrap_or(0),
            subject: f[4].to_string(),
            path: p,
        });
    }
    Ok(out)
}

/// Contents of a file at a revision ("" = index stage 0, ":2" etc. allowed via `spec`).
pub fn blob_text(repo: &Path, spec: &str) -> GitResult<Option<String>> {
    let Some(bytes) = super::inspect::revision_blob(repo, spec, 25 * 1024 * 1024)? else { return Ok(None) };
    super::text_encoding::decode(&bytes, None)?
        .map(|text| Some(text.content))
        .ok_or_else(|| GitError::new("No readable text is available for this file.").kind("binary-file"))
}

#[cfg(test)]
mod tests {
    use super::{changed_files, header, parse_changed_files};
    use crate::git::{diff::empty_tree, runner};
    use std::path::Path;

    fn git(repo: &Path, args: &[&str]) -> String {
        runner::run(repo, args).unwrap().trim().to_owned()
    }

    /// The single-process header must give what the separate `show` + `diff` gave before.
    #[test]
    fn one_process_header_matches_separate_header_and_diff_for_every_commit_shape() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.name", "Tester"],
            &["config", "user.email", "tester@example.com"],
            &["config", "commit.gpgsign", "false"],
            &["config", "core.autocrlf", "false"],
            &["config", "log.showRoot", "false"],
        ] {
            git(repo, args);
        }
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("move.txt"), "a file that will be renamed\nwith enough content\nto be found\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "Root commit\n\nWith a body: ünïcödé, tabs\tand a trailing line\n"]);
        git(repo, &["checkout", "-qb", "side"]);
        std::fs::write(repo.join("side.txt"), "side\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "Side work"]);
        git(repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        git(repo, &["mv", "move.txt", "moved.txt"]);
        std::fs::write(repo.join("image.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "Edit, rename and binary"]);
        git(repo, &["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
        git(repo, &["commit", "-q", "--allow-empty", "-m", "Empty commit"]);

        for (rev, files) in [("HEAD~3", 2), ("HEAD~2", 3), ("HEAD~1", 1), ("HEAD", 0)] {
            let oid = git(repo, &["rev-parse", rev]);
            let details = header(repo, &oid).unwrap();
            let base = details.parents.first().cloned().unwrap_or_else(|| empty_tree(repo).unwrap());
            let expected = changed_files(repo, &base, &oid).unwrap();
            let shape = |files: &[super::ChangedFile]| {
                files.iter().map(|f| (f.path.clone(), f.old_path.clone(), f.status.clone(), f.additions, f.deletions, f.binary)).collect::<Vec<_>>()
            };
            assert_eq!(shape(&details.files), shape(&expected), "{rev}");
            assert_eq!(details.files.len(), files, "{rev}");
            assert_eq!(details.oid, oid);
            assert_eq!(details.diff_base, details.parents.first().cloned());
            assert_eq!((details.author.as_str(), details.author_email.as_str()), ("Tester", "tester@example.com"));
        }
        let root = header(repo, &git(repo, &["rev-parse", "HEAD~3"])).unwrap();
        assert_eq!(root.subject, "Root commit");
        assert_eq!(root.body, "With a body: ünïcödé, tabs\tand a trailing line");
        assert!(root.parents.is_empty() && root.diff_base.is_none());
        let edited = header(repo, &git(repo, &["rev-parse", "HEAD~2"])).unwrap();
        let renamed = edited.files.iter().find(|f| f.path == "moved.txt").unwrap();
        assert_eq!((renamed.status.as_str(), renamed.old_path.as_deref()), ("R", Some("move.txt")));
        assert!(edited.files.iter().any(|f| f.path == "image.bin" && f.binary));
        assert_eq!(edited.files.iter().find(|f| f.path == "a.txt").map(|f| (f.additions, f.deletions)), Some((Some(2), Some(1))));
        let merge = header(repo, &git(repo, &["rev-parse", "HEAD~1"])).unwrap();
        assert_eq!(merge.parents.len(), 2);
        assert_eq!(merge.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["side.txt"], "a merge lists its changes against the first parent");
    }

    #[test]
    fn statistics_match_paths_even_with_reversed_order_and_many_entries() {
        let mut raw = String::new();
        for i in 0..5000 {
            raw.push_str(&format!(":100644 100644 a b M\0file-{i}\0"));
        }
        for i in (0..5000).rev() {
            raw.push_str(&format!("{i}\t1\tfile-{i}\0"));
        }
        let files = parse_changed_files(&raw).unwrap();
        assert_eq!(files.len(), 5000);
        for (i, file) in files.iter().enumerate() {
            assert_eq!(file.path, format!("file-{i}"));
            assert_eq!(file.additions, Some(i as u32));
            assert_eq!(file.deletions, Some(1));
        }
    }

    /// File and Folder History show each commit against its real first parent, as Commit
    /// details do: not the previous commit that touched the path.
    #[test]
    fn file_and_folder_history_give_each_commit_its_real_first_parent() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.name", "Tester"],
            &["config", "user.email", "tester@example.com"],
            &["config", "commit.gpgsign", "false"],
        ] {
            git(repo, args);
        }
        std::fs::create_dir(repo.join("dir")).unwrap();
        std::fs::write(repo.join("dir/f.txt"), "one\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "Add f"]);
        std::fs::write(repo.join("other.txt"), "other\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "Elsewhere"]);
        std::fs::write(repo.join("dir/f.txt"), "two\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "Edit f"]);
        let (first, between, last) = (git(repo, &["rev-parse", "HEAD~2"]), git(repo, &["rev-parse", "HEAD~1"]), git(repo, &["rev-parse", "HEAD"]));
        let files = super::file_history(repo, "dir/f.txt", 10).unwrap();
        assert_eq!(files.iter().map(|e| (e.oid.clone(), e.parent.clone())).collect::<Vec<_>>(), [(last.clone(), Some(between.clone())), (first.clone(), None)]);
        let folder = crate::git::line_history::folder_history(repo, "dir", 10).unwrap();
        assert_eq!(
            folder.iter().map(|e| (e.oid.clone(), e.parent.clone(), e.files.clone())).collect::<Vec<_>>(),
            [(last, Some(between), vec!["dir/f.txt".to_owned()]), (first, None, vec!["dir/f.txt".to_owned()])]
        );
        assert_eq!(folder[0].subject, "Edit f");
    }
}
