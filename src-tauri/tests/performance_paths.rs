//! Correctness of the batched / cached fast paths (same answers as the slow ones).

use std::path::{Path, PathBuf};
use std::process::Command;

use revqora_lib::git::refs;

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let r = Repo { _temp: temp, root };
        r.git(&["init", "-q", "-b", "main"]);
        r.git(&["config", "user.name", "Test"]);
        r.git(&["config", "user.email", "test@example.com"]);
        r.git(&["config", "commit.gpgsign", "false"]);
        r.write("a.txt", "one\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "base"]);
        r
    }

    fn git(&self, args: &[&str]) -> String {
        git_in(&self.root, args)
    }

    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.root.join(name), text).unwrap();
    }

    fn commit_on(&self, branch: &str, file: &str, text: &str) {
        self.git(&["switch", "-q", branch]);
        self.write(file, text);
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", &format!("{branch} {file}")]);
    }
}

fn git_in(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn squash_merged_branches_are_found_in_one_batch() {
    let r = Repo::new();
    for b in ["squashed", "open", "conflicting", "merged"] {
        r.git(&["branch", b]);
    }
    r.commit_on("squashed", "s.txt", "squash me\n");
    r.commit_on("open", "o.txt", "still open\n");
    r.commit_on("conflicting", "a.txt", "theirs\n");
    r.commit_on("merged", "m.txt", "merged\n");
    r.git(&["switch", "-q", "main"]);
    r.git(&["merge", "-q", "--squash", "squashed"]);
    r.git(&["commit", "-qm", "squash"]);
    r.git(&["merge", "-q", "--no-ff", "-m", "merge", "merged"]);
    r.write("a.txt", "ours\n");
    r.git(&["commit", "-qam", "ours"]);
    let mut found = refs::squash_merged(&r.root).unwrap();
    found.sort();
    // `merged` is an ancestor (an ordinary merge), `open` adds changes, `conflicting` conflicts.
    assert_eq!(found, vec!["squashed".to_string()]);
}

#[test]
fn background_housekeeping_packs_refs_and_writes_commit_graph_without_moving_refs() {
    use revqora_lib::git::optimize;
    let r = Repo::new();
    let refs: String = (0..150).map(|i| format!("create refs/tags/t{i} HEAD\n")).collect();
    let out = Command::new("git").current_dir(&r.root).args(["update-ref", "--stdin"]).stdin(std::process::Stdio::piped()).spawn().and_then(|mut child| {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(refs.as_bytes())?;
        child.wait()
    });
    assert!(out.unwrap().success());
    let listing = r.git(&["for-each-ref", "--format=%(refname) %(objectname)"]);
    let info = r.root.join(".git/objects/info");

    // Housekeeping turned off in Git: nothing is written.
    r.git(&["config", "gc.auto", "0"]);
    optimize::run(&r.root, None);
    assert!(!r.root.join(".git/packed-refs").exists());
    assert!(!info.join("commit-graphs").exists() && !info.join("commit-graph").exists());

    r.git(&["config", "--unset", "gc.auto"]);
    let written = optimize::run(&r.root, None);
    assert!(written.is_some());
    assert!(r.root.join(".git/packed-refs").is_file());
    assert!(info.join("commit-graphs/commit-graph-chain").is_file());
    assert_eq!(r.git(&["for-each-ref", "--format=%(refname) %(objectname)"]), listing);
    // Same refs: the next pass has nothing to write.
    assert!(optimize::run(&r.root, written).is_none());
    r.git(&["commit-graph", "verify"]);
    // Advancing an existing branch adds no ref but still needs a graph refresh.
    r.git(&["commit", "--allow-empty", "-q", "-m", "advance"]);
    let advanced = optimize::run(&r.root, written);
    assert!(advanced.is_some(), "a new commit on an existing branch must refresh the commit-graph");
    assert!(optimize::run(&r.root, advanced).is_none());
    // The branch is a loose ref now: moving it again keeps the ref count and packed-refs.
    r.git(&["commit", "--allow-empty", "-q", "-m", "advance again"]);
    assert!(optimize::run(&r.root, advanced).is_some(), "moving a loose ref must refresh the commit-graph");
}

#[test]
fn deepening_a_shallow_clone_refreshes_cached_ahead_behind_counts() {
    let origin = Repo::new();
    origin.commit_on("main", "b.txt", "two\n");
    let temp = tempfile::tempdir().unwrap();
    let clone = temp.path().join("clone");
    let url = format!("file://{}", origin.root.display().to_string().replace('\\', "/"));
    git_in(temp.path(), &["clone", "-q", "--depth", "1", &url, "clone"]);
    for args in [["config", "user.name", "Test"], ["config", "user.email", "test@example.com"], ["config", "commit.gpgsign", "false"]] {
        git_in(&clone, &args);
    }
    git_in(&clone, &["commit", "--allow-empty", "-qm", "local"]);
    origin.commit_on("main", "c.txt", "three\n");
    git_in(&clone, &["fetch", "-q", "--depth", "1", "origin"]);
    let counts = |root: &Path| {
        let main = refs::snapshot(root).unwrap().local.into_iter().find(|b| b.name == "main").unwrap();
        (main.ahead, main.behind)
    };
    let expected = |root: &Path| {
        let out = git_in(root, &["rev-list", "--left-right", "--count", "main...origin/main"]);
        let mut it = out.split_whitespace().map(|n| n.parse::<u32>().unwrap());
        (it.next().unwrap(), it.next().unwrap())
    };
    assert_eq!(counts(&clone), expected(&clone));
    let tips = git_in(&clone, &["for-each-ref", "--format=%(refname) %(objectname)"]);
    git_in(&clone, &["fetch", "-q", "--unshallow", "origin"]);
    assert_eq!(git_in(&clone, &["for-each-ref", "--format=%(refname) %(objectname)"]), tips, "the tips must not move");
    assert_eq!(counts(&clone), expected(&clone), "cached counts must follow the deeper history");
}

#[test]
fn an_orphan_branch_does_not_hide_squash_merged_branches() {
    let r = Repo::new();
    r.git(&["branch", "squashed"]);
    r.commit_on("squashed", "s.txt", "squash me\n");
    r.git(&["switch", "-q", "main"]);
    r.git(&["merge", "-q", "--squash", "squashed"]);
    r.git(&["commit", "-qm", "squash"]);
    r.git(&["switch", "-q", "--orphan", "gh-pages"]);
    r.git(&["rm", "-rfq", "--ignore-unmatch", "."]);
    r.write("index.html", "site\n");
    r.git(&["add", "index.html"]);
    r.git(&["commit", "-qm", "pages"]);
    r.git(&["switch", "-q", "main"]);
    assert_eq!(refs::squash_merged(&r.root).unwrap(), vec!["squashed".to_string()]);
}

#[test]
fn a_reused_worktree_path_maps_to_its_new_repository() {
    use revqora_lib::git::{graph, repo};
    let a = Repo::new();
    let b = Repo::new();
    let temp = tempfile::tempdir().unwrap();
    let slot = temp.path().join("slot");
    let moved = temp.path().join("moved");
    a.git(&["worktree", "add", "-q", "-b", "wa", slot.to_str().unwrap()]);
    let first = repo::git_dir(&slot).unwrap();
    let canon = |p: std::path::PathBuf| std::fs::canonicalize(p).unwrap();
    assert_eq!(canon(graph::common_dir(&slot).unwrap()), canon(repo::git_dir(&a.root).unwrap()));
    a.git(&["worktree", "move", slot.to_str().unwrap(), moved.to_str().unwrap()]);
    b.git(&["worktree", "add", "-q", "-b", "wb", slot.to_str().unwrap()]);
    // Repository A's worktree Git directory still exists, but the folder is B's now.
    assert!(first.join("HEAD").is_file());
    let b_dir = canon(repo::git_dir(&b.root).unwrap());
    assert!(canon(repo::git_dir(&slot).unwrap()).starts_with(&b_dir), "the cached Git directory still pointed at repository A");
    assert_eq!(canon(graph::common_dir(&slot).unwrap()), b_dir);
}
