//! Sparse checkout (`git sparse-checkout`) and partial clone (promisor remote) state.
//!
//! Every mutation runs inside `mutating(...)` in `lib.rs`, so it is queued, checked against the
//! displayed state, journaled in the Operation log and preceded by a recovery checkpoint.
//! Patterns and folders are passed on stdin (`--stdin`), never as argv, so a value starting with
//! `-` can never be read as an option.

use std::path::Path;

use serde::Serialize;

use super::runner::{self, GitError, GitResult};

/// One remote recorded as a promisor (partial clone) source.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PartialRemote {
    pub remote: String,
    /// `remote.<name>.partialclonefilter`, e.g. `blob:none`; None when Git records no filter.
    pub filter: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseState {
    /// `core.sparseCheckout` for this worktree.
    pub enabled: bool,
    /// `core.sparseCheckoutCone`.
    pub cone: bool,
    /// `git sparse-checkout list`: folders in cone mode, gitignore-style patterns otherwise.
    pub patterns: Vec<String>,
    /// Remotes this repository lazily fetches missing objects from.
    pub partial: Vec<PartialRemote>,
    /// Whether `sparse-checkout set --cone/--no-cone` is available (Git 2.35+). Older Git uses
    /// `sparse-checkout init` to pick the mode first.
    pub set_selects_mode: bool,
}

/// Result of a sparse-checkout mutation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseResult {
    pub state: SparseState,
    /// Files outside the new sparse set that Git left in the working tree because they have
    /// local modifications (Git prints them as a warning and keeps them).
    pub left_behind: Vec<String>,
    /// Git's own warning text, verbatim, when it printed one.
    pub warning: Option<String>,
}

fn config_bool(repo: &Path, key: &str) -> GitResult<Option<bool>> {
    let out = runner::exec(repo, ["config", "--bool", "--get", key])?;
    Ok(match out.code {
        0 => Some(out.text().trim() == "true"),
        _ => None,
    })
}

/// Promisor remotes and their filters, from `remote.<name>.promisor` / `.partialclonefilter`
/// and the older `extensions.partialClone = <remote>`.
fn entry(remotes: &mut Vec<PartialRemote>, name: &str) -> usize {
    if let Some(i) = remotes.iter().position(|r| r.remote == name) {
        return i;
    }
    remotes.push(PartialRemote { remote: name.to_string(), filter: None });
    remotes.len() - 1
}

pub fn partial_remotes(repo: &Path) -> GitResult<Vec<PartialRemote>> {
    let out = runner::exec(repo, ["config", "-z", "--get-regexp", r"^(remote\..*\.(promisor|partialclonefilter)|extensions\.partialclone)$"])?;
    let mut remotes: Vec<PartialRemote> = Vec::new();
    let mut promisor = std::collections::HashMap::new();
    if out.ok() {
        let text = out.text();
        for record in runner::split_nul(&text) {
            let (key, value) = record.split_once('\n').unwrap_or((record, ""));
            let lower = key.to_ascii_lowercase();
            if lower == "extensions.partialclone" {
                if !value.trim().is_empty() {
                    promisor.insert(value.trim().to_string(), true);
                }
                continue;
            }
            // remote.<name>.<var>: the name may itself contain dots.
            let Some(rest) = key.strip_prefix("remote.") else { continue };
            let Some((name, var)) = rest.rsplit_once('.') else { continue };
            match var.to_ascii_lowercase().as_str() {
                "promisor" => {
                    let on = matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "yes" | "on" | "1" | "");
                    promisor.insert(name.to_string(), on);
                }
                "partialclonefilter" => {
                    let i = entry(&mut remotes, name);
                    remotes[i].filter = Some(value.trim().to_string()).filter(|f| !f.is_empty());
                }
                _ => {}
            }
        }
    }
    for (name, on) in &promisor {
        if *on {
            entry(&mut remotes, name);
        }
    }
    // A filter without a promisor flag is leftover configuration, not a partial clone.
    remotes.retain(|r| promisor.get(&r.remote).copied().unwrap_or(false));
    remotes.sort_by(|a, b| a.remote.cmp(&b.remote));
    Ok(remotes)
}

pub fn state(repo: &Path) -> GitResult<SparseState> {
    let enabled = config_bool(repo, "core.sparseCheckout")?.unwrap_or(false);
    let cone = config_bool(repo, "core.sparseCheckoutCone")?.unwrap_or(false);
    let patterns = if enabled {
        let out = runner::exec(repo, ["sparse-checkout", "list"])?;
        if out.ok() {
            out.text().lines().map(|l| l.trim_end_matches('\r').to_string()).filter(|l| !l.is_empty()).collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    Ok(SparseState { enabled, cone, patterns, partial: partial_remotes(repo)?, set_selects_mode: runner::version_at_least(2, 35) })
}

/// Normalizes a cone-mode folder: forward slashes, no leading/trailing slash.
pub fn normalize_folder(raw: &str) -> GitResult<String> {
    let folder = raw.trim().replace('\\', "/");
    let folder = folder.trim_matches('/');
    let invalid = |why: &str| GitError::new(format!("{raw:?} is not a usable folder: {why}.")).kind("invalid-sparse-path");
    if folder.is_empty() || folder == "." {
        return Err(invalid("top-level files are always included; enter a folder"));
    }
    if folder.chars().any(|c| c.is_control()) {
        return Err(invalid("it contains a control character"));
    }
    for part in folder.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(invalid("use a plain relative path inside the repository"));
        }
        if part.eq_ignore_ascii_case(".git") {
            return Err(invalid("the .git folder is never checked out"));
        }
    }
    Ok(folder.to_string())
}

fn normalize_entries(cone: bool, entries: &[String]) -> GitResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in entries {
        if raw.trim().is_empty() {
            continue;
        }
        let value = if cone {
            normalize_folder(raw)?
        } else {
            if raw.chars().any(|c| c.is_control()) {
                return Err(GitError::new(format!("{raw:?} contains a control character.")).kind("invalid-sparse-path"));
            }
            raw.trim_end().to_string()
        };
        if !out.contains(&value) {
            out.push(value);
        }
    }
    Ok(out)
}

fn stdin_of(entries: &[String]) -> Vec<u8> {
    let mut text = entries.join("\n");
    text.push('\n');
    text.into_bytes()
}

/// Paths Git listed (tab-indented) after a "not up to date" heading.
fn listed_paths(stderr: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut in_list = false;
    for line in stderr.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("not up to date") || lower.contains("would be overwritten") || lower.contains("were left despite") {
            in_list = true;
            continue;
        }
        if in_list {
            if let Some(path) = line.strip_prefix('\t').or_else(|| line.strip_prefix("    ")) {
                let path = path.trim();
                if !path.is_empty() {
                    paths.push(path.to_string());
                }
                continue;
            }
            in_list = false;
        }
    }
    paths
}

/// Runs a sparse-checkout subcommand. A refusal keeps Git's message and the affected files; a
/// success reports files Git left behind.
/// `connection` is a Git connection selection not saved yet; `None` uses the saved settings.
fn sparse_run(repo: &Path, args: &[&str], input: Option<&[u8]>, connection: Option<&super::connection::Options>) -> GitResult<SparseResult> {
    let mut argv = vec!["sparse-checkout"];
    argv.extend_from_slice(args);
    // In a partial clone this may fetch missing blobs, so it uses the chosen SSH/HTTPS transport.
    let out = runner::exec_full_with_connection(repo, &argv, &[], input, connection)?;
    let stderr = out.stderr.trim().to_string();
    if !out.ok() {
        let files = listed_paths(&stderr);
        let mut err = runner::to_error(&format!("git sparse-checkout {}", args.first().unwrap_or(&"")), &out);
        if !files.is_empty() {
            err.message = format!("Git did not change the sparse checkout because files outside the new set have local changes. Commit, stash or discard them first. Git said: {stderr}");
            err = err.kind("sparse-local-changes").details(files);
        }
        return Err(err);
    }
    let left_behind = listed_paths(&stderr);
    let warning = (!stderr.is_empty()).then_some(stderr);
    Ok(SparseResult { state: state(repo)?, left_behind, warning })
}

/// True when `dir` stays in the working tree for the cone `folders`: it is one of them, lies
/// inside one, or is a parent of one (parents keep their own files, not their other folders).
fn in_cone(dir: &str, folders: &[String]) -> bool {
    let inside = |inner: &str, outer: &str| inner.strip_prefix(outer).is_some_and(|rest| rest.starts_with('/'));
    folders.iter().any(|f| f == dir || inside(dir, f) || inside(f, dir))
}

/// The top-most folder of the folder path `dir` that the cone `folders` exclude, if any.
fn excluded_root<'a>(dir: &'a str, folders: &[String]) -> Option<&'a str> {
    let mut ends: Vec<usize> = dir.match_indices('/').map(|(i, _)| i).collect();
    ends.push(dir.len());
    ends.into_iter().map(|end| &dir[..end]).find(|d| !in_cone(d, folders))
}

/// Ignored files and folders that Git would delete when the cone becomes `folders`.
///
/// In cone mode Git removes every folder with tracked files outside the cone, together with
/// the ignored files in it (`.env`, `node_modules`, build output), without a warning; recovery
/// checkpoints do not keep ignored files. Git leaves a folder alone only when it also holds
/// untracked files that are not ignored.
pub fn ignored_leaving_cone(repo: &Path, folders: &[String]) -> GitResult<Vec<String>> {
    let ignored = super::workspace_files::ignored(repo)?;
    if ignored.truncated {
        return Err(GitError::new("There are too many ignored files to check which ones the sparse checkout would delete. Nothing was changed.")
            .kind("sparse-ignored-unknown"));
    }
    if ignored.paths.is_empty() {
        return Ok(Vec::new());
    }
    let ignore_case = cfg!(windows) || config_bool(repo, "core.ignorecase")?.unwrap_or(false);
    let fold = |p: &str| if ignore_case { p.to_lowercase() } else { p.to_owned() };
    let folders: Vec<String> = folders.iter().map(|f| fold(f)).collect();
    // Ignored paths, by the excluded folder Git would remove them with. A file directly in an
    // included folder (or in the root) is never touched.
    let mut at_risk: std::collections::BTreeMap<String, Vec<&String>> = std::collections::BTreeMap::new();
    for path in &ignored.paths {
        let folded = fold(path);
        let dir = if folded.ends_with('/') { folded.trim_end_matches('/') } else { folded.rsplit_once('/').map_or("", |(dir, _)| dir) };
        if dir.is_empty() {
            continue;
        }
        if let Some(root) = excluded_root(dir, &folders) {
            at_risk.entry(root.to_owned()).or_default().push(path);
        }
    }
    if at_risk.is_empty() {
        return Ok(Vec::new());
    }
    let roots_with = |listing: &[u8]| -> GitResult<std::collections::BTreeSet<String>> {
        let mut found = std::collections::BTreeSet::new();
        for path in super::workspace_files::path_list(listing)?.split('\0').filter(|p| !p.is_empty()) {
            let folded = fold(path);
            for (end, _) in folded.match_indices('/') {
                if at_risk.contains_key(&folded[..end]) {
                    found.insert(folded[..end].to_owned());
                }
            }
        }
        Ok(found)
    };
    // Git removes only folders that hold tracked files, and skips those with other untracked files.
    let tracked = roots_with(&runner::run_bytes(repo, ["ls-files", "-z"])?)?;
    let kept = roots_with(&runner::run_bytes(repo, ["ls-files", "-z", "--others", "--exclude-standard", "--no-empty-directory"])?)?;
    let mut out: Vec<String> =
        at_risk.iter().filter(|(root, _)| tracked.contains(*root) && !kept.contains(*root)).flat_map(|(_, paths)| paths.iter().map(|p| (*p).clone())).collect();
    out.sort();
    Ok(out)
}

/// Refuses a cone change that would delete ignored files, unless the user accepted the loss.
fn guard_ignored(repo: &Path, cone: bool, folders: &[String], allow_ignored_loss: bool) -> GitResult<()> {
    if !cone || allow_ignored_loss {
        return Ok(());
    }
    let doomed = ignored_leaving_cone(repo, folders)?;
    if doomed.is_empty() {
        return Ok(());
    }
    let plural = if doomed.len() == 1 { "" } else { "s" };
    Err(GitError::new(format!(
        "Git would permanently delete {} ignored file{plural} or folder{plural} in folders that leave the working tree. Nothing was changed.",
        doomed.len()
    ))
    .kind("sparse-ignored-files")
    .details(doomed))
}

/// Enables sparse checkout or replaces its folders/patterns, choosing cone or non-cone mode.
/// Refuses when ignored files would be deleted (see `set_with`).
pub fn set(repo: &Path, cone: bool, entries: &[String]) -> GitResult<SparseResult> {
    set_with(repo, cone, entries, false)
}

/// `set`; `allow_ignored_loss` is the user's consent to Git deleting the ignored files in
/// folders that leave the working tree.
pub fn set_with(repo: &Path, cone: bool, entries: &[String], allow_ignored_loss: bool) -> GitResult<SparseResult> {
    guard_ignored(repo, cone, &normalize_entries(cone, entries)?, allow_ignored_loss)?;
    set_with_connection(repo, cone, entries, None)
}

/// `set` with a Git connection selection that is not saved yet (a clone's initial folders).
pub fn set_with_connection(repo: &Path, cone: bool, entries: &[String], connection: Option<&super::connection::Options>) -> GitResult<SparseResult> {
    let entries = normalize_entries(cone, entries)?;
    let mode = if cone { "--cone" } else { "--no-cone" };
    if runner::version_at_least(2, 35) {
        return sparse_run(repo, &["set", mode, "--stdin"], Some(&stdin_of(&entries)), connection);
    }
    // Git 2.30–2.34: `set` cannot pick the mode; `init` does (it is deprecated only later).
    let current = state(repo)?;
    if !current.enabled || current.cone != cone {
        let init: &[&str] = if cone { &["init", "--cone"] } else { &["init"] };
        runner::run(repo, ["config", "core.sparseCheckoutCone", if cone { "true" } else { "false" }])?;
        sparse_run(repo, init, None, connection)?;
    }
    sparse_run(repo, &["set", "--stdin"], Some(&stdin_of(&entries)), connection)
}

/// Adds folders (cone) or patterns (non-cone) to an enabled sparse checkout.
pub fn add(repo: &Path, entries: &[String]) -> GitResult<SparseResult> {
    add_with(repo, entries, false)
}

/// `add`; Git cleans every excluded folder again on each change, so ignored files created in
/// one since the last change are deleted too.
pub fn add_with(repo: &Path, entries: &[String], allow_ignored_loss: bool) -> GitResult<SparseResult> {
    let current = state(repo)?;
    if !current.enabled {
        return Err(GitError::new("Sparse checkout is off. Turn it on first.").kind("sparse-disabled"));
    }
    let entries = normalize_entries(current.cone, entries)?;
    if entries.is_empty() {
        return Err(GitError::new("Enter at least one folder.").kind("invalid-sparse-path"));
    }
    let next: Vec<String> = current.patterns.iter().chain(&entries).cloned().collect();
    guard_ignored(repo, current.cone, &next, allow_ignored_loss)?;
    sparse_run(repo, &["add", "--stdin"], Some(&stdin_of(&entries)), None)
}

/// Turns sparse checkout off: every tracked file comes back to the working tree.
pub fn disable(repo: &Path) -> GitResult<SparseResult> {
    sparse_run(repo, &["disable"], None, None)
}

/// Applies the current patterns again (e.g. after a checkout or merge brought files back).
pub fn reapply(repo: &Path) -> GitResult<SparseResult> {
    reapply_with(repo, false)
}

pub fn reapply_with(repo: &Path, allow_ignored_loss: bool) -> GitResult<SparseResult> {
    let current = state(repo)?;
    if !current.enabled {
        return Err(GitError::new("Sparse checkout is off.").kind("sparse-disabled"));
    }
    guard_ignored(repo, current.cone, &current.patterns, allow_ignored_loss)?;
    sparse_run(repo, &["reapply"], None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_are_normalized_and_validated() {
        assert_eq!(normalize_folder(" src\\app/ ").unwrap(), "src/app");
        assert_eq!(normalize_folder("/docs").unwrap(), "docs");
        for bad in ["", "/", ".", "a/../b", ".git", "a//b", "a\nb"] {
            assert!(normalize_folder(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn cone_exclusion_finds_the_folder_git_removes() {
        let cone = vec!["keep".to_string(), "a/b".to_string()];
        assert_eq!(excluded_root("lib", &cone), Some("lib"));
        assert_eq!(excluded_root("lib/node_modules", &cone), Some("lib"));
        assert_eq!(excluded_root("a/c/deep", &cone), Some("a/c"));
        // Inside the cone, or a parent of a cone folder.
        for kept in ["keep", "keep/x/y", "a", "a/b", "a/b/c"] {
            assert_eq!(excluded_root(kept, &cone), None, "{kept}");
        }
        // Similar names are not parents or children.
        assert_eq!(excluded_root("keeper", &cone), Some("keeper"));
        assert_eq!(excluded_root("a/bc", &cone), Some("a/bc"));
    }

    #[test]
    fn listed_paths_reads_both_git_message_styles() {
        let new = "warning: The following paths are not up to date and were left despite sparse patterns:\n\tlib/a.txt\n\tlib/b.txt\n\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.";
        assert_eq!(listed_paths(new), ["lib/a.txt", "lib/b.txt"]);
        let old = "error: Cannot update sparse checkout: the following entries are not up to date:\n\tlib/a.txt\n";
        assert_eq!(listed_paths(old), ["lib/a.txt"]);
        assert!(listed_paths("").is_empty());
    }
}
