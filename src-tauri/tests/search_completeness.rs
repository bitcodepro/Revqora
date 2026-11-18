//! Commit search against Git itself: every match by SHA, author name and email, subject and
//! body across deep pages, and cursors that stop when the history they paged changes.
use std::fs;
use std::path::Path;

use revqora_lib::git::graph::{self, SearchMode};
use revqora_lib::git::runner::{self, GitError};

fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap().trim().to_string()
}

/// 1,300 commits on two branches, written by one `git fast-import` instead of thousands of
/// processes. Authors rotate through five people; every 50th commit has a body-only token.
fn large_history() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "core.autocrlf", "false"], &["config", "commit.gpgsign", "false"]] {
        runner::run(root, args).unwrap();
    }
    let mut stream = String::new();
    let mut mark = 0;
    let mut commit = |stream: &mut String, branch: &str, from: Option<String>, index: usize| -> String {
        mark += 1;
        let person = format!("Person {} <person{}@example.com> {} +0000", index % 5, index % 5, 1_700_000_000 + index);
        let message = if index % 50 == 7 { format!("Change {index}\n\nBody only: DEEP-BODY-{index}\n") } else { format!("Change {index}\n") };
        stream.push_str(&format!("commit refs/heads/{branch}\nmark :{mark}\nauthor {person}\ncommitter {person}\ndata {}\n{message}", message.len()));
        if let Some(from) = from {
            stream.push_str(&format!("from {from}\n"));
        }
        let content = format!("{index}\n");
        stream.push_str(&format!("M 644 inline file.txt\ndata {}\n{content}\n", content.len()));
        format!(":{mark}")
    };
    let mut tip = None;
    for index in 0..1_200 {
        tip = Some(commit(&mut stream, "main", tip.clone(), index));
    }
    let mut side = Some(":600".to_string());
    for index in 1_200..1_300 {
        side = Some(commit(&mut stream, "side", side.clone(), index));
    }
    let mut child = std::process::Command::new("git").args(["fast-import", "--quiet"]).current_dir(root).stdin(std::process::Stdio::piped()).spawn().unwrap();
    std::io::Write::write_all(child.stdin.as_mut().unwrap(), stream.as_bytes()).unwrap();
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    git(root, &["checkout", "-qf", "main"]);
    dir
}

/// What Git itself lists for the refs search covers, newest first.
fn direct(root: &Path, filter: &[&str]) -> Vec<String> {
    let mut args = vec!["log", "--branches", "--remotes", "--tags", "HEAD", "--format=%H", "--regexp-ignore-case", "--fixed-strings"];
    args.extend_from_slice(filter);
    args.push("--");
    git(root, &args).lines().map(str::to_owned).collect()
}

fn all_pages(next: impl Fn(Option<&str>) -> graph::CommitSearchPage) -> Vec<String> {
    let mut cursor: Option<String> = None;
    let mut oids = Vec::new();
    for _ in 0..400 {
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
fn search_finds_every_commit_by_sha_author_subject_and_body_across_deep_pages() {
    let dir = large_history();
    let root = dir.path();
    let everything = direct(root, &[]);
    assert_eq!(everything.len(), 1_300);
    let target = git(root, &["rev-parse", "main~123"]);
    let by_prefix = |prefix: &str| everything.iter().filter(|oid| oid.starts_with(prefix)).cloned().collect::<Vec<_>>();
    let cases: Vec<(&str, SearchMode, Vec<String>)> = vec![
        // Author name and email, each matching 260 commits: several pages.
        ("person 3", SearchMode::Author, direct(root, &["--author=person 3"])),
        ("PERSON1@EXAMPLE", SearchMode::Author, direct(root, &["--author=person1@example"])),
        // Every commit: more than two Git batches of 512 matches, so later pages use --skip.
        ("@example.com", SearchMode::Author, everything.clone()),
        // Subject and body-only text.
        ("change 12", SearchMode::Message, direct(root, &["--grep=change 12"])),
        ("deep-body-1057", SearchMode::Message, direct(root, &["--grep=DEEP-BODY-1057"])),
        ("deep-body-", SearchMode::Quick, direct(root, &["--grep=DEEP-BODY-"])),
        // SHA prefixes, as Git lists them for the same refs.
        (&target[..12], SearchMode::Hash, vec![target.clone()]),
        (&target[..2], SearchMode::Hash, by_prefix(&target[..2])),
    ];
    for (query, mode, expected) in &cases {
        assert!(!expected.is_empty(), "{query}: the fixture must match");
        for limit in [7, 100] {
            let found = all_pages(|cursor| graph::search_repository_page(root, query, *mode, cursor, limit).unwrap());
            assert_eq!(&found, expected, "{query} ({mode:?}, pages of {limit})");
        }
        let workspace = all_pages(|cursor| graph::search_repository_workspace_page(root, query, *mode, cursor, 30).unwrap());
        assert_eq!(&workspace, expected, "{query} ({mode:?}, workspace pages)");
    }
    let quick_sha = graph::search_repository_page(root, &target[..12].to_uppercase(), SearchMode::Quick, None, 100).unwrap();
    assert_eq!(quick_sha.commits.iter().map(|hit| hit.oid.as_str()).collect::<Vec<_>>(), [target.as_str()], "All mode, upper-case SHA prefix");

    // A deep cursor resumed after other searches pushed its batch out of the cache walks
    // history again from its offset and continues exactly where it stopped.
    let mut cursor = None;
    let mut paged = Vec::new();
    for _ in 0..9 {
        let page = graph::search_repository_page(root, "@example.com", SearchMode::Author, cursor.as_deref(), 100).unwrap();
        paged.extend(page.commits.into_iter().map(|hit| hit.oid));
        cursor = page.next_cursor;
    }
    for other in ["person 0", "person 2", "person 4", "change 9", "change 8"] {
        graph::search_repository_page(root, other, SearchMode::Author, None, 100).unwrap();
        graph::search_repository_page(root, other, SearchMode::Message, None, 100).unwrap();
    }
    let resumed = graph::search_repository_page(root, "@example.com", SearchMode::Author, cursor.as_deref(), 100).unwrap();
    assert!(!resumed.diagnostics.cache_hit, "the batch was evicted");
    assert_eq!(resumed.commits.len(), 100);
    // A page that reaches the end of a Git batch is shorter; nothing is skipped or repeated.
    assert!(paged.len() > 700, "{}", paged.len());
    paged.extend(resumed.commits.into_iter().map(|hit| hit.oid));
    assert_eq!(paged, everything[..paged.len()], "pages 1–10 across an eviction");
}

#[test]
fn search_cursors_stop_after_fetch_ref_changes_and_history_rewrites() {
    let dir = large_history();
    let root = dir.path();
    let first = |query: &str, mode: SearchMode| graph::search_repository_page(root, query, mode, None, 50).unwrap().next_cursor.unwrap();
    let next = |query: &str, mode: SearchMode, cursor: &str| graph::search_repository_page(root, query, mode, Some(cursor), 50).map(|page| page.commits.len());
    let stale = |result: Result<usize, GitError>| result.err().map(|error| error.kind);

    // Unchanged refs: the cursor continues, also after unrelated work in the working tree.
    let cursor = first("person", SearchMode::Author);
    fs::write(root.join("untracked.txt"), "not history").unwrap();
    assert_eq!(next("person", SearchMode::Author, &cursor).unwrap(), 50);

    // A fetch moves a remote-tracking branch.
    let cursor = first("person", SearchMode::Author);
    git(root, &["update-ref", "refs/remotes/origin/main", "main~5"]);
    assert_eq!(stale(next("person", SearchMode::Author, &cursor)), Some("stale-operation".into()), "fetch");

    // A branch or tag appears or moves without a new commit.
    for change in [&["branch", "extra", "main~40"][..], &["tag", "v1", "side"], &["branch", "-f", "extra", "main~41"]] {
        let cursor = first("change", SearchMode::Message);
        git(root, change);
        assert_eq!(stale(next("change", SearchMode::Message, &cursor)), Some("stale-operation".into()), "{change:?}");
    }

    // History rewritten by another tool: an amend and a hard reset of the checked-out branch.
    for rewrite in [
        &["-c", "user.name=Other", "-c", "user.email=other@example.com", "commit", "-q", "--amend", "-m", "Rewritten tip"][..],
        &["reset", "-q", "--hard", "main~3"],
    ] {
        let cursor = first("change", SearchMode::Quick);
        git(root, rewrite);
        assert_eq!(stale(next("change", SearchMode::Quick, &cursor)), Some("stale-operation".into()), "{rewrite:?}");
        // Starting again lists the rewritten history.
        let fresh = all_pages(|cursor| graph::search_repository_page(root, "change", SearchMode::Quick, cursor, 100).unwrap());
        assert_eq!(fresh, direct(root, &["--grep=change"]));
    }
}
