//! Submodules, worktrees, bisect, Git LFS and signing settings on real repositories.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::extras;
use revqora_lib::git::runner;

fn repo(dir: &Path, name: &str) -> PathBuf {
    let r = dir.join(name);
    fs::create_dir_all(&r).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.name", "T"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "core.autocrlf", "false"],
        vec!["config", "commit.gpgsign", "false"],
    ] {
        runner::run(&r, &args).unwrap();
    }
    // Match application discovery: Git resolves macOS symlinks and Windows short paths.
    revqora_lib::git::repo::discover(&r).unwrap()
}

fn commit(r: &Path, file: &str, content: &str, msg: &str) -> String {
    fs::write(r.join(file), content).unwrap();
    runner::run(r, ["add", "-A"]).unwrap();
    runner::run(r, ["commit", "-qm", msg]).unwrap();
    runner::run(r, ["rev-parse", "HEAD"]).unwrap().trim().to_string()
}

#[test]
fn worktrees_add_list_lock_remove() {
    let tmp = tempfile::tempdir().unwrap();
    let r = repo(tmp.path(), "main");
    commit(&r, "a.txt", "a\n", "init");
    let wt = tmp.path().join("wt-feature");
    extras::worktree_add(&r, &wt.to_string_lossy(), None, Some("feature"), Some("main")).unwrap();
    let list = extras::worktrees(&r).unwrap();
    assert_eq!(list.len(), 2);
    assert!(list.iter().any(|w| w.is_current && w.branch.as_deref() == Some("main")));
    let other = list.iter().find(|w| !w.is_current).unwrap();
    assert_eq!(other.branch.as_deref(), Some("feature"));
    extras::worktree_lock(&r, &other.path, true).unwrap();
    assert!(extras::worktrees(&r).unwrap().iter().any(|w| w.locked));
    extras::worktree_lock(&r, &other.path, false).unwrap();
    fs::write(wt.join("dirty.txt"), "x").unwrap();
    let err = extras::worktree_remove(&r, &other.path, false).unwrap_err();
    assert_eq!(err.kind, "dirty-worktree");
    extras::worktree_remove(&r, &other.path, true).unwrap();
    assert_eq!(extras::worktrees(&r).unwrap().len(), 1);
}

#[test]
fn submodules_add_status_update() {
    // Local file:// submodules are blocked by default since git 2.38; allow them for the test.
    std::env::set_var("GIT_CONFIG_COUNT", "1");
    std::env::set_var("GIT_CONFIG_KEY_0", "protocol.file.allow");
    std::env::set_var("GIT_CONFIG_VALUE_0", "always");
    let tmp = tempfile::tempdir().unwrap();
    let lib = repo(tmp.path(), "lib");
    commit(&lib, "lib.txt", "v1\n", "lib v1");
    let app = repo(tmp.path(), "app");
    commit(&app, "app.txt", "app\n", "app");
    extras::submodule_add(&app, &lib.to_string_lossy(), "vendor/lib", |_| {}).unwrap();
    runner::run(&app, ["commit", "-qm", "add lib"]).unwrap();
    let subs = extras::submodules(&app).unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].path, "vendor/lib");
    assert_eq!(subs[0].state, "ok");
    assert!(subs[0].url.is_some());

    // A fresh clone has the submodule uninitialized until "update".
    let clone = tmp.path().join("clone");
    runner::run(tmp.path(), ["clone", "-q", &app.to_string_lossy(), &clone.to_string_lossy()]).unwrap();
    assert_eq!(extras::submodules(&clone).unwrap()[0].state, "uninitialized");
    extras::submodule_update(&clone, &[], |_| {}).unwrap();
    assert_eq!(extras::submodules(&clone).unwrap()[0].state, "ok");
    assert!(clone.join("vendor/lib/lib.txt").exists());
}

#[test]
fn bisect_finds_the_first_bad_commit() {
    let tmp = tempfile::tempdir().unwrap();
    let r = repo(tmp.path(), "b");
    let good = commit(&r, "app.txt", "ok 0\n", "c0");
    let mut culprit = String::new();
    for i in 1..10 {
        let content = if i >= 6 { format!("bug {i}\n") } else { format!("ok {i}\n") };
        let oid = commit(&r, "app.txt", &content, &format!("c{i}"));
        if i == 6 {
            culprit = oid;
        }
    }
    let mut st = extras::bisect_start(&r, "HEAD", &good).unwrap();
    assert!(st.active);
    assert!(st.remaining.is_some());
    for _ in 0..10 {
        if st.first_bad.is_some() {
            break;
        }
        let bad = fs::read_to_string(r.join("app.txt")).unwrap().starts_with("bug");
        st = extras::bisect_mark(&r, if bad { "bad" } else { "good" }, None).unwrap();
    }
    assert_eq!(st.first_bad.as_deref(), Some(culprit.as_str()));
    let labels = revqora_lib::git::refs::labels_by_oid(&r).unwrap();
    assert!(labels.values().flatten().any(|l| l.kind == "bisect"));
    extras::bisect_reset(&r).unwrap();
    assert!(!extras::bisect_status(&r).unwrap().active);
}

#[test]
fn lfs_tracking_and_signing_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let r = repo(tmp.path(), "l");
    commit(&r, "a.txt", "a\n", "init");

    let st = extras::lfs_status(&r).unwrap();
    if st.available {
        extras::lfs_track(&r, "*.psd", true).unwrap();
        let st = extras::lfs_status(&r).unwrap();
        assert!(st.used);
        assert_eq!(st.patterns, vec!["*.psd".to_string()]);
        extras::lfs_track(&r, "*.psd", false).unwrap();
        assert!(extras::lfs_status(&r).unwrap().patterns.is_empty());
    } else {
        eprintln!("git-lfs not installed; skipping LFS part");
    }

    let input = extras::SigningInput { sign_commits: true, sign_tags: false, format: "ssh".into(), key: Some("~/.ssh/id_ed25519.pub".into()) };
    extras::set_signing(&r, &input, false).unwrap();
    let cfg = extras::signing_config(&r);
    assert!(cfg.sign_commits);
    assert_eq!(cfg.format, "ssh");
    assert_eq!(cfg.key.as_deref(), Some("~/.ssh/id_ed25519.pub"));
    let input = extras::SigningInput { sign_commits: false, sign_tags: false, format: "openpgp".into(), key: None };
    extras::set_signing(&r, &input, false).unwrap();
    assert!(extras::signing_config(&r).key.is_none());
    let head = runner::run(&r, ["rev-parse", "HEAD"]).unwrap();
    assert_eq!(extras::signature(&r, head.trim()).unwrap().status, "N");
}
