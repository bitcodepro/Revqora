//! End-to-end checks of the git backend against real temporary repositories.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::conflicts;
use revqora_lib::git::diff::{self, DiffOptions, SelectionMode, WorkSide};
use revqora_lib::git::graph;
use revqora_lib::git::layers;
use revqora_lib::git::ops::{self, CommitOptions, RewriteAction};
use revqora_lib::git::repo;
use revqora_lib::git::runner;
use revqora_lib::git::status;

struct Repo {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

fn pull_fixture() -> (Repo, Repo) {
    let local = Repo::new();
    local.write("base.txt", "base\n");
    local.commit_all("base");
    let remote = Repo::new();
    runner::run(remote.p(), ["fetch", local.p().to_str().unwrap(), "main"]).unwrap();
    remote.git(&["reset", "--hard", "FETCH_HEAD"]);
    local.git(&["remote", "add", "origin", remote.p().to_str().unwrap()]);
    local.git(&["fetch", "origin"]);
    local.git(&["branch", "--set-upstream-to=origin/main", "main"]);
    (local, remote)
}

#[test]
fn pull_reconciles_a_deleted_upstream_without_merging_another_branch() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (local, remote) = pull_fixture();
        remote.git(&["branch", "finished"]);
        local.git(&["fetch", "origin"]);
        local.git(&["branch", "--set-upstream-to=origin/finished", "main"]);
        let head = local.git(&["rev-parse", "HEAD"]);
        let index = fs::read(local.p().join(".git/index")).unwrap();
        local.write("base.txt", "local work stays here\n");
        remote.git(&["branch", "-D", "finished"]);
        remote.write("new.txt", "new main data\n");
        let main = remote.commit_all("advance default branch after merge");
        let out = ops::pull(local.p(), mode, |_| {}).unwrap();
        assert_eq!(out.status, "upstreamGone", "{mode}: {out:?}");
        let gone = out.upstream_gone.as_ref().unwrap();
        assert_eq!(gone.remote, "origin");
        assert_eq!(gone.reference, "refs/heads/finished");
        assert_eq!(gone.default_branch.as_deref(), Some("main"));
        assert_eq!(local.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read(local.p().join(".git/index")).unwrap(), index);
        assert_eq!(local.read("base.txt"), "local work stays here\n");
        assert!(!local.p().join("new.txt").exists());
        assert_eq!(local.git(&["rev-parse", "origin/main"]).trim(), main);
        assert!(!runner::exec(local.p(), ["show-ref", "--verify", "refs/remotes/origin/finished"]).unwrap().ok());
    }
}

#[test]
fn pull_reconciles_deleted_upstreams_in_single_branch_clones() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (_, remote) = pull_fixture();
        remote.git(&["branch", "finished"]);
        let parent = Repo::new();
        let root = parent.p().join("single-branch");
        parent.git(&["clone", "--single-branch", "-b", "finished", remote.p().to_str().unwrap(), root.to_str().unwrap()]);
        let head = runner::run(&root, ["rev-parse", "HEAD"]).unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        fs::write(root.join("base.txt"), "keep this work\n").unwrap();
        remote.git(&["branch", "-D", "finished"]);
        let out = ops::pull(&root, mode, |_| {}).unwrap();
        assert_eq!(out.status, "upstreamGone", "{mode}: {out:?}");
        assert_eq!(out.upstream_gone.unwrap().default_branch.as_deref(), Some("main"));
        assert_eq!(runner::run(&root, ["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(runner::run(&root, ["branch", "--show-current"]).unwrap().trim(), "finished");
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(fs::read_to_string(root.join("base.txt")).unwrap(), "keep this work\n");
        assert!(!runner::exec(&root, ["show-ref", "--verify", "refs/remotes/origin/finished"]).unwrap().ok());
    }
}

#[test]
fn pull_keeps_transport_errors_and_does_not_prune_an_unverified_upstream() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (local, remote) = pull_fixture();
        local.git(&["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
        local.git(&["remote", "set-url", "origin", remote.p().join("unavailable.git").to_str().unwrap()]);
        let cached = local.git(&["rev-parse", "refs/remotes/origin/main"]);
        let head = local.git(&["rev-parse", "HEAD"]);
        let error = ops::pull(local.p(), mode, |_| {}).unwrap_err();
        assert!(error.code.is_some(), "original transport exit code must remain: {error:?}");
        assert!(error.stderr.contains("unavailable.git"), "{mode}: {error:?}");
        assert_eq!(local.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(local.git(&["rev-parse", "refs/remotes/origin/main"]), cached);
    }
}

#[test]
fn pull_does_not_reconcile_a_failed_exact_fetch_after_the_upstream_config_changes() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (local, remote) = pull_fixture();
        remote.git(&["branch", "finished"]);
        local.git(&["fetch", "origin"]);
        local.git(&["branch", "--set-upstream-to=origin/finished", "main"]);
        local.git(&["config", "remote.origin.fetch", "+refs/heads/finished:refs/remotes/origin/finished"]);
        remote.git(&["branch", "-D", "finished"]);
        let mut changed = false;
        let error = ops::pull(local.p(), mode, |_| {
            if !changed {
                local.git(&["config", "branch.main.merge", "refs/heads/main"]);
                changed = true;
            }
        })
        .unwrap_err();
        assert!(changed, "fetch must emit the failure before the mutation");
        assert!(error.kind == "stale-operation" || error.stderr.contains("couldn't find remote ref"), "{mode}: {error:?}");
        assert!(
            runner::exec(local.p(), ["show-ref", "--verify", "refs/remotes/origin/finished"]).unwrap().ok(),
            "stale operation must not prune a tracking ref"
        );
        assert_eq!(local.git(&["branch", "--show-current"]).trim(), "main");
    }
}

#[test]
fn pull_rebase_only_fetches_the_validated_remote_when_fetch_all_is_enabled() {
    let (local, remote) = pull_fixture();
    let other = Repo::new();
    other.write("other.txt", "other remote\n");
    other.commit_all("other");
    local.git(&["remote", "add", "other", other.p().to_str().unwrap()]);
    local.git(&["config", "remote.other.fetch", "+refs/tags/*:refs/tags/*"]);
    local.git(&["config", "fetch.all", "true"]);
    local.git(&["tag", "private-local"]);
    let saved = local.git(&["rev-parse", "refs/tags/private-local"]);
    remote.write("new.txt", "remote update\n");
    let tip = remote.commit_all("remote update");
    let out = ops::pull(local.p(), "rebase", |_| {}).unwrap();
    assert_eq!(out.status, "done", "{out:?}");
    assert_eq!(local.git(&["rev-parse", "HEAD"]).trim(), tip);
    assert_eq!(local.git(&["rev-parse", "refs/tags/private-local"]), saved);
    assert_eq!(local.git(&["config", "fetch.all"]).trim(), "true");
}

#[test]
fn pull_does_not_mistake_an_excluded_upstream_for_a_deleted_branch() {
    let (local, remote) = pull_fixture();
    remote.git(&["branch", "other"]);
    remote.write("new.txt", "remote main update\n");
    remote.commit_all("main update");
    local.git(&["config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other"]);
    local.git(&["config", "--add", "remote.origin.fetch", "^refs/heads/main"]);
    let head = local.git(&["rev-parse", "HEAD"]);
    let error = ops::pull(local.p(), "ff-only", |_| {}).unwrap_err();
    assert_eq!(error.kind, "upstream-not-fetched", "{error:?}");
    assert_eq!(local.git(&["rev-parse", "HEAD"]), head);
    assert!(!local.p().join("new.txt").exists());
}

#[test]
fn pull_automatic_cleanup_preserves_local_tags_with_custom_fetch_settings() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (local, remote) = pull_fixture();
        remote.git(&["branch", "finished"]);
        local.git(&["fetch", "origin"]);
        local.git(&["branch", "--set-upstream-to=origin/finished", "main"]);
        local.git(&["tag", "private-local"]);
        let saved = local.git(&["rev-parse", "refs/tags/private-local"]);
        local.git(&["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
        local.git(&["config", "fetch.pruneTags", "true"]);
        local.git(&["config", "remote.origin.pruneTags", "true"]);
        ops::pull(local.p(), mode, |_| {}).unwrap();
        assert_eq!(local.git(&["rev-parse", "refs/tags/private-local"]), saved);
        remote.git(&["branch", "-D", "finished"]);
        remote.write("new.txt", "main advanced\n");
        remote.commit_all("main");
        let out = ops::pull(local.p(), mode, |_| {}).unwrap();
        assert_eq!(out.status, "upstreamGone", "{mode}: {out:?}");
        assert_eq!(local.git(&["rev-parse", "refs/tags/private-local"]), saved);
        assert!(!runner::exec(local.p(), ["show-ref", "--verify", "refs/remotes/origin/finished"]).unwrap().ok());
    }
}

#[test]
fn pull_rechecks_upstream_configuration_after_fetch() {
    for setting in ["merge", "remote"] {
        let (local, remote) = pull_fixture();
        local.git(&["remote", "add", "other", remote.p().to_str().unwrap()]);
        remote.write("new.txt", "remote update\n");
        remote.commit_all("remote");
        let before = local.git(&["rev-parse", "HEAD"]);
        let mut changed = false;
        let error = ops::pull(local.p(), "ff-only", |_| {
            if !changed {
                local.git(&["config", &format!("branch.main.{setting}"), if setting == "merge" { "refs/heads/other" } else { "other" }]);
                changed = true;
            }
        })
        .unwrap_err();
        assert!(changed);
        assert_eq!(error.kind, "stale-operation", "{error:?}");
        assert_eq!(local.git(&["rev-parse", "HEAD"]), before);
        assert!(!local.p().join("new.txt").exists());
    }
}

fn submodule_pull_fixture() -> (Repo, Repo, Repo, String, String) {
    let module = Repo::new();
    module.write("content.txt", "module A\n");
    let a = module.commit_all("module A");
    module.write("content.txt", "module B\n");
    module.write("added.txt", "remote addition\n");
    let b = module.commit_all("module B");
    let (local, remote) = pull_fixture();
    remote.git(&["-c", "protocol.file.allow=always", "submodule", "add", module.p().to_str().unwrap(), "module"]);
    runner::run(&remote.p().join("module"), ["checkout", "--detach", &a]).unwrap();
    remote.commit_all("add module at A");
    local.git(&["pull", "--ff-only"]);
    local.git(&["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    runner::run(&remote.p().join("module"), ["checkout", "--detach", &b]).unwrap();
    remote.commit_all("advance module to B");
    (local, remote, module, a, b)
}

#[test]
fn pull_recurses_into_initialized_submodules_like_native_git() {
    for setting in ["true", "yes", "on", "1"] {
        let (local, remote, _module, _, b) = submodule_pull_fixture();
        local.git(&["config", "submodule.recurse", setting]);
        // Independent control: native Git Pull on the exact same parent/module history.
        let control = Repo::new();
        control.git(&["fetch", local.p().to_str().unwrap(), "main"]);
        control.git(&["reset", "--hard", "FETCH_HEAD"]);
        control.git(&["remote", "add", "origin", remote.p().to_str().unwrap()]);
        control.git(&["fetch", "origin"]);
        control.git(&["branch", "--set-upstream-to=origin/main", "main"]);
        control.git(&["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
        control.git(&["config", "submodule.recurse", setting]);
        control.git(&["pull", "--ff-only"]);
        assert_eq!(runner::run(&control.p().join("module"), ["rev-parse", "HEAD"]).unwrap().trim(), b);
        let out = ops::pull(local.p(), "ff-only", |_| {}).unwrap();
        assert_eq!(out.status, "fastForward", "{out:?}");
        assert_eq!(runner::run(&local.p().join("module"), ["rev-parse", "HEAD"]).unwrap().trim(), b, "submodule.recurse={setting}");
        assert_eq!(local.git(&["rev-parse", "HEAD"]), remote.git(&["rev-parse", "HEAD"]));
        assert!(local.git(&["status", "--porcelain"]).trim().is_empty());
    }
}

#[test]
fn pull_preserves_dirty_submodules_and_distinguishes_preflight_from_partial_failure() {
    for path in ["content.txt", "added.txt"] {
        let (local, remote, _module, a, _) = submodule_pull_fixture();
        local.git(&["config", "submodule.recurse", "true"]);
        local.write(&format!("module/{path}"), "user changes\n");
        let parent_before = worktree_proof(local.p());
        let module_before = worktree_proof(&local.p().join("module"));
        let error = ops::pull(local.p(), "ff-only", |_| {}).unwrap_err();
        if path == "added.txt" {
            // Previously this untracked collision failed only after updating
            // the parent. Preflight now protects it before either mutation.
            assert_eq!(error.kind, "ignored-collision", "{error:?}");
            assert_eq!(worktree_proof(local.p()), parent_before);
            assert_eq!(worktree_proof(&local.p().join("module")), module_before);
        } else {
            assert_eq!(error.kind, "partial-operation", "{error:?}");
            assert_eq!(local.git(&["rev-parse", "HEAD"]), remote.git(&["rev-parse", "HEAD"]));
        }
        assert!(error.message.contains("submodule"), "{error:?}");
        assert_eq!(runner::run(&local.p().join("module"), ["rev-parse", "HEAD"]).unwrap().trim(), a);
        assert_eq!(local.read(&format!("module/{path}")), "user changes\n");
    }
}

#[test]
fn pull_keeps_disabled_recursion_and_uninitialized_modules_unchanged() {
    let (local, _remote, _module, a, _) = submodule_pull_fixture();
    local.git(&["config", "submodule.recurse", "false"]);
    ops::pull(local.p(), "ff-only", |_| {}).unwrap();
    assert_eq!(runner::run(&local.p().join("module"), ["rev-parse", "HEAD"]).unwrap().trim(), a);
    let (local, _remote, _module, _, _) = submodule_pull_fixture();
    local.git(&["submodule", "deinit", "module"]);
    local.git(&["config", "submodule.recurse", "true"]);
    ops::pull(local.p(), "ff-only", |_| {}).unwrap();
    assert!(!local.p().join("module/content.txt").exists());
}

#[test]
fn recursive_pull_prepares_a_divergent_merge_without_confirming_it() {
    let (local, _remote, _module, a, b) = submodule_pull_fixture();
    local.git(&["config", "submodule.recurse", "true"]);
    local.write("local.txt", "local commit\n");
    let before = local.commit_all("diverge");
    let out = ops::pull(local.p(), "merge", |_| {}).unwrap();
    assert_eq!(out.status, "pending", "{out:?}");
    assert_eq!(local.git(&["rev-parse", "HEAD"]).trim(), before);
    assert!(local.p().join(".git/MERGE_HEAD").exists());
    assert_eq!(runner::run(&local.p().join("module"), ["rev-parse", "HEAD"]).unwrap().trim(), b);
    assert!(local.git(&["ls-tree", "HEAD", "module"]).contains(&a));
    assert!(local.git(&["ls-files", "--stage", "module"]).contains(&b));
    ops::abort_op(local.p(), "merge").unwrap();
}

#[test]
fn invalid_submodule_recursion_fails_before_fetching_or_merging() {
    let (local, remote) = pull_fixture();
    remote.write("new.txt", "remote update\n");
    remote.commit_all("remote");
    let before = local.git(&["rev-parse", "HEAD"]);
    let fetched_before = fs::read(local.p().join(".git/FETCH_HEAD")).unwrap();
    local.git(&["config", "submodule.recurse", "invalid"]);
    assert!(ops::pull(local.p(), "ff-only", |_| {}).is_err());
    assert_eq!(local.git(&["rev-parse", "HEAD"]), before);
    assert_eq!(fs::read(local.p().join(".git/FETCH_HEAD")).unwrap(), fetched_before);
    assert!(!local.p().join("new.txt").exists());
}

#[test]
fn audit_pull_merge_waits_for_confirmation_and_ff_ignores_squash_defaults() {
    let (local, remote) = pull_fixture();
    local.write("local.txt", "local\n");
    let before = local.commit_all("local");
    remote.write("remote.txt", "remote\n");
    remote.commit_all("remote");
    local.git(&["config", "branch.main.mergeOptions", "--commit"]);
    let out = ops::pull(local.p(), "merge", |_| {}).unwrap();
    assert_eq!(out.status, "pending", "{out:?}");
    assert_eq!(local.git(&["rev-parse", "HEAD"]).trim(), before);
    assert!(local.p().join(".git/MERGE_HEAD").exists());
    ops::abort_op(local.p(), "merge").unwrap();
    local.git(&["config", "branch.main.mergeOptions", "--squash"]);
    local.git(&["reset", "--hard", "origin/main"]);
    remote.write("next.txt", "next\n");
    let target = remote.commit_all("next");
    let out = ops::pull(local.p(), "ff-only", |_| {}).unwrap();
    assert_eq!(out.status, "fastForward", "{out:?}");
    assert_eq!(local.git(&["rev-parse", "HEAD"]).trim(), target);
    assert!(local.git(&["diff", "--cached", "--name-only"]).trim().is_empty());
}

#[test]
fn audit_pull_preserves_ignored_files_and_keeps_a_missing_upstream_unmerged() {
    let (local, remote) = pull_fixture();
    local.write(".gitignore", "private.txt\n");
    local.commit_all("ignore");
    remote.write("private.txt", "remote version\n");
    remote.commit_all("tracked collision");
    local.write("private.txt", "irreplaceable ignored data\n");
    let head = local.git(&["rev-parse", "HEAD"]);
    assert!(ops::pull(local.p(), "merge", |_| {}).is_err());
    assert_eq!(local.read("private.txt"), "irreplaceable ignored data\n");
    assert_eq!(local.git(&["rev-parse", "HEAD"]), head);
    local.git(&["config", "branch.main.merge", "refs/heads/deleted"]);
    assert_eq!(ops::pull(local.p(), "ff-only", |_| {}).unwrap().status, "upstreamGone");
    assert_eq!(local.git(&["rev-parse", "HEAD"]), head);
}

#[test]
fn audit_pull_rechecks_index_flags_after_the_fetch() {
    let (local, remote) = pull_fixture();
    remote.write("new.txt", "remote\n");
    remote.commit_all("remote");
    let head = local.git(&["rev-parse", "HEAD"]);
    let mut changed = false;
    let error = ops::pull(local.p(), "ff-only", |_| {
        if !changed {
            local.git(&["update-index", "--assume-unchanged", "base.txt"]);
            changed = true;
        }
    })
    .unwrap_err();
    assert!(changed, "Fetch did not reach the controlled index-change boundary");
    assert_eq!(error.kind, "stale-operation");
    assert_eq!(local.git(&["rev-parse", "HEAD"]), head);
    assert!(!local.p().join("new.txt").exists());
    assert!(local.git(&["ls-files", "-v", "base.txt"]).starts_with('h'));
}

impl Repo {
    fn new() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo");
        fs::create_dir_all(&path).unwrap();
        runner::run(&path, ["init", "-q", "-b", "main"]).unwrap();
        runner::run(&path, ["config", "user.name", "Tester"]).unwrap();
        runner::run(&path, ["config", "user.email", "tester@example.com"]).unwrap();
        runner::run(&path, ["config", "core.autocrlf", "false"]).unwrap();
        runner::run(&path, ["config", "commit.gpgsign", "false"]).unwrap();
        Repo { _dir: dir, path }
    }
    fn p(&self) -> &Path {
        &self.path
    }
    fn write(&self, name: &str, content: &str) {
        let f = self.path.join(name);
        if let Some(parent) = f.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(f, content).unwrap();
    }
    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.path.join(name)).unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(&self.path, args).unwrap()
    }
    fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }
    fn index_blob(&self, name: &str) -> String {
        runner::run(&self.path, ["show", &format!(":{name}")]).unwrap_or_default()
    }
    fn head_blob(&self, name: &str) -> String {
        runner::run(&self.path, ["show", &format!("HEAD:{name}")]).unwrap_or_default()
    }
}

fn opts() -> DiffOptions {
    DiffOptions::default()
}

fn sha256_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["init", "-qb", "main", "--object-format=sha256"],
        vec!["config", "user.name", "Hash format test"],
        vec!["config", "user.email", "hash@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["config", "core.autocrlf", "false"],
    ] {
        runner::run(dir.path(), args).unwrap();
    }
    dir
}

#[test]
fn audit_sha256_blame_reads_lines_and_authors() {
    let r = sha256_repo();
    fs::write(r.path().join("file.txt"), "one\ntwo\n").unwrap();
    runner::run(r.path(), ["add", "file.txt"]).unwrap();
    runner::run(r.path(), ["commit", "-qm", "initial"]).unwrap();
    let head = runner::run(r.path(), ["rev-parse", "HEAD"]).unwrap().trim().to_owned();
    assert_eq!(head.len(), 64);
    let blame = revqora_lib::git::inspect::blame(r.path(), "file.txt", Some(&head)).unwrap();
    assert_eq!(blame.lines.len(), 2);
    assert_eq!(blame.lines[0].text, "one");
    assert_eq!(blame.commits[&head].author, "Hash format test");
}

#[test]
fn audit_sha256_empty_tree_is_used_for_unborn_layers_initial_commits_and_untracked_stash_files() {
    let r = sha256_repo();
    fs::write(r.path().join("file.txt"), "initial\n").unwrap();
    runner::run(r.path(), ["add", "file.txt"]).unwrap();
    layers::seal(r.path(), Some("unborn layer")).unwrap();
    let layer = layers::state(r.path()).unwrap().layers.remove(0);
    let view = diff::rev_diff(r.path(), Some(&layer.from_tree), &layer.to_tree, "file.txt", &opts()).unwrap();
    assert!(!view.hunks.is_empty());
    layers::flatten(r.path()).unwrap();
    let head = ops::commit(r.path(), "initial", &CommitOptions::default()).unwrap();
    let details = revqora_lib::git::commit::details(r.path(), &head).unwrap();
    assert_eq!(details.files[0].path, "file.txt");
    assert!(!diff::rev_diff(r.path(), None, &head, "file.txt", &opts()).unwrap().hunks.is_empty());
    fs::write(r.path().join("untracked.txt"), "stash payload\n").unwrap();
    ops::stash_save(r.path(), "untracked", true, false, &[]).unwrap();
    let contents = revqora_lib::git::more::stash_contents(r.path(), 0).unwrap();
    assert_eq!(contents.untracked[0].path, "untracked.txt");
}

fn select_lines(d: &diff::FileDiff, pred: impl Fn(&str, &str) -> bool) -> Vec<(usize, usize)> {
    let mut v = Vec::new();
    for (hi, h) in d.hunks.iter().enumerate() {
        for (li, l) in h.lines.iter().enumerate() {
            if pred(&l.kind, &l.text) {
                v.push((hi, li));
            }
        }
    }
    v
}

#[test]
fn stage_unstage_and_discard_single_lines() {
    let r = Repo::new();
    r.write("f.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    r.commit_all("init");
    r.write("f.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");

    let d = diff::working_diff(r.p(), "f.txt", WorkSide::Unstaged, None, false, &opts()).unwrap();
    assert_eq!(d.hunks.len(), 2);
    // Stage only the first change.
    let sel = select_lines(&d, |k, t| (k == "-" && t == "one") || (k == "+" && t == "ONE"));
    diff::apply_selection(r.p(), "f.txt", SelectionMode::Stage, &sel, &d.hash, None, false, &opts()).unwrap();
    assert!(r.index_blob("f.txt").starts_with("ONE\ntwo"));
    assert!(r.index_blob("f.txt").ends_with("nine\nten\n"));

    // Unstage it again by line.
    let s = diff::working_diff(r.p(), "f.txt", WorkSide::Staged, None, false, &opts()).unwrap();
    let sel = select_lines(&s, |k, _| k != " ");
    diff::apply_selection(r.p(), "f.txt", SelectionMode::Unstage, &sel, &s.hash, None, false, &opts()).unwrap();
    assert_eq!(r.index_blob("f.txt"), r.head_blob("f.txt"));

    // Discard only the last change from the working tree.
    let d = diff::working_diff(r.p(), "f.txt", WorkSide::Unstaged, None, false, &opts()).unwrap();
    let sel = select_lines(&d, |k, t| (k == "-" && t == "ten") || (k == "+" && t == "TEN"));
    diff::apply_selection(r.p(), "f.txt", SelectionMode::Discard, &sel, &d.hash, None, false, &opts()).unwrap();
    assert_eq!(r.read("f.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
}

#[test]
fn stale_selection_is_refused() {
    let r = Repo::new();
    r.write("f.txt", "a\n");
    r.commit_all("init");
    r.write("f.txt", "b\n");
    let d = diff::working_diff(r.p(), "f.txt", WorkSide::Unstaged, None, false, &opts()).unwrap();
    r.write("f.txt", "c\n");
    let err = diff::apply_selection(r.p(), "f.txt", SelectionMode::Stage, &[(0, 0), (0, 1)], &d.hash, None, false, &opts()).unwrap_err();
    assert_eq!(err.kind, "stale");
}

#[test]
fn partial_stage_of_untracked_file() {
    let r = Repo::new();
    r.write("base.txt", "x\n");
    r.commit_all("init");
    r.write("new.txt", "keep1\nskip\nkeep2\n");
    let d = diff::working_diff(r.p(), "new.txt", WorkSide::Unstaged, None, true, &opts()).unwrap();
    assert!(d.is_new);
    let sel = select_lines(&d, |k, t| k == "+" && t != "skip");
    diff::apply_selection(r.p(), "new.txt", SelectionMode::Stage, &sel, &d.hash, None, true, &opts()).unwrap();
    assert_eq!(r.index_blob("new.txt"), "keep1\nkeep2\n");
}

#[test]
fn repeated_stage_keeps_untouched_earlier_edits_and_newer_edits_win() {
    let r = Repo::new();
    let original = "color=red\nsize=10\nnote=keep\n";
    r.write("settings.txt", original);
    r.write("other.txt", "other base\n");
    let head = r.commit_all("base");
    r.write("other.txt", "unrelated edit stays unstaged\n");
    let paths = vec!["settings.txt".to_owned()];
    for current in ["color=blue\nsize=10\nnote=keep\n", "color=blue\nsize=20\nnote=keep\n", "color=green\nsize=20\nnote=keep\n"] {
        r.write("settings.txt", current);
        ops::stage_paths(r.p(), &paths).unwrap();
        assert_eq!(r.index_blob("settings.txt"), current);
        assert_eq!(r.read("settings.txt"), current);
        assert_eq!(r.head_blob("settings.txt"), original);
        assert_eq!(r.index_blob("other.txt"), "other base\n");
        assert_eq!(r.read("other.txt"), "unrelated edit stays unstaged\n");
        assert!(!layers::state(r.p()).unwrap().active, "Ordinary Stage must not seal extra versions");
    }
    assert_eq!(r.git(&["rev-parse", "HEAD"]).trim(), head);
}

#[test]
fn unstage_after_further_edits_keeps_the_latest_complete_working_file() {
    let r = Repo::new();
    let original = "color=red\nsize=10\nnote=keep\n";
    let latest = "color=green\nsize=20\nnote=keep\n";
    r.write("settings.txt", original);
    r.commit_all("base");
    let paths = vec!["settings.txt".to_owned()];
    r.write("settings.txt", "color=blue\nsize=10\nnote=keep\n");
    ops::stage_paths(r.p(), &paths).unwrap();
    r.write("settings.txt", latest);
    let before = status::status(r.p()).unwrap();
    assert_eq!((before.staged_count, before.unstaged_count), (1, 1));
    ops::unstage_paths(r.p(), &paths, None).unwrap();
    assert_eq!(r.index_blob("settings.txt"), original);
    assert_eq!(r.read("settings.txt"), latest);
    let after = status::status(r.p()).unwrap();
    assert_eq!((after.staged_count, after.unstaged_count), (0, 1));
    ops::stage_paths(r.p(), &paths).unwrap();
    assert_eq!(r.index_blob("settings.txt"), latest);
}

#[test]
fn ordinary_restage_and_unstage_preserve_explicitly_sealed_layers_and_latest_edits() {
    let r = Repo::new();
    r.write("settings.txt", "color=red\nsize=10\nnote=keep\n");
    r.commit_all("base");
    let paths = vec!["settings.txt".to_owned()];
    let sealed = "color=blue\nsize=10\nnote=keep\n";
    r.write("settings.txt", sealed);
    ops::stage_paths(r.p(), &paths).unwrap();
    layers::seal(r.p(), Some("First logical change")).unwrap();
    let base = layers::staged_base(r.p()).unwrap();
    let latest = "color=green\nsize=20\nnote=keep\n";
    r.write("settings.txt", "color=blue\nsize=20\nnote=keep\n");
    ops::stage_paths(r.p(), &paths).unwrap();
    r.write("settings.txt", latest);
    ops::stage_paths(r.p(), &paths).unwrap();
    assert_eq!(r.index_blob("settings.txt"), latest);
    assert_eq!(layers::state(r.p()).unwrap().layers.len(), 1);
    ops::unstage_paths(r.p(), &paths, Some(&base)).unwrap();
    assert_eq!(r.read("settings.txt"), latest);
    assert_eq!(r.index_blob("settings.txt"), sealed);
    let state = layers::state(r.p()).unwrap();
    assert_eq!(state.layers.len(), 1);
    assert_eq!(state.layers[0].name, "First logical change");
    assert!(state.open_files.is_empty());
}

#[test]
fn status_reports_staged_unstaged_untracked() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit_all("init");
    r.write("a.txt", "a2\n");
    r.git(&["add", "a.txt"]);
    r.write("b.txt", "b2\n");
    r.write("c.txt", "c\n");
    let s = status::status(r.p()).unwrap();
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!((s.staged_count, s.unstaged_count, s.conflict_count), (1, 2, 0));
}

#[test]
fn stage_layers_unstage_bottom_layer_keeps_top() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit_all("init");

    r.write("a.txt", "a changed\n");
    ops::stage_paths(r.p(), &["a.txt".into()]).unwrap();
    layers::seal(r.p(), Some("first")).unwrap();

    r.write("b.txt", "b changed\n");
    ops::stage_paths(r.p(), &["b.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    let st = layers::state(r.p()).unwrap();
    assert!(st.active);
    assert_eq!(st.layers.len(), 2);
    assert_eq!(st.layers[0].name, "first");
    assert_eq!(st.layers[0].files[0].path, "a.txt");
    assert_eq!(st.layers[1].files[0].path, "b.txt");
    assert!(st.open_files.is_empty());

    // Unstage the first layer: only b stays staged; the working tree keeps both changes.
    layers::unstage(r.p(), 0, &Default::default()).unwrap();
    assert_eq!(r.index_blob("a.txt"), "a\n");
    assert_eq!(r.index_blob("b.txt"), "b changed\n");
    assert_eq!(r.read("a.txt"), "a changed\n");
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    assert_eq!(st.layers[0].files[0].path, "b.txt");

    // Discard the remaining layer: removed from index and working tree.
    layers::discard(r.p(), 0).unwrap();
    assert_eq!(r.index_blob("b.txt"), "b\n");
    assert_eq!(r.read("b.txt"), "b\n");
    assert!(!layers::state(r.p()).unwrap().active);
}

#[test]
fn stage_layers_open_layer_and_dependent_conflict() {
    let r = Repo::new();
    r.write("f.txt", "v1\n");
    r.commit_all("init");

    r.write("f.txt", "v2\n");
    ops::stage_paths(r.p(), &["f.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    // Second change of the same line, staged in the open layer.
    r.write("f.txt", "v3\n");
    ops::stage_paths(r.p(), &["f.txt".into()]).unwrap();
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    assert_eq!(st.open_files.len(), 1);

    // Diff of the open layer is computed against the top layer.
    let base = layers::staged_base(r.p());
    let d = diff::working_diff(r.p(), "f.txt", WorkSide::Staged, base.as_deref(), false, &opts()).unwrap();
    assert!(d.hunks[0].lines.iter().any(|l| l.kind == "-" && l.text == "v2"));

    // Removing layer 1 conflicts with the open layer that edits the same line.
    let err = layers::unstage(r.p(), 0, &Default::default()).unwrap_err();
    assert_eq!(err.kind, "layer-conflict");
    assert_eq!(err.details, vec!["f.txt".to_string()]);
    // Nothing changed.
    assert_eq!(r.index_blob("f.txt"), "v3\n");

    // Unstaging the open layer returns the index to layer 1.
    layers::unstage(r.p(), 1, &Default::default()).unwrap();
    assert_eq!(r.index_blob("f.txt"), "v2\n");
}

#[test]
fn stage_layers_commit_top_layer_alone() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit_all("init");
    r.write("a.txt", "A\n");
    ops::stage_paths(r.p(), &["a.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();
    r.write("b.txt", "B\n");
    ops::stage_paths(r.p(), &["b.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    layers::commit_layer(r.p(), 1, "only b", &CommitOptions::default(), &Default::default()).unwrap();
    assert_eq!(r.head_blob("b.txt"), "B\n");
    assert_eq!(r.head_blob("a.txt"), "a\n");
    // a stays staged in the remaining layer.
    assert_eq!(r.index_blob("a.txt"), "A\n");
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    assert_eq!(st.layers[0].files[0].path, "a.txt");

    // A normal commit of everything clears the layers.
    ops::commit(r.p(), "rest", &CommitOptions::default()).unwrap();
    assert!(!layers::state(r.p()).unwrap().active);
}

#[test]
fn stage_layers_unstage_file_from_layer_and_merge_down() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.write("c.txt", "c\n");
    r.commit_all("init");
    r.write("a.txt", "A\n");
    r.write("b.txt", "B\n");
    ops::stage_paths(r.p(), &["a.txt".into(), "b.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();
    r.write("c.txt", "C\n");
    ops::stage_paths(r.p(), &["c.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    layers::unstage_files(r.p(), 0, &["b.txt".into()]).unwrap();
    assert_eq!(r.index_blob("b.txt"), "b\n");
    assert_eq!(r.index_blob("a.txt"), "A\n");
    assert_eq!(r.index_blob("c.txt"), "C\n");

    layers::merge_down(r.p(), 1).unwrap();
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    assert_eq!(st.layers[0].files.len(), 2);
}

fn conflict_setup(r: &Repo) {
    r.write("f.txt", "line1\nshared\nline3\n");
    r.commit_all("base");
    r.git(&["switch", "-q", "-c", "feature"]);
    r.write("f.txt", "line1\nfeature side\nline3\n");
    r.write("feature-only.txt", "feature\n");
    r.commit_all("feature change");
    r.git(&["switch", "-q", "main"]);
    r.write("f.txt", "line1\nmain side\nline3\n");
    r.commit_all("main change");
}

#[test]
fn merge_with_conflicts_resolve_and_confirm() {
    let r = Repo::new();
    conflict_setup(&r);
    let head_before = r.git(&["rev-parse", "HEAD"]);

    let out = ops::merge_start(r.p(), "feature", "no-ff").unwrap();
    assert_eq!(out.status, "conflicts");
    assert_eq!(out.conflicts, vec!["f.txt".to_string()]);
    // No commit was created yet.
    assert_eq!(r.git(&["rev-parse", "HEAD"]), head_before);
    let info = repo::info(r.p()).unwrap();
    assert_eq!(info.state.kind, "merge");
    assert_eq!(info.state.incoming_label.as_deref(), Some("feature"));

    let c = conflicts::info(r.p(), "f.txt").unwrap();
    assert_eq!(c.code, "UU");
    assert_eq!(c.conflict_count, 1);
    assert!(c.merged.contains("<<<<<<< ours\nmain side\n"));
    assert!(c.merged.contains(">>>>>>> theirs"));
    assert!(c.working_has_markers);

    // Confirm is refused while conflicts remain.
    assert!(ops::continue_op(r.p(), "merge", None).is_err());

    conflicts::save_resolution(r.p(), "f.txt", "line1\nmain side\nfeature side\nline3\n", true).unwrap();
    let done = ops::continue_op(r.p(), "merge", None).unwrap();
    assert_eq!(done.status, "done");
    let parents = r.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 3);
    assert_eq!(r.head_blob("f.txt"), "line1\nmain side\nfeature side\nline3\n");
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "none");
}

#[test]
fn merge_abort_restores_everything() {
    let r = Repo::new();
    conflict_setup(&r);
    let head_before = r.git(&["rev-parse", "HEAD"]);
    ops::merge_start(r.p(), "feature", "no-ff").unwrap();
    ops::abort_op(r.p(), "merge").unwrap();
    assert_eq!(r.git(&["rev-parse", "HEAD"]), head_before);
    assert_eq!(r.read("f.txt"), "line1\nmain side\nline3\n");
    assert!(!r.p().join("feature-only.txt").exists());
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "none");
}

#[test]
fn clean_merge_waits_for_confirmation() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit_all("base");
    r.git(&["switch", "-q", "-c", "feature"]);
    r.write("b.txt", "b\n");
    r.commit_all("feature");
    r.git(&["switch", "-q", "main"]);
    r.write("c.txt", "c\n");
    r.commit_all("main");
    let before = r.git(&["rev-parse", "HEAD"]);
    let out = ops::merge_start(r.p(), "feature", "no-ff").unwrap();
    assert_eq!(out.status, "pending");
    assert_eq!(r.git(&["rev-parse", "HEAD"]), before);
    let s = status::status(r.p()).unwrap();
    assert!(s.files.iter().any(|f| f.path == "b.txt" && f.index == "A"));
    ops::continue_op(r.p(), "merge", Some("Merge feature (reviewed)")).unwrap();
    assert_eq!(r.git(&["log", "-1", "--format=%s"]).trim(), "Merge feature (reviewed)");
}

#[test]
fn squash_merge_and_take_side() {
    let r = Repo::new();
    conflict_setup(&r);
    let out = ops::merge_start(r.p(), "feature", "squash").unwrap();
    assert_eq!(out.status, "conflicts");
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "squash");
    conflicts::take_side(r.p(), "f.txt", "theirs").unwrap();
    assert_eq!(r.read("f.txt"), "line1\nfeature side\nline3\n");
    ops::continue_op(r.p(), "squash", Some("Squash feature")).unwrap();
    let parents = r.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 2);
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "none");
}

#[test]
fn explicit_merge_modes_override_branch_merge_options_without_implicit_commits() {
    for (mode, configured) in [("ff-only", "--squash"), ("ff", "--squash"), ("no-ff", "--squash"), ("squash", "--no-squash --commit")] {
        let r = Repo::new();
        r.write("base.txt", "base\n");
        let before = r.commit_all("base");
        r.git(&["switch", "-qc", "feature"]);
        r.write("feature.txt", "feature\n");
        let target = r.commit_all("feature");
        r.git(&["switch", "-q", "main"]);
        r.git(&["config", "branch.main.mergeOptions", configured]);
        let out = ops::merge_start(r.p(), "feature", mode).unwrap();
        if matches!(mode, "ff" | "ff-only") {
            assert_eq!(out.status, "fastForward", "{mode} with {configured}: {out:?}");
            assert_eq!(r.git(&["rev-parse", "HEAD"]).trim(), target);
            assert!(status::status(r.p()).unwrap().files.is_empty());
        } else {
            assert_eq!(out.status, "pending", "{mode} with {configured}: {out:?}");
            assert_eq!(r.git(&["rev-parse", "HEAD"]).trim(), before);
            assert_eq!(repo::info(r.p()).unwrap().state.kind, if mode == "squash" { "squash" } else { "merge" });
            ops::continue_op(r.p(), if mode == "squash" { "squash" } else { "merge" }, Some("Explicit confirmation")).unwrap();
            assert_eq!(r.head_blob("feature.txt"), "feature\n");
        }
    }
}

#[test]
fn checkout_branch_creation_and_merge_preserve_colliding_ignored_files() {
    for action in ["checkout", "remote", "remote-new", "detach", "branch", "merge"] {
        let r = Repo::new();
        r.write(".gitignore", "settings.local\n");
        let base = r.commit_all("base");
        r.git(&["switch", "-qc", "feature"]);
        r.write("settings.local", "versioned defaults\n");
        r.git(&["add", "-f", "settings.local"]);
        r.git(&["commit", "-qm", "version settings"]);
        let target = r.git(&["rev-parse", "HEAD"]).trim().to_owned();
        r.git(&["remote", "add", "origin", "."]);
        r.git(&["update-ref", "refs/remotes/origin/feature", &target]);
        r.git(&["switch", "-q", "main"]);
        if action == "remote-new" {
            r.git(&["branch", "-D", "feature"]);
        }
        r.write("settings.local", "personal ignored data\n");
        let result = match action {
            "checkout" => ops::checkout(r.p(), "feature", "local").map(|_| ()),
            "remote" | "remote-new" => ops::checkout(r.p(), "origin/feature", "remote").map(|_| ()),
            "detach" => ops::checkout(r.p(), &target, "commit").map(|_| ()),
            "branch" => ops::create_branch(r.p(), "new-topic", Some("feature"), true),
            _ => ops::merge_start(r.p(), "feature", "no-ff").map(|_| ()),
        };
        assert!(result.is_err(), "{action} accepted the ignored collision: {result:?}; file={:?}", r.read("settings.local"));
        assert!(format!("{result:?}").contains("settings.local"), "{action} failed for an unrelated reason: {result:?}");
        assert_eq!(r.read("settings.local"), "personal ignored data\n", "{action}");
        assert_eq!(r.git(&["rev-parse", "HEAD"]).trim(), base, "{action}");
        assert_eq!(r.git(&["branch", "--show-current"]).trim(), "main");
        assert!(r.git(&["diff", "--cached", "--name-only"]).is_empty());
        assert!(!runner::exec(r.p(), ["show-ref", "--verify", "--quiet", "refs/heads/new-topic"]).unwrap().ok());
        if action == "remote-new" {
            assert!(!runner::exec(r.p(), ["show-ref", "--verify", "--quiet", "refs/heads/feature"]).unwrap().ok());
        }
    }
}

#[test]
fn rebase_pull_blocks_local_add_remove_replay_before_losing_recreated_files() {
    for ignored_at_head in [true, false] {
        let (local, remote) = pull_fixture();
        if ignored_at_head {
            local.write(".gitignore", "private.env\n");
            local.commit_all("ignore local settings");
        }
        local.write("private.env", "temporarily versioned\n");
        local.git(&["add", "-f", "private.env"]);
        local.commit_all("add private settings");
        local.git(&["rm", "private.env"]);
        local.commit_all("remove private settings");
        remote.write(".gitignore", "private.env\n");
        remote.write("remote.txt", "unrelated upstream change\n");
        remote.commit_all("advance upstream");
        local.write("private.env", "unique local data must survive\n");
        local.write("base.txt", "dirty tracked work must survive\n");
        let head = local.git(&["rev-parse", "HEAD"]);
        let index = fs::read(local.p().join(".git/index")).unwrap();
        let error = ops::pull(local.p(), "rebase", |_| {}).unwrap_err();
        assert_eq!(error.kind, "ignored-collision", "ignored_at_head={ignored_at_head}: {error:?}");
        assert_eq!(error.details[1], "private.env");
        assert_eq!(local.read("private.env"), "unique local data must survive\n");
        assert_eq!(local.read("base.txt"), "dirty tracked work must survive\n");
        assert_eq!(local.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read(local.p().join(".git/index")).unwrap(), index);
        assert!(local.git(&["stash", "list"]).is_empty());
        assert!(!local.p().join(".git/rebase-merge").exists());
        assert!(!local.p().join(".git/rebase-apply").exists());
    }
}

fn configure_module_fixture_line_endings(root: &Path) {
    // A clone has its own config: neither its parent nor its origin's policy
    // applies to a later Pull executed by the application.
    runner::run(root, ["config", "--local", "core.autocrlf", "false"]).unwrap();
    assert_eq!(runner::run(root, ["config", "--local", "--get", "core.autocrlf"]).unwrap().trim(), "false", "fixture policy at {}", root.display());
}

fn ignored_module_pull_fixture(nested: bool) -> (Repo, Repo, Repo, Option<Repo>, String) {
    let leaf = Repo::new();
    leaf.write(".gitignore", "private.env\nscratch.env\nbin/\n");
    leaf.write("content.txt", "module A\n");
    let a = leaf.commit_all("module A");
    leaf.write("private.env", "remote defaults\n");
    leaf.write("content.txt", "module B\n");
    leaf.git(&["add", "-f", "private.env"]);
    let b = leaf.commit_all("module B");
    let mut outer = None;
    let (source, old, new, path) = if nested {
        let module = Repo::new();
        module.write("outer.txt", "outer\n");
        module.commit_all("outer base");
        module.git(&["-c", "protocol.file.allow=always", "-c", "core.autocrlf=false", "submodule", "add", leaf.p().to_str().unwrap(), "inner module"]);
        configure_module_fixture_line_endings(&module.p().join("inner module"));
        runner::run(&module.p().join("inner module"), ["checkout", "--detach", &a]).unwrap();
        let old = module.commit_all("nested A");
        runner::run(&module.p().join("inner module"), ["checkout", "--detach", &b]).unwrap();
        let new = module.commit_all("nested B");
        let source = module.p().to_owned();
        outer = Some(module);
        (source, old, new, "outer module")
    } else {
        (leaf.p().to_owned(), a, b, "module")
    };
    let (local, remote) = pull_fixture();
    remote.git(&["-c", "protocol.file.allow=always", "-c", "core.autocrlf=false", "submodule", "add", source.to_str().unwrap(), path]);
    configure_module_fixture_line_endings(&remote.p().join(path));
    runner::run(&remote.p().join(path), ["checkout", "--detach", &old]).unwrap();
    remote.commit_all("add module A");
    local.git(&["pull", "--ff-only"]);
    // The command override covers initial checkout in every clone; persist the
    // same policy in each initialized repo before invoking the actual Pull.
    local.git(&["-c", "protocol.file.allow=always", "-c", "core.autocrlf=false", "submodule", "update", "--init", "--recursive"]);
    configure_module_fixture_line_endings(&local.p().join(path));
    if nested {
        configure_module_fixture_line_endings(&local.p().join(path).join("inner module"));
    }
    runner::run(&remote.p().join(path), ["checkout", "--detach", &new]).unwrap();
    remote.commit_all("advance module B");
    local.git(&["config", "submodule.recurse", "true"]);
    (local, remote, leaf, outer, if nested { "outer module/inner module" } else { "module" }.into())
}

fn worktree_proof(root: &Path) -> (String, Vec<u8>) {
    let index = repo::git_dir(root).unwrap().join("index");
    (runner::run(root, ["rev-parse", "HEAD"]).unwrap(), fs::read(index).unwrap())
}

#[test]
fn recursive_pull_blocks_ignored_collisions_in_direct_and_nested_modules_before_parent_mutation() {
    for nested in [false, true] {
        let (local, _remote, _leaf, _outer, path) = ignored_module_pull_fixture(nested);
        local.write(&format!("{path}/private.env"), "unique module settings\n");
        let module = local.p().join(&path);
        let parent_before = worktree_proof(local.p());
        let module_before = worktree_proof(&module);
        let outer_before = nested.then(|| worktree_proof(&local.p().join("outer module")));
        for mode in ["ff-only", "merge", "rebase"] {
            let error = ops::pull(local.p(), mode, |_| {}).unwrap_err();
            assert_eq!(error.kind, "ignored-collision", "{mode}, nested={nested}: {error:?}");
            assert_eq!(error.details[1], format!("{path}/private.env"));
            assert_eq!(local.read(&format!("{path}/private.env")), "unique module settings\n");
            assert_eq!(worktree_proof(local.p()), parent_before, "{mode}: parent changed");
            assert_eq!(worktree_proof(&module), module_before, "{mode}: child changed");
            if let Some(proof) = &outer_before {
                assert_eq!(&worktree_proof(&local.p().join("outer module")), proof);
            }
            assert!(local.git(&["stash", "list"]).is_empty());
        }
    }
}

#[test]
fn recursive_pull_allows_unrelated_ignored_module_build_output() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (local, _remote, _leaf, _outer, path) = ignored_module_pull_fixture(false);
        local.write(&format!("{path}/bin/local.dll"), "keep build output\n");
        if mode == "rebase" {
            local.write("topic.txt", "local topic\n");
            local.commit_all("local topic");
        }
        let result = ops::pull(local.p(), mode, |_| {}).unwrap();
        assert!(matches!(result.status.as_str(), "done" | "fastForward"), "{mode}: {result:?}");
        assert_eq!(local.read(&format!("{path}/private.env")), "remote defaults\n");
        assert_eq!(local.read(&format!("{path}/bin/local.dll")), "keep build output\n");
        if mode == "rebase" {
            assert_eq!(local.read("topic.txt"), "local topic\n");
        }
        assert!(local.git(&["status", "--porcelain"]).is_empty());
    }
}

#[test]
fn recursive_rebase_blocks_child_local_add_remove_replay() {
    let (local, _remote, _leaf, _outer, path) = ignored_module_pull_fixture(false);
    let child = local.p().join(&path);
    for (key, value) in [("user.name", "Fixture"), ("user.email", "fixture@example.invalid"), ("commit.gpgsign", "false")] {
        runner::run(&child, ["config", key, value]).unwrap();
    }
    local.write(&format!("{path}/scratch.env"), "temporarily versioned\n");
    runner::run(&child, ["add", "-f", "scratch.env"]).unwrap();
    runner::run(&child, ["commit", "-qm", "add settings"]).unwrap();
    runner::run(&child, ["rm", "scratch.env"]).unwrap();
    runner::run(&child, ["commit", "-qm", "remove settings"]).unwrap();
    local.write(&format!("{path}/scratch.env"), "unique recreated settings\n");
    let parent = worktree_proof(local.p());
    let module = worktree_proof(&child);
    let error = ops::pull(local.p(), "rebase", |_| {}).unwrap_err();
    assert_eq!(error.kind, "ignored-collision", "{error:?}");
    assert_eq!(error.details[1], format!("{path}/scratch.env"));
    assert_eq!(worktree_proof(local.p()), parent);
    assert_eq!(worktree_proof(&child), module);
    assert_eq!(local.read(&format!("{path}/scratch.env")), "unique recreated settings\n");
}

#[test]
fn recursive_pull_stops_before_parent_mutation_when_module_target_cannot_be_inspected() {
    let (local, remote, _leaf, _outer, path) = ignored_module_pull_fixture(false);
    let missing = "1111111111111111111111111111111111111111";
    remote.git(&["update-index", "--cacheinfo", "160000", missing, &path]);
    remote.git(&["commit", "-qm", "unavailable module target"]);
    // Force the inspection, rather than having Fetch itself reject the missing
    // module object. The parent must still not be integrated first.
    local.git(&["config", "fetch.recurseSubmodules", "false"]);
    let parent = worktree_proof(local.p());
    let child = worktree_proof(&local.p().join(&path));
    let error = ops::pull(local.p(), "ff-only", |_| {}).unwrap_err();
    assert!(error.message.contains("submodule"), "{error:?}");
    assert_eq!(worktree_proof(local.p()), parent);
    assert_eq!(worktree_proof(&local.p().join(&path)), child);
}

#[test]
fn recursive_pull_does_not_remove_a_module_containing_ignored_local_data() {
    let (local, remote, _leaf, _outer, path) = ignored_module_pull_fixture(false);
    remote.git(&["rm", "-f", &path]);
    remote.commit_all("remove module");
    local.write(&format!("{path}/private.env"), "keep removed-module settings\n");
    let parent = worktree_proof(local.p());
    let module = worktree_proof(&local.p().join(&path));
    let error = ops::pull(local.p(), "ff-only", |_| {}).unwrap_err();
    assert_eq!(error.kind, "ignored-collision", "{error:?}");
    assert_eq!(worktree_proof(local.p()), parent);
    assert_eq!(worktree_proof(&local.p().join(&path)), module);
    assert_eq!(local.read(&format!("{path}/private.env")), "keep removed-module settings\n");
}

#[test]
fn rebase_pull_preserves_ignored_collisions_before_fast_forward_or_replay() {
    for divergent in [false, true] {
        let (local, remote) = pull_fixture();
        local.write(".gitignore", "personal.local\n");
        local.commit_all("ignore personal settings");
        remote.git(&["fetch", local.p().to_str().unwrap(), "main"]);
        remote.git(&["reset", "--hard", "FETCH_HEAD"]);
        remote.write("personal.local", "remote defaults\n");
        remote.git(&["add", "-f", "personal.local"]);
        remote.commit_all("publish defaults");
        if divergent {
            local.write("topic.txt", "local commit\n");
            local.commit_all("local work");
        }
        local.write("personal.local", "irreplaceable ignored bytes\n");
        local.write("base.txt", "uncommitted tracked work\n");
        let head = local.git(&["rev-parse", "HEAD"]);
        let index = fs::read(local.p().join(".git/index")).unwrap();
        let error = ops::pull(local.p(), "rebase", |_| {}).unwrap_err();
        assert_eq!(error.kind, "ignored-collision", "divergent={divergent}: {error:?}");
        assert_eq!(local.read("personal.local"), "irreplaceable ignored bytes\n");
        assert_eq!(local.read("base.txt"), "uncommitted tracked work\n");
        assert_eq!(local.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read(local.p().join(".git/index")).unwrap(), index);
        assert!(local.git(&["stash", "list"]).is_empty());
        assert!(!local.p().join(".git/rebase-merge").exists());
    }
}

#[test]
fn rebase_pull_preserves_the_pre_fetch_fork_point_and_dirty_work() {
    for rewritten in [false, true] {
        let (local, remote) = pull_fixture();
        let base = remote.git(&["rev-parse", "HEAD"]);
        remote.write("old-upstream.txt", "old upstream work\n");
        remote.commit_all("old upstream");
        local.git(&["pull", "--ff-only"]);
        local.write("topic.txt", "local work\n");
        local.commit_all("local topic");
        if rewritten {
            remote.git(&["reset", "--hard", base.trim()]);
        }
        remote.write("new-upstream.txt", "new upstream work\n");
        let target = remote.commit_all("new upstream");
        local.write("base.txt", "dirty tracked work\n");
        let outcome = ops::pull(local.p(), "rebase", |_| {}).unwrap();
        assert_eq!(outcome.status, "done", "{outcome:?}");
        assert_eq!(local.git(&["rev-parse", "HEAD^"]).trim(), target);
        assert_eq!(local.git(&["log", "-1", "--format=%s"]).trim(), "local topic");
        assert_eq!(local.read("base.txt"), "dirty tracked work\n");
        assert_eq!(local.read("topic.txt"), "local work\n");
        assert_eq!(local.p().join("old-upstream.txt").exists(), !rewritten);
        assert!(local.git(&["stash", "list"]).is_empty());
    }
}

#[test]
fn rebase_pull_updates_recursive_submodules_without_dropping_local_parent_commits() {
    for divergent in [false, true] {
        let (local, _remote, _module, _a, b) = submodule_pull_fixture();
        local.git(&["config", "submodule.recurse", "true"]);
        if divergent {
            local.write("topic.txt", "local work\n");
            local.commit_all("local topic");
        }
        let outcome = ops::pull(local.p(), "rebase", |_| {}).unwrap();
        assert!(matches!(outcome.status.as_str(), "done" | "fastForward"), "{outcome:?}");
        assert_eq!(runner::run(&local.p().join("module"), ["rev-parse", "HEAD"]).unwrap().trim(), b);
        assert!(local.git(&["status", "--porcelain"]).is_empty());
        if divergent {
            assert_eq!(local.read("topic.txt"), "local work\n");
        }
    }
}

#[cfg(unix)]
#[test]
fn merge_rejects_undecodable_ignored_or_incoming_names_without_mutating_data() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    for ignored_name in [false, true] {
        let r = Repo::new();
        let name = OsString::from_vec(b"private-\xff.bin".to_vec());
        r.write(".gitignore", "private-*.bin\nother.ignored\n");
        r.commit_all("base");
        r.git(&["switch", "-qc", "incoming"]);
        if let Err(error) = fs::write(r.p().join(&name), b"remote defaults") {
            #[cfg(target_os = "macos")]
            if error.raw_os_error() == Some(92) {
                eprintln!("Filesystem rejects invalid UTF-8 names (EILSEQ); skipping this filesystem fixture. The cross-platform strict-decoder regression still runs.");
                return;
            }
            panic!("Cannot create raw-name fixture: {error}");
        }
        r.git(&["add", "-f", "-A"]);
        r.commit_all("incoming raw name");
        r.git(&["switch", "-q", "main"]);
        r.write("local.txt", "diverge\n");
        r.commit_all("local work");
        if ignored_name {
            fs::write(r.p().join(&name), b"irreplaceable local bytes").unwrap();
        }
        r.write("other.ignored", "keep ignored sibling\n");
        let head = r.git(&["rev-parse", "HEAD"]);
        let index = fs::read(r.p().join(".git/index")).unwrap();
        let error = ops::merge_start(r.p(), "incoming", "no-ff").unwrap_err();
        assert_eq!(error.kind, "unsupported-path-encoding", "{error:?}");
        if ignored_name {
            assert_eq!(fs::read(r.p().join(&name)).unwrap(), b"irreplaceable local bytes");
        } else {
            assert!(!r.p().join(&name).exists());
        }
        assert_eq!(r.read("other.ignored"), "keep ignored sibling\n");
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read(r.p().join(".git/index")).unwrap(), index);
        assert!(!r.p().join(".git/MERGE_HEAD").exists());
    }
}

#[test]
fn pull_allows_new_source_files_beside_collapsed_ignored_build_outputs() {
    for mode in ["ff-only", "merge", "rebase"] {
        let (local, remote) = pull_fixture();
        local.write(".gitignore", "bin/\nobj/\n");
        let base = local.commit_all("ignore build outputs");
        remote.git(&["fetch", local.p().to_str().unwrap(), "main"]);
        remote.git(&["reset", "--hard", "FETCH_HEAD"]);
        let project = "tests/WindowsIntegration";
        remote.write(&format!("{project}/BackgroundRuntimeCheck.cs"), "// new source\n");
        let target = remote.commit_all("add integration project");
        local.write(&format!("{project}/bin/Debug/app.dll"), "keep build output\n");
        local.write(&format!("{project}/obj/project.assets.json"), "keep build assets\n");
        local.git(&["config", "core.ignorecase", "true"]);
        let ignored = runner::run(local.p(), ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).unwrap();
        assert!(ignored.split('\0').any(|path| path == format!("{project}/")), "fixture must reproduce collapsed parent: {ignored:?}");
        assert_eq!(local.git(&["rev-parse", "HEAD"]).trim(), base);
        let result = ops::pull(local.p(), mode, |_| {}).unwrap();
        assert!(matches!(result.status.as_str(), "done" | "fastForward"), "{mode}: {result:?}");
        assert_eq!(local.git(&["rev-parse", "HEAD"]).trim(), target, "{mode}");
        assert_eq!(local.read(&format!("{project}/BackgroundRuntimeCheck.cs")), "// new source\n");
        assert_eq!(local.read(&format!("{project}/bin/Debug/app.dll")), "keep build output\n");
        assert_eq!(local.read(&format!("{project}/obj/project.assets.json")), "keep build assets\n");
        assert!(local.git(&["status", "--porcelain"]).is_empty());
    }
}

#[test]
fn merge_preserves_ignored_files_obstructing_an_incoming_parent() {
    let r = Repo::new();
    r.write(".gitignore", "local/\n");
    let base = r.commit_all("base");
    r.git(&["switch", "-qc", "feature"]);
    r.write("local/settings/config.json", "versioned configuration\n");
    r.git(&["add", "-f", "local/settings/config.json"]);
    r.git(&["commit", "-qm", "add configuration"]);
    r.git(&["switch", "-q", "main"]);
    r.write("local/settings", "personal ignored file\n");
    let index = fs::read(r.p().join(".git/index")).unwrap();
    let error = ops::merge_start(r.p(), "feature", "ff-only").unwrap_err();
    assert_eq!(error.kind, "ignored-collision");
    assert_eq!(error.details, ["local/settings/config.json", "local/settings"]);
    assert_eq!(r.read("local/settings"), "personal ignored file\n");
    assert_eq!(r.git(&["rev-parse", "HEAD"]).trim(), base);
    assert_eq!(fs::read(r.p().join(".git/index")).unwrap(), index);
}

#[test]
fn merge_checks_ignored_directory_collisions_but_allows_unrelated_cache_folders() {
    let r = Repo::new();
    r.write(".gitignore", "cache/\n");
    let base = r.commit_all("base");
    r.git(&["switch", "-qc", "feature"]);
    r.write("cache", "a versioned file replaces the folder\n");
    r.commit_all("file at cache path");
    r.git(&["switch", "-q", "main"]);
    r.write("cache/personal.txt", "keep ignored directory contents\n");
    let error = ops::merge_start(r.p(), "feature", "no-ff").unwrap_err();
    assert!(error.message.contains("ignored data at cache"));
    assert_eq!(r.read("cache/personal.txt"), "keep ignored directory contents\n");
    assert_eq!(r.git(&["rev-parse", "HEAD"]).trim(), base);
    assert!(r.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert!(!r.p().join(".git/MERGE_HEAD").exists());
    r.git(&["switch", "-qc", "unrelated"]);
    r.write("ordinary.txt", "reviewed change\n");
    let target = r.commit_all("unrelated change");
    r.git(&["switch", "-q", "main"]);
    assert_eq!(ops::merge_start(r.p(), "unrelated", "ff-only").unwrap().status, "fastForward");
    assert_eq!(r.git(&["rev-parse", "HEAD"]).trim(), target);
    assert_eq!(r.read("cache/personal.txt"), "keep ignored directory contents\n");
}

#[test]
fn cherry_pick_conflict_then_continue() {
    let r = Repo::new();
    conflict_setup(&r);
    let feat = r.git(&["rev-parse", "feature"]).trim().to_string();
    let out = ops::cherry_pick(r.p(), &[feat], false).unwrap();
    assert_eq!(out.status, "conflicts");
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "cherry-pick");
    conflicts::take_side(r.p(), "f.txt", "ours").unwrap();
    let done = ops::continue_op(r.p(), "cherry-pick", None).unwrap();
    assert_eq!(done.status, "done");
    assert!(r.p().join("feature-only.txt").exists());
}

#[test]
fn rewrite_reword_drop_squash_move_and_undo() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    r.commit_all("c1");
    r.write("b.txt", "2\n");
    let c2 = r.commit_all("c2");
    r.write("c.txt", "3\n");
    let _c3 = r.commit_all("c3");
    r.write("d.txt", "4\n");
    r.commit_all("c4");
    // Dirty worktree survives thanks to --autostash.
    r.write("a.txt", "dirty\n");

    ops::rewrite(r.p(), &RewriteAction::Reword { oid: c2.clone(), message: "second commit".into() }).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "c4\nc3\nsecond commit\nc1");
    assert_eq!(r.read("a.txt"), "dirty\n");

    let c3 = r.git(&["rev-parse", "HEAD~1"]).trim().to_string();
    let _ = c3.clone();
    ops::rewrite(r.p(), &RewriteAction::Drop { oids: vec![c3.clone()] }).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "c4\nsecond commit\nc1");
    assert!(!r.p().join("c.txt").exists());

    let head = r.git(&["rev-parse", "HEAD"]).trim().to_string();
    let prev = r.git(&["rev-parse", "HEAD~1"]).trim().to_string();
    ops::rewrite(r.p(), &RewriteAction::Squash { oids: vec![head, prev], message: "squashed".into() }).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "squashed\nc1");

    r.git(&["stash", "-q"]);
    r.write("e.txt", "5\n");
    r.commit_all("c5");
    let squashed = r.git(&["rev-parse", "HEAD~1"]).trim().to_string();
    ops::rewrite(r.p(), &RewriteAction::Move { oid: squashed, delta: 1 }).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "squashed\nc5\nc1");

    ops::rewrite(r.p(), &RewriteAction::Reword { oid: "HEAD".into(), message: "top".into() }).unwrap();
    assert_eq!(r.git(&["log", "-1", "--format=%s"]).trim(), "top");

    ops::undo_last_commit(r.p()).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "c5\nc1");
    let s = status::status(r.p()).unwrap();
    assert!(s.staged_count >= 2);
    let _ = c3;
}

#[test]
fn edit_commit_stops_rebase() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    let c1 = r.commit_all("c1");
    r.write("b.txt", "2\n");
    r.commit_all("c2");
    let out = ops::rewrite(r.p(), &RewriteAction::Edit { oid: c1 }).unwrap();
    assert_eq!(out.status, "stopped");
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "rebase");
    r.write("a.txt", "1 amended\n");
    r.git(&["add", "a.txt"]);
    r.git(&["commit", "-q", "--amend", "--no-edit"]);
    let done = ops::continue_op(r.p(), "rebase", None).unwrap();
    assert_eq!(done.status, "done");
    assert_eq!(r.git(&["show", "HEAD~1:a.txt"]), "1 amended\n");
}

#[test]
fn graph_rows_and_search() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    r.commit_all("first");
    r.git(&["switch", "-q", "-c", "topic"]);
    r.write("b.txt", "2\n");
    r.commit_all("topic work");
    r.git(&["switch", "-q", "main"]);
    r.write("c.txt", "3\n");
    r.commit_all("main work");
    r.git(&["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
    r.write("c.txt", "dirty\n");

    let g = graph::build(r.p(), None, true, 1000, false).unwrap();
    let fast = graph::build(r.p(), None, true, 1000, true).unwrap();
    assert_eq!(fast.rows.len(), g.rows.len());
    assert_eq!(g.rows.len(), 5);
    assert_eq!(g.rows[0].oid, graph::WORKTREE_OID);
    assert!(g.rows[1].is_head && g.rows[1].is_merge);
    assert!(g.rows[1].refs.iter().any(|l| l.name == "main" && l.kind == "head"));
    assert!(g.max_lanes >= 2);
    let hits = graph::search(r.p(), &g, "topic", graph::SearchMode::Quick).unwrap();
    assert!(hits.len() >= 2);
    let hits = graph::search(r.p(), &g, "b.txt", graph::SearchMode::Path).unwrap();
    assert_eq!(hits.len(), 1);
}

#[test]
#[cfg(unix)]
fn discard_unlinks_dangling_links_and_backs_up_links_without_reading_outside_targets() {
    use std::os::unix::fs::symlink;
    let r = Repo::new();
    r.write("tracked.txt", "base\n");
    r.commit_all("base");
    let outside = r._dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), b"outside data must not be copied").unwrap();
    let links = [
        ("dangling-file", outside.join("missing-file")),
        ("dangling-directory", outside.join("missing-dir/")),
        ("file-link", outside.join("secret.txt")),
        ("directory-link", outside.clone()),
    ];
    for (name, target) in &links {
        symlink(target, r.p().join(name)).unwrap();
    }
    assert!(ops::backup_files(r.p(), &["directory-link/secret.txt".into()]).is_err());
    let head = r.git(&["rev-parse", "HEAD"]);
    let index = fs::read(r.p().join(".git/index")).unwrap();
    let backup = ops::discard_paths(r.p(), &[], &links.iter().map(|(name, _)| name.to_string()).collect::<Vec<_>>()).unwrap();
    for (name, target) in &links {
        assert!(fs::symlink_metadata(r.p().join(name)).is_err(), "{name} was not removed");
        let saved = Path::new(&backup).join(name);
        assert!(fs::symlink_metadata(&saved).unwrap().file_type().is_symlink(), "{name} was copied as target contents");
        assert_eq!(fs::read_link(saved).unwrap(), *target);
    }
    assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"outside data must not be copied");
    assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(r.p().join(".git/index")).unwrap(), index);
}

#[test]
fn stash_roundtrip_and_discard_backup() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit_all("init");
    r.write("a.txt", "changed\n");
    r.write("u.txt", "untracked\n");
    ops::stash_save(r.p(), "wip", true, false, &[]).unwrap();
    assert_eq!(r.read("a.txt"), "a\n");
    assert!(!r.p().join("u.txt").exists());
    ops::stash_apply(r.p(), 0, true).unwrap();
    assert_eq!(r.read("a.txt"), "changed\n");

    let backup = ops::discard_paths(r.p(), &["a.txt".into()], &["u.txt".into()]).unwrap();
    assert_eq!(r.read("a.txt"), "a\n");
    assert!(!r.p().join("u.txt").exists());
    assert_eq!(fs::read_to_string(Path::new(&backup).join("u.txt")).unwrap(), "untracked\n");
}

#[test]
fn branch_details_reports_fork_point_and_merge_state() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    let base = r.commit_all("base");
    r.git(&["switch", "-q", "-c", "topic"]);
    r.write("b.txt", "2\n");
    r.commit_all("topic one");
    r.write("c.txt", "3\n");
    let tip = r.commit_all("topic two");
    r.git(&["switch", "-q", "main"]);
    r.write("d.txt", "4\n");
    r.commit_all("main moves on");

    let d = revqora_lib::git::refs::branch_details(r.p(), "topic", "main").unwrap();
    assert_eq!(d.fork_point.as_deref(), Some(base.as_str()));
    assert_eq!(d.tip, tip);
    assert_eq!((d.ahead, d.behind), (2, 1));
    assert_eq!(d.first_subject.as_deref(), Some("topic one"));
    assert_eq!(d.last_subject, "topic two");
    assert!(!d.merged);

    r.git(&["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
    let d = revqora_lib::git::refs::branch_details(r.p(), "topic", "main").unwrap();
    assert!(d.merged);
}

#[test]
fn partial_discard_of_untracked_and_partial_unstage_of_new_file() {
    let r = Repo::new();
    r.write("base.txt", "x\n");
    r.commit_all("init");

    // Discard one line of an untracked file.
    r.write("u.txt", "a\nb\nc\n");
    let d = diff::working_diff(r.p(), "u.txt", WorkSide::Unstaged, None, true, &opts()).unwrap();
    let sel = select_lines(&d, |k, t| k == "+" && t == "b");
    diff::apply_selection(r.p(), "u.txt", SelectionMode::Discard, &sel, &d.hash, None, true, &opts()).unwrap();
    assert_eq!(r.read("u.txt"), "a\nc\n");

    // Unstage one line of a newly added (staged) file.
    r.write("n.txt", "1\n2\n3\n");
    r.git(&["add", "n.txt"]);
    let s = diff::working_diff(r.p(), "n.txt", WorkSide::Staged, None, false, &opts()).unwrap();
    assert!(s.is_new);
    let sel = select_lines(&s, |k, t| k == "+" && t == "2");
    diff::apply_selection(r.p(), "n.txt", SelectionMode::Unstage, &sel, &s.hash, None, false, &opts()).unwrap();
    assert_eq!(r.index_blob("n.txt"), "1\n3\n");
    assert_eq!(r.read("n.txt"), "1\n2\n3\n");

    // Unstaging every line of the new file removes it from the index entirely.
    let s = diff::working_diff(r.p(), "n.txt", WorkSide::Staged, None, false, &opts()).unwrap();
    let sel = select_lines(&s, |k, _| k == "+");
    diff::apply_selection(r.p(), "n.txt", SelectionMode::Unstage, &sel, &s.hash, None, false, &opts()).unwrap();
    assert!(runner::exec(r.p(), ["ls-files", "--error-unmatch", "n.txt"]).unwrap().code != 0);

    // Stage part of a deletion.
    r.write("del.txt", "k1\nk2\nk3\n");
    r.commit_all("add del");
    fs::remove_file(r.p().join("del.txt")).unwrap();
    let d = diff::working_diff(r.p(), "del.txt", WorkSide::Unstaged, None, false, &opts()).unwrap();
    assert!(d.is_deleted);
    let sel = select_lines(&d, |k, t| k == "-" && t == "k2");
    diff::apply_selection(r.p(), "del.txt", SelectionMode::Stage, &sel, &d.hash, None, false, &opts()).unwrap();
    assert_eq!(r.index_blob("del.txt"), "k1\nk3\n");
}

#[test]
fn compare_blame_and_blob() {
    use revqora_lib::git::inspect::{self, BlobSpec};
    let r = Repo::new();
    r.write("a.txt", "one\ntwo\n");
    let base = r.commit_all("base");
    r.git(&["switch", "-q", "-c", "topic"]);
    r.write("a.txt", "one\nTWO\n");
    r.write("b.txt", "new\n");
    r.commit_all("topic change");
    r.git(&["switch", "-q", "main"]);
    r.write("c.txt", "main only\n");
    r.commit_all("main change");

    // Since branching: only the topic's own changes.
    let c = inspect::compare(r.p(), "main", "topic", true).unwrap();
    assert_eq!(c.merge_base.as_deref(), Some(base.as_str()));
    let mut files: Vec<&str> = c.files.iter().map(|f| f.path.as_str()).collect();
    files.sort();
    assert_eq!(files, vec!["a.txt", "b.txt"]);
    assert_eq!(c.ahead.len(), 1);
    assert_eq!(c.behind, 1);
    // Direct diff also shows main's file as removed.
    let d = inspect::compare(r.p(), "main", "topic", false).unwrap();
    assert!(d.files.iter().any(|f| f.path == "c.txt" && f.status == "D"));
    assert!(inspect::compare(r.p(), "main", "no-such-branch", true).is_err());

    r.git(&["switch", "-q", "topic"]);
    let b = inspect::blame(r.p(), "a.txt", None).unwrap();
    assert_eq!(b.lines.len(), 2);
    assert_eq!(b.commits[&b.lines[0].oid].summary, "base");
    assert_eq!(b.commits[&b.lines[1].oid].summary, "topic change");
    let at_base = inspect::blame(r.p(), "a.txt", Some(&base)).unwrap();
    assert!(at_base.lines.iter().all(|l| l.oid == base));

    let png: &[u8] = &[0x89, b'P', b'N', b'G', 0, 1, 2];
    std::fs::write(r.p().join("img.png"), png).unwrap();
    let w = inspect::blob(r.p(), &BlobSpec { rev: None, worktree: Some("img.png".into()) }).unwrap().unwrap();
    assert_eq!(w.mime, "image/png");
    assert_eq!(w.size, 7);
    r.commit_all("image");
    let h = inspect::blob(r.p(), &BlobSpec { rev: Some("HEAD:img.png".into()), worktree: None }).unwrap().unwrap();
    assert_eq!(h.base64, w.base64);
    assert!(inspect::blob(r.p(), &BlobSpec { rev: None, worktree: Some("../outside.png".into()) }).map(|b| b.is_none()).unwrap_or(true));
}

#[test]
fn interactive_rebase_reorders_rewords_squashes_and_drops() {
    use revqora_lib::git::ops::RebaseItem;
    let r = Repo::new();
    r.write("base.txt", "0\n");
    r.commit_all("base");
    for (f, m) in [("a.txt", "A"), ("b.txt", "B"), ("c.txt", "C"), ("d.txt", "D"), ("e.txt", "E")] {
        r.write(f, &format!("{m}\n"));
        r.commit_all(m);
    }
    let oldest = r.git(&["rev-parse", "HEAD~4"]).trim().to_string();
    let plan = ops::rebase_plan(r.p(), &oldest).unwrap();
    let subjects: Vec<&str> = plan.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, vec!["A", "B", "C", "D", "E"]);
    let oid = |s: &str| plan.commits.iter().find(|c| c.subject == s).unwrap().oid.clone();
    let item = |s: &str, action: &str, message: Option<&str>| RebaseItem { oid: oid(s), action: action.into(), message: message.map(|m| m.into()) };
    // New order: C, A (+ squash D into A with a combined message), B reworded, E dropped.
    let items = vec![
        item("C", "pick", None),
        item("A", "pick", Some("A and D")),
        item("D", "squash", None),
        item("B", "reword", Some("B renamed")),
        item("E", "drop", None),
    ];
    let out = ops::interactive_rebase(r.p(), plan.base.as_deref(), &items).unwrap();
    assert_eq!(out.status, "done");
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "B renamed\nA and D\nC\nbase");
    assert!(r.p().join("d.txt").exists());
    assert!(!r.p().join("e.txt").exists());

    // A stale plan is refused.
    let err = ops::interactive_rebase(r.p(), plan.base.as_deref(), &items).unwrap_err();
    assert_eq!(err.kind, "stale");
    // Squashing the first commit is refused.
    let plan = ops::rebase_plan(r.p(), r.git(&["rev-parse", "HEAD~1"]).trim()).unwrap();
    let items: Vec<RebaseItem> = plan.commits.iter().map(|c| RebaseItem { oid: c.oid.clone(), action: "squash".into(), message: None }).collect();
    assert!(ops::interactive_rebase(r.p(), plan.base.as_deref(), &items).is_err());
}

#[test]
fn layer_conflicts_can_be_resolved_by_hand() {
    use revqora_lib::git::layers::{LayerOp, Resolutions};
    let r = Repo::new();
    r.write(
        "f.txt",
        "start
v1
end
",
    );
    r.commit_all("init");
    // Layer 1 changes line 2, layer 2 changes it again on top.
    r.write(
        "f.txt",
        "start
v2
end
",
    );
    ops::stage_paths(r.p(), &["f.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();
    r.write(
        "f.txt",
        "start
v3
end
",
    );
    ops::stage_paths(r.p(), &["f.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    let op = LayerOp::Unstage { index: 0 };
    let c = layers::preview(r.p(), &op, &Resolutions::new()).unwrap().expect("a conflict");
    assert_eq!(c.item, 1);
    assert_eq!(c.files.len(), 1);
    let f = &c.files[0];
    assert_eq!(f.path, "f.txt");
    assert_eq!(
        f.base.text,
        "start
v2
end
"
    );
    assert_eq!(
        f.ours.text,
        "start
v1
end
"
    );
    assert_eq!(
        f.theirs.text,
        "start
v3
end
"
    );
    assert!(f.merged.contains("<<<<<<<"));

    let mut res = Resolutions::new();
    res.insert(
        format!("{}:f.txt", c.item),
        "start
v3 without v2
end
"
        .into(),
    );
    assert!(layers::preview(r.p(), &op, &res).unwrap().is_none());
    layers::unstage(r.p(), 0, &res).unwrap();
    assert_eq!(
        r.index_blob("f.txt"),
        "start
v3 without v2
end
"
    );
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    // The working tree is untouched.
    assert_eq!(
        r.read("f.txt"),
        "start
v3
end
"
    );
}
