//! Open user-selected files and web links without passing them to a command shell.
use crate::git::runner::{GitError, GitResult};
use std::path::Path;

/// Extensions Windows (and some desktops) run instead of opening. "Open file" on a file shown in
/// a commit must never launch a program the commit added, whatever its name looks like.
const RUNNABLE: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msi",
    "msp",
    "scr",
    "pif",
    "lnk",
    "hta",
    "cpl",
    "jar",
    "reg",
    "appref-ms",
    "application",
    "url",
    "desktop",
    "sh",
    "command",
    "app",
];

/// An existing absolute path without `..` segments (a crafted name such as `a.md\..\tool.exe`
/// would otherwise resolve somewhere else than the file shown).
pub fn local_path(value: &str) -> GitResult<&Path> {
    let path = Path::new(value);
    if value.contains('\0') || !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(GitError::new("Choose a file inside the repository.").kind("invalid-path"));
    }
    if !path.exists() {
        return Err(GitError::new("The selected file or folder no longer exists."));
    }
    Ok(path)
}

/// Whether opening `path` would run it (a program or a script) rather than show it.
pub fn runnable(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    path.is_file() && RUNNABLE.contains(&ext.as_str())
}

/// `allow_run`: the user explicitly confirmed running this program or script.
fn target_checked(value: &str, allow_run: bool) -> GitResult<String> {
    if value.contains('\0') {
        return Err(GitError::new("Invalid file or web address."));
    }
    if Path::new(value).is_absolute() {
        let path = local_path(value)?;
        if runnable(path) && !allow_run {
            // The UI asks whether to open it as text or run it.
            return Err(GitError::new("This is a program or script: opening it would run it.").kind("runnable-file"));
        }
        return Ok(value.to_owned());
    }
    let url = url::Url::parse(value).map_err(|_| GitError::new("Choose an existing absolute path or an HTTP(S) address."))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(GitError::new("Only HTTP(S) web links are supported."));
    }
    Ok(url.to_string())
}

pub fn open(value: &str) -> GitResult<()> {
    open_checked(value, false)
}

/// Runs a program or script the user explicitly chose to run.
pub fn run_confirmed(value: &str) -> GitResult<()> {
    open_checked(value, true)
}

/// Opens a program or script as text: the system "Edit" action (Notepad for scripts), or the
/// "Open with" chooser when the type has no editor; never executes it.
pub fn open_as_text(value: &str) -> GitResult<()> {
    let path = local_path(value)?;
    if !path.is_file() {
        return Err(GitError::new("Choose a file."));
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() };
        let file = wide(value);
        let edit = wide("edit");
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), edit.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1) } as isize;
        if result <= 32 {
            // No "Edit" verb for this type: let the user choose a text editor.
            std::process::Command::new("rundll32.exe").arg("shell32.dll,OpenAs_RunDLL").arg(value).spawn()?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-t"]).arg(value).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // xdg-open would run a .desktop or executable; hand plain text to the text editor.
        let editor = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_else(|_| "xdg-open".into());
        if editor == "xdg-open" {
            std::process::Command::new("gio").args(["open", "--"]).arg(value).spawn().or_else(|_| std::process::Command::new("xdg-open").arg(value).spawn())?;
        } else {
            std::process::Command::new(editor).arg(value).spawn()?;
        }
    }
    Ok(())
}

fn open_checked(value: &str, allow_run: bool) -> GitResult<()> {
    let value = target_checked(value, allow_run)?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let value: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        // ShellExecute receives a single UTF-16 target, never cmd.exe syntax.
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), value.as_ptr(), std::ptr::null(), std::ptr::null(), 1) } as isize;
        if result <= 32 {
            return Err(GitError::new(format!("Windows could not open the selected file or link (ShellExecute code {result}).")));
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(value).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(value).spawn()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_checked_default(value: &str) -> GitResult<String> {
        target_checked(value, false)
    }
    #[test]
    fn preserves_web_query_and_file_shell_metacharacters_as_one_target() {
        let url = "https://github.com/owner/repo/actions?view=logs&job=42#step:1";
        assert_eq!(target_checked_default(url).unwrap(), url);
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("file & other%.txt");
        std::fs::write(&path, b"fixture").unwrap();
        assert_eq!(target_checked_default(path.to_str().unwrap()).unwrap(), path.to_str().unwrap());
        for value in ["javascript:alert(1)", "file:///private/file", "https://user:password@example.com", "relative.txt", "https://example.com/\0"] {
            assert!(target_checked_default(value).is_err());
        }
    }

    #[test]
    fn never_runs_programs_or_follows_dot_dot_segments() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = tmp.path().join("tool.exe");
        std::fs::write(&tool, b"MZ").unwrap();
        std::fs::write(tmp.path().join("readme.md"), b"text").unwrap();
        assert_eq!(target_checked(tool.to_str().unwrap(), false).unwrap_err().kind, "runnable-file");
        assert!(target_checked(tool.to_str().unwrap(), true).is_ok(), "runs only after explicit confirmation");
        let script = tmp.path().join("build.CMD");
        std::fs::write(&script, b"echo").unwrap();
        assert_eq!(target_checked_default(script.to_str().unwrap()).unwrap_err().kind, "runnable-file");
        // A name crafted to climb out of the shown file.
        let crafted = format!("{}{}..{}tool.exe", tmp.path().join("readme.md").display(), std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
        assert_eq!(target_checked_default(&crafted).unwrap_err().kind, "invalid-path");
        assert!(target_checked_default(tmp.path().join("readme.md").to_str().unwrap()).is_ok());
        assert!(target_checked_default(tmp.path().to_str().unwrap()).is_ok(), "folders still open");
    }
}
