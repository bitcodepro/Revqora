//! What a pull request needs from its author or reviewer, read from the provider.
//!
//! The PR Center's "Needs attention" queue and the MCP `pull_request_queue` tool both use
//! this. CI and merge readiness come from the same server reads as the merge dialog
//! ([`super::pr_merge::current_readiness`]), so "Ready to merge" is never inferred from list data.

use super::{
    forge::{self, PrReviewer},
    pr_center, pr_merge,
    runner::{GitError, GitResult},
};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub number: u64,
    /// The PR metadata this answer belongs to (as in `pr_detail`).
    pub revision: String,
    pub head_sha: String,
    /// When the provider was read, in milliseconds since the Unix epoch.
    pub checked_at: u64,
    /// "failed", "pending", "passed" or "none" (no checks reported for the head commit).
    pub ci: &'static str,
    /// Names of failed or cancelled checks, at most five.
    pub failed_checks: Vec<String>,
    /// "ready" (the server reports nothing blocking a merge), "blocked", or "unknown"
    /// when the provider cannot confirm it through its API.
    pub merge: &'static str,
    pub blockers: Vec<String>,
    /// Reviewers with their state, when the list answer does not include it (GitLab).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewers: Option<Vec<PrReviewer>>,
    /// Whether a reviewer currently requests changes, as the server reports it for this PR.
    /// The list answer of GitHub and GitLab does not include it. None when not reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes_requested: Option<bool>,
    /// Whether the server reports merge conflicts with the target. None when not reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<bool>,
}

fn ci_state(checks: &[forge::Check]) -> (&'static str, Vec<String>) {
    let failed: Vec<String> = checks.iter().filter(|c| matches!(c.state.as_str(), "failure" | "cancelled")).map(|c| c.name.clone()).collect();
    let state = if !failed.is_empty() {
        "failed"
    } else if checks.iter().any(|c| c.state == "pending") {
        "pending"
    } else if checks.is_empty() {
        "none"
    } else {
        "passed"
    };
    (state, failed.into_iter().take(5).collect())
}

fn gitlab_reviewer_state(state: &str) -> &'static str {
    match state {
        "approved" => "approved",
        "requested_changes" => "changes_requested",
        "reviewed" => "commented",
        _ => "requested",
    }
}

fn gitlab_reviewers(v: &Value) -> Option<Vec<PrReviewer>> {
    let rows = v.as_array()?;
    Some(
        rows.iter()
            .map(|r| PrReviewer {
                id: forge::user_id(r, "/user/id"),
                login: r.pointer("/user/username").and_then(Value::as_str).unwrap_or("").into(),
                name: r.pointer("/user/name").and_then(Value::as_str).unwrap_or("").into(),
                state: gitlab_reviewer_state(r.get("state").and_then(Value::as_str).unwrap_or("")),
                group: false,
            })
            .collect(),
    )
}

/// Reads CI, merge readiness and (on GitLab) reviewer states of PR `number` through the
/// selected connection `connection`. Read-only: nothing is written to the server or the repository.
pub fn attention(repo: &Path, number: u64, connection: &str) -> GitResult<Attention> {
    let f = forge::reviewed_connection(repo, connection)?;
    let (detail, plan) = pr_merge::current_readiness(repo, number, connection)?;
    let (ci, failed_checks) = ci_state(&plan.checks);
    let merge = if f.kind == "bitbucket" || plan.merged {
        // Bitbucket Cloud's API does not report its merge checks.
        "unknown"
    } else if plan.blockers.is_empty() {
        "ready"
    } else {
        "blocked"
    };
    let reviewers = if f.kind == "gitlab" {
        let v = forge::request(repo, &f, "GET", &format!("{}/{number}/reviewers", pr_center::endpoint(&f)), None)?;
        Some(gitlab_reviewers(&v).ok_or_else(|| GitError::new("GitLab returned an invalid reviewer list."))?)
    } else {
        None
    };
    let changes_requested = match &reviewers {
        Some(list) => Some(list.iter().any(|r| r.state == "changes_requested")),
        None => plan.changes_requested,
    };
    let checked_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(Attention {
        number,
        revision: detail.revision,
        head_sha: detail.pull.head_sha,
        checked_at,
        ci,
        failed_checks,
        merge,
        blockers: if merge == "blocked" { plan.blockers } else { vec![] },
        reviewers,
        changes_requested,
        conflicts: plan.conflicts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn check(name: &str, state: &str) -> forge::Check {
        forge::Check { name: name.into(), state: state.into(), url: None }
    }

    #[test]
    fn ci_state_puts_failures_before_running_checks() {
        assert_eq!(ci_state(&[]), ("none", vec![]));
        assert_eq!(ci_state(&[check("a", "success"), check("b", "skipped")]), ("passed", vec![]));
        assert_eq!(ci_state(&[check("a", "success"), check("b", "pending")]), ("pending", vec![]));
        assert_eq!(ci_state(&[check("a", "pending"), check("b", "failure"), check("c", "cancelled")]), ("failed", vec!["b".into(), "c".into()]));
        let many: Vec<_> = (0..8).map(|i| check(&format!("c{i}"), "failure")).collect();
        assert_eq!(ci_state(&many).1.len(), 5);
    }

    #[test]
    fn gitlab_reviewer_states_map_to_shared_states() {
        let v = json!([
            {"user":{"id":1,"username":"ann","name":"Ann"},"state":"unreviewed"},
            {"user":{"id":2,"username":"bob","name":"Bob"},"state":"approved"},
            {"user":{"id":3,"username":"cy","name":"Cy"},"state":"requested_changes"},
            {"user":{"id":4,"username":"di","name":"Di"},"state":"reviewed"}
        ]);
        let states: Vec<_> = gitlab_reviewers(&v).unwrap().into_iter().map(|r| (r.id, r.login, r.state)).collect();
        assert_eq!(
            states,
            vec![
                ("1".into(), "ann".into(), "requested"),
                ("2".into(), "bob".into(), "approved"),
                ("3".into(), "cy".into(), "changes_requested"),
                ("4".into(), "di".into(), "commented")
            ]
        );
        assert!(gitlab_reviewers(&json!({"message":"x"})).is_none());
    }
}
