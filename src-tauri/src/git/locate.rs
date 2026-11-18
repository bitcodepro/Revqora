//! Finds the git executable Revqora runs: the one installed on the system (on PATH, or the
//! usual Git for Windows locations). `REVQORA_GIT` overrides it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use parking_lot::RwLock;
use serde::Serialize;

/// Oldest git Revqora supports (porcelain v2 status, `switch`/`restore`, pathspec-from-file).
pub const MIN_VERSION: (u32, u32) = (2, 30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSelection {
    /// "system" | "custom" | "none"
    pub source: String,
    pub path: String,
    pub version: String,
    /// The found git is older than [`MIN_VERSION`].
    pub too_old: bool,
    pub min_version: String,
}

struct State {
    exe: PathBuf,
    version: (u32, u32, u32),
    selection: GitSelection,
}

static STATE: RwLock<Option<State>> = RwLock::new(None);

pub fn parse_version(text: &str) -> (u32, u32, u32) {
    let v = text.trim().trim_start_matches("git version ");
    let mut nums = v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).map(|p| p.parse::<u32>().unwrap_or(0));
    (nums.next().unwrap_or(0), nums.next().unwrap_or(0), nums.next().unwrap_or(0))
}

fn probe(exe: &Path) -> Option<String> {
    let mut c = Command::new(exe);
    c.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().trim_start_matches("git version ").to_string())
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// git on PATH, then the standard install folders (PATH can be stale right after installing).
fn find_system_git() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join(exe_name("git"));
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    let mut extra: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var) {
                let base = PathBuf::from(base);
                extra.push(base.join("Git").join("cmd").join("git.exe"));
                extra.push(base.join("Programs").join("Git").join("cmd").join("git.exe"));
            }
        }
    } else {
        extra.extend(["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"].map(PathBuf::from));
    }
    extra.into_iter().find(|p| p.is_file())
}

/// Looks for git again (e.g. after the user installed it) and remembers the result.
pub fn configure() -> GitSelection {
    let custom = std::env::var("REVQORA_GIT").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    let (source, found) = match custom {
        Some(p) => ("custom", Some(p)),
        None => ("system", find_system_git()),
    };
    let probed = found.as_ref().and_then(|p| probe(p).map(|v| (p.clone(), v)));
    let min = format!("{}.{}", MIN_VERSION.0, MIN_VERSION.1);
    let (exe, version, selection) = match probed {
        Some((p, v)) => {
            let ver = parse_version(&v);
            let sel = GitSelection {
                source: source.into(),
                path: p.to_string_lossy().into_owned(),
                version: v,
                too_old: (ver.0, ver.1) < MIN_VERSION,
                min_version: min,
            };
            (p, ver, sel)
        }
        None => (
            PathBuf::from("git"),
            (0, 0, 0),
            GitSelection { source: "none".into(), path: String::new(), version: String::new(), too_old: false, min_version: min },
        ),
    };
    *STATE.write() = Some(State { exe, version, selection: selection.clone() });
    *GCM.write() = None;
    selection
}

fn ensure() {
    if STATE.read().is_none() {
        configure();
    }
}

pub fn exe() -> PathBuf {
    ensure();
    STATE.read().as_ref().map(|s| s.exe.clone()).unwrap_or_else(|| PathBuf::from("git"))
}

pub fn version() -> (u32, u32, u32) {
    ensure();
    STATE.read().as_ref().map(|s| s.version).unwrap_or((0, 0, 0))
}

pub fn selection() -> Option<GitSelection> {
    ensure();
    STATE.read().as_ref().map(|s| s.selection.clone())
}

/// Oldest Git Credential Manager that Bitbucket Cloud accepts from November 30, 2026.
pub const GCM_MIN_FOR_BITBUCKET: (u32, u32, u32) = (3, 0, 0);

/// The Git Credential Manager that Git runs, when the configured helper is GCM.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialManager {
    pub version: String,
    /// Older than [`GCM_MIN_FOR_BITBUCKET`]: Bitbucket sign-ins stop working.
    pub outdated: bool,
    pub min_version: String,
}

static GCM: RwLock<Option<Option<CredentialManager>>> = RwLock::new(None);

/// Asks `git credential-manager --version` once per selected Git (GCM is a .NET program and
/// takes about a second to start). None when GCM is not the configured helper or is missing.
pub fn credential_manager() -> Option<CredentialManager> {
    if let Some(known) = GCM.read().clone() {
        return known;
    }
    let found = probe_credential_manager();
    *GCM.write() = Some(found.clone());
    found
}

fn probe_credential_manager() -> Option<CredentialManager> {
    let git = exe();
    let run = |args: &[&str]| -> Option<String> {
        let mut c = Command::new(&git);
        c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).env("GCM_INTERACTIVE", "never").env("GIT_TERMINAL_PROMPT", "0");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        let mut child = c.spawn().ok()?;
        let start = std::time::Instant::now();
        while child.try_wait().ok()?.is_none() {
            if start.elapsed() > std::time::Duration::from_secs(10) {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let out = child.wait_with_output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    let helpers = run(&["config", "--get-all", "credential.helper"]).unwrap_or_default();
    let uses_gcm = helpers.lines().any(|h| {
        let h = h.trim().trim_matches('"').replace('\\', "/").to_ascii_lowercase();
        h == "manager" || h == "manager-core" || h.contains("credential-manager") || h.ends_with("git-credential-manager.exe")
    });
    if !uses_gcm {
        return None;
    }
    let version = run(&["credential-manager", "--version"])?;
    let version = version.lines().next()?.split('+').next()?.trim().to_owned();
    let parsed = parse_version(&version);
    if parsed == (0, 0, 0) {
        return None;
    }
    let (a, b, c) = GCM_MIN_FOR_BITBUCKET;
    Some(CredentialManager { outdated: parsed < GCM_MIN_FOR_BITBUCKET, version, min_version: format!("{a}.{b}.{c}") })
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("git version 2.56.0.windows.3"), (2, 56, 0));
        assert_eq!(parse_version("2.45.1.windows.1"), (2, 45, 1));
        assert_eq!(parse_version("git version 2.39.5 (Apple Git-154)"), (2, 39, 5));
    }
}
