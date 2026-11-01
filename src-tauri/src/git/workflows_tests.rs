use super::*;
use crate::git::runner;
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    runner::run(r, ["init", "-qb", "main"]).unwrap();
    for (k, v) in [("user.name", "Workflow fixture"), ("user.email", "workflow@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", ".git/hooks")]
    {
        runner::run(r, ["config", k, v]).unwrap();
    }
    fs::write(r.join("base.txt"), "original\n").unwrap();
    runner::run(r, ["add", "."]).unwrap();
    runner::run(r, ["commit", "-qm", "base"]).unwrap();
    d
}
fn step(kind: &str, value: &str, extra: &str) -> Step {
    Step {
        kind: kind.into(),
        label: kind.into(),
        value: value.into(),
        extra: extra.into(),
        body: String::new(),
        timeout_seconds: 15,
        when: "always".into(),
        on_false: "stop".into(),
    }
}
fn recipe(root: &Path, steps: Vec<Step>) -> (Catalog, String) {
    let c = catalog(root).unwrap();
    let c = save_definition(root, Definition { id: String::new(), name: "Fixture workflow".into(), steps }, &c.revision).unwrap();
    let id = c.definitions.last().unwrap().id.clone();
    (c, id)
}
fn start(root: &Path, steps: Vec<Step>) -> Run {
    let (c, id) = recipe(root, steps);
    begin(root, &id, &c.revision, Parameters { branch: "feature/workflow".into(), base: "main".into() }).unwrap()
}
fn wait(root: &Path, id: &str) -> Run {
    let end = std::time::Instant::now() + Duration::from_secs(40);
    loop {
        let r = get(root, id).unwrap();
        let working = jobs().lock().get(&operations::repository_key(root)).is_some_and(|j| !j.finished.load(Ordering::Acquire));
        if !matches!(r.phase.as_str(), "running" | "stopping") && !working {
            return r;
        }
        assert!(std::time::Instant::now() < end, "Workflow stuck: {r:?}");
        thread::sleep(Duration::from_millis(25));
    }
}
fn next(root: &Path, r: &Run) -> Run {
    let p = review(root, &r.id).unwrap();
    execute(root.to_owned(), p, true).unwrap();
    wait(root, &r.id)
}

#[test]
fn definitions_are_validated_and_compare_and_swap_preserves_other_editors() {
    let r = repo();
    let before = catalog(r.path()).unwrap();
    let (c, id) = recipe(r.path(), vec![step("checkClean", "", "")]);
    let mut d = c.definitions[0].clone();
    d.steps.push(step("command", "echo test", ""));
    assert!(save_definition(r.path(), d.clone(), &before.revision).is_err());
    d.steps[1].when = "unknown".into();
    assert!(save_definition(r.path(), d, &c.revision).is_err());
    assert_eq!(catalog(r.path()).unwrap().definitions[0].steps.len(), 1);
    assert!(delete_definition(r.path(), &id, &before.revision).is_err());
    delete_definition(r.path(), &id, &c.revision).unwrap();
    assert!(catalog(r.path()).unwrap().definitions.is_empty());
}
#[test]
fn ordered_checks_branch_and_command_keep_base_and_reject_replayed_reviews() {
    let r = repo();
    let head = runner::run(r.path(), ["rev-parse", "main"]).unwrap();
    let run = start(r.path(), vec![step("checkClean", "", ""), step("branch", "${branch}", "${base}"), step("command", "echo workflow-passed", "")]);
    let proof = review(r.path(), &run.id).unwrap();
    execute(r.path().into(), proof.clone(), false).unwrap();
    let run = wait(r.path(), &run.id);
    assert_eq!(run.cursor, 1);
    assert!(execute(r.path().into(), proof, true).is_err());
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "ready", "{run:?}");
    assert_eq!(runner::run(r.path(), ["branch", "--show-current"]).unwrap().trim(), "feature/workflow");
    let proof = review(r.path(), &run.id).unwrap();
    assert!(execute(r.path().into(), proof, false).is_err());
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "completed", "{run:?}");
    assert!(run.results[2].stdout.contains("workflow-passed"));
    assert_eq!(runner::run(r.path(), ["rev-parse", "main"]).unwrap(), head);
    // Completed cache must not resurrect a previous ready run after stop/forget.
    forget(r.path(), &run.id).unwrap();
    assert!(runs(r.path()).unwrap().is_empty());
}
#[test]
fn false_command_conditions_never_start_the_process_and_stop_is_terminal() {
    let r = repo();
    let mut s = step("command", "echo forbidden > sentinel.txt", "");
    s.when = "dirty".into();
    s.on_false = "skip".into();
    let run = start(r.path(), vec![s.clone(), step("checkBranch", "wrong", "")]);
    let run = next(r.path(), &run);
    assert_eq!(run.results[0].phase, "skipped");
    assert!(!r.path().join("sentinel.txt").exists());
    assert!(validation::report(r.path()).is_none());
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed");
    assert_eq!(run.cursor, 1);
    assert!(review(r.path(), &run.id).is_err());
    s.on_false = "stop".into();
    let run = start(r.path(), vec![s]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed");
    assert!(!r.path().join("sentinel.txt").exists());
    assert!(validation::report(r.path()).is_none());
    let run = start(r.path(), vec![step("checkClean", "", "")]);
    stop(r.path(), &run.id).unwrap();
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "cancelled");
}
#[test]
fn stale_working_files_invalidate_review_before_any_branch_creation() {
    let r = repo();
    let run = start(r.path(), vec![step("branch", "${branch}", "main")]);
    let p = review(r.path(), &run.id).unwrap();
    fs::write(r.path().join("external.txt"), "IDE change").unwrap();
    execute(r.path().into(), p, true).unwrap();
    let run = wait(r.path(), &run.id);
    assert_eq!(run.phase, "failed", "{run:?}");
    assert!(!runner::exec(r.path(), ["show-ref", "--verify", "--quiet", "refs/heads/feature/workflow"]).unwrap().ok());
    assert_eq!(fs::read_to_string(r.path().join("external.txt")).unwrap(), "IDE change");
}
#[test]
fn linked_worktree_cannot_use_another_working_directorys_review() {
    let r = repo();
    let parent = tempfile::tempdir().unwrap();
    let other = parent.path().join("copy");
    runner::run(r.path(), ["worktree", "add", "--detach", other.to_str().unwrap(), "HEAD"]).unwrap();
    let run = start(r.path(), vec![step("checkClean", "", "")]);
    let p = review(r.path(), &run.id).unwrap();
    assert!(review(&other, &run.id).is_err());
    assert!(execute(other, p, true).is_err());
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "ready");
}
#[test]
fn failed_checks_keep_logs_and_do_not_run_later_steps() {
    let r = repo();
    let run = start(r.path(), vec![step("command", "echo failed-check && exit 7", ""), step("branch", "must-not-exist", "main")]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed", "{run:?}");
    assert_eq!(run.results[0].exit_code, Some(7));
    assert!(run.results[0].stdout.contains("failed-check"));
    assert_eq!(run.results[1].phase, "pending");
    assert!(review(r.path(), &run.id).is_err());
}
#[test]
fn interrupted_marker_blocks_replay_and_requires_manual_acknowledgement() {
    let r = repo();
    let mut run = start(r.path(), vec![step("command", "echo must-not-run", "")]);
    run.phase = "running".into();
    run.results[0].phase = "running".into();
    write(&path(r.path(), &run.id).unwrap(), &run).unwrap();
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "interrupted");
    assert!(review(r.path(), &run.id).is_err());
    assert!(forget(r.path(), &run.id).is_err());
    assert!(start_result(r.path()).is_err());
    assert!(acknowledge(r.path(), &run.id, false).is_err());
    acknowledge(r.path(), &run.id, true).unwrap();
    assert_eq!(get(r.path(), &run.id).unwrap().phase, "abandoned");
    assert!(start_result(r.path()).is_ok());
}
fn start_result(root: &Path) -> GitResult<Run> {
    let c = catalog(root)?;
    begin(root, &c.definitions[0].id, &c.revision, Parameters { branch: String::new(), base: String::new() })
}
#[test]
fn escaped_logs_roundtrip_and_oversize_write_preserves_previous_record() {
    let r = repo();
    let mut run = start(r.path(), vec![step("checkClean", "", ""); 16]);
    for row in &mut run.results {
        row.stdout = "\0".repeat(8192);
        row.stderr = "\u{1}".repeat(8192);
    }
    let p = path(r.path(), &run.id).unwrap();
    write(&p, &run).unwrap();
    assert_eq!(get(r.path(), &run.id).unwrap().results[15].stderr, run.results[15].stderr);
    let old = fs::read(&p).unwrap();
    run.results[0].stdout = "x".repeat(LIMIT + 1);
    assert!(write(&p, &run).is_err());
    assert_eq!(fs::read(p).unwrap(), old);
    let (text, truncated) = clip(&"🌿".repeat(3000));
    assert!(text.len() <= 8192 && truncated);
}
#[test]
fn publication_uses_exact_source_and_destination_without_following_tags_or_rewriting_history() {
    let r = repo();
    let server = tempfile::tempdir().unwrap();
    runner::run(server.path(), ["init", "--bare", "-q"]).unwrap();
    runner::run(r.path(), ["remote", "add", "origin", server.path().to_str().unwrap()]).unwrap();
    runner::run(r.path(), ["config", "push.followTags", "true"]).unwrap();
    runner::run(r.path(), ["tag", "-a", "private-tag", "-m", "keep local"]).unwrap();
    let run = start(r.path(), vec![step("publish", "origin", "feature/workflow")]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "completed", "{run:?}");
    assert_eq!(runner::run(server.path(), ["rev-parse", "feature/workflow"]).unwrap(), runner::run(r.path(), ["rev-parse", "HEAD"]).unwrap());
    assert!(runner::run(server.path(), ["tag"]).unwrap().is_empty());
    // Even a locally replaced parent cannot turn unrelated history into a safe push.
    let run = start(r.path(), vec![step("publish", "origin", "feature/workflow")]);
    let p = review(r.path(), &run.id).unwrap();
    let blob = runner::run(r.path(), ["hash-object", "base.txt"]).unwrap();
    runner::run(r.path(), ["update-ref", "refs/heads/main", p.head.as_ref().unwrap()]).unwrap();
    runner::run(r.path(), ["update-ref", "refs/replace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", blob.trim()]).unwrap();
    assert!(review(r.path(), &run.id).is_err());
}

#[test]
fn cherry_pick_conflict_stops_later_steps_and_keeps_a_recovery_checkpoint() {
    let r = repo();
    runner::run(r.path(), ["switch", "-c", "topic"]).unwrap();
    fs::write(r.path().join("base.txt"), "topic edit\n").unwrap();
    runner::run(r.path(), ["commit", "-am", "topic edit"]).unwrap();
    let topic = runner::run(r.path(), ["rev-parse", "HEAD"]).unwrap();
    runner::run(r.path(), ["switch", "main"]).unwrap();
    fs::write(r.path().join("base.txt"), "main edit\n").unwrap();
    runner::run(r.path(), ["commit", "-am", "main edit"]).unwrap();
    let run = start(r.path(), vec![step("cherryPick", topic.trim(), ""), step("command", "echo forbidden > sentinel.txt", "")]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed", "{run:?}");
    assert!(!r.path().join("sentinel.txt").exists());
    assert_eq!(run.results[1].phase, "pending");
    assert!(runner::run(r.path(), ["ls-files", "--unmerged"]).unwrap().contains("base.txt"));
    assert!(!crate::git::recovery::list(r.path()).unwrap().checkpoints.is_empty());
}
#[test]
fn branch_checkout_does_not_overwrite_ignored_files() {
    let r = repo();
    runner::run(r.path(), ["switch", "-c", "with-collision"]).unwrap();
    fs::write(r.path().join("ignored.txt"), "committed elsewhere").unwrap();
    runner::run(r.path(), ["add", "ignored.txt"]).unwrap();
    runner::run(r.path(), ["commit", "-m", "collision"]).unwrap();
    runner::run(r.path(), ["switch", "main"]).unwrap();
    fs::write(r.path().join(".git/info/exclude"), "ignored.txt\n").unwrap();
    fs::write(r.path().join("ignored.txt"), "keep ignored").unwrap();
    let run = start(r.path(), vec![step("branch", "new-branch", "with-collision")]);
    let run = next(r.path(), &run);
    assert_eq!(run.phase, "failed", "{run:?}");
    assert_eq!(fs::read_to_string(r.path().join("ignored.txt")).unwrap(), "keep ignored");
    assert_eq!(runner::run(r.path(), ["branch", "--show-current"]).unwrap().trim(), "main");
}
#[test]
fn stop_cancels_commands_without_waiting_for_the_common_git_writer_gate() {
    let r = repo();
    #[cfg(windows)]
    let command = "echo running && powershell.exe -NoProfile -NonInteractive -Command Start-Sleep 30";
    #[cfg(unix)]
    let command = "echo running; sleep 30";
    let run = start(r.path(), vec![step("command", command, "")]);
    let p = review(r.path(), &run.id).unwrap();
    execute(r.path().into(), p, true).unwrap();
    let end = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let snapshot = get(r.path(), &run.id).unwrap();
        if snapshot.results[0].stdout.contains("running") {
            break;
        }
        assert!(
            !matches!(snapshot.phase.as_str(), "failed" | "uncertain" | "interrupted" | "completed"),
            "Command ended before its readiness marker: {snapshot:?}"
        );
        assert!(std::time::Instant::now() < end, "Command did not reach its readiness marker: {snapshot:?}");
        thread::sleep(Duration::from_millis(25));
    }
    stop(r.path(), &run.id).unwrap();
    let run = wait(r.path(), &run.id);
    assert_eq!(run.phase, "cancelled", "{run:?}");
    assert!(operations::run(r.path(), "workflow_step", None, |_, _| {}, || Ok(())).is_ok());
}

#[test]
fn a_completed_durable_record_wins_over_a_previously_read_running_snapshot() {
    let r = repo();
    let mut run = start(r.path(), vec![step("checkClean", "", "")]);
    run.phase = "running".into();
    let old = run.clone();
    run.phase = "completed".into();
    run.cursor = 1;
    run.results[0].phase = "completed".into();
    let p = path(r.path(), &run.id).unwrap();
    write(&p, &run).unwrap();
    for free in [true, false] {
        assert_eq!(settled_record(&p, old.clone(), free).unwrap().phase, "completed");
    }
}

#[test]
fn dangling_symbolic_destination_is_rejected_without_updating_its_target() {
    let r = repo();
    runner::run(r.path(), ["symbolic-ref", "refs/heads/alias", "refs/heads/missing"]).unwrap();
    let run = start(r.path(), vec![step("branch", "alias", "main")]);
    assert!(review(r.path(), &run.id).is_err());
    assert_eq!(runner::run(r.path(), ["symbolic-ref", "refs/heads/alias"]).unwrap().trim(), "refs/heads/missing");
    assert!(!runner::exec(r.path(), ["show-ref", "--verify", "--quiet", "refs/heads/missing"]).unwrap().ok());
}
