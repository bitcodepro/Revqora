//! Open user-selected files and web links without passing them to a command shell.
use crate::git::runner::{GitError, GitResult};
use std::path::Path;

fn target(value: &str) -> GitResult<String> {
    if value.contains('\0') {
        return Err(GitError::new("Invalid file or web address."));
    }
    if Path::new(value).is_absolute() {
        if !Path::new(value).exists() {
            return Err(GitError::new("The selected file or folder no longer exists."));
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
}
