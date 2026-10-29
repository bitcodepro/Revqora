//! Batched, read-only branch inventory. Merged means physical reachability, not patch equivalence.
use super::{
    branch_deletion, extras, history, operations,
    runner::{GitError, GitResult},
};
use serde::Serialize;
use std::{collections::BTreeSet, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub full_ref: String,
    pub name: String,
    pub oid: String,
    pub local: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub gone: bool,
    pub time: i64,
    pub author: String,
    pub subject: String,
    pub merged: Option<bool>,
    pub protection_names: Vec<String>,
    pub mapping_known: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub branches: Vec<Branch>,
    pub worktrees: Vec<extras::Worktree>,
    pub base_ref: Option<String>,
    pub base_oid: Option<String>,
}
#[derive(Serialize)]
pub struct Distance {
    pub ahead: u64,
    pub behind: u64,
}

fn inventory(root: &Path) -> GitResult<Vec<Branch>> {
    let format = "--format=%(refname)%00%(objectname)%00%(symref)%00%(HEAD)%00%(upstream)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(authorname)%00%(contents:subject)%00";
    let raw = history::run(root, ["for-each-ref", format, "refs/heads/", "refs/remotes/"])?;
    let mut branches = Vec::new();
    // Each record has nine NUL-terminated fields plus Git's record newline.
    let fields: Vec<&str> = raw.split_terminator('\0').collect();
    let (records, tail) = fields.as_chunks::<9>();
    if tail.iter().any(|s| !s.trim_matches('\n').is_empty()) {
        return Err(GitError::new("Invalid branch metadata record."));
    }
    for f in records {
        let full_ref = f[0].trim_start_matches('\n');
        if !(full_ref.starts_with("refs/heads/") || full_ref.starts_with("refs/remotes/"))
            || !matches!(f[1].len(), 40 | 64)
            || !f[1].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(GitError::new("Invalid branch metadata record."));
        }
        if !f[2].is_empty() {
            continue;
        } // symbolic remote HEAD is an alias, not a branch
        let local = full_ref.starts_with("refs/heads/");
        let name = full_ref.strip_prefix(if local { "refs/heads/" } else { "refs/remotes/" }).unwrap_or(full_ref);
        let track = |kind: &str| f[5].split(',').find_map(|s| s.trim().strip_prefix(kind)?.parse().ok()).unwrap_or(0);
        branches.push(Branch {
            full_ref: full_ref.into(),
            name: name.into(),
            oid: f[1].into(),
            local,
            current: f[3] == "*",
            upstream: (!f[4].is_empty()).then(|| f[4].into()),
            ahead: track("ahead "),
            behind: track("behind "),
            gone: f[5] == "gone",
            time: f[6].parse().unwrap_or(0),
            author: f[7].into(),
            subject: f[8].into(),
            merged: None,
            protection_names: vec![name.into()],
            mapping_known: local,
        });
    }
    let mappings = branch_deletion::tracking_sources(root, branches.iter().filter(|b| !b.local).map(|b| b.full_ref.as_str()))?;
    for b in &mut branches {
        if let Some(sources) = mappings.get(&b.full_ref) {
            b.mapping_known = sources.len() == 1;
            b.protection_names.extend(sources.iter().map(|(_, source)| source.trim_start_matches("refs/heads/").to_owned()));
        }
    }
    Ok(branches)
}
pub fn snapshot(root: &Path, requested_base: Option<&str>) -> GitResult<Snapshot> {
    operations::read(root, || {
        let mut branches = inventory(root)?;
        let base_ref = requested_base
            .filter(|r| branches.iter().any(|b| b.full_ref == *r))
            .map(str::to_owned)
            .or_else(|| ["main", "master", "develop"].iter().find_map(|n| branches.iter().find(|b| b.local && b.name == *n).map(|b| b.full_ref.clone())))
            .or_else(|| branches.iter().find(|b| b.current).or(branches.first()).map(|b| b.full_ref.clone()));
        let base_oid = base_ref.as_ref().and_then(|r| branches.iter().find(|b| b.full_ref == *r)).map(|b| b.oid.clone());
        if let Some(base) = &base_oid {
            let raw = history::run(root, ["for-each-ref", &format!("--merged={base}"), "--format=%(refname)", "refs/heads/", "refs/remotes/"])?;
            let merged: BTreeSet<&str> = raw.lines().collect();
            for b in &mut branches {
                b.merged = Some(merged.contains(b.full_ref.as_str()));
            }
        }
        let worktrees = extras::worktrees(root)?;
        // External Git is outside our process lock. Do not present mixed ref generations.
        let after = inventory(root)?;
        if branches.len() != after.len()
            || branches.iter().zip(&after).any(|(a, b)| {
                a.full_ref != b.full_ref
                    || a.oid != b.oid
                    || a.current != b.current
                    || a.upstream != b.upstream
                    || a.protection_names != b.protection_names
                    || a.mapping_known != b.mapping_known
            })
        {
            return Err(GitError::new("Branches changed while loading. Refresh the branch manager.").kind("stale-operation"));
        }
        Ok(Snapshot { branches, worktrees, base_ref, base_oid })
    })
}
pub fn compare(root: &Path, base: &str, tip: &str) -> GitResult<Distance> {
    for oid in [base, tip] {
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(GitError::new("Comparison requires exact commit IDs."));
        }
    }
    operations::read(root, || {
        let raw = history::run(root, ["rev-list", "--left-right", "--count", &format!("{base}...{tip}"), "--"])?;
        let mut counts = raw.split_whitespace();
        let behind = counts.next().and_then(|v| v.parse().ok()).ok_or_else(|| GitError::new("Invalid comparison output"))?;
        let ahead = counts.next().and_then(|v| v.parse().ok()).ok_or_else(|| GitError::new("Invalid comparison output"))?;
        Ok(Distance { ahead, behind })
    })
}
