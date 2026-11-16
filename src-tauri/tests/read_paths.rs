//! Everyday read paths: history builds reuse what did not change, concurrent builds are
//! ordered, and status/repository reads give the same answers with fewer Git processes.
use std::fs;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use revqora_lib::git::graph::{self, BuildOrder, ViewScope};
use revqora_lib::git::{operations, refs, repo as grepo, runner, status};

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

fn commit_file(root: &Path, file: &str, text: &str, message: &str) -> String {
    fs::write(root.join(file), text).unwrap();
    runner::run(root, ["add", "-A"]).unwrap();
    runner::run(root, ["commit", "-qm", message]).unwrap();
    git(root, &["rev-parse", "HEAD"])
}

fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap().trim().to_string()
}

fn head_scope(show_incoming: bool) -> ViewScope<'static> {
    ViewScope { branch: Some("HEAD"), show_incoming, context: None }
}

fn marks(cache: &graph::GraphCache) -> Vec<(String, bool, Vec<String>)> {
    cache.rows.iter().map(|row| (row.oid.clone(), row.local_only, row.refs.iter().map(|label| format!("{}:{}", label.kind, label.name)).collect())).collect()
}

#[test]
fn an_identical_history_request_returns_the_previous_build() {
    let dir = repo();
    let root = dir.path();
    commit_file(root, "a.txt", "1\n", "one");
    commit_file(root, "a.txt", "2\n", "two");

    let first = graph::refresh_for_view(root, head_scope(true), false, 200, false, None).unwrap();
    let again = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&first)).unwrap();
    assert!(Arc::ptr_eq(&first, &again), "unchanged refs, scope, window and options need no new build");
    assert_eq!(first.key, again.key);

    // Every input of the rows gets a new build with a new key.
    let worktree = graph::refresh_for_view(root, head_scope(true), true, 200, false, Some(&first)).unwrap();
    assert_ne!(worktree.key, first.key);
    assert_eq!(worktree.rows[0].oid, graph::WORKTREE_OID);
    let window = graph::refresh_for_view(root, head_scope(true), false, 400, false, Some(&first)).unwrap();
    assert_ne!(window.key, first.key);
    let incoming = graph::refresh_for_view(root, head_scope(false), false, 200, false, Some(&first)).unwrap();
    assert_ne!(incoming.key, first.key);
    let all = graph::refresh_for_view(root, ViewScope { branch: None, show_incoming: true, context: None }, false, 200, false, Some(&first)).unwrap();
    assert_ne!(all.key, first.key);

    // Same commit, different checked-out branch: the labels changed.
    runner::run(root, ["switch", "-qc", "topic"]).unwrap();
    let switched = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&first)).unwrap();
    assert_ne!(switched.key, first.key);
    assert!(switched.rows[0].refs.iter().any(|label| label.kind == "head" && label.name == "topic"));
    let settled = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&switched)).unwrap();
    assert!(Arc::ptr_eq(&switched, &settled));

    // A new commit or a moved ref is never served from the previous build.
    let tip = commit_file(root, "a.txt", "3\n", "three");
    let advanced = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&settled)).unwrap();
    assert_ne!(advanced.key, settled.key);
    assert_eq!(advanced.rows[0].oid, tip);
    runner::run(root, ["tag", "v1"]).unwrap();
    let tagged = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&advanced)).unwrap();
    assert_ne!(tagged.key, advanced.key);
    assert!(tagged.rows[0].refs.iter().any(|label| label.kind == "tag" && label.name == "v1"));

    // The plain builder keeps its contract: always a new build.
    let rebuilt = graph::build_for_view(root, head_scope(true), false, 200, false, Some(&tagged)).unwrap();
    assert_ne!(rebuilt.key, tagged.key);
    assert_eq!(marks(&rebuilt), marks(&tagged));
}

#[test]
fn a_branch_switch_reuses_ref_data_only_while_refs_are_unchanged() {
    let dir = repo();
    let root = dir.path();
    let pushed = commit_file(root, "a.txt", "1\n", "pushed");
    runner::run(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]).unwrap();
    runner::run(root, ["update-ref", "refs/remotes/origin/main", &pushed]).unwrap();
    runner::run(root, ["branch", "side"]).unwrap();
    let local = commit_file(root, "a.txt", "2\n", "local");

    let all = graph::refresh_for_view(root, ViewScope { branch: None, show_incoming: true, context: None }, false, 200, false, None).unwrap();
    // Another scope with the same refs: same marks as a build that reuses nothing.
    let head = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&all)).unwrap();
    let fresh = graph::build_for_view(root, head_scope(true), false, 200, false, None).unwrap();
    assert_ne!(head.key, all.key);
    assert_eq!(marks(&head), marks(&fresh));
    assert_eq!(
        marks(&head).iter().map(|(oid, local_only, _)| (oid.as_str(), *local_only)).collect::<Vec<_>>(),
        [(local.as_str(), true), (pushed.as_str(), false)]
    );
    let side = graph::refresh_for_view(root, ViewScope { branch: Some("refs/heads/side"), show_incoming: true, context: None }, false, 200, false, Some(&head))
        .unwrap();
    assert_eq!(
        marks(&side),
        marks(
            &graph::build_for_view(root, ViewScope { branch: Some("refs/heads/side"), show_incoming: true, context: None }, false, 200, false, None).unwrap()
        )
    );

    // The remote branch advanced (a push or fetch): the old local-only set must not survive.
    runner::run(root, ["update-ref", "refs/remotes/origin/main", &local]).unwrap();
    let after_push = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&head)).unwrap();
    assert_ne!(after_push.key, head.key);
    assert!(after_push.rows.iter().all(|row| !row.local_only));
    assert_eq!(marks(&after_push), marks(&graph::build_for_view(root, head_scope(true), false, 200, false, None).unwrap()));

    // Removing the remote changes the meaning of "local only" without moving a branch.
    runner::run(root, ["update-ref", "-d", "refs/remotes/origin/main"]).unwrap();
    let no_tracking = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&after_push)).unwrap();
    assert!(no_tracking.rows.iter().all(|row| row.local_only));
    runner::run(root, ["remote", "remove", "origin"]).unwrap();
    let no_remote = graph::refresh_for_view(root, head_scope(true), false, 200, false, Some(&no_tracking)).unwrap();
    assert_eq!(marks(&no_remote), marks(&graph::build_for_view(root, head_scope(true), false, 200, false, None).unwrap()));
}

#[test]
fn one_ref_enumeration_gives_the_snapshot_labels_and_head() {
    let dir = repo();
    let root = dir.path();
    let unborn = refs::graph_refs(root).unwrap();
    assert!(unborn.snapshot.is_empty() && unborn.labels.is_empty() && unborn.head_oid.is_empty());

    let first = commit_file(root, "a.txt", "1\n", "one");
    let second = commit_file(root, "a.txt", "2\n", "two");
    runner::run(root, ["update-ref", "refs/remotes/origin/main", &second]).unwrap();
    runner::run(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]).unwrap();
    runner::run(root, ["tag", "-a", "annotated", "-m", "tag", &first]).unwrap();
    let view = refs::graph_refs(root).unwrap();
    assert_eq!(view.head_oid, second);
    let mut expected: Vec<(String, String)> = git(root, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"])
        .lines()
        .map(|line| line.split_once(' ').map(|(name, oid)| (name.to_string(), oid.to_string())).unwrap())
        .collect();
    expected.push(("HEAD".into(), second.clone()));
    expected.sort();
    assert_eq!(view.snapshot, expected, "the snapshot keeps symbolic refs and unpeeled tag objects");
    assert!(view.snapshot.iter().any(|(name, _)| name == "refs/remotes/origin/HEAD"));
    let at_tip: Vec<_> = view.labels[&second].iter().map(|label| (label.kind.as_str(), label.name.as_str(), label.synced_remote.as_deref())).collect();
    assert_eq!(at_tip, [("head", "main", Some("origin/main"))]);
    assert_eq!(view.labels[&first].iter().map(|label| (label.kind.as_str(), label.name.as_str())).collect::<Vec<_>>(), [("tag", "annotated")]);

    runner::run(root, ["switch", "-q", "--detach", &first]).unwrap();
    let detached = refs::graph_refs(root).unwrap();
    assert_eq!(detached.head_oid, first);
    assert_eq!(detached.labels[&first].first().map(|label| (label.kind.as_str(), label.name.as_str())), Some(("detached", "HEAD")));
    assert!(detached.labels[&second].iter().all(|label| label.kind != "head"));
    assert_eq!(refs::labels_by_oid(root).unwrap(), detached.labels);
}

#[test]
fn a_newer_history_request_supersedes_older_builds() {
    let order = BuildOrder::default();
    assert!(order.is_latest("repo", 7), "requests without tracking are never superseded");
    assert!(order.begin("repo", 10));
    assert!(order.begin("repo", 11));
    // The older build finishes last: it must not be stored.
    assert!(!order.is_latest("repo", 10));
    assert!(order.is_latest("repo", 11));
    // A delayed start of an obsolete request does no work at all.
    assert!(!order.begin("repo", 9));
    assert!(order.is_latest("repo", 11));
    // Repositories are independent; repeating the newest request is allowed.
    assert!(order.begin("other", 3) && order.is_latest("other", 3));
    assert!(order.begin("repo", 11) && order.is_latest("repo", 11));
    assert_eq!(BuildOrder::superseded().kind, "superseded");
}

#[test]
fn status_tokens_are_stable_and_reads_finish_beside_queued_writers() {
    let dir = repo();
    let root = dir.path().to_path_buf();
    commit_file(&root, "a.txt", "1\n", "one");
    fs::write(root.join("a.txt"), "changed\n").unwrap();
    fs::write(root.join("new.txt"), "new\n").unwrap();

    let first = status::status(&root).unwrap();
    let second = status::status(&root).unwrap();
    assert!(first.state_token.is_some());
    assert_eq!(first.state_token, second.state_token);
    assert_eq!(first.diff_context_token, second.diff_context_token);
    assert_eq!(first.files, second.files);
    // The guard still covers refs, the index and file contents.
    runner::run(&root, ["branch", "other"]).unwrap();
    let with_ref = status::status(&root).unwrap();
    assert_ne!(with_ref.state_token, first.state_token);
    runner::run(&root, ["add", "new.txt"]).unwrap();
    let staged = status::status(&root).unwrap();
    assert_ne!(staged.state_token, with_ref.state_token);
    fs::write(root.join("a.txt"), "changed again\n").unwrap();
    assert_ne!(status::status(&root).unwrap().state_token, staged.state_token);

    // A guarded mutation re-reads the status inside its write transaction.
    let token = status::status(&root).unwrap().state_token.unwrap();
    operations::run(&root, "test", Some(&token), |_, _| {}, || runner::run(&root, ["update-ref", "refs/heads/guarded", "HEAD"]).map(|_| ())).unwrap();
    let stale = operations::run(&root, "test", Some(&token), |_, _| {}, || Ok(())).unwrap_err();
    assert_eq!(stale.kind, "stale-operation");

    // Readers hold the repository gate while helper threads read. Writers queue behind
    // them; neither side may wait for the other forever.
    let (done, finished) = mpsc::channel();
    let mut workers = Vec::new();
    for reader in 0..3 {
        let (root, done) = (root.clone(), done.clone());
        workers.push(std::thread::spawn(move || {
            for _ in 0..6 {
                let summary = if reader == 0 { status::display_status(&root) } else { status::status(&root) }.unwrap();
                assert!(summary.state_token.is_some());
            }
            done.send(()).unwrap();
        }));
    }
    {
        let (root, done) = (root.clone(), done.clone());
        workers.push(std::thread::spawn(move || {
            for round in 0..6 {
                let name = format!("refs/heads/writer-{round}");
                operations::run(&root, "test", None, |_, _| {}, || runner::run(&root, ["update-ref", name.as_str(), "HEAD"]).map(|_| ())).unwrap();
            }
            done.send(()).unwrap();
        }));
    }
    for _ in 0..workers.len() {
        finished.recv_timeout(Duration::from_secs(120)).expect("status readers and queued writers must not deadlock");
    }
    for worker in workers {
        worker.join().unwrap();
    }
}

#[test]
fn repository_info_resolves_the_root_and_git_directory_together() {
    let dir = repo();
    let root = dir.path();
    commit_file(root, "a.txt", "1\n", "one");
    fs::create_dir_all(root.join("nested/deeper")).unwrap();
    let top = grepo::discover(root).unwrap();
    for path in [root.to_path_buf(), root.join("nested/deeper")] {
        let info = grepo::info(&path).unwrap();
        assert_eq!(Path::new(&info.root), top);
        assert_eq!(Path::new(&info.git_dir), grepo::git_dir(&top).unwrap());
        assert_eq!(info.head.branch.as_deref(), Some("main"));
        assert_eq!(info.state.kind, "none");
    }
    // A linked worktree has its own Git directory and the shared common directory.
    let linked = dir.path().join("linked");
    runner::run(root, ["worktree", "add", "-q", "-b", "wt", linked.to_str().unwrap()]).unwrap();
    let info = grepo::info(&linked).unwrap();
    assert_eq!(Path::new(&info.git_dir), grepo::git_dir(&linked).unwrap());
    assert_ne!(info.git_dir, grepo::info(root).unwrap().git_dir);
    assert_eq!(info.common_dir, grepo::info(root).unwrap().common_dir);
    assert_eq!(info.head.branch.as_deref(), Some("wt"));

    assert_eq!(grepo::info(&root.join("missing")).unwrap_err().kind, "repository-folder-unavailable");
}
