//! Conflict inspection and resolution.

use std::path::Path;

use serde::Serialize;

use super::repo;
use super::runner::{self, GitError, GitResult};

fn checked_path(repo: &Path, path: &str, allow_leaf_link: bool) -> GitResult<std::path::PathBuf> {
    use std::{fs, path::Component};
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.components().any(|c| !matches!(c, Component::Normal(_)) || c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
    {
        return Err(GitError::new("Choose a file inside this working copy."));
    }
    let mut current = repo.canonicalize()?;
    let parts: Vec<_> = path.components().collect();
    for (index, part) in parts.iter().enumerate() {
        current.push(part.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                let leaf = index + 1 == parts.len();
                if meta.file_type().is_symlink() && (!leaf || !allow_leaf_link) || !leaf && !meta.is_dir() || leaf && meta.is_dir() {
                    return Err(GitError::new("The conflict path traverses a link or is not a regular file. Resolve linked files with Git's whole-side action or the external Git tools."));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(current)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub exists: bool,
    pub binary: bool,
    pub text: String,
    pub oid: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub path: String,
    /// "UU", "AA", "DU", "UD", "AU", "UA", "DD"
    pub code: String,
    pub base: ConflictSide,
    pub ours: ConflictSide,
    pub theirs: ConflictSide,
    /// zdiff3-style merge of the three sides with standard conflict markers.
    pub merged: String,
    pub conflict_count: u32,
    pub working: Option<String>,
    pub working_has_markers: bool,
    pub ours_label: String,
    pub theirs_label: String,
    pub eol_crlf: bool,
}

fn is_binary(data: &[u8]) -> bool {
    data.iter().take(8000).any(|b| *b == 0)
}

fn side(repo: &Path, oid: Option<&str>) -> GitResult<(ConflictSide, Vec<u8>)> {
    match oid {
        None => Ok((ConflictSide { exists: false, binary: false, text: String::new(), oid: None }, Vec::new())),
        Some(o) => {
            let data = runner::run_bytes(repo, ["cat-file", "blob", o])?;
            let binary = is_binary(&data);
            let text = if binary { String::new() } else { String::from_utf8_lossy(&data).into_owned() };
            Ok((ConflictSide { exists: true, binary, text, oid: Some(o.to_string()) }, data))
        }
    }
}

pub fn has_markers(text: &str) -> bool {
    let mut open = false;
    for line in text.lines() {
        if line.starts_with("<<<<<<<") {
            open = true;
        } else if open && line.starts_with(">>>>>>>") {
            return true;
        }
    }
    false
}

fn labels(repo: &Path) -> (String, String) {
    let gd = match repo::git_dir(repo) {
        Ok(g) => g,
        Err(_) => return ("Ours".into(), "Theirs".into()),
    };
    let st = repo::op_state(repo, &gd);
    let head = repo::head(repo).ok();
    let ours = head.and_then(|h| h.branch).unwrap_or_else(|| "HEAD".into());
    match st.kind.as_str() {
        // During a rebase "ours" is the branch being rebased onto and "theirs" the replayed commit.
        "rebase" => (
            st.onto.map(|o| o.chars().take(8).collect()).unwrap_or_else(|| "upstream".into()),
            st.incoming_label.unwrap_or_else(|| "commit being replayed".into()),
        ),
        _ => (ours, st.incoming_label.unwrap_or_else(|| "incoming".into())),
    }
}

struct IndexStage {
    mode: String,
    oid: String,
}

fn index_stages(repo: &Path, path: &str) -> GitResult<[Option<IndexStage>; 4]> {
    let raw = runner::run_env(repo, ["ls-files", "-u", "-z", "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
    let mut stages = [None, None, None, None];
    for rec in runner::split_nul(&raw) {
        // "<mode> <oid> <stage>\t<path>"
        let Some((meta, entry_path)) = rec.split_once('\t') else { continue };
        if entry_path != path {
            continue;
        }
        let mut fields = meta.split(' ');
        if let (Some(mode), Some(oid), Some(stage)) = (fields.next(), fields.next(), fields.next().and_then(|value| value.parse::<usize>().ok())) {
            if (1..=3).contains(&stage) {
                stages[stage] = Some(IndexStage { mode: mode.into(), oid: oid.into() });
            }
        }
    }
    if stages[1].is_none() && stages[2].is_none() && stages[3].is_none() {
        return Err(GitError::new(format!("{path} is not in conflict.")).kind("not-conflicted"));
    }
    Ok(stages)
}

#[derive(Serialize)]
pub struct IndexConflictSide {
    oid: String,
    mode: String,
    text: Option<String>,
    omitted: Option<&'static str>,
}

#[derive(Serialize)]
pub struct IndexConflict {
    base: Option<IndexConflictSide>,
    ours: Option<IndexConflictSide>,
    theirs: Option<IndexConflictSide>,
}

pub fn index_conflict(repo: &Path, path: &str) -> GitResult<IndexConflict> {
    const MAX_SIDE_BYTES: usize = 128 * 1024;
    let [_, base, ours, theirs] = index_stages(repo, path)?;
    let read = |stage: Option<IndexStage>| -> GitResult<_> {
        let Some(IndexStage { mode, oid }) = stage else { return Ok(None) };
        let (text, omitted) = if mode == "160000" {
            (None, Some("gitlink"))
        } else if runner::run(repo, ["cat-file", "-s", &oid])?.trim().parse::<usize>().unwrap_or(usize::MAX) > MAX_SIDE_BYTES {
            (None, Some("too_large"))
        } else {
            let bytes = runner::run_bytes(repo, ["cat-file", "blob", &oid])?;
            match super::text_encoding::decode(&bytes, None)? {
                Some(decoded) => (Some(decoded.content), None),
                None => (None, Some("binary")),
            }
        };
        Ok(Some(IndexConflictSide { oid, mode, text, omitted }))
    };
    Ok(IndexConflict { base: read(base)?, ours: read(ours)?, theirs: read(theirs)? })
}

pub fn info(repo: &Path, path: &str) -> GitResult<ConflictInfo> {
    let [_, base, ours, theirs] = index_stages(repo, path)?;
    let (base, base_raw) = side(repo, base.as_ref().map(|entry| entry.oid.as_str()))?;
    let (ours, ours_raw) = side(repo, ours.as_ref().map(|entry| entry.oid.as_str()))?;
    let (theirs, theirs_raw) = side(repo, theirs.as_ref().map(|entry| entry.oid.as_str()))?;
    let code = match (base.exists, ours.exists, theirs.exists) {
        (_, true, true) if !base.exists => "AA",
        (true, true, true) => "UU",
        (true, false, true) => "DU",
        (true, true, false) => "UD",
        (false, true, false) => "AU",
        (false, false, true) => "UA",
        _ => "DD",
    }
    .to_string();
    let working_path = checked_path(repo, path, true)?;
    let working_raw = if std::fs::symlink_metadata(&working_path).is_ok_and(|m| m.file_type().is_symlink()) { None } else { std::fs::read(&working_path).ok() };
    let working = working_raw.as_ref().filter(|w| !is_binary(w)).map(|w| String::from_utf8_lossy(w).into_owned());
    let working_has_markers = working.as_deref().map(has_markers).unwrap_or(false);
    let eol_crlf = [&ours_raw, &theirs_raw, &base_raw].iter().any(|d| d.windows(2).any(|w| w == b"\r\n"));

    let (merged, conflict_count) = if ours.binary || theirs.binary || base.binary || !ours.exists || !theirs.exists {
        (String::new(), 1)
    } else {
        merge_file(&ours_raw, &base_raw, &theirs_raw)?
    };
    let (ours_label, theirs_label) = labels(repo);
    Ok(ConflictInfo {
        path: path.to_string(),
        code,
        base,
        ours,
        theirs,
        merged,
        conflict_count,
        working,
        working_has_markers,
        ours_label,
        theirs_label,
        eol_crlf,
    })
}

/// Three-way merges blobs with `git merge-file --zdiff3`; returns text and conflict count.
pub fn merge_file(ours: &[u8], base: &[u8], theirs: &[u8]) -> GitResult<(String, u32)> {
    let dir = tempfile::tempdir_in(crate::portable::temp_dir()?)?;
    let (o, b, t) = (dir.path().join("ours"), dir.path().join("base"), dir.path().join("theirs"));
    std::fs::write(&o, ours)?;
    std::fs::write(&b, base)?;
    std::fs::write(&t, theirs)?;
    let style = if runner::version_at_least(2, 35) { "--zdiff3" } else { "--diff3" };
    let out = runner::exec(
        dir.path(),
        ["merge-file", "-p", style, "-L", "ours", "-L", "base", "-L", "theirs", &o.to_string_lossy(), &b.to_string_lossy(), &t.to_string_lossy()],
    )?;
    if out.code < 0 {
        return Err(runner::to_error("git merge-file", &out));
    }
    Ok((String::from_utf8_lossy(&out.stdout).into_owned(), out.code.max(0) as u32))
}

/// Writes the resolved content and marks the file as resolved.
pub fn save_resolution(repo: &Path, path: &str, content: &str, stage: bool) -> GitResult<()> {
    let full = checked_path(repo, path, false)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    use std::io::Write;
    let mut temporary = super::atomic_file::new_in(full.parent().ok_or_else(|| GitError::new("Invalid conflict path."))?)?;
    temporary.write_all(content.as_bytes())?;
    if let Ok(meta) = std::fs::metadata(&full) {
        temporary.as_file().set_permissions(meta.permissions())?;
    }
    temporary.as_file().sync_all()?;
    super::atomic_file::replace(temporary, &full)?;
    if stage {
        runner::run_env(repo, ["add", "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
    }
    Ok(())
}

/// Resolves by taking one side as a whole ("ours" | "theirs" | "base" | "delete").
pub fn take_side(repo: &Path, path: &str, which: &str) -> GitResult<()> {
    checked_path(repo, path, true)?;
    let info = info(repo, path)?;
    let pick = match which {
        "ours" => Some(&info.ours),
        "theirs" => Some(&info.theirs),
        "base" => Some(&info.base),
        "delete" => None,
        _ => return Err(GitError::new("Choose ours, theirs, base or delete.")),
    };
    match pick {
        Some(s) if s.exists => {
            // Git restores the selected index stage with its real mode and
            // unlinks a leaf symlink rather than writing through its target.
            let stage = match which {
                "base" => "--stage=1",
                "ours" => "--stage=2",
                _ => "--stage=3",
            };
            runner::run_env(repo, ["checkout-index", "--force", stage, "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
            runner::run_env(repo, ["add", "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
        }
        _ => {
            runner::run_env(repo, ["rm", "--quiet", "--force", "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
        }
    }
    Ok(())
}

pub fn mark_resolved(repo: &Path, paths: &[String]) -> GitResult<()> {
    for path in paths {
        checked_path(repo, path, true)?;
    }
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    runner::run_env(repo, &args, &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
    Ok(())
}

/// Restores the conflicted state of a file (undo a resolution).
pub fn unresolve(repo: &Path, path: &str) -> GitResult<()> {
    checked_path(repo, path, true)?;
    runner::run_env(repo, ["checkout", "-m", "--", path], &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
    Ok(())
}
