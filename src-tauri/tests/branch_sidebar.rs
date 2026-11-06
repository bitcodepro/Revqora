use revqora_lib::git::{refs, runner};
#[test]
fn sidebar_identity_comes_from_git_configuration_and_retains_each_tip_author_email() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Other | author"],
        vec!["config", "user.email", "other@example.invalid"],
        vec!["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Other authored commit"],
        vec!["config", "user.name", "Me"],
        vec!["config", "user.email", "me@example.invalid"],
    ] {
        runner::run(r, args).unwrap();
    }
    let before = runner::run(r, ["rev-parse", "HEAD"]).unwrap();
    let index = std::fs::read(r.join(".git/index")).ok();
    let snapshot = refs::snapshot(r).unwrap();
    assert_eq!(snapshot.identity_email.as_deref(), Some("me@example.invalid"));
    assert_eq!(snapshot.local[0].author_email, "other@example.invalid");
    assert_eq!(snapshot.local[0].author, "Other | author");
    assert_eq!(runner::run(r, ["rev-parse", "HEAD"]).unwrap(), before);
    assert_eq!(std::fs::read(r.join(".git/index")).ok(), index);
}
