//! Submodules, worktrees, bisect, Git LFS and commit signing.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::repo;
use super::runner::{self, GitError, GitResult};

// ───────────── submodules ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub path: String,
    pub url: Option<String>,
    /// Commit recorded in the superproject (or checked out when modified).
    pub oid: String,
    /// "ok" | "uninitialized" | "modified" | "conflict"
    pub state: String,
    pub describe: Option<String>,
}

pub fn parse_submodule_status(raw: &str) -> Vec<(String, String, String, Option<String>)> {
    raw.lines()
        .filter(|l| l.len() > 41)
        .map(|l| {
            let state = match l.as_bytes()[0] {
                b'-' => "uninitialized",
                b'+' => "modified",
                b'U' => "conflict",
                _ => "ok",
            };
            let rest = &l[1..];
            let (oid, tail) = rest.split_once(' ').unwrap_or((rest, ""));
            let (path, describe) = match tail.rfind(" (") {
                Some(i) if tail.ends_with(')') => (tail[..i].to_string(), Some(tail[i + 2..tail.len() - 1].to_string())),
                _ => (tail.to_string(), None),
            };
            (state.to_string(), oid.to_string(), path, describe)
        })
        .collect()
}

pub fn submodules(repo: &Path) -> GitResult<Vec<Submodule>> {
    if !repo.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let out = runner::exec(repo, ["submodule", "status", "--recursive"])?;
    let urls = runner::exec(repo, ["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.(path|url)$"])?.text();
    // Map submodule names to paths and urls.
    let mut by_name: std::collections::HashMap<String, (Option<String>, Option<String>)> = Default::default();
    for l in urls.lines() {
        let Some((key, val)) = l.split_once(' ') else { continue };
        let key = key.trim_start_matches("submodule.");
        if let Some(name) = key.strip_suffix(".path") {
            by_name.entry(name.to_string()).or_default().0 = Some(val.to_string());
        } else if let Some(name) = key.strip_suffix(".url") {
            by_name.entry(name.to_string()).or_default().1 = Some(val.to_string());
        }
    }
    Ok(parse_submodule_status(&out.text())
        .into_iter()
        .map(|(state, oid, path, describe)| {
            let url = by_name.values().find(|(p, _)| p.as_deref() == Some(path.as_str())).and_then(|(_, u)| u.clone());
            Submodule { path, url, oid, state, describe }
        })
        .collect())
}

pub fn submodule_update(repo: &Path, paths: &[String], on_line: impl FnMut(&str)) -> GitResult<String> {
    let mut args: Vec<String> = vec!["submodule".into(), "update".into(), "--init".into(), "--recursive".into(), "--progress".into()];
    if !paths.is_empty() {
        args.push("--".into());
        args.extend(paths.iter().cloned());
    }
    runner::run_streaming(repo, &args, &[], on_line)
}

pub fn submodule_add(repo: &Path, url: &str, path: &str, on_line: impl FnMut(&str)) -> GitResult<String> {
    runner::run_streaming(repo, &["submodule".into(), "add".into(), "--progress".into(), url.trim().into(), path.trim().into()], &[], on_line)
}

pub fn submodule_sync(repo: &Path) -> GitResult<()> {
    runner::run(repo, ["submodule", "sync", "--recursive"])?;
    Ok(())
}

// ───────────── worktrees ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
    pub lock_reason: Option<String>,
    pub prune_reason: Option<String>,
    pub is_current: bool,
}

pub fn parse_worktrees(raw: &str, current: &Path) -> Vec<Worktree> {
    let norm = |p: &Path| {
        let path = repo::normalize(p.to_path_buf());
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        #[cfg(windows)]
        let path = PathBuf::from(path.to_string_lossy().to_lowercase());
        path
    };
    let cur = norm(current);
    // NUL porcelain preserves quotes, backslashes, Unicode and line breaks.
    // Accept the older text form too for existing callers of this parser.
    let separator = if raw.contains('\0') { '\0' } else { '\n' };
    raw.split(&format!("{separator}{separator}"))
        .filter(|b| !b.trim().is_empty())
        .filter_map(|block| {
            let mut w = Worktree {
                path: String::new(),
                head: None,
                branch: None,
                detached: false,
                bare: false,
                locked: false,
                prunable: false,
                lock_reason: None,
                prune_reason: None,
                is_current: false,
            };
            for l in block.split(separator) {
                if let Some(p) = l.strip_prefix("worktree ") {
                    w.path = repo::normalize(PathBuf::from(p)).to_string_lossy().into_owned();
                    w.is_current = norm(Path::new(p)) == cur;
                } else if let Some(h) = l.strip_prefix("HEAD ") {
                    w.head = Some(h.to_string());
                } else if let Some(b) = l.strip_prefix("branch ") {
                    w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                } else if l == "detached" {
                    w.detached = true;
                } else if l == "bare" {
                    w.bare = true;
                } else if l.starts_with("locked") {
                    w.locked = true;
                    w.lock_reason = l.strip_prefix("locked ").map(str::to_owned);
                } else if l.starts_with("prunable") {
                    w.prunable = true;
                    w.prune_reason = l.strip_prefix("prunable ").map(str::to_owned);
                }
            }
            (!w.path.is_empty()).then_some(w)
        })
        .collect()
}

pub fn worktrees(repo: &Path) -> GitResult<Vec<Worktree>> {
    let raw = runner::run(repo, ["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktrees(&raw, repo))
}

/// Adds a worktree at `path`: checks out `branch`, or creates `new_branch` from `start`.
pub fn worktree_add(repo: &Path, path: &str, branch: Option<&str>, new_branch: Option<&str>, start: Option<&str>) -> GitResult<()> {
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if let Some(nb) = new_branch.filter(|s| !s.trim().is_empty()) {
        args.push("-b".into());
        args.push(nb.trim().into());
        args.push(path.into());
        if let Some(s) = start {
            args.push(s.into());
        }
    } else {
        args.push(path.into());
        if let Some(b) = branch {
            args.push(b.into());
        }
    }
    runner::run(repo, &args)?;
    Ok(())
}

pub fn worktree_remove(repo: &Path, path: &str, force: bool) -> GitResult<()> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    let out = runner::exec(repo, &args)?;
    if !out.ok() {
        let e = runner::to_error("git worktree remove", &out);
        if out.stderr.contains("modified or untracked") || out.stderr.contains("--force") {
            return Err(e.kind("dirty-worktree"));
        }
        return Err(e);
    }
    Ok(())
}

pub fn worktree_lock(repo: &Path, path: &str, lock: bool) -> GitResult<()> {
    runner::run(repo, ["worktree", if lock { "lock" } else { "unlock" }, path])?;
    Ok(())
}

pub fn worktree_prune(repo: &Path) -> GitResult<()> {
    runner::run(repo, ["worktree", "prune"])?;
    Ok(())
}

// ───────────── bisect ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStatus {
    pub active: bool,
    pub good: Vec<String>,
    pub bad: Option<String>,
    pub current: Option<String>,
    /// Latest message from git ("Bisecting: 3 revisions left…" or "… is the first bad commit").
    pub message: String,
    pub remaining: Option<u32>,
    pub steps: Option<u32>,
    pub first_bad: Option<String>,
}

fn bisect_note(repo: &Path) -> GitResult<PathBuf> {
    let dir = super::storage::dir(repo)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("bisect-last.txt"))
}

pub fn parse_bisect_message(text: &str) -> (Option<u32>, Option<u32>, Option<String>) {
    let mut remaining = None;
    let mut steps = None;
    let mut first_bad = None;
    for l in text.lines() {
        if let Some(rest) = l.strip_prefix("Bisecting: ") {
            remaining = rest.split_whitespace().next().and_then(|n| n.parse().ok());
            if let Some(i) = rest.find("(roughly ") {
                steps = rest[i + 9..].split_whitespace().next().and_then(|n| n.parse().ok());
            }
        }
        if let Some(sha) = l.strip_suffix(" is the first bad commit").or_else(|| l.strip_suffix(" is the first 'bad' commit")) {
            first_bad = Some(sha.trim().to_string());
        }
    }
    (remaining, steps, first_bad)
}

pub fn bisect_status(repo: &Path) -> GitResult<BisectStatus> {
    let gd = repo::git_dir(repo)?;
    let active = gd.join("BISECT_LOG").exists();
    let refs = runner::run(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/bisect"]).unwrap_or_default();
    let mut good = Vec::new();
    let mut bad = None;
    for l in refs.lines() {
        let Some((r, oid)) = l.split_once(' ') else { continue };
        if r == "refs/bisect/bad" {
            bad = Some(oid.to_string());
        } else if r.starts_with("refs/bisect/good") {
            good.push(oid.to_string());
        }
    }
    let message = if active { std::fs::read_to_string(bisect_note(repo)?).unwrap_or_default() } else { String::new() };
    let (remaining, steps, first_bad) = parse_bisect_message(&message);
    let current = runner::run(repo, ["rev-parse", "-q", "--verify", "HEAD"]).ok().map(|s| s.trim().to_string());
    Ok(BisectStatus { active, good, bad, current, message: message.trim().to_string(), remaining, steps, first_bad })
}

fn bisect_run(repo: &Path, args: &[&str]) -> GitResult<BisectStatus> {
    let out = runner::exec(repo, args)?;
    let text = format!("{}{}", out.text(), out.stderr);
    if !out.ok() {
        return Err(runner::to_error("git bisect", &out));
    }
    std::fs::write(bisect_note(repo)?, &text)?;
    bisect_status(repo)
}

/// Starts bisecting between a known bad and a known good commit.
pub fn bisect_start(repo: &Path, bad: &str, good: &str) -> GitResult<BisectStatus> {
    bisect_run(repo, &["bisect", "start", bad, good])
}

/// Marks a commit (default: the checked-out one) as "good", "bad" or "skip".
pub fn bisect_mark(repo: &Path, verdict: &str, rev: Option<&str>) -> GitResult<BisectStatus> {
    let v = match verdict {
        "good" | "bad" | "skip" => verdict,
        _ => return Err(GitError::new("Verdict must be good, bad or skip.")),
    };
    let mut args = vec!["bisect", v];
    if let Some(r) = rev {
        args.push(r);
    }
    bisect_run(repo, &args)
}

pub fn bisect_reset(repo: &Path) -> GitResult<()> {
    runner::run(repo, ["bisect", "reset"])?;
    if let Ok(p) = bisect_note(repo) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

// ───────────── Git LFS ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    pub oid: String,
    /// True when the real content is in the working tree (not just a pointer).
    pub downloaded: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    pub available: bool,
    pub version: Option<String>,
    /// Repository has LFS filters in .gitattributes.
    pub used: bool,
    pub patterns: Vec<String>,
}

pub fn repo_uses_lfs(repo: &Path) -> bool {
    std::fs::read_to_string(repo.join(".gitattributes")).map(|s| s.contains("filter=lfs")).unwrap_or(false)
}

pub fn lfs_status(repo: &Path) -> GitResult<LfsStatus> {
    let used = repo_uses_lfs(repo);
    let ver = runner::exec(repo, ["lfs", "version"])?;
    let available = ver.ok();
    let mut patterns = Vec::new();
    if let Ok(attrs) = std::fs::read_to_string(repo.join(".gitattributes")) {
        for l in attrs.lines() {
            if l.contains("filter=lfs") {
                if let Some(p) = l.split_whitespace().next() {
                    patterns.push(p.to_string());
                }
            }
        }
    }
    Ok(LfsStatus { available, version: available.then(|| ver.text().trim().to_string()), used, patterns })
}

pub fn lfs_files(repo: &Path) -> GitResult<Vec<LfsFile>> {
    let raw = runner::run(repo, ["lfs", "ls-files"])?;
    Ok(raw
        .lines()
        .filter_map(|l| {
            // "<oid> <*|-> <path>"
            let mut it = l.splitn(3, ' ');
            let oid = it.next()?.to_string();
            let mark = it.next()?;
            let path = it.next()?.to_string();
            Some(LfsFile { oid, downloaded: mark == "*", path })
        })
        .collect())
}

pub fn lfs_track(repo: &Path, pattern: &str, track: bool) -> GitResult<()> {
    runner::run(repo, ["lfs", if track { "track" } else { "untrack" }, pattern.trim()])?;
    Ok(())
}

pub fn lfs_run(repo: &Path, action: &str, on_line: impl FnMut(&str)) -> GitResult<String> {
    let cmd = match action {
        "pull" | "fetch" | "prune" | "install" => action,
        _ => return Err(GitError::new("Unknown LFS action.")),
    };
    let mut args = vec!["lfs".to_string(), cmd.to_string()];
    if cmd == "install" {
        args.push("--local".into());
    }
    runner::run_streaming(repo, &args, &[], on_line)
}

// ───────────── signing ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningConfig {
    pub sign_commits: bool,
    pub sign_tags: bool,
    /// "openpgp" | "ssh" | "x509"
    pub format: String,
    pub key: Option<String>,
}

pub fn signing_config(repo: &Path) -> SigningConfig {
    let get = |k: &str| repo::config_get(repo, k);
    SigningConfig {
        sign_commits: get("commit.gpgsign").map(|v| v == "true").unwrap_or(false),
        sign_tags: get("tag.gpgsign").map(|v| v == "true").unwrap_or(false),
        format: get("gpg.format").unwrap_or_else(|| "openpgp".into()),
        key: get("user.signingkey"),
    }
}

pub fn set_signing(repo: &Path, cfg: &SigningInput, global: bool) -> GitResult<()> {
    let scope = if global { "--global" } else { "--local" };
    let set = |k: &str, v: &str| runner::run(repo, ["config", scope, k, v]).map(|_| ());
    let unset = |k: &str| {
        let _ = runner::exec(repo, ["config", scope, "--unset", k]);
    };
    set("commit.gpgsign", if cfg.sign_commits { "true" } else { "false" })?;
    set("tag.gpgsign", if cfg.sign_tags { "true" } else { "false" })?;
    set("gpg.format", &cfg.format)?;
    match cfg.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => set("user.signingkey", k)?,
        None => unset("user.signingkey"),
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningInput {
    pub sign_commits: bool,
    pub sign_tags: bool,
    pub format: String,
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    /// git's %G?: G good, B bad, U good/unknown validity, X expired, Y expired key, R revoked, E cannot check, N none
    pub status: String,
    pub signer: String,
    pub key: String,
    pub fingerprint: String,
}

pub fn signature(repo: &Path, oid: &str) -> GitResult<Signature> {
    let out = runner::exec(repo, ["log", "-1", "--format=%G?%x1f%GS%x1f%GK%x1f%GF", oid])?;
    let text = out.text();
    let f: Vec<&str> = text.trim_end().splitn(4, '\x1f').collect();
    let get = |i: usize| f.get(i).map(|s| s.trim().to_string()).unwrap_or_default();
    Ok(Signature { status: if get(0).is_empty() { "N".into() } else { get(0) }, signer: get(1), key: get(2), fingerprint: get(3) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_paths_preserve_porcelain_delimiters_and_resolve_directory_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("current workspace");
        std::fs::create_dir(&current).unwrap();
        let unusual = repo::normalize(PathBuf::from("/other/workspace\nwith\tquotes\"and\\slashes"));
        let raw = format!(
            "worktree {}\0HEAD abc\0branch refs/heads/main\0\0worktree {}\0HEAD def\0branch refs/heads/other\0locked reason\0\0",
            current.display(),
            unusual.display()
        );
        let parsed = parse_worktrees(&raw, &current.join("."));
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].is_current);
        assert!(!parsed[1].is_current);
        assert_eq!(parsed[1].path, unusual.to_string_lossy());
        assert_eq!(parsed[1].branch.as_deref(), Some("other"));
        assert!(parsed[1].locked);
        #[cfg(unix)]
        {
            let alias = temp.path().join("alias");
            std::os::unix::fs::symlink(&current, &alias).unwrap();
            assert!(parse_worktrees(&raw, &alias)[0].is_current);
            let case_variant = "worktree /missing/Case\0HEAD abc\0\0worktree /missing/case\0HEAD def\0\0";
            let parsed = parse_worktrees(case_variant, Path::new("/missing/Case"));
            assert!(parsed[0].is_current);
            assert!(!parsed[1].is_current);
        }
    }

    #[test]
    fn parses_submodule_status() {
        let raw = " 1234567890123456789012345678901234567890 libs/a (v1.0)\n-abcdefabcdefabcdefabcdefabcdefabcdefabcd libs/b\n+1111111111111111111111111111111111111111 deep/c (heads/main)\n";
        let s = parse_submodule_status(raw);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].0, "ok");
        assert_eq!(s[0].2, "libs/a");
        assert_eq!(s[0].3.as_deref(), Some("v1.0"));
        assert_eq!(s[1].0, "uninitialized");
        assert_eq!(s[2].0, "modified");
    }

    #[test]
    fn parses_bisect_messages() {
        let (r, st, fb) = parse_bisect_message("Bisecting: 6 revisions left to test after this (roughly 3 steps)\n[abc] msg");
        assert_eq!((r, st, fb), (Some(6), Some(3), None));
        let (_, _, fb) = parse_bisect_message("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef is the first bad commit\ncommit …");
        assert_eq!(fb.as_deref(), Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"));
        let (_, _, fb) = parse_bisect_message("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef is the first 'bad' commit\n");
        assert_eq!(fb.as_deref(), Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"));
    }
}
