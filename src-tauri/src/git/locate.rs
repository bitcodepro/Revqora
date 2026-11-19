//! Finds the git executable Revqora runs: the one installed on the system (on PATH, or the
//! usual Git for Windows locations). `REVQORA_GIT` overrides it.

use std::ffi::OsString;
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
    /// The Git for Windows launcher (`cmd\git.exe`) that was found when Revqora runs the git
    /// binary behind it directly (`path`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launcher: Option<String>,
}

struct State {
    exe: PathBuf,
    /// Environment the Git for Windows launcher would have set (empty when git runs as found).
    env: Vec<(OsString, OsString)>,
    version: (u32, u32, u32),
    selection: GitSelection,
}

/// A configured `git` process: the selected executable with the environment its launcher
/// would set. Every git process Revqora starts is built here.
pub fn command() -> Command {
    ensure();
    let state = STATE.read();
    let Some(state) = state.as_ref() else { return Command::new("git") };
    let mut c = Command::new(&state.exe);
    for (key, value) in &state.env {
        c.env(key, value);
    }
    c
}

/// The git binary behind a Git for Windows launcher and the environment the launcher sets.
///
/// `<Git>\cmd\git.exe` and `<Git>\bin\git.exe` are small launchers: every call starts the real
/// git (`<Git>\ucrt64\bin\git.exe`, or `mingw64`, `clangarm64`, `mingw32`) as a second process,
/// about 18 ms more per command on Windows. The launcher only sets `MSYSTEM` and puts the
/// toolchain folders and `%HOME%\bin` first on `PATH` (git sets HOME and the rest itself), so
/// running the binary with the same variables gives git, hooks, ssh and credential helpers the
/// same environment. None when the found file is not such a launcher or the layout differs.
fn direct_git(found: &Path, var: &dyn Fn(&str) -> Option<OsString>) -> Option<(PathBuf, Vec<(OsString, OsString)>)> {
    if !cfg!(windows) || var("REVQORA_GIT_DIRECT").is_some_and(|v| v == "0") {
        return None;
    }
    let folder = found.parent()?;
    let kind = folder.file_name()?.to_string_lossy().to_ascii_lowercase();
    // The launcher is about 45 KB; the real git is several MB.
    if !(kind == "cmd" || kind == "bin") || std::fs::metadata(found).ok()?.len() > 1024 * 1024 {
        return None;
    }
    let top = folder.parent()?;
    let usr = top.join("usr").join("bin");
    if !usr.is_dir() {
        return None;
    }
    let (bin, msystem) = [("ucrt64", "UCRT64"), ("mingw64", "MINGW64"), ("clangarm64", "CLANGARM64"), ("mingw32", "MINGW32")]
        .into_iter()
        .map(|(prefix, msystem)| (top.join(prefix).join("bin"), msystem))
        .find(|(bin, _)| bin.join("git.exe").is_file())?;
    let home = var("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| match (var("HOMEDRIVE"), var("HOMEPATH")) {
            (Some(drive), Some(path)) if !drive.is_empty() && !path.is_empty() => {
                let mut home = drive;
                home.push(path);
                Some(home)
            }
            _ => None,
        })
        .or_else(|| var("USERPROFILE").filter(|h| !h.is_empty()));
    let mut folders = vec![bin.clone(), usr];
    if let Some(home) = home {
        folders.push(PathBuf::from(home).join("bin"));
    }
    folders.extend(var("PATH").map(|path| std::env::split_paths(&path).collect::<Vec<_>>()).unwrap_or_default());
    let mut env = vec![(OsString::from("PATH"), std::env::join_paths(folders).ok()?)];
    if var("MSYSTEM").is_none_or(|v| v.is_empty()) {
        env.push((OsString::from("MSYSTEM"), OsString::from(msystem)));
    }
    Some((bin.join("git.exe"), env))
}

static STATE: RwLock<Option<State>> = RwLock::new(None);
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Changes every time Git is looked up again (start, Detect again): answers remembered about
/// the installed tools are read again after it changes.
pub fn generation() -> u64 {
    ensure();
    GENERATION.load(std::sync::atomic::Ordering::Acquire)
}

pub fn parse_version(text: &str) -> (u32, u32, u32) {
    let v = text.trim().trim_start_matches("git version ");
    let mut nums = v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).map(|p| p.parse::<u32>().unwrap_or(0));
    (nums.next().unwrap_or(0), nums.next().unwrap_or(0), nums.next().unwrap_or(0))
}

fn probe(exe: &Path, env: &[(OsString, OsString)]) -> Option<String> {
    let mut c = Command::new(exe);
    c.envs(env.iter().map(|(k, v)| (k, v)));
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
    // Prefer the git binary behind a Git for Windows launcher; keep the launcher when the
    // binary is missing or does not answer.
    let var = |name: &str| std::env::var_os(name);
    let direct = found.as_ref().and_then(|launcher| {
        let (exe, env) = direct_git(launcher, &var)?;
        let version = probe(&exe, &env)?;
        Some((exe, env, version, Some(launcher.to_string_lossy().into_owned())))
    });
    let probed = direct.or_else(|| found.as_ref().and_then(|p| probe(p, &[]).map(|v| (p.clone(), Vec::new(), v, None))));
    let min = format!("{}.{}", MIN_VERSION.0, MIN_VERSION.1);
    let (exe, env, version, selection) = match probed {
        Some((p, env, v, launcher)) => {
            let ver = parse_version(&v);
            let sel = GitSelection {
                source: source.into(),
                path: p.to_string_lossy().into_owned(),
                version: v,
                too_old: (ver.0, ver.1) < MIN_VERSION,
                min_version: min,
                launcher,
            };
            (p, env, ver, sel)
        }
        None => (
            PathBuf::from("git"),
            Vec::new(),
            (0, 0, 0),
            GitSelection { source: "none".into(), path: String::new(), version: String::new(), too_old: false, min_version: min, launcher: None },
        ),
    };
    *STATE.write() = Some(State { exe, env, version, selection: selection.clone() });
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
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

/// Oldest Git Credential Manager whose OAuth sign-in Bitbucket Cloud accepts from November 30,
/// 2026. SSH, API tokens and app passwords are not affected.
pub const GCM_MIN_FOR_BITBUCKET: (u32, u32, u32) = (3, 0, 0);

/// The Git Credential Manager that Git runs, when the configured helper is GCM.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialManager {
    pub version: String,
    /// Older than [`GCM_MIN_FOR_BITBUCKET`]: Bitbucket sign-ins stop working.
    pub outdated: bool,
    pub min_version: String,
    /// Revqora holds a token for the asked repository and answers its sign-in before GCM.
    pub revqora_token: bool,
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
    let run = |args: &[&str]| -> Option<String> {
        let mut c = command();
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
    Some(CredentialManager { outdated: parsed < GCM_MIN_FOR_BITBUCKET, version, min_version: format!("{a}.{b}.{c}"), revqora_token: false })
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[cfg(windows)]
    #[test]
    fn the_git_behind_a_launcher_runs_with_the_environment_the_launcher_sets() {
        use std::ffi::OsString;
        use std::path::Path;
        let fixture = tempfile::tempdir_in(crate::portable::temp_dir().unwrap()).unwrap();
        let top = fixture.path().join("Git");
        for dir in ["cmd", "usr/bin", "ucrt64/bin"] {
            std::fs::create_dir_all(top.join(dir)).unwrap();
        }
        std::fs::write(top.join("cmd/git.exe"), b"launcher").unwrap();
        std::fs::write(top.join("ucrt64/bin/git.exe"), b"git").unwrap();
        let vars = |extra: &'static [(&'static str, &'static str)]| {
            move |name: &str| -> Option<OsString> {
                extra.iter().find(|(k, _)| *k == name).map(|(_, v)| OsString::from(v)).or_else(|| match name {
                    "PATH" => Some(OsString::from(r"C:\Windows\system32;C:\Tools")),
                    "USERPROFILE" => Some(OsString::from(r"C:\Users\Person")),
                    _ => None,
                })
            }
        };
        let env_of = |env: &[(OsString, OsString)], key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.to_string_lossy().into_owned());

        let (exe, env) = super::direct_git(&top.join("cmd/git.exe"), &vars(&[])).expect("the binary behind the launcher");
        assert_eq!(exe, top.join("ucrt64").join("bin").join("git.exe"));
        let path = env_of(&env, "PATH").unwrap();
        let folders: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(folders[0], top.join("ucrt64").join("bin"));
        assert_eq!(folders[1], top.join("usr").join("bin"));
        assert_eq!(folders[2], Path::new(r"C:\Users\Person").join("bin"));
        assert_eq!(&folders[3..], [Path::new(r"C:\Windows\system32"), Path::new(r"C:\Tools")]);
        assert_eq!(env_of(&env, "MSYSTEM").as_deref(), Some("UCRT64"));

        // HOME wins over USERPROFILE, and a MSYSTEM that is already set is kept.
        let (_, env) = super::direct_git(&top.join("cmd/git.exe"), &vars(&[("HOME", r"D:\Home"), ("MSYSTEM", "MINGW64")])).unwrap();
        assert_eq!(std::env::split_paths(&env_of(&env, "PATH").unwrap()).nth(2).unwrap(), Path::new(r"D:\Home").join("bin"));
        assert_eq!(env_of(&env, "MSYSTEM"), None);

        // Opt-out, the real binary itself, a large file and an unknown layout keep git as found.
        assert!(super::direct_git(&top.join("cmd/git.exe"), &vars(&[("REVQORA_GIT_DIRECT", "0")])).is_none());
        assert!(super::direct_git(&top.join("ucrt64/bin/git.exe"), &vars(&[])).is_none());
        std::fs::write(top.join("cmd/git.exe"), vec![0u8; 2 * 1024 * 1024]).unwrap();
        assert!(super::direct_git(&top.join("cmd/git.exe"), &vars(&[])).is_none());
        std::fs::write(top.join("cmd/git.exe"), b"launcher").unwrap();
        std::fs::remove_dir_all(top.join("usr")).unwrap();
        assert!(super::direct_git(&top.join("cmd/git.exe"), &vars(&[])).is_none());
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("git version 2.56.0.windows.3"), (2, 56, 0));
        assert_eq!(parse_version("2.45.1.windows.1"), (2, 45, 1));
        assert_eq!(parse_version("git version 2.39.5 (Apple Git-154)"), (2, 39, 5));
    }
}
