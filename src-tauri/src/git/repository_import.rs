//! Discover working copies beneath a folder without walking through their contents.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;

use super::ops::path_is_link;
use super::repo;
use super::runner::{GitError, GitResult};

const MAX_ENTRIES: usize = 30_000;
const MAX_DEPTH: usize = 20;
const MAX_REPOSITORIES: usize = 500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepository {
    pub root: String,
    pub relative_path: String,
    pub workspace_folder: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
    pub repositories: Vec<FoundRepository>,
    pub skipped: usize,
    pub limited: bool,
}

pub fn scan(root: &Path) -> GitResult<FolderScan> {
    if !root.is_absolute() {
        return Err(GitError::new("Choose an absolute folder path."));
    }
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || path_is_link(&metadata) {
        return Err(GitError::new("Choose a folder directly to scan it for repositories."));
    }

    let mut result = FolderScan::default();
    let mut remaining = MAX_ENTRIES;
    let mut pending = vec![(root.to_path_buf(), 0)];
    while let Some((folder, depth)) = pending.pop() {
        match fs::symlink_metadata(folder.join(".git")) {
            Ok(_) => {
                if let Some(found_root) = exact_repository(&folder) {
                    let workspace_folder =
                        if depth > 1 { Path::new(&found_root).ancestors().nth(depth - 1).and_then(Path::to_str).map(str::to_owned) } else { None };
                    let relative_path = folder.strip_prefix(root).ok().and_then(Path::to_str).unwrap_or(&found_root).to_owned();
                    result.repositories.push(FoundRepository { root: found_root, relative_path, workspace_folder });
                    if result.repositories.len() == MAX_REPOSITORIES {
                        result.limited |= !pending.is_empty();
                        break;
                    }
                    continue;
                }
                result.skipped += 1;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        }
        if depth == MAX_DEPTH {
            result.limited = true;
            continue;
        }
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if depth == 0 => return Err(error.into()),
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let mut children = Vec::new();
        for entry in entries {
            if remaining == 0 {
                result.limited = true;
                break;
            }
            remaining -= 1;
            let Ok(entry) = entry else {
                result.skipped += 1;
                continue;
            };
            if entry.file_name() == ".git" {
                continue;
            }
            match entry.metadata() {
                Ok(meta) if path_is_link(&meta) => result.skipped += 1,
                Ok(meta) if meta.is_dir() => {
                    let path = entry.path();
                    if path.to_str().is_some() {
                        children.push(path);
                    } else {
                        result.skipped += 1;
                    }
                }
                Ok(_) => {}
                Err(_) => result.skipped += 1,
            }
        }
        children.sort_unstable();
        pending.extend(children.into_iter().rev().map(|path| (path, depth + 1)));
    }
    Ok(result)
}

fn exact_repository(folder: &Path) -> Option<String> {
    let root = repo::discover(folder).ok()?;
    if fs::canonicalize(folder).ok()? != fs::canonicalize(&root).ok()? {
        return None;
    }
    root.to_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner;

    fn init(path: &Path) {
        fs::create_dir_all(path).unwrap();
        runner::run(path, ["init", "-b", "main"]).unwrap();
    }

    #[test]
    fn scans_direct_and_grouped_working_copies_without_descending_into_repositories() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        init(&root.join("api"));
        init(&root.join("api/nested"));
        init(&root.join("backend/service one"));
        init(&root.join("frontend/deeper/web"));
        fs::create_dir(root.join("empty")).unwrap();
        fs::create_dir(root.join("broken")).unwrap();
        fs::write(root.join("broken/.git"), "invalid").unwrap();
        let result = scan(root).unwrap();
        let paths: Vec<_> = result
            .repositories
            .iter()
            .map(|repo| {
                let name = Path::new(&repo.root).file_name().unwrap().to_str().unwrap();
                let workspace = repo.workspace_folder.as_deref().map(|path| Path::new(path).file_name().unwrap().to_str().unwrap());
                (name, workspace)
            })
            .collect();
        assert_eq!(paths, [("api", None), ("service one", Some("backend")), ("web", Some("frontend"))]);
        assert_eq!(result.skipped, 1);
        assert!(!result.limited);
        assert_eq!(scan(&root.join("api")).unwrap().repositories.len(), 1);
        let aliased = scan(&root.join("empty/..")).unwrap();
        assert_eq!(aliased.repositories[1].workspace_folder, result.repositories[1].workspace_folder);
    }

    #[test]
    fn recognizes_a_gitfile_working_copy() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let repo = root.join("projects/repo");
        fs::create_dir_all(&repo).unwrap();
        runner::run(&repo, ["init", "--separate-git-dir", root.join("metadata").to_str().unwrap()]).unwrap();
        assert!(repo.join(".git").is_file());
        let found = scan(&root.join("projects")).unwrap().repositories;
        assert_eq!(found.len(), 1);
        assert!(found[0].workspace_folder.is_none());
    }

    #[test]
    fn reports_when_the_scan_stops_at_the_depth_limit() {
        let fixture = tempfile::tempdir().unwrap();
        let deepest = fixture.path().join("folder/".repeat(MAX_DEPTH + 1));
        fs::create_dir_all(deepest).unwrap();
        assert!(scan(fixture.path()).unwrap().limited);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_directory_symlinks() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        init(&root.join("external"));
        fs::create_dir(root.join("import")).unwrap();
        std::os::unix::fs::symlink(root.join("external"), root.join("import/link")).unwrap();
        let result = scan(&root.join("import")).unwrap();
        assert!(result.repositories.is_empty());
        assert_eq!(result.skipped, 1);
    }
}
