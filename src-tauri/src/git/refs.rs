//! Branches, remotes, tags and stashes.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::runner::{self, GitResult};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    /// "head" (current branch) | "local" | "remote" | "tag" | "detached"
    pub kind: String,
    /// Remote branch with the same name as a local branch at the same commit.
    pub synced_remote: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
    pub is_head: bool,
    pub remote: Option<String>,
    pub time: i64,
    pub subject: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub oid: String,
    pub target: String,
    pub annotated: bool,
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: u32,
    pub name: String,
    pub oid: String,
    pub time: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
    pub tags: Vec<TagInfo>,
    pub stashes: Vec<StashInfo>,
    pub remotes: Vec<RemoteInfo>,
}

const FMT: &str = "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(creatordate:unix)%1f%(contents:subject)%1f%(authorname)%1f%(symref)%1f%(objecttype)";

fn parse_track(t: &str) -> (u32, u32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    let gone = t.contains("gone");
    for part in t.split(',') {
        let p = part.trim();
        if let Some(n) = p.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = p.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, gone)
}

pub fn snapshot(repo: &Path) -> GitResult<RefsSnapshot> {
    let raw = runner::run(repo, ["for-each-ref", FMT, "refs/heads", "refs/remotes", "refs/tags"])?;
    let mut local = Vec::new();
    let mut remote = Vec::new();
    let mut tags = Vec::new();
    for line in raw.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 11 {
            continue;
        }
        let full = f[0];
        let time = f[6].parse().unwrap_or(0);
        if let Some(name) = full.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = parse_track(f[4]);
            local.push(BranchInfo {
                name: name.to_string(),
                full_name: full.to_string(),
                oid: f[1].to_string(),
                upstream: Some(f[3].to_string()).filter(|s| !s.is_empty()),
                ahead,
                behind,
                gone,
                is_head: f[5] == "*",
                remote: None,
                time,
                subject: f[7].to_string(),
                author: f[8].to_string(),
            });
        } else if let Some(name) = full.strip_prefix("refs/remotes/") {
            if !f[9].is_empty() {
                continue; // origin/HEAD symref
            }
            let remote_name = name.split('/').next().unwrap_or("").to_string();
            remote.push(BranchInfo {
                name: name.to_string(),
                full_name: full.to_string(),
                oid: f[1].to_string(),
                upstream: None,
                ahead: 0,
                behind: 0,
                gone: false,
                is_head: false,
                remote: Some(remote_name),
                time,
                subject: f[7].to_string(),
                author: f[8].to_string(),
            });
        } else if let Some(name) = full.strip_prefix("refs/tags/") {
            let annotated = f[10] == "tag";
            tags.push(TagInfo {
                name: name.to_string(),
                oid: f[1].to_string(),
                target: if annotated && !f[2].is_empty() { f[2].to_string() } else { f[1].to_string() },
                annotated,
                time,
                subject: f[7].to_string(),
            });
        }
    }
    tags.sort_by_key(|t| std::cmp::Reverse(t.time));
    Ok(RefsSnapshot { local, remote, tags, stashes: stashes(repo)?, remotes: remotes(repo)? })
}

pub fn stashes(repo: &Path) -> GitResult<Vec<StashInfo>> {
    let out = runner::exec(repo, ["stash", "list", "--format=%gd%x1f%H%x1f%ct%x1f%gs"])?;
    if !out.ok() {
        return Ok(Vec::new());
    }
    Ok(out
        .text()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(4, '\x1f').collect();
            if f.len() < 4 {
                return None;
            }
            let index = f[0].trim_start_matches("stash@{").trim_end_matches('}').parse().unwrap_or(0);
            Some(StashInfo { index, name: f[0].to_string(), oid: f[1].to_string(), time: f[2].parse().unwrap_or(0), message: f[3].to_string() })
        })
        .collect())
}

pub fn remotes(repo: &Path) -> GitResult<Vec<RemoteInfo>> {
    let raw = runner::run(repo, ["remote", "-v"])?;
    let mut map: Vec<RemoteInfo> = Vec::new();
    for l in raw.lines() {
        let mut it = l.split_whitespace();
        let (Some(name), Some(url), kind) = (it.next(), it.next(), it.next().unwrap_or("")) else { continue };
        let entry = match map.iter_mut().find(|r| r.name == name) {
            Some(e) => e,
            None => {
                map.push(RemoteInfo { name: name.to_string(), fetch_url: String::new(), push_url: String::new() });
                map.last_mut().unwrap()
            }
        };
        if kind.contains("push") {
            entry.push_url = url.to_string();
        } else {
            entry.fetch_url = url.to_string();
        }
    }
    Ok(map)
}

/// Ref decorations keyed by the commit they point to.
pub fn labels_by_oid(repo: &Path) -> GitResult<HashMap<String, Vec<RefLabel>>> {
    let raw = runner::run(
        repo,
        [
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(HEAD)%1f%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/bisect",
        ],
    )?;
    let head_detached = runner::exec(repo, ["symbolic-ref", "-q", "HEAD"])?.code != 0;
    let mut map: HashMap<String, Vec<RefLabel>> = HashMap::new();
    let mut remote_at: HashMap<String, Vec<String>> = HashMap::new();
    let mut entries = Vec::new();
    for line in raw.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 5 || !f[4].is_empty() {
            continue;
        }
        let oid = if !f[2].is_empty() { f[2] } else { f[1] };
        entries.push((f[0].to_string(), oid.to_string(), f[3] == "*"));
        if let Some(n) = f[0].strip_prefix("refs/remotes/") {
            remote_at.entry(oid.to_string()).or_default().push(n.to_string());
        }
    }
    let mut consumed_remote: HashMap<(String, String), ()> = HashMap::new();
    for (full, oid, is_head) in &entries {
        if let Some(n) = full.strip_prefix("refs/heads/") {
            // Fold "origin/<same name>" into the local badge when both point here.
            let synced = remote_at.get(oid).and_then(|rs| rs.iter().find(|r| r.split_once('/').map(|(_, b)| b == n).unwrap_or(false))).cloned();
            if let Some(s) = &synced {
                consumed_remote.insert((oid.clone(), s.clone()), ());
            }
            map.entry(oid.clone()).or_default().push(RefLabel {
                name: n.to_string(),
                kind: if *is_head { "head".into() } else { "local".into() },
                synced_remote: synced,
            });
        }
    }
    for (full, oid, _) in &entries {
        if let Some(n) = full.strip_prefix("refs/remotes/") {
            if consumed_remote.contains_key(&(oid.clone(), n.to_string())) {
                continue;
            }
            map.entry(oid.clone()).or_default().push(RefLabel { name: n.to_string(), kind: "remote".into(), synced_remote: None });
        } else if let Some(n) = full.strip_prefix("refs/tags/") {
            map.entry(oid.clone()).or_default().push(RefLabel { name: n.to_string(), kind: "tag".into(), synced_remote: None });
        } else if let Some(n) = full.strip_prefix("refs/bisect/") {
            let name = if n == "bad" {
                "bisect: bad"
            } else if n.starts_with("good") {
                "bisect: good"
            } else {
                "bisect: skip"
            };
            map.entry(oid.clone()).or_default().push(RefLabel { name: name.into(), kind: "bisect".into(), synced_remote: None });
        }
    }
    if head_detached {
        if let Ok(h) = runner::run(repo, ["rev-parse", "-q", "--verify", "HEAD"]) {
            map.entry(h.trim().to_string()).or_default().insert(0, RefLabel { name: "HEAD".into(), kind: "detached".into(), synced_remote: None });
        }
    }
    for v in map.values_mut() {
        let rank = |k: &str| match k {
            "head" | "detached" => 0,
            "local" => 1,
            "remote" => 2,
            _ => 3,
        };
        v.sort_by(|a, b| rank(&a.kind).cmp(&rank(&b.kind)).then(a.name.cmp(&b.name)));
    }
    Ok(map)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDetails {
    pub name: String,
    pub tip: String,
    pub base: String,
    pub fork_point: Option<String>,
    pub fork_subject: Option<String>,
    pub fork_time: Option<i64>,
    pub ahead: u32,
    pub behind: u32,
    pub first_time: Option<i64>,
    pub first_subject: Option<String>,
    pub last_time: i64,
    pub last_subject: String,
    pub authors: Vec<String>,
    pub merged: bool,
}

/// Where a branch started (fork point against `base`), how far it went and whether it is merged.
pub fn branch_details(repo: &Path, name: &str, base: &str) -> GitResult<BranchDetails> {
    let tip = runner::run(repo, ["rev-parse", "--verify", &format!("{name}^{{commit}}")])?.trim().to_string();
    let mb = runner::exec(repo, ["merge-base", base, name])?;
    let fork_point = if mb.ok() { Some(mb.text().trim().to_string()).filter(|s| !s.is_empty()) } else { None };
    let count = |range: &str| -> u32 { runner::run(repo, ["rev-list", "--count", range]).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0) };
    let ahead = count(&format!("{base}..{name}"));
    let behind = count(&format!("{name}..{base}"));
    let meta = |rev: &str| -> Option<(i64, String)> {
        runner::run(repo, ["log", "-1", "--format=%at%x1f%s", rev]).ok().and_then(|s| {
            let (t, subj) = s.trim().split_once('\x1f')?;
            Some((t.parse().ok()?, subj.to_string()))
        })
    };
    let (fork_time, fork_subject) = match fork_point.as_deref().and_then(meta) {
        Some((t, s)) => (Some(t), Some(s)),
        None => (None, None),
    };
    let first = runner::run(repo, ["rev-list", "--reverse", &format!("{base}..{name}")]).ok().and_then(|s| s.lines().next().map(|l| l.trim().to_string()));
    let (first_time, first_subject) = match first.as_deref().and_then(meta) {
        Some((t, s)) => (Some(t), Some(s)),
        None => (None, None),
    };
    let (last_time, last_subject) = meta(&tip).unwrap_or((0, String::new()));
    let mut authors: Vec<String> =
        runner::run(repo, ["log", "--format=%an", &format!("{base}..{name}")]).unwrap_or_default().lines().map(|s| s.to_string()).collect();
    authors.sort();
    authors.dedup();
    Ok(BranchDetails {
        name: name.to_string(),
        tip,
        base: base.to_string(),
        fork_point,
        fork_subject,
        fork_time,
        ahead,
        behind,
        first_time,
        first_subject,
        last_time,
        last_subject,
        authors,
        merged: ahead == 0,
    })
}
