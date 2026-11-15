//! "Ignore this file / extension / folder": previews and appends one rule to the shared
//! `.gitignore` or the local `info/exclude`, and optionally stops tracking matching files.
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::atomic_file;
use super::runner::{self, GitError, GitResult};

const LITERAL: [(&str, &str); 1] = [("GIT_LITERAL_PATHSPECS", "1")];
/// Tracked files listed in a preview; the count is always exact.
const SHOWN_TRACKED: usize = 200;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IgnorePreview {
    /// The rule that will be appended, exactly as written to the file.
    pub pattern: String,
    /// Repository-relative name of the target file, for display.
    pub file: String,
    /// The target file's text before and after the change (lossy for display only).
    pub before: String,
    pub after: String,
    /// Identifies the file content the preview was made from; apply refuses if it changed.
    pub token: String,
    /// The path is already ignored by some rule (tracked files are still shown).
    pub already_ignored: bool,
    /// Tracked files the rule matches: ignoring does not affect them until they are untracked.
    pub tracked: Vec<String>,
    pub tracked_count: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreResult {
    pub pattern: String,
    pub file: String,
    /// False when a later rule (such as `!name`) still un-ignores the path.
    pub ignored: bool,
    /// Files removed from the index (kept on disk).
    pub untracked: usize,
}

/// Where the rule goes: the shared `.gitignore` at the repository root (committed with the
/// project) or this clone's private `info/exclude`.
fn target(repo: &Path, scope: &str) -> GitResult<(PathBuf, String)> {
    match scope {
        "shared" => Ok((repo.join(".gitignore"), ".gitignore".into())),
        "local" => {
            let rel = runner::run(repo, ["rev-parse", "--git-path", "info/exclude"])?;
            let rel = rel.trim();
            let path = if Path::new(rel).is_absolute() { PathBuf::from(rel) } else { repo.join(rel) };
            Ok((path, ".git/info/exclude".into()))
        }
        _ => Err(GitError::new("Unknown ignore file.").kind("invalid-argument")),
    }
}

/// Escapes a path for a gitignore pattern: wildcards, backslashes, a leading `#`/`!` and
/// trailing spaces would otherwise change its meaning.
fn escape(part: &str) -> String {
    let mut out = String::with_capacity(part.len() + 4);
    for (i, c) in part.chars().enumerate() {
        if matches!(c, '\\' | '*' | '?' | '[') || (i == 0 && matches!(c, '#' | '!')) {
            out.push('\\');
        }
        out.push(c);
    }
    let trailing = out.len() - out.trim_end_matches(' ').len();
    if trailing > 0 {
        out.truncate(out.len() - trailing);
        out.push_str(&"\\ ".repeat(trailing));
    }
    out
}

/// The rule for `path` (a repository-relative file or folder path, `/`-separated).
pub fn pattern_for(path: &str, kind: &str) -> GitResult<String> {
    let path = path.trim_matches('/');
    if path.is_empty() || path.split('/').any(|p| p.is_empty() || p == "." || p == "..") || path.contains('\n') || path.contains('\r') {
        return Err(GitError::new("This path cannot be written as an ignore rule.").kind("invalid-argument"));
    }
    match kind {
        "file" => Ok(format!("/{}", escape(path))),
        "folder" => Ok(format!("/{}/", escape(path))),
        "extension" => {
            let name = path.rsplit('/').next().unwrap_or(path);
            match name.rfind('.') {
                Some(dot) if dot > 0 && dot + 1 < name.len() => Ok(format!("*.{}", escape(&name[dot + 1..]))),
                _ => Err(GitError::new("This file has no extension to ignore.").kind("invalid-argument")),
            }
        }
        _ => Err(GitError::new("Unknown kind of ignore rule.").kind("invalid-argument")),
    }
}

/// What a preview approved: the ignore file's content, and the tracked files the rule matched
/// at the commit then checked out. Apply refuses if either changed.
fn preview_token(file: &[u8], tracked: &[String], head: &str) -> String {
    let mut listing = head.as_bytes().to_vec();
    for path in tracked {
        listing.push(0);
        listing.extend_from_slice(path.as_bytes());
    }
    format!("{}:{}", token(file), token(&listing))
}

fn head(repo: &Path) -> String {
    runner::run(repo, ["rev-parse", "-q", "--verify", "HEAD"]).map(|h| h.trim().to_string()).unwrap_or_default()
}

fn token(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The file's bytes, or none if it does not exist. A symlinked ignore file is refused: the
/// atomic replacement would turn the link into a regular file.
fn read_target(path: &Path) -> GitResult<Vec<u8>> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(GitError::new("The ignore file is a symbolic link. Edit the file it points to instead.").kind("ignore-file-symlink"))
        }
        Ok(meta) if !meta.is_file() => Err(GitError::new("The ignore file is not a regular file.").kind("ignore-file-symlink")),
        Ok(_) => Ok(std::fs::read(path)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

/// The content with `pattern` appended on its own line, keeping the file's line endings.
fn appended(before: &[u8], pattern: &str) -> Vec<u8> {
    let eol: &[u8] = if before.windows(2).any(|w| w == b"\r\n") { b"\r\n" } else { b"\n" };
    let mut after = before.to_vec();
    if !after.is_empty() && !after.ends_with(b"\n") {
        after.extend_from_slice(eol);
    }
    after.extend_from_slice(pattern.as_bytes());
    after.extend_from_slice(eol);
    after
}

/// Tracked files the rule matches (the rule is interpreted from the repository root).
fn tracked_matches(repo: &Path, pattern: &str) -> GitResult<Vec<String>> {
    let raw = runner::run_bytes(repo, ["ls-files", "-z", "--cached", "--ignored", &format!("--exclude={pattern}")])?;
    let raw = super::workspace_files::path_list(&raw)?;
    let mut paths: Vec<String> = raw.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect();
    paths.dedup();
    Ok(paths)
}

fn is_ignored(repo: &Path, path: &str) -> GitResult<bool> {
    // --no-index: answer by the rules alone, also for a tracked path. The path goes through
    // stdin, read verbatim (check-ignore supports no literal-pathspec mode).
    let mut input = path.as_bytes().to_vec();
    input.push(0);
    let out = runner::exec_full(repo, ["check-ignore", "-q", "--no-index", "-z", "--stdin"], &[], Some(&input))?;
    match out.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(GitError::new(out.stderr.trim().to_string())),
    }
}

pub fn preview(repo: &Path, path: &str, kind: &str, scope: &str) -> GitResult<IgnorePreview> {
    let pattern = pattern_for(path, kind)?;
    let (file_path, file) = target(repo, scope)?;
    let before = read_target(&file_path)?;
    let after = appended(&before, &pattern);
    let mut tracked = tracked_matches(repo, &pattern)?;
    let tracked_count = tracked.len();
    let token = preview_token(&before, &tracked, &head(repo));
    tracked.truncate(SHOWN_TRACKED);
    Ok(IgnorePreview {
        already_ignored: is_ignored(repo, path.trim_matches('/'))?,
        token,
        before: String::from_utf8_lossy(&before).into_owned(),
        after: String::from_utf8_lossy(&after).into_owned(),
        pattern,
        file,
        tracked,
        tracked_count,
    })
}

/// Appends the rule previewed with `expected` (the preview token). Refuses if the ignore file
/// changed since, so a concurrent edit is never overwritten. With `untrack`, the matching
/// tracked files leave the index and stay on disk.
pub fn apply(repo: &Path, path: &str, kind: &str, scope: &str, expected: &str, untrack: bool) -> GitResult<IgnoreResult> {
    let pattern = pattern_for(path, kind)?;
    let (file_path, file) = target(repo, scope)?;
    let before = read_target(&file_path)?;
    let (expected_file, expected_tracked) = expected.split_once(':').unwrap_or((expected, ""));
    if token(&before) != expected_file {
        return Err(GitError::new(format!("{file} changed after the preview. Review the rule again.")).kind("ignore-file-changed"));
    }
    // The files to untrack must be exactly the ones the preview listed (another tool may have
    // staged or committed more, or switched branches, since).
    let tracked = tracked_matches(repo, &pattern)?;
    let current = preview_token(&before, &tracked, &head(repo));
    if current.split_once(':').map(|(_, t)| t) != Some(expected_tracked) {
        return Err(GitError::new("The files this rule matches changed after the preview. Review the rule again.").kind("ignore-preview-stale"));
    }
    let parent = file_path.parent().ok_or_else(|| GitError::new("The ignore file has no folder."))?;
    std::fs::create_dir_all(parent)?;
    let parent = std::fs::canonicalize(parent)?;
    let destination = parent.join(file_path.file_name().ok_or_else(|| GitError::new("The ignore file has no name."))?);
    let mut temporary = atomic_file::new_in(&parent)?;
    {
        use std::io::Write;
        temporary.write_all(&appended(&before, &pattern))?;
        temporary.as_file().sync_all()?;
    }
    // Last check right before replacing: the narrowest window for a concurrent writer.
    if token(&read_target(&destination)?) != expected_file {
        return Err(GitError::new(format!("{file} changed after the preview. Review the rule again.")).kind("ignore-file-changed"));
    }
    atomic_file::replace(temporary, &destination)?;
    let mut untracked = 0;
    if untrack {
        for chunk in tracked.chunks(200) {
            let mut args = vec!["rm".to_string(), "--cached".into(), "-q".into(), "--ignore-unmatch".into(), "--".into()];
            args.extend(chunk.iter().cloned());
            runner::run_env(repo, &args, &LITERAL, None)?;
        }
        untracked = tracked.len();
    }
    Ok(IgnoreResult { ignored: is_ignored(repo, path.trim_matches('/'))?, pattern, file, untracked })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_escape_what_gitignore_would_read_as_syntax() {
        assert_eq!(pattern_for("src/main.rs", "file").unwrap(), "/src/main.rs");
        assert_eq!(pattern_for("build/out", "folder").unwrap(), "/build/out/");
        assert_eq!(pattern_for("docs/a.min.js", "extension").unwrap(), "*.js");
        assert_eq!(pattern_for("#notes/!x[1]*?.txt", "file").unwrap(), "/\\#notes/!x\\[1]\\*\\?.txt");
        assert_eq!(pattern_for("dir/!keep", "file").unwrap(), "/dir/!keep");
        assert_eq!(pattern_for("trailing  ", "file").unwrap(), "/trailing\\ \\ ");
        assert!(pattern_for("Makefile", "extension").is_err());
        assert!(pattern_for(".env", "extension").is_err());
        assert!(pattern_for("a/../b", "file").is_err());
        assert!(pattern_for("a\nb", "file").is_err());
    }

    #[test]
    fn appending_keeps_line_endings_and_adds_a_missing_newline() {
        assert_eq!(appended(b"", "/a"), b"/a\n");
        assert_eq!(appended(b"x", "/a"), b"x\n/a\n");
        assert_eq!(appended(b"x\r\ny\r\n", "/a"), b"x\r\ny\r\n/a\r\n");
    }
}
