//! Branches, remotes, tags and stashes.

use std::collections::{HashMap, HashSet};
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
    pub upstream_full_name: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Display count for a local branch with no configured upstream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unpublished: Option<usize>,
    pub gone: bool,
    pub is_head: bool,
    pub remote: Option<String>,
    pub time: i64,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    pub creator: Option<super::branch_origin::Creator>,
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
    pub switch_source: Option<String>,
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
    pub identity_email: Option<String>,
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
    pub tags: Vec<TagInfo>,
    pub stashes: Vec<StashInfo>,
    pub remotes: Vec<RemoteInfo>,
    /// Changes whenever anything above changes: the UI compares two snapshots by it, and asks
    /// [`snapshot_if_changed`] with it instead of receiving an unchanged snapshot again.
    pub fingerprint: String,
    /// Changes whenever a remote branch is added, removed or moves: what cached answers about
    /// remote branches (such as "on a remote") depend on.
    pub remote_fingerprint: String,
}

/// A short hash of `value` as JSON, the form the UI receives it in.
fn fingerprint_of(value: &impl Serialize) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(value).unwrap_or_default().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// The snapshot, or `None` when its fingerprint is still `known`.
pub fn snapshot_if_changed(repo: &Path, known: Option<&str>) -> GitResult<Option<RefsSnapshot>> {
    let snapshot = snapshot(repo)?;
    Ok((known != Some(snapshot.fingerprint.as_str())).then_some(snapshot))
}

const FMT: &str = "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(creatordate:unix)%00%(contents:subject)%00%(authorname)%00%(symref)%00%(objecttype)%00%(upstream)%00%(authoremail:trim)%00";

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

pub fn branch_names(repo: &Path) -> GitResult<Vec<String>> {
    super::repo::require_directory(repo)?;
    let raw = runner::run(repo, ["for-each-ref", "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes"])?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let (name, target) = line.split_once('\0')?;
            target.is_empty().then(|| name.to_owned())
        })
        .collect())
}

#[test]
fn refs_classify_an_unavailable_repository_folder() {
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("removed");
    assert_eq!(branch_names(&path).unwrap_err().kind, "repository-folder-unavailable");
    std::fs::write(&path, "not a folder").unwrap();
    assert_eq!(snapshot(&path).err().unwrap().kind, "repository-folder-unavailable");
    assert_eq!(super::repo::discover(&path).unwrap_err().kind, "repository-folder-unavailable");
}

/// Ref identity that determines every metadata field except `%(HEAD)`: the ref's
/// target, its symbolic target, and its upstream with the upstream's target.
#[derive(Clone, PartialEq, Eq, Hash)]
struct MetaKey {
    refname: String,
    oid: String,
    symref: String,
    upstream: String,
    upstream_oid: String,
}

/// Per repository and history boundary: `MetaKey` → the 13 `FMT` fields of that ref.
type MetaCache = HashMap<(std::path::PathBuf, HistoryBoundary), HashMap<MetaKey, Vec<String>>>;

/// What, besides the two tips, decides ahead/behind counts: the shallow boundary, grafts and
/// replacement refs (`git replace --graft`). Deepening a shallow clone or adding a
/// replacement keeps every listed tip but changes the counts.
type HistoryBoundary = Vec<(std::path::PathBuf, Option<(std::time::SystemTime, u64)>)>;

fn history_boundary(repo: &Path) -> HistoryBoundary {
    let Some(common) = super::graph::common_dir(repo) else { return Vec::new() };
    // Replacement refs may be loose files or lines in packed-refs: watch both.
    let mut files = vec![common.join("shallow"), common.join("info").join("grafts"), common.join("packed-refs")];
    let mut stack = vec![common.join("refs").join("replace")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(entry.path()),
                Ok(t) if t.is_file() => files.push(entry.path()),
                _ => {}
            }
        }
    }
    files.sort();
    files
        .into_iter()
        .map(|file| {
            let stamp = std::fs::metadata(&file).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
            (file, stamp)
        })
        .collect()
}

fn meta_cache() -> &'static parking_lot::Mutex<MetaCache> {
    static CACHE: std::sync::OnceLock<parking_lot::Mutex<MetaCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Above this many changed refs one full enumeration is cheaper than naming them.
const META_NAMED_LIMIT: usize = 100;

/// `for-each-ref FMT refs/heads refs/remotes refs/tags`, in the same record format.
/// Subjects, authors, dates and ahead/behind counts need each ref's objects; they are
/// remembered per ref target and upstream target, so a refresh with unchanged refs runs
/// only a names-and-targets listing, and a few changed refs are read by name.
fn enumerate(repo: &Path) -> GitResult<String> {
    let cheap = runner::run(
        repo,
        ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)%00%(upstream)%00%(HEAD)%00", "refs/heads", "refs/remotes", "refs/tags"],
    )?;
    let fields: Vec<&str> = cheap.split_terminator('\0').map(|f| f.trim_start_matches('\n')).collect();
    let (rows, tail) = fields.as_chunks::<5>();
    if tail.iter().any(|s| !s.trim().is_empty()) {
        return runner::run(repo, ["for-each-ref", FMT, "refs/heads", "refs/remotes", "refs/tags"]);
    }
    let targets: HashMap<&str, &str> = rows.iter().map(|r| (r[0], r[1])).collect();
    let keys: Vec<(MetaKey, bool)> = rows
        .iter()
        .map(|r| {
            let upstream_oid = targets.get(r[3]).copied().unwrap_or_default().to_string();
            (MetaKey { refname: r[0].to_string(), oid: r[1].to_string(), symref: r[2].to_string(), upstream: r[3].to_string(), upstream_oid }, r[4] == "*")
        })
        .collect();
    let key = (repo.to_path_buf(), history_boundary(repo));
    let missing: Vec<&MetaKey> = {
        let mut cache = meta_cache().lock();
        // Counts learned under another boundary of this repository are stale.
        cache.retain(|(root, boundary), _| root != &key.0 || boundary == &key.1);
        let known = cache.get(&key);
        // An upstream outside the listing has no target here to key on: always re-read.
        let unkeyed = |k: &MetaKey| !k.upstream.is_empty() && !targets.contains_key(k.upstream.as_str());
        keys.iter().map(|(k, _)| k).filter(|k| unkeyed(k) || !known.is_some_and(|m| m.contains_key(*k))).collect()
    };
    if !missing.is_empty() {
        let mut args: Vec<String> = vec!["for-each-ref".into(), FMT.into()];
        if missing.len() <= META_NAMED_LIMIT && missing.len() < keys.len() {
            args.extend(missing.iter().map(|k| k.refname.clone()));
        } else {
            args.extend(["refs/heads".into(), "refs/remotes".into(), "refs/tags".into()]);
        }
        let raw = runner::run(repo, &args)?;
        let fields: Vec<&str> = raw.split_terminator('\0').collect();
        let (records, tail) = fields.as_chunks::<13>();
        if tail.iter().any(|s| !s.trim_matches('\n').is_empty()) {
            return Err(super::runner::GitError::new("Invalid reference metadata record."));
        }
        let mut cache = meta_cache().lock();
        if cache.len() > 32 {
            cache.clear();
        }
        let map = cache.entry(key.clone()).or_default();
        // Keep only the current refs plus what was just read.
        let current: HashSet<&MetaKey> = keys.iter().map(|(k, _)| k).collect();
        map.retain(|k, _| current.contains(k));
        let by_name: HashMap<&str, &MetaKey> = keys.iter().map(|(k, _)| (k.refname.as_str(), k)).collect();
        for record in records {
            let refname = record[0].trim_start_matches('\n');
            // Store under the key this listing saw; a ref that moved in between stays missing
            // and falls back to a full read below.
            if let Some(k) = by_name.get(refname).filter(|k| k.oid == record[1] && k.symref == record[9] && k.upstream == record[11]) {
                let mut fields: Vec<String> = record.iter().map(|f| f.to_string()).collect();
                fields[0] = refname.to_string();
                map.insert((*k).clone(), fields);
            }
        }
    }
    // Assemble under the lock; a ref that moved during this call falls back to a full read
    // after the lock is released (no lock is ever held while Git runs).
    let assembled = {
        let cache = meta_cache().lock();
        cache.get(&key).and_then(|map| {
            let mut out = String::new();
            for (k, is_head) in &keys {
                for (i, field) in map.get(k)?.iter().enumerate() {
                    out.push_str(match (i, is_head) {
                        (5, true) => "*",
                        (5, false) => " ",
                        _ => field,
                    });
                    out.push('\0');
                }
                out.push('\n');
            }
            Some(out)
        })
    };
    match assembled {
        Some(out) => Ok(out),
        None => runner::run(repo, ["for-each-ref", FMT, "refs/heads", "refs/remotes", "refs/tags"]),
    }
}

pub fn snapshot(repo: &Path) -> GitResult<RefsSnapshot> {
    super::repo::require_directory(repo)?;
    let mut stages = super::stage_timings::Stages::default();
    // Independent reads run side by side; each is timed on its own thread.
    fn timed<T>(f: impl FnOnce() -> T) -> (T, std::time::Duration) {
        let started = std::time::Instant::now();
        (f(), started.elapsed())
    }
    fn joined<T>(handle: std::thread::ScopedJoinHandle<'_, (GitResult<T>, std::time::Duration)>) -> (GitResult<T>, std::time::Duration) {
        handle.join().unwrap_or_else(|_| (Err(super::runner::GitError::new("Reference read failed.")), std::time::Duration::ZERO))
    }
    // Helpers join the caller's repository transaction (see `Inherited`).
    let parent = super::operations::Inherited::of(repo);
    let (remotes, raw, stashes, identity_email) = std::thread::scope(|scope| {
        let remotes = scope.spawn(|| parent.run(|| timed(|| remotes(repo))));
        let stashes = scope.spawn(|| parent.run(|| timed(|| stashes(repo))));
        let identity = scope.spawn(|| parent.run(|| timed(|| Ok(super::repo::config_get(repo, "user.email")))));
        // Upstream ahead/behind (`upstream:track`) is computed inside this enumeration.
        let raw = timed(|| enumerate(repo));
        (joined(remotes), raw, joined(stashes), joined(identity))
    });
    stages.add("remotes", remotes.1);
    stages.add("enumerationWithUpstreamTrack", raw.1);
    stages.add("stashes", stashes.1);
    stages.add("identity", identity_email.1);
    let (remotes, raw, stashes, identity_email) = (remotes.0?, raw.0?, stashes.0?, identity_email.0.ok().flatten());
    let parse_started = std::time::Instant::now();
    let mut local = Vec::new();
    let mut remote = Vec::new();
    let mut tags = Vec::new();
    let fields: Vec<&str> = raw.split_terminator('\0').collect();
    let (records, tail) = fields.as_chunks::<13>();
    let mut origins = super::branch_origin::Reader::new(repo);
    if tail.iter().any(|s| !s.trim_matches('\n').is_empty()) {
        return Err(super::runner::GitError::new("Invalid reference metadata record."));
    }
    for f in records {
        let full = f[0].trim_start_matches('\n');
        let time = f[6].parse().unwrap_or(0);
        if let Some(name) = full.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = parse_track(f[4]);
            local.push(BranchInfo {
                name: name.to_string(),
                full_name: full.to_string(),
                oid: f[1].to_string(),
                upstream: Some(f[3].to_string()).filter(|s| !s.is_empty()),
                upstream_full_name: Some(f[11].to_string()).filter(|s| !s.is_empty()),
                ahead,
                behind,
                unpublished: None,
                gone,
                is_head: f[5] == "*",
                remote: None,
                time,
                subject: f[7].to_string(),
                author: f[8].to_string(),
                author_email: f[12].to_string(),
                creator: origins.creator(full),
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
                upstream_full_name: None,
                ahead: 0,
                behind: 0,
                unpublished: None,
                gone: false,
                is_head: false,
                remote: Some(remote_name),
                time,
                subject: f[7].to_string(),
                author: f[8].to_string(),
                author_email: f[12].to_string(),
                creator: None,
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
    // Includes branch creator resolution, which runs per local branch while parsing.
    stages.add("parseAndCreators", parse_started.elapsed());
    if !remotes.is_empty() {
        // A missing object must not prevent the sidebar from listing refs.
        let _ = stages.time("unpublishedComparison", || count_unpublished(repo, &mut local, &remote));
    }
    tags.sort_by_key(|t| std::cmp::Reverse(t.time));
    if super::stage_timings::enabled() {
        let detail = format!("local={} remote={} tags={}", local.len(), remote.len(), tags.len());
        super::stage_timings::record("refs_snapshot", repo, &stages, &detail);
    }
    let fingerprint = fingerprint_of(&(&identity_email, &local, &remote, &tags, &stashes, &remotes));
    let remote_fingerprint = fingerprint_of(&remote.iter().map(|branch| (&branch.full_name, &branch.oid)).collect::<Vec<_>>());
    Ok(RefsSnapshot { identity_email, local, remote, tags, stashes, remotes, fingerprint, remote_fingerprint })
}

fn count_unpublished(repo: &Path, local: &mut [BranchInfo], remote: &[BranchInfo]) -> GitResult<()> {
    let candidates: Vec<_> = local.iter_mut().filter(|branch| branch.upstream.is_none() && !branch.gone).collect();
    if candidates.is_empty() {
        return Ok(());
    }
    // Walk all unpublished histories in one Git process using the snapshot tips.
    // Read OIDs on stdin to avoid Windows command-line limits.
    let tips: HashSet<_> = candidates.iter().map(|branch| branch.oid.as_str()).collect();
    let fetched: HashSet<_> = remote.iter().map(|branch| branch.oid.as_str()).collect();
    let mut revisions = String::new();
    for oid in tips {
        revisions.push_str(oid);
        revisions.push('\n');
    }
    for oid in fetched {
        revisions.push('^');
        revisions.push_str(oid);
        revisions.push('\n');
    }
    let output = super::history::run_with_input(repo, ["rev-list", "--parents", "--stdin", "--"], revisions.as_bytes())?;
    let parents: HashMap<_, _> = output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?, fields))
        })
        .collect();
    let mut counts = HashMap::new();
    for branch in candidates {
        let count = *counts.entry(branch.oid.clone()).or_insert_with(|| {
            let mut seen = HashSet::new();
            let mut pending = vec![branch.oid.as_str()];
            while let Some(oid) = pending.pop() {
                if let Some(ancestors) = parents.get(oid) {
                    if seen.insert(oid) {
                        pending.extend(ancestors.clone());
                    }
                }
            }
            seen.len()
        });
        branch.unpublished = Some(count);
    }
    Ok(())
}

/// False only when the repository surely has no stash: no `refs/stash` file and no packed
/// entry for it (files backend). Saves a `stash list` process on every refresh.
fn may_have_stash(repo: &Path) -> bool {
    let Some(common) = super::graph::common_dir(repo) else { return true };
    if common.join("reftable").exists() || common.join("refs").join("stash").exists() {
        return true;
    }
    match std::fs::read(common.join("packed-refs")) {
        Ok(packed) => packed.split(|b| *b == b'\n').any(|line| line.ends_with(b" refs/stash") || line.ends_with(b" refs/stash\r")),
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

pub fn stashes(repo: &Path) -> GitResult<Vec<StashInfo>> {
    if !may_have_stash(repo) {
        return Ok(Vec::new());
    }
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
            Some(StashInfo {
                index,
                name: f[0].to_string(),
                oid: f[1].to_string(),
                time: f[2].parse().unwrap_or(0),
                message: f[3].to_string(),
                switch_source: super::branch_switch::stash_source(f[3]),
            })
        })
        .collect())
}

pub fn remotes(repo: &Path) -> GitResult<Vec<RemoteInfo>> {
    let raw = super::config_cache::run(repo, &["remote", "-v"])?;
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
/// Branches (local and remote) whose changes are already in HEAD although they are not its
/// ancestors — typically squash- or rebase-merged. Git keeps no link for those, so the graph
/// draws them as unmerged; the UI marks their badges instead. Needs `merge-tree --write-tree`.
pub fn squash_merged(repo: &Path) -> GitResult<Vec<String>> {
    if super::locate::version() < (2, 38, 0) {
        return Ok(Vec::new());
    }
    let Ok(head_tree) = runner::run(repo, ["rev-parse", "HEAD^{tree}"]) else { return Ok(Vec::new()) };
    let head_tree = head_tree.trim().to_string();
    let head_ref = runner::run(repo, ["symbolic-ref", "-q", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    // Ancestors of HEAD are ordinary merges the graph already shows; `--no-merged` drops
    // them in the same walk instead of one `merge-base` process per branch.
    let raw = runner::run(
        repo,
        ["for-each-ref", "--no-merged=HEAD", "--format=%(refname:short)%1f%(refname)%1f%(symref)%1f%(objectname)", "refs/heads", "refs/remotes"],
    )?;
    let candidates: Vec<(String, String)> = raw
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\x1f').collect();
            (f.len() == 4 && f[2].is_empty() && f[1] != head_ref).then(|| (f[0].to_string(), f[3].to_string()))
        })
        .take(80)
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    // One process per candidate; a candidate Git refuses to merge (unrelated history) is skipped.
    let one_by_one = || -> GitResult<Vec<String>> {
        let mut out = Vec::new();
        for (name, oid) in &candidates {
            let merged = runner::exec(repo, ["merge-tree", "--write-tree", "HEAD", oid])?;
            if merged.code == 0 && merged.text().lines().next().map(str::trim) == Some(head_tree.as_str()) {
                out.push(name.clone());
            }
        }
        Ok(out)
    };
    if super::locate::version() < (2, 40, 0) {
        // `merge-tree --stdin` needs Git 2.40.
        return one_by_one();
    }
    // One `merge-tree --stdin` process merges every candidate into HEAD.
    let head = runner::run(repo, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim().to_string();
    let input: String = candidates
        .iter()
        .map(|(_, oid)| {
            format!(
                "{head} {oid}
"
            )
        })
        .collect();
    let out = runner::exec_full(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "--stdin"], &[], Some(input.as_bytes()))?;
    if !out.ok() {
        // The batch stops at the first candidate Git refuses (for example an orphan branch
        // such as gh-pages: "refusing to merge unrelated histories"). Merge them one by one
        // so that branch is skipped and the others keep their answers.
        return one_by_one();
    }
    Ok(squash_results(&out.text(), &head_tree, &candidates))
}

/// Parses `merge-tree --stdin --name-only --no-messages`: per merge `clean NUL tree NUL
/// (conflicted path NUL)* NUL`. A branch is squash-merged when its clean merge into HEAD
/// leaves HEAD's tree unchanged.
fn squash_results(raw: &str, head_tree: &str, candidates: &[(String, String)]) -> Vec<String> {
    let mut fields = raw.split('\0');
    let mut out = Vec::new();
    for (name, _) in candidates {
        let (Some(clean), Some(tree)) = (fields.next(), fields.next()) else { break };
        let mut conflicted = false;
        for path in fields.by_ref() {
            if path.is_empty() {
                break;
            }
            conflicted = true;
        }
        if clean == "1" && !conflicted && tree == head_tree {
            out.push(name.clone());
        }
    }
    out
}

#[test]
fn squash_results_parse_clean_and_conflicted_merges() {
    let candidates = vec![("a".to_string(), "1".to_string()), ("b".to_string(), "2".to_string()), ("c".to_string(), "3".to_string())];
    let raw = concat!("1\0T\0\0", "0\0X\0f\0g\0\0", "1\0Y\0\0");
    assert_eq!(squash_results(raw, "T", &candidates), vec!["a".to_string()]);
    let raw = concat!("1\0T\0\0", "0\0T\0f\0\0", "1\0T\0\0");
    assert_eq!(squash_results(raw, "T", &candidates), vec!["a".to_string(), "c".to_string()]);
}

pub fn labels_by_oid(repo: &Path) -> GitResult<HashMap<String, Vec<RefLabel>>> {
    Ok(graph_refs(repo)?.labels)
}

/// What one history build needs to know about refs, from a single enumeration.
pub struct GraphRefs {
    /// refname -> object name for branches, remote branches and tags, plus HEAD. Sorted.
    pub snapshot: Vec<(String, String)>,
    pub labels: HashMap<String, Vec<RefLabel>>,
    /// Empty while HEAD is unborn.
    pub head_oid: String,
    /// `refs/replace/*` refname -> object name. Replacements change the walked history
    /// without moving a branch, so history caches compare them separately.
    pub replace: Vec<(String, String)>,
}

/// Reads refs once for both the graph's ref snapshot and its labels, so the two
/// cannot disagree and a build does not enumerate refs or resolve HEAD twice.
pub fn graph_refs(repo: &Path) -> GitResult<GraphRefs> {
    // HEAD from Git's files when they are ordinary (no process); see repo::head_from_files.
    if let Some(oid) = super::repo::git_dir(repo).ok().and_then(|gd| super::repo::head_from_files(&gd)).and_then(|head| head.oid) {
        let raw = graph_ref_list(repo)?;
        return graph_refs_from(repo, &raw, runner::Output { stdout: format!("{oid}\n").into_bytes(), stderr: String::new(), code: 0 });
    }
    // HEAD is resolved in parallel with the enumeration (two processes, one wait).
    let parent = super::operations::Inherited::of(repo);
    let (raw, head_out) = std::thread::scope(|scope| {
        let head = scope.spawn(|| parent.run(|| runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD"])));
        let raw = graph_ref_list(repo);
        (raw, head.join().unwrap_or_else(|_| Err(super::runner::GitError::new("Resolve HEAD failed."))))
    });
    let (raw, head_out) = (raw?, head_out?);
    graph_refs_from(repo, &raw, head_out)
}

fn graph_ref_list(repo: &Path) -> GitResult<String> {
    runner::run(
        repo,
        [
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(HEAD)%1f%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/bisect",
            "refs/replace",
        ],
    )
}

fn graph_refs_from(repo: &Path, raw: &str, head_out: runner::Output) -> GitResult<GraphRefs> {
    let head_oid = if head_out.ok() { head_out.text().trim().to_string() } else { String::new() };
    let mut snapshot = Vec::new();
    let mut map: HashMap<String, Vec<RefLabel>> = HashMap::new();
    let mut remote_at: HashMap<String, Vec<String>> = HashMap::new();
    let mut entries = Vec::new();
    let mut replace = Vec::new();
    for line in raw.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 5 {
            continue;
        }
        if f[0].starts_with("refs/replace/") {
            replace.push((f[0].to_string(), f[1].to_string()));
            continue;
        }
        if !f[0].starts_with("refs/bisect/") {
            snapshot.push((f[0].to_string(), f[1].to_string()));
        }
        // Symbolic refs (origin/HEAD) are part of the snapshot but carry no label.
        if !f[4].is_empty() {
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
    // A branch marked as checked out proves HEAD is attached. Ask Git only otherwise
    // (detached, unborn, or HEAD on a ref outside refs/heads).
    let head_detached = !entries.iter().any(|(_, _, is_head)| *is_head) && runner::exec(repo, ["symbolic-ref", "-q", "HEAD"])?.code != 0;
    if head_detached && !head_oid.is_empty() {
        map.entry(head_oid.clone()).or_default().insert(0, RefLabel { name: "HEAD".into(), kind: "detached".into(), synced_remote: None });
    }
    if !head_oid.is_empty() {
        snapshot.push(("HEAD".into(), head_oid.clone()));
    }
    snapshot.sort();
    for v in map.values_mut() {
        let rank = |k: &str| match k {
            "head" | "detached" => 0,
            "local" => 1,
            "remote" => 2,
            _ => 3,
        };
        v.sort_by(|a, b| rank(&a.kind).cmp(&rank(&b.kind)).then(a.name.cmp(&b.name)));
    }
    Ok(GraphRefs { snapshot, labels: map, head_oid, replace })
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
    let meta = |rev: &str| -> Option<(i64, String)> {
        runner::run(repo, ["log", "-1", "--format=%at%x1f%s", rev]).ok().and_then(|s| {
            let (t, subj) = s.trim().split_once('\x1f')?;
            Some((t.parse().ok()?, subj.to_string()))
        })
    };
    let range = format!("{base}..{name}");
    // Independent reads run side by side: one wait instead of eight in a row.
    let parent = super::operations::Inherited::of(repo);
    let (tip, fork, counts, range_log) = std::thread::scope(|scope| {
        let tip = scope.spawn(|| {
            parent.run(|| {
                let tip = runner::run(repo, ["rev-parse", "--verify", &format!("{name}^{{commit}}")]).map(|s| s.trim().to_string());
                let last = tip.as_ref().ok().and_then(|tip| meta(tip));
                (tip, last)
            })
        });
        let fork = scope.spawn(|| {
            parent.run(|| {
                let mb = runner::exec(repo, ["merge-base", base, name]).map(|mb| {
                    if mb.ok() {
                        Some(mb.text().trim().to_string()).filter(|s| !s.is_empty())
                    } else {
                        None
                    }
                });
                let meta = mb.as_ref().ok().and_then(|p| p.as_deref()).and_then(meta);
                (mb, meta)
            })
        });
        // `--left-right --count base...name` prints "behind<TAB>ahead" in one walk.
        let counts = scope.spawn(|| parent.run(|| runner::run(repo, ["rev-list", "--left-right", "--count", &format!("{base}...{name}")])));
        // Oldest commit of the branch and its authors from one walk of `base..name`.
        let range_log = runner::run(repo, ["log", "--format=%H%x1f%an", &range]);
        let failed = || super::runner::GitError::new("Branch details read failed.");
        (
            tip.join().unwrap_or_else(|_| (Err(failed()), None)),
            fork.join().unwrap_or_else(|_| (Err(failed()), None)),
            counts.join().unwrap_or_else(|_| Err(failed())),
            range_log,
        )
    });
    let (tip, last) = tip;
    let tip = tip?;
    let (fork_point, fork_meta) = fork;
    let fork_point = fork_point?;
    let (fork_time, fork_subject) = fork_meta.map(|(t, s)| (Some(t), Some(s))).unwrap_or((None, None));
    let (behind, ahead) = counts
        .ok()
        .and_then(|s| {
            let (left, right) = s.trim().split_once(char::is_whitespace)?;
            Some((left.trim().parse().ok()?, right.trim().parse().ok()?))
        })
        .unwrap_or((0, 0));
    let range_log = range_log.unwrap_or_default();
    let first = range_log.lines().last().and_then(|l| l.split('\x1f').next()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let (first_time, first_subject) = match first.as_deref().and_then(meta) {
        Some((t, s)) => (Some(t), Some(s)),
        None => (None, None),
    };
    let (last_time, last_subject) = last.unwrap_or((0, String::new()));
    let mut authors: Vec<String> = range_log.lines().filter_map(|l| l.split_once('\x1f').map(|(_, a)| a.to_string())).collect();
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

#[cfg(test)]
mod enumerate_tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) {
        let out = runner::exec(root, args).unwrap();
        assert!(out.ok(), "{args:?}: {}", out.stderr);
    }

    fn full(root: &Path) -> String {
        runner::run(root, ["for-each-ref", FMT, "refs/heads", "refs/remotes", "refs/tags"]).unwrap()
    }

    #[test]
    fn an_unchanged_snapshot_is_not_sent_again_and_remote_changes_have_their_own_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.name", "T"]);
        git(root, &["config", "user.email", "t@example.com"]);
        git(root, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(root, &["remote", "add", "origin", "https://example.invalid/r.git"]);
        let first = snapshot(root).unwrap();
        assert_eq!(snapshot(root).unwrap().fingerprint, first.fingerprint);
        assert!(snapshot_if_changed(root, Some(&first.fingerprint)).unwrap().is_none());
        git(root, &["branch", "topic"]);
        let local = snapshot_if_changed(root, Some(&first.fingerprint)).unwrap().expect("a new branch is a change");
        assert_ne!(local.fingerprint, first.fingerprint);
        assert_eq!(local.remote_fingerprint, first.remote_fingerprint, "no remote branch changed");
        git(root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        let remote = snapshot(root).unwrap();
        assert_ne!(remote.remote_fingerprint, local.remote_fingerprint);
        assert_ne!(remote.fingerprint, local.fingerprint);
    }

    #[test]
    fn cached_enumeration_matches_a_full_read_after_every_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.name", "T"]);
        git(root, &["config", "user.email", "t@example.com"]);
        git(root, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(root, &["branch", "topic"]);
        git(root, &["tag", "-a", "v1", "-m", "release"]);
        git(root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(root, &["remote", "add", "origin", "https://example.invalid/r.git"]);
        git(root, &["config", "branch.main.remote", "origin"]);
        git(root, &["config", "branch.main.merge", "refs/heads/main"]);
        let steps: Vec<Vec<&str>> = vec![
            vec!["commit", "-q", "--allow-empty", "-m", "two"],     // main moves: ahead 1
            vec!["update-ref", "refs/remotes/origin/main", "HEAD"], // upstream moves only
            vec!["switch", "-q", "topic"],                          // HEAD flag moves only
            vec!["commit", "-q", "--allow-empty", "-m", "three"],   // another branch moves
            vec!["config", "branch.topic.remote", "origin"],        // upstream config only
            vec!["config", "branch.topic.merge", "refs/heads/main"],
            vec!["update-ref", "-d", "refs/remotes/origin/main"], // upstream gone
            vec!["tag", "-f", "-a", "v1", "-m", "moved"],         // tag re-pointed
        ];
        assert_eq!(enumerate(root).unwrap(), full(root));
        for step in steps {
            git(root, &step);
            assert_eq!(enumerate(root).unwrap(), full(root), "after {step:?}");
            assert_eq!(enumerate(root).unwrap(), full(root), "cached after {step:?}");
        }
    }
}
