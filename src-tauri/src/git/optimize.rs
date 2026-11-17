//! Quiet background housekeeping that keeps Git's own caches fresh, so history, branch
//! and search queries stay fast. It writes only what `git gc --auto` and `git fetch`
//! (with `fetch.writeCommitGraph`) would write themselves:
//! - the commit-graph file (newest-first history pages, counts and ancestry checks need
//!   no full object walk), written incrementally with `--split`;
//! - `packed-refs` when many refs are loose (every ref listing reads one file instead of
//!   thousands).
//!
//! No ref, the index or the working tree changes. Users who turned the matching Git
//! housekeeping off (`gc.auto=0`, `gc.packRefs=false`, `gc.writeCommitGraph=false`,
//! `core.commitGraph=false`) are respected.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use super::runner;

/// Loose refs above this count are packed.
const LOOSE_REF_LIMIT: usize = 100;
/// The earliest re-check of the same repository.
const INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Housekeeping waits this long so it never competes with opening a repository or
/// with the reads a fetch triggers.
const SETTLE: Duration = Duration::from_secs(8);

#[derive(Default)]
struct Slot {
    running: bool,
    checked: Option<Instant>,
    /// Ref fingerprint at the last commit-graph write.
    graph_refs: Option<(usize, Option<SystemTime>, usize)>,
}

fn slots() -> &'static Mutex<HashMap<PathBuf, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<PathBuf, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

/// Schedules housekeeping on a background thread unless it ran recently or is running.
/// `force` skips the interval (after a fetch or another bulk ref change).
pub fn schedule(repo: &Path, force: bool) {
    if std::env::var_os("REVQORA_NO_AUTO_OPTIMIZE").is_some() {
        return;
    }
    let key = repo.to_path_buf();
    {
        let mut map = slots().lock().unwrap_or_else(|e| e.into_inner());
        let slot = map.entry(key.clone()).or_default();
        if slot.running || (!force && slot.checked.is_some_and(|at| at.elapsed() < INTERVAL)) {
            return;
        }
        slot.running = true;
    }
    let spawned = std::thread::Builder::new().name("revqora-optimize".into()).spawn(move || {
        std::thread::sleep(SETTLE);
        let previous = slots().lock().unwrap_or_else(|e| e.into_inner()).get(&key).and_then(|s| s.graph_refs);
        let written = runner::in_background(|| run(&key, previous));
        let mut map = slots().lock().unwrap_or_else(|e| e.into_inner());
        let slot = map.entry(key).or_default();
        slot.running = false;
        slot.checked = Some(Instant::now());
        if written.is_some() {
            slot.graph_refs = written;
        }
    });
    if spawned.is_err() {
        let mut map = slots().lock().unwrap_or_else(|e| e.into_inner());
        map.entry(repo.to_path_buf()).or_default().running = false;
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub pack_refs: bool,
    pub write_graph: bool,
}

/// Decides what to refresh. `fingerprint` is the current ref fingerprint, `previous`
/// the one at the last commit-graph write in this process.
pub fn plan(
    config: &str,
    loose_refs: usize,
    has_graph: bool,
    fingerprint: (usize, Option<SystemTime>, usize),
    previous: Option<(usize, Option<SystemTime>, usize)>,
) -> Plan {
    let mut values: HashMap<String, String> = HashMap::new();
    for line in config.lines() {
        let (key, value) = line.split_once(' ').unwrap_or((line, "true"));
        values.insert(key.to_ascii_lowercase(), value.trim().to_ascii_lowercase());
    }
    let off = |key: &str| values.get(key).is_some_and(|v| matches!(v.as_str(), "false" | "no" | "off" | "0"));
    let gc_off = values.get("gc.auto").is_some_and(|v| v.trim() == "0");
    Plan {
        pack_refs: !gc_off && !off("gc.packrefs") && loose_refs > LOOSE_REF_LIMIT,
        write_graph: !gc_off && !off("gc.writecommitgraph") && !off("core.commitgraph") && (!has_graph || previous != Some(fingerprint)),
    }
}

/// Runs the plan now. Returns the ref fingerprint after a commit-graph write.
pub fn run(repo: &Path, previous: Option<(usize, Option<SystemTime>, usize)>) -> Option<(usize, Option<SystemTime>, usize)> {
    let common = super::graph::common_dir(repo)?;
    if common.join("shallow").exists() {
        return None; // Git does not use a commit-graph in shallow repositories.
    }
    let config = runner::run(repo, ["config", "--get-regexp", r"^(gc\.auto|gc\.packrefs|gc\.writecommitgraph|core\.commitgraph)$"]).unwrap_or_default();
    let loose = count_loose_refs(&common.join("refs"), LOOSE_REF_LIMIT + 1);
    let fingerprint = ref_fingerprint(&common);
    let plan = plan(&config, loose, super::graph::has_commit_graph(repo), fingerprint, previous);
    if plan.pack_refs {
        let _ = runner::run(repo, ["pack-refs", "--all"]);
    }
    if !plan.write_graph {
        return None;
    }
    // `--split` appends only new commits to the chain; Git merges small layers itself.
    let out = runner::exec(repo, ["commit-graph", "write", "--reachable", "--changed-paths", "--split", "--no-progress"]).ok()?;
    out.ok().then(|| ref_fingerprint(&common))
}

/// Counts loose ref files, stopping at `stop`.
fn count_loose_refs(dir: &Path, stop: usize) -> usize {
    let mut count = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(entry.path()),
                Ok(t) if t.is_file() => {
                    count += 1;
                    if count >= stop {
                        return count;
                    }
                }
                _ => {}
            }
        }
    }
    count
}

/// Cheap change detector for the ref set: loose ref count, packed-refs mtime and size.
fn ref_fingerprint(common: &Path) -> (usize, Option<SystemTime>, usize) {
    let packed = std::fs::metadata(common.join("packed-refs")).ok();
    (count_loose_refs(&common.join("refs"), usize::MAX), packed.as_ref().and_then(|m| m.modified().ok()), packed.map(|m| m.len() as usize).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_respects_disabled_housekeeping_and_thresholds() {
        let fp = (3, None, 0);
        assert_eq!(plan("", 500, false, fp, None), Plan { pack_refs: true, write_graph: true });
        assert_eq!(plan("", 10, true, fp, Some(fp)), Plan { pack_refs: false, write_graph: false });
        assert_eq!(plan("", 10, true, fp, Some((4, None, 0))), Plan { pack_refs: false, write_graph: true });
        assert_eq!(plan("gc.auto 0", 500, false, fp, None), Plan::default());
        assert_eq!(plan("gc.packrefs false\ncore.commitgraph false", 500, false, fp, None), Plan::default());
        assert_eq!(plan("gc.writeCommitGraph no", 500, false, fp, None), Plan { pack_refs: true, write_graph: false });
    }
}
