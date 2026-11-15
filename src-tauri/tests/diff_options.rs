//! Diff algorithm and blank-line options reach Git; unknown algorithms are refused.
use std::fs;
use std::path::Path;

use revqora_lib::git::diff::{self, DiffOptions, WorkSide};
use revqora_lib::git::runner;

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "Tester"],
        &["config", "user.email", "tester@example.com"],
        &["config", "core.autocrlf", "false"],
    ] {
        runner::run(dir.path(), args).unwrap();
    }
    dir
}
fn commit(root: &Path, text: &str) {
    fs::write(root.join("f.txt"), text).unwrap();
    runner::run(root, ["add", "-A"]).unwrap();
    runner::run(root, ["commit", "-q", "-m", "c"]).unwrap();
}
fn opts(json: &str) -> DiffOptions {
    serde_json::from_str(json).unwrap()
}

#[test]
fn ignore_blank_lines_hides_blank_only_changes() {
    let dir = repo();
    let root = dir.path();
    commit(root, "a\nb\n");
    fs::write(root.join("f.txt"), "a\n\n\nb\n").unwrap();
    let plain = diff::working_diff(root, "f.txt", WorkSide::Unstaged, None, false, &opts("{}")).unwrap();
    assert_eq!(plain.additions, 2);
    let quiet = diff::working_diff(root, "f.txt", WorkSide::Unstaged, None, false, &opts(r#"{"ignoreBlankLines":true}"#)).unwrap();
    assert_eq!(quiet.additions, 0, "{quiet:?}");
}

#[test]
fn unknown_algorithms_and_injected_values_do_not_deserialize() {
    assert!(serde_json::from_str::<DiffOptions>(r#"{"algorithm":"--output=x"}"#).is_err());
    assert!(serde_json::from_str::<DiffOptions>(r#"{"algorithm":"patience --output=x"}"#).is_err());
    assert!(serde_json::from_str::<DiffOptions>(r#"{"algorithm":"patience"}"#).is_ok());
}
