//! Reviewed interactive history editing and one durable result per worktree.
use fs2::FileExt;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::ops::{self, OpOutcome, PlanCommit, RebaseItem, RebasePlan};
use super::recovery::{self, SavedRef, Summary};
use super::runner::{self, GitError, GitResult};
use super::{extras, repo, status};

const MAX_RECORD: u64 = 8 * 1024 * 1024;
const MAX_REFS: usize = 500;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedRef {
    pub name: String,
    pub oid: String,
    pub symbolic: Option<String>,
    pub kind: String,
    pub remote: bool,
    pub rewritten: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub current: bool,
    pub locked: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub token: String,
    pub oldest: String,
    pub head: String,
    pub branch_ref: Option<String>,
    pub upstream: Option<String>,
    pub plan: RebasePlan,
    pub items: Vec<RebaseItem>,
    pub references: Vec<RelatedRef>,
    pub refs_truncated: bool,
    pub worktrees: Vec<RelatedWorktree>,
    pub published_commits: usize,
    pub dirty_files: usize,
    pub staged_files: u32,
    pub blockers: Vec<String>,
    #[serde(default)]
    fetch_mappings: BTreeMap<String, Vec<String>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeStamp {
    directory: String,
    modified: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefChange {
    pub name: String,
    pub before: String,
    pub after: Option<String>,
    pub symbolic_before: Option<String>,
    pub symbolic_after: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub phase: String,
    pub review: Review,
    pub before_checkpoint: Summary,
    pub after_checkpoint: Option<Summary>,
    pub after_head: Option<String>,
    pub ref_changes: Vec<RefChange>,
    pub warning: Option<String>,
    pub error: Option<String>,
    pub candidate_head: Option<String>,
    #[serde(default)]
    native: Option<NativeStamp>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub outcome: OpOutcome,
    pub report: Report,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    #[serde(flatten)]
    pub outcome: OpOutcome,
    pub studio_session: Option<String>,
    pub studio_warning: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub before: Vec<PlanCommit>,
    pub after: Vec<PlanCommit>,
    pub same_tree: bool,
    pub range_diff: Option<String>,
    pub note: Option<String>,
    pub truncated: bool,
}

fn fail(message: impl Into<String>) -> GitError {
    GitError::new(message).kind("rebase-studio")
}
fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn branch(root: &Path) -> GitResult<Option<String>> {
    let out = runner::exec(root, ["symbolic-ref", "--quiet", "HEAD"])?;
    if out.ok() {
        Ok(Some(out.text().trim().into()))
    } else if out.code == 1 {
        Ok(None)
    } else {
        Err(runner::to_error("Read HEAD", &out))
    }
}
fn map(pattern: &str, replacement: &str, value: &str) -> Option<String> {
    match (pattern.split_once('*'), replacement.split_once('*')) {
        (None, None) => (pattern == value).then(|| replacement.into()),
        (Some((a, b)), Some((x, y))) if !b.contains('*') && !y.contains('*') => Some(format!("{x}{}{y}", value.strip_prefix(a)?.strip_suffix(b)?)),
        _ => None,
    }
}
fn remote_specs(root: &Path) -> GitResult<BTreeMap<String, Vec<String>>> {
    let out = runner::exec(root, ["config", "--null", "--get-regexp", r"^remote\..*\.fetch$"])?;
    if out.code != 0 && out.code != 1 {
        return Err(runner::to_error("Read fetch mappings", &out));
    }
    let mut mappings: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let text = out.text();
    for record in text.split('\0') {
        if let Some((key, value)) = record.split_once('\n') {
            if let Some(name) = key.strip_prefix("remote.").and_then(|s| s.strip_suffix(".fetch")) {
                mappings.entry(name.into()).or_default().push(value.into());
            }
        }
    }
    Ok(mappings)
}
fn is_remote(name: &str, mappings: &BTreeMap<String, Vec<String>>) -> bool {
    mappings.values().any(|specs| {
        specs.iter().filter_map(|s| s.trim_start_matches('+').split_once(':')).any(|(source, dest)| {
            map(dest, source, name).is_some_and(|source| {
                source.starts_with("refs/heads/") && !specs.iter().filter_map(|s| s.strip_prefix('^')).any(|p| map(p, p, &source).is_some())
            })
        })
    })
}
fn references(root: &Path, oldest: Option<&str>) -> GitResult<Vec<RelatedRef>> {
    let mappings = remote_specs(root)?;
    references_with_mappings(root, oldest, &mappings)
}
fn references_with_mappings(root: &Path, oldest: Option<&str>, mappings: &BTreeMap<String, Vec<String>>) -> GitResult<Vec<RelatedRef>> {
    let mut args = vec!["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"];
    if let Some(oldest) = oldest {
        args.extend(["--contains", oldest]);
    }
    let text = runner::run(root, &args)?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split('\0').collect();
            if fields.len() != 3 || fields[0].starts_with("refs/revqora/") || fields[0].starts_with("refs/worktree/revqora/") {
                return None;
            }
            let name = fields[0];
            Some(RelatedRef {
                name: name.into(),
                oid: fields[1].into(),
                symbolic: (!fields[2].is_empty()).then(|| fields[2].into()),
                kind: if name.starts_with("refs/heads/") {
                    "branch"
                } else if name.starts_with("refs/tags/") {
                    "tag"
                } else {
                    "reference"
                }
                .into(),
                remote: name.starts_with("refs/remotes/") || is_remote(name, mappings),
                rewritten: false,
            })
        })
        .collect())
}
fn validate_items(plan: &RebasePlan, items: &[RebaseItem]) -> GitResult<()> {
    let expected: BTreeSet<_> = plan.commits.iter().map(|c| c.oid.as_str()).collect();
    let actual: BTreeSet<_> = items.iter().map(|c| c.oid.as_str()).collect();
    if expected != actual || items.len() != expected.len() {
        return Err(fail("The edited plan must include each original commit exactly once. Reopen the plan."));
    }
    let mut head = false;
    let mut size = 0;
    let mut head_message = false;
    for item in items {
        if let Some(m) = &item.message {
            size += m.len();
            if m.contains('\0') {
                return Err(fail("Commit messages cannot contain NUL bytes."));
            }
        }
        match item.action.as_str() {
            "pick" | "edit" => {
                head = true;
                head_message = item.message.as_ref().is_some_and(|m| !m.trim().is_empty());
            }
            "reword" => {
                head = true;
                head_message = true;
                if item.message.as_ref().is_none_or(|m| m.trim().is_empty()) {
                    return Err(fail("A reworded commit needs a message."));
                }
            }
            "squash" if head && head_message => {}
            "fixup" if head => {}
            "drop" => {}
            _ => return Err(fail("Invalid rebase action or a squash/fixup without a preceding kept commit.")),
        }
    }
    if !head || size > 4 * 1024 * 1024 {
        return Err(fail("Keep at least one commit and keep edited messages below 4 MiB."));
    }
    Ok(())
}

/// Pure inspection. The outer inspect transaction supplies its state token.
pub fn review(root: &Path, oldest: &str, items: &[RebaseItem]) -> GitResult<Review> {
    let gd = repo::git_dir(root)?;
    if repo::op_state(root, &gd).kind != "none" {
        return Err(fail("Finish or abort the current Git operation first."));
    }
    let plan = ops::rebase_plan(root, oldest)?;
    validate_items(&plan, items)?;
    let oldest = plan.commits.first().ok_or_else(|| fail("The selected range is empty."))?.oid.clone();
    let head = plan.commits.last().unwrap().oid.clone();
    let branch_ref = branch(root)?;
    let state = status::status(root)?;
    if state.oid.as_deref() != Some(&head) {
        return Err(fail("HEAD changed during review. Refresh the plan.").kind("stale-operation"));
    }
    let upstream = runner::exec(root, ["rev-parse", "--symbolic-full-name", "@{upstream}"])?;
    let upstream = upstream.ok().then(|| upstream.text().trim().into());
    let fetch_mappings = remote_specs(root)?;
    let mut refs = references_with_mappings(root, Some(&oldest), &fetch_mappings)?;
    let mut query = format!("{head}\n");
    if let Some(base) = &plan.base {
        query.push_str(&format!("^{base}\n"));
    }
    for r in refs.iter().filter(|r| r.remote) {
        query.push_str(&format!("^{}\n", r.oid));
    }
    let out = runner::exec_full(root, ["rev-list", "--stdin"], &[], Some(query.as_bytes()))?;
    if !out.ok() {
        return Err(runner::to_error("Inspect published commits", &out));
    }
    let unpublished = out.text().lines().count();
    let published_commits = plan.commits.len().saturating_sub(unpublished);
    for r in &mut refs {
        r.rewritten = branch_ref.as_deref() == Some(&r.name);
    }
    let mut worktrees: Vec<_> = extras::worktrees(root)?
        .into_iter()
        .filter(|w| {
            w.is_current
                || w.branch.as_ref().is_some_and(|b| refs.iter().any(|r| r.name == format!("refs/heads/{b}")))
                || w.head.as_ref().is_some_and(|h| plan.commits.iter().any(|c| &c.oid == h))
        })
        .map(|w| RelatedWorktree { path: w.path, branch: w.branch, head: w.head, current: w.is_current, locked: w.locked })
        .collect();
    let blockers: Vec<_> = worktrees
        .iter()
        .filter(|w| !w.current && w.branch.as_ref().is_some_and(|b| branch_ref.as_deref() == Some(&format!("refs/heads/{b}"))))
        .map(|w| format!("The current branch is also checked out at {}. Switch that worktree to another branch before rebasing.", w.path))
        .collect();
    worktrees.sort_by(|a, b| a.path.cmp(&b.path));
    let mut result = Review {
        token: String::new(),
        oldest,
        head,
        branch_ref,
        upstream,
        plan,
        items: items.to_vec(),
        references: refs,
        refs_truncated: false,
        worktrees,
        published_commits,
        dirty_files: state.files.len(),
        staged_files: state.staged_count,
        blockers,
        fetch_mappings,
    };
    // Digest all refs before display truncation, not just the first screenful.
    let encoded = serde_json::to_vec(&result).map_err(|e| fail(e.to_string()))?;
    if encoded.len() as u64 > MAX_RECORD / 2 {
        return Err(fail("This review is too large. Choose a smaller commit range."));
    }
    result.token = format!("{:x}", Sha256::digest(encoded));
    result.refs_truncated = result.references.len() > MAX_REFS;
    result.references.truncate(MAX_REFS);
    Ok(result)
}
fn directory(root: &Path) -> GitResult<PathBuf> {
    let path = super::storage::dir(root)?.join("rebase-studio");
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir()) {
        return Err(fail("Unsafe Rebase Studio storage directory."));
    }
    fs::create_dir_all(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}
// The repository queue is process-local. Serialize durable intent across app
// instances too, and recheck the displayed state after waiting for this lock.
fn transaction_lock(root: &Path, expected: Option<&str>) -> GitResult<File> {
    let token = match expected {
        Some(t) => t.to_owned(),
        None => status::status(root)?.state_token.ok_or_else(|| fail("Repository state is unavailable."))?,
    };
    let path = directory(root)?.join(".lock");
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(fail("Unsafe Studio lock."));
    }
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)?;
    file.lock_exclusive()?;
    if status::status(root)?.state_token.as_deref() != Some(&token) {
        return Err(fail("The repository changed while waiting for Rebase Studio. Refresh and review it again.").kind("stale-operation"));
    }
    Ok(file)
}
fn save(root: &Path, report: &Report) -> GitResult<()> {
    // tempfile persists with raw Win32 APIs. Canonicalization supplies the
    // extended-length prefix for both paths, including atomic replacements.
    let dir = fs::canonicalize(directory(root)?)?;
    let path = dir.join("last.json");
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(fail("Unsafe Rebase Studio record."));
    }
    let bytes = serde_json::to_vec(report).map_err(|e| fail(e.to_string()))?;
    if bytes.len() as u64 > MAX_RECORD {
        return Err(fail("Rebase Studio record exceeds 8 MiB."));
    }
    let mut temp = tempfile::NamedTempFile::new_in(&dir)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(&path).map_err(|e| fail(e.error.to_string()))?;
    Ok(())
}
fn load(root: &Path) -> GitResult<Option<Report>> {
    let path = directory(root)?.join("last.json");
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_RECORD {
        return Err(fail("The Rebase Studio record is unsafe or too large; it was preserved."));
    }
    let report: Report = serde_json::from_slice(&fs::read(&path)?)
        .map_err(|_| fail("The Rebase Studio record cannot be read; it was preserved. Use Undo Center for checkpoints."))?;
    if report.version != 1
        || !valid_oid(&report.review.head)
        || report.after_head.as_ref().is_some_and(|h| !valid_oid(h))
        || report.review.plan.base.as_ref().is_some_and(|h| !valid_oid(h))
    {
        return Err(fail("Unsupported Rebase Studio record; it was preserved."));
    }
    Ok(Some(report))
}
fn native(root: &Path, report: &Report) -> GitResult<Option<NativeStamp>> {
    let gd = repo::git_dir(root)?;
    for name in ["rebase-merge", "rebase-apply"] {
        let dir = gd.join(name);
        let original = dir.join("orig-head");
        if !original.is_file() {
            continue;
        }
        let head = fs::read_to_string(&original)?;
        let branch = fs::read_to_string(dir.join("head-name"))?;
        let wanted = report.review.branch_ref.as_deref().unwrap_or("detached HEAD");
        if head.trim() != report.review.head || branch.trim() != wanted {
            return Ok(None);
        }
        let modified = fs::metadata(original)?.modified()?.duration_since(UNIX_EPOCH).map_err(|e| fail(e.to_string()))?.as_nanos().to_string();
        return Ok(Some(NativeStamp { directory: name.into(), modified }));
    }
    Ok(None)
}
fn matching(root: &Path, report: &Report) -> GitResult<bool> {
    let Some(current) = native(root, report)? else { return Ok(false) };
    if report.native.as_ref().is_some_and(|saved| saved.directory != current.directory || saved.modified != current.modified) {
        return Ok(false);
    }
    // Filesystem timestamps alone can collide (for example on FAT worktrees).
    // Git writes a unique native reflog action for this session's start. A new
    // CLI rebase with the same HEAD gets a different newest start entry.
    let start = runner::run(
        root,
        ["reflog", "show", "--no-show-signature", "--format=%gs", "--max-count=1", "--fixed-strings", "--grep-reflog= (start): checkout ", "HEAD"],
    )?;
    Ok(start.trim().starts_with(&format!("revqora-studio-{} (start): checkout ", report.id)))
}

pub fn report(root: &Path) -> GitResult<Option<Report>> {
    let Some(mut r) = load(root)? else { return Ok(None) };
    if matches!(r.phase.as_str(), "preparing" | "paused") {
        if matching(root, &r)? {
            r.phase = "paused".into();
        } else {
            r.phase = "unconfirmed".into();
            let gd = repo::git_dir(root)?;
            if repo::op_state(root, &gd).kind == "none" && branch(root)? == r.review.branch_ref {
                r.candidate_head = repo::head(root)?.oid;
            }
        }
    }
    Ok(Some(r))
}
fn warning(r: &mut Report, text: String) {
    r.warning = Some(match r.warning.take() {
        Some(old) => format!("{old}\n{text}"),
        None => text,
    });
}
fn finish(root: &Path, r: &mut Report, phase: &str) -> GitResult<()> {
    let gd = repo::git_dir(root)?;
    if repo::op_state(root, &gd).kind != "none" {
        r.native = native(root, r)?;
        r.phase = "paused".into();
        r.updated_at = crate::journal::now();
        return save(root, r);
    }
    r.native = None;
    if branch(root)? != r.review.branch_ref {
        r.phase = "unconfirmed".into();
        warning(r, "The checked-out branch changed. A result was not associated with this rebase.".into());
    } else {
        let head = repo::head(root)?.oid.ok_or_else(|| fail("The resulting HEAD is missing."))?;
        r.phase = if phase == "aborted" && head != r.review.head { "unconfirmed" } else { phase }.into();
        r.after_head = Some(head.clone());
        if status::status(root)?.conflict_count > 0 {
            warning(r, "The history operation finished, but working changes still have conflicts. Resolve them before committing or pushing.".into());
        }
        let cp = recovery::reference_checkpoint(
            root,
            "rebase_studio_result",
            "Rebase Studio result",
            &[SavedRef { name: r.review.branch_ref.clone().unwrap_or("HEAD".into()), oid: head, kind: "head".into() }],
            None,
        );
        match cp {
            Ok(cp) => r.after_checkpoint = Some(cp),
            Err(e) => warning(r, format!("History finished, but its result could not be pinned: {}", e.message)),
        }
        match references(root, None) {
            Ok(current) => {
                r.ref_changes = r
                    .review
                    .references
                    .iter()
                    .map(|before| {
                        let after = current.iter().find(|v| v.name == before.name);
                        RefChange {
                            name: before.name.clone(),
                            before: before.oid.clone(),
                            after: after.map(|v| v.oid.clone()),
                            symbolic_before: before.symbolic.clone(),
                            symbolic_after: after.and_then(|v| v.symbolic.clone()),
                        }
                    })
                    .collect()
            }
            Err(e) => warning(r, format!("Reference comparison is unavailable: {}", e.message)),
        }
    }
    if r.ref_changes
        .iter()
        .any(|c| r.review.branch_ref.as_deref() != Some(&c.name) && (c.after.as_deref() != Some(&c.before) || c.symbolic_before != c.symbolic_after))
    {
        warning(r, "Other reviewed references changed during the operation. Inspect the reference comparison before pushing.".into());
    }
    r.updated_at = crate::journal::now();
    save(root, r)
}

/// Run only within the repository writer transaction, with the displayed token.
pub fn start(
    root: &Path,
    oldest: &str,
    items: &[RebaseItem],
    review_token: &str,
    expected: &str,
    ack_published: bool,
    ack_dirty: bool,
) -> GitResult<StartResult> {
    let _lock = transaction_lock(root, Some(expected))?;
    let checked = review(root, oldest, items)?;
    if !checked.blockers.is_empty() {
        return Err(fail(checked.blockers.join("\n")));
    }
    if checked.token != review_token {
        return Err(fail("The review changed. Review the plan again; no rebase was started.").kind("stale-selection"));
    }
    if checked.published_commits > 0 && !ack_published {
        return Err(fail("Confirm the published-history warning before starting."));
    }
    if checked.dirty_files > 0 && !ack_dirty {
        return Err(fail("Confirm how Git autostash handles your working changes before starting."));
    }
    let cp = crate::journal::suspend(|| recovery::create_expected(root, "rebase_studio_start", "Before Rebase Studio", true, false, Some(expected)))?;
    let mut r = Report {
        version: 1,
        id: cp.id.clone(),
        created_at: crate::journal::now(),
        updated_at: crate::journal::now(),
        phase: "preparing".into(),
        review: checked,
        before_checkpoint: cp,
        after_checkpoint: None,
        after_head: None,
        ref_changes: Vec::new(),
        warning: None,
        error: None,
        candidate_head: None,
        native: None,
    };
    // Fail closed if durable intent cannot be saved, before touching Git history.
    save(root, &r)?;
    if status::status(root)?.state_token.as_deref() != Some(expected) || review(root, oldest, items)?.token != review_token {
        return Err(fail("The repository changed while saving recovery. Review the plan again.").kind("stale-operation"));
    }
    let action = format!("revqora-studio-{}", r.id);
    let result = ops::interactive_rebase_logged(root, r.review.plan.base.as_deref(), items, Some(&action));
    let phase = if result.is_ok() { "completed" } else { "failed" };
    if let Err(e) = &result {
        r.error = Some(e.message.clone());
    }
    if let Err(e) = finish(root, &mut r, phase) {
        warning(&mut r, format!("Git has already run; the Studio report could not be fully saved: {}. Inspect the repository before retrying.", e.message));
    }
    result.map(|outcome| StartResult { outcome, report: r })
}
fn ticket(root: &Path) -> GitResult<Option<Report>> {
    let Some(r) = load(root)? else { return Ok(None) };
    Ok((matches!(r.phase.as_str(), "preparing" | "paused") && matching(root, &r)?).then_some(r))
}
pub fn step(root: &Path, kind: &str, expected: Option<&str>, run: impl FnOnce() -> GitResult<OpOutcome>) -> GitResult<StepOutcome> {
    let _lock = if kind == "rebase" { Some(transaction_lock(root, expected)?) } else { None };
    let ticket = if kind == "rebase" { ticket(root) } else { Ok(None) };
    let mut result = run();
    let mut id = None;
    let mut note = None;
    match ticket {
        Ok(Some(mut r)) => {
            id = Some(r.id.clone());
            r.error = result.as_ref().err().map(|e| e.message.clone());
            if let Err(e) = finish(root, &mut r, if result.is_ok() { "completed" } else { "failed" }) {
                note = Some(format!("Git has already run; its Studio report needs inspection: {}", e.message));
            } else {
                note = r.warning;
            }
        }
        Err(e) => note = Some(format!("Git ran without a readable Studio record: {}", e.message)),
        _ => {}
    }
    if let (Err(e), Some(note)) = (&mut result, &note) {
        e.details.push(note.clone());
    }
    result.map(|outcome| StepOutcome { outcome, studio_session: id, studio_warning: note })
}
pub fn abort(root: &Path, kind: &str, expected: Option<&str>) -> GitResult<StepOutcome> {
    let _lock = if kind == "rebase" { Some(transaction_lock(root, expected)?) } else { None };
    let ticket = if kind == "rebase" { ticket(root) } else { Ok(None) };
    ops::abort_op(root, kind)?;
    let mut note = None;
    let mut id = None;
    match ticket {
        Ok(Some(mut r)) => {
            r.error = None;
            id = Some(r.id.clone());
            if let Err(e) = finish(root, &mut r, "aborted") {
                note = Some(format!("Rebase was aborted; its Studio report could not be saved: {}", e.message));
            } else {
                note = r.warning;
            }
        }
        Err(e) => note = Some(e.message),
        _ => {}
    }
    Ok(StepOutcome {
        outcome: OpOutcome { status: "done".into(), conflicts: Vec::new(), message: "Operation aborted".into() },
        studio_session: id,
        studio_warning: note,
    })
}
/// Explicit adoption after CLI completion, never an automatic success inference.
pub fn capture(root: &Path, id: &str, head: &str, expected: Option<&str>) -> GitResult<Report> {
    let _lock = transaction_lock(root, expected)?;
    let mut r = report(root)?.ok_or_else(|| fail("No Studio session is saved for this worktree."))?;
    if r.id != id || r.phase != "unconfirmed" || r.candidate_head.as_deref() != Some(head) {
        return Err(fail("The current candidate changed. Refresh the result review."));
    }
    warning(&mut r, "This result was explicitly associated with the current HEAD after an external Git action; automatic completion was not verified.".into());
    finish(root, &mut r, "captured")?;
    Ok(r)
}
pub fn comparison(root: &Path, id: &str) -> GitResult<Comparison> {
    let r = load(root)?.filter(|r| r.id == id).ok_or_else(|| fail("This is no longer the saved Studio session. Use Undo Center for older checkpoints."))?;
    let head = r.after_head.as_deref().ok_or_else(|| fail("This session has no confirmed result yet."))?;
    let after = ops::read_plan_commits(root, r.review.plan.base.as_deref(), head)?;
    let before = r.review.plan.commits;
    let trees = runner::run(root, ["rev-parse", &format!("{}^{{tree}}", r.review.head), &format!("{head}^{{tree}}")])?;
    let hashes: Vec<_> = trees.lines().collect();
    let mut note = None;
    let mut range_diff = None;
    let mut truncated = false;
    if before.len() <= 200 && after.len() <= 200 {
        if let Some(base) = r.review.plan.base {
            let out = runner::exec(
                root,
                ["range-diff", "--no-color", "--no-dual-color", "--no-patch", &format!("{base}..{}", r.review.head), &format!("{base}..{head}")],
            )?;
            if out.ok() {
                let text = out.text();
                truncated = text.len() > 200_000;
                range_diff = Some(text.chars().take(200_000).collect());
            } else {
                note = Some(format!("Git range-diff is unavailable: {}", out.stderr));
            }
        } else {
            note = Some("Root history is shown in the before/after lists. Use direct file comparison to compare unrelated root snapshots.".into());
        }
    } else {
        note = Some("Large ranges are shown as commit lists; use direct file comparison for their actual file contents.".into());
    }
    Ok(Comparison { before, after, same_tree: hashes.len() == 2 && hashes[0] == hashes[1], range_diff, note, truncated })
}
