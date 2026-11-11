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

/// Only isolated Windows automation launches write these fixed startup stages.
/// Keep the evidence outside WebView's files so a failed browser launch is visible.
pub fn automation_startup(stage: &str) {
    #[cfg(all(windows, feature = "ui-automation"))]
    {
        use std::io::Write;
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        if std::env::var("REVQORA_MULTI_INSTANCE").as_deref() != Ok("1") {
            return;
        }
        let Some(profile) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").map(PathBuf::from) else { return };
        let _ = fs::create_dir_all(&profile);
        let path = profile.join("revqora-startup.jsonl");
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let event =
                serde_json::json!({"pid":std::process::id(),"stage":stage,"elapsedMs":START.get_or_init(std::time::Instant::now).elapsed().as_millis()});
            let _ = writeln!(file, "{event}");
        }
    }
    #[cfg(not(all(windows, feature = "ui-automation")))]
    let _ = stage;
}

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
    if std::env::var_os("REVQORA_MULTI_INSTANCE").is_some() {
        if let Some(dir) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
            return Some(PathBuf::from(dir));
        }
    }
    data_dir().map(|d| d.join("webview"))
}

/// Runtime files have one portable root; automation uses its explicitly isolated profile.
/// Unit-test executables have a separate directory and cannot touch the app's profile.
pub fn runtime_dir() -> std::io::Result<PathBuf> {
    let mut root =
        if std::env::var_os("REVQORA_MULTI_INSTANCE").is_some() { webview_dir().map(|p| p.join("revqora-data")) } else { data_dir().map(Path::to_path_buf) }
            .ok_or_else(|| std::io::Error::other("Cannot locate the portable data folder beside Revqora."))?;
    if cfg!(test) {
        root = root.join(format!("tests-{}", std::process::id()));
    }
    std::fs::create_dir_all(&root)?;
    Ok(root)
}

pub fn temp_dir() -> std::io::Result<PathBuf> {
    let dir = runtime_dir()?.join("temp");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Called before Tauri starts worker threads. Child processes (including WebView)
/// use the portable temporary folder rather than the user's system temp directory.
pub fn configure_environment() -> std::io::Result<()> {
    let temp = temp_dir()?;
    if let Some(profile) = webview_dir() {
        // WebView2 environment variables take precedence over builder options.
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", profile);
    }
    for key in ["TEMP", "TMP", "TMPDIR"] {
        std::env::set_var(key, &temp);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Bounds {
    fn new(position: tauri::PhysicalPosition<i32>, size: tauri::PhysicalSize<u32>) -> Self {
        Self { x: position.x, y: position.y, width: size.width, height: size.height }
    }

    /// Fit the client size and its native frame into this physical work area.
    fn place(self, size: tauri::PhysicalSize<u32>, frame: tauri::PhysicalSize<u32>, position: Option<tauri::PhysicalPosition<i32>>) -> Self {
        fn axis(start: i32, available: u32, size: u32, frame: u32, position: Option<i32>) -> (i32, u32) {
            let size = size.clamp(1, available.saturating_sub(frame).max(1));
            let space = available.saturating_sub(size.saturating_add(frame));
            let start = i64::from(start);
            let pos = position.map_or(start + i64::from(space / 2), |pos| i64::from(pos).clamp(start, start + i64::from(space)));
            (i32::try_from(pos).unwrap_or(i32::MAX), size)
        }

        let (x, width) = axis(self.x, self.width, size.width, frame.width, position.map(|p| p.x));
        let (y, height) = axis(self.y, self.height, size.height, frame.height, position.map(|p| p.y));
        Self { x, y, width, height }
    }

    fn position(self) -> tauri::PhysicalPosition<i32> {
        tauri::PhysicalPosition::new(self.x, self.y)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Display {
    name: Option<String>,
    bounds: Bounds,
    work_area: Bounds,
    scale: f64,
}

impl From<tauri::Monitor> for Display {
    fn from(monitor: tauri::Monitor) -> Self {
        let bounds = Bounds::new(*monitor.position(), *monitor.size());
        let area = monitor.work_area();
        let work_area = if area.size.width > 0 && area.size.height > 0 { Bounds::new(area.position, area.size) } else { bounds };
        Self { name: monitor.name().cloned(), bounds, work_area, scale: monitor.scale_factor() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct WindowState {
    display: Display,
    displays: Vec<Display>,
    normal: Option<Bounds>,
}

impl WindowState {
    fn can_restore(&self, displays: &[Display]) -> bool {
        displays.contains(&self.display)
            && displays.len() == self.displays.len()
            && displays.iter().all(|display| self.displays.contains(display))
            && self.displays.iter().all(|display| displays.contains(display))
    }
}

fn load_window_state(dir: &Path) -> Option<WindowState> {
    // Legacy files lack the monitor information needed to trust physical bounds.
    serde_json::from_slice(&fs::read(dir.join(WINDOW_FILE)).ok()?).ok()
}

fn save_window_state(dir: &Path, state: &WindowState) {
    if let Ok(json) = serde_json::to_vec_pretty(state) {
        let _ = fs::write(dir.join(WINDOW_FILE), json);
    }
}

/// Prepare the hidden window on the intended monitor before Windows maximizes it.
pub fn restore_window_bounds(window: &tauri::WebviewWindow) {
    let displays = window.available_monitors().unwrap_or_default().into_iter().map(Display::from).collect::<Vec<_>>();
    let saved = data_dir().and_then(load_window_state).filter(|state| state.can_restore(&displays));
    let display = saved.as_ref().map(|state| state.display.clone()).or_else(|| {
        window
            .cursor_position()
            .ok()
            .and_then(|point| window.monitor_from_point(point.x, point.y).ok().flatten())
            .or_else(|| window.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten())
            .map(Display::from)
    });
    let (Some(display), Ok(inner), Ok(outer)) = (display, window.inner_size(), window.outer_size()) else {
        return;
    };
    let scale = display.scale / window.scale_factor().unwrap_or(display.scale);
    let scaled = |pixels: u32| (f64::from(pixels) * scale).round() as u32;
    let frame = tauri::PhysicalSize::new(scaled(outer.width.saturating_sub(inner.width)), scaled(outer.height.saturating_sub(inner.height)));
    let normal = saved.and_then(|state| state.normal).filter(|bounds| bounds.width >= 400 && bounds.height >= 300);
    let size = normal
        .map_or_else(|| tauri::PhysicalSize::new(scaled(inner.width), scaled(inner.height)), |bounds| tauri::PhysicalSize::new(bounds.width, bounds.height));
    let bounds = display.work_area.place(size, frame, normal.map(Bounds::position));
    // Move first so any per-monitor DPI change is applied before setting the
    // final physical size. Reapply the position after Windows adjusts the frame.
    let _ = window.set_position(bounds.position());
    let sized = window.set_size(tauri::PhysicalSize::new(bounds.width, bounds.height)).is_ok();
    if window.set_position(bounds.position()).is_ok() && sized {
        *NORMAL.lock() = Some((display, bounds));
    }
}

/// The monitor and normal placement that belong together.
static NORMAL: parking_lot::Mutex<Option<(Display, Bounds)>> = parking_lot::Mutex::new(None);

fn normal_bounds(window: &tauri::Window) -> Option<Bounds> {
    Some(Bounds::new(window.outer_position().ok()?, window.inner_size().ok()?))
}

/// Record the normal geometry for the Restore button.
pub fn track_window(window: &tauri::Window) {
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    if let (Ok(Some(monitor)), Some(bounds)) = (window.current_monitor(), normal_bounds(window)) {
        *NORMAL.lock() = Some((monitor.into(), bounds));
    }
}

fn closing_bounds(display: &Display, tracked: Option<&(Display, Bounds)>, current: Option<Bounds>) -> Option<Bounds> {
    current.or_else(|| tracked.filter(|(tracked_display, _)| tracked_display == display).map(|(_, bounds)| *bounds))
}

/// Saves the geometry on close.
pub fn remember_window(window: &tauri::Window) {
    let Some(dir) = data_dir() else { return };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(Some(monitor)), Ok(monitors)) = (window.current_monitor(), window.available_monitors()) else {
        return;
    };
    let display = Display::from(monitor);
    let displays = monitors.into_iter().map(Display::from).collect();
    let current = if window.is_maximized().unwrap_or(false) { None } else { normal_bounds(window) };
    let normal = closing_bounds(&display, NORMAL.lock().as_ref(), current);
    save_window_state(dir, &WindowState { display, displays, normal });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn laptop() -> Display {
        let bounds = Bounds { x: 0, y: 0, width: 1920, height: 1080 };
        Display { name: Some("Laptop".into()), bounds, work_area: Bounds { height: 1040, ..bounds }, scale: 1.25 }
    }

    fn external() -> Display {
        let bounds = Bounds { x: -2560, y: -360, width: 2560, height: 1440 };
        Display { name: Some("External".into()), bounds, work_area: Bounds { height: 1400, ..bounds }, scale: 1.0 }
    }

    #[test]
    fn attaching_disconnecting_or_reconfiguring_a_display_invalidates_saved_bounds() {
        let laptop = laptop();
        let external = external();
        let state = WindowState { display: laptop.clone(), displays: vec![laptop.clone()], normal: None };
        assert!(state.can_restore(std::slice::from_ref(&laptop)));
        assert!(!state.can_restore(&[laptop.clone(), external.clone()]));
        let state = WindowState { displays: vec![laptop.clone(), external.clone()], ..state };
        assert!(state.can_restore(&[external.clone(), laptop.clone()]));
        assert!(!state.can_restore(std::slice::from_ref(&laptop)));
        assert!(!state.can_restore(&[laptop.clone(), Display { scale: 1.5, ..external.clone() }]));
        assert!(!state.can_restore(&[laptop, Display { work_area: Bounds { height: 1440, ..external.work_area }, ..external }]));
    }

    #[test]
    fn maximized_close_uses_only_normal_bounds_for_the_same_display() {
        let laptop = laptop();
        let external = external();
        let opened = Bounds { x: 50, y: 40, width: 1200, height: 800 };
        let resized = Bounds { x: 80, y: 60, width: 1400, height: 900 };
        let tracked = (laptop.clone(), opened);
        assert_eq!(closing_bounds(&laptop, Some(&tracked), None), Some(opened));
        assert_eq!(closing_bounds(&laptop, Some(&tracked), Some(resized)), Some(resized));
        assert_eq!(closing_bounds(&external, Some(&tracked), None), None);
    }

    #[test]
    fn normal_bounds_are_centered_or_clamped_to_the_monitor_work_area() {
        let external = external();
        let frame = tauri::PhysicalSize::new(16, 40);
        let size = tauri::PhysicalSize::new(1200, 800);
        assert_eq!(external.work_area.place(size, frame, None), Bounds { x: -1888, y: -80, width: 1200, height: 800 });
        assert_eq!(
            external.work_area.place(size, frame, Some(tauri::PhysicalPosition::new(200, -900))),
            Bounds { x: -1216, y: -360, width: 1200, height: 800 }
        );
        assert_eq!(external.work_area.place(tauri::PhysicalSize::new(3000, 2000), frame, None), Bounds { x: -2560, y: -360, width: 2544, height: 1360 });
    }

    #[test]
    fn window_state_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let s = WindowState { display: laptop(), displays: vec![laptop(), external()], normal: Some(Bounds { x: 10, y: 20, width: 1200, height: 800 }) };
        save_window_state(tmp.path(), &s);
        assert_eq!(load_window_state(tmp.path()), Some(s));
        fs::write(tmp.path().join(WINDOW_FILE), r#"{"x":10,"y":20,"width":1200,"height":800,"maximized":true}"#).unwrap();
        assert_eq!(load_window_state(tmp.path()), None);
    }
}
