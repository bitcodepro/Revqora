//! Repository housekeeping and pre-commit checks.

use std::path::Path;

use serde::Serialize;

use super::runner::{self, GitError, GitResult};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoSize {
    pub loose_objects: u64,
    pub loose_size_kib: u64,
    pub packs: u64,
    pub pack_size_kib: u64,
    pub garbage: u64,
    pub commit_graph: bool,
    pub maintenance_registered: bool,
}

pub fn parse_count_objects(raw: &str) -> RepoSize {
    let mut s = RepoSize::default();
    for l in raw.lines() {
        let Some((k, v)) = l.split_once(':') else { continue };
        let n: u64 = v.trim().parse().unwrap_or(0);
        match k.trim() {
            "count" => s.loose_objects = n,
            "size" => s.loose_size_kib = n,
            "packs" => s.packs = n,
            "size-pack" => s.pack_size_kib = n,
            "garbage" => s.garbage = n,
            _ => {}
        }
    }
    s
}

pub fn size(repo: &Path) -> GitResult<RepoSize> {
    let mut s = parse_count_objects(&runner::run(repo, ["count-objects", "-v"])?);
    s.commit_graph = super::graph::has_commit_graph(repo);
    let top = runner::run(repo, ["rev-parse", "--show-toplevel"]).unwrap_or_default();
    let registered = runner::run(repo, ["config", "--global", "--get-all", "maintenance.repo"]).unwrap_or_default();
    let norm = |p: &str| p.trim().replace('\\', "/").to_lowercase();
    s.maintenance_registered = registered.lines().any(|l| norm(l) == norm(&top));
    Ok(s)
}

/// Runs a housekeeping task: "gc" | "prune" | "maintenance-start" | "maintenance-stop" | "repack".
pub fn run(repo: &Path, task: &str, on_line: impl FnMut(&str)) -> GitResult<String> {
    let args: Vec<String> = match task {
        "gc" => vec!["gc".into()],
        "prune" => vec!["prune".into(), "--verbose".into()],
        "repack" => vec!["repack".into(), "-a".into(), "-d".into()],
        "maintenance-start" => vec!["maintenance".into(), "start".into()],
        "maintenance-stop" => vec!["maintenance".into(), "unregister".into()],
        _ => return Err(GitError::new("Unknown maintenance task.")),
    };
    runner::run_streaming(repo, &args, &[], on_line)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub path: String,
    pub size: u64,
}

/// Staged blobs bigger than `threshold` bytes. LFS pointers are already small;
/// attributes alone do not prove the staged blob was converted to a pointer.
pub fn large_staged_files(repo: &Path, threshold: u64) -> GitResult<Vec<LargeFile>> {
    let raw = runner::run_bytes(repo, ["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "--diff-filter=AMT", "-z", "--"])?;
    let invalid = || GitError::new("Git returned an incomplete staged file size check.");
    let raw = String::from_utf8_lossy(&raw);
    let mut entries = runner::split_nul(&raw);
    let mut paths = Vec::new();
    let mut input = String::new();
    while let Some(metadata) = entries.next() {
        let mut fields = metadata.split_whitespace();
        let mode = fields.nth(1).ok_or_else(invalid)?;
        let oid = fields.nth(1).ok_or_else(invalid)?;
        let path = entries.next().ok_or_else(invalid)?;
        if mode == "160000" {
            continue; // A staged submodule points to a commit, not a local blob.
        }
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        paths.push(path);
        input.push_str(oid);
        input.push('\n');
    }
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let sizes = runner::run_env(repo, ["cat-file", "--batch-check=%(objectsize)"], &[], Some(input.as_bytes()))?;
    let mut sizes = sizes.lines();
    let mut big = Vec::new();
    for path in paths {
        let size = sizes.next().and_then(|size| size.trim().parse::<u64>().ok()).ok_or_else(invalid)?;
        if size > threshold {
            big.push(LargeFile { path: path.to_string(), size });
        }
    }
    if sizes.next().is_some() {
        return Err(invalid());
    }
    Ok(big)
}

#[cfg(test)]
mod tests {
    use super::parse_count_objects;

    #[test]
    fn parses_count_objects() {
        let s = parse_count_objects("count: 12\nsize: 48\nin-pack: 300\npacks: 2\nsize-pack: 1024\nprune-packable: 0\ngarbage: 1\nsize-garbage: 4\n");
        assert_eq!((s.loose_objects, s.loose_size_kib, s.packs, s.pack_size_kib, s.garbage), (12, 48, 2, 1024, 1));
    }
}
