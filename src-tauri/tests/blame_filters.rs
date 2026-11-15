//! Blame options (whitespace, moved lines, ignore-revs) and combined History filters.
use std::fs;
use std::path::Path;

use revqora_lib::git::graph::{self, HistoryFilters, SearchMode};
use revqora_lib::git::inspect::{self, BlameMoves, BlameOptions};
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

fn write(root: &Path, file: &str, text: &str) {
    if let Some(parent) = Path::new(file).parent() {
        fs::create_dir_all(root.join(parent)).unwrap();
    }
    fs::write(root.join(file), text).unwrap();
}

/// Commit everything as `author` on `date` (author and committer date).
fn commit_as(root: &Path, author: &str, date: &str, msg: &str) -> String {
    runner::run(root, ["add", "-A"]).unwrap();
    let name = format!("user.name={author}");
    let email = format!("user.email={}@example.com", author.to_lowercase());
    let date = format!("{date}T12:00:00+00:00");
    runner::run_env(
        root,
        ["-c", &name, "-c", &email, "commit", "-q", "--allow-empty", "-m", msg],
        &[("GIT_AUTHOR_DATE", &date), ("GIT_COMMITTER_DATE", &date)],
        None,
    )
    .unwrap();
    runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim().to_string()
}

fn commit(root: &Path, msg: &str) -> String {
    commit_as(root, "Tester", "2024-01-01", msg)
}

fn opts(moves: BlameMoves) -> BlameOptions {
    BlameOptions { ignore_whitespace: true, moves, ignore_revs: true }
}

const BLOCK_A: &str = "alpha_function_computes_the_first_long_value(arguments)\nalpha_function_returns_the_second_long_value(arguments)\nalpha_function_handles_the_third_long_value(arguments)\n";
const BLOCK_B: &str = "bravo_routine_prepares_the_first_long_result(parameters)\nbravo_routine_validates_the_second_long_result(parameters)\nbravo_routine_finishes_the_third_long_result(parameters)\n";

#[test]
fn blame_move_detection_within_file_keeps_the_original_commit() {
    let dir = repo();
    let root = dir.path();
    write(root, "a.txt", &format!("{BLOCK_A}{BLOCK_B}"));
    let original = commit(root, "original");
    write(root, "a.txt", &format!("{BLOCK_B}{BLOCK_A}"));
    let swap = commit(root, "swap blocks");
    let off = inspect::blame_with(root, "a.txt", None, opts(BlameMoves::Off)).unwrap();
    assert!(off.lines.iter().any(|l| l.oid == swap), "without -M the moved block belongs to the swap");
    let within = inspect::blame_with(root, "a.txt", None, opts(BlameMoves::File)).unwrap();
    assert!(within.lines.iter().all(|l| l.oid == original), "-M attributes both blocks to the original commit");
    assert!(within.lines.iter().all(|l| l.orig_path == "a.txt"));
}

#[test]
fn blame_across_files_reports_the_original_commit_and_path() {
    let dir = repo();
    let root = dir.path();
    write(root, "a.txt", &format!("{BLOCK_A}{BLOCK_B}"));
    let original = commit(root, "original");
    // Move block B into a new file.
    write(root, "a.txt", BLOCK_A);
    write(root, "b.txt", &format!("header line\n{BLOCK_B}"));
    let moved = commit(root, "move block to b");
    let off = inspect::blame_with(root, "b.txt", None, opts(BlameMoves::Off)).unwrap();
    assert!(off.lines.iter().all(|l| l.oid == moved && l.orig_path == "b.txt"));
    let across = inspect::blame_with(root, "b.txt", None, opts(BlameMoves::Files)).unwrap();
    assert_eq!(across.lines[0].oid, moved);
    for line in &across.lines[1..] {
        assert_eq!(line.oid, original, "{line:?}");
        assert_eq!(line.orig_path, "a.txt");
    }
    assert_eq!(across.lines[1].orig_line, 4);
}

#[test]
fn blame_ignore_revs_file_skips_a_formatting_commit() {
    let dir = repo();
    let root = dir.path();
    write(root, "code.txt", "let first=compute(1)\nlet second=compute(2)\n");
    let original = commit(root, "original");
    write(root, "code.txt", "let first = compute(1);\nlet second = compute(2);\n");
    let format = commit(root, "format");
    write(root, inspect::IGNORE_REVS_FILE, &format!("# formatting\n{format}\n"));
    commit(root, "add ignore revs");
    let mut options = BlameOptions { ignore_whitespace: false, moves: BlameMoves::Off, ignore_revs: true };
    let ignored = inspect::blame_with(root, "code.txt", None, options).unwrap();
    assert!(ignored.lines.iter().all(|l| l.oid == original), "{:?}", ignored.lines);
    options.ignore_revs = false;
    let plain = inspect::blame_with(root, "code.txt", None, options).unwrap();
    assert!(plain.lines.iter().all(|l| l.oid == format));
}

#[test]
fn blame_tolerates_a_configured_but_missing_ignore_revs_file() {
    let dir = repo();
    let root = dir.path();
    write(root, "a.txt", "one\ntwo\n");
    let first = commit(root, "first");
    runner::run(root, ["config", "blame.ignoreRevsFile", "missing-ignore-revs"]).unwrap();
    assert!(runner::run(root, ["blame", "--porcelain", "--", "a.txt"]).is_err(), "plain Git fails on the missing file");
    let blame = inspect::blame(root, "a.txt", None).unwrap();
    assert_eq!(blame.lines.len(), 2);
    assert!(blame.lines.iter().all(|l| l.oid == first));
    // Turning the option off also works with the broken configuration.
    let off = BlameOptions { ignore_revs: false, ..BlameOptions::default() };
    assert_eq!(inspect::blame_with(root, "a.txt", None, off).unwrap().lines.len(), 2);
}

#[test]
fn blame_rejects_option_like_revisions() {
    let dir = repo();
    let root = dir.path();
    write(root, "a.txt", "one\n");
    commit(root, "first");
    for rev in ["", "--output=x", "-L1,1", " HEAD", "HEAD\n"] {
        let error = inspect::blame(root, "a.txt", Some(rev)).unwrap_err();
        assert_eq!(error.kind, "invalid-argument", "{rev:?}");
    }
    assert!(!root.join("x").exists());
    assert_eq!(inspect::blame(root, "a.txt", Some("HEAD")).unwrap().lines.len(), 1);
}

/// init (Ann, Jan) -> docs (Bob, Feb) -> [side: side work (Ann, Mar 5)] / main change (Bob, Mar 10) -> Merge side (Bob, Mar 20)
fn history_repo() -> tempfile::TempDir {
    let dir = repo();
    let root = dir.path();
    write(root, "src/a.txt", "a\n");
    commit_as(root, "Ann", "2024-01-10", "init");
    write(root, "docs/readme.md", "docs\n");
    commit_as(root, "Bob", "2024-02-10", "docs");
    runner::run(root, ["switch", "-q", "-c", "side"]).unwrap();
    write(root, "src/b.txt", "b\n");
    commit_as(root, "Ann", "2024-03-05", "side work");
    runner::run(root, ["switch", "-q", "main"]).unwrap();
    write(root, "src/a.txt", "a2\n");
    commit_as(root, "Bob", "2024-03-10", "main change");
    runner::run_env(
        root,
        ["-c", "user.name=Bob", "-c", "user.email=bob@example.com", "merge", "-q", "--no-ff", "-m", "Merge side", "side"],
        &[("GIT_AUTHOR_DATE", "2024-03-20T12:00:00+00:00"), ("GIT_COMMITTER_DATE", "2024-03-20T12:00:00+00:00")],
        None,
    )
    .unwrap();
    dir
}

fn subjects(root: &Path, query: &str, mode: SearchMode, filters: &HistoryFilters) -> Vec<String> {
    let cache = graph::build(root, Some("HEAD"), false, 1000, false).unwrap();
    graph::search_history_filtered(root, &cache, query, mode, filters).unwrap().into_iter().map(|m| m.row.subject).collect()
}

fn f() -> HistoryFilters {
    HistoryFilters::default()
}

#[test]
fn history_filter_author_alone_and_with_quick_search() {
    let dir = history_repo();
    let root = dir.path();
    let ann = HistoryFilters { author: "ann".into(), ..f() };
    assert_eq!(subjects(root, "", SearchMode::Quick, &ann), ["side work", "init"]);
    // The search text and the filter must both match.
    assert_eq!(subjects(root, "work", SearchMode::Quick, &ann), ["side work"]);
    let bob = HistoryFilters { author: "bob".into(), ..f() };
    assert!(subjects(root, "work", SearchMode::Quick, &bob).is_empty());
    // Author search mode plus author filter is an AND, although Git ORs repeated --author.
    assert!(subjects(root, "ann", SearchMode::Author, &bob).is_empty());
    // Without filters an empty query still returns nothing.
    assert!(subjects(root, "", SearchMode::Quick, &f()).is_empty());
}

#[test]
fn history_filter_path_is_literal_and_matches_folders() {
    let dir = history_repo();
    let root = dir.path();
    let src = HistoryFilters { path: "src/".into(), ..f() };
    let hits = subjects(root, "", SearchMode::Quick, &src);
    assert!(hits.contains(&"init".to_string()) && hits.contains(&"side work".to_string()) && hits.contains(&"main change".to_string()), "{hits:?}");
    assert!(!hits.contains(&"docs".to_string()));
    let glob = HistoryFilters { path: "src*".into(), ..f() };
    assert!(subjects(root, "", SearchMode::Quick, &glob).is_empty(), "wildcards are not expanded");
    // Path search mode inside the filter folder keeps the narrower path; disjoint paths match nothing.
    assert_eq!(subjects(root, "src/b.txt", SearchMode::Path, &src), ["side work"]);
    assert!(subjects(root, "docs", SearchMode::Path, &src).is_empty());
}

#[test]
fn history_filter_dates_are_inclusive_days() {
    let dir = history_repo();
    let root = dir.path();
    let range = HistoryFilters { since: "2024-02-10".into(), until: "2024-03-05".into(), ..f() };
    assert_eq!(subjects(root, "", SearchMode::Quick, &range), ["side work", "docs"]);
    let since = HistoryFilters { since: "2024-03-10".into(), ..f() };
    assert_eq!(subjects(root, "", SearchMode::Quick, &since), ["Merge side", "main change"]);
}

#[test]
fn history_filters_combine_author_path_and_date() {
    let dir = history_repo();
    let root = dir.path();
    let combo = HistoryFilters { author: "Ann".into(), path: "src".into(), since: "2024-02-01".into(), until: "2024-12-31".into(), ..f() };
    assert_eq!(subjects(root, "", SearchMode::Quick, &combo), ["side work"]);
    let none = HistoryFilters { until: "2024-02-01".into(), ..combo };
    assert!(subjects(root, "", SearchMode::Quick, &none).is_empty());
}

#[test]
fn history_filter_first_parent_and_no_merges() {
    let dir = history_repo();
    let root = dir.path();
    let first = HistoryFilters { first_parent: true, ..f() };
    assert_eq!(subjects(root, "", SearchMode::Quick, &first), ["Merge side", "main change", "docs", "init"]);
    let no_merges = HistoryFilters { no_merges: true, ..f() };
    let hits = subjects(root, "", SearchMode::Quick, &no_merges);
    assert_eq!(hits.len(), 4);
    assert!(!hits.contains(&"Merge side".to_string()));
    let both = HistoryFilters { first_parent: true, no_merges: true, ..f() };
    assert_eq!(subjects(root, "", SearchMode::Quick, &both), ["main change", "docs", "init"]);
}

#[test]
fn history_filters_reject_invalid_values() {
    let dir = history_repo();
    let root = dir.path();
    let cache = graph::build(root, Some("HEAD"), false, 1000, false).unwrap();
    for bad in [
        HistoryFilters { since: "2024-13-01".into(), ..f() },
        HistoryFilters { until: "yesterday".into(), ..f() },
        HistoryFilters { author: "--all".into(), ..f() },
        HistoryFilters { path: "-x".into(), ..f() },
        HistoryFilters { since: "2024-05-02".into(), until: "2024-05-01".into(), ..f() },
    ] {
        let error = graph::search_history_filtered(root, &cache, "", SearchMode::Quick, &bad).unwrap_err();
        assert_eq!(error.kind, "invalid-argument", "{bad:?}");
    }
}
