use super::*;
pub(super) fn actor(repo: &Path, f: &ForgeInfo) -> GitResult<(String, String)> {
    if f.kind == "bitbucket-server" {
        return Ok(("Native Git credentials (server permissions)".into(), "git-credentials".into()));
    }
    let path = if f.kind == "azure" { "/_apis/connectionData?api-version=7.1-preview.1" } else { "/user" };
    let u = forge::request(repo, f, "GET", path, None)?;
    let (name, id) = match f.kind.as_str() {
        "github" => (text(&u, "/login"), ident(&u, "/id")),
        "gitlab" => (text(&u, "/username"), ident(&u, "/id")),
        "azure" => (text(&u, "/authenticatedUser/providerDisplayName"), text(&u, "/authenticatedUser/id")),
        _ => (text(&u, "/display_name"), text(&u, "/uuid")),
    };
    if id.is_empty() || name.is_empty() {
        return Err(error("Could not verify the merge identity."));
    }
    Ok((name, id))
}
fn route(f: &ForgeInfo, n: u64, s: &str) -> String {
    format!("{}/{n}{s}", pr_center::endpoint(f))
}
fn gh(repo: &Path, f: &ForgeInfo, d: &Detail, p: &mut Plan) -> GitResult<Value> {
    let project = forge::project_path(&f.project);
    let parts = f.project.split_once('/').ok_or_else(|| error("Invalid GitHub repository."))?;
    let r = forge::request(repo, f, "GET", &format!("/repos/{project}"), None)?;
    let rules = forge::request(repo, f, "GET", &format!("/repos/{project}/rules/branches/{}?per_page=100", forge::enc(&d.pull.base)), None)?;
    let rule_rows = rows(&rules, "")?;
    if rule_rows.len() >= 100 {
        return Err(error("Branch rules may be truncated. Use GitHub to inspect and merge."));
    }
    let g=forge::graphql(repo,f,"query RevqoraMergeReadiness($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid baseRefOid mergeable mergeStateStatus reviewDecision mergeQueueEntry{id state position} baseRef{branchProtectionRule{requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews requiresStatusChecks requiresStrictStatusChecks requiresConversationResolution requiresCommitSignatures requiresLinearHistory}}}}}",json!({"owner":parts.0,"name":parts.1,"number":d.pull.number}))?;
    let pr = &g["repository"]["pullRequest"];
    if text(pr, "/headRefOid") != d.pull.head_sha || text(pr, "/baseRefOid") != d.base_sha || text(pr, "/id").is_empty() {
        return Err(stale());
    }
    if !yes(&r, "/permissions/push") || yes(&r, "/archived") {
        p.block("This account cannot merge into this repository, or the repository is archived.");
    }
    let mergeable = text(pr, "/mergeable");
    let state = text(pr, "/mergeStateStatus");
    let review = text(pr, "/reviewDecision");
    p.rule("Server merge state", format!("{mergeable} / {state}"), true);
    p.rule("Required reviews", if review.is_empty() { "No review decision reported".into() } else { review.clone() }, true);
    if mergeable != "MERGEABLE" {
        p.block("GitHub has not confirmed a conflict-free merge.");
    }
    if matches!(review.as_str(), "CHANGES_REQUESTED" | "REVIEW_REQUIRED") {
        p.block("Required reviews are not satisfied.");
    }
    if let Some(b) = pr.pointer("/baseRef/branchProtectionRule").filter(|b| !b.is_null()) {
        if yes(b, "/requiresApprovingReviews") {
            p.rule(
                "Classic branch protection",
                format!("{} approvals; code owners: {}", ident(b, "/requiredApprovingReviewCount"), yes(b, "/requiresCodeOwnerReviews")),
                true,
            );
        }
        for (key, label) in [
            ("requiresStatusChecks", "Required status checks"),
            ("requiresStrictStatusChecks", "Up-to-date branch"),
            ("requiresConversationResolution", "Resolved conversations"),
            ("requiresCommitSignatures", "Signed commits"),
            ("requiresLinearHistory", "Linear history"),
        ] {
            if yes(b, &format!("/{key}")) {
                p.rule(label, "Required by classic protection", true);
            }
        }
    }
    let queue = rule_rows.iter().any(|r| text(r, "/type") == "merge_queue");
    for rule in rule_rows {
        let name = text(rule, "/type");
        if name.is_empty() {
            return Err(error("GitHub returned an unnamed branch rule."));
        }
        p.rule(format!("Ruleset: {name}"), "Enforced by GitHub", true);
    }
    if let Some(q) = pr.get("mergeQueueEntry").filter(|q| !q.is_null()) {
        p.queue_state = Some(format!("{} · position {}", text(q, "/state"), ident(q, "/position")));
        p.block("This PR is already in the merge queue. Check its progress instead of submitting again.");
    } else if queue {
        p.method("queue", "Add to merge queue", "GitHub chooses the queue strategy and tests the merge group. This does not merge immediately.");
        p.notices.push("The destination requires a merge queue. Direct merge and admin bypass are unavailable.".into());
    } else {
        if state != "CLEAN" {
            p.block("GitHub does not report this request ready for a direct merge.");
        }
        for (flag, id, label, help) in [
            ("allow_merge_commit", "merge", "Merge commit", "Preserve individual commits and create a merge commit."),
            ("allow_squash_merge", "squash", "Squash merge", "Combine the PR changes into one destination commit."),
            ("allow_rebase_merge", "rebase", "Rebase merge", "Replay commits on the destination; commit IDs change."),
        ] {
            if yes(&r, &format!("/{flag}")) {
                p.method(id, label, help);
            }
        }
    }
    if !queue {
        if pr.pointer("/baseRef/branchProtectionRule").is_some_and(|b| yes(b, "/requiresLinearHistory"))
            || rule_rows.iter().any(|r| text(r, "/type") == "required_linear_history")
        {
            p.methods.retain(|m| m.id != "merge");
        }
        for rule in rule_rows {
            if let Some(allowed) = rule.pointer("/parameters/allowed_merge_methods") {
                let allowed = rows(allowed, "")?;
                p.methods.retain(|m| allowed.iter().any(|v| v.as_str() == Some(m.id.as_str())));
            }
        }
    }
    p.checks = checks::load(repo, f, d)?;
    checks::caution(p);
    Ok(json!({"repositoryId":r.get("id"),"rules":rules,"pull":pr}))
}
fn gl(repo: &Path, f: &ForgeInfo, d: &Detail, v: &Value, p: &mut Plan) -> GitResult<Value> {
    let r = forge::request(repo, f, "GET", &format!("/projects/{}", forge::enc(&f.project)), None)?;
    let state = text(v, "/detailed_merge_status");
    p.rule("GitLab merge requirements", state.clone(), true);
    if state != "mergeable" || !yes(v, "/user/can_merge") || yes(&r, "/archived") {
        p.block("GitLab has not granted a ready merge to this user (reviews, pipeline, discussions or permissions may still block it).");
    }
    if v.get("auto_merge_enabled").and_then(Value::as_bool) == Some(true) || yes(v, "/merge_when_pipeline_succeeds") {
        p.queue_state = Some("GitLab auto-merge already enabled".into());
        p.block("This request is already scheduled to merge. Manage it on GitLab.");
    }
    let method = text(&r, "/merge_method");
    let (label, help) = match method.as_str() {
        "merge" => ("Merge commit", "Use the project's configured merge-commit strategy."),
        "rebase_merge" => ("Semi-linear merge", "Use the project's configured semi-linear merge; GitLab may require a prior rebase."),
        "ff" => ("Fast-forward", "Use the project's configured fast-forward strategy."),
        _ => return Err(error("Unknown GitLab project merge strategy.")),
    };
    let squash = text(&r, "/squash_option");
    if matches!(squash.as_str(), "never" | "default_off" | "default_on" | "do_not_allow" | "allow" | "encourage") {
        p.method("configured", label, help);
    }
    if matches!(squash.as_str(), "always" | "default_off" | "default_on" | "require" | "allow" | "encourage") {
        p.method("squash", "Squash with project strategy", "Squash first, then use the project's configured merge strategy.");
    }
    if p.methods.is_empty() {
        return Err(error("Unknown GitLab squash policy."));
    }
    p.rule("Project strategy", format!("{method}; squash: {squash}"), true);
    if let Some(h) = v.get("head_pipeline").filter(|h| !h.is_null()) {
        let sha = text(h, "/sha");
        if sha != d.pull.head_sha {
            p.notices.push(
                "The MR pipeline uses a synthetic merged-results commit; GitLab's detailed merge status determines required pipeline eligibility.".into(),
            );
        }
        p.checks.push(forge::Check {
            name: "MR pipeline".into(),
            state: checks::status(&text(h, "/status")),
            url: Some(text(h, "/web_url")).filter(|s| !s.is_empty()),
        });
    }
    p.checks.extend(checks::load(repo, f, d)?);
    checks::caution(p);
    Ok(json!({"project":r,"status":state,"user":v.get("user"),"pipeline":v.get("head_pipeline"),"scheduled":v.get("auto_merge_enabled")}))
}
fn az(repo: &Path, f: &ForgeInfo, d: &Detail, v: &Value, p: &mut Plan) -> GitResult<Value> {
    let project = text(v, "/repository/project/id");
    if project.is_empty() {
        return Err(error("Azure did not identify the pull request's project for policy evaluation."));
    }
    let name = f.project.split_once('/').ok_or_else(|| error("Invalid Azure project."))?.0;
    let artifact = forge::enc(&format!("vstfs:///CodeReview/CodeReviewId/{project}/{}", d.pull.number));
    let mut policies = vec![];
    for page in 0..50 {
        let r = forge::request(
            repo,
            f,
            "GET",
            &format!(
                "/{}/_apis/policy/evaluations?artifactId={artifact}&includeNotApplicable=true&$top=100&$skip={}&api-version=7.1-preview.1",
                forge::enc(name),
                page * 100
            ),
            None,
        )?;
        let list = rows(&r, "/value")?;
        policies.extend(list.clone());
        if list.len() < 100 {
            break;
        }
        if page == 49 {
            return Err(error("Azure policy evaluations exceed the complete preview limit."));
        }
    }
    let state = text(v, "/mergeStatus");
    p.rule("Azure merge state", state.clone(), true);
    if state != "succeeded" {
        p.block("Azure has not completed a conflict-free merge evaluation.");
    }
    let mut methods = vec![
        ("noFastForward", "Merge commit", "Create a merge commit; keep the source branch unchanged."),
        ("squash", "Squash merge", "Combine changes into one commit; keep the source branch unchanged."),
        ("rebase", "Rebase and fast-forward", "Azure rewrites the source branch and fast-forwards the destination."),
        ("rebaseMerge", "Rebase with merge commit", "Azure rewrites the source branch and creates a merge commit."),
    ];
    for policy in &policies {
        let config = &policy["configuration"];
        match config.get("isEnabled").and_then(Value::as_bool) {
            Some(false) => continue,
            Some(true) => {}
            None => return Err(error("Azure policy enablement is missing.")),
        }
        let required = config.get("isBlocking").and_then(Value::as_bool).ok_or_else(|| error("Azure policy blocking state is missing."))?;
        let status = text(policy, "/status");
        p.rule(text(config, "/type/displayName"), status.clone(), required);
        if required && !matches!(status.as_str(), "approved" | "notApplicable") {
            p.block("A required Azure policy has not approved this PR.");
        }
        let settings = &config["settings"];
        if required
            && status != "notApplicable"
            && ["allowNoFastForward", "allowSquash", "allowRebase", "allowRebaseMerge"].iter().any(|k| settings.get(k).is_some())
        {
            methods.retain(|(id, _, _)| {
                yes(
                    settings,
                    &format!(
                        "/{}",
                        match *id {
                            "noFastForward" => "allowNoFastForward",
                            "squash" => "allowSquash",
                            "rebase" => "allowRebase",
                            _ => "allowRebaseMerge",
                        }
                    ),
                )
            });
        }
    }
    if v.get("autoCompleteSetBy").is_some_and(|x| !x.is_null() && !text(x, "/id").is_empty()) {
        p.queue_state = Some("Azure auto-complete already enabled".into());
        p.block("This PR already has auto-complete enabled. Manage it on Azure.");
    }
    for (id, label, help) in methods {
        p.method(id, label, help);
    }
    p.notices.push(
        "Azure checks completion rights on submission. Policy bypass, automatic work-item transitions and automatic source deletion are disabled.".into(),
    );
    p.checks = checks::load(repo, f, d)?;
    checks::caution(p);
    Ok(json!({"policies":policies,"mergeStatus":state,"autoComplete":v.get("autoCompleteSetBy")}))
}
fn bbs(repo: &Path, f: &ForgeInfo, d: &Detail, v: &Value, p: &mut Plan) -> GitResult<Value> {
    let readiness = forge::request(repo, f, "GET", &route(f, d.pull.number, "/merge"), None)?;
    let settings = forge::request(repo, f, "GET", &format!("{}/settings/pull-requests", forge::server_repo(f)), None)?;
    if readiness.get("conflicted").and_then(Value::as_bool) != Some(false) {
        p.block("Bitbucket has not confirmed a conflict-free merge.");
    }
    for veto in rows(&readiness, "/vetoes")? {
        let label = text(veto, "/summaryMessage");
        p.rule(label.clone(), text(veto, "/detailedMessage"), true);
        p.block(label);
    }
    if v.get("version").and_then(Value::as_u64).is_none() {
        return Err(error("Bitbucket did not provide the version required for a conditional merge."));
    }
    for strategy in rows(&settings, "/mergeConfig/strategies")? {
        // Supported built-in strategies only. Server still rejects disallowed strategies.
        let id = text(strategy, "/id");
        let (label, help) = match id.as_str() {
            "no-ff" => ("Merge commit", "Always create a merge commit."),
            "ff" => ("Fast-forward or merge", "Fast-forward when possible; otherwise create a merge commit."),
            "ff-only" => ("Fast-forward only", "Require the destination to be an ancestor of the source."),
            "squash" => ("Squash merge", "Combine changes into one commit."),
            "squash-ff-only" => ("Squash, fast-forward only", "Squash using the server's fast-forward-only strategy."),
            "rebase-no-ff" => ("Rebase with merge commit", "Replay commits, then create a merge commit."),
            "rebase-ff-only" => ("Rebase and fast-forward", "Replay commits, then fast-forward."),
            _ => continue,
        };
        if strategy.get("enabled").and_then(Value::as_bool) != Some(false) {
            p.method(&id, label, help);
        }
    }
    p.rule("Merge vetoes", if p.blockers.is_empty() { "None reported" } else { "Merge blocked" }, true);
    p.notices.push("Bitbucket Server authenticates with native Git credentials; merge permissions and plug-in checks are re-evaluated by the server.".into());
    p.checks = checks::load(repo, f, d)?;
    checks::caution(p);
    Ok(json!({"readiness":readiness,"settings":settings,"version":v.get("version")}))
}
pub(super) fn inspect(repo: &Path, f: &ForgeInfo, d: &Detail, v: &Value, p: &mut Plan) -> GitResult<Value> {
    let result = match f.kind.as_str() {
        "github" => gh(repo, f, d, p),
        "gitlab" => gl(repo, f, d, v, p),
        "azure" => az(repo, f, d, v, p),
        "bitbucket-server" => bbs(repo, f, d, v, p),
        _ => {
            p.checks = checks::load(repo, f, d)?;
            p.block("Bitbucket Cloud's merge endpoint has no expected-source-SHA lease. Merge on Bitbucket so a new source commit cannot be merged under an old confirmation.");
            p.rule("Bitbucket Cloud merge checks", "Review required checks and branch restrictions on Bitbucket", true);
            Ok(Value::Null)
        }
    }?;
    if p.methods.is_empty() {
        p.block("No supported merge method is available under the current server settings.");
    }
    Ok(result)
}
fn unknown() -> GitError {
    GitError::new(
        "The merge may have been accepted, but its result could not be confirmed. Check the server before any manual retry; no branch cleanup was started.",
    )
    .kind("forge-write-uncertain")
}
pub(super) fn send(repo: &Path, f: &ForgeInfo, d: &Detail, v: &Value, raw: &Value, p: &Plan, input: &MergeInput) -> GitResult<MergeResult> {
    let n = d.pull.number;
    let queue = input.method == "queue";
    let result = if f.kind == "github" {
        let id = text(raw, "/pull/id");
        let (query, variables) = if queue {
            ("mutation RevqoraEnqueue($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,jump:false}){mergeQueueEntry{id state position}}}",json!({"id":id,"head":d.pull.head_sha}))
        } else {
            ("mutation RevqoraMerge($id:ID!,$head:GitObjectID!,$method:PullRequestMergeMethod!,$body:String){mergePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method,commitBody:$body}){pullRequest{merged mergeCommit{oid}}}}",json!({"id":id,"head":d.pull.head_sha,"method":input.method.to_ascii_uppercase(),"body":if input.message.is_empty(){Value::Null}else{json!(input.message)}}))
        };
        forge::graphql_as(repo, f, query, variables, Some(&p.actor_id))
            .map_err(|e| if e.kind == "forge-graphql" { unknown() } else { pr_center::uncertain(e) })?
    } else {
        let (method, path, mut body) = match f.kind.as_str() {
            "gitlab" => (
                "PUT",
                route(f, n, "/merge"),
                json!({"sha":d.pull.head_sha,"squash":input.method=="squash","merge_commit_message":input.message,"squash_commit_message":input.message,"should_remove_source_branch":false,"auto_merge":false,"merge_when_pipeline_succeeds":false}),
            ),
            "azure" => (
                "PATCH",
                format!("{}?api-version=7.1", route(f, n, "")),
                json!({"status":"completed","lastMergeSourceCommit":{"commitId":d.pull.head_sha},"completionOptions":{"mergeStrategy":input.method,"mergeCommitMessage":input.message,"bypassPolicy":false,"deleteSourceBranch":false,"transitionWorkItems":false}}),
            ),
            "bitbucket-server" => {
                ("POST", route(f, n, "/merge"), json!({"version":v["version"],"strategyId":input.method,"message":input.message,"autoMerge":false}))
            }
            _ => return Err(error("No conditional merge is available for this provider.")),
        };
        if input.message.is_empty() {
            if let Some(object) = body.as_object_mut() {
                for key in ["merge_commit_message", "squash_commit_message", "message"] {
                    object.remove(key);
                }
            }
            if let Some(object) = body.get_mut("completionOptions").and_then(Value::as_object_mut) {
                object.remove("mergeCommitMessage");
            }
        }
        let content = forge::write_response(repo, f, method, &path, Some(body), &p.actor_id).map_err(pr_center::uncertain)?;
        serde_json::from_slice::<Value>(&content.bytes).map_err(|_| unknown())?
    };
    if queue {
        let q = &result["enqueuePullRequest"]["mergeQueueEntry"];
        if text(q, "/id").is_empty() {
            return Err(unknown());
        }
        return Ok(MergeResult {
            state: "queued".into(),
            commit: None,
            message: format!("Added to the merge queue: {}. Merge and cleanup have not completed.", text(q, "/state")),
        });
    }
    let (merged, commit) = match f.kind.as_str() {
        "github" => (yes(&result, "/mergePullRequest/pullRequest/merged"), text(&result, "/mergePullRequest/pullRequest/mergeCommit/oid")),
        "gitlab" => (text(&result, "/state") == "merged", {
            let sha = text(&result, "/merge_commit_sha");
            if sha.is_empty() {
                text(&result, "/squash_commit_sha")
            } else {
                sha
            }
        }),
        "azure" => (text(&result, "/status") == "completed", text(&result, "/lastMergeCommit/commitId")),
        _ => (text(&result, "/state") == "MERGED", text(&result, "/properties/mergeCommit/id")),
    };
    if merged {
        return Ok(MergeResult {
            state: "merged".into(),
            commit: oid(&commit).then_some(commit),
            message: "The server confirmed the PR is merged. Source branches were not deleted by Revqora.".into(),
        });
    }
    if f.kind == "azure" && text(&result, "/status") == "active" {
        return Ok(MergeResult {
            state: "accepted".into(),
            commit: None,
            message:
                "Azure accepted the completion request; completion is still pending. Refresh the PR; source cleanup remains unavailable until it is merged."
                    .into(),
        });
    }
    Err(unknown())
}
