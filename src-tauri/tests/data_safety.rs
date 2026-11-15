//! Regressions for data-safety findings: operations must not lose other people's commits,
//! staged work, local refs or file contents.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::ops::{self, PushOptions};
use revqora_lib::git::runner;

struct Repo {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Repo {
    fn new() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo");
        fs::create_dir_all(&path).unwrap();
        let repo = Repo { _dir: dir, path };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.configure();
        repo
    }
    fn clone_of(remote: &Path) -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clone");
        runner::run(dir.path(), ["clone", "-q", remote.to_str().unwrap(), path.to_str().unwrap()]).unwrap();
        let repo = Repo { _dir: dir, path };
        repo.configure();
        repo
    }
    fn configure(&self) {
        for (k, v) in [("user.name", "Tester"), ("user.email", "tester@example.com"), ("core.autocrlf", "false"), ("commit.gpgsign", "false")] {
            self.git(&["config", k, v]);
        }
    }
    fn p(&self) -> &Path {
        &self.path
    }
    fn write(&self, name: &str, content: &str) {
        fs::write(self.path.join(name), content).unwrap();
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(&self.path, args).unwrap()
    }
    fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }
}

/// A bare "server" with one commit on main, and two clones of it.
fn shared_remote() -> (tempfile::TempDir, PathBuf, Repo, Repo) {
    let seed = Repo::new();
    seed.write("a.txt", "base\n");
    seed.commit_all("base");
    let server_dir = tempfile::tempdir().unwrap();
    let server = server_dir.path().join("server.git");
    runner::run(server_dir.path(), ["clone", "-q", "--bare", seed.p().to_str().unwrap(), server.to_str().unwrap()]).unwrap();
    let me = Repo::clone_of(&server);
    let colleague = Repo::clone_of(&server);
    (server_dir, server, me, colleague)
}

fn force_push(_repo: &Repo) -> PushOptions {
    PushOptions { remote: Some("origin".into()), branch: Some("main".into()), remote_branch: Some("main".into()), force_with_lease: true, ..Default::default() }
}

#[test]
fn force_push_after_a_background_fetch_does_not_overwrite_a_colleagues_commit() {
    let (_keep, server, me, colleague) = shared_remote();
    // I rewrite my last commit locally.
    me.write("a.txt", "base, reworded by me\n");
    me.git(&["commit", "-q", "-a", "--amend", "-m", "base (amended)"]);
    // A colleague pushes on top of the old commit.
    colleague.write("b.txt", "colleague work\n");
    let theirs = colleague.commit_all("colleague");
    colleague.git(&["push", "-q", "origin", "main"]);
    // The periodic background fetch silently moves origin/main to their commit.
    ops::fetch_background(me.p()).unwrap();
    assert_eq!(me.git(&["rev-parse", "origin/main"]).trim(), theirs);
    // A force push with lease must refuse: their commit was never integrated locally.
    let err = ops::push(me.p(), &force_push(&me), |_| {}).unwrap_err();
    assert!(err.message.contains("rejected") || err.stderr.contains("rejected"), "{}", err.stderr);
    let server_main = runner::run(&server, ["rev-parse", "main"]).unwrap();
    assert_eq!(server_main.trim(), theirs, "the colleague's commit must stay on the server");
}

#[test]
fn force_push_of_my_own_rewrite_still_works() {
    let (_keep, server, me, _colleague) = shared_remote();
    me.write("a.txt", "base, reworded by me\n");
    me.git(&["commit", "-q", "-a", "--amend", "-m", "base (amended)"]);
    let mine = me.git(&["rev-parse", "HEAD"]).trim().to_string();
    ops::push(me.p(), &force_push(&me), |_| {}).unwrap();
    assert_eq!(runner::run(&server, ["rev-parse", "main"]).unwrap().trim(), mine);
}

#[test]
fn amend_and_force_push_after_my_own_push_works() {
    let (_keep, server, me, _colleague) = shared_remote();
    me.write("c.txt", "first try\n");
    me.commit_all("feature");
    me.git(&["push", "-q", "origin", "main"]); // gives origin/main a reflog entry
    me.write("c.txt", "second try\n");
    me.git(&["commit", "-q", "-a", "--amend", "-m", "feature (amended)"]);
    let mine = me.git(&["rev-parse", "HEAD"]).trim().to_string();
    ops::push(me.p(), &force_push(&me), |_| {}).unwrap();
    assert_eq!(runner::run(&server, ["rev-parse", "main"]).unwrap().trim(), mine);
}

#[test]
fn pull_and_history_edits_refuse_instead_of_unstaging_staged_work() {
    let (_keep, _server, me, colleague) = shared_remote();
    colleague.write("b.txt", "colleague work\n");
    colleague.commit_all("colleague");
    colleague.git(&["push", "-q", "origin", "main"]);
    let older = me.git(&["rev-parse", "HEAD"]).trim().to_string();
    me.write("c.txt", "second\n");
    me.commit_all("second");
    me.write("a.txt", "staged edit\n");
    me.git(&["add", "a.txt"]);
    let index_before = me.git(&["ls-files", "--stage"]);
    for mode in ["merge", "rebase"] {
        let err = ops::pull(me.p(), mode, |_| {}).unwrap_err();
        assert_eq!(err.kind, "staged-changes", "{mode}: {}", err.message);
    }
    let head = me.git(&["rev-parse", "HEAD"]).trim().to_string();
    // Rewording an older commit replays history through an autostashing rebase.
    let err = ops::rewrite(me.p(), &ops::RewriteAction::Reword { oid: older, message: "renamed".into() }).unwrap_err();
    assert_eq!(err.kind, "staged-changes", "{}", err.message);
    // Nothing moved: same commit, same staged entry, the edit still staged.
    assert_eq!(me.git(&["rev-parse", "HEAD"]).trim(), head);
    assert_eq!(me.git(&["ls-files", "--stage"]), index_before);
    assert!(me.git(&["status", "--porcelain"]).contains("M  a.txt"));
}

#[test]
fn a_conflicting_autostash_is_reported_not_shown_as_success() {
    let (_keep, _server, me, colleague) = shared_remote();
    colleague.write("a.txt", "their line\n");
    colleague.commit_all("colleague edits a.txt");
    colleague.git(&["push", "-q", "origin", "main"]);
    // An unstaged edit of the same file: Git autostashes it, pulls, then cannot re-apply it cleanly.
    me.write("a.txt", "my unsaved line\n");
    let out = ops::pull(me.p(), "rebase", |_| {}).unwrap();
    assert_eq!(out.status, "conflicts", "{out:?}");
    assert!(me.git(&["stash", "list"]).contains("autostash") || !me.git(&["stash", "list"]).is_empty());
}

#[test]
fn a_conflict_in_a_non_utf8_file_is_never_saved_as_lossy_text() {
    use revqora_lib::git::conflicts;
    let repo = Repo::new();
    // "Привет\n" in Windows-1251.
    fs::write(repo.p().join("ru.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2\n").unwrap();
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    fs::write(repo.p().join("ru.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2 1\n").unwrap();
    repo.commit_all("other");
    repo.git(&["switch", "-q", "main"]);
    fs::write(repo.p().join("ru.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2 2\n").unwrap();
    repo.commit_all("main");
    let _ = runner::exec(repo.p(), ["merge", "--no-commit", "other"]).unwrap();
    let info = conflicts::info(repo.p(), "ru.txt").unwrap();
    assert!(info.ours.binary && info.theirs.binary, "non-UTF-8 sides must not be offered as editable text");
    let on_disk = fs::read(repo.p().join("ru.txt")).unwrap();
    let err = conflicts::save_resolution(repo.p(), "ru.txt", "\u{fffd}\u{fffd} 2\n", true).unwrap_err();
    assert_eq!(err.kind, "not-text");
    assert_eq!(fs::read(repo.p().join("ru.txt")).unwrap(), on_disk, "the file bytes must be untouched");
}

#[test]
fn fetch_never_prunes_local_tags_but_still_cleans_deleted_remote_branches() {
    let (_keep, server, me, _colleague) = shared_remote();
    // Normal refspec: a branch deleted on the server disappears from origin/*.
    runner::run(&server, ["branch", "gone", "main"]).unwrap();
    ops::fetch_background(me.p()).unwrap();
    assert!(runner::exec(me.p(), ["rev-parse", "--verify", "-q", "refs/remotes/origin/gone"]).unwrap().ok());
    runner::run(&server, ["branch", "-D", "gone"]).unwrap();
    ops::fetch_background(me.p()).unwrap();
    assert!(!runner::exec(me.p(), ["rev-parse", "--verify", "-q", "refs/remotes/origin/gone"]).unwrap().ok());

    // "Always fetch tags" recipe plus pruneTags: a local-only tag must survive both fetch paths.
    me.git(&["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
    me.git(&["config", "fetch.pruneTags", "true"]);
    me.git(&["tag", "local-release-v1"]);
    ops::fetch_background(me.p()).unwrap();
    ops::fetch(me.p(), None, true, |_| {}).unwrap();
    assert!(runner::exec(me.p(), ["rev-parse", "--verify", "-q", "refs/tags/local-release-v1"]).unwrap().ok(), "local tag was pruned");
}

#[test]
fn prune_keeps_recent_unreferenced_objects() {
    use revqora_lib::git::maint;
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.commit_all("base");
    // An object another process just wrote and has not referenced yet.
    let fresh = runner::run_env(repo.p(), ["hash-object", "-w", "--stdin"], &[], Some(b"work in progress\n")).unwrap();
    maint::run(repo.p(), "prune", |_| {}).unwrap();
    assert!(runner::exec(repo.p(), ["cat-file", "-e", fresh.trim()]).unwrap().ok(), "a fresh unreachable object was pruned");
}

#[test]
fn an_uncapturable_working_tree_never_blocks_abort_or_conflict_resolution() {
    use revqora_lib::git::recovery;
    let repo = Repo::new();
    repo.write("a.txt", "base\n");
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write("a.txt", "theirs\n");
    repo.commit_all("theirs");
    repo.git(&["switch", "-q", "main"]);
    repo.write("a.txt", "ours\n");
    repo.commit_all("ours");
    let _ = runner::exec(repo.p(), ["merge", "--no-commit", "other"]).unwrap();
    // An untracked clone inside the working tree: a workspace snapshot cannot capture it.
    let nested = repo.p().join("vendor");
    fs::create_dir_all(&nested).unwrap();
    runner::run(&nested, ["init", "-q"]).unwrap();
    for command in ["conflict_save", "conflict_take", "op_abort"] {
        recovery::before(repo.p(), command, None).unwrap_or_else(|e| panic!("{command} was blocked: {}", e.message));
    }
    // Destructive actions still require the full snapshot that protects the files they touch.
    let err = recovery::before(repo.p(), "discard", None).unwrap_err();
    assert_eq!(err.kind, "checkpoint-failed");
}

#[test]
fn stashing_one_file_treats_its_name_literally() {
    let repo = Repo::new();
    fs::create_dir_all(repo.p().join("pages")).unwrap();
    repo.write("pages/[id].tsx", "page\n");
    repo.write("pages/i.tsx", "other\n");
    repo.commit_all("base");
    repo.write("pages/[id].tsx", "page edited\n");
    repo.write("pages/i.tsx", "other edited\n");
    ops::stash_save(repo.p(), "one file", false, false, &["pages/[id].tsx".into()]).unwrap();
    let stashed = repo.git(&["stash", "show", "--name-only", "stash@{0}"]);
    assert_eq!(stashed.trim(), "pages/[id].tsx", "{stashed}");
    assert_eq!(fs::read_to_string(repo.p().join("pages/i.tsx")).unwrap(), "other edited\n");
}

#[test]
fn history_rewrites_keep_message_lines_that_start_with_a_hash() {
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    let first = repo.commit_all("first");
    repo.write("b.txt", "b\n");
    repo.commit_all("second");
    ops::rewrite(repo.p(), &ops::RewriteAction::Reword { oid: first, message: "#123 Fix crash\n\nDetails".into() }).unwrap();
    let message = repo.git(&["log", "-1", "--format=%B", "HEAD~1"]);
    assert!(message.starts_with("#123 Fix crash"), "{message}");
}
