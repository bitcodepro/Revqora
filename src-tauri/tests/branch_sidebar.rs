use revqora_lib::git::{refs, runner};
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
