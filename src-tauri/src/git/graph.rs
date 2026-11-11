//! Commit history loading and lane layout for the graph view.

use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::refs::{self, RefLabel};
use super::runner::{self, GitError, GitResult};

pub const WORKTREE_OID: &str = "WORKTREE";

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
    pub id: u64,
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
    pub lane_id: u64,
    pub segs: Vec<Seg>,
    pub is_head: bool,
    pub is_merge: bool,
    /// Commit is not contained in any remote-tracking branch (safe to rewrite).
    pub local_only: bool,
    pub incoming: bool,
}

#[derive(Debug, Clone)]
pub struct Layout {
    pub col: u16,
    pub color: u16,
    pub lane_id: u64,
    pub segs: Vec<Seg>,
}

#[derive(Clone, Copy)]
struct Line {
    id: u64,
    color: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaneAnchor {
    commit: String,
    parent: Option<String>,
}

type LaneAnchors = HashMap<u64, LaneAnchor>;

impl Line {
    fn segment(self, a: usize, b: usize, t: u8) -> Seg {
        Seg { a: a as u16, b: b as u16, t, c: self.color, id: self.id }
    }
}

/// Assigns lanes to commits given in display order (children before parents).
fn layout(commits: &[(String, Vec<String>)]) -> (Vec<Layout>, u16, LaneAnchors) {
    let mut lanes: Vec<Option<(String, Line)>> = Vec::new();
    let mut anchors = HashMap::new();
    let mut next_color = 0;
    let mut out = Vec::with_capacity(commits.len());
    let mut max_lanes: u16 = 1;
    let mut allocate_line = |start: &str, parent: Option<&str>| {
        // The same tip or merge edge keeps its identity when the graph is rebuilt
        // or more history is loaded, regardless of column and palette assignment.
        const SAFE_MASK: u64 = (1 << 53) - 1;
        let mut hash = DefaultHasher::new();
        (start, parent).hash(&mut hash);
        let mut id = hash.finish() & SAFE_MASK;
        while anchors.contains_key(&id) {
            id = (id + 1) & SAFE_MASK;
        }
        anchors.insert(id, LaneAnchor { commit: start.to_owned(), parent: parent.map(str::to_owned) });
        let line = Line { id, color: next_color };
        next_color = (next_color + 1) % 12;
        line
    };
    for (oid, parents) in commits {
        let mut segs = Vec::new();
        let existing = lanes.iter().position(|l| l.as_ref().map(|(o, _)| o == oid).unwrap_or(false));
        let (col, line) = match existing {
            Some(i) => (i, lanes[i].as_ref().unwrap().1),
            None => {
                let i = lanes.iter().position(|l| l.is_none()).unwrap_or_else(|| {
                    lanes.push(None);
                    lanes.len() - 1
                });
                let tip = if oid == WORKTREE_OID { parents.first().unwrap_or(oid) } else { oid };
                (i, allocate_line(tip, None))
            }
        };
        // Incoming lines: lanes expecting this commit converge into the node, others pass through.
        for (j, lane) in lanes.iter_mut().enumerate() {
            if let Some((o, incoming)) = lane {
                if o == oid {
                    segs.push(incoming.segment(j, col, 1));
                    if j != col {
                        *lane = None;
                    }
                } else {
                    segs.push(incoming.segment(j, j, 0));
                }
            }
        }
        // Outgoing lines to parents.
        if parents.is_empty() {
            lanes[col] = None;
        } else {
            lanes[col] = Some((parents[0].clone(), line));
            segs.push(line.segment(col, col, 2));
            for p in parents.iter().skip(1) {
                let found = lanes.iter().enumerate().position(|(k, l)| k != col && l.as_ref().map(|(o, _)| o == p).unwrap_or(false));
                match found {
                    Some(k) => {
                        segs.push(lanes[k].as_ref().unwrap().1.segment(col, k, 2));
                    }
                    None => {
                        let k = lanes.iter().enumerate().position(|(k, l)| k != col && l.is_none()).unwrap_or_else(|| {
                            lanes.push(None);
                            lanes.len() - 1
                        });
                        let secondary = allocate_line(oid, Some(p));
                        lanes[k] = Some((p.clone(), secondary));
                        segs.push(secondary.segment(col, k, 2));
                    }
                }
            }
        }
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        let width = segs.iter().map(|s| s.a.max(s.b) + 1).max().unwrap_or(1).max(col as u16 + 1);
        max_lanes = max_lanes.max(width);
        out.push(Layout { col: col as u16, color: line.color, lane_id: line.id, segs });
    }
    (out, max_lanes, anchors)
}

#[derive(Debug, Clone)]
pub struct GraphCache {
    pub head_oid: String,
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
    incoming: Option<IncomingHistory>,
    lane_anchors: Arc<LaneAnchors>,
    previous_anchors: Option<(String, Arc<LaneAnchors>)>,
}

#[derive(Debug, Clone)]
struct IncomingHistory {
    base: String,
    tip: String,
    commits: Arc<Vec<CommitMeta>>,
}

impl GraphCache {
    pub fn branch_members(&self, reference: &str) -> Vec<usize> {
        let Some(tip) = self.refs.iter().find(|(name, _)| name == reference).and_then(|(_, oid)| self.index.get(oid)) else {
            return Vec::new();
        };
        let mut visited = vec![false; self.rows.len()];
        let mut pending = vec![*tip];
        while let Some(index) = pending.pop() {
            if std::mem::replace(&mut visited[index], true) {
                continue;
            }
            pending.extend(self.rows[index].parents.iter().filter_map(|oid| self.index.get(oid).copied()));
        }
        visited.into_iter().enumerate().filter_map(|(index, member)| member.then_some(index)).collect()
    }

    pub fn lane_anchor(&self, key: &str, id: u64) -> Option<LaneAnchor> {
        let anchors = if key == self.key {
            &self.lane_anchors
        } else {
            let (previous_key, anchors) = self.previous_anchors.as_ref()?;
            if key != previous_key {
                return None;
            }
            anchors
        };
        anchors.get(&id).cloned()
    }

    pub fn resolve_lane(&self, anchor: &LaneAnchor) -> Option<u64> {
        let row = self.rows.get(*self.index.get(&anchor.commit)?)?;
        match &anchor.parent {
            None => Some(row.lane_id),
            Some(parent) => {
                // Layout emits one outgoing segment per parent retained in the graph, in parent order.
                let position = row.parents.iter().filter(|oid| self.index.contains_key(*oid)).position(|oid| oid == parent)?;
                row.segs.iter().filter(|segment| segment.t == 2).nth(position).map(|segment| segment.id)
            }
        }
    }

    pub fn check_key(&self, expected_key: Option<&str>) -> GitResult<()> {
        if expected_key.is_some_and(|key| key != self.key) {
            return Err(super::runner::GitError::new("History changed. Refresh the graph rows.").kind("stale-operation"));
        }
        Ok(())
    }

    pub fn page(&self, start: usize, count: usize, expected_key: Option<&str>) -> GitResult<Vec<GraphRow>> {
        self.check_key(expected_key)?;
        let end = start.saturating_add(count).min(self.rows.len());
        Ok(if start >= end { Vec::new() } else { self.rows[start..end].to_vec() })
    }
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
    pub head_oid: String,
    pub key: String,
    pub total: usize,
    pub max_lanes: u16,
    pub head_index: Option<usize>,
}

/// Loads commit metadata. `fast` skips `--date-order` (which needs a full history walk before
/// the first line) so the newest commits stream out immediately; used for the first paint.
fn log_arguments(repo: &Path, limit: usize, fast: bool) -> Vec<String> {
    let mut args: Vec<String> = vec!["log".into(), format!("--max-count={limit}"), "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1e".into()];
    // With a commit-graph file git can order the newest commits without a full walk.
    if !fast || has_commit_graph(repo) {
        args.insert(1, "--date-order".into());
    }
    args
}

pub fn load_commits(repo: &Path, branch_filter: Option<&str>, limit: usize, fast: bool) -> GitResult<Vec<CommitMeta>> {
    let mut args = log_arguments(repo, limit, fast);
    match branch_filter {
        Some(b) if !b.is_empty() => {
            args.push("--end-of-options".into());
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
    read_commits(repo, &args)
}

fn read_commits(repo: &Path, args: &[String]) -> GitResult<Vec<CommitMeta>> {
    let out = runner::exec(repo, args)?;
    if !out.ok() {
        // Unborn HEAD with no refs at all → empty history.
        if out.stderr.contains("does not have any commits") || out.stderr.contains("unknown revision") || out.stderr.contains("bad default revision") {
            return Ok(Vec::new());
        }
        return Err(runner::to_error("git log", &out));
    }
    Ok(parse_log(&out.text()))
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
    build_with_incoming(repo, branch_filter, include_worktree, limit, fast, prev, false)
}

fn incoming_history(
    repo: &Path,
    scope: &str,
    refs: &[(String, String)],
    limit: usize,
    fast: bool,
    previous: Option<&IncomingHistory>,
) -> GitResult<Option<IncomingHistory>> {
    if (scope != "HEAD" && !scope.starts_with("refs/heads/")) || !refs.iter().any(|(name, _)| name.starts_with("refs/remotes/")) {
        return Ok(None);
    }
    let Some((_, base)) = refs.iter().find(|(name, _)| name == scope) else { return Ok(None) };
    let resolved = if let Some(branch) = scope.strip_prefix("refs/heads/") {
        runner::exec(repo, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", &format!("{branch}@{{upstream}}")])?
    } else {
        runner::exec(repo, ["rev-parse", "--symbolic-full-name", "HEAD", "@{upstream}"])?
    };
    if !resolved.ok() {
        return Ok(None);
    }
    let output = resolved.text();
    let mut lines = output.lines();
    if scope == "HEAD" {
        let Some(branch) = lines.next() else { return Ok(None) };
        if !branch.starts_with("refs/heads/") || !refs.iter().any(|(name, oid)| name == branch && oid == base) {
            return Ok(None);
        }
    }
    let Some(upstream) = lines.next() else { return Ok(None) };
    if !upstream.starts_with("refs/remotes/") {
        return Ok(None);
    }
    let Some((_, tip)) = refs.iter().find(|(name, _)| name == upstream) else { return Ok(None) };
    if base == tip {
        return Ok(None);
    }
    if let Some(previous) = previous.filter(|history| history.base == *base && history.tip == *tip) {
        return Ok(Some(previous.clone()));
    }
    // Reserve a row for the local tip even when the incoming history fills the window.
    let mut args = log_arguments(repo, limit.saturating_sub(1), fast);
    args.extend(["--end-of-options".into(), tip.clone(), format!("^{base}"), "--".into()]);
    let commits = Arc::new(read_commits(repo, &args)?);
    Ok(Some(IncomingHistory { base: base.clone(), tip: tip.clone(), commits }))
}

pub fn build_with_incoming(
    repo: &Path,
    branch_filter: Option<&str>,
    include_worktree: bool,
    limit: usize,
    fast: bool,
    prev: Option<&GraphCache>,
    show_incoming: bool,
) -> GitResult<GraphCache> {
    let refs = ref_snapshot(repo);
    let filter = branch_filter.filter(|b| !b.is_empty()).map(|s| s.to_string());
    let scoped_tip = filter.as_ref().and_then(|reference| refs.iter().find(|(name, _)| name == reference));
    let reusable = prev.filter(|p| !fast && p.filter == filter && p.limit == limit && p.source != "fast");
    let reused = reusable.and_then(|p| {
        if filter.is_none() {
            return reuse_history(repo, p, &refs);
        }
        // The unfiltered incremental walk includes advances on every ref.
        // A scoped history is reusable only while its own tip is unchanged.
        p.refs.contains(scoped_tip?).then(|| ((*p.commits).clone(), "reused"))
    });
    // The history walk dominates; fetch decorations and remote info in parallel with it.
    let (commits, incoming, labels, head_oid, local, has_remotes) = std::thread::scope(|sc| {
        let labels = sc.spawn(|| refs::labels_by_oid(repo));
        let head = sc.spawn(|| runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD"]).map(|o| o.text().trim().to_string()));
        let local = sc.spawn(|| local_only(repo));
        let remotes = sc.spawn(|| !runner::run(repo, ["remote"]).unwrap_or_default().trim().is_empty());
        let incoming = sc.spawn(|| match filter.as_deref().filter(|_| show_incoming) {
            Some(scope) => incoming_history(repo, scope, &refs, limit, fast, reusable.and_then(|p| p.incoming.as_ref())),
            None => Ok(None),
        });
        let commits = match &reused {
            Some((c, _)) => Ok(c.clone()),
            None if filter.as_deref() == Some("HEAD") && !refs.iter().any(|(name, _)| name == "HEAD") => Ok(Vec::new()),
            // Use the same local tip as the incoming range even if a ref moves during this build.
            None => load_commits(repo, scoped_tip.map(|(_, oid)| oid.as_str()).or(branch_filter), limit, fast),
        };
        let join_err = || GitError::new("Background history task failed.");
        GitResult::Ok((
            commits?,
            incoming.join().map_err(|_| join_err())??,
            labels.join().map_err(|_| join_err())??,
            head.join().map_err(|_| join_err())??,
            local.join().map_err(|_| join_err())?,
            remotes.join().map_err(|_| join_err())?,
        ))
    })?;

    let upstream_commits = incoming.as_ref().map_or(&[][..], |history| history.commits.as_slice());
    let local_limit = if upstream_commits.is_empty() { commits.len() } else { limit.saturating_sub(upstream_commits.len()).min(commits.len()) };
    let shown = upstream_commits.iter().chain(&commits[..local_limit]);
    let mut order: Vec<(String, Vec<String>)> = Vec::with_capacity(upstream_commits.len() + local_limit + 1);
    if include_worktree && !head_oid.is_empty() {
        order.push((WORKTREE_OID.to_string(), vec![head_oid.clone()]));
    } else if include_worktree {
        order.push((WORKTREE_OID.to_string(), vec![]));
    }
    // Drop parents that are outside the loaded window so lanes do not dangle forever.
    let known: HashMap<&str, ()> = shown.clone().map(|c| (c.oid.as_str(), ())).collect();
    for c in shown.clone() {
        let parents: Vec<String> = c.parents.iter().filter(|p| known.contains_key(p.as_str())).cloned().collect();
        order.push((c.oid.clone(), parents));
    }
    let (lay, max_lanes, lane_anchors) = layout(&order);

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
            lane_id: l.lane_id,
            segs: l.segs.clone(),
            is_head: false,
            is_merge: false,
            local_only: true,
            incoming: false,
        });
        offset = 1;
    }
    for (i, c) in shown.cloned().enumerate() {
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
            lane_id: l.lane_id,
            segs: l.segs.clone(),
            is_merge,
            local_only: lo,
            incoming: i < upstream_commits.len(),
        });
    }
    let index = rows.iter().map(|r| (r.oid.clone(), r.index)).collect();
    // Row count, HEAD and first commit can all stay unchanged across different
    // filters, ref labels or lane layouts. Readers must identify this exact build.
    use std::sync::atomic::{AtomicU64, Ordering};
    static BUILDS: AtomicU64 = AtomicU64::new(0);
    let key = format!("graph-{}", BUILDS.fetch_add(1, Ordering::Relaxed));
    let source = if fast { "fast" } else { reused.as_ref().map(|(_, s)| *s).unwrap_or("full") }.to_string();
    // Rows from the previous build can still be displayed until the first new page arrives.
    let previous_anchors = prev.map(|cache| (cache.key.clone(), Arc::clone(&cache.lane_anchors)));
    Ok(GraphCache {
        head_oid,
        key,
        rows,
        max_lanes,
        index,
        commits: Arc::new(commits),
        refs,
        filter,
        limit,
        source,
        incoming,
        lane_anchors: Arc::new(lane_anchors),
        previous_anchors,
    })
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

fn search_arguments(args: &mut Vec<String>, query: &str, mode: SearchMode) {
    match mode {
        SearchMode::Message => args.extend(["--regexp-ignore-case".into(), "--fixed-strings".into(), format!("--grep={query}")]),
        SearchMode::Content => args.push(format!("-S{query}")),
        _ => {}
    }
    args.push("--".into());
    if mode == SearchMode::Path {
        args.push(query.to_string());
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSearchHit {
    pub oid: String,
    pub subject: String,
    pub author: String,
    pub author_time: i64,
    pub refs: String,
}

/// Search independently of the graph cache, including repositories whose History tab was never opened.
pub fn search_repository(repo: &Path, query: &str, mode: SearchMode) -> GitResult<Vec<CommitSearchHit>> {
    const MATCH_LIMIT: usize = 31; // Show 30 and use one extra row to detect truncation.
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let in_memory = matches!(mode, SearchMode::Quick | SearchMode::Author | SearchMode::Hash);
    let mut args = vec![
        "log".into(),
        "--no-show-signature".into(),
        "--no-color".into(),
        "--format=%H%x00%an%x00%ae%x00%at%x00%s%x00%D".into(),
        "--decorate=short".into(),
        "--branches".into(),
        "--remotes".into(),
        "--tags".into(),
        format!("--max-count={}", if in_memory { 150_000 } else { MATCH_LIMIT }),
    ];
    if runner::exec(repo, ["rev-parse", "--verify", "--quiet", "HEAD"])?.ok() {
        args.push("HEAD".into());
    }
    search_arguments(&mut args, q, mode);
    let raw = runner::run(repo, &args)?;
    let q = q.to_lowercase();
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, '\0');
            let (oid, author, email, time, subject, refs) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?, fields.next()?, fields.next()?);
            let by_author = || author.to_lowercase().contains(&q) || email.to_lowercase().contains(&q);
            let matched = match mode {
                SearchMode::Quick => oid.starts_with(&q) || by_author() || subject.to_lowercase().contains(&q) || refs.to_lowercase().contains(&q),
                SearchMode::Author => by_author(),
                SearchMode::Hash => oid.starts_with(&q),
                _ => true,
            };
            matched.then(|| CommitSearchHit {
                oid: oid.into(),
                subject: subject.into(),
                author: author.into(),
                author_time: time.parse().unwrap_or_default(),
                refs: refs.into(),
            })
        })
        .take(MATCH_LIMIT)
        .collect())
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
            search_arguments(&mut args, q, mode);
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
        let (l, max, _) = layout(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(max, 1);
        assert!(l.iter().all(|x| x.col == 0));
    }

    #[test]
    fn branch_and_merge() {
        // m merges f into b; f and b both come from a.
        let (l, max, _) = layout(&[c("m", &["b", "f"]), c("f", &["a"]), c("b", &["a"]), c("a", &[])]);
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
    fn main_merged_into_branch_then_branch_merged_back() {
        // f1 branches from a; s merges main (m1) into the branch; M merges the branch into main.
        let rows = [c("M", &["m2", "s"]), c("s", &["f1", "m1"]), c("m2", &["m1"]), c("f1", &["a"]), c("m1", &["a"]), c("a", &[])];
        let (l, _, _) = layout(&rows);
        let (main, feature) = (l[0].col, l[1].col);
        assert_ne!(main, feature);
        assert_eq!((l[2].col, l[3].col, l[4].col, l[5].col), (main, feature, main, main));
        // M draws a merge line into the branch lane.
        assert!(l[0].segs.iter().any(|g| g.t == 2 && g.a == main && g.b == feature), "{:?}", l[0].segs);
        // s pulls main in through its own lane, which ends at m1 on the main lane.
        let pulled = l[1].segs.iter().find(|g| g.t == 2 && g.a == feature && g.b != feature).map(|g| g.b).expect("s has no merge line");
        assert!(l[4].segs.iter().any(|g| g.t == 1 && g.a == pulled && g.b == main), "{:?}", l[4].segs);
        // The branch ends at its fork point a.
        assert!(l[5].segs.iter().any(|g| g.t == 1 && g.a == feature && g.b == main), "{:?}", l[5].segs);
    }

    #[test]
    fn independent_tips_get_separate_lanes() {
        let (l, _, _) = layout(&[c("x", &["a"]), c("y", &["a"]), c("a", &[])]);
        assert_eq!(l[0].col, 0);
        assert_eq!(l[1].col, 1);
        assert_eq!(l[2].col, 0);
    }

    #[test]
    fn unrelated_lines_can_share_a_palette_color_without_sharing_identity() {
        let rows: Vec<_> = (0..25).map(|i| (format!("tip-{i}"), vec!["base".to_string()])).chain([c("base", &[])]).collect();
        let (layout, _, _) = layout(&rows);
        assert_eq!(layout[0].color, layout[12].color);
        assert_ne!(layout[0].lane_id, layout[12].lane_id);
        assert!(layout[25].segs.iter().any(|seg| seg.id == layout[12].lane_id));
    }

    #[test]
    fn a_line_keeps_its_identity_when_other_lanes_change() {
        let (before, _, _) = layout(&[c("tip", &["root"]), c("root", &[])]);
        let (after, _, _) = layout(&[c("other", &["root"]), c("tip", &["root"]), c("root", &[])]);
        assert_ne!(before[0].col, after[1].col);
        assert_eq!(before[0].lane_id, after[1].lane_id);
    }

    #[test]
    fn pinned_tip_resolves_after_advancing_and_disappears_outside_the_graph() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        runner::run(repo, ["init", "-qb", "main"]).unwrap();
        let commit = |message| {
            runner::run(
                repo,
                [
                    "-c",
                    "user.name=Graph Fixture",
                    "-c",
                    "user.email=history@example.test",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    message,
                ],
            )
            .unwrap();
            runner::run(repo, ["rev-parse", "HEAD"]).unwrap().trim().to_owned()
        };
        let base = commit("Base");
        runner::run(repo, ["branch", "side", &base]).unwrap();
        let tip = commit("Original tip");
        let before = build(repo, None, false, 100, false).unwrap();
        assert_eq!(before.branch_members("refs/heads/side"), vec![before.index[&base]]);
        let id = before.rows[before.index[&tip]].lane_id;
        let anchor = before.lane_anchor(&before.key, id).unwrap();

        let advanced = commit("New tip");
        let after = build_with(repo, None, false, 100, false, Some(&before)).unwrap();
        let updated = after.rows[after.index[&advanced]].lane_id;
        assert_ne!(id, updated);
        assert_eq!(after.resolve_lane(&anchor), Some(updated));
        // Clicking a still-visible row from the preceding build finds the same anchor.
        assert_eq!(after.resolve_lane(&after.lane_anchor(&before.key, id).unwrap()), Some(updated));

        let filtered = build(repo, Some(&base), false, 100, false).unwrap();
        assert_eq!(filtered.resolve_lane(&anchor), None);
        assert!(filtered.branch_members("refs/heads/main").is_empty());
    }

    #[test]
    fn repository_search_uses_refs_without_loading_a_graph() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        runner::run(repo, ["init", "-qb", "main"]).unwrap();
        assert!(search_repository(repo, "empty", SearchMode::Quick).unwrap().is_empty());
        runner::run(
            repo,
            [
                "-c",
                "user.name=Graph Fixture",
                "-c",
                "user.email=history@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "Searchable subject\n\nExtended body",
            ],
        )
        .unwrap();
        runner::run(repo, ["branch", "feature/search-this-branch"]).unwrap();
        let commit = runner::run(repo, ["rev-parse", "HEAD"]).unwrap();
        for (mode, query) in [
            (SearchMode::Quick, "search-this-branch"),
            (SearchMode::Quick, "SEARCHABLE SUBJECT"),
            (SearchMode::Message, "extended body"),
            (SearchMode::Author, "history@example.test"),
            (SearchMode::Hash, &commit[..9]),
        ] {
            let hits = search_repository(repo, query, mode).unwrap();
            assert_eq!(hits.len(), 1, "{query}");
            assert_eq!(hits[0].oid, commit.trim());
        }
    }
}
