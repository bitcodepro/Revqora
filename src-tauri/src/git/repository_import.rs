//! Discover working copies, including repositories nested in other working copies.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;

use super::ops::path_is_link;
use super::repo;
use super::runner::{GitError, GitResult};

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
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        match fs::symlink_metadata(folder.join(".git")) {
            Ok(_) => {
                if let Some(found_root) = exact_repository(&folder) {
                    let workspace_folder = Path::new(&found_root).parent().and_then(Path::to_str).map(str::to_owned);
                    let relative_path = folder.strip_prefix(root).ok().and_then(Path::to_str).unwrap_or(&found_root).to_owned();
                    result.repositories.push(FoundRepository { root: found_root, relative_path, workspace_folder });
                } else {
                    result.skipped += 1;
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => {
                result.skipped += 1;
            }
        }
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if folder == root => return Err(error.into()),
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let mut children = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else {
                result.skipped += 1;
                continue;
            };
            let name = entry.file_name();
            if name == ".git" || cfg!(windows) && name.to_str().is_some_and(|name| name.eq_ignore_ascii_case(".git")) {
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
        pending.extend(children.into_iter().rev());
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
    fn scans_nested_working_copies_and_uses_each_immediate_parent() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        init(&root.join("api"));
        init(&root.join("api/nested/worker"));
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
        let name = root.file_name().unwrap().to_str().unwrap();
        assert_eq!(paths, [("api", Some(name)), ("worker", Some("nested")), ("service one", Some("backend")), ("web", Some("deeper"))]);
        assert_eq!(result.skipped, 1);
        assert_eq!(scan(&root.join("api")).unwrap().repositories.len(), 2);
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
        assert!(Path::new(found[0].workspace_folder.as_deref().unwrap()).ends_with("projects"));
    }

    #[test]
    fn finds_a_repository_beyond_the_old_depth_limit() {
        let fixture = tempfile::tempdir().unwrap();
        let deepest = fixture.path().join("a/".repeat(30)).join("group/project");
        init(&deepest);
        let found = scan(fixture.path()).unwrap().repositories;
        assert_eq!(found.len(), 1);
        assert!(Path::new(found[0].workspace_folder.as_deref().unwrap()).ends_with("group"));
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
