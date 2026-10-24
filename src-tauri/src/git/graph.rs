//! Commit history loading and lane layout for the graph view.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::refs::{self, RefLabel};
use super::runner::{self, GitError, GitResult};

pub const WORKTREE_OID: &str = "WORKTREE";
const PALETTE_SIZE: u16 = 12;

#[derive(Debug, Clone)]
pub struct CommitMeta {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub subject: String,
}

/// One drawable line piece inside a row.
/// `t`: 0 = full height pass-through, 1 = top edge → node centre, 2 = node centre → bottom edge.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Seg {
    pub a: u16,
    pub b: u16,
    pub t: u8,
    pub c: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub index: usize,
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
    pub col: u16,
    pub color: u16,
    pub segs: Vec<Seg>,
    pub is_head: bool,
    pub is_merge: bool,
    /// Commit is not contained in any remote-tracking branch (safe to rewrite).
    pub local_only: bool,
}

#[derive(Debug, Clone)]
pub struct Layout {
    pub col: u16,
    pub color: u16,
    pub segs: Vec<Seg>,
}

/// Assigns lanes to commits given in display order (children before parents).
pub fn layout(commits: &[(String, Vec<String>)]) -> (Vec<Layout>, u16) {
    let mut lanes: Vec<Option<(String, u16)>> = Vec::new();
    let mut next_color: u16 = 0;
    let mut out = Vec::with_capacity(commits.len());
    let mut max_lanes: u16 = 1;
    let alloc_color = |nc: &mut u16| {
        let c = *nc % PALETTE_SIZE;
        *nc += 1;
        c
    };
    for (oid, parents) in commits {
        let mut segs = Vec::new();
        let existing = lanes.iter().position(|l| l.as_ref().map(|(o, _)| o == oid).unwrap_or(false));
        let (col, color) = match existing {
            Some(i) => (i, lanes[i].as_ref().unwrap().1),
            None => {
                let i = lanes.iter().position(|l| l.is_none()).unwrap_or_else(|| {
                    lanes.push(None);
                    lanes.len() - 1
                });
                (i, alloc_color(&mut next_color))
            }
        };
        // Incoming lines: lanes expecting this commit converge into the node, others pass through.
        for (j, lane) in lanes.iter_mut().enumerate() {
            if let Some((o, c)) = lane {
                if o == oid {
                    segs.push(Seg { a: j as u16, b: col as u16, t: 1, c: *c });
                    if j != col {
                        *lane = None;
                    }
                } else {
                    segs.push(Seg { a: j as u16, b: j as u16, t: 0, c: *c });
                }
            }
        }
        // Outgoing lines to parents.
        if parents.is_empty() {
            lanes[col] = None;
        } else {
            lanes[col] = Some((parents[0].clone(), color));
            segs.push(Seg { a: col as u16, b: col as u16, t: 2, c: color });
            for p in parents.iter().skip(1) {
                let found = lanes.iter().enumerate().position(|(k, l)| k != col && l.as_ref().map(|(o, _)| o == p).unwrap_or(false));
                match found {
                    Some(k) => {
                        let c = lanes[k].as_ref().unwrap().1;
                        segs.push(Seg { a: col as u16, b: k as u16, t: 2, c });
                    }
                    None => {
                        let k = lanes.iter().enumerate().position(|(k, l)| k != col && l.is_none()).unwrap_or_else(|| {
                            lanes.push(None);
                            lanes.len() - 1
                        });
                        let c = alloc_color(&mut next_color);
                        lanes[k] = Some((p.clone(), c));
                        segs.push(Seg { a: col as u16, b: k as u16, t: 2, c });
                    }
                }
            }
        }
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        let width = segs.iter().map(|s| s.a.max(s.b) + 1).max().unwrap_or(1).max(col as u16 + 1);
        max_lanes = max_lanes.max(width);
        out.push(Layout { col: col as u16, color, segs });
    }
    (out, max_lanes)
}

#[derive(Debug, Clone)]
pub struct GraphCache {
    pub key: String,
    pub rows: Vec<GraphRow>,
    pub max_lanes: u16,
    pub index: HashMap<String, usize>,
    /// Inputs of the last full history read, reused by incremental rebuilds.
    pub commits: std::sync::Arc<Vec<CommitMeta>>,
    pub refs: Vec<(String, String)>,
    pub filter: Option<String>,
    pub limit: usize,
    /// How the commit list was obtained: "full" | "reused" | "incremental" | "fast".
    pub source: String,
}

/// refname → oid for everything the graph shows, plus HEAD.
fn ref_snapshot(repo: &Path) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = runner::run(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once(' ').map(|(a, b)| (a.to_string(), b.to_string())))
        .collect();
    if let Ok(h) = runner::run(repo, ["rev-parse", "-q", "--verify", "HEAD"]) {
        v.push(("HEAD".into(), h.trim().to_string()));
    }
    v.sort();
    v
}

fn parse_log(text: &str) -> Vec<CommitMeta> {
    let mut commits = Vec::new();
    for rec in text.split('\x1e') {
        let rec = rec.trim_start_matches(['\n', '\r']);
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.splitn(8, '\x1f').collect();
        if f.len() < 8 {
            continue;
        }
        commits.push(CommitMeta {
            oid: f[0].to_string(),
            parents: f[1].split_whitespace().map(|s| s.to_string()).collect(),
            author: f[2].to_string(),
            email: f[3].to_string(),
            author_time: f[4].parse().unwrap_or(0),
            committer: f[5].to_string(),
            commit_time: f[6].parse().unwrap_or(0),
            subject: f[7].trim_end().to_string(),
        });
    }
    commits
}

/// Tries to reuse the previous history: unchanged refs → same commits; refs that only moved
/// forward (or new refs) → read just the new commits and put them in front.
fn reuse_history(repo: &Path, prev: &GraphCache, refs: &[(String, String)]) -> Option<(Vec<CommitMeta>, &'static str)> {
    if prev.refs == refs {
        return Some(((*prev.commits).clone(), "reused"));
    }
    let old: HashMap<&str, &str> = prev.refs.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let new: HashMap<&str, &str> = refs.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let mut tips = Vec::new();
    for (name, oid) in &old {
        match new.get(name) {
            None => return None, // a ref disappeared: commits may have become unreachable
            Some(n) if n != oid => {
                let ff = runner::exec(repo, ["merge-base", "--is-ancestor", oid, n]).ok()?.ok();
                if !ff {
                    return None;
                }
                tips.push(n.to_string());
            }
            _ => {}
        }
    }
    for (name, oid) in &new {
        if !old.contains_key(name) {
            tips.push(oid.to_string());
        }
    }
    if tips.len() > 40 {
        return None;
    }
    let mut args: Vec<String> = vec!["log".into(), "--date-order".into(), "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1e".into()];
    args.extend(tips);
    args.push("--not".into());
    let mut olds: Vec<String> = old.values().map(|s| s.to_string()).collect();
    olds.sort();
    olds.dedup();
    args.extend(olds);
    args.push("--".into());
    let out = runner::exec(repo, &args).ok()?;
    if !out.ok() {
        return None;
    }
    let fresh = parse_log(&out.text());
    let seen: std::collections::HashSet<&str> = fresh.iter().map(|c| c.oid.as_str()).collect();
    let mut all = fresh.clone();
    all.extend(prev.commits.iter().filter(|c| !seen.contains(c.oid.as_str())).cloned());
    Some((all, "incremental"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSummary {
    pub key: String,
    pub total: usize,
    pub max_lanes: u16,
    pub head_index: Option<usize>,
}

/// Loads commit metadata. `fast` skips `--date-order` (which needs a full history walk before
/// the first line) so the newest commits stream out immediately; used for the first paint.
pub fn load_commits(repo: &Path, branch_filter: Option<&str>, limit: usize, fast: bool) -> GitResult<Vec<CommitMeta>> {
    let mut args: Vec<String> = vec!["log".into(), format!("--max-count={limit}"), "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1e".into()];
    // With a commit-graph file git can order the newest commits without a full walk.
    if !fast || has_commit_graph(repo) {
        args.insert(1, "--date-order".into());
    }
    match branch_filter {
        Some(b) if !b.is_empty() => {
            args.push(b.to_string());
        }
        _ => {
            args.push("--branches".into());
            args.push("--remotes".into());
            args.push("--tags".into());
            args.push("HEAD".into());
        }
    }
    args.push("--".into());
    let out = runner::exec(repo, &args)?;
    if !out.ok() {
        // Unborn HEAD with no refs at all → empty history.
        if out.stderr.contains("does not have any commits") || out.stderr.contains("unknown revision") || out.stderr.contains("bad default revision") {
            return Ok(Vec::new());
        }
        return Err(runner::to_error("git log", &out));
    }
    let text = out.text();
    let mut commits = Vec::new();
    for rec in text.split('\x1e') {
        let rec = rec.trim_start_matches(['\n', '\r']);
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.splitn(8, '\x1f').collect();
        if f.len() < 8 {
            continue;
        }
        commits.push(CommitMeta {
            oid: f[0].to_string(),
            parents: f[1].split_whitespace().map(|s| s.to_string()).collect(),
            author: f[2].to_string(),
            email: f[3].to_string(),
            author_time: f[4].parse().unwrap_or(0),
            committer: f[5].to_string(),
            commit_time: f[6].parse().unwrap_or(0),
            subject: f[7].trim_end().to_string(),
        });
    }
    Ok(commits)
}

/// Whether git's commit-graph cache exists for the repository.
pub fn has_commit_graph(repo: &Path) -> bool {
    let Ok(dir) = runner::run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) else { return false };
    let info = Path::new(dir.trim()).join("objects").join("info");
    info.join("commit-graph").is_file() || info.join("commit-graphs").join("commit-graph-chain").is_file()
}

/// Writes git's commit-graph cache (speeds up ordering and reachability queries).
pub fn write_commit_graph(repo: &Path, on_line: impl FnMut(&str)) -> GitResult<String> {
    runner::run_streaming(repo, &["commit-graph".into(), "write".into(), "--reachable".into(), "--changed-paths".into(), "--progress".into()], &[], on_line)
}

/// Commits reachable from local branches/HEAD but not from any remote-tracking branch.
fn local_only(repo: &Path) -> HashMap<String, ()> {
    let mut m = HashMap::new();
    if let Ok(s) = runner::run(repo, ["rev-list", "--branches", "HEAD", "--not", "--remotes", "--max-count=5000"]) {
        for l in s.lines() {
            m.insert(l.trim().to_string(), ());
        }
    }
    m
}

pub fn build(repo: &Path, branch_filter: Option<&str>, include_worktree: bool, limit: usize, fast: bool) -> GitResult<GraphCache> {
    build_with(repo, branch_filter, include_worktree, limit, fast, None)
}

pub fn build_with(
    repo: &Path,
    branch_filter: Option<&str>,
    include_worktree: bool,
    limit: usize,
    fast: bool,
    prev: Option<&GraphCache>,
) -> GitResult<GraphCache> {
    let refs = ref_snapshot(repo);
    let filter = branch_filter.filter(|b| !b.is_empty()).map(|s| s.to_string());
    let reusable = prev.filter(|p| !fast && p.filter == filter && p.limit == limit && p.source != "fast");
    let reused = reusable.and_then(|p| reuse_history(repo, p, &refs));
    // The history walk dominates; fetch decorations and remote info in parallel with it.
    let (commits, labels, head_oid, local, has_remotes) = std::thread::scope(|sc| {
        let labels = sc.spawn(|| refs::labels_by_oid(repo));
        let head = sc.spawn(|| runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD"]).map(|o| o.text().trim().to_string()));
        let local = sc.spawn(|| local_only(repo));
        let remotes = sc.spawn(|| !runner::run(repo, ["remote"]).unwrap_or_default().trim().is_empty());
        let commits = match &reused {
            Some((c, _)) => Ok(c.clone()),
            None => load_commits(repo, branch_filter, limit, fast),
        };
        let join_err = || GitError::new("Background history task failed.");
        GitResult::Ok((
            commits?,
            labels.join().map_err(|_| join_err())??,
            head.join().map_err(|_| join_err())??,
            local.join().map_err(|_| join_err())?,
            remotes.join().map_err(|_| join_err())?,
        ))
    })?;

    let mut order: Vec<(String, Vec<String>)> = Vec::with_capacity(commits.len() + 1);
    if include_worktree && !head_oid.is_empty() {
        order.push((WORKTREE_OID.to_string(), vec![head_oid.clone()]));
    } else if include_worktree {
        order.push((WORKTREE_OID.to_string(), vec![]));
    }
    // Drop parents that are outside the loaded window so lanes do not dangle forever.
    let known: HashMap<&str, ()> = commits.iter().map(|c| (c.oid.as_str(), ())).collect();
    for c in &commits {
        let parents: Vec<String> = c.parents.iter().filter(|p| known.contains_key(p.as_str())).cloned().collect();
        order.push((c.oid.clone(), parents));
    }
    let (lay, max_lanes) = layout(&order);
    let commit_list = commits.clone();

    let mut rows = Vec::with_capacity(order.len());
    let mut offset = 0;
    if include_worktree {
        let l = &lay[0];
        rows.push(GraphRow {
            index: 0,
            oid: WORKTREE_OID.into(),
            parents: order[0].1.clone(),
            author: String::new(),
            email: String::new(),
            author_time: 0,
            committer: String::new(),
            commit_time: 0,
            subject: "Uncommitted changes".into(),
            refs: Vec::new(),
            col: l.col,
            color: l.color,
            segs: l.segs.clone(),
            is_head: false,
            is_merge: false,
            local_only: true,
        });
        offset = 1;
    }
    for (i, c) in commits.into_iter().enumerate() {
        let l = &lay[i + offset];
        let refs = labels.get(&c.oid).cloned().unwrap_or_default();
        let is_merge = c.parents.len() > 1;
        let lo = if has_remotes { local.contains_key(&c.oid) } else { true };
        rows.push(GraphRow {
            index: i + offset,
            is_head: c.oid == head_oid,
            oid: c.oid,
            parents: c.parents,
            author: c.author,
            email: c.email,
            author_time: c.author_time,
            committer: c.committer,
            commit_time: c.commit_time,
            subject: c.subject,
            refs,
            col: l.col,
            color: l.color,
            segs: l.segs.clone(),
            is_merge,
            local_only: lo,
        });
    }
    let index = rows.iter().map(|r| (r.oid.clone(), r.index)).collect();
    let key = format!("{}:{}:{}", rows.len(), head_oid, rows.first().map(|r| r.oid.as_str()).unwrap_or(""));
    let source = if fast { "fast" } else { reused.as_ref().map(|(_, s)| *s).unwrap_or("full") }.to_string();
    Ok(GraphCache { key, rows, max_lanes, index, commits: std::sync::Arc::new(commit_list), refs, filter, limit, source })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    /// Message, author, hash and refs over the loaded history (instant).
    Quick,
    Message,
    Author,
    Hash,
    /// Commits whose diff adds/removes the text (`git log -S`).
    Content,
    /// Commits touching a path.
    Path,
}

pub fn search(repo: &Path, cache: &GraphCache, query: &str, mode: SearchMode) -> GitResult<Vec<usize>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let ql = q.to_lowercase();
    let in_memory =
        |pred: &dyn Fn(&GraphRow) -> bool| -> Vec<usize> { cache.rows.iter().filter(|r| r.oid != WORKTREE_OID && pred(r)).map(|r| r.index).collect() };
    let res = match mode {
        SearchMode::Quick => in_memory(&|r| {
            r.subject.to_lowercase().contains(&ql)
                || r.author.to_lowercase().contains(&ql)
                || r.email.to_lowercase().contains(&ql)
                || r.oid.starts_with(&ql)
                || r.refs.iter().any(|x| x.name.to_lowercase().contains(&ql))
        }),
        SearchMode::Author => in_memory(&|r| r.author.to_lowercase().contains(&ql) || r.email.to_lowercase().contains(&ql)),
        SearchMode::Hash => in_memory(&|r| r.oid.starts_with(&ql)),
        SearchMode::Message | SearchMode::Content | SearchMode::Path => {
            let mut args: Vec<String> = vec!["log".into(), "--format=%H".into(), "--branches".into(), "--remotes".into(), "--tags".into(), "HEAD".into()];
            match mode {
                SearchMode::Message => {
                    args.push("--regexp-ignore-case".into());
                    args.push("--fixed-strings".into());
                    args.push(format!("--grep={q}"));
                }
                SearchMode::Content => {
                    args.push(format!("-S{q}"));
                }
                _ => {}
            }
            args.push("--".into());
            if mode == SearchMode::Path {
                args.push(q.to_string());
            }
            let out = runner::run(repo, &args)?;
            let mut v: Vec<usize> = out.lines().filter_map(|l| cache.index.get(l.trim()).copied()).collect();
            v.sort_unstable();
            v
        }
    };
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(o: &str, p: &[&str]) -> (String, Vec<String>) {
        (o.to_string(), p.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn linear_history_uses_one_lane() {
        let (l, max) = layout(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(max, 1);
        assert!(l.iter().all(|x| x.col == 0));
    }

    #[test]
    fn branch_and_merge() {
        // m merges f into b; f and b both come from a.
        let (l, max) = layout(&[c("m", &["b", "f"]), c("f", &["a"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(max, 2);
        assert_eq!(l[0].col, 0);
        assert_eq!(l[1].col, 1); // feature lane
        assert_eq!(l[2].col, 0);
        assert_eq!(l[3].col, 0);
        // the merge node draws a line to lane 1
        assert!(l[0].segs.iter().any(|s| s.t == 2 && s.a == 0 && s.b == 1));
        // the root receives both lanes
        assert!(l[3].segs.iter().any(|s| s.t == 1 && s.a == 1 && s.b == 0));
    }

    #[test]
    fn independent_tips_get_separate_lanes() {
        let (l, _) = layout(&[c("x", &["a"]), c("y", &["a"]), c("a", &[])]);
        assert_eq!(l[0].col, 0);
        assert_eq!(l[1].col, 1);
        assert_eq!(l[2].col, 0);
    }
}
