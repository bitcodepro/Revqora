use super::{Bridge, Session};
use crate::git::{operations, repo, runner::GitResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[derive(Clone, PartialEq)]
pub(crate) struct PickIdentity {
    incoming: String,
    head: Option<String>,
}

pub(crate) struct TrackedPick {
    id: String,
    root: PathBuf,
    identity: PickIdentity,
    result: Option<PickResult>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub(crate) enum PickResult {
    Succeeded { sha: String },
    Cancelled { reason: &'static str },
    Failed { reason: &'static str },
}

fn active(bridge: &Bridge) -> Option<Arc<Session>> {
    bridge.0.lock().clone()
}

fn identity(root: &Path) -> GitResult<Option<PickIdentity>> {
    let state = repo::op_state(root, &repo::git_dir(root)?);
    match state.incoming.filter(|_| state.kind == "cherry-pick") {
        Some(incoming) => Ok(Some(PickIdentity { incoming, head: repo::head(root)?.oid })),
        None => Ok(None),
    }
}

pub(crate) fn before_step(app: &AppHandle, root: &Path, kind: &str) -> Option<PickIdentity> {
    if kind != "cherry-pick" || active(&app.state::<Bridge>()).is_none() {
        return None;
    }
    identity(root).ok().flatten()
}

pub(crate) fn track(app: &AppHandle, id: &str, root: &Path) {
    let Some(session) = active(&app.state::<Bridge>()).filter(|session| id.starts_with(&session.id)) else { return };
    let Ok(Some(identity)) = identity(root) else { return };
    let mut picks = session.picks.lock();
    picks.iter_mut().filter(|pick| pick.root == root && pick.result.is_none()).for_each(|pick| {
        pick.result = Some(PickResult::Failed { reason: "operation_changed" });
    });
    if picks.len() == 50 {
        picks.pop_front();
    }
    picks.push_back(TrackedPick { id: id.to_owned(), root: root.to_owned(), identity, result: None });
}

pub(crate) fn finish(app: &AppHandle, root: &Path, previous: Option<PickIdentity>, cancel: Option<&'static str>) {
    let Some((session, identity)) = active(&app.state::<Bridge>()).zip(previous) else { return };
    let result = match cancel {
        Some(reason) => PickResult::Cancelled { reason },
        None => match repo::head(root).ok().and_then(|head| head.oid) {
            Some(sha) if identity.head.as_ref() != Some(&sha) => PickResult::Succeeded { sha },
            _ => PickResult::Failed { reason: "result_unverified" },
        },
    };
    let mut picks = session.picks.lock();
    if let Some(pick) = picks.iter_mut().rev().find(|pick| pick.root == root && pick.identity == identity && pick.result.is_none()) {
        pick.result = Some(result);
    }
}

#[tauri::command]
pub(crate) async fn mcp_cherry_pick_status(window: WebviewWindow, bridge: State<'_, Bridge>, repo: String, id: String) -> Result<Option<PickResult>, String> {
    let session = active(&bridge).filter(|session| window.label() == "main" && id.starts_with(&session.id)).ok_or("The MCP session ended.")?;
    let root = PathBuf::from(repo);
    crate::blocking(move || {
        operations::read(&root, || {
            let mut picks = session.picks.lock();
            let Some(pick) = picks.iter_mut().find(|pick| pick.id == id && pick.root == root) else {
                return Ok(Some(PickResult::Failed { reason: "result_unverified" }));
            };
            if pick.result.is_none() && identity(&root)?.as_ref() != Some(&pick.identity) {
                pick.result = Some(PickResult::Failed { reason: "operation_changed" });
            }
            Ok(pick.result.clone())
        })
    })
    .await
    .map_err(|error| error.message)
}
