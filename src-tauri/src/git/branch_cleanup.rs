//! One reviewed batch, one repository writer turn. External writers still require
//! per-item revalidation and exact local CAS / server leases. A batch is not atomic.
use super::{
    branch_deletion, branch_protection,
    branch_review::{self, DeletionPlan, DeletionProof},
    operations, recovery,
    runner::{self, GitError, GitResult},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Remote,
    Both,
}
impl Mode {
    fn local(self) -> bool {
        self != Self::Remote
    }
    fn remote(self) -> bool {
        self != Self::Local
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub reference: String,
    pub oid: String,
    pub mode: Mode,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    pub request: Request,
    pub plan: Option<DeletionPlan>,
    pub error: Option<String>,
    pub force_required: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub items: Vec<ReviewItem>,
    pub state_token: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub proof: DeletionProof,
    pub mode: Mode,
    pub force: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub name: String,
    pub local_deleted: bool,
    pub remote_deleted: bool,
    pub status: String,
    pub message: Option<String>,
    pub checkpoints: Vec<recovery::Summary>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub status: String,
    pub items: Vec<Outcome>,
    pub preflight_failed: bool,
}
fn invalid(message: &str) -> GitError {
    GitError::new(message).kind("stale-selection")
}
fn bounded(len: usize) -> GitResult<()> {
    if len == 0 || len > 50 {
        return Err(invalid("Select between 1 and 50 branches per cleanup review."));
    }
    Ok(())
}
fn remote_unchanged(root: &Path, proof: &DeletionProof) -> GitResult<()> {
    let t = proof.target.as_ref().ok_or_else(|| invalid("No unambiguous remote target. Use individual branch review."))?;
    let output = runner::run(root, ["ls-remote", "--heads", "--refs", "--", &t.push_url, &t.remote_ref])?;
    if !output.lines().any(|line| line.split_once('\t') == Some((t.oid.as_str(), t.remote_ref.as_str()))) {
        return Err(GitError::new(
            "The push server tip differs from this review. Fetch and prepare a new review; use individual branch review for a separate push server.",
        )
        .kind("remote-changed"));
    }
    Ok(())
}
fn check(root: &Path, s: &Selection, rules: &[String], server: bool) -> GitResult<()> {
    if s.mode.local() == s.proof.remote_only {
        return Err(invalid("The deletion scope differs from the reviewed proof."));
    }
    branch_review::validate(root, &s.proof, s.mode.local())?;
    branch_protection::require_allowed(
        Some(rules),
        s.mode.local().then_some(s.proof.name.as_str()),
        if s.mode.remote() { s.proof.target.as_ref() } else { None },
    )?;
    branch_review::require_retained(root, &s.proof, s.mode.local(), s.mode.remote(), s.force)?;
    if s.mode.remote() && server {
        remote_unchanged(root, &s.proof)?;
    }
    Ok(())
}
pub fn review(root: &Path, requests: Vec<Request>, base: &str, rules: &[String]) -> GitResult<Review> {
    review_with_analysis(root, requests, base, rules, true)
}

pub fn review_with_analysis(root: &Path, requests: Vec<Request>, base: &str, rules: &[String], analyze: bool) -> GitResult<Review> {
    bounded(requests.len())?;
    let (mut items, state_token) = operations::inspect(root, || {
        let local_refs = if !analyze && requests.iter().any(|r| r.mode == Mode::Local) { Some(branch_review::LocalRefSnapshot::read(root)?) } else { None };
        requests
            .into_iter()
            .map(|request| {
                let result = (|| {
                    if let (Some(snapshot), Some(name)) = (local_refs.as_ref(), request.reference.strip_prefix("refs/heads/")) {
                        if request.mode == Mode::Local {
                            let plan = snapshot.plan(name, &request.oid)?;
                            branch_protection::require_allowed(Some(rules), Some(name), None)?;
                            return Ok(plan);
                        }
                    }
                    let remote_row = request.reference.starts_with("refs/remotes/");
                    if remote_row && request.mode != Mode::Remote {
                        return Err(invalid("A remote row can only delete its server branch."));
                    }
                    let (name, target) = if remote_row {
                        let t = branch_deletion::remote_target(root, &request.reference)?;
                        (t.remote_ref.strip_prefix("refs/heads/").unwrap_or("").to_owned(), Some(t))
                    } else {
                        let name = request.reference.strip_prefix("refs/heads/").ok_or_else(|| invalid("Select a direct local or remote branch."))?.to_owned();
                        let target = if request.mode.remote() {
                            let mut targets = branch_deletion::targets(root, &name)?;
                            if targets.len() != 1 {
                                return Err(invalid("No single remote target. Choose local-only or use individual branch review."));
                            }
                            Some(targets.remove(0))
                        } else {
                            None
                        };
                        (name, target)
                    };
                    // Never silently replace the selected inventory tip while opening review.
                    let oid = runner::run(root, ["rev-parse", "--verify", &request.reference])?;
                    if oid.trim() != request.oid {
                        return Err(invalid("The selected branch changed. Refresh the manager and select it again."));
                    }
                    let p = if analyze {
                        branch_review::plan(root, &name, Some(base), target, None, request.mode == Mode::Remote)?
                    } else {
                        branch_review::plan_without_history(root, &name, target, request.mode == Mode::Remote)?
                    };
                    branch_review::validate(root, &p.proof, request.mode.local())?;
                    branch_protection::require_allowed(
                        Some(rules),
                        request.mode.local().then_some(name.as_str()),
                        if request.mode.remote() { p.proof.target.as_ref() } else { None },
                    )?;
                    Ok(p)
                })();
                let (plan, error, force_required) = match result {
                    Ok(p) => {
                        let force = p.proof.base_oid.is_none()
                            || (request.mode.local() && p.local_unmerged > 0)
                            || (request.mode.remote() && p.remote_unmerged.unwrap_or(0) > 0);
                        (Some(p), None, force)
                    }
                    Err(e) => (None, Some(e.message), false),
                };
                Ok(ReviewItem { request, plan, error, force_required })
            })
            .collect::<GitResult<Vec<_>>>()
    })?;
    for item in &mut items {
        if let Some(plan) = &mut item.plan {
            plan.state_token = state_token.clone();
        }
    }
    Ok(Review { items, state_token })
}
pub fn execute(root: &Path, selections: &[Selection], rules: &[String], mut progress: impl FnMut(&str)) -> GitResult<Report> {
    execute_with_checkpoint(root, selections, rules, true, &mut progress)
}

pub fn execute_with_checkpoint(
    root: &Path,
    selections: &[Selection],
    rules: &[String],
    create_checkpoint: bool,
    mut progress: impl FnMut(&str),
) -> GitResult<Report> {
    bounded(selections.len())?;
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let fast_local = selections.iter().all(|s| {
                s.mode == Mode::Local
                    && s.force
                    && !s.proof.remote_only
                    && s.proof.local_present
                    && s.proof.base_ref.is_none()
                    && s.proof.base_oid.is_none()
                    && s.proof.target.is_none()
            });
            let local_snapshot = if fast_local { Some(branch_review::LocalRefSnapshot::read(root)?) } else { None };
            let local_refs: HashSet<_> = selections.iter().filter(|s| s.mode.local()).map(|s| format!("refs/heads/{}", s.proof.name)).collect();
            let mut seen_local = HashSet::new();
            let mut seen_remote = HashSet::new();
            let mut outcomes = Vec::new();
            let mut failed = false;
            // Validate EVERY actual destination before the first checkpoint or mutation.
            for s in selections {
                progress(&format!("Checking {}", s.proof.name));
                let result = (|| {
                    if s.proof.base_ref.as_ref().is_some_and(|r| local_refs.contains(r)) {
                        return Err(invalid("The comparison branch is also selected for deletion. Keep it or choose another base."));
                    }
                    if s.mode == Mode::Remote && local_refs.contains(&format!("refs/heads/{}", s.proof.name)) {
                        return Err(invalid(
                            "Remote-only review keeps its matching local branch, but another row deletes it. Use one combined local + remote row instead.",
                        ));
                    }
                    if s.mode.local() && !seen_local.insert(s.proof.name.clone()) {
                        return Err(invalid("The same local branch is selected twice."));
                    }
                    if s.mode.remote() {
                        let t = s.proof.target.as_ref().ok_or_else(|| invalid("Choose a remote target."))?;
                        if !seen_remote.insert((t.push_url.clone(), t.remote_ref.clone())) {
                            return Err(invalid("The same server branch is selected twice. Keep only one row for this destination."));
                        }
                    }
                    if let Some(snapshot) = &local_snapshot {
                        snapshot.plan(&s.proof.name, &s.proof.local_oid)?;
                        branch_protection::require_allowed(Some(rules), Some(&s.proof.name), None)
                    } else {
                        check(root, s, rules, true)
                    }
                })();
                if result.is_err() {
                    failed = true;
                }
                outcomes.push(Outcome {
                    name: s.proof.name.clone(),
                    local_deleted: false,
                    remote_deleted: false,
                    status: if result.is_err() { "failed" } else { "skipped" }.into(),
                    message: result.err().map(|e| e.message),
                    checkpoints: Vec::new(),
                });
            }
            if failed {
                for o in &mut outcomes {
                    if o.message.is_none() {
                        o.message = Some("Nothing deleted: another row failed preflight. Prepare a new review.".into());
                    }
                }
                return Ok(Report { status: "stopped".into(), items: outcomes, preflight_failed: true });
            }
            // Fast cleanup preserves the entire selection in one bundle rather
            // than walking and packing the same history once for every row.
            let batch_checkpoint = if create_checkpoint && fast_local {
                progress("Saving one recovery checkpoint for the selected branch tips");
                let mut references = std::collections::BTreeMap::new();
                for s in selections {
                    let name = format!("refs/heads/{}", s.proof.name);
                    references.insert(name.clone(), recovery::SavedRef { name, oid: s.proof.local_oid.clone(), kind: "branch".into() });
                }
                Some(recovery::reference_checkpoint(
                    root,
                    "branch_cleanup_execute",
                    "Before deleting selected branches",
                    &references.into_values().collect::<Vec<_>>(),
                    None,
                )?)
            } else {
                None
            };
            if fast_local {
                progress("Deleting reviewed local branch references");
                // Refresh worktree usage after checkpoint creation. Local CAS is
                // then enforced for the entire selection by one ref transaction.
                let fresh = branch_review::LocalRefSnapshot::read(root)?;
                for s in selections {
                    fresh.plan(&s.proof.name, &s.proof.local_oid)?;
                }
                if create_checkpoint {
                    let tips = selections.iter().map(|s| (s.proof.name.as_str(), s.proof.local_oid.as_str())).collect::<Vec<_>>();
                    let _ = super::more::record_deleted_tips(root, &tips);
                }
                let mut transaction = String::from("start\n");
                for s in selections {
                    transaction.push_str(&format!("delete refs/heads/{} {}\n", s.proof.name, s.proof.local_oid));
                }
                transaction.push_str("prepare\ncommit\n");
                let out = runner::exec_full(root, ["update-ref", "--no-deref", "--stdin"], &[], Some(transaction.as_bytes()))?;
                for (s, outcome) in selections.iter().zip(&mut outcomes) {
                    outcome.checkpoints.extend(batch_checkpoint.clone());
                    if !out.ok() {
                        outcome.status = "failed".into();
                        outcome.message = Some(runner::to_error("git update-ref transaction", &out).message);
                        continue;
                    }
                    outcome.local_deleted = true;
                    outcome.status = "deleted".into();
                    let cleanup = runner::exec(root, ["config", "--remove-section", &format!("branch.{}", s.proof.name)]);
                    if !matches!(cleanup,Ok(ref out) if out.ok()||out.stderr.contains("no such section")) {
                        outcome.message = Some("The branch was deleted, but its Git configuration section could not be removed.".into());
                    }
                }
                return Ok(Report { status: if out.ok() { "done" } else { "stopped" }.into(), items: outcomes, preflight_failed: false });
            }
            for (s, outcome) in selections.iter().zip(&mut outcomes) {
                if failed {
                    outcome.message = Some("Skipped after an earlier failure. Prepare a new review.".into());
                    continue;
                }
                progress(&format!("Deleting {}", s.proof.name));
                let result: GitResult<()> = (|| {
                    // An external CLI can mutate refs even while our writer turn is held.
                    check(root, s, rules, true)?;
                    outcome.checkpoints.extend(batch_checkpoint.clone());
                    let mut warnings = Vec::new();
                    if s.mode.local() {
                        let r = branch_review::delete_local_with_checkpoint(
                            root,
                            &s.proof,
                            s.mode.remote(),
                            s.force,
                            None,
                            Some(rules),
                            create_checkpoint && batch_checkpoint.is_none(),
                        )?;
                        outcome.local_deleted = true;
                        outcome.checkpoints.extend(r.checkpoint);
                        if let Some(w) = r.warning {
                            warnings.push(w);
                        }
                    }
                    if s.mode.remote() {
                        let r = branch_review::delete_remote_with_checkpoint(
                            root,
                            &s.proof,
                            s.force,
                            None,
                            Some(rules),
                            create_checkpoint && batch_checkpoint.is_none(),
                            &mut progress,
                        )?;
                        outcome.remote_deleted = true;
                        outcome.checkpoints.extend(r.checkpoint);
                        if let Some(w) = r.warning {
                            warnings.push(w);
                        }
                    }
                    outcome.message = (!warnings.is_empty()).then(|| warnings.join("\n"));
                    Ok(())
                })();
                match result {
                    Ok(()) => outcome.status = "deleted".into(),
                    Err(e) => {
                        failed = true;
                        outcome.status = if outcome.local_deleted || outcome.remote_deleted { "partial" } else { "failed" }.into();
                        outcome.message = Some(e.message);
                    }
                }
            }
            Ok(Report { status: if failed { "stopped" } else { "done" }.into(), items: outcomes, preflight_failed: false })
        },
    )
}
