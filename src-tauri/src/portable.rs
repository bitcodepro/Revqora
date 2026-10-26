//! Portable data: settings, history of opened repositories (WebView2 local storage) and the
//! window geometry live only in a `data` folder next to the executable. Nothing is read from or
//! written to per-user locations (%APPDATA%, %LOCALAPPDATA%), and updates (which replace only
//! the package's own files) keep the folder.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub const DATA_DIR: &str = "data";
const WINDOW_FILE: &str = "window.json";

static DATA: OnceLock<Option<PathBuf>> = OnceLock::new();

/// `<install root>/data` (created on first use). `None` only if the app folder is unknown.
pub fn data_dir() -> Option<&'static Path> {
    DATA.get_or_init(|| {
        let dir = crate::update::launch()?.root.join(DATA_DIR);
        let _ = fs::create_dir_all(&dir);
        Some(dir)
    })
    .as_deref()
}

/// The web view's profile folder: `data/webview`, or the throwaway profile tests pass in
/// `WEBVIEW2_USER_DATA_FOLDER`.
pub fn webview_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        return Some(PathBuf::from(dir));
    }
    data_dir().map(|d| d.join("webview"))
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

pub fn load_window_state(dir: &Path) -> Option<WindowState> {
    serde_json::from_slice(&fs::read(dir.join(WINDOW_FILE)).ok()?).ok()
}

pub fn save_window_state(dir: &Path, state: &WindowState) {
    if let Ok(json) = serde_json::to_vec_pretty(state) {
        let _ = fs::write(dir.join(WINDOW_FILE), json);
    }
}

/// Restores the saved geometry, or opens maximized the first time.
pub fn restore_window(window: &tauri::WebviewWindow) {
    let saved = data_dir().and_then(load_window_state);
    let Some(s) = saved.filter(|s| s.width >= 400 && s.height >= 300) else {
        let _ = window.maximize();
        return;
    };
    let _ = window.set_size(tauri::PhysicalSize::new(s.width, s.height));
    // Only reuse the position while some monitor still shows the window's top-left area.
    let visible = window.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, z) = (m.position(), m.size());
        s.x + 40 >= p.x && s.y + 10 >= p.y && s.x + 40 < p.x + z.width as i32 && s.y + 10 < p.y + z.height as i32
    });
    if visible {
        let _ = window.set_position(tauri::PhysicalPosition::new(s.x, s.y));
    } else {
        let _ = window.center();
    }
    if s.maximized {
        let _ = window.maximize();
    }
}

/// The last normal (not maximized, not minimized) placement seen while the app runs.
static NORMAL: parking_lot::Mutex<Option<WindowState>> = parking_lot::Mutex::new(None);

/// Records the current placement whenever the window is moved or resized in normal state, so a
/// window that is maximized and then closed still reopens (unmaximized) where it last was.
pub fn track_window(window: &tauri::Window) {
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
        *NORMAL.lock() = Some(WindowState { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false });
    }
}

/// What to save on close: the latest normal placement plus whether the window is maximized.
/// Falls back to the current placement (normal state) or the saved one (nothing tracked yet).
pub fn closing_state(tracked: Option<WindowState>, saved: Option<WindowState>, current: Option<WindowState>, maximized: bool) -> Option<WindowState> {
    let normal = if maximized { tracked.or(saved) } else { current.or(tracked) };
    normal.map(|n| WindowState { maximized, ..n })
}

/// Saves the geometry on close.
pub fn remember_window(window: &tauri::Window) {
    let Some(dir) = data_dir() else { return };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let current = match (window.outer_position(), window.inner_size()) {
        (Ok(p), Ok(z)) if !maximized => Some(WindowState { x: p.x, y: p.y, width: z.width, height: z.height, maximized: false }),
        _ => None,
    };
    if let Some(state) = closing_state(*NORMAL.lock(), load_window_state(dir), current, maximized) {
        save_window_state(dir, &state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maximized_close_keeps_the_latest_normal_placement() {
        let opened = WindowState { x: 50, y: 40, width: 1200, height: 800, maximized: false };
        let resized = WindowState { x: 80, y: 60, width: 1400, height: 900, maximized: false };
        // Reopened at 1200x800, moved/resized to 1400x900 (tracked), maximized, closed.
        let state = closing_state(Some(resized), Some(opened), None, true).unwrap();
        assert_eq!(state, WindowState { maximized: true, ..resized });
        // Closed in normal state: the current placement wins.
        assert_eq!(closing_state(Some(opened), None, Some(resized), false), Some(resized));
        // Maximized before anything was tracked: the saved placement is kept.
        assert_eq!(closing_state(None, Some(opened), None, true), Some(WindowState { maximized: true, ..opened }));
    }

    #[test]
    fn window_state_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let s = WindowState { x: 10, y: 20, width: 1200, height: 800, maximized: false };
        save_window_state(tmp.path(), &s);
        assert_eq!(load_window_state(tmp.path()), Some(s));
    }
}
