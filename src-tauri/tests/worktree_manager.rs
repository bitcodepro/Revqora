use revqora_lib::git::{
    operations, recovery, runner, status,
    worktree_manager::{self as wm, CreateMode, CreateRequest},
};
use std::{
    fs,
    path::{Path, PathBuf},
};

struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("main repo 'проверка'");
        fs::create_dir(&root).unwrap();
        let f = Self { temp, root };
        for args in [
            vec!["init", "-qb", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "test@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.autocrlf", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            f.git(&f.root, &args);
        }
        for file in ["file.txt", "hidden.txt", "absent.txt"] {
            fs::write(f.root.join(file), format!("base {file}\n")).unwrap();
        }
        fs::write(f.root.join(".gitignore"), "ignored.txt\n").unwrap();
        f.git(&f.root, &["add", "."]);
        f.git(&f.root, &["commit", "-qm", "Base"]);
        f
    }
    fn git(&self, p: &Path, args: &[&str]) -> String {
        runner::run(p, args).unwrap().trim().into()
    }
    fn oid(&self) -> String {
        self.git(&self.root, &["rev-parse", "HEAD"])
    }
    fn path(&self, name: &str) -> PathBuf {
        self.temp.path().join(name)
    }
    fn add(&self, name: &str) -> PathBuf {
        let p = self.path(name);
        self.git(&self.root, &["worktree", "add", "-b", name, p.to_str().unwrap(), "HEAD"]);
        p
    }
    fn detach(&self, name: &str) -> PathBuf {
        let p = self.path(name);
        self.git(&self.root, &["worktree", "add", "--detach", p.to_str().unwrap(), "HEAD"]);
        p
    }
    fn remove_folder(&self, p: &Path) {
        assert!(fs::canonicalize(p).unwrap().starts_with(fs::canonicalize(self.temp.path()).unwrap()));
        fs::remove_dir_all(p).unwrap();
    }
    fn review(&self, p: &Path) -> wm::RemovalReview {
        wm::removal_review(&self.root, p.to_str().unwrap()).unwrap()
    }
    fn execute(&self, r: &wm::RemovalReview, force: bool) -> Result<wm::Removal, runner::GitError> {
        operations::run(&self.root, "worktree_remove", Some(&r.state_token), |_, _| {}, || wm::remove(&self.root, &r.proof, force))
    }
    fn create_review(&self, name: &str, mode: CreateMode, branch: &str) -> wm::CreationReview {
        wm::creation_review(
            &self.root,
            CreateRequest { path: self.path(name).to_string_lossy().into_owned(), mode, branch: branch.into(), start: "HEAD".into() },
        )
        .unwrap()
    }
    fn create(&self, r: &wm::CreationReview) -> Result<wm::Created, runner::GitError> {
        operations::run(&self.root, "worktree_add", Some(&r.state_token), |_, _| {}, || wm::create(&self.root, r))
    }
}

#[test]
fn inventory_is_read_only_and_describes_dirty_locked_missing_and_detached_worktrees() {
    let f = Fixture::new();
    let dirty = f.add("dirty");
    let gone = f.detach("gone");
    let locked = f.add("locked");
    fs::write(dirty.join("file.txt"), "local\n").unwrap();
    fs::write(dirty.join("ignored.txt"), "ignored\n").unwrap();
    f.git(&f.root, &["worktree", "lock", "--reason", "Portable drive is offline", locked.to_str().unwrap()]);
    f.remove_folder(&gone);
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let s = wm::snapshot(&f.root).unwrap();
    assert_eq!(s.worktrees.len(), 4);
    assert!(s.worktrees[0].is_main && s.worktrees[0].worktree.is_current);
    let d = s.worktrees.iter().find(|w| w.worktree.branch.as_deref() == Some("dirty")).unwrap();
    assert_eq!(d.changed_files, Some(1));
    assert_eq!(d.ignored, Some(1));
    let l = s.worktrees.iter().find(|w| w.worktree.locked).unwrap();
    assert_eq!(l.worktree.lock_reason.as_deref(), Some("Portable drive is offline"));
    let m = s.worktrees.iter().find(|w| !w.exists).unwrap();
    assert!(m.worktree.detached && m.worktree.prunable);
    assert_eq!(index, fs::read(f.root.join(".git/index")).unwrap());
}

#[test]
fn creation_modes_freeze_the_start_and_keep_source_files_staging_and_branch() {
    let f = Fixture::new();
    f.git(&f.root, &["branch", "available"]);
    fs::write(f.root.join("file.txt"), "source staged\n").unwrap();
    f.git(&f.root, &["add", "file.txt"]);
    fs::write(f.root.join("file.txt"), "source unstaged\r\n").unwrap();
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let source = status::status(&f.root).unwrap().state_token;
    let head = f.oid();
    for (name, mode, branch) in
        [("new-folder", CreateMode::New, "new-topic"), ("existing-folder", CreateMode::Existing, "available"), ("detached-folder", CreateMode::Detached, "")]
    {
        let detached = mode == CreateMode::Detached;
        let r = f.create_review(name, mode, branch);
        assert_eq!(r.start_oid, head);
        let created = f.create(&r).unwrap();
        assert_eq!(created.head.as_deref(), Some(head.as_str()));
        assert!(created.warning.is_none());
        assert_eq!(fs::read(f.path(name).join("file.txt")).unwrap(), b"base file.txt\n");
        if detached {
            assert!(!runner::exec(&f.path(name), ["symbolic-ref", "--quiet", "HEAD"]).unwrap().ok());
        } else {
            assert_eq!(f.git(&f.path(name), &["symbolic-ref", "--quiet", "HEAD"]), format!("refs/heads/{branch}"));
        }
    }
    assert_eq!(f.oid(), head);
    assert_eq!(index, fs::read(f.root.join(".git/index")).unwrap());
    assert_eq!(fs::read(f.root.join("file.txt")).unwrap(), b"source unstaged\r\n");
    assert_ne!(status::status(&f.root).unwrap().state_token, source); // new branch changes refs, not source files
}

#[test]
fn creation_refuses_in_use_alias_nested_existing_and_changed_destinations_before_mutation() {
    let f = Fixture::new();
    assert!(wm::creation_review(
        &f.root,
        CreateRequest { path: f.path("in-use").to_string_lossy().into(), mode: CreateMode::Existing, branch: "main".into(), start: "HEAD".into() }
    )
    .is_err());
    f.git(&f.root, &["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
    assert!(wm::creation_review(
        &f.root,
        CreateRequest { path: f.path("alias-copy").to_string_lossy().into(), mode: CreateMode::Existing, branch: "alias".into(), start: "HEAD".into() }
    )
    .is_err());
    assert!(wm::creation_review(
        &f.root,
        CreateRequest { path: f.root.join("nested").to_string_lossy().into(), mode: CreateMode::New, branch: "nested".into(), start: "HEAD".into() }
    )
    .is_err());
    let review = f.create_review("destination", CreateMode::New, "topic");
    fs::create_dir(f.path("destination")).unwrap();
    fs::write(f.path("destination/keep.txt"), "kept").unwrap();
    assert!(f.create(&review).is_err());
    assert_eq!(fs::read(f.path("destination/keep.txt")).unwrap(), b"kept");
    assert!(!runner::exec(&f.root, ["show-ref", "--verify", "--quiet", "refs/heads/topic"]).unwrap().ok());
    assert!(!f.path("in-use").exists() && !f.path("alias-copy").exists() && !f.root.join("nested").exists());
}

#[test]
fn a_changed_start_or_registry_invalidates_creation_even_without_the_outer_queue_guard() {
    let f = Fixture::new();
    let review = f.create_review("target", CreateMode::New, "created");
    let other = f.add("other");
    assert!(wm::create(&f.root, &review).is_err());
    assert!(!f.path("target").exists());
    let fresh = f.create_review("target", CreateMode::New, "created");
    let tree = f.git(&f.root, &["rev-parse", "HEAD^{tree}"]);
    let next = f.git(&f.root, &["commit-tree", &tree, "-p", "HEAD", "-m", "Advance"]);
    f.git(&f.root, &["update-ref", "refs/heads/main", &next]);
    assert!(wm::create(&f.root, &fresh).is_err());
    assert!(!f.path("target").exists());
    assert!(other.exists());
}

#[test]
fn removal_saves_a_complete_workspace_including_ignored_hidden_missing_paths_and_exact_index() {
    let f = Fixture::new();
    let wt = f.add("topic");
    let head = f.oid();
    fs::write(wt.join("file.txt"), "staged\n").unwrap();
    f.git(&wt, &["add", "file.txt"]);
    fs::write(wt.join("file.txt"), "unstaged\r\n").unwrap();
    fs::write(wt.join("untracked.bin"), [0, 255, 1, 13, 10]).unwrap();
    fs::write(wt.join("ignored.txt"), "private ignored data\n").unwrap();
    fs::create_dir(wt.join("empty-folder")).unwrap();
    f.git(&wt, &["update-index", "--assume-unchanged", "hidden.txt"]);
    fs::write(wt.join("hidden.txt"), "hidden modification\n").unwrap();
    f.git(&wt, &["update-index", "--skip-worktree", "absent.txt"]);
    fs::remove_file(wt.join("absent.txt")).unwrap();
    let index = f.git(&wt, &["ls-files", "--stage", "-v", "-z"]);
    let staged = f.git(&wt, &["diff", "--cached", "--", "file.txt"]);
    let source_index = fs::read(f.root.join(".git/index")).unwrap();
    let r = f.review(&wt);
    assert!(r.requires_force);
    assert!(f.execute(&r, false).is_err());
    assert!(wt.exists());
    let result = f.execute(&r, true).unwrap();
    assert_eq!(result.removed, Some(true));
    assert!(result.warning.is_none());
    assert!(!wt.exists());
    assert!(result.checkpoint.workspace && result.checkpoint.includes_ignored);
    assert_eq!(f.git(&f.root, &["rev-parse", "refs/heads/topic"]), head);
    assert_eq!(source_index, fs::read(f.root.join(".git/index")).unwrap());
    let restored = f.path("restored");
    recovery::restore_workspace(&f.root, &result.checkpoint.id, &restored, "restored-topic").unwrap();
    assert_eq!(fs::read(restored.join("file.txt")).unwrap(), b"unstaged\r\n");
    assert_eq!(fs::read(restored.join("hidden.txt")).unwrap(), b"hidden modification\n");
    assert!(!restored.join("absent.txt").exists());
    assert_eq!(fs::read(restored.join("ignored.txt")).unwrap(), b"private ignored data\n");
    assert_eq!(fs::read(restored.join("untracked.bin")).unwrap(), [0, 255, 1, 13, 10]);
    assert!(restored.join("empty-folder").is_dir());
    assert_eq!(f.git(&restored, &["ls-files", "--stage", "-v", "-z"]), index);
    assert_eq!(f.git(&restored, &["diff", "--cached", "--", "file.txt"]), staged);
}

#[test]
fn ignored_content_change_after_review_is_stale_even_when_normal_status_token_is_unchanged() {
    let f = Fixture::new();
    let wt = f.add("topic");
    fs::write(wt.join("ignored.txt"), "before\n").unwrap();
    let r = f.review(&wt);
    fs::write(wt.join("ignored.txt"), "after!\n").unwrap();
    assert_eq!(status::status(&wt).unwrap().state_token.as_deref(), Some(r.proof.target_state.as_str()));
    assert_eq!(f.execute(&r, true).err().unwrap().kind, "stale-operation");
    assert_eq!(fs::read(wt.join("ignored.txt")).unwrap(), b"after!\n");
}

#[test]
fn main_current_locked_running_operations_and_nested_repositories_are_kept() {
    let f = Fixture::new();
    let wt = f.add("topic");
    assert!(wm::removal_review(&f.root, f.root.to_str().unwrap()).is_err());
    assert!(wm::removal_review(&wt, wt.to_str().unwrap()).is_err());
    f.git(&f.root, &["worktree", "lock", wt.to_str().unwrap()]);
    assert!(wm::removal_review(&f.root, wt.to_str().unwrap()).is_err());
    f.git(&f.root, &["worktree", "unlock", wt.to_str().unwrap()]);
    let gd = PathBuf::from(f.git(&wt, &["rev-parse", "--absolute-git-dir"]));
    fs::write(gd.join("MERGE_HEAD"), format!("{}\n", f.oid())).unwrap();
    assert!(wm::removal_review(&f.root, wt.to_str().unwrap()).is_err());
    fs::remove_file(gd.join("MERGE_HEAD")).unwrap();
    let child = wt.join("child");
    fs::create_dir(&child).unwrap();
    f.git(&child, &["init", "-q"]);
    assert!(wm::removal_review(&f.root, wt.to_str().unwrap()).is_err());
    assert!(child.join(".git").is_dir());
    assert!(f.root.is_dir() && wt.is_dir());
}

#[test]
fn replacing_the_marker_with_an_unrelated_repository_cannot_authorize_removal() {
    let f = Fixture::new();
    let wt = f.add("topic");
    let review = f.review(&wt);
    let foreign = f.path("foreign");
    f.git(&f.root, &["clone", "-q", f.root.to_str().unwrap(), foreign.to_str().unwrap()]);
    fs::write(wt.join(".git"), format!("gitdir: {}\n", foreign.join(".git").display())).unwrap();
    assert!(f.execute(&review, true).is_err());
    assert!(wm::removal_review(&f.root, wt.to_str().unwrap()).is_err());
    assert!(wt.exists());
    assert_eq!(f.git(&foreign, &["rev-parse", "HEAD"]), f.oid());
}

#[test]
fn lock_reason_and_missing_offline_lock_are_reviewed_against_the_exact_registry() {
    let f = Fixture::new();
    let wt = f.add("topic");
    let s = wm::snapshot(&f.root).unwrap();
    operations::run(
        &f.root,
        "worktree_lock",
        Some(&s.state_token),
        |_, _| {},
        || wm::lock(&f.root, wt.to_str().unwrap(), &s.registry_token, true, "External drive"),
    )
    .unwrap();
    assert!(wm::lock(&f.root, wt.to_str().unwrap(), &s.registry_token, false, "").is_err());
    f.remove_folder(&wt);
    let s = wm::snapshot(&f.root).unwrap();
    assert!(wm::prune_review(&f.root).unwrap().entries.is_empty());
    wm::lock(&f.root, wt.to_str().unwrap(), &s.registry_token, false, "").unwrap();
    let review = wm::prune_review(&f.root).unwrap();
    assert_eq!(review.entries.len(), 1);
}

#[test]
fn scoped_prune_pins_detached_heads_keeps_locked_entries_and_does_not_delete_branch_refs() {
    let f = Fixture::new();
    let detached = f.detach("detached");
    f.git(&detached, &["commit", "--allow-empty", "-qm", "Unique detached work"]);
    let tip = f.git(&detached, &["rev-parse", "HEAD"]);
    let locked = f.add("locked");
    let base = f.oid();
    assert_ne!(tip, base);
    f.git(&f.root, &["worktree", "lock", locked.to_str().unwrap()]);
    f.remove_folder(&detached);
    f.remove_folder(&locked);
    let review = wm::prune_review(&f.root).unwrap();
    assert_eq!(review.entries.len(), 1);
    let result = operations::run(&f.root, "worktree_prune", Some(&review.state_token), |_, _| {}, || wm::prune(&f.root, &review, |_| {})).unwrap();
    assert_eq!(result.removed.len(), 1);
    assert!(result.kept.is_empty() && result.unknown.is_empty() && result.warning.is_none());
    f.git(&f.root, &["reflog", "expire", "--expire=now", "--all"]);
    f.git(&f.root, &["gc", "--prune=now"]);
    let cp = recovery::detail(&f.root, &result.checkpoint.id).unwrap();
    let i = cp.refs.iter().position(|r| r.kind == "worktree" && r.oid == tip).unwrap();
    recovery::restore_branch(&f.root, &result.checkpoint.id, Some(i), "detached-recovered").unwrap();
    assert_eq!(f.git(&f.root, &["rev-parse", "detached-recovered"]), tip);
    assert!(wm::snapshot(&f.root).unwrap().worktrees.iter().any(|w| w.worktree.locked));
    assert_eq!(f.git(&f.root, &["rev-parse", "locked"]), base);
}

#[test]
fn prune_rejects_a_reappeared_folder_and_stops_after_partial_progress_with_accurate_results() {
    let f = Fixture::new();
    let a = f.add("a");
    let b = f.add("b");
    f.remove_folder(&a);
    f.remove_folder(&b);
    let review = wm::prune_review(&f.root).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(b.join("keep.txt"), "reappeared\n").unwrap();
    assert!(wm::prune(&f.root, &review, |_| {}).is_err());
    assert_eq!(fs::read(b.join("keep.txt")).unwrap(), b"reappeared\n");
    f.remove_folder(&b);
    let review = wm::prune_review(&f.root).unwrap();
    let second = PathBuf::from(&review.entries[1].path);
    let mut calls = 0;
    let result = wm::prune(&f.root, &review, |_| {
        calls += 1;
        if calls == 2 {
            fs::create_dir(&second).unwrap();
            fs::write(second.join("keep.txt"), "manual\n").unwrap();
        }
    })
    .unwrap();
    assert_eq!(result.removed.len(), 1);
    assert_eq!(result.kept.len(), 1);
    assert!(result.warning.is_some());
    assert!(result.unknown.is_empty());
    assert_eq!(fs::read(second.join("keep.txt")).unwrap(), b"manual\n");
}

#[cfg(unix)]
#[test]
fn directory_symlinks_are_kept_and_regular_file_symlinks_are_recoverable() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let wt = f.add("topic");
    let outside = f.path("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), "outside").unwrap();
    symlink(&outside, wt.join("dir-link")).unwrap();
    assert!(wm::removal_review(&f.root, wt.to_str().unwrap()).is_err());
    assert!(outside.join("keep").exists());
    fs::remove_file(wt.join("dir-link")).unwrap();
    symlink("file.txt", wt.join("file-link")).unwrap();
    let review = f.review(&wt);
    let result = f.execute(&review, true).unwrap();
    let restored = f.path("restored");
    recovery::restore_workspace(&f.root, &result.checkpoint.id, &restored, "restored-topic").unwrap();
    assert_eq!(fs::read_link(restored.join("file-link")).unwrap(), PathBuf::from("file.txt"));
}

fn directory_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("cmd.exe").args(["/C", "mklink", "/J"]).arg(link).arg(target).creation_flags(0x08000000).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
}
fn remove_directory_link(link: &Path) {
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
    #[cfg(unix)]
    fs::remove_file(link).unwrap();
}

#[test]
fn directory_links_cannot_redirect_removal_and_retargeted_creation_parents_are_stale() {
    let f = Fixture::new();
    let wt = f.add("topic");
    let a = f.path("outside-a");
    let b = f.path("outside-b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("keep"), "a").unwrap();
    fs::write(b.join("keep"), "b").unwrap();
    let link = wt.join("linked-dir");
    directory_link(&a, &link);
    assert!(wm::removal_review(&f.root, wt.to_str().unwrap()).is_err());
    assert_eq!(fs::read(a.join("keep")).unwrap(), b"a");
    remove_directory_link(&link);
    let parent = f.path("parent-alias");
    directory_link(&a, &parent);
    let review = wm::creation_review(
        &f.root,
        CreateRequest {
            path: parent.join("new-worktree").to_string_lossy().into_owned(),
            mode: CreateMode::New,
            branch: "new-parent-topic".into(),
            start: "HEAD".into(),
        },
    )
    .unwrap();
    remove_directory_link(&parent);
    directory_link(&b, &parent);
    assert!(wm::create(&f.root, &review).is_err());
    assert!(!a.join("new-worktree").exists() && !b.join("new-worktree").exists());
    assert_eq!(fs::read(b.join("keep")).unwrap(), b"b");
    remove_directory_link(&parent);
}

#[test]
fn an_uncapturable_workspace_is_kept_instead_of_bypassing_the_checkpoint_budget() {
    let f = Fixture::new();
    let wt = f.add("topic");
    fs::File::create(wt.join("ignored.txt")).unwrap().set_len(101 * 1024 * 1024).unwrap();
    let error = wm::removal_review(&f.root, wt.to_str().unwrap()).err().unwrap();
    assert!(error.message.contains("100 MiB"));
    assert!(wt.exists());
    assert_eq!(fs::metadata(wt.join("ignored.txt")).unwrap().len(), 101 * 1024 * 1024);
    assert!(recovery::list(&f.root).unwrap().checkpoints.is_empty());
}

#[test]
fn complete_sparse_workspace_recovery_uses_saved_layout_and_keeps_hidden_content() {
    let f = Fixture::new();
    let wt = f.add("sparse-topic");
    f.git(&f.root, &["config", "extensions.worktreeConfig", "true"]);
    f.git(&wt, &["sparse-checkout", "set", "--no-cone", "/file.txt"]);
    fs::write(wt.join("file.txt"), "sparse local\n").unwrap();
    let review = f.review(&wt);
    let result = f.execute(&review, true).unwrap();
    assert_eq!(result.removed, Some(true));
    // Later configuration changes must not reinterpret the captured sparse tree.
    f.git(&f.root, &["config", "--worktree", "core.sparseCheckout", "false"]);
    let restored = f.path("restored-sparse");
    recovery::restore_workspace(&f.root, &result.checkpoint.id, &restored, "restored-sparse").unwrap();
    assert_eq!(fs::read(restored.join("file.txt")).unwrap(), b"sparse local\n");
    assert!(!restored.join("hidden.txt").exists());
    assert_eq!(f.git(&restored, &["config", "--bool", "core.sparseCheckout"]), "true");
}
