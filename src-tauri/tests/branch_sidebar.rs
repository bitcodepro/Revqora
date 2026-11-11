use revqora_lib::git::{refs, runner};

#[test]
fn current_branch_history_follows_head_without_reusing_commits_from_other_refs() {
    use revqora_lib::git::graph;
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    let git = |args: &[&str]| runner::run(r, args.iter().copied()).unwrap();
    git(&["init", "-qb", "main"]);
    assert!(graph::build(r, Some("HEAD"), false, 100, false).unwrap().rows.is_empty());
    git(&["config", "user.name", "Tester"]);
    git(&["config", "user.email", "test@example.invalid"]);
    git(&["config", "commit.gpgsign", "false"]);
    git(&["commit", "--allow-empty", "-qm", "Base"]);
    git(&["branch", "topic"]);
    git(&["commit", "--allow-empty", "-qm", "Main tip"]);
    let before = graph::build(r, Some("HEAD"), false, 100, false).unwrap();
    git(&["switch", "topic"]);
    git(&["commit", "--allow-empty", "-qm", "Topic tip"]);
    git(&["switch", "main"]);
    let unchanged = graph::build_with(r, Some("HEAD"), false, 100, false, Some(&before)).unwrap();
    assert_eq!(unchanged.rows.iter().map(|row| row.subject.as_str()).collect::<Vec<_>>(), ["Main tip", "Base"]);
    git(&["switch", "topic"]);
    let switched = graph::build_with(r, Some("HEAD"), false, 100, false, Some(&unchanged)).unwrap();
    assert_eq!(switched.rows.iter().map(|row| row.subject.as_str()).collect::<Vec<_>>(), ["Topic tip", "Base"]);
    let all = graph::build(r, None, false, 100, false).unwrap();
    assert_eq!(all.rows.len(), 3);
}

#[test]
fn incoming_preview_follows_only_the_upstream_and_refreshes_after_integration() {
    use revqora_lib::git::graph;
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    let git = |args: &[&str]| runner::run(r, args.iter().copied()).unwrap().trim().to_owned();
    git(&["init", "-qb", "main"]);
    git(&["config", "user.name", "Tester"]);
    git(&["config", "user.email", "test@example.invalid"]);
    git(&["config", "commit.gpgsign", "false"]);
    git(&["commit", "--allow-empty", "-qm", "Base"]);
    let base = git(&["rev-parse", "HEAD"]);
    let tree = git(&["rev-parse", "HEAD^{tree}"]);
    git(&["remote", "add", "origin", "https://example.invalid/unused"]);
    git(&["update-ref", "refs/remotes/origin/main", &base]);
    git(&["branch", "--set-upstream-to=origin/main"]);
    git(&["commit", "--allow-empty", "-qm", "Local"]);
    let local = git(&["rev-parse", "HEAD"]);
    let before = graph::build_with_incoming(r, Some("HEAD"), false, 100, false, None, true).unwrap();
    assert!(before.rows.iter().all(|row| !row.incoming));

    let fetched = git(&["commit-tree", &tree, "-p", &base, "-m", "Fetched"]);
    let unrelated = git(&["commit-tree", &tree, "-p", &base, "-m", "Unrelated"]);
    git(&["update-ref", "refs/remotes/origin/main", &fetched]);
    git(&["update-ref", "refs/remotes/origin/unrelated", &unrelated]);
    let preview = graph::build_with_incoming(r, Some("HEAD"), false, 100, false, Some(&before), true).unwrap();
    assert_eq!(preview.rows.iter().map(|row| (row.subject.as_str(), row.incoming)).collect::<Vec<_>>(), [("Fetched", true), ("Local", false), ("Base", false)]);
    assert_eq!(git(&["rev-parse", "HEAD"]), local);
    let explicit = graph::build_with_incoming(r, Some("refs/heads/main"), false, 2, false, None, true).unwrap();
    assert_eq!(explicit.rows.iter().map(|row| row.oid.as_str()).collect::<Vec<_>>(), [fetched.as_str(), local.as_str()]);
    let hidden = graph::build_with_incoming(r, Some("HEAD"), false, 100, false, Some(&preview), false).unwrap();
    assert!(!hidden.index.contains_key(&fetched));

    git(&["merge", "--no-edit", "origin/main"]);
    let integrated = graph::build_with_incoming(r, Some("HEAD"), false, 100, false, Some(&preview), true).unwrap();
    assert!(!integrated.rows[integrated.index[&fetched]].incoming);
    assert!(!integrated.index.contains_key(&unrelated));
}

#[test]
fn graph_records_its_actual_detached_head_even_outside_the_filter() {
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    let git = |args: &[&str]| runner::run(r, args.iter().copied()).unwrap().trim().to_owned();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Tester"],
        vec!["config", "user.email", "test@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["commit", "--allow-empty", "-qm", "A"],
        vec!["branch", "kept-at-a"],
    ] {
        git(&args);
    }
    let a = git(&["rev-parse", "HEAD"]);
    git(&["commit", "--allow-empty", "-qm", "B"]);
    let b = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--detach", &a]);
    let first = revqora_lib::git::graph::build(r, None, false, 100, false).unwrap();
    assert_eq!(first.head_oid, a);
    git(&["checkout", "--detach", &b]);
    let second = revqora_lib::git::graph::build(r, Some("refs/heads/kept-at-a"), false, 100, false).unwrap();
    assert_eq!(second.head_oid, b);
    assert!(second.rows.iter().all(|row| !row.is_head));
}

#[test]
fn graph_row_pages_reject_previous_builds_even_when_commit_positions_are_identical() {
    use revqora_lib::git::graph;
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Tester"],
        vec!["config", "user.email", "test@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["commit", "--allow-empty", "-qm", "A"],
    ] {
        runner::run(r, args).unwrap();
    }
    let first = graph::build(r, None, false, 100, false).unwrap();
    runner::run(r, ["-c", "tag.gpgSign=false", "tag", "new-label", "HEAD"]).unwrap();
    let second = graph::build(r, None, false, 100, false).unwrap();
    assert_eq!(first.rows.len(), second.rows.len());
    assert_eq!(first.head_oid, second.head_oid);
    assert_eq!(first.rows[0].oid, second.rows[0].oid);
    assert_ne!(first.key, second.key);
    assert!(second.page(0, 100, Some(&first.key)).unwrap_err().message.contains("History changed"));
    let rows = second.page(0, usize::MAX, Some(&second.key)).unwrap();
    assert!(rows[0].refs.iter().any(|label| label.name == "new-label"));
    assert!(second.page(usize::MAX, 100, Some(&second.key)).unwrap().is_empty());
}
#[test]
fn sidebar_creator_is_independent_of_tip_authors_and_uses_the_effective_git_identity() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Other | author"],
        vec!["config", "user.email", "other@example.invalid"],
        vec!["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Other authored commit"],
        vec!["config", "user.name", "Me"],
        vec!["config", "user.email", "me@example.invalid"],
        vec!["checkout", "-qb", "mine"],
        vec![
            "-c",
            "user.name=Other",
            "-c",
            "user.email=other@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-qm",
            "Others work on mine",
        ],
        vec!["checkout", "main"],
        vec!["-c", "user.name=Other", "-c", "user.email=other@example.invalid", "checkout", "-qb", "foreign"],
        vec!["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "My work on someone elses branch"],
    ] {
        runner::run(r, args).unwrap();
    }
    let before = runner::run(r, ["rev-parse", "HEAD"]).unwrap();
    let index = std::fs::read(r.join(".git/index")).ok();
    let snapshot = refs::snapshot(r).unwrap();
    assert_eq!(snapshot.identity_email.as_deref(), Some("me@example.invalid"));
    let mine = snapshot.local.iter().find(|b| b.name == "mine").unwrap();
    assert_eq!(mine.author_email, "other@example.invalid");
    assert_eq!(mine.creator.as_ref().unwrap().email, "me@example.invalid");
    let foreign = snapshot.local.iter().find(|b| b.name == "foreign").unwrap();
    assert_eq!(foreign.author_email, "me@example.invalid");
    assert_eq!(foreign.creator.as_ref().unwrap().email, "other@example.invalid");
    let manager = revqora_lib::git::branch_manager::snapshot(r, None).unwrap();
    assert_eq!(manager.branches.iter().find(|b| b.name == "mine").unwrap().creator, mine.creator);
    assert_eq!(runner::run(r, ["rev-parse", "HEAD"]).unwrap(), before);
    assert_eq!(std::fs::read(r.join(".git/index")).ok(), index);
}

#[test]
fn slash_named_local_sources_and_copies_after_expiry_have_the_correct_creator() {
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    let git = |args: &[&str]| runner::run(r, args.iter().copied()).unwrap();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Creator"],
        vec!["config", "user.email", "creator@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["commit", "--allow-empty", "-qm", "Base"],
        vec!["branch", "feature/topic"],
    ] {
        git(&args);
    }
    revqora_lib::git::ops::create_branch(r, "topic", Some("feature/topic"), false).unwrap();
    for args in [
        vec!["checkout", "-qb", "source"],
        vec!["commit", "--allow-empty", "-qm", "Surviving entry"],
        vec!["reflog", "delete", "source@{1}"],
        vec!["config", "user.email", "copier@example.invalid"],
        vec!["branch", "-c", "source", "copied"],
        vec!["-c", "tag.gpgSign=false", "tag", "base-tag", "HEAD"],
    ] {
        git(&args);
    }
    revqora_lib::git::ops::create_branch(r, "from-tag", Some("base-tag"), false).unwrap();
    assert!(std::fs::read_to_string(r.join(".git/logs/refs/heads/topic")).unwrap().contains("Created from refs/heads/feature/topic"));
    assert!(std::fs::read_to_string(r.join(".git/logs/refs/heads/from-tag")).unwrap().contains("Created from refs/tags/base-tag"));
    let before = git(&["rev-parse", "HEAD"]);
    let index = std::fs::read(r.join(".git/index")).ok();
    let snapshot = refs::snapshot(r).unwrap();
    assert_eq!(snapshot.local.iter().find(|b| b.name == "topic").unwrap().creator.as_ref().unwrap().email, "creator@example.invalid");
    assert!(snapshot.local.iter().find(|b| b.name == "source").unwrap().creator.is_none());
    assert_eq!(snapshot.local.iter().find(|b| b.name == "copied").unwrap().creator.as_ref().unwrap().email, "copier@example.invalid");
    assert_eq!(snapshot.local.iter().find(|b| b.name == "from-tag").unwrap().creator.as_ref().unwrap().email, "copier@example.invalid");
    let manager = revqora_lib::git::branch_manager::snapshot(r, None).unwrap();
    assert_eq!(manager.branches.iter().find(|b| b.name == "topic").unwrap().creator.as_ref().unwrap().email, "creator@example.invalid");
    assert_eq!(manager.branches.iter().find(|b| b.name == "copied").unwrap().creator.as_ref().unwrap().email, "copier@example.invalid");
    assert_eq!(manager.branches.iter().find(|b| b.name == "from-tag").unwrap().creator.as_ref().unwrap().email, "copier@example.invalid");
    assert_eq!(git(&["rev-parse", "HEAD"]), before);
    assert_eq!(std::fs::read(r.join(".git/index")).ok(), index);
}

#[test]
fn historical_creation_does_not_change_when_source_refs_are_renamed_deleted_or_shadowed() {
    use revqora_lib::git::ops;
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    let git = |args: &[&str]| runner::run(r, args.iter().copied()).unwrap();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Creator"],
        vec!["config", "user.email", "creator@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["commit", "--allow-empty", "-qm", "Base"],
        vec!["remote", "add", "origin", "https://example.invalid/never-contacted.git"],
        vec!["update-ref", "refs/remotes/origin/topic", "HEAD"],
        vec!["branch", "topic", "origin/topic"],
        vec!["branch", "feature/local", "HEAD"],
        vec!["-c", "tag.gpgSign=false", "tag", "starting-tag", "HEAD"],
    ] {
        git(&args);
    }
    ops::create_branch(r, "local-child", Some("feature/local"), false).unwrap();
    ops::create_branch(r, "tag-child", Some("starting-tag"), false).unwrap();
    ops::create_branch(r, "remote-child", Some("origin/topic"), false).unwrap();
    git(&["branch", "cli-child", "feature/local"]);
    git(&["branch", "cli-from-main", "main"]);
    git(&["update-ref", "refs/remotes/origin/cli-from-main", "HEAD"]);
    git(&["branch", "--set-upstream-to=origin/cli-from-main", "cli-from-main"]);
    let head = git(&["rev-parse", "HEAD"]);
    let index = std::fs::read(r.join(".git/index")).ok();
    let verify = || {
        let sidebar = refs::snapshot(r).unwrap();
        let manager = revqora_lib::git::branch_manager::snapshot(r, None).unwrap();
        assert!(sidebar.local.iter().find(|b| b.name == "topic").unwrap().creator.is_none());
        assert!(manager.branches.iter().find(|b| b.local && b.name == "topic").unwrap().creator.is_none());
        for name in ["local-child", "tag-child", "remote-child", "cli-child", "cli-from-main"] {
            assert_eq!(sidebar.local.iter().find(|b| b.name == name).unwrap().creator.as_ref().unwrap().email, "creator@example.invalid", "{name}");
            assert_eq!(
                manager.branches.iter().find(|b| b.local && b.name == name).unwrap().creator.as_ref().unwrap().email,
                "creator@example.invalid",
                "{name}"
            );
        }
        assert_eq!(git(&["rev-parse", "HEAD"]), head);
        assert_eq!(std::fs::read(r.join(".git/index")).ok(), index);
    };
    verify();
    for args in [
        vec!["-c", "tag.gpgSign=false", "tag", "origin/topic", "HEAD"],
        vec!["branch", "origin/topic", "HEAD"],
        vec!["branch", "-m", "feature/local", "renamed/source"],
        vec!["branch", "-D", "renamed/source"],
        vec!["tag", "-d", "starting-tag"],
        vec!["branch", "starting-tag", "HEAD"],
        vec!["branch", "-D", "origin/topic"],
        vec!["tag", "-d", "origin/topic"],
        vec!["update-ref", "-d", "refs/remotes/origin/topic"],
    ] {
        git(&args);
        verify();
    }
}

#[test]
fn revision_expressions_and_new_worktrees_record_local_creation_without_changing_tracking_semantics() {
    use revqora_lib::git::{extras, ops};
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    let git = |args: &[&str]| runner::run(r, args.iter().copied()).unwrap().trim().to_owned();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Creator"],
        vec!["config", "user.email", "creator@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["commit", "--allow-empty", "-qm", "A"],
        vec!["commit", "--allow-empty", "-qm", "B"],
        vec!["-c", "tag.gpgSign=false", "tag", "base-tag", "HEAD"],
        vec!["remote", "add", "origin", "https://example.invalid/never-contacted.git"],
        vec!["update-ref", "refs/remotes/origin/topic", "HEAD"],
    ] {
        git(&args);
    }
    let a = git(&["rev-parse", "HEAD~1"]);
    for (name, start) in [
        ("ancestor-head", "HEAD~1"),
        ("ancestor-main", "main^"),
        ("peeled-tag", "base-tag^{commit}"),
        ("reflog-entry", "HEAD@{1}"),
        ("remote-parent", "refs/remotes/origin/topic~1"),
    ] {
        git(&["branch", name, start]);
    }
    git(&["branch", "topic", "origin/topic"]);
    git(&["config", "core.logAllRefUpdates", "false"]);
    ops::create_branch(r, "app-ancestor", Some("HEAD~1"), false).unwrap();
    assert_eq!(git(&["rev-parse", "app-ancestor"]), a);
    git(&["config", "branch.autoSetupMerge", "always"]);
    ops::create_branch(r, "tracked-local", Some("main"), false).unwrap();
    ops::create_branch(r, "tracked-remote", Some("origin/topic"), false).unwrap();
    ops::create_branch(r, "checkout-remote", Some("origin/topic"), true).unwrap();
    ops::create_branch(r, "checkout-qualified-remote", Some("refs/remotes/origin/topic"), true).unwrap();
    git(&["config", "branch.autoSetupMerge", "inherit"]);
    git(&["branch", "--set-upstream-to=origin/topic", "main"]);
    ops::create_branch(r, "inherited-local", Some("main"), false).unwrap();
    let wt = r.join("linked");
    extras::worktree_add(r, wt.to_str().unwrap(), None, Some("worktree-created"), Some("main")).unwrap();
    let snapshot = refs::snapshot(r).unwrap();
    let manager = revqora_lib::git::branch_manager::snapshot(r, None).unwrap();
    for name in [
        "ancestor-head",
        "ancestor-main",
        "peeled-tag",
        "reflog-entry",
        "remote-parent",
        "app-ancestor",
        "tracked-local",
        "tracked-remote",
        "checkout-remote",
        "checkout-qualified-remote",
        "inherited-local",
        "worktree-created",
    ] {
        assert_eq!(snapshot.local.iter().find(|b| b.name == name).unwrap().creator.as_ref().unwrap().email, "creator@example.invalid", "{name}");
        assert_eq!(manager.branches.iter().find(|b| b.local && b.name == name).unwrap().creator.as_ref().unwrap().email, "creator@example.invalid", "{name}");
    }
    assert!(snapshot.local.iter().find(|b| b.name == "topic").unwrap().creator.is_none());
    assert_eq!(git(&["config", "branch.tracked-local.merge"]), "refs/heads/main");
    assert_eq!(git(&["config", "branch.tracked-remote.merge"]), "refs/heads/topic");
    assert_eq!(git(&["config", "branch.inherited-local.remote"]), "origin");
    assert_eq!(git(&["config", "branch.inherited-local.merge"]), "refs/heads/topic");
    assert!(snapshot.local.iter().find(|b| b.name == "checkout-remote").unwrap().upstream.is_none());
    assert!(snapshot.local.iter().find(|b| b.name == "checkout-qualified-remote").unwrap().upstream.is_none());
    assert_eq!(git(&["branch", "--show-current"]), "checkout-qualified-remote");
    assert!(refs::snapshot(&wt).unwrap().local.iter().find(|b| b.name == "worktree-created").unwrap().creator.is_some());
    assert_eq!(git(&["config", "core.logAllRefUpdates"]), "false");
}

#[test]
fn branch_and_switch_preserve_unique_merge_base_shorthands_without_mutating_on_ambiguity() {
    use revqora_lib::git::ops;
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    let git = |args: &[&str]| runner::run(r, args.iter().copied()).unwrap().trim().to_owned();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Creator"],
        vec!["config", "user.email", "creator@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["commit", "--allow-empty", "-qm", "Base"],
    ] {
        git(&args);
    }
    let base = git(&["rev-parse", "HEAD"]);
    let tree = git(&["rev-parse", "HEAD^{tree}"]);
    let a = git(&["commit-tree", &tree, "-p", &base, "-m", "A"]);
    let b = git(&["commit-tree", &tree, "-p", &base, "-m", "B"]);
    git(&["update-ref", "refs/heads/main", &a]);
    git(&["update-ref", "refs/heads/other", &b]);
    let index = std::fs::read(r.join(".git/index")).ok();
    for (i, start) in ["main...other", "...other", "main...", "..."].into_iter().enumerate() {
        let expected = if start.ends_with("...") { &a } else { &base };
        // Compare the app's result with Git's actual branch/switch behavior.
        for checkout in [false, true] {
            let control = format!("control-{i}-{checkout}");
            git(&[if checkout { "switch" } else { "branch" }, if checkout { "-c" } else { "--no-track" }, &control, start]);
            assert_eq!(git(&["rev-parse", &control]), *expected);
            git(&["switch", "main"]);
            let name = format!("app-{i}-{checkout}");
            ops::create_branch(r, &name, Some(start), checkout).unwrap();
            assert_eq!(git(&["rev-parse", &name]), *expected);
            assert_eq!(git(&["branch", "--show-current"]), if checkout { name.clone() } else { "main".into() });
            let snapshot = refs::snapshot(r).unwrap();
            assert_eq!(snapshot.local.iter().find(|b| b.name == name).unwrap().creator.as_ref().unwrap().email, "creator@example.invalid");
            git(&["switch", "main"]);
            assert_eq!(std::fs::read(r.join(".git/index")).ok(), index);
        }
    }
    // Criss-cross history has two equally valid bases: neither may be chosen.
    let x = git(&["commit-tree", &tree, "-p", &a, "-p", &b, "-m", "X"]);
    let y = git(&["commit-tree", &tree, "-p", &b, "-p", &a, "-m", "Y"]);
    let unrelated = git(&["commit-tree", &tree, "-m", "Unrelated"]);
    for checkout in [false, true] {
        for start in [format!("{x}...{y}"), format!("{a}...{unrelated}"), "main...missing".into()] {
            assert!(ops::create_branch(r, "must-not-exist", Some(&start), checkout).is_err(), "{start}");
            assert!(!runner::exec(r, ["show-ref", "--verify", "refs/heads/must-not-exist"]).unwrap().ok());
            assert_eq!(git(&["branch", "--show-current"]), "main");
            assert_eq!(git(&["rev-parse", "HEAD"]), a);
            assert_eq!(std::fs::read(r.join(".git/index")).ok(), index);
        }
    }
}

#[test]
fn upstream_and_push_selectors_never_claim_imported_remote_branches_in_any_case() {
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    let git = |args: &[&str]| runner::run(r, args.iter().copied()).unwrap();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Importer"],
        vec!["config", "user.email", "importer@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["commit", "--allow-empty", "-qm", "Base"],
        vec!["remote", "add", "origin", "https://example.invalid/never-contacted.git"],
        vec!["update-ref", "refs/remotes/origin/topic", "HEAD"],
        vec!["branch", "--set-upstream-to=origin/topic", "main"],
        vec!["config", "push.default", "upstream"],
    ] {
        git(&args);
    }
    for (i, selector) in
        ["@{u}", "@{U}", "main@{upstream}", "main@{UPSTREAM}", "main@{UpStReAm}", "main@{push}", "main@{PUSH}", "main@{PuSh}"].into_iter().enumerate()
    {
        let name = format!("imported-{i}");
        git(&["branch", &name, selector]);
        let sidebar = refs::snapshot(r).unwrap();
        let manager = revqora_lib::git::branch_manager::snapshot(r, None).unwrap();
        assert!(sidebar.local.iter().find(|b| b.name == name).unwrap().creator.is_none(), "{selector}");
        assert!(manager.branches.iter().find(|b| b.local && b.name == name).unwrap().creator.is_none(), "{selector}");
    }
}
