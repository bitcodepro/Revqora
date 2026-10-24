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

/// Staged files bigger than `threshold` bytes that Git LFS does not handle.
pub fn large_staged_files(repo: &Path, threshold: u64) -> GitResult<Vec<LargeFile>> {
    let names = runner::run(repo, ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z"])?;
    let paths: Vec<&str> = runner::split_nul(&names).collect();
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = String::new();
    for p in &paths {
        input.push_str(&format!(":{p}\n"));
    }
    let sizes = runner::run_env(repo, ["cat-file", "--batch-check=%(objectsize)"], &[], Some(input.as_bytes()))?;
    let mut big: Vec<LargeFile> = sizes
        .lines()
        .zip(paths.iter())
        .filter_map(|(sz, p)| sz.trim().parse::<u64>().ok().filter(|n| *n > threshold).map(|n| LargeFile { path: p.to_string(), size: n }))
        .collect();
    if big.is_empty() {
        return Ok(big);
    }
    // Drop files already routed through LFS (their blob is a tiny pointer anyway, but be safe).
    let mut args = vec!["check-attr".to_string(), "filter".into(), "--".into()];
    args.extend(big.iter().map(|f| f.path.clone()));
    let attrs = runner::run(repo, &args).unwrap_or_default();
    big.retain(|f| !attrs.lines().any(|l| l.starts_with(&format!("{}: filter: lfs", f.path))));
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
