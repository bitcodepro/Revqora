use super::*;
use std::io;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_SYNCHRONIZE};
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

const WORKER: &str = "updater.exe";

#[derive(serde::Deserialize, Serialize)]
pub(super) struct Pending {
    pub version: String,
    pub checksum: String,
}

struct DesktopProcess(HANDLE);
impl Drop for DesktopProcess {
    fn drop(&mut self) {
        // SAFETY: OpenProcess returned this owned handle.
        unsafe { CloseHandle(self.0) };
    }
}

pub(super) fn launch_worker(current: &Launch) -> GitResult<()> {
    let _lease = UpdateLease::acquire(&current.root)?;
    let worker = current.root.join(STAGING).join(WORKER);
    fs::copy(current.installed_exe(), &worker).map_err(|error| update_io("Copy the update helper", &worker, error))?;
    let mut child = Command::new(&worker)
        .arg("--apply-prepared-update")
        .arg(std::process::id().to_string())
        .args(std::env::args_os().skip(1))
        .current_dir(&current.root)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| update_io("Start the update helper", &worker, error))?;
    let mut stdout = child.stdout.take().expect("helper handshake pipe");
    let (send, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = [0];
        let _ = send.send(stdout.read_exact(&mut ready).is_ok() && ready == [1]);
    });
    if received.recv_timeout(Duration::from_secs(8)) != Ok(true) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(GitError::new("The update helper could not connect to Revqora. The downloaded package is kept.").kind("update-install"));
    }
    Ok(())
}

fn pending_at(root: &Path) -> GitResult<Pending> {
    let marker = root.join(STAGING).join(PENDING);
    let pending: Pending = serde_json::from_reader(fs::File::open(&marker).map_err(|error| update_io("Open prepared update", &marker, error))?.take(4096))
        .map_err(|error| GitError::new(format!("Could not read prepared update: {error}")).kind("update-install"))?;
    if !pending.version.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.')
        || parse_version(&pending.version).is_none()
        || parse_checksum(&pending.checksum).as_deref() != Some(&pending.checksum)
    {
        return Err(GitError::new("Invalid prepared update. Download the release again.").kind("update-install"));
    }
    Ok(pending)
}

fn apply(root: &Path, args: &[std::ffi::OsString]) -> GitResult<()> {
    let _lease = UpdateLease::acquire(root)?;
    let pending = pending_at(root)?;
    let rid = rid().ok_or_else(|| GitError::new("Unsupported platform."))?;
    let manifest = root.join("build-info.json");
    let installed: serde_json::Value =
        serde_json::from_reader(fs::File::open(&manifest).map_err(|error| update_io("Read installed version", &manifest, error))?)
            .map_err(|error| GitError::new(format!("Could not read installed version: {error}")))?;
    if installed["rid"].as_str() != Some(rid) || !installed["version"].as_str().is_some_and(|version| is_newer(&pending.version, version)) {
        return Err(GitError::new("The prepared update no longer matches this installation.").kind("update-install"));
    }
    let staging = root.join(STAGING);
    let archive = staging.join(archive_name(&pending.version, rid));
    if archive_digest(&archive)? != pending.checksum {
        return Err(GitError::new("The prepared download changed. Download the release again.").kind("update-checksum"));
    }
    let new = extract_checked(root, &archive, &pending.version, rid)?;
    apply_extracted(root, &new, || restart_desktop(root, args))?;
    let _ = fs::remove_file(staging.join(PENDING));
    let _ = fs::remove_file(archive);
    Ok(())
}

pub fn run_worker() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--apply-prepared-update")) {
        return None;
    }
    let Some(pid) = args.next().and_then(|pid| pid.to_str()?.parse::<u32>().ok()) else { return Some(1) };
    let Some(exe) = std::env::current_exe().ok() else { return Some(1) };
    let Some(staging) = exe.parent() else { return Some(1) };
    let Some(root) = staging.parent() else { return Some(1) };
    if exe.file_name().and_then(|name| name.to_str()) != Some(WORKER) || staging.file_name().and_then(|name| name.to_str()) != Some(STAGING) {
        return Some(1);
    }
    // SAFETY: Only SYNCHRONIZE access is requested. Keeping the handle pins the process
    // identity across shutdown, even if Windows subsequently recycles its PID.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        let _ = crate::error_log::record_at(&root.join(crate::portable::DATA_DIR), "updater.wait", "update-install", &error.to_string());
        return Some(1);
    }
    let desktop = DesktopProcess(handle);
    if io::stdout().write_all(&[1]).and_then(|_| io::stdout().flush()).is_err() {
        return Some(1);
    }
    // SAFETY: desktop owns the process handle for the whole wait.
    match unsafe { WaitForSingleObject(desktop.0, 60_000) } {
        WAIT_OBJECT_0 => {}
        WAIT_TIMEOUT => {
            show_error(root, "Revqora did not close within 60 seconds. The downloaded update is kept. Close Revqora and try again.");
            return Some(1);
        }
        _ => {
            show_error(root, &format!("Could not wait for Revqora to close: {}", io::Error::last_os_error()));
            return Some(1);
        }
    }
    let args: Vec<_> = args.collect();
    if let Err(error) = apply(root, &args) {
        show_error(root, &error.message);
        if !staging.join("rollback-incomplete").exists() {
            if let Err(restart) = restart_desktop(root, &args) {
                show_error(root, &format!("Could not reopen Revqora at {} ({restart}).", root.display()));
            }
        }
        return Some(1);
    }
    Some(0)
}

fn restart_desktop(root: &Path, args: &[std::ffi::OsString]) -> io::Result<()> {
    Command::new(root.join("revqora.exe")).args(args).env("REVQORA_RESTART_AFTER", std::process::id().to_string()).current_dir(root).spawn().map(|_| ())
}

fn show_error(root: &Path, message: &str) {
    let _ = crate::error_log::record_at(&root.join(crate::portable::DATA_DIR), "updater", "update-install", message);
    let title: Vec<_> = "Revqora update".encode_utf16().chain(Some(0)).collect();
    let text: Vec<_> = message.encode_utf16().chain(Some(0)).collect();
    // SAFETY: both buffers are terminated UTF-16 and live for the duration of the call.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}
