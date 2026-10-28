//! Stash only selected unstaged text changes, without ever replacing the real index.
use std::collections::HashSet;
use std::path::{Component, Path};

use serde::Serialize;

use super::diff::{self, DiffOptions, WorkSide};
use super::runner::{self, GitError, GitResult};
use super::{repo, status};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialStashResult {
    pub oid: String,
    pub removed: bool,
    pub warning: Option<String>,
}

pub fn save(root: &Path, path: &str, selection: &[(usize, usize)], hash: &str, opts: &DiffOptions, message: &str) -> GitResult<PartialStashResult> {
    if path.is_empty() || Path::new(path).components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(GitError::new("Select a repository-relative file."));
    }
    if opts.ignore_whitespace {
        return Err(GitError::new("Turn off Ignore whitespace before stashing selected lines."));
    }
    let gd = repo::git_dir(root)?;
    if repo::op_state(root, &gd).kind != "none" {
        return Err(GitError::new("Finish the current Git operation before stashing lines."));
    }
    let meta = std::fs::symlink_metadata(root.join(path))?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(GitError::new("Partial stash supports regular tracked text files."));
    }
    let stage = runner::run(root, ["ls-files", "--stage", "-z", "--", &format!(":(literal){path}")])?;
    let records: Vec<_> = stage.split('\0').filter(|s| !s.is_empty()).collect();
    if records.len() != 1
        || !records[0]
            .split_once('\t')
            .is_some_and(|(header, p)| p == path && (header.starts_with("100644 ") || header.starts_with("100755 ")) && header.ends_with(" 0"))
    {
        return Err(GitError::new("Partial stash supports tracked text files without conflicts. Use Stash this file for other files."));
    }
    let raw = diff::working_raw(root, path, WorkSide::Unstaged, None, false, opts)?;
    if diff::fingerprint(&raw) != hash {
        return Err(GitError::new("The diff changed. Refresh and select the lines again.").kind("stale"));
    }
    let files = diff::parse(&raw);
    let file = files
        .first()
        .filter(|f| files.len() == 1 && f.new_path.as_deref() == Some(path))
        .ok_or_else(|| GitError::new("The selected file has no text diff."))?;
    if file.binary || file.is_new || file.is_deleted || file.old_mode != file.new_mode || file.old_path != file.new_path {
        return Err(GitError::new("Use Stash this file for binary, renamed, added, deleted or mode-changing files."));
    }
    let picked: HashSet<_> = selection.iter().copied().collect();
    if picked.is_empty() || picked.iter().any(|&(h, l)| !file.hunks.get(h).and_then(|h| h.lines.get(l)).is_some_and(|l| matches!(l.kind, b'+' | b'-'))) {
        return Err(GitError::new("Select changed lines or a hunk to stash."));
    }
    let forward = diff::build_partial_patch(file, &picked, false).ok_or_else(|| GitError::new("No changed lines selected."))?;
    let reverse = diff::build_partial_patch(file, &picked, true).ok_or_else(|| GitError::new("No changed lines selected."))?;
    let head = runner::run(root, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim().to_owned();
    let before = status::status(root)?.state_token;
    let temp = tempfile::Builder::new().prefix("partial-stash-").tempdir_in(crate::portable::temp_dir()?)?;
    let index_path = temp.path().join("index").to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", index_path.as_str())];
    runner::run_env(root, ["read-tree", &head], &env, None)?;
    // Three-way application separates the selected unstaged delta from staged
    // edits in the same file. Dependencies/conflicts fail in this disposable index.
    let applied = runner::exec_full(root, ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], &env, Some(&forward))?;
    if !applied.ok() {
        return Err(GitError::new(
            "These lines depend on staged changes or cannot be isolated. Nothing was removed; stash the whole file or adjust staging first.",
        )
        .details(vec![applied.stderr]));
    }
    let tree = runner::run_env(root, ["write-tree"], &env, None)?.trim().to_owned();
    let head_tree = runner::run(root, ["rev-parse", &format!("{head}^{{tree}}")])?.trim().to_owned();
    if tree == head_tree {
        return Err(GitError::new("The selected delta does not produce an independent stash."));
    }
    let index_commit =
        runner::run_env(root, ["-c", "commit.gpgsign=false", "commit-tree", &head_tree, "-p", &head], &[], Some(b"Revqora partial stash index\n"))?
            .trim()
            .to_owned();
    let title = if message.trim().is_empty() { format!("Selected changes in {path}") } else { message.trim().to_owned() };
    let oid = runner::run_env(root, ["-c", "commit.gpgsign=false", "commit-tree", &tree, "-p", &head, "-p", &index_commit], &[], Some(title.as_bytes()))?
        .trim()
        .to_owned();
    if status::status(root)?.state_token != before || diff::fingerprint(&diff::working_raw(root, path, WorkSide::Unstaged, None, false, opts)?) != hash {
        return Err(GitError::new("The repository changed while preparing the partial stash. Nothing was removed.").kind("stale-operation"));
    }
    runner::run_env(root, ["apply", "--check", "--reverse", "--recount", "--whitespace=nowarn", "-"], &[], Some(&reverse))?;
    let old = runner::exec(root, ["rev-parse", "--verify", "--quiet", "refs/stash"])?;
    let old_oid = if old.ok() {
        old.text().trim().to_owned()
    } else if old.code == 1 {
        "0".repeat(head.len())
    } else {
        return Err(runner::to_error("git rev-parse refs/stash", &old));
    };
    let reflog = format!("On partial stash: {}", title.lines().next().unwrap_or("Selected changes"));
    // Publish a recoverable stash before removing anything from a working file.
    runner::run(root, ["update-ref", "--create-reflog", "-m", &reflog, "refs/stash", &oid, &old_oid])?;
    let removal = runner::exec_full(root, ["apply", "--reverse", "--recount", "--whitespace=nowarn", "-"], &[], Some(&reverse));
    let warning = match removal {
        Ok(out) if out.ok() => None,
        Ok(out) => Some(out.stderr),
        Err(error) => Some(error.message),
    }
    .map(|error| {
        format!("The stash was saved, but the selected changes could not be removed from the working file. Inspect it before applying or retrying. {error}")
    });
    Ok(PartialStashResult { oid, removed: warning.is_none(), warning })
}
