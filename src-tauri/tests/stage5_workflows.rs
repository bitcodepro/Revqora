use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::{diff, operations, partial_stash, recovery, remote_rename, runner, status, workspace_files};

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("stage5 проверка");
        fs::create_dir(&root).unwrap();
        let r = Self { _temp: temp, root };
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.autocrlf", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            r.git(&args);
        }
        r
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(&self.root, args).unwrap().trim().into()
    }
    fn commit(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-qm", msg]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn base(&self) -> String {
        fs::write(self.root.join("f.txt"), "one\ntwo\nthree\n").unwrap();
        self.commit("Base")
    }
    fn index(&self) -> Vec<u8> {
        fs::read(self.root.join(".git/index")).unwrap()
    }
    fn stash(&self, path: &str, selection: &[(usize, usize)], hash: &str, opts: &diff::DiffOptions) -> runner::GitResult<partial_stash::PartialStashResult> {
        let expected = status::status(&self.root)?.state_token;
        operations::run(
            &self.root,
            "stash_selection",
            expected.as_deref(),
            |_, _| {},
            || partial_stash::save(&self.root, path, selection, hash, opts, "Selected lines"),
        )
    }
    fn origin(&self) -> PathBuf {
        let bare = self.root.parent().unwrap().join("origin.git");
        self.git(&["clone", "--bare", ".", bare.to_str().unwrap()]);
        self.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        self.git(&["push", "origin", "HEAD:refs/heads/topic"]);
        self.git(&["fetch", "origin"]);
        bare
    }
    fn plan(&self, tracking: &str, new: &str) -> runner::GitResult<remote_rename::RenamePlan> {
        operations::run(&self.root, "remote_rename_plan", None, |_, _| {}, || remote_rename::plan(&self.root, tracking, new))
    }
    fn rename(&self, plan: &remote_rename::RenamePlan) -> runner::GitResult<remote_rename::RenameResult> {
        operations::run(&self.root, "remote_branch_rename", Some(&plan.state_token), |_, _| {}, || remote_rename::rename(&self.root, plan))
    }
}
fn git_at(root: &Path, args: &[&str]) -> String {
    runner::run(root, args).unwrap().trim().into()
}
fn hook(path: &Path, content: &str) {
    fs::write(path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}
fn changes(d: &diff::FileDiff, h: usize) -> Vec<(usize, usize)> {
    d.hunks[h].lines.iter().enumerate().filter_map(|(i, l)| matches!(l.kind.as_str(), "+" | "-").then_some((h, i))).collect()
}

#[test]
fn ignored_and_nested_inspection_is_read_only_and_stops_at_repository_boundaries() {
    let r = Repo::new();
    r.base();
    fs::write(r.root.join(".gitignore"), "cache/\n*.ignored\n").unwrap();
    r.commit("Ignore rules");
    fs::create_dir(r.root.join("cache")).unwrap();
    fs::write(r.root.join("cache/build.out"), "output").unwrap();
    fs::write(r.root.join("file.ignored"), "ignored").unwrap();
    let child = r.root.join("vendor/child");
    fs::create_dir_all(&child).unwrap();
    git_at(&child, &["init", "-q", "-b", "child"]);
    let deep = child.join("deeper");
    fs::create_dir(&deep).unwrap();
    git_at(&deep, &["init", "-q"]);
    let linked = r.root.join("linked");
    r.git(&["worktree", "add", "--detach", linked.to_str().unwrap(), "HEAD"]);
    let bare = r.root.join("bare.git");
    r.git(&["clone", "--bare", ".", bare.to_str().unwrap()]);
    let index = r.index();
    let ignored = workspace_files::ignored(&r.root).unwrap();
    assert!(ignored.paths.contains(&"cache/".into()));
    assert!(ignored.paths.contains(&"file.ignored".into()));
    let nested = workspace_files::nested(&r.root).unwrap();
    assert!(nested.repositories.iter().any(|c| c.relative_path == "vendor/child" && c.branch.as_deref() == Some("child")));
    assert!(nested.repositories.iter().any(|c| c.relative_path == "linked" && c.kind == "linked worktree"));
    assert!(nested.repositories.iter().any(|c| c.relative_path == "bare.git" && c.kind == "bare"));
    assert!(!nested.repositories.iter().any(|c| c.relative_path.contains("deeper")));
    assert_eq!(r.index(), index);
}

#[test]
fn partial_stash_preserves_staging_and_unselected_changes_and_has_a_native_stash_shape() {
    let r = Repo::new();
    let lines: Vec<_> = (1..=24).map(|n| format!("line {n}\n")).collect();
    fs::write(r.root.join("f.txt"), lines.concat()).unwrap();
    r.commit("Base");
    let staged = lines.concat().replace("line 2\n", "STAGED\n");
    fs::write(r.root.join("f.txt"), &staged).unwrap();
    r.git(&["add", "f.txt"]);
    let working = staged.replace("line 10\n", "SELECTED\n").replace("line 20\n", "UNSELECTED\n");
    fs::write(r.root.join("f.txt"), &working).unwrap();
    fs::write(r.root.join("keep.txt"), "untracked").unwrap();
    let index = r.index();
    let opts = diff::DiffOptions { context: Some(1), ..Default::default() };
    let d = diff::working_diff(&r.root, "f.txt", diff::WorkSide::Unstaged, None, false, &opts).unwrap();
    assert_eq!(d.hunks.len(), 2);
    let saved = r.stash("f.txt", &changes(&d, 0), &d.hash, &opts).unwrap();
    assert!(saved.removed, "{:?}", saved.warning);
    assert_eq!(r.index(), index);
    let remaining = fs::read_to_string(r.root.join("f.txt")).unwrap();
    assert!(remaining.contains("STAGED\n"));
    assert!(remaining.contains("UNSELECTED\n"));
    assert!(!remaining.contains("SELECTED\nline 11"));
    assert_eq!(fs::read_to_string(r.root.join("keep.txt")).unwrap(), "untracked");
    let stored = r.git(&["show", &format!("{}:f.txt", saved.oid)]);
    assert!(stored.contains("SELECTED"));
    assert!(!stored.contains("STAGED"));
    assert!(!stored.contains("UNSELECTED"));
    assert_eq!(r.git(&["rev-parse", "stash@{0}^2^{tree}"]), r.git(&["rev-parse", "HEAD^{tree}"]));
    assert!(recovery::list(&r.root).unwrap().checkpoints.iter().any(|c| c.command == "stash_selection" && c.workspace));
    let restored = r.root.parent().unwrap().join("restore");
    r.git(&["worktree", "add", "--detach", restored.to_str().unwrap(), "HEAD"]);
    git_at(&restored, &["stash", "apply", "--index", "stash@{0}"]);
    assert!(fs::read_to_string(restored.join("f.txt")).unwrap().contains("SELECTED"));
    assert_eq!(git_at(&restored, &["diff", "--cached", "--name-only"]), "");
}

#[test]
fn partial_stash_supports_individual_added_lines_crlf_and_quoted_unicode_paths() {
    let r = Repo::new();
    let name = "файл [1] 'space'.txt";
    fs::write(r.root.join(name), "one\ntwo\nthree\n").unwrap();
    fs::write(r.root.join("файл 1 'space'.txt"), "decoy\n").unwrap();
    r.commit("Base");
    r.git(&["config", "core.autocrlf", "true"]);
    fs::write(r.root.join(name), "one\r\nFIRST\r\ntwo\r\nSECOND\r\nthree\r\n").unwrap();
    let index = r.index();
    let opts = diff::DiffOptions::default();
    let d = diff::working_diff(&r.root, name, diff::WorkSide::Unstaged, None, false, &opts).unwrap();
    let selected = d
        .hunks
        .iter()
        .enumerate()
        .flat_map(|(h, block)| block.lines.iter().enumerate().filter_map(move |(l, line)| (line.text == "FIRST" && line.kind == "+").then_some((h, l))))
        .collect::<Vec<_>>();
    let saved = r.stash(name, &selected, &d.hash, &opts).unwrap();
    assert!(saved.removed, "{:?}", saved.warning);
    assert_eq!(r.index(), index);
    let text = fs::read_to_string(r.root.join(name)).unwrap();
    assert!(!text.contains("FIRST"));
    assert!(text.contains("SECOND"));
    assert_eq!(text, "one\r\ntwo\r\nSECOND\r\nthree\r\n");
    assert_eq!(fs::read_to_string(r.root.join("файл 1 'space'.txt")).unwrap(), "decoy\n");
    assert!(r.git(&["show", &format!("{}:{name}", saved.oid)]).contains("FIRST"));
}

#[test]
fn conflicting_staged_dependency_and_stale_selection_leave_files_index_and_stash_unchanged() {
    let r = Repo::new();
    r.base();
    fs::write(r.root.join("f.txt"), "STAGED\ntwo\nthree\n").unwrap();
    r.git(&["add", "f.txt"]);
    fs::write(r.root.join("f.txt"), "UNSTAGED\ntwo\nthree\n").unwrap();
    let index = r.index();
    let opts = diff::DiffOptions::default();
    let d = diff::working_diff(&r.root, "f.txt", diff::WorkSide::Unstaged, None, false, &opts).unwrap();
    assert!(r.stash("f.txt", &changes(&d, 0), &d.hash, &opts).is_err());
    assert_eq!(r.index(), index);
    assert!(fs::read_to_string(r.root.join("f.txt")).unwrap().starts_with("UNSTAGED"));
    assert_eq!(r.git(&["stash", "list"]), "");
    assert!(r.stash("f.txt", &changes(&d, 0), "stale-diff", &opts).is_err());
    assert_eq!(r.index(), index);
}

#[test]
fn stash_ref_failure_removes_nothing_and_late_file_change_reports_a_saved_partial_result() {
    let r = Repo::new();
    r.base();
    fs::write(r.root.join("f.txt"), "one\nADDED\ntwo\nthree\n").unwrap();
    let opts = diff::DiffOptions::default();
    let d = diff::working_diff(&r.root, "f.txt", diff::WorkSide::Unstaged, None, false, &opts).unwrap();
    let selected = changes(&d, 0);
    let index = r.index();
    let path = r.root.join(".git/hooks/reference-transaction");
    hook(&path, "#!/bin/sh\nwhile read old new ref; do\n if [ \"$ref\" = refs/stash ] && [ \"$1\" = prepared ]; then exit 1; fi\ndone\nexit 0\n");
    assert!(r.stash("f.txt", &selected, &d.hash, &opts).is_err());
    assert!(fs::read_to_string(r.root.join("f.txt")).unwrap().contains("ADDED"));
    assert_eq!(r.index(), index);
    hook(&path, "#!/bin/sh\nwhile read old new ref; do\n if [ \"$ref\" = refs/stash ] && [ \"$1\" = committed ]; then root=$(git rev-parse --show-toplevel); printf 'EXTERNAL\\n' > \"$root/f.txt\"; fi\ndone\nexit 0\n");
    let result = r.stash("f.txt", &selected, &d.hash, &opts).unwrap();
    assert!(!result.removed);
    assert!(result.warning.is_some());
    assert_eq!(fs::read_to_string(r.root.join("f.txt")).unwrap(), "EXTERNAL\n");
    assert_eq!(r.index(), index);
    assert_eq!(r.git(&["rev-parse", "refs/stash"]), result.oid);
}

#[test]
fn remote_rename_uses_atomic_updates_and_offers_upstream_change_separately() {
    let r = Repo::new();
    let oid = r.base();
    let bare = r.origin();
    r.git(&["branch", "--set-upstream-to=origin/topic", "main"]);
    r.git(&["tag", "main"]); // Ambiguous short ref names must not become "heads/main" in the UI.
    fs::write(r.root.join("f.txt"), "dirty\n").unwrap();
    let index = r.index();
    let p = r.plan("refs/remotes/origin/topic", "renamed").unwrap();
    let result = r.rename(&p).unwrap();
    assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/renamed"]), oid);
    assert!(!runner::exec(&bare, ["show-ref", "--verify", "refs/heads/topic"]).unwrap().ok());
    assert_eq!(result.tracking_ref.as_deref(), Some("refs/remotes/origin/renamed"));
    assert_eq!(result.local_branches, vec!["main"]);
    assert_eq!(r.git(&["config", "branch.main.merge"]), "refs/heads/topic");
    assert_eq!(r.git(&["rev-parse", "HEAD"]), oid);
    assert_eq!(r.index(), index);
    assert_eq!(fs::read_to_string(r.root.join("f.txt")).unwrap(), "dirty\n");
    let checkpoint = recovery::detail(&r.root, &result.checkpoint.id).unwrap();
    assert!(checkpoint.refs.iter().any(|r| r.name == "refs/heads/topic" && r.oid == oid));
}

#[test]
fn remote_rename_refuses_existing_or_advanced_source_and_destination_refs() {
    let r = Repo::new();
    let oid = r.base();
    let bare = r.origin();
    git_at(&bare, &["update-ref", "refs/heads/occupied", &oid]);
    assert!(r.plan("refs/remotes/origin/topic", "occupied").is_err());
    let p = r.plan("refs/remotes/origin/topic", "new").unwrap();
    git_at(&bare, &["update-ref", "refs/heads/new", &oid]);
    assert!(r.rename(&p).is_err());
    git_at(&bare, &["update-ref", "-d", "refs/heads/new"]);
    fs::write(r.root.join("other"), "other").unwrap();
    let advanced = r.commit("Advanced");
    r.git(&["push", "origin", "HEAD:refs/heads/other"]);
    r.git(&["reset", "--hard", &oid]);
    let p = r.plan("refs/remotes/origin/topic", "new").unwrap();
    git_at(&bare, &["update-ref", "refs/heads/topic", &advanced]);
    assert!(r.rename(&p).is_err());
    assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/topic"]), advanced);
    assert!(!runner::exec(&bare, ["show-ref", "--verify", "refs/heads/new"]).unwrap().ok());
}

#[test]
fn atomic_push_rejection_and_unsupported_server_do_not_create_a_partial_rename() {
    for unsupported in [false, true] {
        let r = Repo::new();
        let oid = r.base();
        let bare = r.origin();
        if unsupported {
            git_at(&bare, &["config", "receive.advertiseAtomic", "false"]);
        } else {
            hook(&bare.join("hooks/pre-receive"), "#!/bin/sh\nexit 1\n");
        }
        let p = r.plan("refs/remotes/origin/topic", "new").unwrap();
        assert!(r.rename(&p).is_err());
        assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/topic"]), oid);
        assert!(!runner::exec(&bare, ["show-ref", "--verify", "refs/heads/new"]).unwrap().ok());
        assert!(recovery::list(&r.root).unwrap().checkpoints.iter().any(|c| c.command == "remote_branch_rename"));
    }
}

#[test]
fn push_server_tip_is_preserved_without_rewriting_a_different_fetch_server() {
    let r = Repo::new();
    let base = r.base();
    let fetch = r.origin();
    let push = r.root.parent().unwrap().join("push.git");
    r.git(&["clone", "--bare", fetch.to_str().unwrap(), push.to_str().unwrap()]);
    fs::write(r.root.join("other"), "server-only").unwrap();
    let pushed = r.commit("Push server tip");
    r.git(&["push", push.to_str().unwrap(), "HEAD:refs/heads/topic"]);
    r.git(&["reset", "--hard", &base]);
    r.git(&["remote", "set-url", "--push", "origin", push.to_str().unwrap()]);
    let p = r.plan("refs/remotes/origin/topic", "new").unwrap();
    assert_eq!(p.server_oid, pushed);
    assert_eq!(p.target.oid, base);
    let config = fs::read(r.root.join(".git/config")).unwrap();
    let result = r.rename(&p).unwrap();
    assert_eq!(fs::read(r.root.join(".git/config")).unwrap(), config);
    assert!(!runner::exec(&r.root, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/new"]).unwrap().ok());
    assert!(result.tracking_ref.is_none());
    assert!(!result.warnings.is_empty());
    assert_eq!(git_at(&fetch, &["rev-parse", "refs/heads/topic"]), base);
    assert_eq!(r.git(&["rev-parse", "refs/remotes/origin/topic"]), base);
    assert_eq!(git_at(&push, &["rev-parse", "refs/heads/new"]), pushed);
    assert!(recovery::detail(&r.root, &result.checkpoint.id).unwrap().refs.iter().any(|r| r.oid == pushed));
}

#[test]
fn remote_rename_resolves_wildcard_aliases_in_both_directions() {
    let r = Repo::new();
    let oid = r.base();
    let bare = r.origin();
    r.git(&["push", "origin", "HEAD:refs/heads/team/old"]);
    r.git(&["config", "--replace-all", "remote.origin.fetch", "+refs/heads/team/*:refs/remotes/origin/alias/*"]);
    r.git(&["fetch", "origin"]);
    let p = r.plan("refs/remotes/origin/alias/old", "team/new").unwrap();
    assert_eq!(p.target.remote_ref, "refs/heads/team/old");
    let result = r.rename(&p).unwrap();
    assert_eq!(result.tracking_ref.as_deref(), Some("refs/remotes/origin/alias/new"));
    assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/team/new"]), oid);
}

#[test]
fn a_destination_alias_owned_by_another_remote_is_not_rewritten() {
    let r = Repo::new();
    let oid = r.base();
    let bare = r.origin();
    r.git(&["remote", "add", "second", bare.to_str().unwrap()]);
    r.git(&["config", "--replace-all", "remote.second.fetch", "+refs/heads/unrelated:refs/remotes/origin/new"]);
    let p = r.plan("refs/remotes/origin/topic", "new").unwrap();
    let result = r.rename(&p).unwrap();
    assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/new"]), oid);
    assert!(result.tracking_ref.is_none());
    assert!(!result.warnings.is_empty());
    assert!(!runner::exec(&r.root, ["show-ref", "--verify", "refs/remotes/origin/new"]).unwrap().ok());
}

#[test]
fn a_symbolic_destination_cache_cannot_move_a_local_branch() {
    let r = Repo::new();
    let oid = r.base();
    let bare = r.origin();
    r.git(&["symbolic-ref", "refs/remotes/origin/new", "refs/heads/main"]);
    let p = r.plan("refs/remotes/origin/topic", "new").unwrap();
    let result = r.rename(&p).unwrap();
    assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/new"]), oid);
    assert!(result.tracking_ref.is_none());
    assert!(!result.warnings.is_empty());
    assert_eq!(r.git(&["symbolic-ref", "refs/remotes/origin/new"]), "refs/heads/main");
    assert_eq!(r.git(&["rev-parse", "main"]), oid);
}

#[test]
fn server_changes_during_receive_are_guarded_by_atomic_leases() {
    for destination_race in [false, true] {
        let r = Repo::new();
        let base = r.base();
        let bare = r.origin();
        fs::write(r.root.join("other"), "other").unwrap();
        let other = r.commit("Other tip");
        r.git(&["push", "origin", "HEAD:refs/heads/seed"]);
        r.git(&["reset", "--hard", &base]);
        let p = r.plan("refs/remotes/origin/topic", "new").unwrap();
        let target = if destination_race { "refs/heads/new" } else { "refs/heads/topic" };
        hook(&bare.join("hooks/pre-receive"), &format!("#!/bin/sh\nunset GIT_QUARANTINE_PATH\ngit update-ref {target} {other}\nexit 0\n"));
        assert!(r.rename(&p).is_err());
        assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/topic"]), if destination_race { base.as_str() } else { other.as_str() });
        if destination_race {
            assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/new"]), other);
        } else {
            assert!(!runner::exec(&bare, ["show-ref", "--verify", "refs/heads/new"]).unwrap().ok());
        }
    }
}

#[test]
fn partial_stash_of_a_deleted_line_preserves_unselected_additions_and_missing_final_newline() {
    let r = Repo::new();
    fs::write(r.root.join("f.txt"), "one\ntwo\nthree\nfour").unwrap();
    r.commit("No final newline");
    fs::write(r.root.join("f.txt"), "one\nthree\nEXTRA\nfour").unwrap();
    let index = r.index();
    let opts = diff::DiffOptions::default();
    let d = diff::working_diff(&r.root, "f.txt", diff::WorkSide::Unstaged, None, false, &opts).unwrap();
    let selected = d
        .hunks
        .iter()
        .enumerate()
        .flat_map(|(h, block)| block.lines.iter().enumerate().filter_map(move |(l, line)| (line.kind == "-" && line.text == "two").then_some((h, l))))
        .collect::<Vec<_>>();
    let result = r.stash("f.txt", &selected, &d.hash, &opts).unwrap();
    assert!(result.removed, "{:?}", result.warning);
    assert_eq!(fs::read_to_string(r.root.join("f.txt")).unwrap(), "one\ntwo\nthree\nEXTRA\nfour");
    assert_eq!(r.index(), index);
    let bytes = runner::run_bytes(&r.root, ["show", &format!("{}:f.txt", result.oid)]).unwrap();
    assert_eq!(bytes, b"one\nthree\nfour");
}

#[test]
fn invalid_server_names_and_changed_local_state_cannot_execute_a_reviewed_rename() {
    let r = Repo::new();
    let oid = r.base();
    let bare = r.origin();
    for name in ["--unsafe", "../invalid", "new:other", "topic"] {
        assert!(r.plan("refs/remotes/origin/topic", name).is_err(), "{name}");
    }
    let p = r.plan("refs/remotes/origin/topic", "new").unwrap();
    fs::write(r.root.join("f.txt"), "external editor\n").unwrap();
    assert_eq!(r.rename(&p).err().unwrap().kind, "stale-operation");
    assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/topic"]), oid);
    assert!(!runner::exec(&bare, ["show-ref", "--verify", "refs/heads/new"]).unwrap().ok());
}

#[test]
fn internal_partial_stash_commits_do_not_launch_a_configured_signer() {
    let r = Repo::new();
    r.base();
    r.git(&["config", "commit.gpgsign", "true"]);
    r.git(&["config", "gpg.program", "revqora-test-signer-must-not-run"]);
    fs::write(r.root.join("f.txt"), "one\nADDED\ntwo\nthree\n").unwrap();
    let opts = diff::DiffOptions::default();
    let d = diff::working_diff(&r.root, "f.txt", diff::WorkSide::Unstaged, None, false, &opts).unwrap();
    let result = r.stash("f.txt", &changes(&d, 0), &d.hash, &opts).unwrap();
    assert!(result.removed);
    assert_eq!(r.git(&["config", "commit.gpgsign"]), "true");
    assert_eq!(r.git(&["rev-parse", "refs/stash"]), result.oid);
}

#[test]
fn staging_cannot_silently_embed_a_child_and_treats_brackets_as_literal_filenames() {
    use revqora_lib::git::ops;
    let r = Repo::new();
    r.base();
    let child = r.root.join("vendor/child");
    fs::create_dir_all(&child).unwrap();
    git_at(&child, &["init", "-q", "-b", "main"]);
    git_at(&child, &["-c", "user.name=Child", "-c", "user.email=child@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Child"]);
    fs::write(r.root.join("literal[1].txt"), "literal\n").unwrap();
    fs::write(r.root.join("literal1.txt"), "must not stage\n").unwrap();
    let index = r.index();
    let error = ops::stage_paths(&r.root, &[".".into()]).unwrap_err();
    assert_eq!(error.kind, "nested-repository");
    assert_eq!(r.index(), index);
    assert_eq!(ops::stage_paths(&r.root, &["literal[1].txt".into(), "vendor/child/".into()]).unwrap_err().kind, "nested-repository");
    assert_eq!(r.index(), index);
    ops::stage_paths(&r.root, &["literal[1].txt".into()]).unwrap();
    assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "literal[1].txt");
}

#[test]
fn an_explicitly_configured_submodule_can_be_staged_again_after_unstaging() {
    use revqora_lib::git::ops;
    let r = Repo::new();
    r.base();
    let child = Repo::new();
    child.base();
    r.git(&["-c", "protocol.file.allow=always", "submodule", "add", child.root.to_str().unwrap(), "registered"]);
    r.git(&["reset", "HEAD", "--", ".gitmodules", "registered"]);
    ops::stage_paths(&r.root, &[".gitmodules".into(), "registered".into()]).unwrap();
    assert!(r.git(&["ls-files", "--stage", "--", "registered"]).starts_with("160000 "));
    assert!(workspace_files::nested(&r.root).unwrap().repositories.iter().any(|r| r.relative_path == "registered" && r.kind == "submodule"));
}
