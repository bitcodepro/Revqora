use super::*;
use crate::git::{forge, history, ops, pr_center, recovery, repo, runner, status, sync};
fn expand(r: &Run, s: &str) -> String {
    match s {
        "${branch}" => r.parameters.branch.clone(),
        "${base}" => r.parameters.base.clone(),
        _ => s.to_owned(),
    }
}
fn branch(root: &Path, name: &str) -> GitResult<()> {
    if name.is_empty() || name.starts_with('-') || !runner::exec(root, ["check-ref-format", &format!("refs/heads/{name}")])?.ok() {
        return Err(fail("Enter a valid branch name."));
    }
    Ok(())
}
fn commit(root: &Path, value: &str) -> GitResult<String> {
    if value.is_empty() || value.starts_with('-') {
        return Err(fail("Choose a commit or branch."));
    }
    Ok(history::run(root, ["rev-parse", "--verify", "--end-of-options", &format!("{value}^{{commit}}")])?.trim().to_owned())
}
fn urls(root: &Path, remote: &str) -> GitResult<String> {
    if remote.starts_with('-') || !runner::run(root, ["remote"])?.lines().any(|r| r == remote) {
        return Err(fail("Select an existing named remote."));
    }
    let fetch = runner::run(root, ["remote", "get-url", "--all", remote])?;
    let push = runner::run(root, ["remote", "get-url", "--push", "--all", remote])?;
    if fetch.lines().count() != 1 || push.lines().count() != 1 || fetch.trim() != push.trim() {
        return Err(fail("Workflow publication requires one identical fetch/push destination. Review other configurations in the individual Git tools."));
    }
    Ok(push.trim().to_owned())
}
fn server_head(root: &Path, url: &str, branch: &str) -> GitResult<Option<String>> {
    let (mut args, name) = sync::transport(root, url)?;
    args.extend(["ls-remote".into(), "--symref".into(), "--refs".into(), "--heads".into(), "--".into(), name, format!("refs/heads/{branch}")]);
    let raw = history::run(root, args)?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let rows: Vec<_> = raw.lines().collect();
    if rows.len() != 1 {
        return Err(fail("Ambiguous server branch response."));
    }
    let (oid, reference) = rows[0].split_once('\t').ok_or_else(|| fail("Invalid server branch response."))?;
    if reference != format!("refs/heads/{branch}") || !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(fail("Invalid server branch identity."));
    }
    Ok(Some(oid.to_owned()))
}
pub(super) fn build_review(root: &Path, r: &Run) -> GitResult<Review> {
    build_review_with(root, r, None)
}
pub(super) fn build_review_with(root: &Path, r: &Run, previous: Option<&Review>) -> GitResult<Review> {
    let (mut out, state) = operations::inspect(root, || {
        let info = repo::info(root)?;
        let st = status::status(root)?;
        if info.is_bare || info.state.kind != "none" {
            return Err(fail("Finish any merge/rebase/cherry-pick and use a working repository before this step."));
        }
        let mut step = r.definition.steps.get(r.cursor).cloned().ok_or_else(|| fail("No pending step."))?;
        // Commands and PR text are literal. Only whole structured Git fields
        // expand parameters, so branch text never becomes shell interpolation.
        if matches!(step.kind.as_str(), "checkBranch" | "branch" | "cherryPick" | "publish") {
            step.value = expand(r, &step.value);
        }
        step.extra = expand(r, &step.extra);
        let clean = st.files.is_empty();
        let applies = match step.when.as_str() {
            "clean" => clean,
            "dirty" => !clean,
            _ => true,
        };
        let mut out = Review {
            working_directory: r.workspace.clone().unwrap_or_else(|| r.repository.clone()),
            run_id: r.id.clone(),
            cursor: r.cursor,
            run_revision: digest(r)?,
            state_token: String::new(),
            branch: st.branch.clone(),
            head: st.oid.clone(),
            step: step.clone(),
            resolved: vec![],
            connection: String::new(),
            remote_fingerprint: String::new(),
            remote_head: None,
            skip: !applies && step.on_false == "skip",
            condition_met: applies,
            consent_required: !matches!(step.kind.as_str(), "checkClean" | "checkBranch" | "prChecks") && applies,
            explanation: String::new(),
        };
        if !applies {
            out.explanation = if out.skip {
                "Condition is false: this step will be recorded as skipped."
            } else {
                "Condition is false: this workflow will stop with an error."
            }
            .into();
            return Ok(out);
        }
        match step.kind.as_str() {
            "prAgent" | "prChecks" | "prRequestReview" | "prMerge" | "prCleanup" => pull_requests::review(root, &step, &mut out, previous)?,
            "commit" => {
                if step.value.trim().is_empty() || clean {
                    return Err(fail("Enter a commit message and review changed files before committing."));
                }
                out.resolved = st.files.iter().map(|f| f.path.clone()).collect();
                out.explanation = format!("Stage all {} Git-visible changed files in this working copy and create a commit. Hooks and configured signing remain enabled. Review the diff first; ignored files are excluded.", st.files.len());
            }
            "checkClean" => {
                out.explanation =
                    "Verify that staging, working files and untracked files have no Git-visible changes. Ignored files are outside this check.".into()
            }
            "checkBranch" => {
                branch(root, &step.value)?;
                out.explanation = format!("Require current branch: {}", step.value);
            }
            "branch" => {
                sync::require_actual_history(root)?;
                if !clean {
                    return Err(fail("Commit or stash Git-visible changes before creating/checking out a workflow branch."));
                }
                branch(root, &step.value)?;
                if runner::exec(root, ["symbolic-ref", "-q", &format!("refs/heads/{}", step.value)])?.ok() {
                    return Err(fail("Symbolic branch aliases cannot be created or reused by a workflow."));
                }
                if runner::exec(root, ["show-ref", "--verify", "--quiet", &format!("refs/heads/{}", step.value)])?.ok() {
                    return Err(fail("That branch already exists; a workflow never force-reuses it."));
                }
                out.resolved.push(commit(root, &step.extra)?);
                out.explanation = format!("Create and check out {} from exact commit {}. Existing branches are never reset.", step.value, out.resolved[0]);
            }
            "cherryPick" => {
                sync::require_actual_history(root)?;
                if !clean || st.branch.is_none() {
                    return Err(fail("Cherry-pick requires a clean checked-out branch."));
                }
                if runner::exec(root, ["symbolic-ref", "-q", &format!("refs/heads/{}", st.branch.as_ref().unwrap())])?.ok() {
                    return Err(fail("Check out a direct local branch before cherry-picking."));
                }
                for value in step.value.split_whitespace() {
                    let oid = commit(root, value)?;
                    if history::run(root, ["rev-list", "--parents", "-n", "1", &oid])?.split_whitespace().count() > 2 {
                        return Err(fail("Merge commits need an explicit mainline decision in the individual cherry-pick tool."));
                    }
                    out.resolved.push(oid);
                }
                if out.resolved.is_empty() || out.resolved.len() > 16 {
                    return Err(fail("Select 1–16 commits in application order."));
                }
                out.explanation = format!(
                    "Cherry-pick {} commit(s), creating local commits. A conflict stops the workflow; no automatic abort or retry.",
                    out.resolved.len()
                );
            }
            "command" => {
                if step.value.trim().is_empty() {
                    return Err(fail("Enter an explicit test/build command."));
                }
                out.explanation=format!("Run this literal shell command in the working directory ({} second timeout). It can change files or access services; it is not a sandbox. A recovery checkpoint precedes execution.",step.timeout_seconds);
            }
            "publish" => {
                sync::require_actual_history(root)?;
                branch(root, &step.extra)?;
                let head = st.oid.as_ref().ok_or_else(|| fail("No commit to publish."))?;
                let url = urls(root, &step.value)?;
                out.remote_fingerprint = digest(&url)?;
                out.remote_head = server_head(root, &url, &step.extra)?;
                if let Some(old) = &out.remote_head {
                    if !history::exec(root, ["merge-base", "--is-ancestor", old, head])?.ok() {
                        return Err(fail("Fetch and review the server history first. Workflow publication permits only original-history fast-forwards."));
                    }
                }
                out.explanation=format!("Publish exact commit {head} to {}/{}. No tags, history rewrite, tracking change or source cleanup. An exact server-ref lease guards the reviewed destination.",step.value,step.extra);
            }
            "pr" => {
                if step.value.trim().is_empty() {
                    return Err(fail("Enter a pull request title."));
                }
                branch(root, &step.extra)?;
                let source = st.branch.as_ref().ok_or_else(|| fail("PR creation requires a checked-out branch."))?;
                let f = forge::detect(root)?.ok_or_else(|| fail("Select a PR API connection first in Accounts/PR Center."))?;
                out.connection = f.connection_revision.clone().ok_or_else(|| fail("Refresh the API connection."))?;
                let url = urls(root, &f.remote)?;
                out.remote_fingerprint = digest(&(url.clone(), f.remote.clone()))?;
                out.remote_head = server_head(root, &url, source)?;
                if out.remote_head != st.oid {
                    return Err(fail("Publish this exact current commit to the selected API remote/source branch before creating the PR."));
                }
                out.explanation = format!(
                    "Create an ordinary PR on {} as {}, from {} to {}. This sends the title/description to the selected service; no merge or cleanup follows.",
                    f.host,
                    f.account_login.as_deref().unwrap_or("native Git credential identity"),
                    source,
                    step.extra
                );
            }
            _ => return Err(fail("Unknown workflow step.")),
        }
        Ok(out)
    })?;
    out.state_token = state;
    Ok(out)
}
pub(super) fn execute_action(root: &Path, original: &Run, prepared: &Review, job: &Arc<Job>) -> GitResult<ResultRow> {
    // original is the immutable pre-dispatch record. Reconstruct its ready state
    // before comparing the preview; the stored running marker is never reverted.
    let mut reviewed = original.clone();
    reviewed.phase = "ready".into();
    reviewed.results[reviewed.cursor].phase = "pending".into();
    if matches!(prepared.step.kind.as_str(), "prAgent" | "prChecks") && prepared.condition_met {
        if build_review_with(root, &reviewed, Some(prepared))? != *prepared {
            return Err(stale());
        }
        return pull_requests::execute_waiting(root, prepared, job);
    }
    if prepared.step.kind == "command" && prepared.condition_met {
        if build_review(root, &reviewed)? != *prepared {
            return Err(stale());
        }
        if job.cancel.load(Ordering::Acquire) {
            return Err(fail("Workflow stopped before the command."));
        }
        let report = validation::start(root.to_owned(), prepared.step.value.clone(), prepared.state_token.clone(), prepared.step.timeout_seconds)?;
        loop {
            if job.cancel.load(Ordering::Acquire) {
                let _ = validation::cancel(root, &report.id);
            }
            let current = validation::report(root).ok_or_else(|| fail("Command report is missing; inspect the check result before another workflow."))?;
            if current.id != report.id {
                return Err(fail("Another check replaced this report. Its result cannot be assumed successful."));
            }
            let (stdout, a) = clip(&current.stdout);
            let (stderr, b) = clip(&current.stderr);
            {
                let mut r = job.run.lock();
                let index = r.cursor;
                r.results[index].stdout = stdout.clone();
                r.results[index].stderr = stderr.clone();
                r.results[index].truncated = current.truncated || a || b;
                r.results[index].exit_code = current.exit_code;
            }
            if !matches!(current.phase.as_str(), "queued" | "running") {
                if current.phase != "passed" {
                    return Err(fail(format!("Command {} (exit {:?}): {}", current.phase, current.exit_code, current.error.unwrap_or_default())));
                }
                return Ok(ResultRow {
                    workspace: None,
                    phase: "completed".into(),
                    message: "Command passed. Review any working-file changes before the next step.".into(),
                    stdout,
                    stderr,
                    truncated: current.truncated || a || b,
                    exit_code: current.exit_code,
                });
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
    operations::run(
        root,
        if prepared.step.kind == "cherryPick" { "cherry_pick" } else { "workflow_step" },
        Some(&prepared.state_token),
        |_, _| {},
        || {
            if job.cancel.load(Ordering::Acquire) {
                return Err(fail("Workflow stopped before the action."));
            }
            let fresh = build_review_with(root, &reviewed, Some(prepared))?;
            if fresh != *prepared {
                return Err(stale());
            }
            let st = status::status(root)?;
            let applies = match prepared.step.when.as_str() {
                "clean" => st.files.is_empty(),
                "dirty" => !st.files.is_empty(),
                _ => true,
            };
            if !applies {
                if prepared.skip {
                    return Ok(ResultRow { phase: "skipped".into(), message: "Step condition was false.".into(), ..ResultRow::pending() });
                }
                return Err(fail("Step condition was false; workflow stopped."));
            }
            let s = &prepared.step;
            let message = match s.kind.as_str() {
                "prRequestReview" | "prMerge" | "prCleanup" => pull_requests::execute_remote(root, prepared)?,
                "commit" => {
                    recovery::create(root, "workflow_commit", "Before staging and committing workflow edits", false, false)?;
                    runner::run(root, ["add", "-A", "--", "."])?;
                    ops::commit(root, &s.value, &ops::CommitOptions::default())?
                }
                "checkClean" => {
                    if !st.files.is_empty() {
                        return Err(fail("Git-visible changes are present."));
                    }
                    "Working directory is Git-visible clean.".into()
                }
                "checkBranch" => {
                    if st.branch.as_deref() != Some(&s.value) {
                        return Err(fail("Current branch does not match the required branch."));
                    }
                    "Branch condition passed.".into()
                }
                "branch" => {
                    runner::run(root, ["switch", "--no-overwrite-ignore", "-c", &s.value, &prepared.resolved[0]])?;
                    format!("Created and checked out {}.", s.value)
                }
                "cherryPick" => {
                    let outcome = ops::cherry_pick(root, &prepared.resolved, false)?;
                    if !matches!(outcome.status.as_str(), "done" | "upToDate") {
                        return Err(fail(format!(
                            "Cherry-pick stopped: {}. Resolve or abort using the existing Git tools; later steps were not run.",
                            outcome.message
                        )));
                    }
                    outcome.message
                }
                "publish" => {
                    recovery::create(root, "workflow_publish", "Before publishing workflow branch", false, false)?;
                    let url = urls(root, &s.value)?;
                    let (mut args, name) = sync::transport(root, &url)?;
                    args.extend([
                        "-c".into(),
                        "push.followTags=false".into(),
                        "push".into(),
                        "--porcelain".into(),
                        "--no-follow-tags".into(),
                        "--recurse-submodules=no".into(),
                        format!("--force-with-lease=refs/heads/{}:{}", s.extra, prepared.remote_head.as_deref().unwrap_or("")),
                        "--".into(),
                        name,
                        format!("{}:refs/heads/{}", prepared.head.as_deref().unwrap(), s.extra),
                    ]);
                    let out = history::exec(root, args).map_err(|e| e.kind("workflow-write-uncertain"))?;
                    if !out.ok() {
                        return Err(runner::to_error("workflow push", &out).kind("workflow-write-uncertain"));
                    }
                    format!("Published reviewed commit to {}/{}.", s.value, s.extra)
                }
                "pr" => {
                    let p = pr_center::create(root, &s.value, &s.body, prepared.branch.as_deref().unwrap(), &s.extra, false, &prepared.connection)?;
                    format!("Created PR #{}: {}", p.number, p.url)
                }
                _ => return Err(fail("Unknown step.")),
            };
            Ok(ResultRow { phase: "completed".into(), message, ..ResultRow::pending() })
        },
    )
}
