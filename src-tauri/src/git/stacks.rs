//! Linear dependent branches. One reviewed rebase at a time; no bulk force push.
use super::{
    branch_protection, forge, history, operations, pr_center, recovery, repo,
    runner::{self, GitError, GitResult},
    status, storage, sync, workflows as json,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
fn fail(s: impl Into<String>) -> GitError {
    GitError::new(s).kind("branch-stack")
}
fn stale() -> GitError {
    GitError::new("Stack metadata, refs or working files changed. Refresh and review again.").kind("stale-operation")
}
fn oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn branch(root: &Path, s: &str) -> GitResult<()> {
    if s.is_empty() || s.len() > 1024 || s.starts_with('-') || !runner::exec(root, ["check-ref-format", &format!("refs/heads/{s}")])?.ok() {
        return Err(fail("Choose a valid local branch name."));
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pending {
    pub original: String,
    pub parent_oid: String,
    pub checkpoint: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub branch: String,
    pub boundary: String,
    pub pull: Option<u64>,
    #[serde(default)]
    pub pull_connection: Option<String>,
    pub pending: Option<Pending>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stack {
    pub id: String,
    pub name: String,
    pub base: String,
    pub entries: Vec<Entry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub revision: String,
    pub stacks: Vec<Stack>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub catalog: Catalog,
    pub tips: BTreeMap<String, String>,
    pub current: Option<String>,
    pub state_token: String,
}
fn dir(root: &Path) -> GitResult<PathBuf> {
    let d = storage::common(root)?.join("stacks");
    json::direct(d.parent().unwrap())?;
    fs::create_dir_all(&d)?;
    json::direct(&d)?;
    Ok(d)
}
pub fn catalog(root: &Path) -> GitResult<Catalog> {
    let file = dir(root)?.join("definitions.json");
    let stacks: Vec<Stack> = if file.exists() { json::read(&file)? } else { vec![] };
    if stacks.len() > 20 {
        return Err(fail("Keep at most 20 stacks."));
    }
    let mut branches = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for s in &stacks {
        if !valid_id(&s.id) || !ids.insert(&s.id) || s.name.trim().is_empty() || s.name.len() > 200 || s.entries.len() > 16 {
            return Err(fail("Invalid stack metadata."));
        }
        branch(root, &s.base)?;
        for e in &s.entries {
            branch(root, &e.branch)?;
            if e.branch == s.base
                || !branches.insert(&e.branch)
                || !oid(&e.boundary)
                || e.pull.is_some_and(|n| n == 0 || n > 9_007_199_254_740_991)
                || e.pending.as_ref().is_some_and(|p| !oid(&p.original) || !oid(&p.parent_oid))
            {
                return Err(fail("Invalid stack branch, boundary or pending result."));
            }
        }
    }
    if stacks.iter().any(|s| branches.contains(&s.base)) {
        return Err(fail("A stack base cannot also be a tracked layer. Keep each dependent chain in one stack."));
    }
    Ok(Catalog { revision: json::digest(&stacks)?, stacks })
}
fn write(root: &Path, c: &Catalog) -> GitResult<Catalog> {
    json::write(&dir(root)?.join("definitions.json"), &c.stacks)?;
    catalog(root)
}
fn heads(root: &Path) -> GitResult<BTreeMap<String, String>> {
    let raw = history::run(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)", "refs/heads/"])?;
    let mut out = BTreeMap::new();
    for row in raw.lines() {
        let fields: Vec<_> = row.split('\0').collect();
        if fields.len() == 4 && fields[2].is_empty() && fields[3] == "commit" && oid(fields[1]) {
            out.insert(fields[0].strip_prefix("refs/heads/").unwrap_or(fields[0]).into(), fields[1].into());
        }
    }
    Ok(out)
}
fn tip<'a>(tips: &'a BTreeMap<String, String>, name: &str) -> GitResult<&'a str> {
    tips.get(name).map(String::as_str).ok_or_else(|| fail(format!("Branch {name} is missing, symbolic or not a direct commit reference.")))
}
fn ancestor(root: &Path, a: &str, b: &str) -> GitResult<bool> {
    let result = history::exec(root, ["merge-base", "--is-ancestor", a, b])?;
    match result.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(runner::to_error("compare stack history", &result)),
    }
}
fn guard_working_copy(root: &Path, branch: &str, parent: &str, range: &str) -> GitResult<()> {
    if super::extras::worktrees(root)?.iter().any(|w| !w.is_current && w.branch.as_deref() == Some(branch)) {
        return Err(fail("This branch is also checked out in another worktree. Switch that copy away before rewriting it."));
    }
    let flags = runner::run(root, ["ls-files", "-v", "-z"])?;
    if flags.split('\0').filter_map(|p| p.as_bytes().first()).any(|b| *b == b'S' || b.is_ascii_lowercase()) {
        return Err(fail("Clear skip-worktree / assume-unchanged flags before restacking so hidden edits can be inspected."));
    }
    let ignored = super::workspace_files::ignored(root)?;
    if ignored.truncated {
        return Err(fail("Ignored-file inspection was truncated; no rebase was started."));
    }
    if ignored.paths.is_empty() {
        return Ok(());
    }
    let normalize = |p: &str| {
        let p = p.trim_start_matches('\n').trim_end_matches('/').replace('\\', "/");
        if cfg!(windows) {
            p.to_lowercase()
        } else {
            p
        }
    };
    let ignored: Vec<_> = ignored.paths.iter().map(|p| normalize(p)).collect();
    let parent_files = history::run(root, ["ls-tree", "-r", "-z", "--name-only", parent])?;
    let replay_files = history::run(root, ["log", "--format=", "--name-only", "-z", "--no-renames", range])?;
    for p in parent_files.split('\0').chain(replay_files.split('\0')).filter(|p| !p.trim_matches('\n').is_empty()) {
        let p = normalize(p);
        if ignored.iter().any(|i| p == *i || p.starts_with(&format!("{i}/")) || i.starts_with(&format!("{p}/"))) {
            return Err(fail("An ignored path overlaps files checked out during this rebase. Move that ignored data aside before reviewing again."));
        }
    }
    Ok(())
}
pub fn snapshot(root: &Path) -> GitResult<Snapshot> {
    let ((catalog, tips, current), state_token) = operations::inspect(root, || Ok((catalog(root)?, heads(root)?, status::status(root)?.branch)))?;
    Ok(Snapshot { catalog, tips, current, state_token })
}
pub fn create(root: &Path, name: &str, base: &str, expected: &str) -> GitResult<Catalog> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let d = dir(root)?;
            let _lock = json::lock(&d, "catalog.lock")?;
            let mut c = catalog(root)?;
            if c.revision != expected {
                return Err(stale());
            }
            if name.trim().is_empty() || name.len() > 200 || c.stacks.len() >= 20 {
                return Err(fail("Name the stack (up to 200 characters); keep at most 20 stacks."));
            }
            branch(root, base)?;
            if c.stacks.iter().any(|s| s.entries.iter().any(|e| e.branch == base)) {
                return Err(fail("That branch is already a layer. Append to its existing chain instead of creating a cross-stack dependency."));
            }
            let tips = heads(root)?;
            tip(&tips, base)?;
            c.stacks.push(Stack { id: json::id()?, name: name.trim().into(), base: base.into(), entries: vec![] });
            write(root, &c)
        },
    )
}
pub fn append(root: &Path, id: &str, name: &str, existing: bool, expected: &str, expected_state: &str) -> GitResult<Catalog> {
    operations::run(
        root,
        "stack_append",
        Some(expected_state),
        |_, _| {},
        || {
            sync::require_actual_history(root)?;
            branch(root, name)?;
            let d = dir(root)?;
            let _lock = json::lock(&d, "catalog.lock")?;
            let mut c = catalog(root)?;
            if c.revision != expected {
                return Err(stale());
            }
            if c.stacks.iter().any(|s| s.base == name || s.entries.iter().any(|e| e.branch == name)) {
                return Err(fail("This branch already belongs to a stack."));
            }
            let s = c.stacks.iter_mut().find(|s| s.id == id).ok_or_else(|| fail("Stack not found."))?;
            if s.entries.len() >= 16 || s.entries.iter().any(|e| e.pending.is_some()) || name == s.base {
                return Err(fail("Finish pending restacks first; a stack supports 16 distinct branches."));
            }
            let parent = s.entries.last().map(|e| e.branch.as_str()).unwrap_or(&s.base);
            let tips = heads(root)?;
            let boundary = tip(&tips, parent)?.to_owned();
            if existing {
                let child = tip(&tips, name)?;
                if !ancestor(root, &boundary, child)? {
                    return Err(fail("Adopt only a branch that contains the current parent tip. Update the parent or choose the correct stack first."));
                }
            } else {
                let reference = format!("refs/heads/{name}");
                if runner::exec(root, ["symbolic-ref", "-q", &reference])?.ok()
                    || tips.keys().any(|b| if cfg!(windows) { b.to_lowercase() == name.to_lowercase() } else { b == name })
                {
                    return Err(fail("The branch already exists or is a symbolic/case alias. Choose a new name."));
                }
                // Atomic create-only CAS. Never follow a newly introduced symref
                // between preflight and dispatch, including a dangling alias.
                runner::run(
                    root,
                    [
                        "update-ref",
                        "--no-deref",
                        "--create-reflog",
                        "-m",
                        "Revqora: add dependent stack layer",
                        &reference,
                        &boundary,
                        &"0".repeat(boundary.len()),
                    ],
                )?;
            }
            s.entries.push(Entry { branch: name.into(), boundary, pull: None, pull_connection: None, pending: None });
            write(root, &c).map_err(|e| fail(format!("{} The Git branch was kept. Refresh before adopting or creating another layer.", e.message)))
        },
    )
}
pub fn forget(root: &Path, id: &str, expected: &str) -> GitResult<Catalog> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let d = dir(root)?;
            let _lock = json::lock(&d, "catalog.lock")?;
            let mut c = catalog(root)?;
            if c.revision != expected {
                return Err(stale());
            }
            if c.stacks.iter().find(|s| s.id == id).is_some_and(|s| s.entries.iter().any(|e| e.pending.is_some())) {
                return Err(fail("Review the pending rebase result before forgetting its tracking metadata."));
            }
            c.stacks.retain(|s| s.id != id);
            write(root, &c)
        },
    )
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub token: String,
    pub stack_id: String,
    pub index: usize,
    pub revision: String,
    pub state_token: String,
    pub branch: String,
    pub original: String,
    pub boundary: String,
    pub parent: String,
    pub parent_oid: String,
    pub commits: usize,
    pub published: bool,
    pub protection_rules: Vec<String>,
}
pub fn review(root: &Path, id: &str, index: usize, rules: &[String]) -> GitResult<Plan> {
    let (mut plan, state) = operations::inspect(root, || {
        sync::require_actual_history(root)?;
        let c = catalog(root)?;
        let s = c.stacks.iter().find(|s| s.id == id).ok_or_else(|| fail("Stack not found."))?;
        let e = s.entries.get(index).ok_or_else(|| fail("Layer not found."))?;
        if s.entries.iter().any(|e| e.pending.is_some()) {
            return Err(fail("Resolve and review the pending rebase before another restack."));
        }
        let tips = heads(root)?;
        for i in 0..index {
            let p = if i == 0 { &s.base } else { &s.entries[i - 1].branch };
            if s.entries[i].boundary != tip(&tips, p)? {
                return Err(fail("Update the stack from its bottom layer first."));
            }
        }
        let parent = if index == 0 { &s.base } else { &s.entries[index - 1].branch };
        let original = tip(&tips, &e.branch)?.to_owned();
        let parent_oid = tip(&tips, parent)?.to_owned();
        let st = status::status(root)?;
        let info = repo::info(root)?;
        if info.state.kind != "none" || st.branch.as_deref() != Some(&e.branch) || st.oid.as_deref() != Some(&original) || !st.files.is_empty() {
            return Err(fail("Check out this layer in the current working copy, finish any Git operation and commit/stash changes before restacking."));
        }
        branch_protection::require_allowed(Some(rules), Some(&e.branch), None).map_err(|mut e| {
            e.message = e.message.replace("before deleting this branch", "before rewriting this stack layer");
            e
        })?;
        if parent_oid == e.boundary {
            return Err(fail("This layer already uses the current parent tip."));
        }
        if !ancestor(root, &e.boundary, &original)? {
            return Err(fail("The saved boundary is no longer in this branch. Inspect external history edits; no range was guessed."));
        }
        let range = format!("{}..{}", e.boundary, original);
        let merges = history::run(root, ["rev-list", "--min-parents=2", &range])?;
        if !merges.trim().is_empty() {
            return Err(fail("This layer contains merge commits. Use Rebase Studio to review that history explicitly."));
        }
        let count = history::run(root, ["rev-list", "--count", &range])?.trim().parse::<usize>().map_err(|_| fail("Unknown commit count."))?;
        if count > 500 {
            return Err(fail("Restack at most 500 commits at a time."));
        }
        guard_working_copy(root, &e.branch, &parent_oid, &range)?;
        let unpublished = history::run(root, ["rev-list", "--count", &range, "--not", "--remotes"])?
            .trim()
            .parse::<usize>()
            .map_err(|_| fail("Unknown publication state."))?;
        let tip_visible = !history::run(root, ["for-each-ref", "--format=%(refname)", &format!("--contains={original}"), "refs/remotes/"])?.trim().is_empty();
        Ok(Plan {
            token: String::new(),
            stack_id: id.into(),
            index,
            revision: c.revision,
            state_token: String::new(),
            branch: e.branch.clone(),
            original,
            boundary: e.boundary.clone(),
            parent: parent.clone(),
            parent_oid,
            commits: count,
            published: tip_visible || unpublished < count,
            protection_rules: rules.to_vec(),
        })
    })?;
    plan.state_token = state;
    plan.token = json::digest(&plan)?;
    Ok(plan)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub phase: String,
    pub message: String,
    pub checkpoint: String,
}
pub fn restack(root: &Path, plan: &Plan, consent: bool, published_consent: bool) -> GitResult<Outcome> {
    if !consent || plan.published && !published_consent {
        return Err(fail("Review the rewritten range and explicitly allow rewriting published commits when applicable."));
    }
    operations::run(
        root,
        "stack_rebase",
        Some(&plan.state_token),
        |_, _| {},
        || {
            let d = dir(root)?;
            let _lock = json::lock(&d, "catalog.lock")?;
            let fresh = review(root, &plan.stack_id, plan.index, &plan.protection_rules)?;
            if fresh.token != plan.token {
                return Err(stale());
            }
            let checkpoint = recovery::create(root, "stack_rebase", "Before restacking dependent branch", false, false)?;
            let mut c = catalog(root)?;
            let entry = &mut c.stacks.iter_mut().find(|s| s.id == plan.stack_id).unwrap().entries[plan.index];
            entry.pending = Some(Pending { original: plan.original.clone(), parent_oid: plan.parent_oid.clone(), checkpoint: checkpoint.id.clone() });
            write(root, &c)?;
            let out = history::exec(
                root,
                [
                    "-c",
                    "rebase.updateRefs=false",
                    "-c",
                    "rebase.autoSquash=false",
                    "-c",
                    "rebase.autoStash=false",
                    "rebase",
                    "--merge",
                    "--no-fork-point",
                    "--reapply-cherry-picks",
                    "--no-update-refs",
                    "--no-autosquash",
                    "--no-autostash",
                    "--no-rebase-merges",
                    "--keep-empty",
                    "--empty=keep",
                    "--onto",
                    &plan.parent_oid,
                    &plan.boundary,
                ],
            );
            match out {
                Ok(out) if out.ok() => {
                    let st = status::status(root)?;
                    if st.branch.as_deref() != Some(&plan.branch) || !ancestor(root, &plan.parent_oid, st.oid.as_deref().unwrap_or(""))? {
                        return Err(fail(
                            "The rebase completed but hooks or another tool changed its result. Inspect the pending layer and recovery checkpoint.",
                        ));
                    }
                    let entry = &mut c.stacks.iter_mut().find(|s| s.id == plan.stack_id).unwrap().entries[plan.index];
                    entry.boundary = plan.parent_oid.clone();
                    entry.pending = None;
                    write(root, &c).map_err(|e| {
                        fail(format!("Rebase finished but its metadata could not be saved: {}. Review the pending result; do not rerun it.", e.message))
                    })?;
                    Ok(Outcome {
                        phase: "completed".into(),
                        message: "Layer rebased; downstream layers are kept for separate review. Published branches need a separately reviewed push.".into(),
                        checkpoint: checkpoint.id,
                    })
                }
                Ok(out) if repo::info(root)?.state.kind == "rebase" => Ok(Outcome {
                    phase: "paused".into(),
                    message: format!("Rebase paused. Resolve/continue or abort using Conflict Studio, then review this layer's pending result. {}", out.stderr),
                    checkpoint: checkpoint.id,
                }),
                Ok(out) => Err(fail(format!("{} Review the pending layer before another action.", runner::to_error("restack branch", &out).message))),
                Err(e) => Err(fail(format!("{} Rebase result is unknown; review the pending layer.", e.message))),
            }
        },
    )
}
pub fn finalize(root: &Path, id: &str, index: usize, expected: &str, expected_state: &str, consent: bool) -> GitResult<Catalog> {
    if !consent {
        return Err(fail("Inspect the completed or aborted rebase and confirm its result."));
    }
    operations::run(
        root,
        "stack_finalize",
        Some(expected_state),
        |_, _| {},
        || {
            sync::require_actual_history(root)?;
            let d = dir(root)?;
            let _lock = json::lock(&d, "catalog.lock")?;
            let mut c = catalog(root)?;
            if c.revision != expected {
                return Err(stale());
            }
            let s = c.stacks.iter_mut().find(|s| s.id == id).ok_or_else(|| fail("Stack not found."))?;
            let e = s.entries.get_mut(index).ok_or_else(|| fail("Layer not found."))?;
            let p = e.pending.as_ref().ok_or_else(|| fail("No pending result."))?;
            let st = status::status(root)?;
            if repo::info(root)?.state.kind != "none" || st.branch.as_deref() != Some(&e.branch) || !st.files.is_empty() {
                return Err(fail("Finish or abort the rebase, check out this layer and commit/stash changes before confirming its result."));
            }
            let tips = heads(root)?;
            let current = tip(&tips, &e.branch)?;
            if current != p.original {
                if !ancestor(root, &p.parent_oid, current)? {
                    return Err(fail("This result does not contain the reviewed new parent. Use recovery or inspect external ref changes."));
                }
                e.boundary = p.parent_oid.clone();
            }
            e.pending = None;
            write(root, &c)
        },
    )
}
pub fn link_pull(root: &Path, id: &str, index: usize, number: u64, expected: &str) -> GitResult<Catalog> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let f = forge::detect(root)?.ok_or_else(|| fail("Select an API connection first."))?;
            let pull = pr_center::detail(root, number, f.connection_revision.as_deref().unwrap_or_default())?;
            let d = dir(root)?;
            let _lock = json::lock(&d, "catalog.lock")?;
            let mut c = catalog(root)?;
            if c.revision != expected {
                return Err(stale());
            }
            let s = c.stacks.iter_mut().find(|s| s.id == id).ok_or_else(|| fail("Stack not found."))?;
            let parent = if index == 0 { s.base.clone() } else { s.entries.get(index - 1).ok_or_else(|| fail("Layer not found."))?.branch.clone() };
            let e = s.entries.get_mut(index).ok_or_else(|| fail("Layer not found."))?;
            if pull.pull.head != e.branch || pull.pull.base != parent || tip(&heads(root)?, &e.branch)? != pull.pull.head_sha {
                return Err(fail("The PR source, target and exact source commit must match this local layer and its immediate parent."));
            }
            e.pull = Some(number);
            e.pull_connection = f.connection_revision;
            write(root, &c)
        },
    )
}
fn linked(root: &Path, s: &Stack, index: usize, connection: &str, revision: &str) -> GitResult<pr_center::Detail> {
    let e = s.entries.get(index).ok_or_else(|| fail("Layer not found."))?;
    let n = e.pull.ok_or_else(|| fail("Link this layer to a PR first."))?;
    let d = pr_center::detail(root, n, connection)?;
    if d.revision != revision || d.pull.head != e.branch || e.pull_connection.as_deref() != Some(connection) {
        return Err(stale());
    }
    Ok(d)
}
pub fn retire_bottom(root: &Path, id: &str, expected: &str, connection: &str, revision: &str, consent: bool) -> GitResult<Catalog> {
    if !consent {
        return Err(fail("Review the merged layer and its new child target first."));
    }
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let d = dir(root)?;
            let _lock = json::lock(&d, "catalog.lock")?;
            let mut c = catalog(root)?;
            if c.revision != expected {
                return Err(stale());
            }
            let s = c.stacks.iter_mut().find(|s| s.id == id).ok_or_else(|| fail("Stack not found."))?;
            let pull = linked(root, s, 0, connection, revision)?;
            if pull.pull.state != "merged" || pull.pull.base != s.base || s.entries.iter().any(|e| e.pending.is_some()) {
                return Err(fail("Retire only a server-confirmed merged bottom layer with no pending rebase."));
            }
            if heads(root)?.get(&s.entries[0].branch).is_some_and(|tip| tip != &pull.pull.head_sha) {
                return Err(fail("The local bottom branch contains a different tip than the merged PR. Its later work must be reviewed first."));
            }
            let f = forge::reviewed_connection(root, connection)?;
            let (current, raw) = pr_center::load_detail(root, &f, pull.pull.number)?;
            if current.revision != pull.revision {
                return Err(stale());
            }
            let merged = match f.kind.as_str() {
                "github" => pr_center::text(&raw, "/merge_commit_sha"),
                "gitlab" => {
                    let m = pr_center::text(&raw, "/merge_commit_sha");
                    if m.is_empty() {
                        pr_center::text(&raw, "/squash_commit_sha")
                    } else {
                        m
                    }
                }
                "bitbucket" => pr_center::text(&raw, "/merge_commit/hash"),
                "azure" => pr_center::text(&raw, "/lastMergeCommit/commitId"),
                _ => pr_center::text(&raw, "/properties/mergeCommit/id"),
            };
            if !oid(&merged) || !ancestor(root, &merged, tip(&heads(root)?, &s.base)?)? {
                return Err(fail("Update the local stack base to include the server-confirmed merge commit before retiring this layer. An unavailable merge receipt is never guessed from source ancestry."));
            }
            // Preserve the next layer's old boundary: --onto main old-parent replays
            // only that layer's commits even after a squash merge of its parent.
            s.entries.remove(0);
            write(root, &c)
        },
    )
}
pub fn retarget_pull(root: &Path, id: &str, index: usize, expected: &str, connection: &str, revision: &str, consent: bool) -> GitResult<pr_center::EditResult> {
    if !consent {
        return Err(fail("Review the new PR target before changing it."));
    }
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            let c = catalog(root)?;
            if c.revision != expected {
                return Err(stale());
            }
            let s = c.stacks.iter().find(|s| s.id == id).ok_or_else(|| fail("Stack not found."))?;
            let pull = linked(root, s, index, connection, revision)?;
            let parent = if index == 0 { &s.base } else { &s.entries[index - 1].branch };
            if pull.pull.state != "open" || pull.pull.base == *parent {
                return Err(fail("Only an open PR with an outdated target needs retargeting."));
            }
            pr_center::edit(root, pull.pull.number, connection, revision, pr_center::Edit { title: pull.pull.title, body: pull.body, base: parent.clone() })
        },
    )
}
#[cfg(test)]
mod tests;
