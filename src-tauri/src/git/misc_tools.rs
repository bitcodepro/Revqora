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
    // Checking out the stash base silently replaces ignored files that the base tracks (Git
    // refuses only for tracked and untracked ones), and checkpoints do not keep ignored files.
    let clashes = ignored_files_in_stash(repo, expected)?;
    if !clashes.is_empty() {
        let shown = clashes.iter().take(10).cloned().collect::<Vec<_>>().join(", ");
        let more = if clashes.len() > 10 { format!(" and {} more", clashes.len() - 10) } else { String::new() };
        return Err(GitError::new(format!(
            "Restoring this stash would overwrite untracked or ignored files that exist here: {shown}{more}. Move or delete them first."
        ))
        .kind("stash-branch-collision"));
    }
    let out = runner::exec(repo, ["stash", "branch", name, &format!("stash@{{{index}}}")])?;
    if !out.ok() {
        return Err(GitError::new(out.text().trim().to_string()));
    }
    Ok(out.text())
}

/// Ignored files on disk that `tree` (a commit) contains: a checkout of it would overwrite them.
fn ignored_files_in_stash(repo: &Path, stash: &str) -> GitResult<Vec<String>> {
    // Every untracked file, ignored or not: the base's ignore rules can differ from the current
    // ones, so a file Git would refuse to overwrite now may be ignored (and overwritten) there.
    let ignored = runner::run_bytes(repo, ["ls-files", "-z", "--others"])?;
    let ignored: Vec<String> = String::from_utf8_lossy(&ignored).split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect();
    if ignored.is_empty() {
        return Ok(Vec::new());
    }
    // Everything `git stash branch` writes: the base commit it checks out (^1), then the
    // stash's staged (^2) and working-tree (the stash itself) versions, and its untracked
    // files (^3, when the stash has them) — a stash can add files its base never had.
    let mut tree: Vec<String> = Vec::new();
    for rev in [format!("{stash}^1"), format!("{stash}^2"), stash.to_string(), format!("{stash}^3")] {
        if !runner::exec(repo, ["rev-parse", "-q", "--verify", "--end-of-options", &format!("{rev}^{{tree}}")])?.ok() {
            continue; // no untracked part
        }
        let raw = runner::run_bytes(repo, ["ls-tree", "-r", "-z", "--name-only", "--end-of-options", &rev])?;
        tree.extend(String::from_utf8_lossy(&raw).split('\0').filter(|p| !p.is_empty()).map(str::to_string));
    }
    tree.sort();
    tree.dedup();
    Ok(checkout_collisions(&tree, &ignored))
}

/// Ignored paths a checkout of `tree` would destroy: the same path, an ignored file inside a
/// folder the tree has as a file (`cache` vs `cache/precious`), or an ignored file where the
/// tree has a folder (`cache` vs `cache/file`).
pub(crate) fn checkout_collisions(tree: &[String], ignored: &[String]) -> Vec<String> {
    use std::collections::HashSet;
    let files: HashSet<&str> = tree.iter().map(String::as_str).collect();
    let mut folders: HashSet<&str> = HashSet::new();
    for path in tree {
        let mut at = path.len();
        while let Some(slash) = path[..at].rfind('/') {
            if !folders.insert(&path[..slash]) {
                break;
            }
            at = slash;
        }
    }
    let mut out: Vec<String> = ignored
        .iter()
        .filter(|path| {
            let p = path.as_str();
            // Same path, or the tree has a folder where this ignored file is.
            if files.contains(p) || folders.contains(p) {
                return true;
            }
            // The tree has a file where one of this ignored file's folders is.
            let mut at = p.len();
            while let Some(slash) = p[..at].rfind('/') {
                if files.contains(&p[..slash]) {
                    return true;
                }
                at = slash;
            }
            false
        })
        .cloned()
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod collision_tests {
    use super::checkout_collisions;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn file_and_folder_collisions_are_found_both_ways() {
        // Same path.
        assert_eq!(checkout_collisions(&v(&["cache"]), &v(&["cache"])), ["cache"]);
        // Tree file `cache`, ignored folder content `cache/precious` (deep too).
        assert_eq!(checkout_collisions(&v(&["cache"]), &v(&["cache/precious", "cache/a/b"])), ["cache/a/b", "cache/precious"]);
        // Tree folder `cache/file`, ignored file `cache`.
        assert_eq!(checkout_collisions(&v(&["cache/file", "src/x"]), &v(&["cache", "src"])), ["cache", "src"]);
        // Similar names that do not overlap.
        assert!(checkout_collisions(&v(&["cache", "a/b"]), &v(&["cache2", "cachex/y", "a/bc", "ab"])).is_empty());
    }
}
