//! Pages of large answers for MCP tools: a diff, the branches, the changed files. Built here
//! from the full answer, so only the page crosses to the window that relays it to the client.
//! Text offsets are UTF-16 code units, as MCP clients received them before.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::git::diff::FileDiff;
use crate::git::runner::{GitError, GitResult};

/// Bytes of diff lines in one page (the client's result limit leaves room for the rest).
const PAGE_BYTES: usize = 112_000;
/// Changed files in one `repository_status` page.
const STATUS_PAGE: usize = 200;
/// Branches in one `list_branches` page.
const BRANCH_PAGE: usize = 100;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffPageOptions {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub diff_version: Option<String>,
    pub line_offset: Option<usize>,
    pub conflict_side: Option<String>,
}

fn invalid(message: &str) -> GitError {
    GitError::new(message).kind("invalid-arguments")
}

/// The version a continued read names must still be the diff's.
pub fn assert_diff_version(version: &str, options: &DiffPageOptions) -> GitResult<()> {
    if options.diff_version.as_deref().is_some_and(|known| known != version) {
        return Err(GitError::new("The diff changed. Restart at offset 0 and use the new diffVersion.").kind("diff-changed"));
    }
    if options.diff_version.is_none() && (options.offset.unwrap_or(0) > 0 || options.line_offset.is_some()) {
        return Err(GitError::new("Pass diffVersion from the first page when requesting another page or continuing a line.").kind("diff-version-required"));
    }
    Ok(())
}

/// `size` UTF-16 units of `text` from `start`, never splitting a surrogate pair, and where the
/// next chunk starts (none at the end).
fn text_chunk(text: &str, start: usize, size: usize) -> GitResult<(String, Option<usize>)> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let low = |at: usize| units.get(at).is_some_and(|unit| (0xdc00..=0xdfff).contains(unit));
    if start > units.len() || low(start) {
        return Err(invalid("Use the nextTextOffset from the preceding line chunk."));
    }
    let mut end = units.len().min(start + size);
    if low(end) {
        end -= 1;
    }
    Ok((String::from_utf16_lossy(&units[start..end]), (end < units.len()).then_some(end)))
}

fn json_size(value: &Value) -> usize {
    serde_json::to_vec(value).map(|bytes| bytes.len()).unwrap_or(0)
}

/// One page of `diff`: lines from `offset`, at most `limit` (400) and [`PAGE_BYTES`], each line's
/// text cut at 600 units; or one line from `lineOffset`, in chunks of 16 000 units.
pub fn diff_page(diff: FileDiff, options: &DiffPageOptions) -> GitResult<Value> {
    assert_diff_version(&diff.hash, options)?;
    if options.conflict_side.is_some() {
        return Err(invalid("conflictSide applies only to a conflicted file."));
    }
    let offset = options.offset.unwrap_or(0);
    let line_offset = options.line_offset;
    let limit = if line_offset.is_none() { options.limit.unwrap_or(400) } else { 1 };
    let total: usize = diff.hunks.iter().map(|hunk| hunk.lines.len()).sum();
    if line_offset.is_some() && offset >= total {
        return Err(invalid("The requested diff line does not exist."));
    }
    let mut items = Vec::new();
    let (mut start, mut returned, mut size, mut truncated) = (0usize, 0usize, 0usize, false);
    for hunk in &diff.hunks {
        if returned == limit {
            break;
        }
        let first = offset.saturating_sub(start);
        if first < hunk.lines.len() {
            let header: String = hunk.header.chars().take(600).collect();
            let header_size = json_size(&json!({ "header": header, "lines": [] })) + 1;
            let mut lines = Vec::new();
            for (i, line) in hunk.lines.iter().enumerate().skip(first) {
                if returned >= limit {
                    break;
                }
                let (text, next) = text_chunk(&line.text, line_offset.unwrap_or(0), if line_offset.is_none() { 600 } else { 16_000 })?;
                let item =
                    json!({ "kind": line.kind, "oldNo": line.old_no, "newNo": line.new_no, "text": text, "nextTextOffset": next, "lineIndex": start + i });
                let bytes = json_size(&item) + 1 + if lines.is_empty() { header_size } else { 0 };
                if size + bytes > PAGE_BYTES {
                    break;
                }
                lines.push(item);
                size += bytes;
                returned += 1;
                truncated |= next.is_some();
            }
            let shown = lines.len();
            if shown > 0 {
                items.push(json!({ "header": header, "lines": lines }));
            }
            if first + shown < hunk.lines.len() {
                break;
            }
        }
        start += hunk.lines.len();
    }
    let next = offset + returned;
    let version = diff.hash.clone();
    let mut summary = match serde_json::to_value(&diff) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    summary.remove("hunks");
    summary.remove("hash");
    summary.insert("diffVersion".into(), json!(version));
    summary.insert("hunks".into(), Value::Array(items));
    summary.insert("totalLines".into(), json!(total));
    summary.insert("lineTextTruncated".into(), json!(truncated));
    summary.insert("nextOffset".into(), json!((line_offset.is_none() && next < total).then_some(next)));
    Ok(Value::Object(summary))
}

/// `{ items, total, nextOffset }` for `items[offset..offset + size]`.
pub fn page<T: serde::Serialize>(items: &[T], offset: usize, size: usize) -> Value {
    let end = items.len().min(offset.saturating_add(size));
    let shown = items.get(offset.min(items.len())..end).unwrap_or(&[]);
    json!({ "items": shown, "total": items.len(), "nextOffset": (offset.saturating_add(size) < items.len()).then_some(offset + size) })
}

/// `list_branches`: local, remote or all branches whose name contains `query` (any case).
pub fn branch_page(snapshot: &crate::git::refs::RefsSnapshot, scope: Option<&str>, query: Option<&str>, offset: usize) -> Value {
    let all: Vec<&crate::git::refs::BranchInfo> = match scope {
        Some("local") => snapshot.local.iter().collect(),
        Some("remote") => snapshot.remote.iter().collect(),
        _ => snapshot.local.iter().chain(&snapshot.remote).collect(),
    };
    let query = query.filter(|q| !q.is_empty()).map(str::to_lowercase);
    let matching: Vec<_> = all.into_iter().filter(|branch| query.as_ref().is_none_or(|q| branch.name.to_lowercase().contains(q))).collect();
    page(&matching, offset, BRANCH_PAGE)
}

/// `repository_status`: the summary with one page of changed files, versioned by the status
/// token; a continued read whose version moved must start again.
pub fn status_page(status: &impl serde::Serialize, status_version: Option<&str>, offset: usize) -> GitResult<Value> {
    let Ok(Value::Object(mut summary)) = serde_json::to_value(status) else {
        return Err(GitError::new("The repository status could not be read."));
    };
    let version = summary.remove("stateToken").and_then(|token| token.as_str().map(str::to_owned)).filter(|token| !token.is_empty());
    summary.remove("diffContextToken");
    let files = match summary.remove("files") {
        Some(Value::Array(files)) => files,
        _ => Vec::new(),
    };
    let Some(version) = version.filter(|version| status_version.is_none_or(|known| known == version)) else {
        return Err(GitError::new("The repository status changed. Restart at offset 0.").kind("stale-operation"));
    };
    let files: Vec<Value> = files
        .into_iter()
        .map(|mut file| {
            if let Value::Object(map) = &mut file {
                map.remove("diffToken");
            }
            file
        })
        .collect();
    summary.insert("statusVersion".into(), json!(version));
    summary.insert("files".into(), page(&files, offset, STATUS_PAGE));
    Ok(Value::Object(summary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::{DiffHunk, DiffLine};

    fn diff(lines: usize, text: &str) -> FileDiff {
        let lines = (0..lines).map(|i| DiffLine { kind: "add".into(), old_no: None, new_no: Some(i as u32 + 1), text: text.to_owned() }).collect();
        FileDiff {
            path: "a.txt".into(),
            hash: "v1".into(),
            hunks: vec![DiffHunk { header: "@@ -0,0 +1 @@".into(), old_start: 0, old_lines: 0, new_start: 1, new_lines: 1, lines }],
            ..Default::default()
        }
    }

    #[test]
    fn a_diff_is_paged_by_lines_and_bytes_and_a_long_line_by_chunks() {
        let page = diff_page(diff(1000, "x"), &DiffPageOptions::default()).unwrap();
        assert_eq!(page["totalLines"], 1000);
        assert_eq!(page["hunks"][0]["lines"].as_array().unwrap().len(), 400);
        assert_eq!(page["nextOffset"], 400);
        assert_eq!(page["diffVersion"], "v1");
        assert!(page.get("hash").is_none());
        assert_eq!(page["path"], "a.txt");
        let next = diff_page(diff(1000, "x"), &DiffPageOptions { offset: Some(800), diff_version: Some("v1".into()), ..Default::default() }).unwrap();
        assert_eq!(next["hunks"][0]["lines"][0]["lineIndex"], 800);
        assert_eq!(next["nextOffset"], Value::Null);
        // Long lines: cut at 600 units, and the page stays within its byte budget.
        let wide = diff_page(diff(400, &"y".repeat(5000)), &DiffPageOptions::default()).unwrap();
        let shown = wide["hunks"][0]["lines"].as_array().unwrap();
        assert!(shown.len() < 400 && shown.len() > 100, "{}", shown.len());
        assert_eq!(shown[0]["text"].as_str().unwrap().len(), 600);
        assert_eq!(shown[0]["nextTextOffset"], 600);
        assert_eq!(wide["lineTextTruncated"], true);
        let line = diff_page(
            diff(3, &"y".repeat(20_000)),
            &DiffPageOptions { offset: Some(1), line_offset: Some(16_000), diff_version: Some("v1".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(line["hunks"][0]["lines"][0]["text"].as_str().unwrap().len(), 4000);
        assert_eq!(line["hunks"][0]["lines"][0]["nextTextOffset"], Value::Null);
        assert_eq!(line["nextOffset"], Value::Null);
    }

    #[test]
    fn versions_and_offsets_are_checked_as_before() {
        let changed = diff_page(diff(3, "x"), &DiffPageOptions { diff_version: Some("old".into()), ..Default::default() }).unwrap_err();
        assert_eq!(changed.kind, "diff-changed");
        let unversioned = diff_page(diff(3, "x"), &DiffPageOptions { offset: Some(1), ..Default::default() }).unwrap_err();
        assert_eq!(unversioned.kind, "diff-version-required");
        let missing =
            diff_page(diff(3, "x"), &DiffPageOptions { offset: Some(3), line_offset: Some(0), diff_version: Some("v1".into()), ..Default::default() })
                .unwrap_err();
        assert_eq!(missing.kind, "invalid-arguments");
        // A surrogate pair is never split: an offset inside one is refused.
        let emoji = diff_page(diff(1, "😀😀"), &DiffPageOptions { line_offset: Some(1), diff_version: Some("v1".into()), ..Default::default() }).unwrap_err();
        assert_eq!(emoji.kind, "invalid-arguments");
        let (text, next) = text_chunk("a😀b", 0, 2).unwrap();
        assert_eq!((text.as_str(), next), ("a", Some(1)));
    }

    #[test]
    fn status_pages_drop_tokens_and_refuse_a_moved_version() {
        let status = json!({ "stateToken": "s1", "diffContextToken": "d", "branch": "main", "files": (0..250).map(|i| json!({ "path": format!("f{i}"), "diffToken": "t" })).collect::<Vec<_>>() });
        let first = status_page(&status, None, 0).unwrap();
        assert_eq!(first["statusVersion"], "s1");
        assert_eq!(first["branch"], "main");
        assert!(first.get("diffContextToken").is_none() && first.get("stateToken").is_none());
        assert_eq!(first["files"]["total"], 250);
        assert_eq!(first["files"]["nextOffset"], 200);
        assert!(first["files"]["items"][0].get("diffToken").is_none());
        let rest = status_page(&status, Some("s1"), 200).unwrap();
        assert_eq!(rest["files"]["items"].as_array().unwrap().len(), 50);
        assert_eq!(rest["files"]["nextOffset"], Value::Null);
        assert_eq!(status_page(&status, Some("s0"), 200).unwrap_err().kind, "stale-operation");
    }
}
