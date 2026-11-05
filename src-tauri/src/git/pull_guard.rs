//! Read-only preflight for trees that Pull can visit, beyond its final parent tree.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use super::runner::{self, GitError, GitResult};
use super::{ops, workspace_files};

fn uncertain(message: impl Into<String>) -> GitError {
    GitError::new(message).kind("submodule-preflight")
}

/// --raw -z --no-renames emits a metadata record followed by exactly one path.
/// Include deletions: a local add/remove pair can erase a recreated ignored file
/// while rebase checks out intermediate local trees, despite identical endpoints.
fn replay_paths(raw: &[u8]) -> GitResult<(Vec<u8>, bool)> {
    let mut records = workspace_files::path_list(raw)?.split('\0');
    let mut paths = Vec::new();
    let mut gitlinks = false;
    while let Some(header) = records.next() {
        let header = header.trim_start_matches('\n');
        if header.is_empty() {
            continue;
        }
        let fields: Vec<_> = header.strip_prefix(':').unwrap_or("").split_whitespace().collect();
        if fields.len() != 5 || !matches!(fields[4], "A" | "D" | "M" | "T") {
            return Err(uncertain("Cannot safely inspect the commits to replay. No working files were changed."));
        }
        let path = records.next().filter(|path| !path.is_empty()).ok_or_else(|| uncertain("Incomplete path in rebase inspection."))?;
        gitlinks |= fields[0] == "160000" || fields[1] == "160000";
        paths.extend_from_slice(path.as_bytes());
        paths.push(0);
    }
    Ok((paths, gitlinks))
}

pub(super) fn replayed_paths(repo: &Path, upstream: &str, recursive: bool) -> GitResult<()> {
    let raw = runner::run_bytes(
        repo,
        [
            "log",
            "--format=",
            "--raw",
            "-z",
            "--no-abbrev",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-show-signature",
            "--no-decorate",
            "-m",
            "--root",
            &format!("{upstream}..HEAD"),
            "--",
        ],
    )?;
    let (paths, gitlinks) = replay_paths(&raw)?;
    if recursive && gitlinks {
        return Err(uncertain(
            "Cannot rebase with locally recorded submodule modifications while recursive updates are enabled. No working files were changed.",
        ));
    }
    ops::guard_untracked_paths(repo, &paths)
}

fn gitlinks(raw: &[u8], index: bool) -> GitResult<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    for record in workspace_files::path_list(raw)?.split('\0').filter(|record| !record.is_empty()) {
        let (header, path) = record.split_once('\t').ok_or_else(|| uncertain("Incomplete submodule tree inspection."))?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 3 || index && fields[2] != "0" {
            return Err(uncertain("An unresolved index prevents safe recursive Pull. Resolve it before retrying."));
        }
        if fields[0] == "160000" {
            let oid = if index { fields[1] } else { fields[2] };
            if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) || path.is_empty() {
                return Err(uncertain("Invalid submodule commit or path in tree inspection."));
            }
            result.insert(path.to_owned(), oid.to_owned());
        }
    }
    Ok(result)
}

fn in_module(mut error: GitError, prefix: &str) -> GitError {
    if error.kind == "ignored-collision" {
        // The Pull recovery dialog is rooted at the parent repository.
        for path in error.details.iter_mut().take(2) {
            *path = format!("{prefix}/{path}");
        }
    }
    error.message = format!("Recursive Pull stopped to protect submodule {prefix}: {}", error.message);
    error
}

struct Inspection<'a> {
    mode: &'a str,
    seen: BTreeSet<(PathBuf, String, bool)>,
}

impl Inspection<'_> {
    fn tree(&mut self, repo: &Path, target: &str, prefix: &str, removed: bool, depth: usize, uncertain_merge: bool) -> GitResult<()> {
        if depth > 32 || self.seen.len() >= 4096 {
            return Err(uncertain("Recursive Pull inspection exceeded its safety limit. No working files were changed."));
        }
        if !self.seen.insert((std::fs::canonicalize(repo)?, target.to_owned(), removed)) {
            return Ok(());
        }
        if !prefix.is_empty() {
            if removed {
                let ignored = workspace_files::untracked(repo).map_err(|e| in_module(e, prefix))?;
                if ignored.truncated {
                    return Err(uncertain(format!("Ignored-data inspection was truncated in submodule {prefix}.")));
                }
                if let Some(path) = ignored.paths.first() {
                    return Err(GitError::new(format!("Recursive Pull may remove submodule {prefix}, which contains uncommitted local data. Move that data outside the repository before retrying."))
                        .kind("ignored-collision").details(vec![prefix.to_owned(), format!("{prefix}/{}", path.trim_end_matches('/'))]));
                }
            }
            // A checkout may visit any path in the target, not just the parent's
            // gitlink diff. Submodule rebase can additionally replay local trees.
            ops::guard_untracked_tree(repo, target).map_err(|e| in_module(e, prefix))?;
            if self.mode == "rebase" {
                replayed_paths(repo, target, true).map_err(|e| in_module(e, prefix))?;
            }
        }
        let current = gitlinks(&runner::run_bytes(repo, ["ls-files", "--stage", "-z"])?, true)?;
        let incoming = gitlinks(&runner::run_bytes(repo, ["ls-tree", "-r", "-z", "--full-tree", target])?, false)?;
        let paths: BTreeSet<_> = current.keys().chain(incoming.keys()).collect();
        for path in paths {
            let child = ops::local_leaf_path(repo, path)?;
            let metadata = match std::fs::symlink_metadata(&child) {
                Ok(metadata) => metadata,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            let name = if prefix.is_empty() { path.to_owned() } else { format!("{prefix}/{path}") };
            if ops::path_is_link(&metadata) || !metadata.is_dir() {
                return Err(uncertain(format!("Submodule {name} is not an ordinary working directory. No working files were changed.")));
            }
            match std::fs::symlink_metadata(child.join(".git")) {
                Ok(marker) if !ops::path_is_link(&marker) && (marker.is_file() || marker.is_dir()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Deinitialized empty directories have nothing to lose. A
                    // nonempty directory without a marker could be reattached
                    // by Git using cached module metadata; do not assume safety.
                    if std::fs::read_dir(&child)?.next().transpose()?.is_some() {
                        return Err(uncertain(format!("Cannot inspect local data in uninitialized submodule {name}. Move it outside the repository or restore the module before retrying.")));
                    }
                    continue;
                }
                Err(e) => return Err(e.into()),
                _ => return Err(uncertain(format!("Cannot safely inspect the Git marker for submodule {name}."))),
            }
            let top = runner::run(&child, ["rev-parse", "--show-toplevel"])?;
            if std::fs::canonicalize(top.trim())? != std::fs::canonicalize(&child)? {
                return Err(uncertain(format!("Submodule {name} points at a different working directory.")));
            }
            let mut candidates: BTreeSet<_> = incoming.get(path).into_iter().collect();
            // Rebase can also reset to the pre-integration gitlink while
            // rebuilding local history. Inspect both possible checkout trees.
            if candidates.is_empty() || uncertain_merge || self.mode == "rebase" {
                candidates.extend(current.get(path));
            }
            for oid in candidates {
                self.tree(&child, oid, &name, removed || !incoming.contains_key(path), depth + 1, false).map_err(|mut e| {
                    if e.kind != "ignored-collision" && !e.message.contains(&name) {
                        e.message = format!("Cannot safely inspect submodule {name}: {}", e.message);
                    }
                    e
                })?;
            }
        }
        Ok(())
    }
}

pub(super) fn submodules(repo: &Path, target: &str, mode: &str) -> GitResult<()> {
    let uncertain_merge = mode == "merge" && !runner::exec(repo, ["merge-base", "--is-ancestor", "HEAD", target])?.ok();
    Inspection { mode, seen: BTreeSet::new() }.tree(repo, target, "", false, 0, uncertain_merge)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_keeps_deleted_paths_and_literal_newlines_and_detects_gitlinks() {
        let raw = b":100644 000000 abc def D\0private\nfile.env\0:000000 160000 abc def A\0nested\0";
        let (paths, links) = replay_paths(raw).unwrap();
        assert_eq!(paths, b"private\nfile.env\0nested\0");
        assert!(links);
    }
    #[test]
    fn undecodable_path_records_are_rejected_on_every_filesystem() {
        assert_eq!(workspace_files::path_list(b"ordinary\0bad-\xff\0").unwrap_err().kind, "unsupported-path-encoding");
        assert_eq!(replay_paths(b":100644 000000 abc def D\0bad-\xff\0").unwrap_err().kind, "unsupported-path-encoding");
        assert_eq!(gitlinks(b"160000 commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tbad-\xff\0", false).unwrap_err().kind, "unsupported-path-encoding");
    }
}
