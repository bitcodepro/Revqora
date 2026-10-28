//! Explicit, read-only inspection of files omitted from the normal status view.
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::runner::{self, GitResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredFiles {
    pub paths: Vec<String>,
    pub truncated: bool,
}

pub fn ignored(root: &Path) -> GitResult<IgnoredFiles> {
    // Collapsing wholly ignored folders avoids enumerating node_modules or build
    // output. Git handles repository, info/exclude and global ignore rules.
    let raw = runner::run(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])?;
    let mut paths: Vec<_> = raw.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect();
    paths.sort();
    let truncated = paths.len() > 10_000;
    paths.truncate(10_000);
    Ok(IgnoredFiles { paths, truncated })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedRepository {
    pub path: String,
    pub relative_path: String,
    pub kind: String,
    pub branch: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedRepositories {
    pub repositories: Vec<NestedRepository>,
    pub truncated: bool,
    pub skipped: usize,
}

pub fn nested(root: &Path) -> GitResult<NestedRepositories> {
    let root = std::fs::canonicalize(root)?;
    let mut pending = vec![(root.clone(), 0usize)];
    let mut result = NestedRepositories { repositories: Vec::new(), truncated: false, skipped: 0 };
    let mut visited = 0;
    while let Some((folder, depth)) = pending.pop() {
        let entries = match std::fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        for entry in entries {
            visited += 1;
            if visited > 50_000 || result.repositories.len() >= 200 {
                result.truncated = true;
                break;
            }
            let Ok(entry) = entry else {
                result.skipped += 1;
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                result.skipped += 1;
                continue;
            };
            // Never follow symlinks/junctions out of the selected repository.
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if [".git", "node_modules", "target", "dist", ".next", ".vs", "obj", "__pycache__"].contains(&name.as_str()) {
                result.skipped += 1;
                continue;
            }
            let path = entry.path();
            if let Some(repo) = inspect(&root, &path) {
                result.repositories.push(repo);
                // A child is a separate workspace. Scan deeper after opening it,
                // rather than reading all of its independent repository data.
            } else if depth < 11 {
                pending.push((path, depth + 1));
            } else {
                result.truncated = true;
            }
        }
        if visited > 50_000 || result.repositories.len() >= 200 {
            result.truncated = true;
            break;
        }
    }
    result.repositories.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(result)
}

fn inspect(root: &Path, folder: &Path) -> Option<NestedRepository> {
    let dotgit = folder.join(".git");
    let marker = std::fs::symlink_metadata(&dotgit).ok();
    if marker.as_ref().is_some_and(|m| m.file_type().is_symlink()) {
        return None;
    }
    let bare_candidate = marker.is_none() && folder.join("HEAD").is_file() && folder.join("objects").is_dir();
    if marker.is_none() && !bare_candidate {
        return None;
    }
    let bare = runner::run(folder, ["rev-parse", "--is-bare-repository"]).ok()?.trim() == "true";
    if !bare {
        let top = runner::run(folder, ["rev-parse", "--show-toplevel"]).ok()?;
        if std::fs::canonicalize(top.trim()).ok()? != std::fs::canonicalize(folder).ok()? {
            return None;
        }
    }
    let git_dir = runner::run(folder, ["rev-parse", "--absolute-git-dir"]).ok()?;
    let git_dir = PathBuf::from(git_dir.trim());
    let kind = if bare {
        "bare"
    } else if marker.as_ref().is_some_and(|m| m.is_file()) {
        if git_dir.components().any(|c| c.as_os_str() == "modules") {
            "submodule"
        } else {
            "linked worktree"
        }
    } else {
        "embedded repository"
    };
    let branch = runner::exec(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().filter(|r| r.ok()).map(|r| r.text().trim().to_owned());
    Some(NestedRepository {
        path: folder.to_string_lossy().into_owned(),
        relative_path: folder.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"),
        kind: kind.into(),
        branch,
    })
}
