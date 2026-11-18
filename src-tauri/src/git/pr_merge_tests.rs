use super::*;
#[test]
fn bitbucket_ci_pagination_cannot_hide_a_later_failure_or_cross_repository() {
    let mut f = ForgeInfo {
        account_id: None,
        kind: "bitbucket-server".into(),
        host: "example.invalid".into(),
        project: "team/repo".into(),
        remote: "origin".into(),
        web_url: "https://example.invalid".into(),
        api: "https://example.invalid".into(),
        connection_revision: None,
        account_login: None,
    };
    let result = checks::bitbucket(&f, &"a".repeat(40), |p| {
        Ok(if p.contains("start=100") {
            json!({"values":[{"name":"Late build","state":"FAILED"}],"isLastPage":true})
        } else {
            json!({"values":[{"name":"First build","state":"SUCCESSFUL"}],"isLastPage":false,"nextPageStart":100})
        })
    })
    .unwrap();
    assert_eq!(result.len(), 2);
    assert_eq!(result[1].state, "failure");
    assert!(checks::bitbucket(&f, &"a".repeat(40), |_| Ok(json!({"values":[],"isLastPage":false}))).is_err());
    f.kind = "bitbucket".into();
    f.api = "https://api.bitbucket.org/2.0".into();
    for next in [
        "https://api.bitbucket.org/2.0/repositories/other/repo/commit/a/statuses?page=2",
        "https://other.invalid/2.0/repositories/team/repo/commit/a/statuses?page=2",
    ] {
        assert!(checks::bitbucket(&f, &"a".repeat(40), |_| Ok(json!({"values":[],"next":next}))).is_err());
    }
}
#[test]
fn unknown_check_states_are_never_green() {
    assert_eq!(checks::status("future-state"), "pending");
    assert_eq!(checks::status("cancelled"), "cancelled");
    assert_eq!(checks::status("succeeded"), "success");
}

#[test]
fn github_reports_requested_changes_and_conflicts_for_the_attention_queue() {
    use serde_json::json;
    let facts = super::providers::github_review_facts;
    // A branch without required reviews: reviewDecision is null, the latest reviews say it.
    let open = json!({"mergeable":"MERGEABLE","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[{"state":"APPROVED"},{"state":"CHANGES_REQUESTED"}]}});
    assert_eq!(facts(&open), (Some(true), Some(false)));
    let decided = json!({"mergeable":"CONFLICTING","reviewDecision":"CHANGES_REQUESTED"});
    assert_eq!(facts(&decided), (Some(true), Some(true)));
    let approved = json!({"mergeable":"UNKNOWN","reviewDecision":"APPROVED","latestOpinionatedReviews":{"nodes":[{"state":"APPROVED"}]}});
    assert_eq!(facts(&approved), (Some(false), None));
    assert_eq!(facts(&json!({"reviewDecision":null})), (None, None), "not reported stays unknown");
}
