use super::*;
#[test]
fn new_layers_never_follow_dangling_aliases_or_form_cross_stack_cycles() {
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    let main = heads(r).unwrap()["main"].clone();
    runner::run(r, ["symbolic-ref", "refs/heads/alias", "refs/heads/missing"]).unwrap();
    let s = snapshot(r).unwrap();
    assert!(append(r, &id, "alias", false, &s.catalog.revision, &s.state_token).is_err());
    assert_eq!(runner::run(r, ["symbolic-ref", "refs/heads/alias"]).unwrap().trim(), "refs/heads/missing");
    assert!(!heads(r).unwrap().contains_key("missing"));
    assert_eq!(heads(r).unwrap()["main"], main);
    add(r, &id, "first", false);
    assert!(create(r, "Invalid dependent stack", "first", &catalog(r).unwrap().revision).is_err());
    #[cfg(windows)]
    {
        let s = snapshot(r).unwrap();
        assert!(append(r, &id, "MAIN", false, &s.catalog.revision, &s.state_token).is_err());
        assert_eq!(heads(r).unwrap()["main"], main);
    }
}
#[test]
fn another_checked_out_copy_blocks_branch_rewriting() {
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    add(r, &id, "first", false);
    commit(r, "parent.txt", "parent moved");
    runner::run(r, ["switch", "first"]).unwrap();
    let other = tempfile::tempdir().unwrap();
    let path = other.path().join("copy");
    runner::run(r, ["worktree", "add", "--force", path.to_str().unwrap(), "first"]).unwrap();
    assert!(review(r, &id, 0, &[]).unwrap_err().message.contains("another worktree"));
}
fn fixture() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    runner::run(r, ["init", "-qb", "main"]).unwrap();
    for (k, v) in [("user.name", "Stack fixture"), ("user.email", "stack@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", ".git/hooks")] {
        runner::run(r, ["config", k, v]).unwrap();
    }
    commit(r, "base.txt", "base");
    d
}
fn commit(r: &Path, file: &str, value: &str) {
    fs::write(r.join(file), value).unwrap();
    runner::run(r, ["add", "."]).unwrap();
    runner::run(r, ["commit", "-qm", value]).unwrap();
}
fn initial(r: &Path) -> String {
    let c = catalog(r).unwrap();
    let c = create(r, "Feature stack", "main", &c.revision).unwrap();
    c.stacks[0].id.clone()
}
fn add(r: &Path, id: &str, name: &str, existing: bool) {
    let s = snapshot(r).unwrap();
    append(r, id, name, existing, &s.catalog.revision, &s.state_token).unwrap();
}
#[test]
fn creation_adoption_and_catalogue_cas_preserve_working_files() {
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    let old = catalog(r).unwrap().revision;
    fs::write(r.join("dirty.txt"), "keep me").unwrap();
    add(r, &id, "first", false);
    assert_eq!(status::status(r).unwrap().branch.as_deref(), Some("main"));
    assert_eq!(fs::read_to_string(r.join("dirty.txt")).unwrap(), "keep me");
    assert!(forget(r, &id, &old).is_err());
    assert!(append(r, &id, "first", false, &catalog(r).unwrap().revision, &snapshot(r).unwrap().state_token).is_err());
    forget(r, &id, &catalog(r).unwrap().revision).unwrap();
    assert!(heads(r).unwrap().contains_key("first"));
}
#[test]
fn restack_preserves_child_own_commits_after_parent_rewrite() {
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    add(r, &id, "first", false);
    runner::run(r, ["switch", "first"]).unwrap();
    commit(r, "first.txt", "first work");
    add(r, &id, "second", false);
    runner::run(r, ["switch", "second"]).unwrap();
    commit(r, "second.txt", "second work");
    let old_first = heads(r).unwrap()["first"].clone();
    runner::run(r, ["switch", "main"]).unwrap();
    commit(r, "main.txt", "main work");
    runner::run(r, ["switch", "first"]).unwrap();
    let p = review(r, &id, 0, &[]).unwrap();
    assert!(restack(r, &p, false, false).is_err());
    let outcome = restack(r, &p, true, false).unwrap();
    assert_eq!(outcome.phase, "completed");
    let s = snapshot(r).unwrap();
    assert_ne!(s.tips["first"], old_first);
    assert_eq!(s.catalog.stacks[0].entries[1].boundary, old_first);
    runner::run(r, ["switch", "second"]).unwrap();
    let p = review(r, &id, 1, &[]).unwrap();
    assert_eq!(p.commits, 1);
    let base = heads(r).unwrap()["main"].clone();
    assert_eq!(restack(r, &p, true, false).unwrap().phase, "completed");
    assert_eq!(heads(r).unwrap()["main"], base);
    assert_eq!(fs::read_to_string(r.join("first.txt")).unwrap(), "first work");
    assert_eq!(fs::read_to_string(r.join("second.txt")).unwrap(), "second work");
    assert_eq!(fs::read_to_string(r.join("main.txt")).unwrap(), "main work");
    assert!(restack(r, &p, true, false).is_err());
}
#[test]
fn stale_dirty_symbolic_and_protected_layers_never_rewrite() {
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    add(r, &id, "first", false);
    commit(r, "main.txt", "main moved");
    runner::run(r, ["switch", "first"]).unwrap();
    let p = review(r, &id, 0, &[]).unwrap();
    assert!(review(r, &id, 0, &["first".into()]).is_err());
    fs::write(r.join("dirty.txt"), "keep").unwrap();
    assert!(restack(r, &p, true, true).is_err());
    fs::remove_file(r.join("dirty.txt")).unwrap();
    runner::run(r, ["switch", "main"]).unwrap();
    runner::run(r, ["symbolic-ref", "refs/heads/alias", "refs/heads/main"]).unwrap();
    let s = snapshot(r).unwrap();
    assert!(!s.tips.contains_key("alias"));
    assert!(append(r, &id, "alias", true, &s.catalog.revision, &s.state_token).is_err());
}
#[test]
fn conflicting_rebase_remains_pending_until_explicit_abort_acknowledgement() {
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    add(r, &id, "first", false);
    runner::run(r, ["switch", "first"]).unwrap();
    commit(r, "base.txt", "child edit");
    runner::run(r, ["switch", "main"]).unwrap();
    commit(r, "base.txt", "parent edit");
    runner::run(r, ["switch", "first"]).unwrap();
    let old = heads(r).unwrap()["first"].clone();
    let p = review(r, &id, 0, &[]).unwrap();
    assert_eq!(restack(r, &p, true, false).unwrap().phase, "paused");
    assert!(catalog(r).unwrap().stacks[0].entries[0].pending.is_some());
    assert!(review(r, &id, 0, &[]).is_err());
    runner::run(r, ["rebase", "--abort"]).unwrap();
    let s = snapshot(r).unwrap();
    assert!(finalize(r, &id, 0, &s.catalog.revision, &s.state_token, false).is_err());
    finalize(r, &id, 0, &s.catalog.revision, &s.state_token, true).unwrap();
    assert_eq!(heads(r).unwrap()["first"], old);
    assert!(catalog(r).unwrap().stacks[0].entries[0].pending.is_none());
}

#[test]
fn ignored_collisions_and_hidden_index_flags_block_before_rebase() {
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    add(r, &id, "first", false);
    fs::write(r.join(".git/info/exclude"), "cache.txt\n").unwrap();
    fs::write(r.join("cache.txt"), "parent cache").unwrap();
    runner::run(r, ["add", "-f", "cache.txt"]).unwrap();
    runner::run(r, ["commit", "-qm", "parent cache"]).unwrap();
    runner::run(r, ["switch", "first"]).unwrap();
    fs::write(r.join("cache.txt"), "private ignored data").unwrap();
    assert!(status::status(r).unwrap().files.is_empty());
    assert!(review(r, &id, 0, &[]).unwrap_err().message.contains("ignored"));
    assert_eq!(fs::read_to_string(r.join("cache.txt")).unwrap(), "private ignored data");
    fs::remove_file(r.join("cache.txt")).unwrap();
    runner::run(r, ["update-index", "--assume-unchanged", "base.txt"]).unwrap();
    assert!(review(r, &id, 0, &[]).unwrap_err().message.contains("assume-unchanged"));
}
#[test]
fn publication_consent_is_required_and_remote_refs_are_never_rewritten() {
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    add(r, &id, "first", false);
    runner::run(r, ["switch", "first"]).unwrap();
    commit(r, "first.txt", "first work");
    let old = heads(r).unwrap()["first"].clone();
    runner::run(r, ["update-ref", "refs/remotes/origin/first", &old]).unwrap();
    runner::run(r, ["switch", "main"]).unwrap();
    commit(r, "next.txt", "new parent");
    runner::run(r, ["switch", "first"]).unwrap();
    let p = review(r, &id, 0, &[]).unwrap();
    assert!(p.published);
    assert!(restack(r, &p, true, false).is_err());
    restack(r, &p, true, true).unwrap();
    assert_eq!(runner::run(r, ["rev-parse", "refs/remotes/origin/first"]).unwrap().trim(), old);
}
#[test]
fn stack_catalogue_can_be_replaced_with_a_reader_open() {
    let d = fixture();
    let r = d.path();
    initial(r);
    let mut old = fs::File::open(dir(r).unwrap().join("definitions.json")).unwrap();
    let before = catalog(r).unwrap();
    let after = create(r, "Second stack", "main", &before.revision).unwrap();
    let old: Vec<Stack> = serde_json::from_reader(&mut old).unwrap();
    assert_eq!(old.len(), 1);
    assert_eq!(after.stacks.len(), 2);
}
#[test]
fn merged_bottom_layer_requires_the_actual_merge_receipt_and_preserves_a_squashed_boundary() {
    use crate::git::{
        forge_accounts as accounts,
        forge_test_http::{metadata, Http, SERIAL},
    };
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let _serial = SERIAL.lock();
    let d = fixture();
    let r = d.path();
    let id = initial(r);
    add(r, &id, "first", false);
    runner::run(r, ["switch", "first"]).unwrap();
    commit(r, "first.txt", "first work");
    let first = heads(r).unwrap()["first"].clone();
    add(r, &id, "second", false);
    runner::run(r, ["switch", "second"]).unwrap();
    commit(r, "second.txt", "second work");
    runner::run(r, ["switch", "-c", "server-merged", "main"]).unwrap();
    fs::write(r.join("first.txt"), "first work").unwrap();
    runner::run(r, ["add", "."]).unwrap();
    // Identical content/parent/message and second-resolution timestamps can
    // reproduce the original commit on fast runners. A squash receipt must
    // have the same tree but a distinct identity regardless of wall-clock time.
    runner::run(r, ["commit", "-qm", "Squash merge first layer"]).unwrap();
    let merged = heads(r).unwrap()["server-merged"].clone();
    runner::run(r, ["switch", "main"]).unwrap();
    assert_ne!(first, merged);
    assert_eq!(runner::run(r, ["rev-parse", &format!("{first}^{{tree}}")]).unwrap(), runner::run(r, ["rev-parse", &format!("{merged}^{{tree}}")]).unwrap());
    assert!(!ancestor(r, &first, &merged).unwrap());
    let is_merged = Arc::new(AtomicBool::new(false));
    let state = is_merged.clone();
    let source = first.clone();
    let receipt = merged.clone();
    let http = Http::new(move |req| {
        let h = "Content-Type: application/json\r\n".to_string();
        if req.path.ends_with("/user") {
            return (200, h, json!({"id":20,"login":"stack-tester"}).to_string());
        }
        let mut v = metadata("github", "First layer", "", "main", 1);
        v["head"]["ref"] = json!("first");
        v["head"]["sha"] = json!(source);
        if state.load(Ordering::Acquire) {
            v["state"] = json!("closed");
            v["merged"] = json!(true);
            v["merge_commit_sha"] = json!(receipt);
        }
        (200, h, v.to_string())
    });
    runner::run(r, ["remote", "add", "origin", &format!("{}/team/repo.git", http.url)]).unwrap();
    let manager = accounts::manager().unwrap();
    let a = manager
        .add(
            accounts::Add {
                id: None,
                kind: "github".into(),
                server: http.url.clone(),
                username: String::new(),
                token: "offline-stack-token".into(),
                auth_mode: "token".into(),
                persist: false,
            },
            &manager.snapshot().unwrap().revision,
        )
        .unwrap();
    let account = a.accounts.iter().find(|a| a.profile.server.server == http.url).unwrap().profile.id.clone();
    let c = accounts::connections(r).unwrap();
    accounts::select(
        r,
        accounts::Selection {
            remote: "origin".into(),
            fingerprint: c.remotes[0].fingerprint.clone(),
            account_id: Some(account.clone()),
            allow_ssh_alias: false,
        },
        &c.revision,
    )
    .unwrap();
    link_pull(r, &id, 0, 7, &catalog(r).unwrap().revision).unwrap();
    is_merged.store(true, Ordering::Release);
    let connection = forge::detect(r).unwrap().unwrap().connection_revision.unwrap();
    let pull = pr_center::detail(r, 7, &connection).unwrap();
    let revision = catalog(r).unwrap().revision;
    assert!(retire_bottom(r, &id, &revision, &connection, &pull.revision, true).is_err());
    assert_eq!(catalog(r).unwrap().stacks[0].entries.len(), 2);
    runner::run(r, ["switch", "server-merged"]).unwrap();
    runner::run(r, ["branch", "-f", "main", "server-merged"]).unwrap();
    runner::run(r, ["switch", "second"]).unwrap();
    let updated = retire_bottom(r, &id, &revision, &connection, &pull.revision, true).unwrap();
    assert_eq!(updated.stacks[0].entries[0].boundary, first);
    let plan = review(r, &id, 0, &[]).unwrap();
    assert_eq!(plan.commits, 1);
    restack(r, &plan, true, false).unwrap();
    assert_eq!(runner::run(r, ["rev-list", "--count", "main..second"]).unwrap().trim(), "1");
    assert!(r.join("first.txt").exists() && r.join("second.txt").exists());
    assert!(heads(r).unwrap().contains_key("first"));
    manager.remove(&account, &manager.snapshot().unwrap().revision).unwrap();
}
