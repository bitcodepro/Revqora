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
}
