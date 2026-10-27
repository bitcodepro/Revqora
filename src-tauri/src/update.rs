//! Self-update for the portable packages published on GitHub Releases.
//!
//! The check asks the GitHub API for the latest stable release and picks the archive for this
//! platform. Installing downloads it next to the app, verifies the published SHA-256 and the
//! embedded `build-info.json`, then swaps the top-level entries (exe or `Revqora.app`, README,
//! licenses, …) in place. The replaced files are kept in `.revqora-update/old` until the next
//! start, so a failed swap rolls back and a running exe can be renamed on every platform.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::git::runner::{GitError, GitResult};

pub const REPO: &str = "bitcodepro/Revqora";
const STAGING: &str = ".revqora-update";
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub notes: String,
    pub published_at: Option<String>,
    pub html_url: String,
    pub asset: Option<Asset>,
    /// The running copy can replace itself (a portable package in a writable folder).
    pub can_install: bool,
    /// Why it cannot, shown next to the download button.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub checksum_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub downloaded: u64,
    pub total: u64,
}

/// Release identifier of this build, matching `scripts/release.py`.
pub fn rid() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("win-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("linux-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("linux-arm64")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("osx-arm64")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("osx-x64")
    } else {
        None
    }
}

pub fn archive_name(version: &str, rid: &str) -> String {
    let ext = if rid.starts_with("linux-") { "tar.gz" } else { "zip" };
    format!("Revqora-{version}-{rid}.{ext}")
}

type Version = (u64, u64, u64, Option<String>);

pub fn parse_version(text: &str) -> Option<Version> {
    let v = text.trim().trim_start_matches('v');
    let v = v.split('+').next()?;
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (v, None),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??, pre);
    parts.next().is_none().then_some(version)
}

/// `latest` is a newer version than `current` (a release beats its own prereleases).
pub fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(l), Some(c)) = (parse_version(latest), parse_version(current)) else { return false };
    match (l.0, l.1, l.2).cmp(&(c.0, c.1, c.2)) {
        std::cmp::Ordering::Equal => match (&l.3, &c.3) {
            (None, Some(_)) => true,
            (Some(a), Some(b)) => a > b,
            _ => false,
        },
        o => o.is_gt(),
    }
}

/// Folder holding the package's top-level entries (the one with `build-info.json`).
pub fn install_root(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    if cfg!(target_os = "macos") {
        // Revqora.app/Contents/MacOS/revqora
        let app = dir.parent()?.parent()?;
        if app.extension().is_some_and(|e| e == "app") {
            return app.parent().map(Path::to_path_buf);
        }
    }
    Some(dir.to_path_buf())
}

/// Where this process was started from: the install root and the executable relative to it.
/// Captured once at startup, because after an update swaps the files `current_exe()` can point
/// at the moved-away old binary (Linux resolves it through `/proc/self/exe`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub root: PathBuf,
    pub exe: PathBuf,
}

impl Launch {
    pub fn from_exe(exe: &Path) -> Option<Launch> {
        let root = install_root(exe)?;
        let rel = exe.strip_prefix(&root).ok()?.to_path_buf();
        Some(Launch { root, exe: rel })
    }
    /// The executable at the stable install location (the new one after an update).
    pub fn installed_exe(&self) -> PathBuf {
        self.root.join(&self.exe)
    }
}

static LAUNCH: OnceLock<Option<Launch>> = OnceLock::new();

/// Records the launch location; call first thing in `main`, before any update can run.
pub fn launch() -> Option<&'static Launch> {
    LAUNCH.get_or_init(|| std::env::current_exe().ok().and_then(|e| Launch::from_exe(&e))).as_ref()
}

/// Whether this copy may replace itself; `Err` carries the reason shown to the user.
pub fn installable(root: &Path) -> Result<(), String> {
    if !root.join("build-info.json").is_file() {
        return Err("This copy was not installed from a release package.".into());
    }
    let probe = root.join(".revqora-write-test");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(_) => Err("The app folder is read-only. Download the new version instead.".into()),
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(30)).user_agent("Revqora-updater").build()
}

fn net_err(e: ureq::Error) -> GitError {
    match e {
        ureq::Error::Status(403 | 429, _) => GitError::new("GitHub rate limit reached; try again later.").kind("update-network"),
        ureq::Error::Status(code, _) => GitError::new(format!("GitHub answered HTTP {code}.")).kind("update-network"),
        ureq::Error::Transport(t) => GitError::new(format!("Could not reach GitHub: {t}")).kind("update-network"),
    }
}

/// Only release downloads of this repository are fetched.
fn trusted_url(url: &str) -> bool {
    url.starts_with(&format!("https://github.com/{REPO}/releases/download/"))
}

/// Builds the result from a `releases/latest` API response.
pub fn parse_release(json: &serde_json::Value, current: &str, rid: Option<&str>) -> GitResult<UpdateInfo> {
    let tag = json["tag_name"].as_str().ok_or_else(|| GitError::new("Release has no tag.").kind("update-network"))?;
    let latest = tag.trim_start_matches('v').to_string();
    let assets = json["assets"].as_array().cloned().unwrap_or_default();
    let find = |name: &str| assets.iter().find(|a| a["name"].as_str() == Some(name));
    let asset = rid.and_then(|rid| {
        let name = archive_name(&latest, rid);
        let a = find(&name)?;
        let url = a["browser_download_url"].as_str()?.to_string();
        trusted_url(&url).then(|| Asset {
            size: a["size"].as_u64().unwrap_or(0),
            checksum_url: find(&format!("{name}.sha256")).and_then(|c| c["browser_download_url"].as_str()).filter(|u| trusted_url(u)).map(String::from),
            name,
            url,
        })
    });
    Ok(UpdateInfo {
        available: is_newer(&latest, current),
        current: current.to_string(),
        latest,
        notes: json["body"].as_str().unwrap_or_default().trim().to_string(),
        published_at: json["published_at"].as_str().map(String::from),
        html_url: json["html_url"].as_str().map(String::from).unwrap_or_else(|| format!("https://github.com/{REPO}/releases/latest")),
        asset,
        can_install: false,
        reason: None,
    })
}

/// Release feed; tests may point it at a local server (downloads stay limited to GitHub).
fn feed_url() -> String {
    match std::env::var("REVQORA_UPDATE_FEED") {
        Ok(url) if url.starts_with("http://127.0.0.1:") => url,
        _ => format!("https://api.github.com/repos/{REPO}/releases/latest"),
    }
}

pub fn check(current: &str) -> GitResult<UpdateInfo> {
    let url = feed_url();
    let json: serde_json::Value = agent()
        .get(&url)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(net_err)?
        .into_json()
        .map_err(|e| GitError::new(format!("Bad release data: {e}")))?;
    let mut info = parse_release(&json, current, rid())?;
    let state = match (&info.asset, launch().map(|l| l.root.clone())) {
        (None, _) => Err("No package for this platform in the release.".to_string()),
        (Some(a), _) if a.checksum_url.is_none() => Err("The release has no checksum for this package.".to_string()),
        (_, None) => Err("Could not find the app folder.".to_string()),
        (_, Some(root)) => installable(&root),
    };
    info.can_install = state.is_ok();
    info.reason = state.err();
    Ok(info)
}

/// Downloads, verifies and installs `info`'s package over the running copy.
pub fn install(info: &UpdateInfo, mut progress: impl FnMut(Progress)) -> GitResult<()> {
    let asset = info.asset.as_ref().ok_or_else(|| GitError::new("No package for this platform."))?;
    let checksum_url = asset.checksum_url.as_deref().ok_or_else(|| GitError::new("The release has no checksum."))?;
    let rid = rid().ok_or_else(|| GitError::new("Unsupported platform."))?;
    if !trusted_url(&asset.url) || !trusted_url(checksum_url) {
        return Err(GitError::new("Unexpected download location."));
    }
    let root = launch().map(|l| l.root.clone()).ok_or_else(|| GitError::new("Could not find the app folder."))?;
    installable(&root).map_err(|r| GitError::new(r).kind("update-readonly"))?;

    let staging = root.join(STAGING);
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    let expected = agent().get(checksum_url).call().map_err(net_err)?.into_string().map_err(|e| GitError::new(e.to_string()))?;
    let expected = parse_checksum(&expected).ok_or_else(|| GitError::new("Malformed checksum file."))?;

    let archive = staging.join(&asset.name);
    let resp = agent().get(&asset.url).call().map_err(net_err)?;
    let total = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(asset.size);
    if total > MAX_ARCHIVE {
        return Err(GitError::new("The package is unexpectedly large."));
    }
    let mut reader = resp.into_reader().take(MAX_ARCHIVE + 1);
    let mut file = fs::File::create(&archive)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut downloaded, mut reported) = (0u64, 0u64);
    progress(Progress { downloaded: 0, total });
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])?;
        downloaded += n as u64;
        if downloaded > MAX_ARCHIVE {
            return Err(GitError::new("The package is unexpectedly large."));
        }
        if downloaded - reported >= 256 * 1024 {
            reported = downloaded;
            progress(Progress { downloaded, total });
        }
    }
    file.sync_all()?;
    drop(file);
    progress(Progress { downloaded, total: total.max(downloaded) });
    let actual = hex(&hasher.finalize());
    if actual != expected {
        let _ = fs::remove_dir_all(&staging);
        return Err(GitError::new("The download is corrupted (checksum mismatch).").kind("update-checksum"));
    }
    apply_archive(&root, &archive, &info.latest, rid)
}

pub fn parse_checksum(text: &str) -> Option<String> {
    let token = text.split_whitespace().next()?.to_ascii_lowercase();
    (token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit())).then_some(token)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A relative path with only normal components (no `..`, roots or drive prefixes).
fn safe_relative(path: &Path) -> bool {
    path.components().all(|c| matches!(c, Component::Normal(_))) && path.components().next().is_some()
}

fn extract(archive: &Path, dest: &Path) -> GitResult<()> {
    let name = archive.to_string_lossy();
    fs::create_dir_all(dest)?;
    if name.ends_with(".tar.gz") {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(archive)?));
        for entry in tar.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            let kind = entry.header().entry_type();
            if !safe_relative(&path) || !(kind.is_file() || kind.is_dir()) {
                return Err(GitError::new(format!("Unexpected entry in the package: {}", path.display())));
            }
            entry.unpack(dest.join(&path))?;
        }
    } else {
        let mut zip = zip::ZipArchive::new(fs::File::open(archive)?).map_err(|e| GitError::new(format!("Bad package: {e}")))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| GitError::new(format!("Bad package: {e}")))?;
            let path = entry
                .enclosed_name()
                .filter(|p| safe_relative(p))
                .ok_or_else(|| GitError::new(format!("Unexpected entry in the package: {}", entry.name())))?;
            if entry.is_symlink() {
                return Err(GitError::new(format!("Unexpected link in the package: {}", path.display())));
            }
            let target = dest.join(&path);
            if entry.is_dir() {
                fs::create_dir_all(&target)?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = fs::File::create(&target)?;
            std::io::copy(&mut entry, &mut out)?;
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777))?;
            }
        }
    }
    Ok(())
}

/// Extracts `archive`, checks its `build-info.json` and swaps its top-level entries into `root`.
pub fn apply_archive(root: &Path, archive: &Path, version: &str, rid: &str) -> GitResult<()> {
    let staging = root.join(STAGING);
    let new = staging.join("new");
    let old = staging.join("old");
    let _ = fs::remove_dir_all(&new);
    let _ = fs::remove_dir_all(&old);
    extract(archive, &new)?;
    let manifest: serde_json::Value = fs::read(new.join("build-info.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| GitError::new("The package has no build information."))?;
    if manifest["version"].as_str() != Some(version) || manifest["rid"].as_str() != Some(rid) {
        return Err(GitError::new(format!("The package is for {} {}, expected {version} {rid}.", manifest["version"], manifest["rid"])));
    }
    let exe = if rid.starts_with("osx-") {
        "Revqora.app/Contents/MacOS/revqora"
    } else if rid.starts_with("win-") {
        "revqora.exe"
    } else {
        "revqora"
    };
    if !new.join(exe).is_file() {
        return Err(GitError::new("The package has no executable."));
    }
    fs::create_dir_all(&old)?;
    let entries: Vec<_> = fs::read_dir(&new)?.filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
    let mut moved_old = Vec::new();
    let mut placed = Vec::new();
    let result = (|| -> std::io::Result<()> {
        for name in &entries {
            let target = root.join(name);
            if target.exists() {
                fs::rename(&target, old.join(name))?;
                moved_old.push(name.clone());
            }
            fs::rename(new.join(name), &target)?;
            placed.push(name.clone());
        }
        Ok(())
    })();
    if let Err(e) = result {
        for name in placed.iter().rev() {
            let _ = fs::rename(root.join(name), new.join(name));
        }
        for name in moved_old.iter().rev() {
            let _ = fs::rename(old.join(name), root.join(name));
        }
        return Err(GitError::new(format!("Could not replace the app files ({e}); nothing was changed.")).kind("update-install"));
    }
    let _ = fs::remove_file(archive);
    Ok(())
}

/// Removes what a previous update left behind (the old exe may still be locked for a moment).
pub fn cleanup(root: &Path) {
    let staging = root.join(STAGING);
    for _ in 0..20 {
        if !staging.exists() || fs::remove_dir_all(&staging).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Started by "Restart" after an update: waits until the previous process has exited so the
/// single-instance check does not hand the launch back to it.
pub fn wait_for_previous_instance() {
    let Some(pid) = std::env::var("REVQORA_RESTART_AFTER").ok().and_then(|v| v.parse::<u32>().ok()) else { return };
    std::env::remove_var("REVQORA_RESTART_AFTER");
    for _ in 0..100 {
        if !process_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    // SAFETY: plain Win32 calls on a handle we own and close.
    unsafe {
        let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if h.is_null() {
            return false;
        }
        let alive = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
        CloseHandle(h);
        alive
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Starts the freshly installed executable; the caller exits right after.
pub fn relaunch() -> GitResult<()> {
    let exe = launch().map(Launch::installed_exe).ok_or_else(|| GitError::new("Could not find the app folder."))?;
    if !exe.is_file() {
        return Err(GitError::new(format!("The updated app is missing: {}", exe.display())));
    }
    let mut c = std::process::Command::new(&exe);
    c.args(std::env::args_os().skip(1)).env("REVQORA_RESTART_AFTER", std::process::id().to_string());
    c.spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("v1.0.0", "0.99.99"));
        assert!(is_newer("0.2.0", "0.2.0-rc.1"));
        assert!(is_newer("0.2.0-rc.2", "0.2.0-rc.1"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(!is_newer("0.2.0-rc.1", "0.2.0"));
        assert!(!is_newer("garbage", "0.1.0"));
        assert_eq!(parse_version("0.0.0-pr.12"), Some((0, 0, 0, Some("pr.12".into()))));
    }

    #[test]
    fn parses_checksums() {
        let h = "a".repeat(64);
        assert_eq!(parse_checksum(&format!("{h}  Revqora-0.1.0-win-x64.zip\n")), Some(h.clone()));
        assert_eq!(parse_checksum(&h.to_uppercase()), Some(h));
        assert_eq!(parse_checksum("xyz file"), None);
    }

    #[test]
    fn picks_the_platform_asset_from_the_release() {
        let url = |n: &str| format!("https://github.com/{REPO}/releases/download/v0.2.0/{n}");
        let json = serde_json::json!({
            "tag_name": "v0.2.0",
            "body": "Faster graph",
            "html_url": "https://github.com/bitcodepro/Revqora/releases/tag/v0.2.0",
            "assets": [
                { "name": "Revqora-0.2.0-win-x64.zip", "size": 10, "browser_download_url": url("Revqora-0.2.0-win-x64.zip") },
                { "name": "Revqora-0.2.0-win-x64.zip.sha256", "size": 1, "browser_download_url": url("Revqora-0.2.0-win-x64.zip.sha256") },
                { "name": "Revqora-0.2.0-linux-x64.tar.gz", "size": 10, "browser_download_url": "https://evil.example/x.tar.gz" }
            ]
        });
        let info = parse_release(&json, "0.1.0", Some("win-x64")).unwrap();
        assert!(info.available);
        assert_eq!(info.latest, "0.2.0");
        let asset = info.asset.unwrap();
        assert_eq!(asset.size, 10);
        assert!(asset.checksum_url.is_some());
        // Downloads outside the repository's releases are ignored.
        assert!(parse_release(&json, "0.1.0", Some("linux-x64")).unwrap().asset.is_none());
        assert!(!parse_release(&json, "0.2.0", Some("win-x64")).unwrap().available);
    }

    fn zip_package(path: &Path, files: &[(&str, &str)]) {
        let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, body) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn installs_a_package_over_the_old_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("revqora.exe"), "old exe").unwrap();
        fs::write(root.join("README.md"), "old readme").unwrap();
        fs::write(root.join("build-info.json"), r#"{"version":"0.1.0","rid":"win-x64"}"#).unwrap();
        assert!(installable(root).is_ok());
        let archive = tmp.path().join("pkg.zip");
        zip_package(
            &archive,
            &[
                ("revqora.exe", "new exe"),
                ("README.md", "new readme"),
                ("licenses/OFL.txt", "ofl"),
                ("build-info.json", r#"{"version":"0.2.0","rid":"win-x64"}"#),
            ],
        );
        apply_archive(root, &archive, "0.2.0", "win-x64").unwrap();
        assert_eq!(fs::read_to_string(root.join("revqora.exe")).unwrap(), "new exe");
        assert_eq!(fs::read_to_string(root.join("licenses/OFL.txt")).unwrap(), "ofl");
        assert_eq!(fs::read_to_string(root.join(STAGING).join("old/revqora.exe")).unwrap(), "old exe");
        cleanup(root);
        assert!(!root.join(STAGING).exists());
    }

    #[test]
    fn rejects_wrong_or_unsafe_packages() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("revqora.exe"), "old exe").unwrap();
        let archive = tmp.path().join("pkg.zip");
        zip_package(&archive, &[("revqora.exe", "x"), ("build-info.json", r#"{"version":"0.2.0","rid":"linux-x64"}"#)]);
        assert!(apply_archive(root, &archive, "0.2.0", "win-x64").is_err());
        zip_package(&archive, &[("../evil.txt", "x"), ("build-info.json", r#"{"version":"0.2.0","rid":"win-x64"}"#)]);
        assert!(apply_archive(root, &archive, "0.2.0", "win-x64").is_err());
        assert!(!tmp.path().parent().unwrap().join("evil.txt").exists());
        assert_eq!(fs::read_to_string(root.join("revqora.exe")).unwrap(), "old exe");
    }

    #[test]
    fn relaunch_targets_the_installed_exe_not_the_moved_one() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("revqora.exe"), "old exe").unwrap();
        fs::write(root.join("build-info.json"), r#"{"version":"0.1.0","rid":"win-x64"}"#).unwrap();
        let launch = Launch::from_exe(&root.join("revqora.exe")).unwrap();
        let archive = tmp.path().join("pkg.zip");
        zip_package(&archive, &[("revqora.exe", "new exe"), ("build-info.json", r#"{"version":"0.2.0","rid":"win-x64"}"#)]);
        apply_archive(root, &archive, "0.2.0", "win-x64").unwrap();
        assert_eq!(launch.root, root);
        assert_eq!(fs::read_to_string(launch.installed_exe()).unwrap(), "new exe");
    }

    /// A real running Linux process whose binary is swapped: `/proc/<pid>/exe` follows the old
    /// inode into the staging folder, while the relaunch target runs the new version.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_relaunch_runs_the_new_binary_after_the_swap() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Revqora");
        fs::create_dir_all(&root).unwrap();
        fs::copy("/bin/sleep", root.join("revqora")).unwrap();
        fs::write(root.join("build-info.json"), r#"{"version":"0.1.0","rid":"linux-x64"}"#).unwrap();
        let launch = Launch::from_exe(&root.join("revqora")).unwrap();
        struct Probe(std::process::Child);
        impl Drop for Probe {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        // Parallel tests may fork while extraction/copy holds a writable FD.
        // A child can retain that FD until exec even with CLOEXEC, so Linux may
        // briefly refuse the executable. Retry only ETXTBSY before a child starts.
        fn spawn_ready(command: &mut std::process::Command) -> std::process::Child {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match command.spawn() {
                    Ok(child) => return child,
                    Err(e) if e.raw_os_error() == Some(26) && std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(e) => panic!("could not start relaunch probe: {e}"),
                }
            }
        }
        let mut old = Probe(spawn_ready(std::process::Command::new(root.join("revqora")).arg("30")));
        // Establish which image is running before moving it. Under concurrent
        // process creation /proc can briefly expose the child's pre-exec image.
        let expected = fs::canonicalize(root.join("revqora")).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let running = fs::read_link(format!("/proc/{}/exe", old.0.id()));
            if running.as_ref().is_ok_and(|path| path == &expected) {
                break;
            }
            if let Some(status) = old.0.try_wait().unwrap() {
                panic!("relaunch probe exited before exec: {status}");
            }
            assert!(std::time::Instant::now() < deadline, "relaunch probe did not start its installed image: {running:?}");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let staging = tmp.path().join("pkg");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("revqora"), "#!/bin/sh\necho 0.2.0\n").unwrap();
        fs::set_permissions(staging.join("revqora"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(staging.join("build-info.json"), r#"{"version":"0.2.0","rid":"linux-x64"}"#).unwrap();
        let archive = tmp.path().join("pkg.tar.gz");
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(fs::File::create(&archive).unwrap(), flate2::Compression::fast()));
        tar.append_path_with_name(staging.join("revqora"), "revqora").unwrap();
        tar.append_path_with_name(staging.join("build-info.json"), "build-info.json").unwrap();
        tar.into_inner().unwrap().finish().unwrap();

        apply_archive(&root, &archive, "0.2.0", "linux-x64").unwrap();
        let running = fs::read_link(format!("/proc/{}/exe", old.0.id())).unwrap();
        assert!(running.starts_with(root.join(STAGING)), "running binary now resolves to {}", running.display());
        assert_eq!(Launch::from_exe(&root.join("revqora")).unwrap(), launch);
        let mut command = std::process::Command::new(launch.installed_exe());
        command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let out = spawn_ready(&mut command).wait_with_output().unwrap();
        assert!(out.status.success(), "replacement binary failed: {out:?}");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "0.2.0");
    }

    #[test]
    fn dev_builds_are_not_installable() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(installable(tmp.path()).is_err());
    }
}
