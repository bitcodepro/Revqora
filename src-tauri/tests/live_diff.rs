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
    assert_eq!(before.diff_context_token, after.diff_context_token);
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

#[test]
fn configured_attributes_contents_refresh_working_and_sealed_diffs_without_touching_staging() {
    for absolute in [false, true] {
        let repo = Repo::new();
        let policy = repo.root.join("policy.attrs");
        fs::write(&policy, "*.txt diff\n").unwrap();
        repo.git(&["add", "policy.attrs"]);
        repo.git(&["commit", "-qm", "Track custom attributes"]);
        repo.git(&["config", "core.attributesFile", if absolute { policy.to_str().unwrap() } else { "policy.attrs" }]);
        fs::write(repo.root.join("selected.txt"), "saved edit\n").unwrap();
        repo.git(&["add", "selected.txt"]);
        revqora_lib::git::layers::seal(&repo.root, Some("Configured attributes")).unwrap();
        let layer = revqora_lib::git::layers::state(&repo.root).unwrap().layers.remove(0);
        fs::write(repo.root.join("selected.txt"), "working edit\n").unwrap();
        let before = repo.status();
        let index = fs::read(repo.root.join(".git/index")).unwrap();
        let opts = diff::DiffOptions::default();
        assert!(!diff::working_diff(&repo.root, "selected.txt", diff::WorkSide::Unstaged, None, false, &opts).unwrap().binary);
        assert!(!diff::rev_diff(&repo.root, Some(&layer.from_tree), &layer.to_tree, "selected.txt", &opts).unwrap().binary);
        fs::write(&policy, "*.txt -diff\n").unwrap();
        let after = repo.status();
        assert!(diff::working_diff(&repo.root, "selected.txt", diff::WorkSide::Unstaged, None, false, &opts).unwrap().binary);
        assert!(diff::rev_diff(&repo.root, Some(&layer.from_tree), &layer.to_tree, "selected.txt", &opts).unwrap().binary);
        assert_ne!(Repo::token(&before), Repo::token(&after), "Configured attributes must invalidate the selected path; absolute={absolute}");
        assert_ne!(before.diff_context_token, after.diff_context_token);
        let error = operations::run(&repo.root, "stage", before.state_token.as_deref(), |_, _| {}, || Ok(())).unwrap_err();
        assert_eq!(error.kind, "stale-operation");
        fs::write(repo.root.join("noise.sqlite-wal"), "noise\n").unwrap();
        let noise = repo.status();
        assert_eq!(Repo::token(&after), Repo::token(&noise));
        assert_eq!(after.diff_context_token, noise.diff_context_token);
        let unchanged = revqora_lib::git::layers::state(&repo.root).unwrap().layers.remove(0);
        assert_eq!((layer.from_tree, layer.to_tree), (unchanged.from_tree, unchanged.to_tree));
        assert_eq!(index, fs::read(repo.root.join(".git/index")).unwrap());
    }
}

fn submodule_repo() -> (Repo, PathBuf, Vec<String>) {
    let repo = Repo::new();
    let module = repo.root.join("module");
    fs::create_dir(&module).unwrap();
    let git = |args: &[&str]| runner::run(&module, args).unwrap().trim().to_string();
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.name", "Tester"]);
    git(&["config", "user.email", "test@example.com"]);
    git(&["config", "commit.gpgsign", "false"]);
    git(&["config", "core.autocrlf", "false"]);
    git(&["config", "core.hooksPath", ".git/hooks"]);
    let mut commits = Vec::new();
    for value in ["A", "B", "C"] {
        fs::write(module.join("file.txt"), value).unwrap();
        git(&["add", "file.txt"]);
        git(&["commit", "-qm", value]);
        commits.push(git(&["rev-parse", "HEAD"]));
    }
    git(&["checkout", "-q", &commits[0]]);
    fs::write(repo.root.join(".gitmodules"), "[submodule \"module\"]\n\tpath = module\n\turl = unused\n").unwrap();
    repo.git(&["add", ".gitmodules", "module"]);
    repo.git(&["commit", "-qm", "Record module A"]);
    repo.git(&["submodule", "absorbgitdirs", "module"]);
    assert!(module.join(".git").is_file());
    (repo, module, commits)
}

#[test]
fn an_already_changed_submodule_refreshes_when_its_head_moves_from_b_to_c() {
    let (repo, module, commits) = submodule_repo();
    let git = |args: &[&str]| runner::run(&module, args).unwrap().trim().to_string();
    git(&["checkout", "-q", &commits[1]]);
    let before = repo.status();
    let before_raw = runner::run(&repo.root, ["status", "--porcelain=v2", "-z"]).unwrap();
    let first = diff::working_diff(&repo.root, "module", diff::WorkSide::Unstaged, None, false, &diff::DiffOptions::default()).unwrap();
    git(&["checkout", "-q", &commits[2]]);
    let after = repo.status();
    let after_raw = runner::run(&repo.root, ["status", "--porcelain=v2", "-z"]).unwrap();
    let second = diff::working_diff(&repo.root, "module", diff::WorkSide::Unstaged, None, false, &diff::DiffOptions::default()).unwrap();
    assert_eq!(before_raw, after_raw, "the reproduction needs identical SC.. flags and parent gitlink OIDs");
    assert_ne!(first.hash, second.hash, "Git must show the different submodule commit");
    let token = |s: &status::StatusSummary| s.files.iter().find(|f| f.path == "module").unwrap().diff_token.clone();
    assert_ne!(token(&before), token(&after), "a directory marker alone cannot identify a submodule diff");
    assert_ne!(before.state_token, after.state_token);
}

#[test]
fn inline_submodule_diff_refreshes_for_an_already_dirty_file_without_a_head_change() {
    let (repo, module, _) = submodule_repo();
    repo.git(&["config", "diff.submodule", "diff"]);
    fs::write(module.join("file.txt"), "dirty-one\n").unwrap();
    let before = repo.status();
    let raw_before = runner::run(&repo.root, ["status", "--porcelain=v2", "-z"]).unwrap();
    let first = diff::working_raw(&repo.root, "module", diff::WorkSide::Unstaged, None, false, &diff::DiffOptions::default()).unwrap();
    fs::write(module.join("file.txt"), "dirty-two\n").unwrap();
    let after = repo.status();
    let second = diff::working_raw(&repo.root, "module", diff::WorkSide::Unstaged, None, false, &diff::DiffOptions::default()).unwrap();
    assert_eq!(raw_before, runner::run(&repo.root, ["status", "--porcelain=v2", "-z"]).unwrap());
    assert_ne!(first, second, "inline Git diff must include the new working content");
    let token = |s: &status::StatusSummary| s.files.iter().find(|f| f.path == "module").unwrap().diff_token.clone();
    assert_ne!(token(&before), token(&after), "HEAD alone does not describe an inline submodule diff");
    fs::write(repo.root.join("outside.sqlite-wal"), "unrelated\n").unwrap();
    assert_eq!(token(&after), token(&repo.status()));
    fs::write(module.join("inside.sqlite-wal"), "1111").unwrap();
    let untracked = repo.status();
    fs::write(module.join("inside.sqlite-wal"), "2222").unwrap();
    assert_eq!(token(&untracked), token(&repo.status()), "untracked bytes are not part of the inline diff");
}

#[test]
fn sealed_layer_context_changes_with_working_and_indexed_attributes_but_not_file_edits() {
    let repo = Repo::new();
    fs::write(repo.root.join("selected.txt"), "layer\n").unwrap();
    repo.git(&["add", "selected.txt"]);
    revqora_lib::git::layers::seal(&repo.root, Some("Saved text")).unwrap();
    let before = repo.status();
    let layer = revqora_lib::git::layers::state(&repo.root).unwrap().layers.remove(0);
    let text = diff::rev_diff(&repo.root, Some(&layer.from_tree), &layer.to_tree, "selected.txt", &diff::DiffOptions::default()).unwrap();
    assert!(!text.binary && !text.hunks.is_empty());
    fs::write(repo.root.join(".gitattributes"), "*.txt -diff\n").unwrap();
    let binary = repo.status();
    assert_ne!(before.diff_context_token, binary.diff_context_token);
    assert!(diff::rev_diff(&repo.root, Some(&layer.from_tree), &layer.to_tree, "selected.txt", &diff::DiffOptions::default()).unwrap().binary);
    fs::write(repo.root.join("selected.txt"), "ordinary unstaged edit\n").unwrap();
    let working = repo.status();
    assert_eq!(binary.diff_context_token, working.diff_context_token);
    repo.git(&["add", ".gitattributes"]);
    fs::remove_file(repo.root.join(".gitattributes")).unwrap();
    let indexed = repo.status();
    fs::write(repo.root.join(".gitattributes"), "*.txt diff\n").unwrap();
    repo.git(&["add", ".gitattributes"]);
    fs::remove_file(repo.root.join(".gitattributes")).unwrap();
    assert_ne!(indexed.diff_context_token, repo.status().diff_context_token);
    let unchanged = revqora_lib::git::layers::state(&repo.root).unwrap().layers.remove(0);
    assert_eq!((layer.from_tree, layer.to_tree), (unchanged.from_tree, unchanged.to_tree));
}
