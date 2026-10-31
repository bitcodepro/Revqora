//! Optional, separately reviewed post-merge cleanup using existing CAS/checkpoint deletion.
use super::*;
use crate::git::{branch_deletion, branch_protection, branch_review, recovery, runner};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupInput {
    pub local: bool,
    pub remote: bool,
    pub force: bool,
    pub protection_rules: Vec<String>,
    pub review_token: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReview {
    pub token: String,
    pub plan: branch_review::DeletionPlan,
    pub local: bool,
    pub remote: bool,
    pub source_sha: String,
    pub notices: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub state: String,
    pub local_deleted: bool,
    pub remote_deleted: bool,
    pub checkpoint: Option<recovery::Summary>,
    pub warning: Option<String>,
}
fn same(v: &Value, a: &str, b: &str) -> bool {
    let a = ident(v, a);
    !a.is_empty() && a == ident(v, b)
}
fn source_repo(f: &ForgeInfo, v: &Value) -> bool {
    match f.kind.as_str() {
        "github" => same(v, "/head/repo/id", "/base/repo/id") && text(v, "/base/repo/full_name").eq_ignore_ascii_case(&f.project),
        "gitlab" => same(v, "/source_project_id", "/target_project_id"),
        "bitbucket" => {
            same(v, "/source/repository/uuid", "/destination/repository/uuid") && text(v, "/destination/repository/full_name").eq_ignore_ascii_case(&f.project)
        }
        "bitbucket-server" => same(v, "/fromRef/repository/id", "/toRef/repository/id"),
        "azure" => {
            !ident(v, "/repository/id").is_empty() && (v.get("forkSource").is_none_or(Value::is_null) || same(v, "/forkSource/repository/id", "/repository/id"))
        }
        _ => false,
    }
}
fn default_branch(repo: &Path, f: &ForgeInfo) -> GitResult<String> {
    let path = match f.kind.as_str() {
        "github" => format!("/repos/{}", forge::project_path(&f.project)),
        "gitlab" => format!("/projects/{}", forge::enc(&f.project)),
        "bitbucket" => format!("/repositories/{}", forge::project_path(&f.project)),
        "bitbucket-server" => format!("{}/branches/default", forge::server_repo(f)),
        _ => format!("{}?api-version=7.1", forge::azure_repo(f)),
    };
    let r = forge::request(repo, f, "GET", &path, None)?;
    let value = text(
        &r,
        match f.kind.as_str() {
            "bitbucket" => "/mainbranch/name",
            "bitbucket-server" => "/displayId",
            "azure" => "/defaultBranch",
            _ => "/default_branch",
        },
    );
    let name = value.strip_prefix("refs/heads/").unwrap_or(&value).to_string();
    if name.is_empty() {
        return Err(error("Cannot verify the server's default branch. Cleanup is unavailable."));
    }
    Ok(name)
}
fn remote_policy(repo: &Path, f: &ForgeInfo, name: &str) -> GitResult<()> {
    let path = match f.kind.as_str() {
        "github" => format!("/repos/{}/branches/{}", forge::project_path(&f.project), forge::enc(name)),
        "gitlab" => format!("/projects/{}/repository/branches/{}", forge::enc(&f.project), forge::enc(name)),
        _ => return Ok(()),
    };
    let v = forge::request(repo, f, "GET", &path, None)?;
    if v.get("protected").and_then(Value::as_bool) != Some(false) {
        return Err(error("The source branch is protected, or its server protection state is unknown. It was kept."));
    }
    Ok(())
}
pub fn cleanup_plan(repo: &Path, n: u64, connection: &str, revision: &str, input: &CleanupInput) -> GitResult<CleanupReview> {
    let (f, d, v) = scoped(repo, n, connection, revision)?;
    if d.pull.state != "merged" || !source_repo(&f, &v) {
        return Err(error("Cleanup requires a server-confirmed merged PR whose source is in this same repository. Fork branches are kept."));
    }
    if !input.local && !input.remote {
        return Err(error("Select local and/or remote branch cleanup."));
    }
    let name = &d.pull.head;
    if name == &d.pull.base || name == &default_branch(repo, &f)? {
        return Err(error("The destination and default branch are never cleanup targets."));
    }
    runner::run(repo, ["check-ref-format", "--branch", name])?;
    let reference = format!("refs/heads/{name}");
    if input.local {
        if runner::exec(repo, ["symbolic-ref", "-q", &reference])?.ok() {
            return Err(error("A symbolic local branch cannot be a cleanup target."));
        }
        let current = runner::run(repo, ["rev-parse", "--verify", &reference])?;
        if current.trim() != d.pull.head_sha {
            return Err(error("The local source branch contains different commits. Review it in Branch Manager; it was kept."));
        }
    }
    let target = if input.remote {
        remote_policy(repo, &f, name)?;
        let candidates = branch_deletion::targets(repo, name)?;
        let mut selected = candidates.into_iter().filter(|t| t.remote == f.remote && t.remote_ref == reference && t.oid == d.pull.head_sha).collect::<Vec<_>>();
        if selected.len() != 1 {
            return Err(error("There is no unique fetched source-branch mapping at the merged SHA. Fetch and inspect Branch Manager before cleanup."));
        }
        let t = selected.remove(0);
        let fetch = runner::run(repo, ["remote", "get-url", &t.remote])?;
        if fetch.trim() != t.push_url {
            return Err(error("The remote has a separate push destination. Cleanup from the PR is disabled."));
        }
        let advertised = runner::run(repo, ["ls-remote", "--heads", "--refs", "--", &t.push_url, &reference])?;
        if !advertised.lines().any(|line| line.split_once('\t').is_some_and(|(sha, r)| sha == d.pull.head_sha && r == reference)) {
            return Err(error("The source branch is missing or has new server commits. It was kept; reload the repository."));
        }
        Some(t)
    } else {
        None
    };
    branch_protection::require_allowed(Some(&input.protection_rules), input.local.then_some(name.as_str()), target.as_ref())?;
    let plan = branch_review::plan(repo, name, None, target, None, !input.local)?;
    if input.local && !plan.worktrees.is_empty() {
        return Err(error("The source branch is checked out in a worktree. Switch it to another branch before local cleanup."));
    }
    if input.local && plan.proof.local_oid != d.pull.head_sha {
        return Err(stale());
    }
    scoped(repo, n, connection, revision)?;
    let token = hash(
        serde_json::to_vec(&json!([connection, revision, input.local, input.remote, input.protection_rules, plan.proof, plan.state_token]))
            .map_err(|_| error("Could not fingerprint cleanup."))?,
    );
    Ok(CleanupReview{token,plan,local:input.local,remote:input.remote,source_sha:d.pull.head_sha,notices:vec!["A merged PR is not proof that every source commit is reachable after squash/rebase. Outside-history deletion requires explicit consent and saves a recovery checkpoint.".into(),"Git server deletion uses an exact-SHA lease. Server permissions remain final. Working files and other branches are kept.".into()]})
}
pub fn cleanup_act(repo: &Path, n: u64, connection: &str, revision: &str, input: CleanupInput) -> GitResult<CleanupResult> {
    super::super::operations::access(
        repo,
        true,
        |_, _| {},
        || {
            let review = cleanup_plan(repo, n, connection, revision, &input)?;
            if input.review_token.is_empty() || input.review_token != review.token {
                return Err(stale());
            }
            let proof = &review.plan.proof;
            let mut result = CleanupResult { state: "done".into(), local_deleted: false, remote_deleted: false, checkpoint: None, warning: None };
            if input.local {
                let local = branch_review::delete_local(repo, proof, input.remote, input.force, Some(&review.plan.state_token), Some(&input.protection_rules))?;
                result.local_deleted = true;
                result.checkpoint = Some(local.checkpoint);
                result.warning = local.warning;
            }
            if input.remote {
                match branch_review::delete_remote(
                    repo,
                    proof,
                    input.force,
                    if input.local { None } else { Some(&review.plan.state_token) },
                    Some(&input.protection_rules),
                    |_| {},
                ) {
                    Ok(remote) => {
                        result.remote_deleted = true;
                        result.checkpoint = Some(remote.checkpoint);
                    }
                    Err(e) if result.local_deleted => {
                        result.state = "partial".into();
                        result.warning =
                            Some(format!("Local branch deleted; remote cleanup did not complete: {}. No automatic retry was attempted.", e.message));
                    }
                    Err(e) => return Err(e),
                }
            }
            Ok(result)
        },
    )
}
