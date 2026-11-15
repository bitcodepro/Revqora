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
fn pull_and_history_edits_keep_staged_work_staged() {
    for mode in ["merge", "rebase"] {
        let (_keep, _server, me, colleague) = shared_remote();
        colleague.write("b.txt", "colleague work\n");
        let theirs = colleague.commit_all("colleague");
        colleague.git(&["push", "-q", "origin", "main"]);
        me.write("a.txt", "staged edit\n");
        me.git(&["add", "a.txt"]);
        me.write("a.txt", "staged edit\nplus an unstaged line\n");
        let out = ops::pull(me.p(), mode, |_| {}).unwrap();
        assert!(matches!(out.status.as_str(), "done" | "fastForward" | "pending"), "{mode}: {out:?}");
        if out.status == "pending" {
            ops::continue_op(me.p(), "merge", None).unwrap();
        }
        assert!(me.git(&["log", "--format=%H"]).contains(&theirs), "{mode}: pulled");
        assert_eq!(me.git(&["show", ":a.txt"]), "staged edit\n", "{mode}: the staged version is still staged");
        assert_eq!(fs::read_to_string(me.p().join("a.txt")).unwrap(), "staged edit\nplus an unstaged line\n", "{mode}: and the unstaged edit is back");
        assert!(me.git(&["stash", "list"]).is_empty(), "{mode}: nothing left behind");
    }
    // Rewording an older commit replays history; the staging survives that too.
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    let older = repo.commit_all("first");
    repo.write("c.txt", "c\n");
    repo.commit_all("second");
    repo.write("a.txt", "staged\n");
    repo.git(&["add", "a.txt"]);
    ops::rewrite(repo.p(), &ops::RewriteAction::Reword { oid: older, message: "renamed".into() }).unwrap();
    assert_eq!(repo.git(&["log", "-1", "--format=%s", "HEAD~1"]).trim(), "renamed");
    assert!(repo.git(&["status", "--porcelain"]).contains("M  a.txt"));
}

#[test]
fn staged_work_saved_before_a_paused_rebase_comes_back_after_abort() {
    let repo = Repo::new();
    repo.write("a.txt", "base\n");
    repo.write("s.txt", "s\n");
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write("a.txt", "theirs\n");
    repo.commit_all("theirs");
    repo.git(&["switch", "-q", "main"]);
    repo.write("a.txt", "ours\n");
    repo.commit_all("ours");
    repo.write("s.txt", "staged elsewhere\n");
    repo.git(&["add", "s.txt"]);
    let out = ops::rebase_onto(repo.p(), "other").unwrap();
    assert_eq!(out.status, "conflicts", "{out:?}");
    ops::abort_op(repo.p(), "rebase").unwrap();
    assert!(repo.git(&["status", "--porcelain"]).contains("M  s.txt"), "{}", repo.git(&["status", "--porcelain"]));
    assert!(repo.git(&["stash", "list"]).is_empty());
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
    assert!(!me.git(&["stash", "list"]).is_empty(), "a copy of the changes is kept");
}

#[test]
fn a_cp1251_conflict_is_edited_as_text_and_saved_back_in_cp1251() {
    use revqora_lib::git::conflicts;
    let repo = Repo::new();
    // "Привет" in Windows-1251, with CRLF line ends.
    fs::write(repo.p().join("ru.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2\r\n").unwrap();
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    fs::write(repo.p().join("ru.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2 1\r\n").unwrap();
    repo.commit_all("other");
    repo.git(&["switch", "-q", "main"]);
    fs::write(repo.p().join("ru.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2 2\r\n").unwrap();
    repo.commit_all("main");
    let _ = runner::exec(repo.p(), ["merge", "--no-commit", "other"]).unwrap();
    let info = conflicts::info(repo.p(), "ru.txt").unwrap();
    assert!(!info.ours.binary && !info.theirs.binary, "CP1251 is text and must be editable");
    assert_eq!(info.encoding, "windows-1251");
    assert!(!info.encodings_differ);
    assert!(info.ours.text.contains("Привет 2") && info.theirs.text.contains("Привет 1"));
    assert!(info.merged.contains("<<<<<<<") && info.merged.contains("Привет"), "{}", info.merged);
    // Saved in its own encoding: the bytes are CP1251 again, not UTF-8 and not U+FFFD.
    conflicts::save_resolution(repo.p(), "ru.txt", "Привет 1 и 2\r\n", true).unwrap();
    assert_eq!(fs::read(repo.p().join("ru.txt")).unwrap(), b"\xcf\xf0\xe8\xe2\xe5\xf2 1 \xe8 2\r\n");
}

#[test]
fn different_encodings_are_saved_in_the_one_the_user_chooses_and_unstorable_text_is_reported() {
    use revqora_lib::git::conflicts;
    let repo = Repo::new();
    fs::write(repo.p().join("ru.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2\n").unwrap();
    repo.commit_all("base cp1251");
    repo.git(&["switch", "-q", "-c", "other"]);
    fs::write(repo.p().join("ru.txt"), "Привет из UTF-8\n").unwrap();
    repo.commit_all("other utf-8");
    repo.git(&["switch", "-q", "main"]);
    fs::write(repo.p().join("ru.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2 \xe8\xe7 1251\n").unwrap();
    repo.commit_all("main cp1251");
    let _ = runner::exec(repo.p(), ["merge", "--no-commit", "other"]).unwrap();
    let info = conflicts::info(repo.p(), "ru.txt").unwrap();
    assert!(info.encodings_differ);
    assert_eq!(info.ours.encoding.as_deref(), Some("windows-1251"));
    assert_eq!(info.theirs.encoding.as_deref(), Some("UTF-8"));
    // A character CP1251 cannot store is reported, nothing is written.
    let before = fs::read(repo.p().join("ru.txt")).unwrap();
    let err = conflicts::save_resolution_as(repo.p(), "ru.txt", "Привет 😀\n", false, Some("windows-1251")).unwrap_err();
    assert_eq!(err.kind, "unencodable", "{}", err.message);
    assert_eq!(fs::read(repo.p().join("ru.txt")).unwrap(), before);
    // The user picks UTF-8 for the result.
    conflicts::save_resolution_as(repo.p(), "ru.txt", "Привет\n", true, Some("UTF-8")).unwrap();
    assert_eq!(fs::read_to_string(repo.p().join("ru.txt")).unwrap(), "Привет\n");
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
    // Remote-tracking branches are still cleaned with that refspec, by both fetch paths.
    for background in [true, false] {
        runner::run(&server, ["branch", "gone2", "main"]).unwrap();
        ops::fetch(me.p(), None, true, |_| {}).unwrap();
        assert!(runner::exec(me.p(), ["rev-parse", "--verify", "-q", "refs/remotes/origin/gone2"]).unwrap().ok());
        runner::run(&server, ["branch", "-D", "gone2"]).unwrap();
        if background {
            ops::fetch_background(me.p()).unwrap();
        } else {
            ops::fetch(me.p(), None, true, |_| {}).unwrap();
        }
        assert!(!runner::exec(me.p(), ["rev-parse", "--verify", "-q", "refs/remotes/origin/gone2"]).unwrap().ok(), "background={background}");
        assert!(runner::exec(me.p(), ["rev-parse", "--verify", "-q", "refs/tags/local-release-v1"]).unwrap().ok());
    }
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

#[test]
fn force_push_stays_safe_when_the_user_turned_the_reflog_off() {
    let (_keep, server, me, colleague) = shared_remote();
    me.git(&["config", "core.logAllRefUpdates", "false"]);
    me.write("a.txt", "base, reworded by me\n");
    me.git(&["commit", "-q", "-a", "--amend", "-m", "base (amended)"]);
    colleague.write("b.txt", "colleague work\n");
    let theirs = colleague.commit_all("colleague");
    colleague.git(&["push", "-q", "origin", "main"]);
    // Revqora's fetches keep a reflog for origin/* anyway, so the lease can still tell the
    // colleague's fetched commit from my own work and refuses to overwrite it.
    ops::fetch_background(me.p()).unwrap();
    let err = ops::push(me.p(), &force_push(&me), |_| {}).unwrap_err();
    assert_eq!(err.kind, "rejected", "{}", err.message);
    assert_eq!(runner::run(&server, ["rev-parse", "main"]).unwrap().trim(), theirs);
}

#[test]
fn a_working_file_in_another_encoding_is_read_correctly_not_lossily() {
    use revqora_lib::git::conflicts;
    let repo = Repo::new();
    fs::write(repo.p().join("note.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2\n").unwrap();
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    fs::write(repo.p().join("note.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2 1\n").unwrap();
    repo.commit_all("other");
    repo.git(&["switch", "-q", "main"]);
    fs::write(repo.p().join("note.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2 2\n").unwrap();
    repo.commit_all("main");
    let _ = runner::exec(repo.p(), ["merge", "--no-commit", "other"]).unwrap();
    // The user resolved the file in an external CP1251 editor before opening Revqora.
    fs::write(repo.p().join("note.txt"), b"\xcf\xf0\xe8\xe2\xe5\xf2 1+2\n").unwrap();
    let info = conflicts::info(repo.p(), "note.txt").unwrap();
    assert_eq!(info.working.as_deref(), Some("Привет 1+2\n"), "the working file is decoded in its own encoding");
    conflicts::save_resolution(repo.p(), "note.txt", info.working.as_deref().unwrap(), true).unwrap();
    assert_eq!(fs::read(repo.p().join("note.txt")).unwrap(), b"\xcf\xf0\xe8\xe2\xe5\xf2 1+2\n");
}
