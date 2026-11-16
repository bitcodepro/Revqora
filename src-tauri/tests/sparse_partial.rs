//! Sparse checkout (cone / non-cone, add / remove folders, refusal with local changes) and
//! partial clone (promisor state, lazy blob fetch for a diff). Remotes are local `file://`
//! repositories; no network.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::diff::{self, DiffOptions};
use revqora_lib::git::ops::{self, CloneFilter, CloneOptions};
use revqora_lib::git::{runner, sparse, status};

fn git(dir: &Path, args: &[&str]) -> String {
    runner::run(dir, args).unwrap().trim().to_string()
}

fn configure(dir: &Path) {
    for (k, v) in [("user.name", "Tester"), ("user.email", "tester@example.com"), ("core.autocrlf", "false"), ("commit.gpgsign", "false")] {
        git(dir, &["config", k, v]);
    }
}

fn tmp() -> tempfile::TempDir {
    match std::env::var_os("REVQORA_TEST_TMP") {
        Some(dir) => {
            fs::create_dir_all(&dir).unwrap();
            tempfile::tempdir_in(dir).unwrap()
        }
        None => tempfile::tempdir().unwrap(),
    }
}

/// A repository with top-level files and three folders, two commits deep.
fn seed(root: &Path) -> PathBuf {
    let repo = root.join("seed");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    configure(&repo);
    for (path, body) in [("README.md", "top\n"), ("lib/a.txt", "a1\n"), ("lib/deep/b.txt", "b\n"), ("docs/guide.md", "g1\n"), ("app/main.txt", "m\n")] {
        let full = repo.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, body).unwrap();
    }
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "one"]);
    fs::write(repo.join("docs/guide.md"), "g2\n").unwrap();
    fs::write(repo.join("lib/a.txt"), "a2\n").unwrap();
    git(&repo, &["commit", "-q", "-am", "two"]);
    repo
}

fn file_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

fn folders(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn assert_no_phantom_deletions(repo: &Path) {
    let s = status::status(repo).unwrap();
    assert!(s.files.is_empty(), "sparse-excluded paths must not show as changes: {:?}", s.files.iter().map(|f| &f.path).collect::<Vec<_>>());
}

#[test]
fn cone_enable_add_remove_disable() {
    let t = tmp();
    let repo = seed(t.path());
    assert!(!sparse::state(&repo).unwrap().enabled);

    let r = sparse::set(&repo, true, &folders(&["lib"])).unwrap();
    assert!(r.state.enabled && r.state.cone);
    assert_eq!(r.state.patterns, ["lib"]);
    assert!(repo.join("README.md").exists() && repo.join("lib/deep/b.txt").exists());
    assert!(!repo.join("docs").exists() && !repo.join("app").exists());
    assert_no_phantom_deletions(&repo);

    let r = sparse::add(&repo, &folders(&["docs\\"])).unwrap();
    assert_eq!(r.state.patterns, ["docs", "lib"]);
    assert!(repo.join("docs/guide.md").exists());

    // Removing a folder is `set` with the remaining list.
    let r = sparse::set(&repo, true, &folders(&["docs"])).unwrap();
    assert_eq!(r.state.patterns, ["docs"]);
    assert!(!repo.join("lib").exists());
    assert_no_phantom_deletions(&repo);

    // Reapply restores the selection after files were brought back behind Git's back.
    git(&repo, &["update-index", "--no-skip-worktree", "lib/a.txt"]);
    git(&repo, &["checkout", "--", "lib/a.txt"]);
    assert!(repo.join("lib/a.txt").exists());
    sparse::reapply(&repo).unwrap();
    assert!(!repo.join("lib/a.txt").exists());

    let r = sparse::disable(&repo).unwrap();
    assert!(!r.state.enabled && r.state.patterns.is_empty());
    assert!(repo.join("lib/deep/b.txt").exists() && repo.join("app/main.txt").exists());
    assert_no_phantom_deletions(&repo);
}

#[test]
fn non_cone_patterns_and_mode_switch() {
    let t = tmp();
    let repo = seed(t.path());
    let r = sparse::set(&repo, false, &folders(&["/*", "!/*/", "/app/", "*.md"])).unwrap();
    assert!(r.state.enabled && !r.state.cone);
    assert!(r.state.patterns.contains(&"/app/".to_string()));
    assert!(repo.join("app/main.txt").exists() && repo.join("docs/guide.md").exists());
    assert!(!repo.join("lib").exists());
    assert_no_phantom_deletions(&repo);

    let r = sparse::set(&repo, true, &folders(&["app"])).unwrap();
    assert!(r.state.cone);
    assert_eq!(r.state.patterns, ["app"]);
    assert!(!repo.join("docs").exists());
    assert_no_phantom_deletions(&repo);
}

#[test]
fn invalid_folders_are_rejected_before_git_runs() {
    let t = tmp();
    let repo = seed(t.path());
    for bad in ["../outside", ".git", "a/./b"] {
        let e = sparse::set(&repo, true, &folders(&[bad])).unwrap_err();
        assert_eq!(e.kind, "invalid-sparse-path");
    }
    assert_eq!(sparse::add(&repo, &folders(&["lib"])).unwrap_err().kind, "sparse-disabled");
    assert!(!sparse::state(&repo).unwrap().enabled);
}

#[test]
fn local_changes_leaving_the_sparse_set_are_surfaced() {
    let t = tmp();
    let repo = seed(t.path());
    sparse::set(&repo, true, &folders(&["lib", "docs"])).unwrap();
    fs::write(repo.join("docs/guide.md"), "local edit\n").unwrap();
    match sparse::set(&repo, true, &folders(&["lib"])) {
        // Newer Git keeps the modified file and warns.
        Ok(r) => {
            assert_eq!(r.left_behind, ["docs/guide.md"], "warning: {:?}", r.warning);
            assert!(r.warning.as_deref().unwrap_or("").contains("docs/guide.md"));
        }
        // Older Git refuses the whole change.
        Err(e) => {
            assert_eq!(e.kind, "sparse-local-changes");
            assert_eq!(e.details, ["docs/guide.md"]);
        }
    }
    assert_eq!(fs::read_to_string(repo.join("docs/guide.md")).unwrap(), "local edit\n", "the edit must never be lost");
}

fn served(root: &Path) -> String {
    let repo = seed(root);
    let bare = root.join("server.git");
    git(root, &["clone", "-q", "--bare", repo.to_str().unwrap(), bare.to_str().unwrap()]);
    git(&bare, &["config", "uploadpack.allowFilter", "true"]);
    git(&bare, &["config", "uploadpack.allowAnySHA1InWant", "true"]);
    file_url(&bare)
}

#[test]
fn sparse_clone_with_folders_and_partial_state() {
    let t = tmp();
    let url = served(t.path());
    let parent = t.path().join("out");
    let options =
        CloneOptions { filter: CloneFilter::BlobNone, sparse: true, sparse_folders: folders(&["docs"]), recurse_submodules: false, ..Default::default() };
    let args = ops::clone_option_args(t.path(), &options).unwrap();
    assert!(args.contains(&"--sparse".to_string()) && args.contains(&"--filter=blob:none".to_string()));
    let (root, warning) = ops::clone_with_options(&parent, &url, "sparse", &options, |_| {}, None).unwrap();
    assert!(warning.is_none(), "{warning:?}");
    let state = sparse::state(&root).unwrap();
    assert!(state.enabled && state.cone);
    assert_eq!(state.patterns, ["docs"]);
    assert_eq!(state.partial.len(), 1);
    assert_eq!(state.partial[0].remote, "origin");
    assert_eq!(state.partial[0].filter.as_deref(), Some("blob:none"));
    assert!(root.join("README.md").exists() && root.join("docs/guide.md").exists());
    assert!(!root.join("lib").exists());
    assert_no_phantom_deletions(&root);

    // A sparse clone without folders has only the top-level files.
    let top = CloneOptions { sparse: true, recurse_submodules: false, ..Default::default() };
    let (root2, _) = ops::clone_with_options(&parent, &url, "top", &top, |_| {}, None).unwrap();
    assert!(root2.join("README.md").exists() && !root2.join("docs").exists());
    assert!(sparse::state(&root2).unwrap().partial.is_empty(), "a full clone has no promisor remote");

    // Invalid folders are rejected before cloning.
    let bad = CloneOptions { sparse: true, sparse_folders: folders(&["../x"]), ..Default::default() };
    assert_eq!(ops::clone_option_args(t.path(), &bad).unwrap_err().kind, "invalid-sparse-path");
}

#[test]
fn partial_clone_diff_fetches_missing_blobs_lazily() {
    let t = tmp();
    let url = served(t.path());
    let parent = t.path().join("out");
    let options =
        CloneOptions { filter: CloneFilter::BlobNone, sparse: true, sparse_folders: folders(&["app"]), recurse_submodules: false, ..Default::default() };
    let (root, _) = ops::clone_with_options(&parent, &url, "partial", &options, |_| {}, None).unwrap();
    // The old docs blob was never downloaded.
    let old = git(&root, &["rev-parse", "HEAD~1:docs/guide.md"]);
    let listed = git(&root, &["rev-list", "--objects", "--missing=print", "HEAD~1"]);
    assert!(listed.lines().any(|l| l == format!("?{old}")), "blob should be missing before the diff");

    // History and the commit's file list need no blobs.
    let log = git(&root, &["log", "--name-status", "--format=%s", "-n", "1", "HEAD"]);
    assert!(log.contains("docs/guide.md"));

    // Opening the diff of a sparse-excluded file triggers Git's lazy fetch.
    let d = diff::rev_diff(&root, Some("HEAD~1"), "HEAD", "docs/guide.md", &DiffOptions::default()).unwrap();
    assert!(!d.empty, "diff should show the change");
    let text = format!("{:?}", d.hunks);
    assert!(text.contains("g1") && text.contains("g2"), "{text}");
    let listed = git(&root, &["rev-list", "--objects", "--missing=print", "HEAD~1"]);
    assert!(!listed.lines().any(|l| l == format!("?{old}")), "lazy fetch should have downloaded the old blob");
    // Blobs nobody asked for stay missing: the fetch was lazy, not a full download.
    let lib = git(&root, &["rev-parse", "HEAD~1:lib/a.txt"]);
    assert!(listed.lines().any(|l| l == format!("?{lib}")));
    assert_no_phantom_deletions(&root);
}

#[test]
fn cone_changes_never_delete_ignored_files_without_consent() {
    let t = tmp();
    let repo = seed(t.path());
    fs::write(repo.join(".gitignore"), "*.env\nnode_modules/\nbuild/\n").unwrap();
    git(&repo, &["add", ".gitignore"]);
    git(&repo, &["commit", "-q", "-m", "ignore"]);
    let precious = |repo: &Path| {
        for path in ["lib/.env", "lib/node_modules/pkg/index.js", "docs/local.env", "build/out.bin", "app/.env"] {
            let full = repo.join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, "precious\n").unwrap();
        }
    };
    precious(&repo);
    // Keeping `app`: `lib` and `docs` leave with their ignored files; `build` has no tracked
    // files and `app/.env` stays in the cone, so Git does not touch those.
    let e = sparse::set(&repo, true, &folders(&["app"])).unwrap_err();
    assert_eq!(e.kind, "sparse-ignored-files");
    assert_eq!(e.details, ["docs/local.env", "lib/.env", "lib/node_modules/"]);
    assert!(!sparse::state(&repo).unwrap().enabled, "a refused change must not turn sparse checkout on");
    for path in ["lib/.env", "lib/node_modules/pkg/index.js", "docs/local.env", "lib/a.txt"] {
        assert!(repo.join(path).exists(), "{path} must survive a refused change");
    }
    // A folder that also holds an ordinary untracked file is left alone by Git: no warning for it.
    fs::write(repo.join("docs/notes.txt"), "untracked\n").unwrap();
    let e = sparse::set(&repo, true, &folders(&["app"])).unwrap_err();
    assert_eq!(e.details, ["lib/.env", "lib/node_modules/"]);
    // With consent the change runs; what the guard announced is exactly what Git removed.
    sparse::set_with(&repo, true, &folders(&["app"]), true).unwrap();
    assert!(!repo.join("lib").exists());
    assert!(repo.join("docs/local.env").exists() && repo.join("docs/notes.txt").exists());
    assert!(repo.join("build/out.bin").exists() && repo.join("app/.env").exists());
    // Ignored files created later in an excluded folder are deleted by add and reapply too.
    fs::create_dir_all(repo.join("lib")).unwrap();
    fs::write(repo.join("lib/.env"), "again\n").unwrap();
    fs::remove_file(repo.join("docs/notes.txt")).unwrap();
    assert_eq!(sparse::reapply(&repo).unwrap_err().details, ["docs/local.env", "lib/.env"]);
    assert_eq!(sparse::add(&repo, &folders(&["docs"])).unwrap_err().details, ["lib/.env"]);
    assert_eq!(fs::read_to_string(repo.join("lib/.env")).unwrap(), "again\n");
    // Non-cone mode removes tracked files one by one and keeps ignored ones: nothing to confirm.
    sparse::set(&repo, false, &folders(&["/app/"])).unwrap();
    assert_eq!(fs::read_to_string(repo.join("lib/.env")).unwrap(), "again\n");
}
