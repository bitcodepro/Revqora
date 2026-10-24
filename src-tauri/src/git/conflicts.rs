//! Conflict inspection and resolution.

use std::path::Path;

use serde::Serialize;

use super::repo;
use super::runner::{self, GitError, GitResult};

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

pub fn info(repo: &Path, path: &str) -> GitResult<ConflictInfo> {
    let raw = runner::run(repo, ["ls-files", "-u", "-z", "--", path])?;
    let mut stages: [Option<String>; 4] = [None, None, None, None];
    for rec in runner::split_nul(&raw) {
        // "<mode> <oid> <stage>\t<path>"
        let (meta, _p) = rec.split_once('\t').unwrap_or((rec, ""));
        let f: Vec<&str> = meta.split(' ').collect();
        if f.len() == 3 {
            if let Ok(s) = f[2].parse::<usize>() {
                if s < 4 {
                    stages[s] = Some(f[1].to_string());
                }
            }
        }
    }
    if stages[1].is_none() && stages[2].is_none() && stages[3].is_none() {
        return Err(GitError::new(format!("{path} is not in conflict.")).kind("not-conflicted"));
    }
    let (base, base_raw) = side(repo, stages[1].as_deref())?;
    let (ours, ours_raw) = side(repo, stages[2].as_deref())?;
    let (theirs, theirs_raw) = side(repo, stages[3].as_deref())?;
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
    let working_path = repo.join(path);
    let working_raw = std::fs::read(&working_path).ok();
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
    let dir = tempfile::tempdir()?;
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
    let full = repo.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&full, content.as_bytes())?;
    if stage {
        runner::run(repo, ["add", "--", path])?;
    }
    Ok(())
}

/// Resolves by taking one side as a whole ("ours" | "theirs" | "base" | "delete").
pub fn take_side(repo: &Path, path: &str, which: &str) -> GitResult<()> {
    let info = info(repo, path)?;
    let pick = match which {
        "ours" => Some(&info.ours),
        "theirs" => Some(&info.theirs),
        "base" => Some(&info.base),
        _ => None,
    };
    match pick {
        Some(s) if s.exists => {
            let oid = s.oid.clone().unwrap_or_default();
            let data = runner::run_bytes(repo, ["cat-file", "blob", &oid])?;
            let full = repo.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&full, data)?;
            runner::run(repo, ["add", "--", path])?;
        }
        _ => {
            runner::run(repo, ["rm", "--quiet", "--force", "--", path])?;
        }
    }
    Ok(())
}

pub fn mark_resolved(repo: &Path, paths: &[String]) -> GitResult<()> {
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    runner::run(repo, &args)?;
    Ok(())
}

/// Restores the conflicted state of a file (undo a resolution).
pub fn unresolve(repo: &Path, path: &str) -> GitResult<()> {
    runner::run(repo, ["checkout", "-m", "--", path])?;
    Ok(())
}
