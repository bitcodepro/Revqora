use std::fs;
use std::path::PathBuf;

use revqora_lib::git::{diff, operations, runner, status};

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("live diff проверка");
        fs::create_dir(&root).unwrap();
        let repo = Self { _temp: temp, root };
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.autocrlf", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            repo.git(&args);
        }
        fs::write(repo.root.join("selected.txt"), "base\n").unwrap();
        repo.git(&["add", "selected.txt"]);
        repo.git(&["commit", "-qm", "Base"]);
        repo
    }
    fn git(&self, args: &[&str]) {
        runner::run(&self.root, args).unwrap();
    }
    fn status(&self) -> status::StatusSummary {
        status::status(&self.root).unwrap()
    }
    fn token(snapshot: &status::StatusSummary) -> &str {
        &snapshot.files.iter().find(|f| f.path == "selected.txt").unwrap().diff_token
    }
}

#[test]
fn unrelated_wal_writes_keep_selected_diff_token_but_not_the_mutation_guard() {
    let repo = Repo::new();
    fs::write(repo.root.join("selected.txt"), "edit\n").unwrap();
    fs::write(repo.root.join("database.sqlite-wal"), "1111").unwrap();
    let before = repo.status();
    let index = fs::read(repo.root.join(".git/index")).unwrap();
    let first = diff::working_diff(&repo.root, "selected.txt", diff::WorkSide::Unstaged, None, false, &diff::DiffOptions::default()).unwrap();
    fs::write(repo.root.join("database.sqlite-wal"), "2222").unwrap();
    let after = repo.status();
    let second = diff::working_diff(&repo.root, "selected.txt", diff::WorkSide::Unstaged, None, false, &diff::DiffOptions::default()).unwrap();
    assert_eq!(Repo::token(&before), Repo::token(&after));
    assert_ne!(before.state_token, after.state_token);
    assert_eq!(first.hash, second.hash);
    assert_eq!(index, fs::read(repo.root.join(".git/index")).unwrap(), "status must remain read-only");
    let error = operations::run(&repo.root, "stage", before.state_token.as_deref(), |_, _| {}, || Ok(())).unwrap_err();
    assert_eq!(error.kind, "stale-operation", "path tokens must never replace the full mutation precondition");
}

#[test]
fn same_status_and_same_length_working_edits_change_the_selected_token() {
    let repo = Repo::new();
    fs::write(repo.root.join("selected.txt"), "aaaa\n").unwrap();
    let before = repo.status();
    fs::write(repo.root.join("selected.txt"), "bbbb\n").unwrap();
    let after = repo.status();
    assert_eq!(before.files[0].worktree, after.files[0].worktree);
    assert_ne!(Repo::token(&before), Repo::token(&after));
    assert_eq!(Repo::token(&after), Repo::token(&repo.status()));
}

#[test]
fn restaging_different_bytes_refreshes_an_already_mm_file() {
    let repo = Repo::new();
    fs::write(repo.root.join("selected.txt"), "staged-one\n").unwrap();
    repo.git(&["add", "selected.txt"]);
    fs::write(repo.root.join("selected.txt"), "working\n").unwrap();
    let before = repo.status();
    fs::write(repo.root.join("selected.txt"), "staged-two\n").unwrap();
    repo.git(&["add", "selected.txt"]);
    fs::write(repo.root.join("selected.txt"), "working\n").unwrap();
    let after = repo.status();
    assert_eq!((&before.files[0].index, &before.files[0].worktree), (&after.files[0].index, &after.files[0].worktree));
    assert_ne!(Repo::token(&before), Repo::token(&after));
}

#[test]
fn attributes_refresh_selected_diffs_even_when_the_attributes_file_is_ignored() {
    let repo = Repo::new();
    fs::write(repo.root.join("selected.txt"), "edit\n").unwrap();
    fs::write(repo.root.join(".git/info/exclude"), ".gitattributes\n").unwrap();
    let before = repo.status();
    fs::write(repo.root.join(".gitattributes"), "*.txt -diff\n").unwrap();
    let after = repo.status();
    assert_eq!(after.files.len(), 1);
    assert_ne!(Repo::token(&before), Repo::token(&after));
    let result = diff::working_diff(&repo.root, "selected.txt", diff::WorkSide::Unstaged, None, false, &diff::DiffOptions::default()).unwrap();
    assert!(result.binary);
}

#[test]
fn indexed_attributes_refresh_a_diff_when_the_worktree_attributes_are_absent() {
    let repo = Repo::new();
    fs::write(repo.root.join("selected.txt"), "edit\n").unwrap();
    fs::write(repo.root.join(".gitattributes"), "*.txt diff\n").unwrap();
    repo.git(&["add", ".gitattributes"]);
    fs::remove_file(repo.root.join(".gitattributes")).unwrap();
    let before = repo.status();
    fs::write(repo.root.join(".gitattributes"), "*.txt -diff\n").unwrap();
    repo.git(&["add", ".gitattributes"]);
    fs::remove_file(repo.root.join(".gitattributes")).unwrap();
    let after = repo.status();
    assert_ne!(Repo::token(&before), Repo::token(&after));
    let result = diff::working_diff(&repo.root, "selected.txt", diff::WorkSide::Unstaged, None, false, &diff::DiffOptions::default()).unwrap();
    assert!(result.binary);
}
