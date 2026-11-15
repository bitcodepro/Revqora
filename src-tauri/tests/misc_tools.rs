//! rerere, notes, archive export and branch from stash.
use std::fs;
use std::path::Path;

use revqora_lib::git::{misc_tools as misc, runner};

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "Tester"],
        &["config", "user.email", "tester@example.com"],
        &["config", "core.autocrlf", "false"],
    ] {
        runner::run(dir.path(), args).unwrap();
    }
    dir
}
fn commit(root: &Path, file: &str, text: &str) -> String {
    fs::write(root.join(file), text).unwrap();
    runner::run(root, ["add", "-A"]).unwrap();
    runner::run(root, ["commit", "-q", "-m", text]).unwrap();
    runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim().to_string()
}

#[test]
fn rerere_is_set_for_this_repository() {
    let dir = repo();
    assert!(!misc::rerere(dir.path()).enabled);
    let r = misc::set_rerere(dir.path(), true, true).unwrap();
    assert!(r.enabled && r.auto_update);
    assert_eq!(runner::run(dir.path(), ["config", "--local", "rerere.enabled"]).unwrap().trim(), "true");
    let r = misc::set_rerere(dir.path(), false, true).unwrap();
    assert!(!r.enabled && !r.auto_update, "auto-update without rerere is meaningless");
}

#[test]
fn notes_are_added_replaced_and_removed_without_changing_the_commit() {
    let dir = repo();
    let root = dir.path();
    let oid = commit(root, "a.txt", "one");
    assert_eq!(misc::note(root, &oid).unwrap(), None);
    misc::set_note(root, &oid, "Reviewed — ok ✓\nsecond line").unwrap();
    assert_eq!(misc::note(root, &oid).unwrap().as_deref(), Some("Reviewed — ok ✓\nsecond line"));
    misc::set_note(root, &oid, "replaced").unwrap();
    assert_eq!(misc::note(root, &oid).unwrap().as_deref(), Some("replaced"));
    misc::set_note(root, &oid, "  ").unwrap();
    assert_eq!(misc::note(root, &oid).unwrap(), None);
    assert_eq!(runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim(), oid);
    assert!(misc::note(root, "--all").is_err());
}

#[test]
fn archives_a_revision_as_zip_or_tar_gz() {
    let dir = repo();
    let root = dir.path();
    let first = commit(root, "a.txt", "one");
    commit(root, "b.txt", "two");
    let out = tempfile::tempdir().unwrap();
    let zip = out.path().join("first.zip");
    misc::archive(root, &first, "zip", &zip, Some("project-1.0")).unwrap();
    let bytes = fs::read(&zip).unwrap();
    assert_eq!(&bytes[..2], b"PK");
    let names = String::from_utf8_lossy(&bytes);
    assert!(names.contains("project-1.0/a.txt") && !names.contains("b.txt"), "only the first commit's files, under the prefix");
    let tgz = out.path().join("head.tar.gz");
    misc::archive(root, "HEAD", "tar.gz", &tgz, None).unwrap();
    assert_eq!(&fs::read(&tgz).unwrap()[..2], &[0x1f, 0x8b]);
    assert!(misc::archive(root, "--output=x", "zip", &zip, None).is_err());
    assert!(misc::archive(root, "HEAD", "exe", &zip, None).is_err());
    assert!(misc::archive(root, "HEAD", "zip", Path::new("relative.zip"), None).is_err());
    assert!(misc::archive(root, "HEAD", "zip", &zip, Some("../up")).is_err());
}

#[test]
fn branch_from_stash_checks_out_its_base_with_the_changes_and_staging() {
    let dir = repo();
    let root = dir.path();
    let base = commit(root, "a.txt", "base\n");
    fs::write(root.join("a.txt"), "staged\n").unwrap();
    runner::run(root, ["add", "a.txt"]).unwrap();
    fs::write(root.join("a.txt"), "worktree\n").unwrap();
    runner::run(root, ["stash", "push", "-q", "-m", "wip"]).unwrap();
    commit(root, "a.txt", "moved on\n");
    let stash = runner::run(root, ["rev-parse", "stash@{0}"]).unwrap().trim().to_string();

    assert!(misc::stash_branch(root, "rescue", 0, &"0".repeat(40)).is_err(), "a different stash at that index is refused");
    assert!(misc::stash_branch(root, "-x", 0, &stash).is_err());
    misc::stash_branch(root, "rescue", 0, &stash).unwrap();
    assert_eq!(runner::run(root, ["branch", "--show-current"]).unwrap().trim(), "rescue");
    assert_eq!(runner::run(root, ["rev-parse", "HEAD"]).unwrap().trim(), base);
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "worktree\n");
    assert_eq!(runner::run(root, ["show", ":a.txt"]).unwrap(), "staged\n");
    assert!(runner::run(root, ["stash", "list"]).unwrap().trim().is_empty(), "applied stash is dropped");
}

#[test]
fn signature_status_is_reported_per_commit() {
    let dir = repo();
    let root = dir.path();
    let a = commit(root, "a.txt", "one");
    let b = commit(root, "b.txt", "two");
    let status = revqora_lib::git::commit::signature_status(root, &[a.clone(), b.clone()]).unwrap();
    assert_eq!(status.get(&a).map(String::as_str), Some("N"));
    assert_eq!(status.get(&b).map(String::as_str), Some("N"));
    assert!(revqora_lib::git::commit::signature_status(root, &["--all".into()]).is_err());
    assert!(revqora_lib::git::commit::signature_status(root, &[]).unwrap().is_empty());
}

#[test]
fn branch_from_stash_never_overwrites_an_ignored_file() {
    let dir = repo();
    let root = dir.path();
    // The stash base tracks `cache`; later the branch deletes and ignores it, and a local
    // ignored `cache` appears. Checking out the base would overwrite it silently.
    fs::write(root.join("cache"), "tracked once\n").unwrap();
    commit(root, "a.txt", "base\n");
    fs::write(root.join("a.txt"), "stashed edit\n").unwrap();
    runner::run(root, ["stash", "push", "-q", "-m", "wip"]).unwrap();
    runner::run(root, ["rm", "-q", "cache"]).unwrap();
    fs::write(root.join(".gitignore"), "cache\n").unwrap();
    runner::run(root, ["add", ".gitignore"]).unwrap();
    runner::run(root, ["commit", "-q", "-m", "ignore cache"]).unwrap();
    fs::write(root.join("cache"), "precious local data\n").unwrap();
    let stash = runner::run(root, ["rev-parse", "stash@{0}"]).unwrap().trim().to_string();

    let err = misc::stash_branch(root, "rescue", 0, &stash).unwrap_err();
    assert_eq!(err.kind, "stash-branch-collision", "{}", err.message);
    assert!(err.message.contains("cache"));
    assert_eq!(fs::read_to_string(root.join("cache")).unwrap(), "precious local data\n");
    assert_eq!(runner::run(root, ["rev-parse", "stash@{0}"]).unwrap().trim(), stash, "the stash is kept");
    assert_eq!(runner::run(root, ["branch", "--show-current"]).unwrap().trim(), "main");
}
