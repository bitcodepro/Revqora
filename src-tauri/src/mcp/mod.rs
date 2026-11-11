//! A stdio MCP process talks to the running desktop through a private local bridge.
pub(crate) mod cherry_pick;
mod protocol;
mod transport;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

pub use protocol::stdio;

const DISABLED: &str = "Open Revqora and enable MCP under Settings → General → MCP.";
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(25);
const WORKERS: usize = 8;
type Reply = Result<Value, ToolError>;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub(crate) struct ToolError {
    code: String,
    message: String,
}

impl ToolError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    fn disabled() -> Self {
        Self::new("mcp_disabled", DISABLED)
    }

    fn desktop_closed() -> Self {
        Self::new("desktop_closed", "Revqora's desktop is closed. Open Revqora to reconnect to MCP.")
    }
}

#[derive(Default)]
pub(crate) struct Bridge(Mutex<Option<Arc<Session>>>, Mutex<ApprovalMode>);

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalMode {
    #[default]
    Ask,
    Full,
    DeleteOnly,
}

struct Session {
    id: String,
    key: transport::Secret,
    descriptor: PathBuf,
    stopped: AtomicBool,
    workers: AtomicUsize,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Reply>>>,
    picks: Mutex<VecDeque<cherry_pick::TrackedPick>>,
}

impl Session {
    fn stop(&self, reason: ToolError) {
        self.stopped.store(true, Ordering::Release);
        for (_, sender) in self.pending.lock().drain() {
            let _ = sender.try_send(Err(reason.clone()));
        }
        let _ = std::fs::remove_file(&self.descriptor);
    }

    fn dispatch(&self, app: &AppHandle, request: protocol::ToolCall) -> Reply {
        let id = transport::random_id().map_err(|e| ToolError::new("desktop_unavailable", e.to_string()))?;
        let (send, receive) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock();
            if self.stopped.load(Ordering::Acquire) {
                return Err(ToolError::disabled());
            }
            pending.insert(id.clone(), send);
        }
        let result = app
            .emit_to("main", "mcp-request", &Event { id: &id, session: &self.id, request })
            .map_err(|_| ToolError::new("desktop_unavailable", "Revqora's main window is unavailable."))
            .and_then(|_| match receive.recv_timeout(DISPATCH_TIMEOUT) {
                Ok(reply) => reply,
                Err(mpsc::RecvTimeoutError::Timeout) => Err(ToolError::new("request_timeout", "Revqora did not finish the MCP request in time.")),
                Err(mpsc::RecvTimeoutError::Disconnected) => Err(ToolError::disabled()),
            });
        self.pending.lock().remove(&id);
        result
    }
}

#[derive(Clone, Serialize)]
struct Event<'a> {
    id: &'a str,
    session: &'a str,
    request: protocol::ToolCall,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if let Some(session) = self.0.get_mut().take() {
            session.stop(ToolError::desktop_closed());
        }
    }
}

impl Bridge {
    pub(crate) fn shutdown(&self) {
        if let Some(session) = self.0.lock().take() {
            session.stop(ToolError::desktop_closed());
        }
    }
}

fn listen(listener: TcpListener, session: Arc<Session>, app: AppHandle) {
    while !session.stopped.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((socket, _)) if session.workers.fetch_add(1, Ordering::AcqRel) < WORKERS => {
                let session = Arc::clone(&session);
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = transport::serve(socket, &session.key, |request| {
                        let request = protocol::validate(request)?;
                        session.dispatch(&app, request)
                    });
                    session.workers.fetch_sub(1, Ordering::AcqRel);
                });
            }
            Ok(_) => {
                session.workers.fetch_sub(1, Ordering::AcqRel);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(35)),
            Err(_) => break,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    enabled: bool,
    executable: String,
    approval_mode: ApprovalMode,
}

fn info(bridge: &Bridge) -> Result<Info, String> {
    let exe = crate::update::launch().ok_or("Could not locate the installed Revqora executable.")?.installed_exe();
    let executable = exe.to_str().ok_or("The executable path cannot be represented in an MCP configuration.")?;
    Ok(Info { enabled: bridge.0.lock().is_some(), executable: executable.to_owned(), approval_mode: *bridge.1.lock() })
}

fn preference_path() -> Result<PathBuf, String> {
    crate::portable::runtime_dir().map(|dir| dir.join("mcp-enabled.json")).map_err(|error| format!("Could not access the saved MCP setting. {error}"))
}

fn saved_enabled(path: &Path) -> io::Result<bool> {
    saved_preference(path)
}

fn saved_preference<T: serde::de::DeserializeOwned + Default>(path: &Path) -> io::Result<T> {
    match File::open(path) {
        Ok(file) => Ok(serde_json::from_reader(file)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error),
    }
}

fn save_preference(path: &Path, value: impl Serialize) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("Missing portable data folder."))?;
    let mut file = crate::git::atomic_file::new_in(dir)?;
    serde_json::to_writer(&mut file, &value)?;
    file.as_file().sync_all()?;
    crate::git::atomic_file::replace(file, path)
}

fn start(app: AppHandle) -> io::Result<Arc<Session>> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let session = Arc::new(Session {
        id: transport::random_id()?,
        key: transport::secret()?,
        descriptor: transport::descriptor_path()?,
        stopped: AtomicBool::new(false),
        workers: AtomicUsize::new(0),
        pending: Mutex::new(HashMap::new()),
        picks: Mutex::new(VecDeque::new()),
    });
    transport::publish(&session.descriptor, listener.local_addr()?.port(), &session.key)?;
    let thread_session = Arc::clone(&session);
    if let Err(error) = std::thread::Builder::new().name("revqora-mcp".into()).spawn(move || listen(listener, thread_session, app)) {
        session.stop(ToolError::desktop_closed());
        return Err(error);
    }
    Ok(session)
}

fn start_error(error: io::Error) -> String {
    format!("Could not start the local MCP bridge. {error}")
}

#[tauri::command]
pub(crate) fn mcp_info(bridge: State<'_, Bridge>) -> Result<Info, String> {
    info(&bridge)
}

#[tauri::command]
pub(crate) fn mcp_restore(app: AppHandle, window: WebviewWindow, bridge: State<'_, Bridge>) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Manage MCP from the main Revqora window.".into());
    }
    let mut active = bridge.0.lock();
    let path = preference_path()?;
    if active.is_none() {
        *bridge.1.lock() = saved_preference(&path.with_file_name("mcp-approval.json")).unwrap_or_default();
        if saved_enabled(&path).map_err(|error| format!("Could not read the saved MCP setting. {error}"))? {
            *active = Some(start(app).map_err(start_error)?);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn mcp_enable(app: AppHandle, window: WebviewWindow, bridge: State<'_, Bridge>, enabled: bool) -> Result<Info, String> {
    if window.label() != "main" {
        return Err("Manage MCP from the main Revqora window.".into());
    }
    let mut active = bridge.0.lock();
    let path = preference_path()?;
    let started = if enabled && active.is_none() { Some(start(app).map_err(start_error)?) } else { None };
    if let Err(error) = save_preference(&path, enabled) {
        if let Some(session) = started {
            session.stop(ToolError::disabled());
        }
        return Err(format!("Could not save the MCP setting. {error}"));
    }
    if let Some(session) = started {
        *active = Some(session);
    } else if !enabled {
        if let Some(session) = active.take() {
            session.stop(ToolError::disabled());
        }
    }
    drop(active);
    info(&bridge)
}

#[tauri::command]
pub(crate) fn mcp_set_approval_mode(window: WebviewWindow, bridge: State<'_, Bridge>, approval_mode: ApprovalMode) -> Result<Info, String> {
    if window.label() != "main" {
        return Err("Manage MCP from the main Revqora window.".into());
    }
    {
        let mut mode = bridge.1.lock();
        save_preference(&preference_path()?.with_file_name("mcp-approval.json"), approval_mode)
            .map_err(|error| format!("Could not save the MCP approval mode. {error}"))?;
        *mode = approval_mode;
    }
    info(&bridge)
}

#[tauri::command]
pub(crate) fn mcp_lease(window: WebviewWindow, bridge: State<'_, Bridge>, session: String, id: Option<String>) -> bool {
    window.label() == "main"
        && bridge.0.lock().as_ref().is_some_and(|active| active.id == session && id.as_ref().is_none_or(|id| active.pending.lock().contains_key(id)))
}

#[tauri::command]
pub(crate) fn mcp_reply(window: WebviewWindow, bridge: State<'_, Bridge>, session: String, id: String, value: Value, error: Option<ToolError>) {
    if window.label() != "main" {
        return;
    }
    let active = bridge.0.lock();
    if let Some(active) = active.as_ref().filter(|active| active.id == session) {
        if let Some(sender) = active.pending.lock().remove(&id) {
            let _ = sender.try_send(error.map_or(Ok(value), Err));
        }
    }
}
