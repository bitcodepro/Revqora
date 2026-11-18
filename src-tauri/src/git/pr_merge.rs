//! Reviewed forge-side merging. Never pushes, checks out or stages local files.
use super::{
    forge::{self, ForgeInfo},
    pr_center::{self, hash, text, Detail},
    runner::{GitError, GitResult},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
pub(super) mod checks;
mod cleanup;
mod providers;
pub use cleanup::{cleanup_act, cleanup_plan, CleanupInput, CleanupResult, CleanupReview};
pub(super) fn same_repository_source(f: &ForgeInfo, raw: &Value) -> bool {
    cleanup::source_repo(f, raw)
}
fn error(s: &str) -> GitError {
    GitError::new(s).kind("pr-merge")
}
fn stale() -> GitError {
    GitError::new("The PR, checks, policies or merge identity changed. Refresh and review again; no merge was sent.").kind("stale-operation")
}
fn yes(v: &Value, p: &str) -> bool {
    v.pointer(p).and_then(Value::as_bool) == Some(true)
}
fn rows<'a>(v: &'a Value, p: &str) -> GitResult<&'a Vec<Value>> {
    v.pointer(p).and_then(Value::as_array).ok_or_else(|| error("Incomplete server policy/check response. Merge is unavailable until it can be verified."))
}
fn ident(v: &Value, p: &str) -> String {
    v.pointer(p).filter(|v| !v.is_null()).map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())).unwrap_or_default()
}
fn oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn scoped(repo: &Path, n: u64, connection: &str, revision: &str) -> GitResult<(ForgeInfo, Detail, Value)> {
    let f = forge::reviewed_connection(repo, connection)?;
    let (d, v) = pr_center::load_detail(repo, &f, n)?;
    if revision.is_empty() || d.revision != revision {
        return Err(stale());
    }
    Ok((f, d, v))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Method {
    pub id: String,
    pub label: String,
    pub explanation: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub label: String,
    pub state: String,
    pub required: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub revision: String,
    pub detail_revision: String,
    pub source_sha: String,
    pub target_sha: String,
    pub actor: String,
    pub actor_id: String,
    pub methods: Vec<Method>,
    pub checks: Vec<forge::Check>,
    pub rules: Vec<Rule>,
    pub blockers: Vec<String>,
    pub notices: Vec<String>,
    pub queue_state: Option<String>,
    pub merged: bool,
    pub source_branch_may_be_deleted: bool,
    /// What the server reported for the head commit: requested changes and merge conflicts.
    /// None when the provider did not say. Used by the attention queue, not by the merge dialog.
    #[serde(skip)]
    pub changes_requested: Option<bool>,
    #[serde(skip)]
    pub conflicts: Option<bool>,
}
impl Plan {
    fn block(&mut self, s: impl Into<String>) {
        self.blockers.push(s.into());
    }
    fn rule(&mut self, label: impl Into<String>, state: impl Into<String>, required: bool) {
        self.rules.push(Rule { label: label.into(), state: state.into(), required });
    }
    fn method(&mut self, id: &str, label: &str, explanation: &str) {
        self.methods.push(Method { id: id.into(), label: label.into(), explanation: explanation.into() });
    }
}
struct Prepared {
    plan: Plan,
    raw: Value,
}
pub fn plan(repo: &Path, n: u64, connection: &str, revision: &str) -> GitResult<Plan> {
    prepare(repo, n, connection, revision).map(|p| p.plan)
}
/// Merge readiness of the PR as the server reports it now, for the attention queue: the same
/// reads as [`plan`] without the merge identity and the second metadata read that guard a
/// merge confirmation. Nothing here can be used to submit a merge.
pub fn current_readiness(repo: &Path, n: u64, connection: &str) -> GitResult<(Detail, Plan)> {
    let f = forge::reviewed_connection(repo, connection)?;
    let (d, v) = pr_center::load_detail(repo, &f, n)?;
    let (plan, _) = readiness(repo, &f, &d, &v)?;
    Ok((d, plan))
}
pub fn verified_checks(repo: &Path, n: u64, connection: &str, revision: &str) -> GitResult<Vec<forge::Check>> {
    let (f, d, _) = scoped(repo, n, connection, revision)?;
    let checks = checks::load(repo, &f, &d)?;
    scoped(repo, n, connection, revision)?;
    Ok(checks)
}
fn prepare(repo: &Path, n: u64, connection: &str, revision: &str) -> GitResult<Prepared> {
    let (f, d, v) = scoped(repo, n, connection, revision)?;
    // The identity read is independent of the provider's readiness reads: run it alongside.
    let parent = super::operations::Inherited::of(repo);
    std::thread::scope(|scope| {
        let identity = scope.spawn(|| parent.run(|| providers::actor(repo, &f)));
        let readiness = readiness(repo, &f, &d, &v);
        let (actor, actor_id) = identity.join().unwrap_or_else(|_| Err(error("Could not verify the merge identity.")))?;
        let (mut p, raw) = readiness?;
        p.actor = actor;
        p.actor_id = actor_id;
        Ok::<_, GitError>((p, raw))
    })
    .and_then(|(p, raw)| finish(repo, n, connection, revision, p, raw))
}

fn readiness(repo: &Path, f: &ForgeInfo, d: &Detail, v: &Value) -> GitResult<(Plan, Value)> {
    let (actor, actor_id) = (String::new(), String::new());
    let mut p = Plan {
        revision: String::new(),
        detail_revision: d.revision.clone(),
        source_sha: d.pull.head_sha.clone(),
        target_sha: d.base_sha.clone(),
        actor,
        actor_id,
        methods: vec![],
        checks: vec![],
        rules: vec![],
        blockers: vec![],
        notices: vec![],
        queue_state: None,
        merged: d.pull.state == "merged",
        source_branch_may_be_deleted: matches!(f.kind.as_str(), "github" | "bitbucket-server"),
        changes_requested: None,
        conflicts: None,
    };
    if !oid(&p.source_sha) || !oid(&p.target_sha) {
        p.block("The server has not provided complete source and target commit IDs.");
    }
    if d.pull.state != "open" {
        p.block(format!("This request is {}.", d.pull.state));
    }
    if d.pull.draft {
        p.block("Mark this draft ready for review on the server before merging.");
    }
    // Closed PRs still expose completion state, without needing protected-branch read scopes.
    let raw = if d.pull.state == "open" { providers::inspect(repo, f, d, v, &mut p)? } else { Value::Null };
    if p.source_branch_may_be_deleted {
        p.notices.push("The provider may delete the source branch after merging.".into());
    }
    p.notices.push("The server enforces its current permissions and policies. Revqora never requests a policy bypass. Target branches can advance during a server request.".into());
    Ok((p, raw))
}

fn finish(repo: &Path, n: u64, connection: &str, revision: &str, mut p: Plan, raw: Value) -> GitResult<Prepared> {
    scoped(repo, n, connection, revision)?;
    p.revision = hash(serde_json::to_vec(&json!([&p, &raw])).map_err(|_| error("Could not fingerprint merge review."))?);
    Ok(Prepared { plan: p, raw })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeInput {
    pub plan_revision: String,
    pub method: String,
    pub message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub state: String,
    pub commit: Option<String>,
    pub message: String,
}
pub fn merge(repo: &Path, n: u64, connection: &str, revision: &str, input: MergeInput) -> GitResult<MergeResult> {
    super::operations::access(
        repo,
        true,
        |_, _| {},
        || {
            if input.message.len() > 65536 || input.message.contains('\0') {
                return Err(error("Merge message must be at most 64 KiB without NUL characters."));
            }
            let prepared = prepare(repo, n, connection, revision)?;
            let p = &prepared.plan;
            if input.plan_revision.is_empty() || p.revision != input.plan_revision {
                return Err(stale());
            }
            if !p.blockers.is_empty() || !p.methods.iter().any(|m| m.id == input.method) {
                return Err(error("This merge action is unavailable. Refresh the server checks and policies."));
            }
            if input.method == "queue" && !input.message.is_empty() {
                return Err(error("The merge queue uses its server-configured message and strategy."));
            }
            let (f, d, v) = scoped(repo, n, connection, revision)?;
            providers::send(repo, &f, &d, &v, &prepared.raw, p, &input)
        },
    )
}
#[cfg(test)]
#[path = "pr_merge_contracts.rs"]
mod contracts;
#[cfg(test)]
#[path = "pr_merge_tests.rs"]
mod tests;
