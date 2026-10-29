#[tauri::command]
async fn branch_manager_snapshot(repo: String, base: Option<String>) -> git::runner::GitResult<git::branch_manager::Snapshot> {
    blocking(move || git::branch_manager::snapshot(&p(&repo), base.as_deref())).await
}
#[tauri::command]
async fn branch_manager_compare(repo: String, base: String, tip: String) -> git::runner::GitResult<git::branch_manager::Distance> {
    blocking(move || git::branch_manager::compare(&p(&repo), &base, &tip)).await
}
#[tauri::command]
async fn sync_prepare(repo: String, expected_state: Option<String>, app: AppHandle) -> git::runner::GitResult<git::sync::SyncPlan> {
    mutating(repo.clone(), expected_state, app, "sync_prepare", None, move || git::sync::prepare(&p(&repo))).await
}
#[tauri::command]
async fn sync_execute(
    repo: String,
    plan: git::sync::SyncPlan,
    receive: bool,
    send: bool,
    expected_state: Option<String>,
    app: AppHandle,
) -> git::runner::GitResult<git::sync::SyncResult> {
    if expected_state.as_deref() != Some(plan.state_token.as_str()) || plan.state_token.is_empty() {
        return Err(git::runner::GitError::new("Prepare a Sync review first."));
    }
    mutating(repo.clone(), expected_state, app, "sync_execute", None, move || git::sync::execute(&p(&repo), &plan, receive, send)).await
}
// Revqora: Tauri command surface over the git backend.

pub mod askpass;
pub mod git;
pub mod journal;
pub mod portable;
pub mod update;

#[tauri::command]
async fn validation_start(repo: String, command: String, expected_state: String, timeout_seconds: u64) -> git::runner::GitResult<git::validation::Report> {
    // Returns immediately; polling and cancellation must not wait for the writer queue.
    blocking(move || git::validation::start(PathBuf::from(repo), command, expected_state, timeout_seconds)).await
}
#[tauri::command]
fn validation_report(repo: String) -> Option<git::validation::Report> {
    git::validation::report(&PathBuf::from(repo))
}
#[tauri::command]
fn validation_cancel(repo: String, id: String) -> git::runner::GitResult<()> {
    git::validation::cancel(&PathBuf::from(repo), &id)
}

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use git::branch_deletion::{self, RemoteBranchTarget};
use git::branch_review::{self, DeletionPlan, DeletionProof, DeletionResult};
use git::commit::{self as gcommit, CommitDetails, FileHistoryEntry};
use git::conflicts::{self, ConflictInfo};
use git::diff::{self, DiffOptions, FileDiff, SelectionMode, WorkSide};
use git::graph::{self, GraphCache, GraphRow, GraphSummary, SearchMode};
use git::layers::{self, LayersState};
use git::ops::{self, CommitOptions, OpOutcome, PushOptions, ReflogEntry, RewriteAction};
use git::rebase_studio as studio;
use git::recovery;
use git::refs::{self, RefsSnapshot};
use git::repo::{self, RepoInfo};
use git::runner::{self, GitError, GitResult};
use git::status::{self, StatusSummary};
use git::watcher::{self, RepoWatcher};

#[derive(Default)]
struct AppState {
    graphs: Mutex<HashMap<String, Arc<GraphCache>>>,
    watchers: Mutex<HashMap<String, RepoWatcher>>,
}

async fn blocking<T, F>(f: F) -> GitResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> GitResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| GitError::new(format!("Background task failed: {e}")))?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationEvent {
    id: String,
    repo: String,
    repository_key: String,
    command: String,
    phase: String,
    ahead: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observed<T> {
    #[serde(flatten)]
    value: T,
    state_token: String,
}

async fn mutating<T, F>(repo: String, expected: Option<String>, app: AppHandle, command: &'static str, id: Option<String>, f: F) -> GitResult<T>
where
    T: Send + Serialize + 'static,
    F: FnOnce() -> GitResult<T> + Send + 'static,
{
    use std::sync::atomic::{AtomicU64, Ordering};
    static IDS: AtomicU64 = AtomicU64::new(0);
    let id = id.unwrap_or_else(|| format!("repository-op-{}", IDS.fetch_add(1, Ordering::Relaxed)));
    blocking(move || {
        let repository_key = git::operations::repository_key(&p(&repo)).to_string_lossy().into_owned();
        let log = journal::begin(&p(&repo), command);
        let _ = app.emit("operation-log-changed", ());
        let emit = |phase: &str, ahead: usize| {
            if let Some(log) = &log {
                log.phase(phase, &p(&repo));
            }
            let _ = app.emit(
                "repository-operation",
                OperationEvent {
                    id: id.clone(),
                    repo: repo.clone(),
                    repository_key: repository_key.clone(),
                    command: command.into(),
                    phase: phase.into(),
                    ahead,
                },
            );
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            git::operations::run(&p(&repo), command, expected.as_deref(), emit, || {
                let result = f();
                if let Some(log) = &log {
                    log.after(&p(&repo));
                }
                result
            })
        }))
        .unwrap_or_else(|_| {
            Err(GitError::new("The operation failed unexpectedly. Refresh and inspect the repository before retrying.").kind("operation-failed"))
        });
        if let Some(log) = &log {
            log.finish(&result);
        }
        emit(if result.is_ok() { "finished" } else { "failed" }, 0);
        let _ = app.emit("operation-log-changed", ());
        let _ = app.emit("recovery-changed", ());
        result
    })
    .await
}

fn p(repo: &str) -> PathBuf {
    PathBuf::from(repo)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    op_id: String,
    line: String,
}

fn progress(app: &AppHandle, op_id: &str) -> impl FnMut(&str) {
    let app = app.clone();
    let op_id = op_id.to_string();
    move |line: &str| {
        let _ = app.emit("op-progress", Progress { op_id: op_id.clone(), line: line.to_string() });
    }
}

// Diagnostics only: these commands never mutate a Git repository.
fn log_error(message: String) -> GitError {
    GitError::new(message).kind("operation-log")
}

#[tauri::command]
async fn operation_log_health() -> GitResult<journal::Health> {
    blocking(|| Ok(journal::health())).await
}

#[tauri::command]
async fn operation_log_list(filter: journal::Filter) -> GitResult<journal::Page> {
    blocking(move || journal::store().and_then(|s| s.list(&filter, 50)).map_err(log_error)).await
}

#[tauri::command]
async fn operation_log_detail(id: String) -> GitResult<journal::Detail> {
    blocking(move || journal::store().and_then(|s| s.detail(&id)).map_err(log_error)).await
}

#[tauri::command]
async fn operation_log_clear(app: AppHandle, filter: journal::Filter) -> GitResult<usize> {
    let count = blocking(move || journal::store().and_then(|s| s.clear(&filter)).map_err(log_error)).await?;
    let _ = app.emit("operation-log-changed", ());
    Ok(count)
}

#[tauri::command]
async fn operation_log_export(filter: journal::Filter, destination: String) -> GitResult<usize> {
    blocking(move || journal::store().and_then(|s| s.export(&filter, &p(&destination))).map_err(log_error)).await
}

#[tauri::command]
async fn operation_log_retry(app: AppHandle) -> GitResult<journal::Health> {
    blocking(|| journal::retry().map_err(log_error)).await?;
    let _ = app.emit("operation-log-changed", ());
    Ok(journal::health())
}

// ───────────────────────────── app / repo ─────────────────────────────

#[tauri::command]
async fn recovery_list(repo: String) -> GitResult<recovery::Catalog> {
    blocking(move || git::operations::read(&p(&repo), || recovery::list(&p(&repo)))).await
}
#[tauri::command]
async fn recovery_detail(repo: String, id: String) -> GitResult<recovery::Checkpoint> {
    blocking(move || git::operations::read(&p(&repo), || recovery::detail(&p(&repo), &id))).await
}
#[tauri::command]
async fn recovery_create(app: AppHandle, expected_state: Option<String>, repo: String, label: String) -> GitResult<recovery::Summary> {
    mutating(repo.clone(), expected_state, app, "recovery_create", None, move || {
        journal::suspend(|| recovery::create(&p(&repo), "manual", &label, true, false))
    })
    .await
}
#[tauri::command]
async fn recovery_delete(app: AppHandle, expected_state: Option<String>, repo: String, id: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app, "recovery_delete", None, move || recovery::delete(&p(&repo), &id)).await
}
#[tauri::command]
async fn recovery_restore_branch(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    id: String,
    reference: Option<usize>,
    name: String,
) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app, "recovery_restore_branch", None, move || recovery::restore_branch(&p(&repo), &id, reference, &name)).await
}
#[tauri::command]
async fn recovery_restore_stash(app: AppHandle, expected_state: Option<String>, repo: String, id: String, reference: usize) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app, "recovery_restore_stash", None, move || recovery::restore_stash(&p(&repo), &id, reference)).await
}
#[tauri::command]
async fn recovery_restore_workspace(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    id: String,
    destination: String,
    name: String,
) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app, "recovery_restore_workspace", None, move || {
        recovery::restore_workspace(&p(&repo), &id, &p(&destination), &name)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitVersionInfo {
    version: String,
    supported: bool,
    layers_reorder: bool,
}

#[tauri::command]
fn git_selection() -> Option<git::locate::GitSelection> {
    git::locate::selection()
}

/// Looks for git again (after the user installed or updated it).
#[tauri::command]
async fn git_configure(state: State<'_, AppState>) -> GitResult<git::locate::GitSelection> {
    let sel = blocking(|| Ok(git::locate::configure())).await?;
    state.graphs.lock().clear();
    Ok(sel)
}

#[tauri::command]
fn askpass_respond(id: u64, value: Option<String>) -> bool {
    askpass::respond(id, value)
}

#[tauri::command]
async fn git_version() -> GitResult<GitVersionInfo> {
    blocking(|| {
        let (a, b, _, v) = runner::version()?;
        Ok(GitVersionInfo { version: v, supported: (a, b) >= (2, 30), layers_reorder: (a, b) >= (2, 40) })
    })
    .await
}

#[tauri::command]
async fn repo_open(path: String) -> GitResult<RepoInfo> {
    blocking(move || repo::info(&p(&path))).await
}

#[tauri::command]
async fn repo_init(app: AppHandle, path: String, branch: Option<String>) -> GitResult<RepoInfo> {
    // Initialization is logged separately because the repository gate does not exist yet.
    blocking(move || {
        journal::record(
            &p(&path),
            "repo_init",
            || {
                let _ = app.emit("operation-log-changed", ());
            },
            || repo::init(&p(&path), branch.as_deref().unwrap_or("main")),
        )
    })
    .await
}

#[tauri::command]
async fn repo_clone(app: AppHandle, parent: String, url: String, name: String, op_id: String) -> GitResult<RepoInfo> {
    blocking(move || {
        journal::record(
            &p(&parent).join(&name),
            "repo_clone",
            || {
                let _ = app.emit("operation-log-changed", ());
            },
            || {
                let root = ops::clone(&p(&parent), &url, &name, progress(&app, &op_id))?;
                repo::info(&root)
            },
        )
    })
    .await
}

#[tauri::command]
async fn repo_info(repo: String) -> GitResult<RepoInfo> {
    blocking(move || repo::info(&p(&repo))).await
}

#[tauri::command]
async fn status(repo: String) -> GitResult<StatusSummary> {
    blocking(move || status::status(&p(&repo))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    name: Option<String>,
    email: Option<String>,
}

#[tauri::command]
async fn identity_get(repo: String) -> GitResult<Identity> {
    blocking(move || {
        let r = p(&repo);
        Ok(Identity { name: repo::config_get(&r, "user.name"), email: repo::config_get(&r, "user.email") })
    })
    .await
}

#[tauri::command]
async fn identity_set(app: AppHandle, expected_state: Option<String>, repo: String, name: String, email: String, global: bool) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "identity_set", None, move || {
        let r = p(&repo);
        repo::config_set(&r, "user.name", name.trim(), global)?;
        repo::config_set(&r, "user.email", email.trim(), global)
    })
    .await
}

// ───────────────────────────── diffs & staging ─────────────────────────────

#[tauri::command]
async fn working_diff(repo: String, path: String, side: WorkSide, untracked: bool, opts: Option<DiffOptions>) -> GitResult<FileDiff> {
    blocking(move || {
        let r = p(&repo);
        let base = if side == WorkSide::Staged { layers::staged_base(&r) } else { None };
        diff::working_diff(&r, &path, side, base.as_deref(), untracked, &opts.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn rev_diff(repo: String, from: Option<String>, to: String, path: String, opts: Option<DiffOptions>) -> GitResult<FileDiff> {
    blocking(move || diff::rev_diff(&p(&repo), from.as_deref(), &to, &path, &opts.unwrap_or_default())).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat Tauri IPC arguments preserve the existing client contract.
async fn apply_selection(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    path: String,
    mode: SelectionMode,
    selection: Vec<(usize, usize)>,
    hash: String,
    untracked: bool,
    opts: Option<DiffOptions>,
) -> GitResult<()> {
    let checkpoint_expected = expected_state.clone();
    mutating(repo.clone(), expected_state, app.clone(), "apply_selection", None, move || {
        let r = p(&repo);
        if mode == SelectionMode::Discard {
            recovery::automatic_expected(&r, "discard_lines", true, false, checkpoint_expected.as_deref())?;
        }
        let base = if mode == SelectionMode::Unstage { layers::staged_base(&r) } else { None };
        diff::apply_selection(&r, &path, mode, &selection, &hash, base.as_deref(), untracked, &opts.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn stage(app: AppHandle, expected_state: Option<String>, repo: String, paths: Vec<String>) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "stage", None, move || ops::stage_paths(&p(&repo), &paths)).await
}

#[tauri::command]
async fn unstage(app: AppHandle, expected_state: Option<String>, repo: String, paths: Vec<String>) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "unstage", None, move || {
        let r = p(&repo);
        let base = layers::staged_base(&r);
        ops::unstage_paths(&r, &paths, base.as_deref())
    })
    .await
}

#[tauri::command]
async fn discard(app: AppHandle, expected_state: Option<String>, repo: String, tracked: Vec<String>, untracked: Vec<String>) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "discard", None, move || ops::discard_paths(&p(&repo), &tracked, &untracked)).await
}

#[tauri::command]
async fn commit(app: AppHandle, expected_state: Option<String>, repo: String, message: String, opts: Option<CommitOptions>) -> GitResult<String> {
    let checkpoint_expected = expected_state.clone();
    mutating(repo.clone(), expected_state, app.clone(), "commit", None, move || {
        let opts = opts.unwrap_or_default();
        if opts.amend {
            recovery::automatic_expected(&p(&repo), "amend", true, false, checkpoint_expected.as_deref())?;
        }
        ops::commit(&p(&repo), &message, &opts)
    })
    .await
}

#[tauri::command]
async fn last_message(repo: String) -> GitResult<String> {
    blocking(move || ops::last_message(&p(&repo))).await
}

// ───────────────────────────── history ─────────────────────────────

#[tauri::command]
async fn graph_load(
    state: State<'_, AppState>,
    repo: String,
    branch: Option<String>,
    include_worktree: bool,
    limit: Option<usize>,
    fast: Option<bool>,
) -> GitResult<GraphSummary> {
    let key = repo.clone();
    let fast = fast.unwrap_or(false);
    let prev = state.graphs.lock().get(&repo).cloned();
    let cache = blocking(move || graph::build_with(&p(&repo), branch.as_deref(), include_worktree, limit.unwrap_or(150_000), fast, prev.as_deref())).await?;
    let head_index = cache.rows.iter().position(|r| r.is_head);
    let summary = GraphSummary { key: cache.key.clone(), total: cache.rows.len(), max_lanes: cache.max_lanes, head_index };
    state.graphs.lock().insert(key, Arc::new(cache));
    Ok(summary)
}

#[tauri::command]
fn graph_rows(state: State<'_, AppState>, repo: String, start: usize, count: usize) -> GitResult<Vec<GraphRow>> {
    let graphs = state.graphs.lock();
    let cache = graphs.get(&repo).ok_or_else(|| GitError::new("History is not loaded."))?;
    let end = (start + count).min(cache.rows.len());
    Ok(if start >= end { Vec::new() } else { cache.rows[start..end].to_vec() })
}

#[tauri::command]
fn graph_find(state: State<'_, AppState>, repo: String, oid: String) -> Option<usize> {
    let graphs = state.graphs.lock();
    let cache = graphs.get(&repo)?;
    if let Some(i) = cache.index.get(&oid) {
        return Some(*i);
    }
    cache.rows.iter().position(|r| r.oid.starts_with(&oid))
}

#[tauri::command]
async fn graph_search(state: State<'_, AppState>, repo: String, query: String, mode: SearchMode) -> GitResult<Vec<usize>> {
    let cache = state.graphs.lock().get(&repo).cloned().ok_or_else(|| GitError::new("History is not loaded."))?;
    blocking(move || graph::search(&p(&repo), &cache, &query, mode)).await
}

#[tauri::command]
async fn commit_graph_status(repo: String) -> GitResult<bool> {
    blocking(move || Ok(graph::has_commit_graph(&p(&repo)))).await
}

#[tauri::command]
async fn commit_graph_write(expected_state: Option<String>, app: AppHandle, repo: String, op_id: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "commit_graph_write", Some(op_id.clone()), move || {
        graph::write_commit_graph(&p(&repo), progress(&app, &op_id))
    })
    .await
}

#[tauri::command]
async fn commit_details(repo: String, oid: String) -> GitResult<CommitDetails> {
    blocking(move || gcommit::details(&p(&repo), &oid)).await
}

#[tauri::command]
async fn file_history(repo: String, path: String) -> GitResult<Vec<FileHistoryEntry>> {
    blocking(move || gcommit::file_history(&p(&repo), &path, 500)).await
}

#[tauri::command]
async fn file_text(repo: String, spec: String) -> GitResult<Option<String>> {
    blocking(move || gcommit::blob_text(&p(&repo), &spec)).await
}

#[tauri::command]
async fn blame(repo: String, path: String, rev: Option<String>) -> GitResult<git::inspect::Blame> {
    blocking(move || git::inspect::blame(&p(&repo), &path, rev.as_deref())).await
}

#[tauri::command]
async fn compare(repo: String, from: String, to: String, three_dot: bool) -> GitResult<git::inspect::Comparison> {
    blocking(move || git::inspect::compare(&p(&repo), &from, &to, three_dot)).await
}

#[tauri::command]
async fn blob(repo: String, spec: git::inspect::BlobSpec) -> GitResult<Option<git::inspect::BlobData>> {
    blocking(move || git::inspect::blob(&p(&repo), &spec)).await
}

#[tauri::command]
async fn reflog(repo: String) -> GitResult<Vec<ReflogEntry>> {
    blocking(move || ops::reflog(&p(&repo), 150)).await
}

// ───────────────────────────── refs ─────────────────────────────

#[tauri::command]
async fn refs_snapshot(repo: String) -> GitResult<RefsSnapshot> {
    blocking(move || refs::snapshot(&p(&repo))).await
}

/// Branches already squash- or rebase-merged into HEAD.
#[tauri::command]
async fn squash_merged(repo: String) -> GitResult<Vec<String>> {
    blocking(move || refs::squash_merged(&p(&repo))).await
}

#[tauri::command]
async fn branch_details(repo: String, name: String, base: String) -> GitResult<refs::BranchDetails> {
    blocking(move || refs::branch_details(&p(&repo), &name, &base)).await
}

#[tauri::command]
async fn checkout(app: AppHandle, expected_state: Option<String>, repo: String, target: String, kind: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "checkout", None, move || ops::checkout(&p(&repo), &target, &kind)).await
}

#[tauri::command]
async fn branch_create(app: AppHandle, expected_state: Option<String>, repo: String, name: String, start: Option<String>, checkout: bool) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "branch_create", None, move || ops::create_branch(&p(&repo), &name, start.as_deref(), checkout)).await
}

#[tauri::command]
async fn branch_rename(app: AppHandle, expected_state: Option<String>, repo: String, old: String, new: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "branch_rename", None, move || ops::rename_branch(&p(&repo), &old, &new)).await
}

#[tauri::command]
async fn branch_delete_plan(
    repo: String,
    name: String,
    base: Option<String>,
    target: Option<RemoteBranchTarget>,
    saved_local_oid: Option<String>,
    remote_only: Option<bool>,
) -> GitResult<DeletionPlan> {
    blocking(move || branch_review::plan(&p(&repo), &name, base.as_deref(), target, saved_local_oid.as_deref(), remote_only.unwrap_or(false))).await
}

#[tauri::command]
async fn branch_delete_reviewed(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    review: DeletionProof,
    include_remote: bool,
    force: bool,
    protection_rules: Option<Vec<String>>,
) -> GitResult<DeletionResult> {
    let expected = expected_state.clone();
    mutating(repo.clone(), expected_state, app.clone(), "branch_delete_reviewed", None, move || {
        branch_review::delete_local(&p(&repo), &review, include_remote, force, expected.as_deref(), protection_rules.as_deref())
    })
    .await
}

#[tauri::command]
async fn branch_delete_remote_reviewed(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    review: DeletionProof,
    force: bool,
    op_id: String,
    protection_rules: Option<Vec<String>>,
) -> GitResult<DeletionResult> {
    let expected = expected_state.clone();
    mutating(repo.clone(), expected_state, app.clone(), "branch_delete_remote_reviewed", Some(op_id.clone()), move || {
        branch_review::delete_remote(&p(&repo), &review, force, expected.as_deref(), protection_rules.as_deref(), progress(&app, &op_id))
    })
    .await
}

#[tauri::command]
async fn branch_delete_remote_target(repo: String, tracking_ref: String) -> GitResult<RemoteBranchTarget> {
    blocking(move || branch_deletion::remote_target(&p(&repo), &tracking_ref)).await
}

#[tauri::command]
async fn branch_delete_targets(repo: String, name: String) -> GitResult<Vec<RemoteBranchTarget>> {
    blocking(move || branch_deletion::targets(&p(&repo), &name)).await
}

#[tauri::command]
async fn branch_delete(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    name: String,
    force: bool,
    target: Option<RemoteBranchTarget>,
) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "branch_delete", None, move || branch_deletion::delete(&p(&repo), &name, force, target.as_ref())).await
}

#[tauri::command]
async fn branch_delete_remote(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    target: RemoteBranchTarget,
    force: bool,
    op_id: String,
) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "branch_delete_remote", Some(op_id.clone()), move || {
        branch_deletion::delete_remote(&p(&repo), &target, force, progress(&app, &op_id))
    })
    .await
}

#[tauri::command]
async fn branch_delete_refresh(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    target: RemoteBranchTarget,
    op_id: String,
) -> GitResult<branch_deletion::RemoteDeletionReview> {
    mutating(repo.clone(), expected_state, app.clone(), "branch_delete_refresh", Some(op_id.clone()), move || {
        branch_deletion::refresh_remote(&p(&repo), &target, progress(&app, &op_id))
    })
    .await
}

#[tauri::command]
async fn branch_set_upstream(app: AppHandle, expected_state: Option<String>, repo: String, branch: String, upstream: Option<String>) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "branch_set_upstream", None, move || ops::set_upstream(&p(&repo), &branch, upstream.as_deref())).await
}

#[tauri::command]
async fn tag_create(app: AppHandle, expected_state: Option<String>, repo: String, name: String, target: String, message: Option<String>) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "tag_create", None, move || ops::create_tag(&p(&repo), &name, &target, message.as_deref())).await
}

#[tauri::command]
async fn tag_delete(app: AppHandle, expected_state: Option<String>, repo: String, name: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "tag_delete", None, move || ops::delete_tag(&p(&repo), &name)).await
}

#[tauri::command]
async fn reset(app: AppHandle, expected_state: Option<String>, repo: String, target: String, mode: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "reset", None, move || ops::reset(&p(&repo), &target, &mode)).await
}

#[tauri::command]
async fn undo_commit(app: AppHandle, expected_state: Option<String>, repo: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "undo_commit", None, move || ops::undo_last_commit(&p(&repo))).await
}

// ───────────────────────────── remotes ─────────────────────────────

#[tauri::command]
async fn fetch(expected_state: Option<String>, app: AppHandle, repo: String, remote: Option<String>, prune: bool, op_id: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "fetch", Some(op_id.clone()), move || {
        ops::fetch(&p(&repo), remote.as_deref(), prune, progress(&app, &op_id))
    })
    .await
}

/// Periodic fetch in the background: never asks for credentials.
#[tauri::command]
async fn fetch_background(app: AppHandle, expected_state: Option<String>, repo: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "fetch_background", None, move || ops::fetch_background(&p(&repo))).await
}

#[tauri::command]
async fn pull(expected_state: Option<String>, app: AppHandle, repo: String, mode: String, op_id: String) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "pull", Some(op_id.clone()), move || ops::pull(&p(&repo), &mode, progress(&app, &op_id))).await
}

#[tauri::command]
async fn push(expected_state: Option<String>, app: AppHandle, repo: String, opts: PushOptions, op_id: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "push", Some(op_id.clone()), move || ops::push(&p(&repo), &opts, progress(&app, &op_id))).await
}

#[tauri::command]
async fn push_ref(expected_state: Option<String>, app: AppHandle, repo: String, remote: String, refspec: String, op_id: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "push_ref", Some(op_id.clone()), move || {
        ops::push_ref(&p(&repo), &remote, &refspec, progress(&app, &op_id))
    })
    .await
}

#[tauri::command]
async fn remote_add(app: AppHandle, expected_state: Option<String>, repo: String, name: String, url: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "remote_add", None, move || ops::remote_add(&p(&repo), &name, &url)).await
}

#[tauri::command]
async fn remote_remove(app: AppHandle, expected_state: Option<String>, repo: String, name: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "remote_remove", None, move || ops::remote_remove(&p(&repo), &name)).await
}

#[tauri::command]
async fn remote_set_url(app: AppHandle, expected_state: Option<String>, repo: String, name: String, url: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "remote_set_url", None, move || ops::remote_set_url(&p(&repo), &name, &url)).await
}

// ───────────────────────────── merge & friends ─────────────────────────────

#[tauri::command]
async fn merge_start(app: AppHandle, expected_state: Option<String>, repo: String, target: String, strategy: String) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "merge_start", None, move || ops::merge_start(&p(&repo), &target, &strategy)).await
}

#[tauri::command]
async fn op_abort(app: AppHandle, expected_state: Option<String>, repo: String, kind: String) -> GitResult<studio::StepOutcome> {
    let expected = expected_state.clone();
    mutating(repo.clone(), expected_state, app.clone(), "op_abort", None, move || studio::abort(&p(&repo), &kind, expected.as_deref())).await
}

#[tauri::command]
async fn op_continue(app: AppHandle, expected_state: Option<String>, repo: String, kind: String, message: Option<String>) -> GitResult<studio::StepOutcome> {
    let expected = expected_state.clone();
    mutating(repo.clone(), expected_state, app.clone(), "op_continue", None, move || {
        studio::step(&p(&repo), &kind, expected.as_deref(), || ops::continue_op(&p(&repo), &kind, message.as_deref()))
    })
    .await
}

#[tauri::command]
async fn op_skip(app: AppHandle, expected_state: Option<String>, repo: String, kind: String) -> GitResult<studio::StepOutcome> {
    let expected = expected_state.clone();
    mutating(repo.clone(), expected_state, app.clone(), "op_skip", None, move || {
        studio::step(&p(&repo), &kind, expected.as_deref(), || ops::skip_op(&p(&repo), &kind))
    })
    .await
}

#[tauri::command]
async fn cherry_pick(app: AppHandle, expected_state: Option<String>, repo: String, oids: Vec<String>, no_commit: bool) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "cherry_pick", None, move || ops::cherry_pick(&p(&repo), &oids, no_commit)).await
}

#[tauri::command]
async fn revert(app: AppHandle, expected_state: Option<String>, repo: String, oid: String, no_commit: bool) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "revert", None, move || ops::revert(&p(&repo), &oid, no_commit)).await
}

#[tauri::command]
async fn rebase_onto(app: AppHandle, expected_state: Option<String>, repo: String, upstream: String) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "rebase_onto", None, move || ops::rebase_onto(&p(&repo), &upstream)).await
}

#[tauri::command]
async fn rebase_plan(repo: String, oldest: String) -> GitResult<Observed<ops::RebasePlan>> {
    blocking(move || git::operations::inspect(&p(&repo), || ops::rebase_plan(&p(&repo), &oldest)).map(|(value, state_token)| Observed { value, state_token }))
        .await
}

#[tauri::command]
async fn interactive_rebase(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    base: Option<String>,
    items: Vec<ops::RebaseItem>,
) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "interactive_rebase", None, move || ops::interactive_rebase(&p(&repo), base.as_deref(), &items)).await
}

#[tauri::command]
async fn rewrite(app: AppHandle, expected_state: Option<String>, repo: String, action: RewriteAction) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "rewrite", None, move || ops::rewrite(&p(&repo), &action)).await
}

#[tauri::command]
async fn rebase_studio_review(repo: String, oldest: String, items: Vec<ops::RebaseItem>) -> GitResult<Observed<studio::Review>> {
    blocking(move || {
        git::operations::inspect(&p(&repo), || studio::review(&p(&repo), &oldest, &items)).map(|(value, state_token)| Observed { value, state_token })
    })
    .await
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StudioStartRequest {
    oldest: String,
    items: Vec<ops::RebaseItem>,
    review_token: String,
    ack_published: bool,
    ack_dirty: bool,
}
#[tauri::command]
async fn rebase_studio_start(app: AppHandle, expected_state: Option<String>, repo: String, request: StudioStartRequest) -> GitResult<studio::StartResult> {
    let expected = expected_state.clone().ok_or_else(|| GitError::new("A reviewed repository state is required."))?;
    mutating(repo.clone(), expected_state, app, "rebase_studio_start", None, move || {
        studio::start(&p(&repo), &request.oldest, &request.items, &request.review_token, &expected, request.ack_published, request.ack_dirty)
    })
    .await
}
#[tauri::command]
async fn rebase_studio_report(repo: String) -> GitResult<Option<studio::Report>> {
    blocking(move || git::operations::inspect(&p(&repo), || studio::report(&p(&repo))).map(|(value, _)| value)).await
}
#[tauri::command]
async fn rebase_studio_comparison(repo: String, id: String) -> GitResult<studio::Comparison> {
    blocking(move || git::operations::inspect(&p(&repo), || studio::comparison(&p(&repo), &id)).map(|(value, _)| value)).await
}
#[tauri::command]
async fn rebase_studio_capture(app: AppHandle, expected_state: Option<String>, repo: String, id: String, head: String) -> GitResult<studio::Report> {
    let expected = expected_state.clone();
    mutating(repo.clone(), expected_state, app, "rebase_studio_capture", None, move || studio::capture(&p(&repo), &id, &head, expected.as_deref())).await
}

// ───────────────────────────── conflicts ─────────────────────────────

#[tauri::command]
async fn conflict_info(repo: String, path: String) -> GitResult<Observed<ConflictInfo>> {
    blocking(move || git::operations::inspect(&p(&repo), || conflicts::info(&p(&repo), &path)).map(|(value, state_token)| Observed { value, state_token }))
        .await
}

#[tauri::command]
async fn conflict_save(app: AppHandle, expected_state: Option<String>, repo: String, path: String, content: String, stage: bool) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "conflict_save", None, move || conflicts::save_resolution(&p(&repo), &path, &content, stage)).await
}

#[tauri::command]
async fn conflict_take(app: AppHandle, expected_state: Option<String>, repo: String, path: String, which: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "conflict_take", None, move || conflicts::take_side(&p(&repo), &path, &which)).await
}

#[tauri::command]
async fn conflict_mark_resolved(app: AppHandle, expected_state: Option<String>, repo: String, paths: Vec<String>) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "conflict_mark_resolved", None, move || conflicts::mark_resolved(&p(&repo), &paths)).await
}

#[tauri::command]
async fn conflict_unresolve(app: AppHandle, expected_state: Option<String>, repo: String, path: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "conflict_unresolve", None, move || conflicts::unresolve(&p(&repo), &path)).await
}

#[tauri::command]
async fn ignored_files(repo: String) -> GitResult<git::workspace_files::IgnoredFiles> {
    blocking(move || git::workspace_files::ignored(&p(&repo))).await
}

#[tauri::command]
async fn nested_repositories(repo: String) -> GitResult<git::workspace_files::NestedRepositories> {
    blocking(move || git::workspace_files::nested(&p(&repo))).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn stash_selection(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    path: String,
    selection: Vec<(usize, usize)>,
    hash: String,
    opts: Option<DiffOptions>,
    message: String,
) -> GitResult<git::partial_stash::PartialStashResult> {
    mutating(repo.clone(), expected_state, app, "stash_selection", None, move || {
        git::partial_stash::save(&p(&repo), &path, &selection, &hash, &opts.unwrap_or_default(), &message)
    })
    .await
}

#[tauri::command]
async fn remote_rename_plan(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    tracking_ref: String,
    new_name: String,
) -> GitResult<git::remote_rename::RenamePlan> {
    mutating(repo.clone(), expected_state, app, "remote_rename_plan", None, move || git::remote_rename::plan(&p(&repo), &tracking_ref, &new_name)).await
}

#[tauri::command]
async fn remote_branch_rename(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    plan: git::remote_rename::RenamePlan,
) -> GitResult<git::remote_rename::RenameResult> {
    if expected_state.as_deref() != Some(plan.state_token.as_str()) {
        return Err(GitError::new("Reopen the remote rename review.").kind("stale-operation"));
    }
    mutating(repo.clone(), expected_state, app, "remote_branch_rename", None, move || git::remote_rename::rename(&p(&repo), &plan)).await
}

// ───────────────────────────── stash ─────────────────────────────

#[tauri::command]
async fn stash_save(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    message: String,
    include_untracked: bool,
    keep_index: bool,
    paths: Option<Vec<String>>,
) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "stash_save", None, move || {
        ops::stash_save(&p(&repo), &message, include_untracked, keep_index, &paths.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn stash_apply(app: AppHandle, expected_state: Option<String>, repo: String, index: u32, pop: bool) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "stash_apply", None, move || ops::stash_apply(&p(&repo), index, pop)).await
}

#[tauri::command]
async fn stash_drop(app: AppHandle, expected_state: Option<String>, repo: String, index: u32) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "stash_drop", None, move || ops::stash_drop(&p(&repo), index)).await
}

// ───────────────────────────── stage layers ─────────────────────────────

#[tauri::command]
async fn layers_state(repo: String) -> GitResult<LayersState> {
    blocking(move || layers::state(&p(&repo))).await
}

#[tauri::command]
async fn layer_seal(app: AppHandle, expected_state: Option<String>, repo: String, name: Option<String>) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_seal", None, move || layers::seal(&p(&repo), name.as_deref())).await
}

#[tauri::command]
async fn layer_unstage(app: AppHandle, expected_state: Option<String>, repo: String, index: usize, resolutions: Option<layers::Resolutions>) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_unstage", None, move || layers::unstage(&p(&repo), index, &resolutions.unwrap_or_default()))
        .await
}

#[tauri::command]
async fn layer_discard(app: AppHandle, expected_state: Option<String>, repo: String, index: usize) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_discard", None, move || layers::discard(&p(&repo), index)).await
}

#[tauri::command]
async fn layer_merge_down(app: AppHandle, expected_state: Option<String>, repo: String, index: usize) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_merge_down", None, move || layers::merge_down(&p(&repo), index)).await
}

#[tauri::command]
async fn layer_move(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    index: usize,
    delta: i32,
    resolutions: Option<layers::Resolutions>,
) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_move", None, move || {
        layers::move_layer(&p(&repo), index, delta, &resolutions.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn layer_rename(app: AppHandle, expected_state: Option<String>, repo: String, index: usize, name: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_rename", None, move || layers::rename(&p(&repo), index, &name)).await
}

#[tauri::command]
async fn layers_flatten(app: AppHandle, expected_state: Option<String>, repo: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "layers_flatten", None, move || layers::flatten(&p(&repo))).await
}

/// Dry-runs a layer operation and returns the first conflict that still needs a resolution.
#[tauri::command]
async fn layer_preview(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    op: layers::LayerOp,
    resolutions: Option<layers::Resolutions>,
) -> GitResult<Option<layers::LayerConflict>> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_preview", None, move || layers::preview(&p(&repo), &op, &resolutions.unwrap_or_default())).await
}

#[tauri::command]
async fn layer_unstage_files(app: AppHandle, expected_state: Option<String>, repo: String, index: usize, paths: Vec<String>) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_unstage_files", None, move || layers::unstage_files(&p(&repo), index, &paths)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat Tauri IPC arguments preserve the existing client contract.
async fn layer_commit(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    index: usize,
    message: String,
    through: bool,
    opts: Option<CommitOptions>,
    resolutions: Option<layers::Resolutions>,
) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "layer_commit", None, move || {
        let o = opts.unwrap_or_default();
        if through {
            layers::commit_through(&p(&repo), index, &message, &o)
        } else {
            layers::commit_layer(&p(&repo), index, &message, &o, &resolutions.unwrap_or_default())
        }
    })
    .await
}

// ───────────────────────────── submodules, worktrees, bisect, LFS, signing ─────────────────────────────

use git::extras::{self, BisectStatus, LfsFile, LfsStatus, Signature, SigningConfig, SigningInput, Submodule, Worktree};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoExtras {
    submodules: Vec<Submodule>,
    worktrees: Vec<Worktree>,
    lfs: Option<LfsStatus>,
    bisect: Option<BisectStatus>,
}

/// Everything the sidebar shows besides refs, gathered in parallel.
#[tauri::command]
async fn repo_extras(repo: String) -> GitResult<RepoExtras> {
    blocking(move || {
        let r = p(&repo);
        std::thread::scope(|sc| {
            let subs = sc.spawn(|| extras::submodules(&r).unwrap_or_default());
            let wts = sc.spawn(|| extras::worktrees(&r).unwrap_or_default());
            let lfs = sc.spawn(|| if extras::repo_uses_lfs(&r) { extras::lfs_status(&r).ok() } else { None });
            let bisect = extras::bisect_status(&r).ok().filter(|b| b.active);
            Ok(RepoExtras { submodules: subs.join().unwrap_or_default(), worktrees: wts.join().unwrap_or_default(), lfs: lfs.join().unwrap_or(None), bisect })
        })
    })
    .await
}

#[tauri::command]
async fn submodule_update(expected_state: Option<String>, app: AppHandle, repo: String, paths: Vec<String>, op_id: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "submodule_update", Some(op_id.clone()), move || {
        extras::submodule_update(&p(&repo), &paths, progress(&app, &op_id))
    })
    .await
}

#[tauri::command]
async fn submodule_add(expected_state: Option<String>, app: AppHandle, repo: String, url: String, path: String, op_id: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "submodule_add", Some(op_id.clone()), move || {
        extras::submodule_add(&p(&repo), &url, &path, progress(&app, &op_id))
    })
    .await
}

#[tauri::command]
async fn submodule_sync(app: AppHandle, expected_state: Option<String>, repo: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "submodule_sync", None, move || extras::submodule_sync(&p(&repo))).await
}

#[tauri::command]
async fn worktree_add(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    path: String,
    branch: Option<String>,
    new_branch: Option<String>,
    start: Option<String>,
) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "worktree_add", None, move || {
        extras::worktree_add(&p(&repo), &path, branch.as_deref(), new_branch.as_deref(), start.as_deref())
    })
    .await
}

#[tauri::command]
async fn worktree_remove(
    app: AppHandle,
    expected_state: Option<String>,
    expected_target_state: Option<String>,
    repo: String,
    path: String,
    force: bool,
) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "worktree_remove", None, move || {
        if let Some(expected) = &expected_target_state {
            if status::status(&p(&path))?.state_token.as_deref() != Some(expected.as_str()) {
                return Err(GitError::new("The worktree changed while the confirmation was open. Review it before removing it.").kind("stale-operation"));
            }
        }
        recovery::automatic_expected(&p(&path), "worktree_remove", true, true, expected_target_state.as_deref())?;
        extras::worktree_remove(&p(&repo), &path, force)
    })
    .await
}

#[tauri::command]
async fn worktree_lock(app: AppHandle, expected_state: Option<String>, repo: String, path: String, lock: bool) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "worktree_lock", None, move || extras::worktree_lock(&p(&repo), &path, lock)).await
}

#[tauri::command]
async fn worktree_prune(app: AppHandle, expected_state: Option<String>, repo: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "worktree_prune", None, move || extras::worktree_prune(&p(&repo))).await
}

#[tauri::command]
async fn bisect_status(repo: String) -> GitResult<BisectStatus> {
    blocking(move || extras::bisect_status(&p(&repo))).await
}

#[tauri::command]
async fn bisect_start(app: AppHandle, expected_state: Option<String>, repo: String, bad: String, good: String) -> GitResult<BisectStatus> {
    mutating(repo.clone(), expected_state, app.clone(), "bisect_start", None, move || extras::bisect_start(&p(&repo), &bad, &good)).await
}

#[tauri::command]
async fn bisect_mark(app: AppHandle, expected_state: Option<String>, repo: String, verdict: String, rev: Option<String>) -> GitResult<BisectStatus> {
    mutating(repo.clone(), expected_state, app.clone(), "bisect_mark", None, move || extras::bisect_mark(&p(&repo), &verdict, rev.as_deref())).await
}

#[tauri::command]
async fn bisect_reset(app: AppHandle, expected_state: Option<String>, repo: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "bisect_reset", None, move || extras::bisect_reset(&p(&repo))).await
}

#[tauri::command]
async fn lfs_files(repo: String) -> GitResult<Vec<LfsFile>> {
    blocking(move || extras::lfs_files(&p(&repo))).await
}

#[tauri::command]
async fn lfs_track(app: AppHandle, expected_state: Option<String>, repo: String, pattern: String, track: bool) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "lfs_track", None, move || extras::lfs_track(&p(&repo), &pattern, track)).await
}

#[tauri::command]
async fn lfs_run(expected_state: Option<String>, app: AppHandle, repo: String, action: String, op_id: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "lfs_run", Some(op_id.clone()), move || extras::lfs_run(&p(&repo), &action, progress(&app, &op_id)))
        .await
}

#[tauri::command]
async fn signing_get(repo: String) -> GitResult<SigningConfig> {
    blocking(move || Ok(extras::signing_config(&p(&repo)))).await
}

#[tauri::command]
async fn signing_set(app: AppHandle, expected_state: Option<String>, repo: String, config: SigningInput, global: bool) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "signing_set", None, move || extras::set_signing(&p(&repo), &config, global)).await
}

#[tauri::command]
async fn commit_signature(repo: String, oid: String) -> GitResult<Signature> {
    blocking(move || extras::signature(&p(&repo), &oid)).await
}

// ───────────────────────────── maintenance, recovery, patches, browsing ─────────────────────────────

use git::maint;
use git::more;

#[tauri::command]
async fn repo_size(repo: String) -> GitResult<maint::RepoSize> {
    blocking(move || maint::size(&p(&repo))).await
}

#[tauri::command]
async fn maintenance_run(expected_state: Option<String>, app: AppHandle, repo: String, task: String, op_id: String) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "maintenance_run", Some(op_id.clone()), move || maint::run(&p(&repo), &task, progress(&app, &op_id)))
        .await
}

#[tauri::command]
async fn large_staged_files(repo: String, threshold: u64) -> GitResult<Vec<maint::LargeFile>> {
    blocking(move || maint::large_staged_files(&p(&repo), threshold)).await
}

#[tauri::command]
async fn deleted_branches(repo: String) -> GitResult<Vec<more::DeletedBranch>> {
    blocking(move || more::deleted_branches(&p(&repo))).await
}

#[tauri::command]
async fn restore_branch(app: AppHandle, expected_state: Option<String>, repo: String, name: String, oid: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "restore_branch", None, move || more::restore_branch(&p(&repo), &name, &oid)).await
}

#[tauri::command]
async fn branch_reflog(repo: String, name: String) -> GitResult<Vec<more::RefLogEntry>> {
    blocking(move || more::branch_reflog(&p(&repo), &name)).await
}

#[tauri::command]
async fn create_patch(repo: String, oids: Vec<String>, file: String) -> GitResult<usize> {
    blocking(move || more::create_patch(&p(&repo), &oids, &file)).await
}

#[tauri::command]
async fn apply_patch(app: AppHandle, expected_state: Option<String>, repo: String, file: String) -> GitResult<OpOutcome> {
    mutating(repo.clone(), expected_state, app.clone(), "apply_patch", None, move || more::apply_patch(&p(&repo), &file)).await
}

#[tauri::command]
async fn checkout_file(app: AppHandle, expected_state: Option<String>, repo: String, rev: String, path: String) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "checkout_file", None, move || more::checkout_file(&p(&repo), &rev, &path)).await
}

#[tauri::command]
async fn apply_from_commit(
    app: AppHandle,
    expected_state: Option<String>,
    repo: String,
    from: Option<String>,
    to: String,
    path: String,
    selection: Option<Vec<(usize, usize)>>,
) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "apply_from_commit", None, move || {
        more::apply_from_commit(&p(&repo), from.as_deref(), &to, &path, selection.as_deref())
    })
    .await
}

#[tauri::command]
async fn stash_contents(repo: String, index: u32) -> GitResult<more::StashContents> {
    blocking(move || more::stash_contents(&p(&repo), index)).await
}

#[tauri::command]
async fn stash_restore_file(app: AppHandle, expected_state: Option<String>, repo: String, index: u32, path: String, untracked: bool) -> GitResult<()> {
    mutating(repo.clone(), expected_state, app.clone(), "stash_restore_file", None, move || more::stash_restore_file(&p(&repo), index, &path, untracked)).await
}

#[tauri::command]
async fn list_tree(repo: String, rev: String) -> GitResult<Vec<String>> {
    blocking(move || more::list_tree(&p(&repo), &rev)).await
}

#[tauri::command]
async fn grep(repo: String, rev: String, query: String, ignore_case: bool, regex: bool) -> GitResult<Vec<more::GrepHit>> {
    blocking(move || more::grep(&p(&repo), &rev, &query, ignore_case, regex)).await
}

#[tauri::command]
async fn compare_worktree(repo: String, from: String) -> GitResult<more::WorktreeComparison> {
    blocking(move || more::compare_worktree(&p(&repo), &from)).await
}

#[tauri::command]
async fn worktree_file_diff(repo: String, from: String, path: String, opts: Option<DiffOptions>) -> GitResult<FileDiff> {
    blocking(move || more::worktree_file_diff(&p(&repo), &from, &path, &opts.unwrap_or_default())).await
}

#[tauri::command]
async fn commit_helpers(repo: String) -> GitResult<more::CommitHelpers> {
    blocking(move || more::commit_helpers(&p(&repo))).await
}

#[tauri::command]
async fn save_text_file(path: String, content: String) -> GitResult<()> {
    blocking(move || Ok(std::fs::write(&path, content)?)).await
}

// ───────────────────────────── GitHub / GitLab ─────────────────────────────

use git::forge;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequests {
    forge: forge::ForgeInfo,
    items: Vec<forge::PullRequest>,
}

#[tauri::command]
async fn forge_info(repo: String) -> GitResult<Option<forge::ForgeInfo>> {
    blocking(move || forge::detect(&p(&repo))).await
}

#[tauri::command]
async fn pull_requests(repo: String) -> GitResult<PullRequests> {
    blocking(move || forge::list(&p(&repo)).map(|(forge, items)| PullRequests { forge, items })).await
}

#[tauri::command]
async fn pull_request_create(repo: String, title: String, body: String, head: String, base: String, draft: bool) -> GitResult<forge::PullRequest> {
    blocking(move || forge::create(&p(&repo), &title, &body, &head, &base, draft)).await
}

#[tauri::command]
async fn pull_request_checkout(app: AppHandle, expected_state: Option<String>, repo: String, number: u64) -> GitResult<String> {
    mutating(repo.clone(), expected_state, app.clone(), "pull_request_checkout", None, move || forge::checkout(&p(&repo), number)).await
}

#[tauri::command]
async fn commit_checks(repo: String, sha: String) -> GitResult<Vec<forge::Check>> {
    blocking(move || forge::checks(&p(&repo), &sha)).await
}

// ───────────────────────────── watcher & shell ─────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChanged {
    repo: String,
    git: bool,
    worktree: bool,
}

#[tauri::command]
async fn watch_repo(app: AppHandle, state: State<'_, AppState>, repo: String) -> GitResult<()> {
    if state.watchers.lock().contains_key(&repo) {
        return Ok(());
    }
    let r = repo.clone();
    let gd = blocking(move || repo::git_dir(&p(&r))).await?;
    let key = repo.clone();
    let w = watcher::watch(p(&repo), gd, move |git, worktree| {
        let _ = app.emit("repo-changed", RepoChanged { repo: key.clone(), git, worktree });
    })
    .map_err(|e| GitError::new(format!("Cannot watch the repository: {e}")))?;
    state.watchers.lock().insert(repo, w);
    Ok(())
}

#[tauri::command]
fn unwatch_repo(state: State<'_, AppState>, repo: String) {
    state.watchers.lock().remove(&repo);
    state.graphs.lock().remove(&repo);
}

#[tauri::command]
fn reveal_path(path: String) -> GitResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", path.replace('/', "\\"))).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-R", &path]).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
        std::process::Command::new("xdg-open").arg(parent).spawn()?;
    }
    Ok(())
}

#[tauri::command]
fn open_path(path: String) -> GitResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd").args(["/C", "start", ""]).arg(path.replace('/', "\\")).creation_flags(0x0800_0000).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn()?;
    }
    Ok(())
}

#[tauri::command]
fn open_terminal(path: String) -> GitResult<()> {
    #[cfg(windows)]
    {
        let wt = std::process::Command::new("wt.exe").args(["-d", &path]).spawn();
        if wt.is_err() {
            std::process::Command::new("cmd").args(["/C", "start", "cmd"]).current_dir(&path).spawn()?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-a", "Terminal", &path]).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("x-terminal-emulator").current_dir(&path).spawn()?;
    }
    Ok(())
}

/// Latest release on GitHub compared with this build.
#[tauri::command]
async fn update_check(app: AppHandle) -> GitResult<update::UpdateInfo> {
    let current = app.package_info().version.to_string();
    blocking(move || update::check(&current)).await
}

/// Downloads and installs the update; progress goes out as `update-progress` events.
#[tauri::command]
async fn update_install(app: AppHandle) -> GitResult<()> {
    let current = app.package_info().version.to_string();
    blocking(move || {
        let info = update::check(&current)?;
        if !info.available {
            return Err(GitError::new("Revqora is already up to date."));
        }
        update::install(&info, |p| {
            let _ = app.emit("update-progress", p);
        })
    })
    .await
}

/// Starts the updated executable and closes this one.
#[tauri::command]
fn update_restart(app: AppHandle) -> GitResult<()> {
    update::relaunch()?;
    app.exit(0);
    Ok(())
}

/// Folders passed on the command line (`revqora <path>`), opened at startup.
#[tauri::command]
fn startup_paths() -> Vec<String> {
    std::env::args().skip(1).filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir()).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(all(windows, feature = "ui-automation"))]
    let context = {
        let mut context = context;
        if std::env::var("REVQORA_MULTI_INSTANCE").as_deref() == Ok("1") {
            if let Some(port) = std::env::var("REVQORA_CDP_PORT").ok().and_then(|value| value.parse::<u16>().ok()).filter(|port| *port > 0) {
                for window in &mut context.config_mut().app.windows {
                    if window.label == "main" {
                        let existing = window.additional_browser_args.take().unwrap_or_default();
                        window.additional_browser_args = Some(format!("{existing} --remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"));
                    }
                }
            }
        }
        context
    };
    // UI tests run the window off-screen, without a taskbar button and without taking focus,
    // unless they are asked to show it (`--visible`).
    let mut context = context;
    // The main window is created in `setup` with its web view profile in `data/` next to the exe;
    // created from the config, Tauri would make an (empty) folder under %LOCALAPPDATA% first.
    for window in &mut context.config_mut().app.windows {
        if window.label == "main" {
            window.create = false;
        }
    }
    if std::env::var("REVQORA_MULTI_INSTANCE").as_deref() == Ok("1") && std::env::var("REVQORA_TEST_HIDDEN").as_deref() == Ok("1") {
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" {
                window.center = false;
                window.x = Some(-32000.0);
                window.y = Some(-32000.0);
                window.skip_taskbar = true;
                window.focus = false;
            }
        }
    }
    let mut builder = tauri::Builder::default();
    // A second launch (e.g. "Open in Revqora" from Explorer) opens its folders as tabs in the
    // running window. Tests set REVQORA_MULTI_INSTANCE to run isolated copies side by side.
    if std::env::var_os("REVQORA_MULTI_INSTANCE").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<String> = argv.into_iter().skip(1).filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir()).collect();
            let _ = app.emit("open-paths", paths);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    // Settings and window geometry live in `data/` next to the exe. The window opens maximized
    // the first time, then as it was closed. UI tests keep their own off-screen geometry.
    let remember_window = std::env::var_os("REVQORA_MULTI_INSTANCE").is_none();
    if remember_window {
        builder = builder.on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => portable::track_window(window),
                tauri::WindowEvent::CloseRequested { .. } => portable::remember_window(window),
                _ => {}
            }
        });
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(move |app| {
            git::locate::configure();
            let log_dir = if std::env::var_os("REVQORA_MULTI_INSTANCE").is_some() {
                portable::webview_dir().map(|p| p.join("revqora-operation-log"))
            } else {
                portable::data_dir().map(|p| p.join("operation-log"))
            };
            journal::initialize(log_dir.as_deref());
            if let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() {
                // No Edge form autofill (its dropdown arrow showed up inside text fields).
                let mut wb = tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?.general_autofill_enabled(false);
                if let Some(dir) = portable::webview_dir() {
                    wb = wb.data_directory(dir);
                }
                let w = wb.build()?;
                if remember_window {
                    portable::restore_window(&w);
                }
            }
            if let Some(root) = update::launch().map(|l| l.root.clone()) {
                std::thread::spawn(move || update::cleanup(&root));
            }
            let handle = app.handle().clone();
            let exe = std::env::current_exe()?;
            if let Err(e) = askpass::start(
                &exe,
                std::sync::Arc::new(move |req| {
                    let _ = handle.emit("askpass-request", req);
                }),
            ) {
                eprintln!("askpass server failed to start: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            branch_manager_snapshot,
            branch_manager_compare,
            sync_prepare,
            sync_execute,
            operation_log_health,
            operation_log_list,
            operation_log_detail,
            operation_log_clear,
            operation_log_export,
            operation_log_retry,
            recovery_list,
            recovery_detail,
            recovery_create,
            recovery_delete,
            recovery_restore_branch,
            recovery_restore_stash,
            recovery_restore_workspace,
            git_version,
            update_check,
            update_install,
            update_restart,
            git_selection,
            git_configure,
            askpass_respond,
            repo_open,
            repo_init,
            repo_clone,
            repo_info,
            status,
            identity_get,
            identity_set,
            working_diff,
            rev_diff,
            apply_selection,
            stage,
            unstage,
            discard,
            commit,
            last_message,
            graph_load,
            graph_rows,
            graph_find,
            graph_search,
            commit_details,
            commit_graph_status,
            commit_graph_write,
            file_history,
            file_text,
            reflog,
            blame,
            compare,
            blob,
            refs_snapshot,
            fetch_background,
            squash_merged,
            branch_details,
            checkout,
            branch_create,
            branch_rename,
            branch_delete,
            branch_delete_plan,
            branch_delete_reviewed,
            branch_delete_remote_reviewed,
            branch_delete_targets,
            branch_delete_remote_target,
            branch_delete_remote,
            branch_delete_refresh,
            branch_set_upstream,
            tag_create,
            tag_delete,
            reset,
            undo_commit,
            fetch,
            pull,
            push,
            push_ref,
            remote_add,
            remote_remove,
            remote_set_url,
            merge_start,
            op_abort,
            op_continue,
            op_skip,
            cherry_pick,
            revert,
            rebase_onto,
            rewrite,
            rebase_plan,
            rebase_studio_review,
            rebase_studio_start,
            rebase_studio_report,
            rebase_studio_comparison,
            rebase_studio_capture,
            interactive_rebase,
            conflict_info,
            validation_start,
            validation_report,
            validation_cancel,
            conflict_save,
            conflict_take,
            conflict_mark_resolved,
            conflict_unresolve,
            ignored_files,
            nested_repositories,
            stash_selection,
            remote_rename_plan,
            remote_branch_rename,
            stash_save,
            stash_apply,
            stash_drop,
            layers_state,
            layer_seal,
            layer_unstage,
            layer_discard,
            layer_merge_down,
            layer_move,
            layer_rename,
            layers_flatten,
            layer_unstage_files,
            layer_preview,
            layer_commit,
            repo_extras,
            repo_size,
            forge_info,
            pull_requests,
            pull_request_create,
            pull_request_checkout,
            commit_checks,
            maintenance_run,
            large_staged_files,
            deleted_branches,
            restore_branch,
            branch_reflog,
            create_patch,
            apply_patch,
            checkout_file,
            apply_from_commit,
            stash_contents,
            stash_restore_file,
            list_tree,
            grep,
            compare_worktree,
            worktree_file_diff,
            commit_helpers,
            save_text_file,
            submodule_update,
            submodule_add,
            submodule_sync,
            worktree_add,
            worktree_remove,
            worktree_lock,
            worktree_prune,
            bisect_status,
            bisect_start,
            bisect_mark,
            bisect_reset,
            lfs_files,
            lfs_track,
            lfs_run,
            signing_get,
            signing_set,
            commit_signature,
            watch_repo,
            unwatch_repo,
            reveal_path,
            open_path,
            open_terminal,
            startup_paths,
        ])
        .build(context)
        .expect("error while building Revqora")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                git::validation::cancel_all();
            }
        });
}
