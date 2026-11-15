//! Commits behind a submodule pointer change.
use std::fs;
use std::path::Path;

use revqora_lib::git::{runner, submodule_log};

fn init(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "Tester"],
        &["config", "user.email", "tester@example.com"],
        &["config", "core.autocrlf", "false"],
    ] {
        runner::run(dir, args).unwrap();
    }
}
fn commit(dir: &Path, file: &str, msg: &str) -> String {
    fs::write(dir.join(file), msg).unwrap();
    runner::run(dir, ["add", "-A"]).unwrap();
    runner::run(dir, ["commit", "-q", "-m", msg]).unwrap();
    runner::run(dir, ["rev-parse", "HEAD"]).unwrap().trim().to_string()
}

#[test]
fn lists_commits_added_and_removed_by_a_pointer_change() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("lib");
    let app = tmp.path().join("app");
    init(&lib);
    let first = commit(&lib, "a.txt", "lib one");
    init(&app);
    commit(&app, "readme", "app");
    runner::run(&app, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.to_str().unwrap(), "lib"]).unwrap();
    runner::run(&app, ["commit", "-q", "-m", "add lib"]).unwrap();
    let sub = app.join("lib");
    for args in [&["config", "user.name", "Tester"][..], &["config", "user.email", "tester@example.com"]] {
        runner::run(&sub, args).unwrap();
    }
    commit(&sub, "b.txt", "lib two");
    let third = commit(&sub, "c.txt", "lib three");

    let log = submodule_log::log(&app, "lib", Some(&first), Some(&third)).unwrap();
    assert!(log.unavailable.is_none(), "{log:?}");
    assert_eq!(log.added_count, 2);
    assert_eq!(log.added.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["lib three", "lib two"]);
    assert_eq!(log.removed_count, 0);

    let back = submodule_log::log(&app, "lib", Some(&third), Some(&first)).unwrap();
    assert_eq!((back.added_count, back.removed_count), (0, 2), "a rewind drops commits");

    let missing = submodule_log::log(&app, "lib", Some(&first), Some(&"a".repeat(40))).unwrap();
    assert!(missing.unavailable.is_some());
    assert!(submodule_log::log(&app, "lib", Some("--output=x"), Some(&first)).is_err());
    assert!(submodule_log::log(&app, "../lib", Some(&first), Some(&third)).is_err());
}

#[test]
fn a_folder_that_is_not_a_checked_out_submodule_is_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let app = tmp.path().join("app");
    init(&app);
    fs::create_dir_all(app.join("vendor")).unwrap();
    commit(&app, "vendor/x", "x");
    let head = runner::run(&app, ["rev-parse", "HEAD"]).unwrap();
    let log = submodule_log::log(&app, "vendor", Some(head.trim()), Some(head.trim())).unwrap();
    assert!(log.unavailable.is_some());
}
