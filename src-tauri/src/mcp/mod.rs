//! A stdio MCP process talks to the running desktop through a private local bridge.
mod protocol;
mod transport;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

pub use protocol::stdio;

const DISABLED: &str = "Open Revqora and turn on Settings → MCP for this session.";
const WORKERS: usize = 8;
type Reply = Result<Value, String>;

#[derive(Default)]
pub(crate) struct Bridge(Mutex<Option<Arc<Session>>>);

struct Session {
    id: String,
    key: transport::Secret,
    descriptor: PathBuf,
    stopped: AtomicBool,
    workers: AtomicUsize,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Reply>>>,
}

impl Session {
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.pending.lock().clear();
        let _ = std::fs::remove_file(&self.descriptor);
    }

    fn dispatch(&self, app: &AppHandle, request: protocol::ToolCall) -> Reply {
        let id = transport::random_id().map_err(|e| e.to_string())?;
        let (send, receive) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock();
            if self.stopped.load(Ordering::Acquire) {
                return Err(DISABLED.into());
            }
            pending.insert(id.clone(), send);
        }
        let result = app
            .emit_to("main", "mcp-request", &Event { id: &id, session: &self.id, request })
            .map_err(|_| "Revqora's main window is unavailable.".to_owned())
            .and_then(|_| {
                receive
                    .recv_timeout(Duration::from_secs(25))
                    .map_err(|_| "Revqora did not return a result. Check the desktop before retrying an action.".to_owned())
            })
            .and_then(|reply| reply);
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
            session.stop();
        }
    }
}

impl Bridge {
    pub(crate) fn shutdown(&self) {
        if let Some(session) = self.0.lock().take() {
            session.stop();
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
pub(crate) struct Info {
    enabled: bool,
    executable: String,
}

fn info(bridge: &Bridge) -> Result<Info, String> {
    let exe = crate::update::launch().ok_or("Could not locate the installed Revqora executable.")?.installed_exe();
    let executable = exe.to_str().ok_or("The executable path cannot be represented in an MCP configuration.")?;
    Ok(Info { enabled: bridge.0.lock().is_some(), executable: executable.to_owned() })
}

#[tauri::command]
pub(crate) fn mcp_info(bridge: State<'_, Bridge>) -> Result<Info, String> {
    info(&bridge)
}

#[tauri::command]
pub(crate) fn mcp_enable(app: AppHandle, window: WebviewWindow, bridge: State<'_, Bridge>, enabled: bool) -> Result<Info, String> {
    if window.label() != "main" {
        return Err("Manage MCP from the main Revqora window.".into());
    }
    let mut active = bridge.0.lock();
    if enabled && active.is_none() {
        let start = || -> io::Result<_> {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
            listener.set_nonblocking(true)?;
            let descriptor = transport::descriptor_path()?;
            let session = Arc::new(Session {
                id: transport::random_id()?,
                key: transport::secret()?,
                descriptor,
                stopped: AtomicBool::new(false),
                workers: AtomicUsize::new(0),
                pending: Mutex::new(HashMap::new()),
            });
            transport::publish(&session.descriptor, listener.local_addr()?.port(), &session.key)?;
            let thread_session = Arc::clone(&session);
            if let Err(error) = std::thread::Builder::new().name("revqora-mcp".into()).spawn(move || listen(listener, thread_session, app)) {
                session.stop();
                return Err(error);
            }
            Ok(session)
        };
        *active = Some(start().map_err(|e| format!("Could not start the local MCP bridge. {e}"))?);
    } else if !enabled {
        if let Some(session) = active.take() {
            session.stop();
        }
    }
    drop(active);
    info(&bridge)
}

#[tauri::command]
pub(crate) fn mcp_lease(window: WebviewWindow, bridge: State<'_, Bridge>, session: String, id: Option<String>) -> bool {
    window.label() == "main"
        && bridge.0.lock().as_ref().is_some_and(|active| active.id == session && id.as_ref().is_none_or(|id| active.pending.lock().contains_key(id)))
}

#[tauri::command]
pub(crate) fn mcp_reply(window: WebviewWindow, bridge: State<'_, Bridge>, session: String, id: String, value: Value, error: Option<String>) {
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
