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
    /// Detected text encoding of this version (e.g. "windows-1251", "UTF-16LE").
    pub encoding: Option<String>,
    pub bom: bool,
    /// Plain ASCII without a BOM: valid in every ASCII-compatible encoding.
    pub ascii: bool,
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
    /// Encoding the resolution is saved in by default: the sides' own encoding.
    pub encoding: String,
    pub bom: bool,
    /// The sides use different encodings; the user chooses the result's encoding.
    pub encodings_differ: bool,
}

pub(crate) fn missing_side() -> ConflictSide {
    ConflictSide { exists: false, binary: false, text: String::new(), oid: None, encoding: None, bom: false, ascii: false }
}

/// Decodes one version in its own encoding (CP1251, Shift-JIS, UTF-16, ...). Only real binary
/// data stays undecoded; the editor works on the text and a save encodes it back.
pub(crate) fn text_side(data: &[u8], oid: Option<String>) -> GitResult<ConflictSide> {
    let decoded = super::text_encoding::decode(data, None)?;
    Ok(match decoded {
        Some(d) => ConflictSide {
            exists: true,
            binary: false,
            // Plain ASCII fits any ASCII-compatible encoding; UTF-16/32 text of ASCII characters
            // passes `is_ascii` byte-wise (its NULs are ASCII) but is not interchangeable.
            ascii: data.is_ascii() && !d.bom && !data.contains(&0) && !d.encoding.starts_with("UTF-16") && !d.encoding.starts_with("UTF-32"),
            text: d.content,
            oid,
            encoding: Some(d.encoding.to_string()),
            bom: d.bom,
        },
        None => ConflictSide { exists: true, binary: true, text: String::new(), oid, encoding: None, bom: false, ascii: false },
    })
}

/// The encoding a resolution is saved in: the sides' own (ours first). Pure-ASCII versions fit
/// any ASCII-compatible encoding, so they never count as a difference.
pub(crate) fn result_encoding(sides: [&ConflictSide; 3]) -> (String, bool, bool) {
    let named: Vec<&ConflictSide> = sides.into_iter().filter(|s| s.exists && !s.binary && !s.ascii && s.encoding.is_some()).collect();
    match named.first() {
        Some(first) => {
            let encoding = first.encoding.clone().unwrap_or_default();
            let differ = named.iter().any(|s| s.encoding.as_deref() != Some(encoding.as_str()));
            (encoding, first.bom, differ)
        }
        None => ("UTF-8".into(), sides.iter().any(|s| s.exists && s.bom && s.encoding.as_deref() == Some("UTF-8")), false),
    }
}

/// Three-way merge of the decoded texts, so sides in any encoding (even UTF-16) merge by line.
pub(crate) fn merge_sides(ours: &ConflictSide, base: &ConflictSide, theirs: &ConflictSide) -> GitResult<(String, u32)> {
    merge_file(ours.text.as_bytes(), base.text.as_bytes(), theirs.text.as_bytes())
}

/// Encodes a resolution for saving; characters the encoding cannot store are reported.
pub(crate) fn encode_resolution(content: &str, encoding: &str, bom: bool) -> GitResult<Vec<u8>> {
    match super::text_encoding::encode(content, encoding, bom)? {
        Ok(bytes) => Ok(bytes),
        Err(missing) => Err(GitError::new(missing.message(encoding)).kind("unencodable").details(vec![missing.line.to_string(), missing.ch.to_string()])),
    }
}

fn side(repo: &Path, oid: Option<&str>) -> GitResult<(ConflictSide, Vec<u8>)> {
    match oid {
        None => Ok((missing_side(), Vec::new())),
        Some(o) => {
            let data = runner::run_bytes(repo, ["cat-file", "blob", o])?;
            Ok((text_side(&data, Some(o.to_string()))?, data))
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
    let (base, _) = side(repo, base.as_ref().map(|entry| entry.oid.as_str()))?;
    let (ours, _) = side(repo, ours.as_ref().map(|entry| entry.oid.as_str()))?;
    let (theirs, _) = side(repo, theirs.as_ref().map(|entry| entry.oid.as_str()))?;
    let (encoding, bom, encodings_differ) = result_encoding([&ours, &theirs, &base]);
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
    // The working file (with Git's markers or the user's own edits) is read in the sides'
    // encoding first, then detected on its own.
    let working = match &working_raw {
        Some(bytes) => match super::text_encoding::decode(bytes, Some(&encoding)).ok().flatten() {
            Some(text) => Some(text.content),
            None => super::text_encoding::decode(bytes, None)?.map(|text| text.content),
        },
        None => None,
    };
    let working_has_markers = working.as_deref().map(has_markers).unwrap_or(false);
    let eol_crlf = [&ours, &theirs, &base].iter().any(|s| s.text.contains("\r\n"));

    let (merged, conflict_count) =
        if ours.binary || theirs.binary || base.binary || !ours.exists || !theirs.exists { (String::new(), 1) } else { merge_sides(&ours, &base, &theirs)? };
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
        encoding,
        bom,
        encodings_differ,
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
    save_resolution_as(repo, path, content, stage, None)
}

/// Writes the resolution in `encoding` (default: the sides' own encoding and BOM), so a CP1251
/// file stays CP1251. Binary sides have no text form; they are resolved by taking a side.
pub fn save_resolution_as(repo: &Path, path: &str, content: &str, stage: bool, encoding: Option<&str>) -> GitResult<()> {
    let full = checked_path(repo, path, false)?;
    let (target, bom) = match info(repo, path) {
        Ok(current) => {
            if current.ours.binary || current.theirs.binary || current.base.binary {
                return Err(GitError::new("This is a binary file; keep one side, or delete it.").kind("not-text"));
            }
            match encoding {
                Some(chosen) => {
                    let chosen = super::text_encoding::canonical(chosen)?.to_string();
                    let bom = if chosen == current.encoding { current.bom } else { chosen.starts_with("UTF-16") || chosen.starts_with("UTF-32") };
                    (chosen, bom)
                }
                None => (current.encoding, current.bom),
            }
        }
        // Already resolved (stages gone): keep the chosen encoding, else UTF-8.
        Err(_) => (encoding.map(super::text_encoding::canonical).transpose()?.unwrap_or("UTF-8").to_string(), false),
    };
    let bytes = encode_resolution(content, &target, bom)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    use std::io::Write;
    let mut temporary = super::atomic_file::new_in(full.parent().ok_or_else(|| GitError::new("Invalid conflict path."))?)?;
    temporary.write_all(&bytes)?;
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
