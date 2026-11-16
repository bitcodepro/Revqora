//! Recent-branch history cache (reuse and invalidation) and the shared workspace/MCP
//! commit search pages.
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use revqora_lib::git::graph::{self, GraphCache, RecentGraphs, SearchMode, ViewScope, RECENT_GRAPHS_PER_REPOSITORY};
use revqora_lib::git::runner;

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "Tester"],
        &["config", "user.email", "tester@example.com"],
        &["config", "core.autocrlf", "false"],
        &["config", "commit.gpgsign", "false"],
    ] {
        runner::run(dir.path(), args).unwrap();
    }
    dir
}

fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap().trim().to_string()
}

fn commit(root: &Path, file: &str, message: &str) -> String {
    fs::write(root.join(file), message).unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-qm", message]);
    git(root, &["rev-parse", "HEAD"])
}

fn scope(branch: &str) -> ViewScope<'_> {
    ViewScope { branch: Some(branch), show_incoming: false, context: None }
}

/// What `graph_load` does: start from a recent build of the scope, else the displayed graph.
fn load(root: &Path, recent: &RecentGraphs, displayed: Option<&Arc<GraphCache>>, branch: &str, include_worktree: bool) -> graph::Refresh {
    let key = root.to_string_lossy().to_string();
    let prev = recent.find(&key, &scope(branch), include_worktree, 1000).or_else(|| displayed.cloned());
    let refresh = graph::refresh_for_view_timed(root, scope(branch), include_worktree, 1000, false, prev.as_ref(), displayed).unwrap();
    recent.remember(&key, &refresh.cache);
    refresh
}

fn two_branches() -> tempfile::TempDir {
    let dir = repo();
    let root = dir.path();
    commit(root, "a.txt", "base");
    git(root, &["checkout", "-qb", "feature"]);
    commit(root, "b.txt", "feature work");
    git(root, &["checkout", "-q", "main"]);
    commit(root, "c.txt", "main work");
    dir
}

#[test]
fn returning_to_a_recent_branch_reuses_its_build() {
    let dir = two_branches();
    let root = dir.path();
    let recent = RecentGraphs::default();
    let main = load(root, &recent, None, "refs/heads/main", false);
    assert!(!main.unchanged);
    let feature = load(root, &recent, Some(&main.cache), "refs/heads/feature", false);
    assert!(!feature.unchanged);
    assert_ne!(feature.cache.key, main.cache.key);
    // Back to main while the displayed graph is the feature build.
    let back = load(root, &recent, Some(&feature.cache), "refs/heads/main", false);
    assert!(back.unchanged, "an unchanged recent build is returned as is");
    assert_eq!(back.cache.key, main.cache.key);
    assert!(Arc::ptr_eq(&back.cache, &main.cache));
    assert!(back.stages.get("refResolution").is_some(), "the reuse still checked refs");
    assert!(back.stages.get("laneLayout").is_none(), "no new layout for a reused build");
    // Rows of the reused build still describe main, not the displayed feature graph.
    let subjects: Vec<_> = back.cache.rows.iter().map(|row| row.subject.as_str()).collect();
    assert_eq!(subjects, ["main work", "base"]);
    let (builds, rows) = recent.usage();
    assert_eq!((builds, rows), (2, 4));
}

#[test]
fn recent_builds_are_rebuilt_after_ref_or_option_changes() {
    let dir = two_branches();
    let root = dir.path();
    let recent = RecentGraphs::default();
    let main = load(root, &recent, None, "refs/heads/main", false);
    let feature = load(root, &recent, Some(&main.cache), "refs/heads/feature", false);

    // Display option: the worktree row is a different request.
    let key = root.to_string_lossy().to_string();
    assert!(recent.find(&key, &scope("refs/heads/main"), true, 1000).is_none());
    assert!(recent.find(&key, &ViewScope { branch: Some("refs/heads/main"), show_incoming: true, context: None }, false, 1000).is_none());
    assert!(recent.find(&key, &scope("refs/heads/main"), false, 999).is_none());

    // Any ref moving (here an unrelated tag) gives a new build with a new key.
    git(root, &["tag", "v1", "HEAD~1"]);
    let back = load(root, &recent, Some(&feature.cache), "refs/heads/main", false);
    assert!(!back.unchanged);
    assert_ne!(back.cache.key, main.cache.key);
    assert!(back.cache.rows.iter().any(|row| row.refs.iter().any(|label| label.name == "v1")));

    // The scope's own tip moving changes its rows.
    let tip = commit(root, "d.txt", "newer main work");
    let moved = load(root, &recent, Some(&back.cache), "refs/heads/main", false);
    assert!(!moved.unchanged);
    assert_eq!(moved.cache.rows[0].oid, tip);
}

#[test]
fn replace_refs_and_shallow_state_invalidate_recent_builds() {
    let dir = two_branches();
    let root = dir.path();
    let recent = RecentGraphs::default();
    let main = load(root, &recent, None, "refs/heads/main", false);
    let feature = load(root, &recent, Some(&main.cache), "refs/heads/feature", false);

    // `git replace` changes the walked history without moving any branch, tag or HEAD.
    let base = git(root, &["rev-parse", "main~1"]);
    let tree = git(root, &["rev-parse", "main~1^{tree}"]);
    let substitute = git(root, &["commit-tree", &tree, "-m", "replacement base"]);
    git(root, &["replace", &base, &substitute]);
    let replaced = load(root, &recent, Some(&feature.cache), "refs/heads/main", false);
    assert!(!replaced.unchanged, "a replace ref must invalidate the recent build");
    assert!(replaced.cache.rows.iter().any(|row| row.subject == "replacement base"));
    git(root, &["replace", "-d", &base]);

    let restored = load(root, &recent, Some(&replaced.cache), "refs/heads/main", false);
    assert!(!restored.unchanged);
    assert!(restored.cache.rows.iter().all(|row| row.subject != "replacement base"));

    // A shallow boundary hides the parents of the listed commit.
    let git_dir = root.join(".git");
    fs::write(git_dir.join("shallow"), format!("{}\n", git(root, &["rev-parse", "main"]))).unwrap();
    let shallow = load(root, &recent, Some(&restored.cache), "refs/heads/main", false);
    assert!(!shallow.unchanged, "a shallow boundary must invalidate the recent build");
    assert_eq!(shallow.cache.rows.len(), 1);
    fs::remove_file(git_dir.join("shallow")).unwrap();
    let full = load(root, &recent, Some(&shallow.cache), "refs/heads/main", false);
    assert!(!full.unchanged);
    assert_eq!(full.cache.rows.len(), 2);
}

#[test]
fn the_recent_cache_is_bounded_per_repository() {
    let dir = repo();
    let root = dir.path();
    commit(root, "a.txt", "base");
    let names: Vec<String> = (0..RECENT_GRAPHS_PER_REPOSITORY + 3).map(|index| format!("topic-{index}")).collect();
    for name in &names {
        git(root, &["branch", name]);
    }
    let recent = RecentGraphs::default();
    let mut displayed: Option<Arc<GraphCache>> = None;
    for name in &names {
        let reference = format!("refs/heads/{name}");
        let refresh = load(root, &recent, displayed.as_ref(), &reference, false);
        displayed = Some(refresh.cache);
    }
    let (builds, _) = recent.usage();
    assert_eq!(builds, RECENT_GRAPHS_PER_REPOSITORY);
    let key = root.to_string_lossy().to_string();
    assert!(recent.find(&key, &scope("refs/heads/topic-0"), false, 1000).is_none(), "the oldest build was evicted");
    assert!(recent.find(&key, &scope(&format!("refs/heads/{}", names.last().unwrap())), false, 1000).is_some());
    // Revisiting one scope keeps one entry for it.
    load(root, &recent, displayed.as_ref(), &format!("refs/heads/{}", names.last().unwrap()), false);
    assert_eq!(recent.usage().0, RECENT_GRAPHS_PER_REPOSITORY);
    recent.forget(&key);
    assert_eq!(recent.usage(), (0, 0));
}

fn all_pages(next: impl Fn(Option<&str>) -> graph::CommitSearchPage) -> Vec<String> {
    let mut cursor: Option<String> = None;
    let mut oids = Vec::new();
    for _ in 0..100 {
        let page = next(cursor.as_deref());
        oids.extend(page.commits.into_iter().map(|hit| hit.oid));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return oids,
        }
    }
    panic!("search cursors did not finish");
}

#[test]
fn workspace_search_pages_match_the_mcp_pages_and_include_bodies() {
    let dir = repo();
    let root = dir.path();
    let mut expected_body = String::new();
    for index in 0..75 {
        let message = if index == 3 { "Plain subject\n\nOnly the body has WS-BODY-TOKEN".to_string() } else { format!("Feature step {index}") };
        fs::write(root.join("file.txt"), index.to_string()).unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-qm", &message]);
        if index == 3 {
            expected_body = git(root, &["rev-parse", "HEAD"]);
        }
    }
    git(root, &["checkout", "-qb", "side", "HEAD~70"]);
    commit(root, "side.txt", "Feature step on the side branch");
    git(root, &["checkout", "-q", "main"]);

    // All mode includes full commit bodies, in both the workspace and MCP pages.
    let body = graph::search_repository_workspace_page(root, "ws-body-token", SearchMode::Quick, None, 30).unwrap();
    assert_eq!(body.commits.iter().map(|hit| hit.oid.as_str()).collect::<Vec<_>>(), [expected_body.as_str()]);
    let legacy = graph::search_repository(root, "WS-BODY-TOKEN", SearchMode::Quick).unwrap();
    assert_eq!(legacy.len(), 1);

    for (query, mode) in [("feature step", SearchMode::Quick), ("tester@example", SearchMode::Author), ("feature", SearchMode::Message)] {
        let workspace = all_pages(|cursor| graph::search_repository_workspace_page(root, query, mode, cursor, 30).unwrap());
        let mcp = all_pages(|cursor| graph::search_repository_page(root, query, mode, cursor, 30).unwrap());
        assert_eq!(workspace, mcp, "{query}");
        let direct = git(root, &["log", "--branches", "--remotes", "--tags", "HEAD", "--format=%H"]);
        let direct: Vec<&str> = direct.lines().collect();
        let matching = if mode == SearchMode::Author { direct.len() } else { direct.len() - 1 };
        assert_eq!(workspace.len(), matching, "{query}: every matching commit across pages");
        assert_eq!(workspace.iter().collect::<HashSet<_>>().len(), workspace.len(), "{query}: no duplicates across pages");
        // Pages follow Git's newest-first order.
        let order: Vec<&str> = direct.iter().copied().filter(|oid| workspace.iter().any(|hit| hit == oid)).collect();
        assert_eq!(workspace.iter().map(String::as_str).collect::<Vec<_>>(), order, "{query}");
    }

    // The first page reports more results instead of silently stopping at 30.
    let first = graph::search_repository_workspace_page(root, "feature step", SearchMode::Quick, None, 30).unwrap();
    assert_eq!(first.commits.len(), 30);
    assert!(first.has_more && first.next_cursor.is_some());
    // Hash prefixes and empty queries.
    let hash = graph::search_repository_workspace_page(root, &expected_body[..10], SearchMode::Hash, None, 30).unwrap();
    assert_eq!(hash.commits.len(), 1);
    assert!(graph::search_repository_workspace_page(root, "  ", SearchMode::Quick, None, 30).unwrap().commits.is_empty());
    // A cursor from a different history is refused rather than mixing results.
    let cursor = first.next_cursor.unwrap();
    commit(root, "late.txt", "Feature step after the first page");
    let stale = graph::search_repository_workspace_page(root, "feature step", SearchMode::Quick, Some(&cursor), 30);
    assert_eq!(stale.err().map(|error| error.kind), Some("stale-operation".into()));
}
