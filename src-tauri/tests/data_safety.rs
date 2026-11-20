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
        runner::run(dir.path(), ["clone", "-q", "-c", "core.autocrlf=false", remote.to_str().unwrap(), path.to_str().unwrap()]).unwrap();
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

/// Local `main` pushed to the remote branch `team/main` (another name).
fn renamed_force_push() -> PushOptions {
    PushOptions {
        remote: Some("origin".into()),
        branch: Some("main".into()),
        remote_branch: Some("team/main".into()),
        force_with_lease: true,
        ..Default::default()
    }
}

#[test]
fn force_push_to_a_branch_with_another_name_works_after_my_own_rewrite() {
    // Git's --force-if-includes looks for a local branch named like the remote one and refused
    // every such push ("remote ref updated since checkout").
    let (_keep, server, me, _colleague) = shared_remote();
    me.write("c.txt", "first try\n");
    me.commit_all("feature");
    me.git(&["push", "-q", "origin", "main:refs/heads/team/main"]);
    me.git(&["fetch", "-q", "origin"]);
    me.write("c.txt", "second try\n");
    me.git(&["commit", "-q", "-a", "--amend", "-m", "feature (amended)"]);
    let mine = me.git(&["rev-parse", "HEAD"]).trim().to_string();
    ops::push(me.p(), &renamed_force_push(), |_| {}).unwrap();
    assert_eq!(runner::run(&server, ["rev-parse", "team/main"]).unwrap().trim(), mine);
}

#[test]
fn force_push_to_a_branch_with_another_name_never_overwrites_a_fetched_colleague_commit() {
    let (_keep, server, me, colleague) = shared_remote();
    me.git(&["push", "-q", "origin", "main:refs/heads/team/main"]);
    me.git(&["fetch", "-q", "origin"]);
    me.write("a.txt", "base, reworded by me\n");
    me.git(&["commit", "-q", "-a", "--amend", "-m", "base (amended)"]);
    colleague.git(&["fetch", "-q", "origin"]);
    colleague.git(&["checkout", "-q", "-b", "team", "origin/team/main"]);
    colleague.write("b.txt", "colleague work\n");
    let theirs = colleague.commit_all("colleague");
    colleague.git(&["push", "-q", "origin", "team:refs/heads/team/main"]);
    // The background fetch moves origin/team/main to their commit, which I never saw.
    ops::fetch_background(me.p()).unwrap();
    assert_eq!(me.git(&["rev-parse", "origin/team/main"]).trim(), theirs);
    let err = ops::push(me.p(), &renamed_force_push(), |_| {}).unwrap_err();
    assert_eq!(err.kind, "lease-unverifiable", "{}", err.message);
    assert_eq!(runner::run(&server, ["rev-parse", "team/main"]).unwrap().trim(), theirs, "their commit stays on the server");
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
fn pull_updates_files_only_line_ending_rules_call_modified() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (_keep, _server, me, colleague) = shared_remote();
        // Committed with CRLF, then a rule that stores text with LF: Git calls the untouched
        // files modified, and no checkout or stash changes that.
        fs::write(colleague.p().join("crlf.txt"), "one\r\ntwo\r\n").unwrap();
        colleague.commit_all("crlf");
        colleague.git(&["push", "-q", "origin", "main"]);
        me.git(&["pull", "-q", "--ff-only"]);
        fs::write(me.p().join(".git/info/attributes"), "* text\n").unwrap();
        me.git(&["config", "core.eol", "lf"]);
        me.write("a.txt", "my real edit\n");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(me.p().join("crlf.txt"), "one\r\ntwo\r\n").unwrap();
        assert!(me.git(&["status", "--porcelain"]).contains(" M crlf.txt"), "{mode}: line endings alone make it modified");
        fs::write(colleague.p().join("crlf.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
        let theirs = colleague.commit_all("three");
        colleague.git(&["push", "-q", "origin", "main"]);

        let out = ops::pull(me.p(), mode, |_| {}).unwrap();
        assert!(matches!(out.status.as_str(), "done" | "fastForward"), "{mode}: {out:?}");
        assert_eq!(me.git(&["rev-parse", "HEAD"]).trim(), theirs, "{mode}");
        assert_eq!(fs::read(me.p().join("crlf.txt")).unwrap(), b"one\r\ntwo\r\nthree\r\n", "{mode}: the incoming version");
        assert_eq!(fs::read_to_string(me.p().join("a.txt")).unwrap(), "my real edit\n", "{mode}: a real edit is kept");
        assert!(me.git(&["stash", "list"]).is_empty(), "{mode}: nothing left behind");
        assert_eq!(fs::read_to_string(me.p().join(".git/info/attributes")).unwrap(), "* text\n", "{mode}: the rules are as before");
    }
}

#[test]
fn pull_keeps_line_ending_rules_for_the_files_it_writes_and_others_edits_of_the_rules() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (_keep, _server, me, colleague) = shared_remote();
        fs::write(colleague.p().join("crlf.txt"), "one\r\ntwo\r\n").unwrap();
        colleague.commit_all("crlf stored as is");
        colleague.git(&["push", "-q", "origin", "main"]);
        me.git(&["pull", "-q", "--ff-only"]);
        // This clone checks text out with CRLF and stores it with LF: the file committed with
        // CRLF is "modified" by the rule alone.
        fs::write(me.p().join(".git/info/attributes"), "*.txt text eol=crlf\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(me.p().join("crlf.txt"), "one\r\ntwo\r\n").unwrap();
        assert!(me.git(&["status", "--porcelain"]).contains(" M crlf.txt"), "{mode}");
        // The colleague fixes the file: stored with LF from now on.
        fs::write(colleague.p().join("crlf.txt"), "one\ntwo\nthree\n").unwrap();
        let theirs = colleague.commit_all("normalized");
        colleague.git(&["push", "-q", "origin", "main"]);
        // Another tool adds a rule while the pull runs (a hook stands in for it).
        let hooks = me.p().join(".git/hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = if mode == "rebase" { "post-rewrite" } else { "post-merge" };
        fs::write(hooks.join(hook), "#!/bin/sh\nprintf '*.bin binary\\n' >> .git/info/attributes\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(hooks.join(hook), fs::Permissions::from_mode(0o755)).unwrap();
        }

        let out = ops::pull(me.p(), mode, |_| {}).unwrap();
        assert!(matches!(out.status.as_str(), "done" | "fastForward"), "{mode}: {out:?}");
        assert_eq!(me.git(&["rev-parse", "HEAD"]).trim(), theirs, "{mode}");
        assert_eq!(fs::read(me.p().join("crlf.txt")).unwrap(), b"one\r\ntwo\r\nthree\r\n", "{mode}: checked out as the rule says");
        let status = me.git(&["status", "--porcelain"]);
        assert!(status.trim().is_empty(), "{mode}: clean, not {status}");
        let rules = fs::read_to_string(me.p().join(".git/info/attributes")).unwrap();
        if mode != "rebase" || rules.contains("*.bin") {
            assert_eq!(rules, "*.txt text eol=crlf\n*.bin binary\n", "{mode}: the other tool's rule stays, the pull's block is gone");
        } else {
            assert_eq!(rules, "*.txt text eol=crlf\n", "{mode}");
        }
    }
}

#[test]
fn a_failed_pull_takes_out_only_its_own_line_ending_block() {
    let (_keep, _server, me, colleague) = shared_remote();
    fs::write(colleague.p().join("crlf.txt"), "one\r\ntwo\r\n").unwrap();
    colleague.commit_all("crlf");
    colleague.git(&["push", "-q", "origin", "main"]);
    me.git(&["pull", "-q", "--ff-only"]);
    fs::write(me.p().join(".git/info/attributes"), "* text\n").unwrap();
    me.git(&["config", "core.eol", "lf"]);
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::write(me.p().join("crlf.txt"), "one\r\ntwo\r\n").unwrap();
    me.git(&["remote", "set-url", "origin", me.p().join("no-such-server.git").to_str().unwrap()]);
    assert!(ops::pull(me.p(), "ff-only", |_| {}).is_err());
    assert_eq!(fs::read_to_string(me.p().join(".git/info/attributes")).unwrap(), "* text\n");
    // Without a rules file before, none is left behind either.
    fs::remove_file(me.p().join(".git/info/attributes")).unwrap();
    fs::write(me.p().join(".gitattributes"), "* text\n").unwrap();
    let _ = ops::pull(me.p(), "ff-only", |_| {});
    assert!(!me.p().join(".git/info/attributes").exists());
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

#[test]
fn force_push_after_reflogs_were_expired_does_not_overwrite_a_fetched_commit() {
    let (_keep, server, me, colleague) = shared_remote();
    me.write("a.txt", "base, reworded by me\n");
    me.git(&["commit", "-q", "-a", "--amend", "-m", "base (amended)"]);
    colleague.write("b.txt", "colleague work\n");
    let theirs = colleague.commit_all("colleague");
    colleague.git(&["push", "-q", "origin", "main"]);
    ops::fetch_background(me.p()).unwrap();
    // Every reflog is gone (gc, expiry or a manual clean-up): nothing shows what was fetched.
    me.git(&["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
    let err = ops::push(me.p(), &force_push(&me), |_| {}).unwrap_err();
    assert_eq!(err.kind, "lease-unverifiable", "{}", err.message);
    assert_eq!(runner::run(&server, ["rev-parse", "main"]).unwrap().trim(), theirs);
}

/// A rebase that pauses on a.txt while s.txt was staged; the rebased commits also change s.txt,
/// so restoring the saved change after the rebase conflicts.
fn paused_rebase_with_saved_changes() -> Repo {
    let repo = Repo::new();
    repo.write("a.txt", "base\n");
    repo.write("s.txt", "s\n");
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write("a.txt", "theirs\n");
    repo.write("s.txt", "other s\n");
    repo.commit_all("theirs");
    repo.git(&["switch", "-q", "main"]);
    repo.write("a.txt", "ours\n");
    repo.commit_all("ours");
    repo.write("s.txt", "staged s\n");
    repo.git(&["add", "s.txt"]);
    let out = ops::rebase_onto(repo.p(), "other").unwrap();
    assert_eq!(out.status, "conflicts", "{out:?}");
    repo
}

#[test]
fn continue_and_skip_report_conflicts_when_restoring_saved_changes_conflicts() {
    let repo = paused_rebase_with_saved_changes();
    repo.write("a.txt", "resolved\n");
    repo.git(&["add", "a.txt"]);
    let out = ops::continue_op(repo.p(), "rebase", None).unwrap();
    assert_eq!(out.status, "conflicts", "continue: {out:?}");
    assert!(out.conflicts.iter().any(|c| c == "s.txt"), "{out:?}");
    assert!(!repo.git(&["stash", "list"]).is_empty(), "a copy stays in Stashes");

    let repo = paused_rebase_with_saved_changes();
    let out = ops::skip_op(repo.p(), "rebase").unwrap();
    assert_eq!(out.status, "conflicts", "skip: {out:?}");
    assert!(out.conflicts.iter().any(|c| c == "s.txt"), "{out:?}");
}

#[test]
fn utf16_without_bom_is_saved_back_as_utf16() {
    use revqora_lib::git::conflicts;
    let utf16 = |text: &str| -> Vec<u8> { text.encode_utf16().flat_map(u16::to_le_bytes).collect() };
    let repo = Repo::new();
    fs::write(repo.p().join("w.txt"), utf16("base line\r\n")).unwrap();
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    fs::write(repo.p().join("w.txt"), utf16("theirs line\r\n")).unwrap();
    repo.commit_all("other");
    repo.git(&["switch", "-q", "main"]);
    fs::write(repo.p().join("w.txt"), utf16("ours line\r\n")).unwrap();
    repo.commit_all("main");
    let _ = runner::exec(repo.p(), ["merge", "--no-commit", "other"]).unwrap();
    let info = conflicts::info(repo.p(), "w.txt").unwrap();
    assert_eq!(info.encoding, "UTF-16LE", "{info:?}");
    assert!(!info.ours.ascii, "UTF-16 text is not interchangeable with ASCII");
    conflicts::save_resolution(repo.p(), "w.txt", "merged line\r\n", true).unwrap();
    assert_eq!(fs::read(repo.p().join("w.txt")).unwrap(), utf16("merged line\r\n"));
}

/// A rebase paused on a.txt, with a new file n.txt and an edit of s.txt staged before it.
fn paused_rebase_saving_new_file() -> Repo {
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
    repo.write("n.txt", "saved new\n");
    repo.write("s.txt", "saved s\n");
    repo.git(&["add", "n.txt", "s.txt"]);
    let out = ops::rebase_onto(repo.p(), "other").unwrap();
    assert_eq!(out.status, "conflicts", "{out:?}");
    assert!(!repo.p().join("n.txt").exists());
    repo
}

#[test]
fn restoring_saved_changes_never_overwrites_files_created_while_paused() {
    for (skip, ignored) in [(false, false), (true, false), (false, true)] {
        let repo = paused_rebase_saving_new_file();
        if ignored {
            fs::write(repo.p().join(".git/info/exclude"), "n.txt\n").unwrap();
        }
        repo.write("n.txt", "made while paused\n");
        let out = if skip {
            ops::skip_op(repo.p(), "rebase").unwrap()
        } else {
            repo.write("a.txt", "resolved\n");
            repo.git(&["add", "a.txt"]);
            ops::continue_op(repo.p(), "rebase", None).unwrap()
        };
        assert!(out.message.contains("n.txt"), "{out:?}");
        assert_eq!(fs::read_to_string(repo.p().join("n.txt")).unwrap(), "made while paused\n");
        assert!(!repo.git(&["stash", "list"]).is_empty(), "the saved changes stay in Stashes");
    }
}

#[test]
fn edits_hidden_by_assume_unchanged_are_never_overwritten() {
    // Continue: the restore compares content, not Git's index flags, and keeps the stash.
    let repo = paused_rebase_saving_new_file();
    repo.git(&["update-index", "--assume-unchanged", "s.txt"]);
    repo.write(
        "s.txt",
        "edited while paused
",
    );
    repo.write(
        "a.txt",
        "resolved
",
    );
    repo.git(&["add", "a.txt"]);
    let out = ops::continue_op(repo.p(), "rebase", None).unwrap();
    assert!(out.message.contains("s.txt"), "{out:?}");
    assert_eq!(
        fs::read_to_string(repo.p().join("s.txt")).unwrap(),
        "edited while paused
"
    );
    assert!(!repo.git(&["stash", "list"]).is_empty(), "the saved changes stay in Stashes");

    // Skip and Abort reset the working tree, which Git does without seeing flagged files:
    // they stop first, with the file named, and nothing is lost.
    for abort in [false, true] {
        let repo = paused_rebase_saving_new_file();
        repo.git(&["update-index", "--assume-unchanged", "s.txt"]);
        repo.write(
            "s.txt",
            "edited while paused
",
        );
        let err = if abort { ops::abort_op(repo.p(), "rebase").unwrap_err() } else { ops::skip_op(repo.p(), "rebase").unwrap_err() };
        assert_eq!(err.kind, "hidden-changes", "{}", err.message);
        assert!(err.message.contains("s.txt"), "{}", err.message);
        assert_eq!(
            fs::read_to_string(repo.p().join("s.txt")).unwrap(),
            "edited while paused
"
        );
        assert!(!repo.git(&["stash", "list"]).is_empty(), "the saved changes stay in Stashes");
        // Still paused: the user can clear the flag or copy the file, then try again.
        assert!(repo.p().join(".git/rebase-merge").exists() || repo.p().join(".git/rebase-apply").exists());
    }
}

/// A rebase paused on a.txt in a sparse checkout that leaves out.txt out (skip-worktree, absent).
fn paused_sparse_rebase() -> Repo {
    let repo = Repo::new();
    repo.write("a.txt", "base\n");
    repo.write("out.txt", "excluded\n");
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write("a.txt", "theirs\n");
    repo.commit_all("theirs");
    repo.git(&["switch", "-q", "main"]);
    repo.write("a.txt", "ours\n");
    repo.commit_all("ours");
    repo.git(&["sparse-checkout", "set", "--no-cone", "/a.txt"]);
    assert!(!repo.p().join("out.txt").exists());
    let out = ops::rebase_onto(repo.p(), "other").unwrap();
    assert_eq!(out.status, "conflicts", "{out:?}");
    repo
}

#[test]
fn sparse_checkout_does_not_block_abort_or_skip() {
    // Plain skip-worktree ("S"), and skip-worktree with assume-unchanged too ("s").
    for assume in [false, true] {
        for abort in [false, true] {
            let repo = paused_sparse_rebase();
            if assume {
                repo.git(&["update-index", "--assume-unchanged", "out.txt"]);
                assert!(repo.git(&["ls-files", "-v", "out.txt"]).starts_with("s "));
            }
            if abort {
                ops::abort_op(repo.p(), "rebase").unwrap()
            } else {
                ops::skip_op(repo.p(), "rebase").map(drop).unwrap()
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn hidden_type_and_mode_changes_are_never_overwritten() {
    use std::os::unix::fs::PermissionsExt;
    // Same bytes, different executable bit; then a symlink whose target text equals the content.
    for symlink in [false, true] {
        let repo = paused_rebase_saving_new_file();
        repo.git(&["config", "core.filemode", "true"]);
        repo.git(&["config", "core.symlinks", "true"]);
        repo.git(&["update-index", "--assume-unchanged", "s.txt"]);
        let file = repo.p().join("s.txt");
        if symlink {
            fs::remove_file(&file).unwrap();
            std::os::unix::fs::symlink("s\n", &file).unwrap();
        } else {
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let err = ops::skip_op(repo.p(), "rebase").unwrap_err();
        assert_eq!(err.kind, "hidden-changes", "{}", err.message);
        repo.write("a.txt", "resolved\n");
        repo.git(&["add", "a.txt"]);
        let out = ops::continue_op(repo.p(), "rebase", None).unwrap();
        assert!(out.message.contains("s.txt"), "{out:?}");
        let meta = fs::symlink_metadata(&file).unwrap();
        if symlink {
            assert!(meta.file_type().is_symlink(), "the symlink was replaced");
        } else {
            assert_ne!(meta.permissions().mode() & 0o111, 0, "the executable bit was reset");
        }
        assert!(!repo.git(&["stash", "list"]).is_empty(), "the saved changes stay in Stashes");
    }
}

#[cfg(unix)]
#[test]
fn hidden_mode_change_follows_the_owner_execute_bit() {
    use std::os::unix::fs::PermissionsExt;
    // Committed executable (100755); made 0645 while paused: Git reads that as 100644 because
    // only the owner-execute bit counts, even though other-execute is still set.
    let repo = Repo::new();
    repo.git(&["config", "core.filemode", "true"]);
    repo.write(
        "a.txt", "base
",
    );
    repo.write(
        "s.sh", "s
",
    );
    fs::set_permissions(repo.p().join("s.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write(
        "a.txt", "theirs
",
    );
    repo.commit_all("theirs");
    repo.git(&["switch", "-q", "main"]);
    repo.write(
        "a.txt", "ours
",
    );
    repo.commit_all("ours");
    repo.write(
        "s.sh", "saved
",
    );
    repo.git(&["add", "s.sh"]);
    let out = ops::rebase_onto(repo.p(), "other").unwrap();
    assert_eq!(out.status, "conflicts", "{out:?}");
    repo.git(&["update-index", "--assume-unchanged", "s.sh"]);
    let file = repo.p().join("s.sh");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o645)).unwrap();
    let err = ops::skip_op(repo.p(), "rebase").unwrap_err();
    assert_eq!(err.kind, "hidden-changes", "{}", err.message);
    repo.write(
        "a.txt",
        "resolved
",
    );
    repo.git(&["add", "a.txt"]);
    let out = ops::continue_op(repo.p(), "rebase", None).unwrap();
    assert!(out.message.contains("s.sh"), "{out:?}");
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o645, "the user's mode was reset");
    assert!(!repo.git(&["stash", "list"]).is_empty(), "the saved changes stay in Stashes");
}

/// main: base, "add files" (secret.cfg, plain.txt), "remove" (deletes both, ignores secret.cfg).
fn repo_with_removed_files() -> (Repo, String, String) {
    let repo = Repo::new();
    repo.write("base.txt", "base\n");
    repo.commit_all("base");
    repo.write("secret.cfg", "tracked\n");
    repo.write("plain.txt", "tracked\n");
    let with_files = repo.commit_all("add files");
    fs::remove_file(repo.p().join("secret.cfg")).unwrap();
    fs::remove_file(repo.p().join("plain.txt")).unwrap();
    repo.write(".gitignore", "secret.cfg\n");
    let removed = repo.commit_all("remove");
    (repo, with_files, removed)
}

#[test]
fn reset_never_overwrites_untracked_or_ignored_files() {
    let (repo, with_files, removed) = repo_with_removed_files();
    for (mode, file) in [("hard", "secret.cfg"), ("hard", "plain.txt"), ("keep", "secret.cfg")] {
        repo.write(file, "MINE\n");
        let e = ops::reset(repo.p(), &with_files, mode).unwrap_err();
        assert_eq!(e.kind, "ignored-collision", "{mode} {file}: {}", e.message);
        assert_eq!(fs::read_to_string(repo.p().join(file)).unwrap(), "MINE\n");
        assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), removed, "{mode}: HEAD must not move");
        fs::remove_file(repo.p().join(file)).unwrap();
    }
    // Soft and mixed never write files; hard works once nothing is in the way.
    repo.write("secret.cfg", "MINE\n");
    ops::reset(repo.p(), &with_files, "mixed").unwrap();
    assert_eq!(fs::read_to_string(repo.p().join("secret.cfg")).unwrap(), "MINE\n");
    ops::reset(repo.p(), &removed, "soft").unwrap();
    repo.git(&["reset", "-q", "--mixed", &removed]);
    fs::remove_file(repo.p().join("secret.cfg")).unwrap();
    ops::reset(repo.p(), &with_files, "hard").unwrap();
    assert_eq!(fs::read_to_string(repo.p().join("secret.cfg")).unwrap(), "tracked\n");
    assert_eq!(ops::reset(repo.p(), "--hard", "mixed").unwrap_err().kind, "invalid-argument");
}

#[test]
fn revert_never_overwrites_ignored_files() {
    let (repo, _, removed) = repo_with_removed_files();
    repo.write("secret.cfg", "MINE\n");
    let e = ops::revert(repo.p(), &removed, false).unwrap_err();
    assert_eq!(e.kind, "ignored-collision", "{}", e.message);
    assert_eq!(fs::read_to_string(repo.p().join("secret.cfg")).unwrap(), "MINE\n");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), removed);
    fs::remove_file(repo.p().join("secret.cfg")).unwrap();
    ops::revert(repo.p(), &removed, false).unwrap();
    assert_eq!(fs::read_to_string(repo.p().join("secret.cfg")).unwrap(), "tracked\n");
}

#[test]
fn rebase_onto_never_overwrites_ignored_files() {
    let (repo, _, removed) = repo_with_removed_files();
    // Upstream tracks the ignored path; the topic branch does not have it.
    repo.git(&["switch", "-q", "-c", "up"]);
    repo.write("secret.cfg", "upstream\n");
    repo.git(&["add", "-f", "secret.cfg"]);
    repo.git(&["commit", "-q", "-m", "up"]);
    repo.git(&["switch", "-q", "-c", "topic", &removed]);
    repo.write("topic.txt", "t\n");
    let topic = repo.commit_all("topic");
    repo.write("secret.cfg", "MINE\n");
    let e = ops::rebase_onto(repo.p(), "up").unwrap_err();
    assert_eq!(e.kind, "ignored-collision", "{}", e.message);
    assert_eq!(fs::read_to_string(repo.p().join("secret.cfg")).unwrap(), "MINE\n");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), topic);
    fs::remove_file(repo.p().join("secret.cfg")).unwrap();
    ops::rebase_onto(repo.p(), "up").unwrap();
    assert_eq!(fs::read_to_string(repo.p().join("secret.cfg")).unwrap(), "upstream\n");
    assert!(repo.p().join("topic.txt").exists());
}

#[test]
fn rebase_onto_keeps_merge_commits_only_when_asked() {
    let build = || {
        let repo = Repo::new();
        repo.write("base.txt", "base\n");
        repo.commit_all("base");
        repo.git(&["switch", "-q", "-c", "up"]);
        repo.write("up.txt", "up\n");
        repo.commit_all("up");
        repo.git(&["switch", "-q", "-c", "topic", "main"]);
        repo.write("topic.txt", "t\n");
        repo.commit_all("topic");
        repo.git(&["switch", "-q", "-c", "side", "main"]);
        repo.write("side.txt", "s\n");
        repo.commit_all("side");
        repo.git(&["switch", "-q", "topic"]);
        repo.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
        repo
    };
    let merges = |repo: &Repo| repo.git(&["rev-list", "--count", "--merges", "up..HEAD"]).trim().to_string();

    let repo = build();
    assert_eq!(ops::rebase_merge_count(repo.p(), "up").unwrap(), 1);
    assert_eq!(ops::rebase_merge_count(repo.p(), "topic").unwrap(), 0);
    assert!(ops::rebase_merge_count(repo.p(), "--all").is_err());
    ops::rebase_onto_with(repo.p(), "up", true).unwrap();
    assert_eq!(merges(&repo), "1", "the merge commit must be re-created");
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]).trim(), "merge side");
    for file in ["up.txt", "topic.txt", "side.txt"] {
        assert!(repo.p().join(file).exists(), "{file}");
    }

    let repo = build();
    ops::rebase_onto_with(repo.p(), "up", false).unwrap();
    assert_eq!(merges(&repo), "0", "a plain rebase flattens");
    assert_eq!(repo.git(&["rev-list", "--count", "up..HEAD"]).trim(), "2");
}

#[test]
fn rebase_onto_protects_ignored_files_at_directory_rename_destinations() {
    // Upstream moves old/ to new/; the topic adds old/extra, which Git's directory-rename
    // detection writes to new/extra, where an ignored local file is.
    let repo = Repo::new();
    fs::create_dir_all(repo.p().join("old")).unwrap();
    fs::create_dir_all(repo.p().join("new")).unwrap();
    repo.write("old/base", "base\n");
    repo.write("new/keep", "keep\n");
    repo.write(".gitignore", "new/extra\n");
    repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "up"]);
    repo.git(&["mv", "old/base", "new/base"]);
    repo.git(&["commit", "-q", "-m", "move"]);
    repo.git(&["switch", "-q", "-c", "topic", "main"]);
    repo.write("old/extra", "topic\n");
    let topic = repo.commit_all("topic");
    repo.write("new/extra", "PRECIOUS\n");
    let e = ops::rebase_onto(repo.p(), "up").unwrap_err();
    assert_eq!(e.kind, "ignored-collision", "{}", e.message);
    assert!(e.details.iter().any(|d| d == "new/extra"), "{:?}", e.details);
    assert_eq!(fs::read_to_string(repo.p().join("new/extra")).unwrap(), "PRECIOUS\n");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), topic);
    assert!(!repo.p().join(".git/rebase-merge").exists() && !repo.p().join(".git/rebase-apply").exists());
}

#[test]
fn keep_merges_rebase_protects_files_a_side_branch_moves_into_a_renamed_folder() {
    // Upstream moves old/ to new/. On the topic, topic and side both change x (side conflicts
    // with topic's version), side then adds old/extra, and topic merges side. The ordered
    // preview stops at side's conflict, but --rebase-merges replays side on its own first.
    let repo = Repo::new();
    fs::create_dir_all(repo.p().join("old")).unwrap();
    fs::create_dir_all(repo.p().join("new")).unwrap();
    repo.write("old/base", "base\n");
    repo.write("new/keep", "keep\n");
    repo.write("x", "0\n");
    repo.write(".gitignore", "new/extra\n");
    let base = repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "up"]);
    repo.git(&["mv", "old/base", "new/base"]);
    repo.git(&["commit", "-q", "-m", "move"]);
    repo.git(&["switch", "-q", "-c", "topic", &base]);
    repo.write("x", "topic\n");
    repo.commit_all("topic x");
    repo.git(&["switch", "-q", "-c", "side", &base]);
    repo.write("x", "side\n");
    repo.commit_all("side x");
    repo.write("old/extra", "side\n");
    repo.commit_all("side extra");
    repo.git(&["switch", "-q", "topic"]);
    let _ = runner::run(repo.p(), ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    repo.write("x", "resolved\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "--no-edit"]);
    let topic = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.write("new/extra", "PRECIOUS\n");
    let e = ops::rebase_onto_with(repo.p(), "up", true).unwrap_err();
    assert_eq!(e.kind, "ignored-collision", "{}", e.message);
    assert_eq!(fs::read_to_string(repo.p().join("new/extra")).unwrap(), "PRECIOUS\n");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), topic);
}

#[test]
fn keep_merges_rebase_protects_files_a_recreated_merge_moves() {
    // The topic renames old/ to new/; side adds old/extra. The original merge was made without
    // directory-rename detection, so it kept old/extra. Re-creating it during the rebase (with
    // normal settings) moves old/extra to new/extra, where an ignored local file is.
    let repo = Repo::new();
    fs::create_dir_all(repo.p().join("old")).unwrap();
    fs::create_dir_all(repo.p().join("new")).unwrap();
    repo.write("old/base", "base\n");
    repo.write("new/keep", "keep\n");
    repo.write("x", "0\n");
    repo.write(".gitignore", "new/extra\n");
    let base = repo.commit_all("base");
    repo.git(&["switch", "-q", "-c", "up"]);
    repo.write("up.txt", "up\n");
    repo.commit_all("up");
    repo.git(&["switch", "-q", "-c", "topic", &base]);
    repo.write("x", "topic\n");
    repo.git(&["mv", "old/base", "new/base"]);
    repo.commit_all("topic x and rename");
    repo.git(&["switch", "-q", "-c", "side", &base]);
    repo.write("x", "side\n");
    repo.commit_all("side x");
    fs::create_dir_all(repo.p().join("old")).unwrap();
    repo.write("old/extra", "side\n");
    repo.commit_all("side extra");
    repo.git(&["switch", "-q", "topic"]);
    let _ = runner::run(repo.p(), ["-c", "merge.directoryRenames=false", "merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    repo.write("x", "resolved\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "--no-edit"]);
    assert!(repo.p().join("old/extra").exists(), "the original merge must keep old/extra");
    let topic = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.write("new/extra", "PRECIOUS\n");
    let e = ops::rebase_onto_with(repo.p(), "up", true).unwrap_err();
    assert_eq!(e.kind, "ignored-collision", "{}", e.message);
    assert_eq!(fs::read_to_string(repo.p().join("new/extra")).unwrap(), "PRECIOUS\n");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), topic);
}

#[test]
fn revert_protects_ignored_files_where_a_later_rename_moves_the_restored_file() {
    let repo = Repo::new();
    fs::create_dir_all(repo.p().join("old")).unwrap();
    repo.write(
        "old/base", "base
",
    );
    repo.write(
        "old/extra",
        "committed
",
    );
    repo.write(
        ".gitignore",
        "new/extra
",
    );
    repo.commit_all("base");
    fs::remove_file(repo.p().join("old/extra")).unwrap();
    let deletion = repo.commit_all("delete extra");
    fs::create_dir_all(repo.p().join("new")).unwrap();
    repo.git(&["mv", "old/base", "new/base"]);
    repo.git(&["commit", "-q", "-m", "move"]);
    let head = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.write(
        "new/extra",
        "PRECIOUS
",
    );
    let e = ops::revert(repo.p(), &deletion, false).unwrap_err();
    assert_eq!(e.kind, "ignored-collision", "{}", e.message);
    assert_eq!(
        fs::read_to_string(repo.p().join("new/extra")).unwrap(),
        "PRECIOUS
"
    );
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), head);
    assert!(!repo.p().join(".git/REVERT_HEAD").exists() && !repo.p().join(".git/sequencer").exists());
}

#[test]
fn revert_without_commit_protects_ignored_files_behind_a_staged_rename() {
    let repo = Repo::new();
    fs::create_dir_all(repo.p().join("old")).unwrap();
    repo.write(
        "old/base", "base
",
    );
    repo.write(
        "old/extra",
        "committed
",
    );
    repo.write(
        ".gitignore",
        "new/extra
",
    );
    repo.commit_all("base");
    fs::remove_file(repo.p().join("old/extra")).unwrap();
    let deletion = repo.commit_all("delete extra");
    repo.git(&["mv", "old", "new"]);
    let head = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    let staged = repo.git(&["diff", "--cached", "--name-status"]);
    repo.write(
        "new/extra",
        "PRECIOUS
",
    );
    let e = ops::revert(repo.p(), &deletion, true).unwrap_err();
    assert_eq!(e.kind, "ignored-collision", "{}", e.message);
    assert_eq!(
        fs::read_to_string(repo.p().join("new/extra")).unwrap(),
        "PRECIOUS
"
    );
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), head);
    assert_eq!(repo.git(&["diff", "--cached", "--name-status"]), staged, "the staged rename must stay as it was");
    assert!(!repo.p().join(".git/REVERT_HEAD").exists() && !repo.p().join(".git/sequencer").exists());
}

fn ignored_fixture() -> Repo {
    let repo = Repo::new();
    repo.write(".gitignore", "*.env\nnode_modules/\n");
    repo.write("app.txt", "1\n");
    repo.commit_all("base");
    repo.write("local.env", "PRECIOUS\n");
    repo.write("other.env", "untouched\n");
    fs::create_dir_all(repo.p().join("node_modules/pkg")).unwrap();
    repo.write("node_modules/pkg/index.js", "cache\n");
    repo
}

type Report = Option<revqora_lib::git::recovery::IgnoredReport>;

/// Runs `f` as the queued operation `reset` and returns its own ignored-file report.
fn run_op(repo: &Path, f: impl FnOnce() -> Result<(), runner::GitError>) -> (Result<(), runner::GitError>, Report) {
    use revqora_lib::git::{operations, recovery};
    let result = operations::run(repo, "reset", None, |_, _| {}, f);
    (result, recovery::take_ignored_report(repo))
}

#[test]
fn ignored_files_git_changes_unexpectedly_are_saved_reported_and_restorable() {
    use revqora_lib::git::recovery;
    let repo = ignored_fixture();
    // Stand-in for a write no guard predicted: one ignored file replaced, one deleted.
    let (result, report) = run_op(repo.p(), || {
        fs::write(repo.p().join("local.env"), "from git\n").unwrap();
        fs::remove_file(repo.p().join("other.env")).unwrap();
        Ok(())
    });
    result.unwrap();
    let report = report.expect("the change must be reported");
    assert_eq!(report.command, "reset");
    assert_eq!(report.paths, ["local.env", "other.env"]);
    assert!(recovery::take_ignored_report(repo.p()).is_none(), "a report is delivered once");
    let checkpoint = report.checkpoint.clone().expect("the ignored files must have been saved");
    // Restore uses only what is on disk (as after a restart): the checkpoint is listed in Recovery.
    assert!(recovery::list(repo.p()).unwrap().checkpoints.iter().any(|c| c.id == checkpoint));
    let saved = recovery::detail(repo.p(), &checkpoint).unwrap();
    assert!(saved.paths.iter().all(|p| !p.path.starts_with("node_modules")), "wholly ignored folders are not copied");
    let outcome = recovery::restore_files(repo.p(), &checkpoint, &report.changes).unwrap();
    assert_eq!(outcome.restored, ["local.env", "other.env"]);
    assert!(outcome.changed_since.is_empty() && outcome.failed.is_none());
    assert_eq!(fs::read_to_string(repo.p().join("local.env")).unwrap(), "PRECIOUS\n");
    assert_eq!(fs::read_to_string(repo.p().join("other.env")).unwrap(), "untouched\n");
    // An operation that leaves ignored files alone reports nothing.
    let (result, report) = run_op(repo.p(), || Ok(()));
    result.unwrap();
    assert!(report.is_none());
}

#[test]
fn restore_never_replaces_a_file_changed_after_the_operation() {
    use revqora_lib::git::recovery;
    let repo = ignored_fixture();
    let (_, report) = run_op(repo.p(), || {
        fs::write(repo.p().join("local.env"), "from git\n").unwrap();
        fs::write(repo.p().join("other.env"), "from git\n").unwrap();
        Ok(())
    });
    let report = report.unwrap();
    // The user edits one file while the dialog is open.
    repo.write("other.env", "edited later\n");
    let outcome = recovery::restore_files(repo.p(), report.checkpoint.as_deref().unwrap(), &report.changes).unwrap();
    assert_eq!(outcome.restored, ["local.env"]);
    assert_eq!(outcome.changed_since, ["other.env"]);
    assert_eq!(fs::read_to_string(repo.p().join("other.env")).unwrap(), "edited later\n");
    assert_eq!(fs::read_to_string(repo.p().join("other.env.recovered")).unwrap(), "untouched\n", "the saved copy is written beside it");
    assert_eq!(fs::read_to_string(repo.p().join("local.env")).unwrap(), "PRECIOUS\n");
}

#[test]
fn a_failed_operation_that_wrote_ignored_files_is_still_reported() {
    let repo = ignored_fixture();
    let (result, report) = run_op(repo.p(), || {
        fs::write(repo.p().join("local.env"), "half written\n").unwrap();
        Err(runner::GitError::new("git failed midway"))
    });
    assert!(result.is_err());
    let report = report.expect("a failure after a partial write must still be reported");
    assert_eq!(report.paths, ["local.env"]);
    assert!(report.checkpoint.is_some());
}

#[test]
fn each_queued_operation_keeps_its_own_report() {
    use std::sync::{Arc, Barrier};
    let repo = ignored_fixture();
    repo.write("b.env", "B\n");
    let path = Arc::new(repo.p().to_path_buf());
    let a_done = Arc::new(Barrier::new(2));
    let b_done = Arc::new(Barrier::new(2));
    let (pa, a1, b1) = (path.clone(), a_done.clone(), b_done.clone());
    // A finishes its operation, then B runs and takes its report before A takes A's.
    let a = std::thread::spawn(move || {
        let result = revqora_lib::git::operations::run(
            &pa,
            "reset",
            None,
            |_, _| {},
            || {
                fs::write(pa.join("local.env"), "A\n").unwrap();
                Ok(())
            },
        );
        a1.wait();
        b1.wait();
        (result, revqora_lib::git::recovery::take_ignored_report(&pa))
    });
    let (pb, a2, b2) = (path.clone(), a_done.clone(), b_done.clone());
    let b = std::thread::spawn(move || {
        a2.wait();
        let out = run_op(&pb, || {
            fs::write(pb.join("b.env"), "changed by B\n").unwrap();
            Ok(())
        });
        b2.wait();
        out
    });
    let (ra, report_a) = a.join().unwrap();
    let (rb, report_b) = b.join().unwrap();
    ra.unwrap();
    rb.unwrap();
    let report_a = report_a.expect("report of the first operation");
    let report_b = report_b.expect("report of the second operation");
    assert_eq!(report_a.paths, ["local.env"]);
    assert_eq!(report_b.paths, ["b.env"]);
    assert_ne!(report_a.checkpoint, report_b.checkpoint);
}

#[test]
fn ignored_files_that_cannot_be_saved_need_consent_for_that_exact_list() {
    use revqora_lib::git::recovery;
    let repo = ignored_fixture();
    // Larger than a checkpoint may hold; sparse, so the test writes almost nothing.
    fs::File::create(repo.p().join("huge.env")).unwrap().set_len(101 * 1024 * 1024).unwrap();
    let mut ran = false;
    let (result, _) = run_op(repo.p(), || {
        ran = true;
        Ok(())
    });
    let e = result.unwrap_err();
    assert_eq!(e.kind, "ignored-backup-unavailable", "{}", e.message);
    assert_eq!(e.details, ["huge.env", "local.env", "other.env"]);
    assert!(!ran, "nothing may run before the user accepts");
    // Consent for an outdated list does not apply.
    carry(recovery::accept_unprotected(repo.p(), "reset", &e.details, None));
    repo.write("new.env", "appeared\n");
    let (result, _) = run_op(repo.p(), || Ok(()));
    let again = result.unwrap_err();
    assert_eq!(again.details, ["huge.env", "local.env", "new.env", "other.env"]);
    // Consent for the current list runs it once; changes are still detected.
    carry(recovery::accept_unprotected(repo.p(), "reset", &again.details, None));
    let (result, report) = run_op(repo.p(), || {
        fs::write(repo.p().join("local.env"), "from git\n").unwrap();
        Ok(())
    });
    result.unwrap();
    let report = report.expect("changes must still be reported without a copy");
    assert_eq!(report.paths, ["local.env"]);
    assert!(report.checkpoint.is_none());
    let (result, _) = run_op(repo.p(), || Ok(()));
    assert_eq!(result.unwrap_err().kind, "ignored-backup-unavailable", "consent is used once");
}

#[cfg(unix)]
#[test]
fn restore_keeps_file_permissions() {
    use revqora_lib::git::recovery;
    use std::os::unix::fs::PermissionsExt;
    let repo = ignored_fixture();
    repo.write("run.env", "#!/bin/sh\n");
    fs::set_permissions(repo.p().join("run.env"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(repo.p().join("local.env"), fs::Permissions::from_mode(0o644)).unwrap();
    let (_, report) = run_op(repo.p(), || {
        fs::write(repo.p().join("run.env"), "x\n").unwrap();
        fs::write(repo.p().join("local.env"), "x\n").unwrap();
        Ok(())
    });
    let report = report.unwrap();
    recovery::restore_files(repo.p(), report.checkpoint.as_deref().unwrap(), &report.changes).unwrap();
    let mode = |name: &str| fs::metadata(repo.p().join(name)).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode("run.env"), 0o755);
    assert_eq!(mode("local.env"), 0o644);
    assert_eq!(fs::read_to_string(repo.p().join("run.env")).unwrap(), "#!/bin/sh\n");
}

/// main has personal ignored files; feature brings tracked files under the same names.
fn collision_fixture() -> Repo {
    let r = Repo::new();
    r.write(
        ".gitignore",
        "*.env
",
    );
    r.commit_all("base");
    r.git(&["switch", "-qc", "feature"]);
    r.write(
        "keys.env",
        "versioned keys
",
    );
    r.write(
        "settings.env",
        "versioned settings
",
    );
    r.git(&["add", "-f", "keys.env", "settings.env"]);
    r.git(&["commit", "-qm", "add configuration"]);
    r.git(&["switch", "-q", "main"]);
    r.write(
        "keys.env",
        "personal keys
",
    );
    r.write(
        "settings.env",
        "personal settings
",
    );
    r
}

fn merge_op(repo: &Path) -> (Result<(), runner::GitError>, Report) {
    use revqora_lib::git::{operations, ops, recovery};
    let result = operations::run(repo, "merge_start", None, |_, _| {}, || ops::merge_start(repo, "feature", "ff-only").map(|_| ()));
    (result, recovery::take_ignored_report(repo))
}

fn local() -> Vec<String> {
    vec!["keys.env".to_owned(), "settings.env".to_owned()]
}

#[test]
fn a_collision_lists_every_path_and_continues_only_with_the_users_decision() {
    use revqora_lib::git::recovery;
    let r = collision_fixture();
    let read = |name: &str| fs::read_to_string(r.p().join(name)).unwrap();
    let (result, _) = merge_op(r.p());
    let e = result.unwrap_err();
    assert_eq!(e.kind, "ignored-collision");
    assert_eq!(e.details, ["keys.env", "keys.env", "settings.env", "settings.env"], "all pairs, not just the first");
    // A decision for part of the list does not apply.
    carry(recovery::accept_collisions(r.p(), "merge_start", &["keys.env".to_owned()], true));
    let (result, _) = merge_op(r.p());
    assert_eq!(result.unwrap_err().kind, "ignored-collision");
    assert_eq!(
        read("settings.env"),
        "personal settings
"
    );
    // Save a copy and continue: saved before Git runs, reported, comparable, restorable on request.
    carry(recovery::accept_collisions(r.p(), "merge_start", &local(), true));
    let (result, report) = merge_op(r.p());
    result.unwrap();
    assert_eq!(
        read("settings.env"),
        "versioned settings
",
        "the copy is never applied automatically"
    );
    let report = report.expect("the overwritten files must be reported");
    assert_eq!(report.paths, local());
    let checkpoint = report.checkpoint.clone().expect("a verified copy");
    let diff = recovery::compare_saved(r.p(), &checkpoint, "settings.env").unwrap();
    assert!(!diff.hunks.is_empty());
    let outcome = recovery::restore_files(r.p(), &checkpoint, &report.changes).unwrap();
    assert_eq!(outcome.restored, local());
    assert_eq!(
        read("settings.env"),
        "personal settings
"
    );
}

#[test]
fn continuing_without_a_copy_applies_once() {
    use revqora_lib::git::recovery;
    let r = collision_fixture();
    carry(recovery::accept_collisions(r.p(), "merge_start", &local(), false));
    // The decision is consumed by the next operation even if that one finds nothing to decide.
    let (result, _) = run_op(r.p(), || Ok(()));
    result.unwrap();
    let (result, _) = merge_op(r.p());
    assert_eq!(result.unwrap_err().kind, "ignored-collision", "a decision applies to one operation");
    carry(recovery::accept_collisions(r.p(), "merge_start", &local(), false));
    let (result, _) = merge_op(r.p());
    result.unwrap();
    assert_eq!(
        fs::read_to_string(r.p().join("settings.env")).unwrap(),
        "versioned settings
"
    );
}

fn huge_fixture() -> Repo {
    let repo = ignored_fixture();
    // Larger than a checkpoint may hold; sparse, so the test writes almost nothing.
    fs::File::create(repo.p().join("huge.env")).unwrap().set_len(101 * 1024 * 1024).unwrap();
    repo
}

fn unprotected_list() -> Vec<String> {
    vec!["huge.env".to_owned(), "local.env".to_owned(), "other.env".to_owned()]
}

/// The request that runs next carries `token` (as the client's retry does).
fn carry(token: String) {
    revqora_lib::git::recovery::set_request_consent(Some(token));
}

#[test]
fn consent_never_survives_its_operation() {
    use revqora_lib::git::{operations, recovery};
    let repo = huge_fixture();
    // Rejected before it starts (stale state): the consent is gone, not kept for later.
    let token = recovery::accept_unprotected(repo.p(), "reset", &unprotected_list(), None);
    carry(token.clone());
    let stale = operations::run(repo.p(), "reset", Some("not-the-current-state"), |_, _| {}, || Ok(()));
    assert_eq!(stale.unwrap_err().kind, "stale-operation");
    carry(token);
    let (result, _) = run_op(repo.p(), || Ok(()));
    assert_eq!(result.unwrap_err().kind, "ignored-backup-unavailable", "a rejected run uses up the consent");
    // Consent for reset does not apply to another command carrying it.
    carry(recovery::accept_unprotected(repo.p(), "reset", &unprotected_list(), None));
    let other = operations::run(repo.p(), "checkout", None, |_, _| {}, || Ok(()));
    assert_eq!(other.unwrap_err().kind, "ignored-backup-unavailable");
    // A run whose backup succeeds after all also ends it.
    let token = recovery::accept_unprotected(repo.p(), "reset", &unprotected_list(), None);
    fs::remove_file(repo.p().join("huge.env")).unwrap();
    carry(token.clone());
    let (result, _) = run_op(repo.p(), || Ok(()));
    result.unwrap();
    fs::File::create(repo.p().join("huge.env")).unwrap().set_len(101 * 1024 * 1024).unwrap();
    carry(token);
    let (result, _) = run_op(repo.p(), || Ok(()));
    assert_eq!(result.unwrap_err().kind, "ignored-backup-unavailable");
}

#[test]
fn another_request_of_the_same_command_never_uses_the_consent() {
    use revqora_lib::git::recovery;
    use std::sync::{Arc, Barrier};
    let repo = huge_fixture();
    // Request A was approved; request B (same command, other target) runs first, on its own thread.
    let token = recovery::accept_unprotected(repo.p(), "reset", &unprotected_list(), None);
    let path = Arc::new(repo.p().to_path_buf());
    let done = Arc::new(Barrier::new(2));
    let (pb, db) = (path.clone(), done.clone());
    let b = std::thread::spawn(move || {
        let out = run_op(&pb, || Ok(()));
        db.wait();
        out.0
    });
    done.wait();
    assert_eq!(b.join().unwrap().unwrap_err().kind, "ignored-backup-unavailable", "B asks for its own decision");
    // A's retry still has its approval.
    carry(token);
    let (result, _) = run_op(repo.p(), || Ok(()));
    result.unwrap();
}

#[test]
fn a_panicking_operation_still_reports_and_leaves_no_watch_behind() {
    let repo = ignored_fixture();
    let other = ignored_fixture();
    // One worker thread runs both operations, like the reusable blocking pool.
    let (a, b) = (repo.p().to_path_buf(), other.p().to_path_buf());
    let (report, next) = std::thread::spawn(move || {
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_op(&a, || {
                fs::write(a.join("local.env"), "half written\n").unwrap();
                panic!("operation panicked");
            })
        }));
        assert!(panicked.is_err());
        let report = revqora_lib::git::recovery::take_ignored_report(&a);
        let next = run_op(&b, || Ok(()));
        (report, next)
    })
    .join()
    .unwrap();
    let report = report.expect("the partial write must be reported after a panic");
    assert_eq!(report.paths, ["local.env"]);
    next.0.unwrap();
    assert!(next.1.is_none(), "the next operation on the worker sees no leftover watch");
}

#[test]
fn copy_and_no_copy_decisions_stay_together_and_a_new_copy_choice_starts_clean() {
    use revqora_lib::git::recovery;
    let r = collision_fixture();
    fs::File::create(r.p().join("settings.env")).unwrap().set_len(101 * 1024 * 1024).unwrap();
    // Copy chosen; the attempt uses up its token and fails to save.
    carry(recovery::accept_collisions(r.p(), "merge_start", &local(), true));
    let (result, _) = merge_op(r.p());
    let e = result.unwrap_err();
    assert_eq!(e.kind, "ignored-backup-unavailable");
    // A no-copy consent alone, or an older one, does not carry the collision choice.
    carry(recovery::accept_unprotected(r.p(), "merge_start", &e.details, None));
    let (result, _) = merge_op(r.p());
    assert_eq!(result.unwrap_err().kind, "ignored-collision");
    let _older = recovery::accept_unprotected(r.p(), "merge_start", &e.details, None);
    carry(recovery::accept_collisions(r.p(), "merge_start", &local(), true));
    assert_eq!(merge_op(r.p()).0.unwrap_err().kind, "ignored-backup-unavailable", "a new Copy choice starts clean");
    // The client's answer repeats the same request's choice: one new token for both, and it runs.
    carry(recovery::accept_unprotected(r.p(), "merge_start", &e.details, Some((local().as_slice(), true))));
    let (result, _) = merge_op(r.p());
    result.unwrap();
}

/// main ignores `cache`; feature tracks a file named `cache`; locally `cache/` holds data.
/// Fails only if the file system refuses the local file name.
#[cfg(unix)]
fn folder_collision(name: &std::ffi::OsStr) -> std::io::Result<Repo> {
    let r = Repo::new();
    r.write(
        ".gitignore",
        "cache
",
    );
    r.commit_all("base");
    r.git(&["switch", "-qc", "feature"]);
    r.write(
        "cache", "tracked
",
    );
    r.git(&["add", "-f", "cache"]);
    r.git(&["commit", "-qm", "track cache"]);
    r.git(&["switch", "-q", "main"]);
    fs::create_dir_all(r.p().join("cache/sub")).unwrap();
    let mut path = r.p().join("cache").into_os_string();
    path.push("/");
    path.push(name);
    fs::write(std::path::PathBuf::from(path), b"PRECIOUS")?;
    Ok(r)
}

/// Accepts "save a copy" for the collision and returns the next attempt's error.
#[cfg(unix)]
fn copy_attempt(r: &Repo) -> runner::GitError {
    use revqora_lib::git::recovery;
    let e = merge_op(r.p()).0.unwrap_err();
    assert_eq!(e.kind, "ignored-collision");
    let local: Vec<String> = e.details.iter().skip(1).step_by(2).cloned().collect();
    carry(recovery::accept_collisions(r.p(), "merge_start", &local, true));
    merge_op(r.p()).0.unwrap_err()
}

#[cfg(unix)]
#[test]
fn copy_route_refuses_a_name_that_cannot_be_saved() {
    use std::os::unix::ffi::OsStrExt;
    let r = match folder_collision(std::ffi::OsStr::from_bytes(b"secret-\xff")) {
        Ok(r) => r,
        // macOS (APFS) itself rejects such names, so no such file can exist there.
        Err(e) if e.raw_os_error() == Some(92) && cfg!(target_os = "macos") => {
            eprintln!("skipped: this file system rejects non-UTF-8 names ({e})");
            return;
        }
        Err(e) => panic!("creating the fixture failed: {e}"),
    };
    let e = copy_attempt(&r);
    assert_eq!(e.kind, "ignored-backup-unavailable", "{}", e.message);
    assert_eq!(e.details, ["cache"]);
    assert!(r.p().join("cache").is_dir(), "Git did not run");
}

#[cfg(unix)]
#[test]
fn copy_route_refuses_an_unreadable_folder() {
    use std::os::unix::fs::PermissionsExt;
    let r = folder_collision(std::ffi::OsStr::new("secret")).unwrap();
    fs::set_permissions(r.p().join("cache/sub"), fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read_dir(r.p().join("cache/sub")).is_ok() {
        // Running as root: permissions do not stop reading, so there is nothing to test.
        eprintln!("skipped: permissions are not enforced for this user");
    } else {
        let e = copy_attempt(&r);
        assert_eq!(e.kind, "ignored-backup-unavailable", "{}", e.message);
        assert_eq!(e.details, ["cache"]);
        assert!(r.p().join("cache/secret").is_file(), "Git did not run");
    }
    fs::set_permissions(r.p().join("cache/sub"), fs::Permissions::from_mode(0o755)).unwrap();
}
