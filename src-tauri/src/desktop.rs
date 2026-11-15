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

fn target(value: &str) -> GitResult<String> {
    if value.contains('\0') {
        return Err(GitError::new("Invalid file or web address."));
    }
    if Path::new(value).is_absolute() {
        let path = local_path(value)?;
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        if path.is_file() && RUNNABLE.contains(&ext.as_str()) {
            return Err(GitError::new("Revqora does not run programs or scripts. Use Show in folder or open it from your editor.").kind("runnable-file"));
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
    let value = target(value)?;
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
    #[test]
    fn preserves_web_query_and_file_shell_metacharacters_as_one_target() {
        let url = "https://github.com/owner/repo/actions?view=logs&job=42#step:1";
        assert_eq!(target(url).unwrap(), url);
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("file & other%.txt");
        std::fs::write(&path, b"fixture").unwrap();
        assert_eq!(target(path.to_str().unwrap()).unwrap(), path.to_str().unwrap());
        for value in ["javascript:alert(1)", "file:///private/file", "https://user:password@example.com", "relative.txt", "https://example.com/\0"] {
            assert!(target(value).is_err());
        }
    }

    #[test]
    fn never_runs_programs_or_follows_dot_dot_segments() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = tmp.path().join("tool.exe");
        std::fs::write(&tool, b"MZ").unwrap();
        std::fs::write(tmp.path().join("readme.md"), b"text").unwrap();
        assert_eq!(target(tool.to_str().unwrap()).unwrap_err().kind, "runnable-file");
        let script = tmp.path().join("build.CMD");
        std::fs::write(&script, b"echo").unwrap();
        assert_eq!(target(script.to_str().unwrap()).unwrap_err().kind, "runnable-file");
        // A name crafted to climb out of the shown file.
        let crafted = format!("{}{}..{}tool.exe", tmp.path().join("readme.md").display(), std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
        assert_eq!(target(&crafted).unwrap_err().kind, "invalid-path");
        assert!(target(tmp.path().join("readme.md").to_str().unwrap()).is_ok());
        assert!(target(tmp.path().to_str().unwrap()).is_ok(), "folders still open");
    }
}
