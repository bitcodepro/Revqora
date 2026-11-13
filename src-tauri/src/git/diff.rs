//! Unified diff parsing, display model and partial (hunk / line) patch building.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::runner::{self, GitError, GitResult};

/// Resolve the empty tree in this repository's object format without writing an
/// object or refreshing the index. SHA-1's well-known constant is not a SHA-256 ID.
pub fn empty_tree(repo: &Path) -> GitResult<String> {
    Ok(runner::run_env(repo, ["hash-object", "-t", "tree", "--stdin"], &[], Some(&[]))?.trim().to_owned())
}
const MAX_DISPLAY_LINES: usize = 20_000;
const STAGE_SNAPSHOT_LIMIT: usize = 64;
const STAGE_SNAPSHOT_BYTES: usize = 1024 * 1024;

struct StageSnapshot {
    id: u64,
    repo: PathBuf,
    path: String,
    raw: Arc<[u8]>,
}

static STAGE_SNAPSHOTS: Mutex<VecDeque<StageSnapshot>> = Mutex::new(VecDeque::new());
static NEXT_STAGE_SNAPSHOT: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct RawLine {
    pub kind: u8,
    /// Line content without the leading marker; includes the trailing '\n' if present.
    pub content: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct RawHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub section: String,
    pub lines: Vec<RawLine>,
}

#[derive(Debug, Clone, Default)]
pub struct RawFileDiff {
    pub header: Vec<Vec<u8>>,
    pub hunks: Vec<RawHunk>,
    pub binary: bool,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub is_new: bool,
    pub is_deleted: bool,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub similarity: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub encoded_text: bool,
    pub is_new: bool,
    pub is_deleted: bool,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub similarity: Option<u32>,
    pub hunks: Vec<DiffHunk>,
    pub additions: u32,
    pub deletions: u32,
    pub truncated: bool,
    /// Fingerprint of the raw diff for actions that require a fresh worktree.
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_snapshot: Option<u64>,
    pub empty: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    #[serde(default)]
    pub context: Option<u32>,
    #[serde(default)]
    pub ignore_whitespace: bool,
    #[serde(default)]
    pub disable_textconv: bool,
    pub rename_from: Option<String>,
}

pub fn fingerprint(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn parse_range(s: &str) -> (u32, u32) {
    let mut it = s.splitn(2, ',');
    let start = it.next().unwrap_or("0").parse().unwrap_or(0);
    let count = it.next().map(|c| c.parse().unwrap_or(0)).unwrap_or(1);
    (start, count)
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32, String)> {
    // @@ -a,b +c,d @@ section
    let rest = line.strip_prefix("@@ -")?;
    let end = rest.find(" @@")?;
    let ranges = &rest[..end];
    let section = rest[end + 3..].trim().to_string();
    let mut parts = ranges.split(" +");
    let (os, ol) = parse_range(parts.next()?);
    let (ns, nl) = parse_range(parts.next()?);
    Some((os, ol, ns, nl, section))
}

fn unquote_path(p: &str) -> String {
    let p = p.trim_end_matches('\t');
    if p.starts_with('"') && p.ends_with('"') && p.len() >= 2 {
        // C-style quoting; core.quotepath=false keeps UTF-8 intact, unescape the basics.
        let inner = &p[1..p.len() - 1];
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('t') => out.push('\t'),
                    Some('n') => out.push('\n'),
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(o) => {
                        out.push('\\');
                        out.push(o)
                    }
                    None => {}
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        p.to_string()
    }
}

/// Splits raw bytes into lines, keeping the trailing '\n'.
fn lines_keep(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in data.iter().enumerate() {
        if *b == b'\n' {
            out.push(&data[start..=i]);
            start = i + 1;
        }
    }
    if start < data.len() {
        out.push(&data[start..]);
    }
    out
}

/// Parses one or more file diffs out of unified diff output.
pub fn parse(data: &[u8]) -> Vec<RawFileDiff> {
    let mut files: Vec<RawFileDiff> = Vec::new();
    let mut cur: Option<RawFileDiff> = None;
    let mut in_hunk = false;
    for line in lines_keep(data) {
        let text = String::from_utf8_lossy(line);
        let t = text.trim_end_matches(['\n', '\r']);
        if t.starts_with("diff --git ") || t.starts_with("diff --cc ") || t.starts_with("diff --combined ") {
            if let Some(f) = cur.take() {
                files.push(f);
            }
            let mut f = RawFileDiff::default();
            f.header.push(line.to_vec());
            cur = Some(f);
            in_hunk = false;
            continue;
        }
        let Some(f) = cur.as_mut() else { continue };
        if t.starts_with("@@ ") {
            if let Some((os, ol, ns, nl, section)) = parse_hunk_header(t) {
                f.hunks.push(RawHunk { old_start: os, old_lines: ol, new_start: ns, new_lines: nl, section, lines: Vec::new() });
                in_hunk = true;
                continue;
            }
        }
        if in_hunk {
            if let Some(h) = f.hunks.last_mut() {
                let kind = line.first().copied().unwrap_or(b' ');
                match kind {
                    b' ' | b'+' | b'-' | b'\\' => {
                        h.lines.push(RawLine { kind, content: line[1..].to_vec() });
                        continue;
                    }
                    _ => {
                        if line == b"\n" || line == b"\r\n" {
                            // Some tools emit an empty context line without the leading space.
                            h.lines.push(RawLine { kind: b' ', content: line.to_vec() });
                            continue;
                        }
                        in_hunk = false;
                    }
                }
            }
        }
        // Header lines.
        f.header.push(line.to_vec());
        if let Some(p) = t.strip_prefix("--- ") {
            if p != "/dev/null" {
                f.old_path = Some(unquote_path(p.trim_prefix("a/")));
            }
        } else if let Some(p) = t.strip_prefix("+++ ") {
            if p != "/dev/null" {
                f.new_path = Some(unquote_path(p.trim_prefix("b/")));
            }
        } else if let Some(m) = t.strip_prefix("new file mode ") {
            f.is_new = true;
            f.new_mode = Some(m.to_string());
        } else if let Some(m) = t.strip_prefix("deleted file mode ") {
            f.is_deleted = true;
            f.old_mode = Some(m.to_string());
        } else if let Some(m) = t.strip_prefix("old mode ") {
            f.old_mode = Some(m.to_string());
        } else if let Some(m) = t.strip_prefix("new mode ") {
            f.new_mode = Some(m.to_string());
        } else if let Some(p) = t.strip_prefix("rename from ") {
            f.old_path = Some(unquote_path(p));
        } else if let Some(p) = t.strip_prefix("rename to ") {
            f.new_path = Some(unquote_path(p));
        } else if let Some(s) = t.strip_prefix("similarity index ") {
            f.similarity = s.trim_end_matches('%').parse().ok();
        } else if t.starts_with("Binary files ") || t == "GIT binary patch" {
            f.binary = true;
        }
    }
    if let Some(f) = cur.take() {
        files.push(f);
    }
    files
}

fn display_text(content: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(content).into_owned();
    while s.ends_with('\n') || s.ends_with('\r') {
        s.pop();
    }
    s
}

pub fn to_display(raw: &RawFileDiff, path_hint: &str, hash: String) -> FileDiff {
    let mut d = FileDiff {
        path: raw.new_path.clone().or_else(|| raw.old_path.clone()).unwrap_or_else(|| path_hint.to_string()),
        old_path: match (&raw.old_path, &raw.new_path) {
            (Some(o), Some(n)) if o != n => Some(o.clone()),
            _ => None,
        },
        binary: raw.binary,
        is_new: raw.is_new,
        is_deleted: raw.is_deleted,
        old_mode: raw.old_mode.clone(),
        new_mode: raw.new_mode.clone(),
        similarity: raw.similarity,
        hash,
        ..Default::default()
    };
    let mut shown = 0usize;
    for h in &raw.hunks {
        let mut old_no = h.old_start;
        let mut new_no = h.new_start;
        let mut lines = Vec::with_capacity(h.lines.len());
        for l in &h.lines {
            d.encoded_text |= std::str::from_utf8(&l.content).is_err();
            let (o, n) = match l.kind {
                b' ' => {
                    let r = (Some(old_no), Some(new_no));
                    old_no += 1;
                    new_no += 1;
                    r
                }
                b'-' => {
                    d.deletions += 1;
                    let r = (Some(old_no), None);
                    old_no += 1;
                    r
                }
                b'+' => {
                    d.additions += 1;
                    let r = (None, Some(new_no));
                    new_no += 1;
                    r
                }
                _ => (None, None),
            };
            if shown < MAX_DISPLAY_LINES {
                lines.push(DiffLine { kind: (l.kind as char).to_string(), old_no: o, new_no: n, text: display_text(&l.content) });
            }
            shown += 1;
        }
        if !lines.is_empty() {
            let header = format!("@@ -{},{} +{},{} @@ {}", h.old_start, h.old_lines, h.new_start, h.new_lines, h.section);
            d.hunks.push(DiffHunk {
                header: header.trim_end().to_string(),
                old_start: h.old_start,
                old_lines: h.old_lines,
                new_start: h.new_start,
                new_lines: h.new_lines,
                lines,
            });
        }
    }
    d.truncated = shown > MAX_DISPLAY_LINES;
    d.empty = raw.hunks.is_empty() && !raw.binary && raw.old_mode == raw.new_mode && !raw.is_new && !raw.is_deleted && d.old_path.is_none();
    d
}

fn base_args(opts: &DiffOptions) -> Vec<String> {
    let mut a = vec!["--no-color".to_string(), "--no-ext-diff".into(), "--find-renames".into()];
    a.push(format!("-U{}", opts.context.unwrap_or(3)));
    if opts.ignore_whitespace {
        a.push("-w".into());
    }
    if opts.disable_textconv {
        a.push("--no-textconv".into());
    }
    a
}

/// What a working-copy diff compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkSide {
    /// index → worktree
    Unstaged,
    /// base (HEAD or top stage layer) → index
    Staged,
}

/// Raw bytes of a working copy diff for a single path.
pub fn working_raw(repo: &Path, path: &str, side: WorkSide, base: Option<&str>, untracked: bool, opts: &DiffOptions) -> GitResult<Vec<u8>> {
    let mut args = vec!["diff".to_string(), "--full-index".into()];
    args.extend(base_args(opts));
    if untracked && side == WorkSide::Unstaged {
        args.push("--no-index".into());
        args.push("--".into());
        args.push("/dev/null".into());
        args.push(path.into());
        let out = runner::exec_full(repo, &args, &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
        if out.code > 1 {
            return Err(runner::to_error("git diff --no-index", &out));
        }
        return Ok(out.stdout);
    }
    if side == WorkSide::Staged {
        args.push("--cached".into());
        if let Some(b) = base {
            args.push(b.to_string());
        }
    }
    args.push("--".into());
    args.push(path.into());
    if side == WorkSide::Staged {
        if let Some(old) = opts.rename_from.as_ref().filter(|old| old.as_str() != path) {
            args.push(old.clone());
        }
    }
    let out = runner::exec_full(repo, &args, &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
    if !out.ok() {
        return Err(runner::to_error("git diff", &out));
    }
    Ok(out.stdout)
}

pub fn working_diff(repo: &Path, path: &str, side: WorkSide, base: Option<&str>, untracked: bool, opts: &DiffOptions) -> GitResult<FileDiff> {
    let raw = working_raw(repo, path, side, base, untracked, opts)?;
    let hash = fingerprint(&raw);
    let files = parse(&raw);
    // Pick the file entry matching the path (renames can produce one entry).
    let pick = files.iter().find(|f| f.new_path.as_deref() == Some(path)).or_else(|| files.first());
    let Some(file) = pick else {
        return Ok(FileDiff { path: path.to_string(), hash, empty: true, ..Default::default() });
    };
    let mut display = to_display(file, path, hash);
    if side == WorkSide::Unstaged
        && files.len() == 1
        && !display.binary
        && !display.hunks.is_empty()
        && file.old_path.as_deref().is_none_or(|old| old == path)
        && file.new_path.as_deref().is_none_or(|new| new == path)
        && raw.len() <= STAGE_SNAPSHOT_BYTES
        && (file.is_new || stage_index_base(file).is_some())
    {
        let mut snapshots = STAGE_SNAPSHOTS.lock();
        let id = NEXT_STAGE_SNAPSHOT.fetch_add(1, Ordering::Relaxed);
        if snapshots.len() == STAGE_SNAPSHOT_LIMIT {
            snapshots.pop_front();
        }
        snapshots.push_back(StageSnapshot { id, repo: repo.into(), path: path.into(), raw: raw.into() });
        display.stage_snapshot = Some(id);
    }
    Ok(display)
}

fn stage_index_base(file: &RawFileDiff) -> Option<(&str, &str)> {
    let index = file.header.iter().find_map(|line| std::str::from_utf8(line).ok()?.strip_prefix("index "))?;
    let (oids, mode) = index.split_once(' ').map_or((index.trim_end(), None), |(oids, mode)| (oids, Some(mode.trim_end())));
    let (old, _) = oids.split_once("..")?;
    Some((file.old_mode.as_deref().or(mode)?, old))
}

/// Stage the exact displayed patch against its original index entry. The
/// working file may have been rewritten any number of times since display.
pub fn stage_selection_snapshot(repo: &Path, path: &str, selection: &[(usize, usize)], id: u64) -> GitResult<bool> {
    let raw = STAGE_SNAPSHOTS.lock().iter().find(|entry| entry.id == id && entry.repo == repo && entry.path == path).map(|entry| Arc::clone(&entry.raw));
    let Some(raw) = raw else { return Ok(false) };
    let file = parse(&raw).into_iter().next().ok_or_else(|| GitError::new("Nothing to apply."))?;
    if !file.is_new {
        let (mode, oid) = stage_index_base(&file).ok_or_else(|| GitError::new("The displayed patch has no index base."))?;
        let entry = runner::run_bytes(repo, ["ls-files", "--stage", "-z", "--", &format!(":(literal){path}")])?;
        let expected = format!("{mode} {oid} 0\t{path}\0");
        if entry != expected.as_bytes() {
            return Err(GitError::new("The staged version changed. Review the updated diff before staging these lines.").kind("stale"));
        }
    }
    // Git applies new-file patches to absent or intent-to-add entries. It
    // refuses to replace a file added to the index after this snapshot.
    apply_selection_patch(repo, &file, SelectionMode::Stage, selection)?;
    Ok(true)
}

/// Diff of a path between two revisions (`from` may be None for a root commit).
pub fn rev_raw(repo: &Path, from: Option<&str>, to: &str, path: &str, opts: &DiffOptions) -> GitResult<Vec<u8>> {
    let mut args = vec!["diff".to_string()];
    args.extend(base_args(opts));
    args.push(match from {
        Some(from) => from.to_owned(),
        None => empty_tree(repo)?,
    });
    args.push(to.to_string());
    args.push("--".into());
    args.push(path.into());
    if let Some(old) = opts.rename_from.as_ref().filter(|old| old.as_str() != path) {
        args.push(old.clone());
    }
    let out = runner::exec_full(repo, &args, &[("GIT_LITERAL_PATHSPECS", "1")], None)?;
    if !out.ok() {
        return Err(runner::to_error("git diff", &out));
    }
    Ok(out.stdout)
}

pub fn rev_diff(repo: &Path, from: Option<&str>, to: &str, path: &str, opts: &DiffOptions) -> GitResult<FileDiff> {
    let raw = rev_raw(repo, from, to, path, opts)?;
    let hash = fingerprint(&raw);
    let files = parse(&raw);
    let pick = files.iter().find(|f| f.new_path.as_deref() == Some(path)).or_else(|| files.first());
    Ok(match pick {
        Some(f) => to_display(f, path, hash),
        None => FileDiff { path: path.to_string(), hash, empty: true, ..Default::default() },
    })
}

/// Builds a patch containing only the selected lines.
///
/// `reverse` = the patch will be applied with `-R` (unstage / discard): then unselected
/// additions become context and unselected deletions are dropped. For forward application
/// (stage) unselected deletions become context and unselected additions are dropped.
pub fn build_partial_patch(file: &RawFileDiff, selected: &HashSet<(usize, usize)>, reverse: bool) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    // A partial patch of a created (or deleted) file must not claim to create/delete the
    // whole file, otherwise `git apply` expects the complete content. Describe it as a
    // modification of the existing file instead.
    let changes = file.hunks.iter().enumerate().flat_map(|(hi, h)| h.lines.iter().enumerate().map(move |(li, l)| (hi, li, l.kind)));
    let (mut total, mut picked) = (0usize, 0usize);
    for (hi, li, k) in changes {
        if k == b'+' || k == b'-' {
            total += 1;
            if selected.contains(&(hi, li)) {
                picked += 1;
            }
        }
    }
    let as_modification = picked < total && ((file.is_new && reverse) || (file.is_deleted && !reverse));
    let path = file.new_path.clone().or_else(|| file.old_path.clone()).unwrap_or_default();
    for h in &file.header {
        if as_modification {
            let t = String::from_utf8_lossy(h);
            let t = t.trim_end_matches(['\n', '\r']);
            if t.starts_with("new file mode") || t.starts_with("deleted file mode") || t.starts_with("index ") {
                continue;
            }
            if t == "--- /dev/null" {
                out.extend_from_slice(format!("--- a/{path}\n").as_bytes());
                continue;
            }
            if t == "+++ /dev/null" {
                out.extend_from_slice(format!("+++ b/{path}\n").as_bytes());
                continue;
            }
        }
        out.extend_from_slice(h);
    }
    let mut any = false;
    let mut delta: i64 = 0;
    for (hi, h) in file.hunks.iter().enumerate() {
        let has_sel = h.lines.iter().enumerate().any(|(li, l)| (l.kind == b'+' || l.kind == b'-') && selected.contains(&(hi, li)));
        if !has_sel {
            continue;
        }
        let mut body: Vec<u8> = Vec::new();
        let (mut old_count, mut new_count) = (0i64, 0i64);
        let mut prev_kept = true;
        for (li, l) in h.lines.iter().enumerate() {
            let sel = selected.contains(&(hi, li));
            let emit_kind = match l.kind {
                b' ' => Some(b' '),
                b'+' if sel => Some(b'+'),
                b'-' if sel => Some(b'-'),
                b'+' => {
                    if reverse {
                        Some(b' ')
                    } else {
                        None
                    }
                }
                b'-' => {
                    if reverse {
                        None
                    } else {
                        Some(b' ')
                    }
                }
                b'\\' => {
                    if prev_kept {
                        body.push(b'\\');
                        body.extend_from_slice(&l.content);
                        if !l.content.ends_with(b"\n") {
                            body.push(b'\n');
                        }
                    }
                    continue;
                }
                _ => None,
            };
            match emit_kind {
                Some(k) => {
                    body.push(k);
                    body.extend_from_slice(&l.content);
                    if !l.content.ends_with(b"\n") {
                        // Content without newline must be followed by the marker line, which comes next.
                        body.push(b'\n');
                    }
                    match k {
                        b' ' => {
                            old_count += 1;
                            new_count += 1
                        }
                        b'-' => old_count += 1,
                        b'+' => new_count += 1,
                        _ => {}
                    }
                    prev_kept = true;
                }
                None => prev_kept = false,
            }
        }
        let (old_start, new_start) = if reverse {
            let ns = h.new_start as i64;
            (ns - delta, ns)
        } else {
            let os = h.old_start as i64;
            (os, os + delta)
        };
        delta += new_count - old_count;
        out.extend_from_slice(format!("@@ -{},{} +{},{} @@\n", old_start.max(0), old_count, new_start.max(0), new_count).as_bytes());
        out.extend_from_slice(&body);
        any = true;
    }
    if any {
        Some(out)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelectionMode {
    Stage,
    Unstage,
    Discard,
}

/// Applies a hunk/line selection of a working copy diff.
#[allow(clippy::too_many_arguments)]
pub fn apply_selection(
    repo: &Path,
    path: &str,
    mode: SelectionMode,
    selection: &[(usize, usize)],
    expected_hash: &str,
    staged_base: Option<&str>,
    untracked: bool,
    opts: &DiffOptions,
) -> GitResult<()> {
    let side = if mode == SelectionMode::Unstage { WorkSide::Staged } else { WorkSide::Unstaged };
    let raw = working_raw(repo, path, side, staged_base, untracked, opts)?;
    if fingerprint(&raw) != expected_hash {
        return Err(GitError::new("The file changed since the diff was shown. Refresh and try again.").kind("stale"));
    }
    if untracked && mode == SelectionMode::Stage {
        // Make the file known to the index so a normal patch can be applied.
        runner::run(repo, ["add", "--intent-to-add", "--", path])?;
    }
    // Stage the validated snapshot. A second worktree read can return different
    // lines while retaining the selection's old numeric coordinates.
    let raw = if untracked || mode == SelectionMode::Stage { raw } else { working_raw(repo, path, side, staged_base, false, opts)? };
    let files = parse(&raw);
    let Some(file) = files.into_iter().next() else {
        return Err(GitError::new("Nothing to apply."));
    };
    apply_selection_patch(repo, &file, mode, selection)
}

fn apply_selection_patch(repo: &Path, file: &RawFileDiff, mode: SelectionMode, selection: &[(usize, usize)]) -> GitResult<()> {
    // Selection indexes refer to the exact diff displayed for this operation.
    let sel: HashSet<(usize, usize)> = selection.iter().copied().collect();
    let reverse = mode != SelectionMode::Stage;
    let Some(patch) = build_partial_patch(file, &sel, reverse) else {
        return Err(GitError::new("No changed lines selected."));
    };
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    match mode {
        SelectionMode::Stage => args.push("--cached"),
        SelectionMode::Unstage => {
            args.push("--cached");
            args.push("-R");
        }
        SelectionMode::Discard => args.push("-R"),
    }
    args.push("-");
    runner::run_env(repo, &args, &[], Some(&patch))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/f.txt b/f.txt\nindex 111..222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n+D\n";

    #[test]
    fn parses_and_displays() {
        let files = parse(SAMPLE.as_bytes());
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.new_path.as_deref(), Some("f.txt"));
        assert_eq!(f.hunks.len(), 1);
        assert_eq!(f.hunks[0].lines.len(), 6);
        let d = to_display(f, "f.txt", "h".into());
        assert_eq!((d.additions, d.deletions), (2, 2));
        assert_eq!(d.hunks[0].lines[1].old_no, Some(2));
        assert_eq!(d.hunks[0].lines[2].new_no, Some(2));
    }

    #[test]
    fn partial_forward_patch() {
        let files = parse(SAMPLE.as_bytes());
        // select only "-b" and "+B"
        let sel: HashSet<(usize, usize)> = [(0, 1), (0, 2)].into_iter().collect();
        let p = String::from_utf8(build_partial_patch(&files[0], &sel, false).unwrap()).unwrap();
        assert!(p.contains("@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d\n"), "{p}");
    }

    #[test]
    fn partial_reverse_patch() {
        let files = parse(SAMPLE.as_bytes());
        let sel: HashSet<(usize, usize)> = [(0, 4), (0, 5)].into_iter().collect();
        let p = String::from_utf8(build_partial_patch(&files[0], &sel, true).unwrap()).unwrap();
        assert!(p.contains(" a\n B\n c\n-d\n+D\n"), "{p}");
    }
}
