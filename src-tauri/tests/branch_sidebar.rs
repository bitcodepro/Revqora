use revqora_lib::git::{refs, runner};

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
        vec!["branch", "topic", "feature/topic"],
        vec!["checkout", "-qb", "source"],
        vec!["commit", "--allow-empty", "-qm", "Surviving entry"],
        vec!["reflog", "delete", "source@{1}"],
        vec!["config", "user.email", "copier@example.invalid"],
        vec!["branch", "-c", "source", "copied"],
        vec!["-c", "tag.gpgSign=false", "tag", "base-tag", "HEAD"],
        vec!["branch", "from-tag", "base-tag"],
    ] {
        git(&args);
    }
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
