use revqora_lib::git::{
    branch_cleanup::{self, Mode, Request, Selection},
    branch_deletion, branch_review, operations, recovery, runner, status,
};
use std::{fs, path::PathBuf};
struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Очистка 'branches'");
        fs::create_dir(&root).unwrap();
        let f = Self { temp, root };
        for args in [
            vec!["init", "-qb", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "test@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.autocrlf", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            f.git(&args);
        }
        fs::write(f.root.join("file.txt"), "base\n").unwrap();
        f.git(&["add", "."]);
        f.git(&["commit", "-qm", "Base"]);
        for name in ["one", "two", "three"] {
            f.git(&["branch", name]);
        }
        f
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(&self.root, args).unwrap().trim().into()
    }
    fn oid(&self, name: &str) -> String {
        self.git(&["rev-parse", name])
    }
    fn exists(&self, name: &str) -> bool {
        runner::exec(&self.root, ["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).unwrap().ok()
    }
    fn server(&self) -> PathBuf {
        let server = self.temp.path().join("server.git");
        self.git(&["clone", "--bare", ".", server.to_str().unwrap()]);
        runner::run(&server, ["config", "receive.denyDeleteCurrent", "ignore"]).unwrap();
        self.git(&["remote", "add", "origin", server.to_str().unwrap()]);
        self.git(&["fetch", "-q", "origin"]);
        server
    }
    fn selection(&self, name: &str, mode: Mode) -> Selection {
        let target = if mode != Mode::Local { Some(branch_deletion::targets(&self.root, name).unwrap().remove(0)) } else { None };
        let plan = branch_review::plan(&self.root, name, Some("refs/heads/main"), target, None, mode == Mode::Remote).unwrap();
        Selection { proof: plan.proof, mode, force: false }
    }
    fn next(&self) -> String {
        self.git(&["commit-tree", &self.oid("HEAD^{tree}"), "-p", "HEAD", "-m", "New tip"])
    }
    fn execute(&self, selections: &[Selection], rules: &[String]) -> branch_cleanup::Report {
        branch_cleanup::execute(&self.root, selections, rules, |_| {}).unwrap()
    }
}
#[test]
fn disabling_checkpoints_for_a_mixed_batch_keeps_whole_selection_protection() {
    let f = Fixture::new();
    let server = f.server();
    let selections = [f.selection("one", Mode::Local), f.selection("two", Mode::Both), f.selection("three", Mode::Remote)];
    let before = recovery::list(&f.root).unwrap().checkpoints.len();
    let refs = f.git(&["show-ref"]);
    let denied = branch_cleanup::execute_with_checkpoint(&f.root, &selections, &["two".into()], false, |_| {}).unwrap();
    assert!(denied.preflight_failed);
    assert_eq!(f.git(&["show-ref"]), refs);
    fs::write(f.root.join("file.txt"), "manual contents\n").unwrap();
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let report = branch_cleanup::execute_with_checkpoint(&f.root, &selections, &["main".into()], false, |_| {}).unwrap();
    assert!(!report.preflight_failed);
    assert!(report.items.iter().all(|r| r.status == "deleted" && r.checkpoints.is_empty()));
    assert!(!f.exists("one") && !f.exists("two") && f.exists("three"));
    for (name, kept) in [("one", true), ("two", false), ("three", false)] {
        assert_eq!(runner::exec(&server, ["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).unwrap().ok(), kept);
    }
    assert_eq!(recovery::list(&f.root).unwrap().checkpoints.len(), before);
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(f.root.join("file.txt")).unwrap(), b"manual contents\n");
}

#[test]
fn mixed_scopes_preserve_working_files_and_recover_each_exact_tip() {
    let f = Fixture::new();
    let server = f.server();
    let tip = f.oid("one");
    fs::write(f.root.join("file.txt"), "uncommitted\n").unwrap();
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let report = f.execute(&[f.selection("one", Mode::Local), f.selection("two", Mode::Both), f.selection("three", Mode::Remote)], &["main".into()]);
    assert!(!report.preflight_failed);
    assert!(report.items.iter().all(|o| o.status == "deleted"));
    assert!(!f.exists("one") && !f.exists("two") && f.exists("three"));
    for (name, kept) in [("one", true), ("two", false), ("three", false)] {
        assert_eq!(runner::exec(&server, ["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).unwrap().ok(), kept);
    }
    assert_eq!(fs::read(f.root.join("file.txt")).unwrap(), b"uncommitted\n");
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
    for (i, o) in report.items.iter().enumerate() {
        let cp = o.checkpoints.last().unwrap();
        let detail = recovery::detail(&f.root, &cp.id).unwrap();
        assert!(detail.refs.iter().all(|r| r.oid == tip));
        recovery::restore_branch(&f.root, &cp.id, Some(0), &format!("recovered-{i}")).unwrap();
        assert_eq!(f.oid(&format!("recovered-{i}")), tip);
    }
}
#[test]
fn preflight_checks_protected_actual_remote_alias_before_deleting_any_local_branch() {
    let f = Fixture::new();
    let server = f.server();
    f.git(&["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/innocent"]);
    f.git(&["fetch", "-q", "origin"]);
    f.git(&["config", "branch.two.remote", "origin"]);
    f.git(&["config", "branch.two.merge", "refs/heads/main"]);
    let mut dangerous = f.selection("two", Mode::Both);
    dangerous.force = true;
    let before = f.git(&["show-ref"]);
    let r = f.execute(&[f.selection("one", Mode::Local), dangerous], &["main".into()]);
    assert!(r.preflight_failed);
    assert_eq!(r.items[0].status, "skipped");
    assert!(r.items[1].message.as_ref().unwrap().contains("protected"));
    assert_eq!(f.git(&["show-ref"]), before);
    assert!(r.items.iter().all(|o| o.checkpoints.is_empty()));
    assert_eq!(runner::run(&server, ["rev-parse", "main"]).unwrap().trim(), f.oid("main"));
    assert_eq!(f.execute(&[f.selection("two", Mode::Local)], &["main".into()]).items[0].status, "deleted");
}
#[test]
fn changed_server_or_local_sha_blocks_whole_batch_even_with_force() {
    let f = Fixture::new();
    let server = f.server();
    let mut second = f.selection("two", Mode::Both);
    second.force = true;
    let before = status::status(&f.root).unwrap().state_token.unwrap();
    let previous = f.oid("two");
    let next = runner::run(
        &server,
        [
            "-c",
            "user.name=Peer",
            "-c",
            "user.email=peer@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            &f.oid("HEAD^{tree}"),
            "-p",
            &previous,
            "-m",
            "Unseen server tip",
        ],
    )
    .unwrap()
    .trim()
    .to_owned();
    runner::run(&server, ["update-ref", "refs/heads/two", &next, &previous]).unwrap();
    assert_eq!(status::status(&f.root).unwrap().state_token.as_deref(), Some(before.as_str()));
    let r = operations::run(
        &f.root,
        "branch_cleanup_execute",
        Some(&before),
        |_, _| {},
        || branch_cleanup::execute(&f.root, &[f.selection("one", Mode::Local), second], &[], |_| {}),
    )
    .unwrap();
    assert!(r.preflight_failed);
    assert!(r.items[1].message.as_ref().unwrap().contains("push server tip differs"));
    assert!(f.exists("one") && f.exists("two"));
    let second = f.selection("two", Mode::Local);
    let local_next = f.next();
    f.git(&["update-ref", "refs/heads/two", &local_next]);
    let r = f.execute(&[f.selection("one", Mode::Local), second], &[]);
    assert!(r.preflight_failed);
    assert!(f.exists("one"));
}
#[test]
fn fetched_tracking_update_rejects_outer_state_before_batch_preflight() {
    let f = Fixture::new();
    let server = f.server();
    let selections = [f.selection("one", Mode::Local), f.selection("two", Mode::Both)];
    let expected = status::status(&f.root).unwrap().state_token.unwrap();
    let one = f.oid("one");
    let two = f.oid("two");
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let next = runner::run(
        &server,
        [
            "-c",
            "user.name=Peer",
            "-c",
            "user.email=peer@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            &f.oid("HEAD^{tree}"),
            "-p",
            &two,
            "-m",
            "Peer tip before fetch",
        ],
    )
    .unwrap()
    .trim()
    .to_owned();
    runner::run(&server, ["update-ref", "refs/heads/two", &next, &two]).unwrap();
    assert_eq!(status::status(&f.root).unwrap().state_token.as_deref(), Some(expected.as_str()));
    assert_eq!(f.oid("refs/remotes/origin/two"), two);
    f.git(&["fetch", "-q", "origin"]);
    assert_eq!(f.oid("refs/remotes/origin/two"), next);
    assert_ne!(status::status(&f.root).unwrap().state_token.as_deref(), Some(expected.as_str()));
    let refs_after_fetch = f.git(&["show-ref"]);
    let result = operations::run(&f.root, "branch_cleanup_execute", Some(&expected), |_, _| {}, || branch_cleanup::execute(&f.root, &selections, &[], |_| {}));
    assert_eq!(result.err().unwrap().kind, "stale-operation");
    assert_eq!(f.git(&["show-ref"]), refs_after_fetch);
    assert_eq!(f.oid("one"), one);
    assert_eq!(f.oid("two"), two);
    assert_eq!(runner::run(&server, ["rev-parse", "one"]).unwrap().trim(), one);
    assert_eq!(runner::run(&server, ["rev-parse", "two"]).unwrap().trim(), next);
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
}

#[test]
fn duplicate_server_target_and_selected_base_are_rejected_without_side_effects() {
    let f = Fixture::new();
    f.server();
    f.git(&["config", "branch.two.remote", "origin"]);
    f.git(&["config", "branch.two.merge", "refs/heads/one"]);
    let before = f.git(&["show-ref"]);
    let r = f.execute(&[f.selection("one", Mode::Both), f.selection("two", Mode::Both)], &[]);
    assert!(r.preflight_failed);
    assert_eq!(f.git(&["show-ref"]), before);
    let mut one = f.selection("one", Mode::Local);
    one.proof.base_ref = Some("refs/heads/two".into());
    one.proof.base_oid = Some(f.oid("two"));
    let r = f.execute(&[one, f.selection("two", Mode::Local)], &[]);
    assert!(r.preflight_failed);
    assert_eq!(f.git(&["show-ref"]), before);
}
#[test]
fn external_change_mid_batch_stops_remaining_rows_and_keeps_exact_first_checkpoint() {
    let f = Fixture::new();
    let first = f.oid("one");
    let next = f.next();
    let r =
        branch_cleanup::execute(&f.root, &[f.selection("one", Mode::Local), f.selection("two", Mode::Local), f.selection("three", Mode::Local)], &[], |line| {
            if line == "Deleting two" {
                f.git(&["update-ref", "refs/heads/two", &next]);
            }
        })
        .unwrap();
    assert_eq!(r.items.iter().map(|o| o.status.as_str()).collect::<Vec<_>>(), ["deleted", "failed", "skipped"]);
    assert!(!f.exists("one") && f.exists("three"));
    assert_eq!(f.oid("two"), next);
    let cp = &r.items[0].checkpoints[0];
    assert_eq!(recovery::detail(&f.root, &cp.id).unwrap().refs[0].oid, first);
}

#[test]
fn overlapping_local_and_remote_only_rows_are_rejected_before_any_deletion() {
    let f = Fixture::new();
    f.server();
    let before = f.git(&["show-ref"]);
    let r = f.execute(&[f.selection("one", Mode::Local), f.selection("one", Mode::Remote)], &[]);
    assert!(r.preflight_failed);
    assert!(r.items[1].message.as_ref().unwrap().contains("combined"));
    assert_eq!(f.git(&["show-ref"]), before);
}
#[test]
fn remote_hook_rejection_reports_partial_local_deletion_and_stops_batch() {
    let f = Fixture::new();
    let server = f.server();
    let tip = f.oid("one");
    let hook = server.join("hooks/pre-receive");
    fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let r = f.execute(&[f.selection("one", Mode::Both), f.selection("two", Mode::Local)], &[]);
    assert!(!r.preflight_failed);
    assert_eq!(r.status, "stopped");
    assert_eq!(r.items[0].status, "partial");
    assert!(r.items[0].local_deleted && !r.items[0].remote_deleted);
    assert_eq!(r.items[1].status, "skipped");
    assert!(!f.exists("one") && f.exists("two"));
    assert_eq!(runner::run(&server, ["rev-parse", "one"]).unwrap().trim(), tip);
    assert_eq!(recovery::detail(&f.root, &r.items[0].checkpoints[0].id).unwrap().refs[0].oid, tip);
}
#[test]
fn review_rejects_symbolic_and_occupied_locals_and_stale_inventory() {
    let f = Fixture::new();
    f.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
    let wt = f.temp.path().join("linked");
    f.git(&["worktree", "add", wt.to_str().unwrap(), "two"]);
    let requests = [("alias", f.oid("alias")), ("two", f.oid("two")), ("one", f.next())]
        .into_iter()
        .map(|(name, oid)| Request { reference: format!("refs/heads/{name}"), oid, mode: Mode::Local })
        .collect();
    let before = f.git(&["show-ref"]);
    let r = branch_cleanup::review(&f.root, requests, "refs/heads/main", &[]).unwrap();
    assert!(r.items.iter().all(|r| r.error.is_some() && r.plan.is_none()));
    assert_eq!(f.git(&["show-ref"]), before);
}
#[test]
fn replace_refs_cannot_hide_unmerged_history_and_state_guard_preserves_manual_edits() {
    let f = Fixture::new();
    let real = f.git(&["commit-tree", &f.oid("HEAD^{tree}"), "-m", "Independent original history"]);
    f.git(&["update-ref", "refs/heads/one", &real]);
    f.git(&["replace", "--graft", "HEAD", &real]);
    let r = branch_cleanup::review(&f.root, vec![Request { reference: "refs/heads/one".into(), oid: real.clone(), mode: Mode::Local }], "refs/heads/main", &[])
        .unwrap();
    assert!(r.items[0].force_required);
    let s = Selection { proof: r.items[0].plan.as_ref().unwrap().proof.clone(), mode: Mode::Local, force: false };
    assert!(f.execute(&[s], &[]).preflight_failed);
    assert_eq!(f.oid("one"), real);
    fs::write(f.root.join("file.txt"), "external manual edit").unwrap();
    let result = operations::run(
        &f.root,
        "branch_cleanup_execute",
        Some(&r.state_token),
        |_, _| {},
        || branch_cleanup::execute(&f.root, &[f.selection("two", Mode::Local)], &[], |_| {}),
    );
    assert_eq!(result.err().unwrap().kind, "stale-operation");
    assert!(f.exists("two"));
    assert_eq!(fs::read_to_string(f.root.join("file.txt")).unwrap(), "external manual edit");
}

fn fast_review(f: &Fixture, names: &[&str]) -> branch_cleanup::Review {
    let requests = names.iter().map(|name| Request { reference: format!("refs/heads/{name}"), oid: f.oid(name), mode: Mode::Local }).collect();
    branch_cleanup::review_with_analysis(&f.root, requests, "refs/heads/main", &["main".into()], false).unwrap()
}
fn fast_selections(review: &branch_cleanup::Review) -> Vec<Selection> {
    review.items.iter().map(|item| Selection { proof: item.plan.as_ref().unwrap().proof.clone(), mode: item.request.mode, force: true }).collect()
}

#[test]
fn twenty_remote_deleted_local_branches_need_no_history_comparison_and_share_one_checkpoint() {
    let f = Fixture::new();
    f.git(&["remote", "add", "origin", f.temp.path().join("unavailable.git").to_str().unwrap()]);
    let names: Vec<_> = (0..20).map(|n| format!("obsolete-{n:02}")).collect();
    let mut tips = std::collections::BTreeMap::new();
    for name in &names {
        let tip = f.git(&["commit-tree", &f.oid("HEAD^{tree}"), "-p", "HEAD", "-m", name]);
        f.git(&["update-ref", &format!("refs/heads/{name}"), &tip]);
        f.git(&["config", &format!("branch.{name}.remote"), "origin"]);
        f.git(&["config", &format!("branch.{name}.merge"), &format!("refs/heads/{name}")]);
        tips.insert(format!("refs/heads/{name}"), tip);
    }
    fs::write(f.root.join("file.txt"), "manual changes stay\n").unwrap();
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let r = fast_review(&f, &names.iter().map(String::as_str).collect::<Vec<_>>());
    for item in &r.items {
        let plan = item.plan.as_ref().unwrap();
        assert!(!plan.analysis_performed);
        assert!(plan.proof.base_oid.is_none() && plan.proof.base_ref.is_none());
        assert_eq!(plan.local_integration, "not-analyzed");
        assert!(plan.local_only.is_none() && plan.remote_only.is_none());
    }
    let before = recovery::list(&f.root).unwrap().checkpoints.len();
    let report = f.execute(&fast_selections(&r), &["main".into()]);
    assert!(!report.preflight_failed);
    assert!(report.items.iter().all(|item| item.status == "deleted" && item.checkpoints.len() == 1));
    let id = &report.items[0].checkpoints[0].id;
    assert!(report.items.iter().all(|item| item.checkpoints[0].id == *id));
    assert_eq!(recovery::list(&f.root).unwrap().checkpoints.len(), before + 1);
    let saved = recovery::detail(&f.root, id).unwrap();
    let deleted = revqora_lib::git::more::deleted_branches(&f.root).unwrap();
    for name in &names {
        assert!(deleted.iter().any(|entry| entry.name == *name && entry.oid == tips[&format!("refs/heads/{name}")] && entry.subject == *name));
    }
    assert_eq!(
        saved.refs.iter().filter(|r| tips.contains_key(&r.name)).map(|r| (r.name.clone(), r.oid.clone())).collect::<std::collections::BTreeMap<_, _>>(),
        tips
    );
    for (i, reference) in saved.refs.iter().enumerate().filter(|(_, r)| tips.contains_key(&r.name)) {
        assert!(!f.exists(reference.name.strip_prefix("refs/heads/").unwrap()));
        let restored = format!("restored-{i}");
        recovery::restore_branch(&f.root, id, Some(i), &restored).unwrap();
        assert_eq!(f.oid(&restored), reference.oid);
    }
    for name in ["main", "one", "two", "three"] {
        assert!(f.exists(name));
    }
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(f.root.join("file.txt")).unwrap(), b"manual changes stay\n");
}

#[test]
fn fast_review_does_not_traverse_history_but_explicit_analysis_does() {
    let f = Fixture::new();
    // A real tip with an unavailable parent: reading the ref is possible, walking
    // its history is not. This proves skipping analysis, without timing guesses.
    let raw = format!(
        "tree {}\nparent {}\nauthor Tester <test@example.invalid> 1 +0000\ncommitter Tester <test@example.invalid> 1 +0000\n\nMissing ancestor\n",
        f.oid("HEAD^{tree}"),
        "f".repeat(40)
    );
    let out = runner::exec_full(&f.root, ["hash-object", "-t", "commit", "-w", "--stdin"], &[], Some(raw.as_bytes())).unwrap();
    assert!(out.ok());
    let tip = out.text().trim().to_owned();
    f.git(&["update-ref", "refs/heads/incomplete", &tip]);
    let r = fast_review(&f, &["incomplete"]);
    assert!(!r.items[0].plan.as_ref().unwrap().analysis_performed);
    let analyzed = branch_cleanup::review_with_analysis(
        &f.root,
        vec![Request { reference: "refs/heads/incomplete".into(), oid: tip, mode: Mode::Local }],
        "refs/heads/main",
        &[],
        true,
    )
    .unwrap();
    assert!(analyzed.items[0].error.is_some() && analyzed.items[0].plan.is_none());
    let report = branch_cleanup::execute_with_checkpoint(&f.root, &fast_selections(&r), &[], false, |_| {}).unwrap();
    assert_eq!(report.items[0].status, "deleted");
    assert!(report.items[0].checkpoints.is_empty());
}

#[test]
fn unchecked_history_still_rejects_stale_protected_symbolic_and_occupied_branches() {
    let f = Fixture::new();
    let r = fast_review(&f, &["one", "two"]);
    let selections = fast_selections(&r);
    let refs = f.git(&["show-ref"]);
    assert!(f.execute(&selections, &["two".into()]).preflight_failed);
    assert_eq!(f.git(&["show-ref"]), refs);
    f.git(&["update-ref", "refs/heads/two", &f.next()]);
    assert!(f.execute(&selections, &[]).preflight_failed);
    assert!(f.exists("one"));
    f.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
    let wt = f.temp.path().join("occupied");
    f.git(&["worktree", "add", wt.to_str().unwrap(), "two"]);
    let occupied = fast_review(&f, &["alias", "two", "main"]);
    assert!(occupied.items.iter().all(|r| r.error.is_some() && r.plan.is_none()));
    assert!(recovery::list(&f.root).unwrap().checkpoints.is_empty());
}

#[test]
fn fast_local_transaction_failure_does_not_partially_delete_the_selection() {
    let f = Fixture::new();
    let selections = fast_selections(&fast_review(&f, &["one", "two", "three"]));
    let refs = f.git(&["show-ref"]);
    fs::write(f.root.join(".git/refs/heads/two.lock"), b"another Git writer").unwrap();
    let report = branch_cleanup::execute_with_checkpoint(&f.root, &selections, &[], false, |_| {}).unwrap();
    assert_eq!(report.status, "stopped");
    assert!(report.items.iter().all(|r| r.status == "failed" && !r.local_deleted && r.checkpoints.is_empty()));
    assert_eq!(f.git(&["show-ref"]), refs);
}

#[test]
fn fast_local_batch_rechecks_new_worktree_usage_after_saving_recovery() {
    let f = Fixture::new();
    let selections = fast_selections(&fast_review(&f, &["one", "two"]));
    let refs = f.git(&["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
    let wt = f.temp.path().join("occupied-during-confirmation");
    let result = branch_cleanup::execute_with_checkpoint(&f.root, &selections, &[], true, |line| {
        if line == "Deleting reviewed local branch references" {
            f.git(&["worktree", "add", wt.to_str().unwrap(), "two"]);
        }
    });
    assert_eq!(result.err().unwrap().kind, "branch-in-use");
    assert_eq!(f.git(&["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]), refs);
    assert!(wt.join("file.txt").is_file());
    assert_eq!(recovery::list(&f.root).unwrap().checkpoints.len(), 1);
}
