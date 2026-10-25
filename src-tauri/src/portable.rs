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

/// Saves the geometry; while maximized the last normal size and position are kept.
pub fn remember_window(window: &tauri::Window) {
    let Some(dir) = data_dir() else { return };
    let maximized = window.is_maximized().unwrap_or(false);
    let previous = load_window_state(dir);
    let state = match (maximized, previous) {
        (true, Some(p)) => WindowState { maximized: true, ..p },
        _ => {
            let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else { return };
            if window.is_minimized().unwrap_or(false) {
                return;
            }
            WindowState { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized }
        }
    };
    save_window_state(dir, &state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_state_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let s = WindowState { x: 10, y: 20, width: 1200, height: 800, maximized: false };
        save_window_state(tmp.path(), &s);
        assert_eq!(load_window_state(tmp.path()), Some(s));
    }
}
