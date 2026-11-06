//! Optimistic, index-preserving edits of an existing UTF-8 working file.
use super::{
    operations, ops, repo,
    runner::{GitError, GitResult},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

const LIMIT: usize = 2 * 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub content: String,
    pub revision: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub file: Snapshot,
    pub backup_path: Option<String>,
}

fn checked_path(root: &Path, path: &str) -> GitResult<PathBuf> {
    let relative = Path::new(path);
    if relative.as_os_str().is_empty()
        || relative.components().any(|c| !matches!(c, Component::Normal(_)) || c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
    {
        return Err(GitError::new("Choose a file inside this working copy."));
    }
    #[cfg(windows)]
    if path.contains(':') {
        return Err(GitError::new("Alternate data streams cannot be edited."));
    }
    let base = root.canonicalize()?;
    let mut full = base.clone();
    let parts: Vec<_> = relative.components().collect();
    for (i, part) in parts.iter().enumerate() {
        full.push(part.as_os_str());
        let meta = fs::symlink_metadata(&full)?;
        let leaf = i + 1 == parts.len();
        if ops::path_is_link(&meta) || (leaf && !meta.is_file()) || (!leaf && !meta.is_dir()) {
            return Err(GitError::new("The editor only opens regular files and does not follow symbolic links or directory junctions."));
        }
        // Resolve Windows short names and trailing-dot/space aliases as well.
        // Lexical checks alone would allow a spelling such as `.git./config`.
        full = full.canonicalize()?;
        if full.strip_prefix(&base).map_or(true, |relative| relative.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))) {
            return Err(GitError::new("Choose a file inside this working copy, outside Git metadata."));
        }
        if !leaf && full.join(".git").exists() {
            return Err(GitError::new("Open this nested repository separately before editing its files."));
        }
    }
    Ok(full)
}
fn validate(content: &str) -> GitResult<()> {
    if content.len() > LIMIT || content.contains('\0') {
        return Err(GitError::new("The editor supports UTF-8 text files up to 2 MiB. Open binary or larger files in an external editor."));
    }
    Ok(())
}
fn revision(root: &Path, path: &str, bytes: &[u8], permissions: &fs::Permissions, head: &[u8]) -> String {
    let mut hash = Sha256::new();
    for field in [root.as_os_str().as_encoded_bytes(), path.as_bytes(), bytes, head] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field);
    }
    hash.update([permissions.readonly() as u8]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        hash.update(permissions.mode().to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}
struct Disk {
    full: PathBuf,
    file: Snapshot,
    permissions: fs::Permissions,
    head: Vec<u8>,
}

#[cfg(windows)]
fn security_descriptor(path: &Path) -> std::io::Result<Vec<u32>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{GetFileSecurityW, DACL_SECURITY_INFORMATION};
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut needed = 0;
    unsafe {
        GetFileSecurityW(path.as_ptr(), DACL_SECURITY_INFORMATION, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut buffer = vec![0u32; (needed as usize).div_ceil(4)];
    if unsafe { GetFileSecurityW(path.as_ptr(), DACL_SECURITY_INFORMATION, buffer.as_mut_ptr().cast(), needed, &mut needed) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(buffer)
}
fn prepare_permissions(source: &Path, temporary: &Path, permissions: &fs::Permissions) -> GitResult<()> {
    fs::set_permissions(temporary, permissions.clone())?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::{
            GetSecurityDescriptorControl, SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
            UNPROTECTED_DACL_SECURITY_INFORMATION,
        };
        let descriptor = security_descriptor(source)?;
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor.as_ptr().cast_mut().cast(), &mut control, &mut revision) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let flags = DACL_SECURITY_INFORMATION
            | if control & SE_DACL_PROTECTED != 0 { PROTECTED_DACL_SECURITY_INFORMATION } else { UNPROTECTED_DACL_SECURITY_INFORMATION };
        let path: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { SetFileSecurityW(path.as_ptr(), flags, descriptor.as_ptr().cast_mut().cast()) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    let _ = source;
    Ok(())
}
fn inspect(root: &Path, path: &str) -> GitResult<Disk> {
    let head = serde_json::to_vec(&repo::head(root)?).map_err(|e| GitError::new(e.to_string()))?;
    let full = checked_path(root, path)?;
    let mut file = fs::File::open(&full)?;
    let meta = file.metadata()?;
    if meta.len() > LIMIT as u64 {
        return Err(GitError::new("This file exceeds the editor's 2 MiB limit."));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file).take(LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    let content = String::from_utf8(bytes).map_err(|_| GitError::new("This file is not UTF-8 text. Use an external editor to preserve its encoding."))?;
    validate(&content)?;
    if serde_json::to_vec(&repo::head(root)?).map_err(|e| GitError::new(e.to_string()))? != head || checked_path(root, path)? != full {
        return Err(stale());
    }
    let token = revision(root, path, content.as_bytes(), &meta.permissions(), &head);
    Ok(Disk { full, file: Snapshot { content, revision: token }, permissions: meta.permissions(), head })
}
fn stale() -> GitError {
    GitError::new("The file or checked-out branch changed outside this editor. Your draft is kept. Reload from disk before saving.").kind("stale-file")
}
pub fn read(root: &Path, path: &str) -> GitResult<Snapshot> {
    operations::read(root, || inspect(root, path).map(|d| d.file))
}
pub fn save(root: &Path, path: &str, expected_revision: &str, content: &str) -> GitResult<Saved> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            validate(content)?;
            let disk = inspect(root, path)?;
            if disk.file.revision != expected_revision {
                return Err(stale());
            }
            if disk.permissions.readonly() {
                return Err(GitError::new("The working file is read-only. Change its permissions outside Revqora before saving."));
            }
            if disk.file.content == content {
                return Ok(Saved { file: disk.file, backup_path: None });
            }
            // Prepare a complete replacement before touching the original. Recovery
            // copies stay in portable data; the short-lived replacement must share
            // the destination directory for atomic same-filesystem rename.
            let mut temporary = super::atomic_file::new_in(disk.full.parent().ok_or_else(|| GitError::new("Invalid file directory."))?)?;
            // Apply the existing access policy before putting content in the
            // temporary file. A Windows rename otherwise inherits a broader
            // parent DACL instead of retaining a file's explicit restrictions.
            prepare_permissions(&disk.full, temporary.path(), &disk.permissions)?;
            temporary.write_all(content.as_bytes())?;
            temporary.as_file().sync_all()?;
            let backup = ops::backup_files(root, &[path.to_owned()])?;
            if inspect(root, path)?.file.revision != expected_revision {
                return Err(stale());
            }
            super::atomic_file::replace(temporary, &disk.full).map_err(|e| {
                let mut error = GitError::from(e);
                error.message = format!(
                    "Could not save {path}: {}. The original file and your draft are kept. Check write permissions or close programs that lock this file before saving again.",
                    error.message
                );
                error
            })?;
            Ok(Saved {
                file: Snapshot { content: content.into(), revision: revision(root, path, content.as_bytes(), &disk.permissions, &disk.head) },
                backup_path: Some(backup.to_string_lossy().into_owned()),
            })
        },
    )
}

#[cfg(all(test, windows))]
mod security_tests {
    use super::*;
    fn access_policy(path: &Path) -> (bool, bool, Vec<u8>) {
        use windows_sys::Win32::Security::{GetSecurityDescriptorControl, GetSecurityDescriptorDacl, SE_DACL_PROTECTED};
        let descriptor = security_descriptor(path).unwrap();
        let mut control = 0;
        let mut revision = 0;
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = std::ptr::null_mut();
        unsafe {
            assert_ne!(GetSecurityDescriptorControl(descriptor.as_ptr().cast_mut().cast(), &mut control, &mut revision), 0);
            assert_ne!(GetSecurityDescriptorDacl(descriptor.as_ptr().cast_mut().cast(), &mut present, &mut dacl, &mut defaulted), 0);
            // The self-relative descriptor may change its auto-inheritance
            // bookkeeping bit. The ACL entries and protection policy must not.
            (
                control & SE_DACL_PROTECTED != 0,
                present != 0,
                if dacl.is_null() { Vec::new() } else { std::slice::from_raw_parts(dacl.cast::<u8>(), (*dacl).AclSize as usize).to_vec() },
            )
        }
    }
    #[test]
    fn save_keeps_a_protected_windows_file_dacl() {
        use std::os::windows::process::CommandExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        super::super::runner::run(root, ["init", "-q"]).unwrap();
        let path = root.join("private.txt");
        fs::write(&path, "original").unwrap();
        let result = std::process::Command::new("icacls.exe").arg(&path).arg("/inheritance:d").creation_flags(0x08000000).output().unwrap();
        assert!(result.status.success(), "Could not prepare protected fixture ACL");
        let before = access_policy(&path);
        assert!(before.0, "The fixture must disable ACL inheritance");
        let snapshot = read(root, "private.txt").unwrap();
        save(root, "private.txt", &snapshot.revision, "edited").unwrap();
        assert_eq!(access_policy(&path), before);
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
    }
}
