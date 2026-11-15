//! Clone options (branch, shallow depth, partial clone filter, submodules) and fetching
//! more history into a shallow clone. Remotes are local bare repositories; no network.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::ops::{self, CloneFilter, CloneOptions};
use revqora_lib::git::runner;

fn git(dir: &Path, args: &[&str]) -> String {
    runner::run(dir, args).unwrap().trim().to_string()
}

fn configure(dir: &Path) {
    for (k, v) in [("user.name", "Tester"), ("user.email", "tester@example.com"), ("core.autocrlf", "false"), ("commit.gpgsign", "false")] {
        git(dir, &["config", k, v]);
    }
}

/// A seed repository with `commits` commits on main and one on `topic`, published to a bare server.
fn server(tmp: &Path, name: &str, commits: usize) -> PathBuf {
    let seed = tmp.join(format!("{name}-seed"));
    fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    configure(&seed);
    for i in 0..commits {
        fs::write(seed.join("a.txt"), format!("{i}\n")).unwrap();
        git(&seed, &["add", "-A"]);
        git(&seed, &["commit", "-q", "-m", &format!("c{i}")]);
    }
    git(&seed, &["checkout", "-q", "-b", "topic"]);
    fs::write(seed.join("topic.txt"), "topic\n").unwrap();
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-q", "-m", "topic"]);
    git(&seed, &["checkout", "-q", "main"]);
    let bare = tmp.join(format!("{name}.git"));
    git(tmp, &["clone", "-q", "--bare", seed.to_str().unwrap(), bare.to_str().unwrap()]);
    bare
}

fn file_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

fn clone(parent: &Path, url: &str, name: &str, options: &CloneOptions) -> runner::GitResult<PathBuf> {
    ops::clone_with_options(parent, url, name, options, |_| {}, None).map(|r| r.0)
}

#[test]
fn default_options_reproduce_plain_clone() {
    let tmp = tempfile::tempdir().unwrap();
    let parent = tmp.path().join("out");
    fs::create_dir_all(&parent).unwrap();
    assert_eq!(ops::clone_option_args(&parent, &CloneOptions::default()).unwrap(), vec!["--recurse-submodules"]);
    let bare = server(tmp.path(), "plain", 3);
    let root = clone(&parent, bare.to_str().unwrap(), "plain", &CloneOptions::default()).unwrap();
    assert_eq!(git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert_eq!(git(&root, &["rev-parse", "--is-shallow-repository"]), "false");
    assert!(!ops::is_shallow(&root).unwrap());
    assert!(ops::fetch_more_history(&root, Some(1), |_| {}).is_err());
}

#[test]
fn branch_option_checks_out_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let bare = server(tmp.path(), "branch", 2);
    let options = CloneOptions { branch: Some("topic".into()), ..Default::default() };
    let root = clone(&tmp.path().join("out"), bare.to_str().unwrap(), "b", &options).unwrap();
    assert_eq!(git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]), "topic");
    assert!(root.join("topic.txt").exists());
}

#[test]
fn depth_gives_shallow_clone_and_history_can_be_fetched() {
    let tmp = tempfile::tempdir().unwrap();
    let bare = server(tmp.path(), "deep", 5);
    let options = CloneOptions { depth: Some(1), ..Default::default() };
    // Local paths ignore --depth; a file:// URL uses the real transport.
    let root = clone(&tmp.path().join("out"), &file_url(&bare), "d", &options).unwrap();
    configure(&root);
    assert!(ops::is_shallow(&root).unwrap());
    assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]), "1");
    // --no-single-branch is on by default: other branches stay visible.
    assert!(!git(&root, &["branch", "-r", "--list", "origin/topic"]).is_empty());
    ops::fetch_more_history(&root, Some(2), |_| {}).unwrap();
    assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]), "3");
    ops::fetch_more_history(&root, None, |_| {}).unwrap();
    assert!(!ops::is_shallow(&root).unwrap());
    assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]), "5");
}

#[test]
fn fetching_more_history_never_prunes_local_tags() {
    let tmp = tempfile::tempdir().unwrap();
    let bare = server(tmp.path(), "tags", 4);
    let root = clone(&tmp.path().join("out"), &file_url(&bare), "t", &CloneOptions { depth: Some(1), ..Default::default() }).unwrap();
    configure(&root);
    // A tag only this clone has, with pruning of tags switched on in its configuration.
    git(&root, &["tag", "local-only"]);
    git(&root, &["config", "fetch.prune", "true"]);
    git(&root, &["config", "fetch.pruneTags", "true"]);
    git(&root, &["config", "remote.origin.prune", "true"]);
    git(&root, &["config", "remote.origin.pruneTags", "true"]);
    ops::fetch_more_history(&root, Some(1), |_| {}).unwrap();
    assert_eq!(git(&root, &["tag", "--list", "local-only"]), "local-only");
    ops::fetch_more_history(&root, None, |_| {}).unwrap();
    assert_eq!(git(&root, &["tag", "--list", "local-only"]), "local-only");
}

#[test]
fn single_branch_shallow_clone_when_toggle_off() {
    let tmp = tempfile::tempdir().unwrap();
    let bare = server(tmp.path(), "single", 2);
    let options = CloneOptions { depth: Some(1), no_single_branch: false, ..Default::default() };
    let root = clone(&tmp.path().join("out"), &file_url(&bare), "s", &options).unwrap();
    assert!(git(&root, &["branch", "-r", "--list", "origin/topic"]).is_empty());
}

#[test]
fn blob_none_filter_makes_partial_clone() {
    let tmp = tempfile::tempdir().unwrap();
    let bare = server(tmp.path(), "partial", 2);
    git(&bare, &["config", "uploadpack.allowFilter", "true"]);
    let options = CloneOptions { filter: CloneFilter::BlobNone, ..Default::default() };
    let root = clone(&tmp.path().join("out"), &file_url(&bare), "p", &options).unwrap();
    assert_eq!(git(&root, &["config", "--get", "remote.origin.promisor"]), "true");
    assert_eq!(git(&root, &["config", "--get", "remote.origin.partialclonefilter"]), "blob:none");
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap().trim(), "1");
    let args = ops::clone_option_args(tmp.path(), &CloneOptions { filter: CloneFilter::TreeZero, ..Default::default() }).unwrap();
    assert!(args.contains(&"--filter=tree:0".to_string()));
}

#[test]
fn recurse_submodules_clones_submodule() {
    let tmp = tempfile::tempdir().unwrap();
    let sub = server(tmp.path(), "sub", 1);
    let seed = tmp.path().join("super-seed");
    fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    configure(&seed);
    git(&seed, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.to_str().unwrap(), "lib"]);
    git(&seed, &["commit", "-q", "-m", "add submodule"]);
    let bare = tmp.path().join("super.git");
    git(tmp.path(), &["clone", "-q", "--bare", seed.to_str().unwrap(), bare.to_str().unwrap()]);
    // Git refuses local file submodules by default (CVE-2022-39253); the option itself is what is tested.
    git(&bare, &["config", "protocol.file.allow", "always"]);
    let out = tmp.path().join("out");
    fs::create_dir_all(&out).unwrap();
    let global = tmp.path().join("gitconfig");
    fs::write(&global, "[protocol \"file\"]\n\tallow = always\n").unwrap();
    // SAFETY: only this test reads GIT_CONFIG_GLOBAL-dependent submodule transport.
    unsafe { std::env::set_var("GIT_CONFIG_GLOBAL", &global) };
    let root = clone(&out, bare.to_str().unwrap(), "super", &CloneOptions::default()).unwrap();
    assert!(root.join("lib").join("a.txt").exists(), "submodule content checked out");
    let plain = clone(&out, bare.to_str().unwrap(), "flat", &CloneOptions { recurse_submodules: false, ..Default::default() }).unwrap();
    assert!(!plain.join("lib").join("a.txt").exists());
}

#[test]
fn shallow_submodules_only_with_depth() {
    let tmp = tempfile::tempdir().unwrap();
    let with = CloneOptions { depth: Some(2), shallow_submodules: true, ..Default::default() };
    assert_eq!(ops::clone_option_args(tmp.path(), &with).unwrap(), vec!["--depth", "2", "--no-single-branch", "--recurse-submodules", "--shallow-submodules"]);
    let without = CloneOptions { shallow_submodules: true, ..Default::default() };
    assert!(!ops::clone_option_args(tmp.path(), &without).unwrap().contains(&"--shallow-submodules".to_string()));
}

#[test]
fn invalid_branch_and_depth_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let bare = server(tmp.path(), "invalid", 1);
    let out = tmp.path().join("out");
    for bad in ["a..b", "has space", "x.lock", "bad~1", "bad:name"] {
        let options = CloneOptions { branch: Some(bad.into()), ..Default::default() };
        assert!(clone(&out, bare.to_str().unwrap(), "x", &options).is_err(), "{bad}");
    }
    let zero = CloneOptions { depth: Some(0), ..Default::default() };
    assert!(clone(&out, bare.to_str().unwrap(), "x", &zero).is_err());
    assert!(!out.join("x").exists());
    // Deserialization accepts only the fixed filter names.
    assert!(serde_json::from_str::<CloneOptions>(r#"{"filter":"sparse:oid=HEAD"}"#).is_err());
    let parsed: CloneOptions = serde_json::from_str(r#"{"filter":"tree:0"}"#).unwrap();
    assert_eq!(parsed.filter, CloneFilter::TreeZero);
    assert!(parsed.recurse_submodules && parsed.no_single_branch);
}

#[test]
fn branch_option_injection_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let bare = server(tmp.path(), "inject", 1);
    let out = tmp.path().join("out");
    let marker = tmp.path().join("pwned");
    for bad in ["--upload-pack=touch pwned", "-b", "--template=."] {
        let options = CloneOptions { branch: Some(bad.into()), ..Default::default() };
        let err = clone(&out, bare.to_str().unwrap(), "x", &options).unwrap_err();
        assert!(err.message.contains("branch"), "{}", err.message);
    }
    assert!(!marker.exists());
    assert!(!out.join("x").exists());
}
