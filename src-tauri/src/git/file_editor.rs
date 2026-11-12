//! Index-preserving working-file edits with conflict-safe publication.
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

pub(super) fn checked_path(root: &Path, path: &str) -> GitResult<PathBuf> {
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
    save_at_boundary(root, path, expected_revision, content, |_| {})
}
fn save_at_boundary(root: &Path, path: &str, expected_revision: &str, content: &str, mut boundary: impl FnMut(&str)) -> GitResult<Saved> {
    operations::access(
        root,
        true,
        |_, _| {},
        || {
            validate(content)?;
            #[cfg(windows)]
            let mut locked = {
                use std::os::windows::fs::OpenOptionsExt;
                use std::os::windows::io::AsRawHandle;
                use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
                // Windows enforces sharing against ordinary writes AND atomic
                // replacement, including handles opened before this one. Keep
                // this handle through validation, backup, write and sync.
                let file = fs::OpenOptions::new().read(true).write(true).share_mode(1).open(checked_path(root, path)?).map_err(save_error)?;
                let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
                if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                if unsafe { info.assume_init() }.nNumberOfLinks != 1 {
                    return Err(GitError::new("Files with hard links require an external editor so other linked paths cannot be changed accidentally."));
                }
                file
            };
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
            // POSIX publication uses a prepared file in the destination directory.
            // The original inode is kept separately in portable recovery.
            #[cfg(not(windows))]
            let temporary = {
                let mut temporary = super::atomic_file::new_in(disk.full.parent().ok_or_else(|| GitError::new("Invalid file directory."))?)?;
                // Apply the existing mode before putting content in the file.
                prepare_permissions(&disk.full, temporary.path(), &disk.permissions)?;
                temporary.write_all(content.as_bytes())?;
                temporary.as_file().sync_all()?;
                temporary
            };
            if inspect(root, path)?.file.revision != expected_revision {
                return Err(stale());
            }
            let trash = super::storage::dir(root)?.join("trash");
            fs::create_dir_all(&trash)?;
            let folder = tempfile::Builder::new().prefix("editor-").tempdir_in(&trash)?;
            let preserved = folder.path().join(path);
            fs::create_dir_all(preserved.parent().unwrap())?;
            #[cfg(windows)]
            let backup = {
                use std::io::Seek;
                // Copy the validated bytes while the OS excludes all other
                // writers. Do not use CopyFile, whose sharing mode can conflict
                // with our write handle. Preserve source access restrictions.
                let mut copy = fs::OpenOptions::new().create_new(true).write(true).open(&preserved)?;
                prepare_permissions(&disk.full, &preserved, &disk.permissions)?;
                copy.write_all(disk.file.content.as_bytes())?;
                copy.sync_all()?;
                let backup = folder.keep();
                boundary("before-write");
                // Use the SAME locked handle. Closing it for a path-based
                // rename would reopen the external-writer race.
                let result = (|| -> std::io::Result<()> {
                    locked.rewind()?;
                    locked.write_all(content.as_bytes())?;
                    locked.set_len(content.len() as u64)?;
                    locked.sync_all()
                })();
                result.map_err(|e| recovery_error(GitError::from(e), &backup))?;
                backup
            };
            #[cfg(not(windows))]
            let backup = {
                // POSIX advisory locks do not exclude IDEs. Atomically detach
                // the actual current inode into portable recovery, then publish
                // ONLY into an absent name. Open external writers retain their
                // inode in recovery; an external replacement is never clobbered.
                boundary("before-write");
                fs::rename(&disk.full, &preserved).map_err(|e| {
                    let cross_device = e.kind() == std::io::ErrorKind::CrossesDevices;
                    let mut error = save_error(e);
                    if cross_device {
                        error
                            .message
                            .push_str(" Safe saving requires the recovery folder and repository on the same filesystem; otherwise use an external editor.");
                    }
                    error
                })?;
                let backup = folder.keep();
                boundary("after-capture");
                let result = (|| -> GitResult<()> {
                    let metadata = fs::symlink_metadata(&preserved)?;
                    if ops::path_is_link(&metadata) || !metadata.is_file() {
                        return Err(stale());
                    }
                    let mut bytes = Vec::new();
                    fs::File::open(&preserved)?.take(LIMIT as u64 + 1).read_to_end(&mut bytes)?;
                    let head = serde_json::to_vec(&repo::head(root)?).map_err(|e| GitError::new(e.to_string()))?;
                    if revision(root, path, &bytes, &metadata.permissions(), &head) != expected_revision {
                        return Err(stale());
                    }
                    temporary.persist_noclobber(&disk.full).map_err(|e| GitError::from(e.error))?;
                    Ok(())
                })();
                if let Err(error) = result {
                    return Err(restore_capture(error, &preserved, &disk.full, &backup));
                }
                backup
            };
            Ok(Saved {
                file: Snapshot { content: content.into(), revision: revision(root, path, content.as_bytes(), &disk.permissions, &disk.head) },
                backup_path: Some(backup.to_string_lossy().into_owned()),
            })
        },
    )
}

#[cfg(not(windows))]
fn restore_capture(mut error: GitError, preserved: &Path, destination: &Path, backup: &Path) -> GitError {
    let metadata = fs::symlink_metadata(preserved);
    let directory = metadata.as_ref().is_ok_and(fs::Metadata::is_dir);
    let restored = metadata.and_then(|_| if directory { rename_directory_noclobber(preserved, destination) } else { fs::hard_link(preserved, destination) });
    match restored {
        Ok(()) if directory => {
            // Only remove empty recovery directories created by this save.
            for parent in preserved.ancestors().skip(1).take_while(|path| path.starts_with(backup)) {
                if fs::remove_dir(parent).is_err() {
                    break;
                }
            }
            error.message.push_str(" The directory was restored to its working-tree path.");
            error
        }
        Ok(()) => recovery_error(error, backup),
        Err(restore_error) => {
            error.message.push_str(&format!(" Could not restore the captured item to {}: {restore_error}.", destination.display()));
            error.details.push(format!("restore-error={restore_error}"));
            recovery_error(error, backup)
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_directory_noclobber(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    // The kernel checks destination absence as part of the rename. A separate
    // existence check would let another process create a directory in between.
    #[cfg(target_os = "linux")]
    let result = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, source.as_ptr(), libc::AT_FDCWD, destination.as_ptr(), libc::RENAME_NOREPLACE) };
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn rename_directory_noclobber(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "No safe directory rename is available on this platform"))
}

fn save_error(error: std::io::Error) -> GitError {
    let mut error = GitError::from(error);
    error.message = format!(
        "Could not save: {}. The original file and your draft are kept. Check permissions or close another editor's write handle before saving again.",
        error.message
    );
    error
}
fn recovery_error(mut error: GitError, backup: &Path) -> GitError {
    error
        .message
        .push_str(&format!(" Your draft is kept. The captured item is retained in recovery: {}. Inspect the working path before retrying.", backup.display()));
    error.details.push(format!("backup-path={}", backup.display()));
    error
}

#[cfg(test)]
mod race_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn checkout_directory_during_save(destination_recreated: bool) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let git = |args: &[&str]| super::super::runner::run(root, args.iter().copied()).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Editor test"]);
        git(&["config", "user.email", "editor@example.invalid"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&["config", "core.hooksPath", ".git/hooks"]);
        let path = root.join("item");
        fs::write(&path, "original").unwrap();
        git(&["add", "item"]);
        git(&["commit", "-qm", "regular file"]);
        git(&["switch", "-qc", "directory"]);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("nested.txt"), "checked-out content").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "directory"]);
        git(&["switch", "-q", "main"]);
        let loaded = read(root, "item").unwrap();
        let mut competing_inode = None;
        let error = save_at_boundary(root, "item", &loaded.revision, "editor draft", |phase| {
            if phase == "before-write" {
                git(&["switch", "-q", "directory"]);
            } else if phase == "after-capture" && destination_recreated {
                // Plain rename could silently replace this empty directory.
                use std::os::unix::fs::MetadataExt;
                fs::create_dir(&path).unwrap();
                competing_inode = Some(fs::metadata(&path).unwrap().ino());
            }
        })
        .err()
        .expect("A checkout replaced the file with a directory");
        assert_eq!(error.kind, "stale-file");
        assert_eq!(git(&["branch", "--show-current"]).trim(), "directory");
        if let Some(inode) = competing_inode {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
            assert!(error.message.contains("Could not restore the captured item"));
            assert!(error.details.iter().any(|detail| detail.starts_with("restore-error=")));
            let backup = error.details.iter().find_map(|detail| detail.strip_prefix("backup-path=")).unwrap();
            assert_eq!(fs::read_to_string(Path::new(backup).join("item/nested.txt")).unwrap(), "checked-out content");
        } else {
            assert!(!destination_recreated, "The save must reach the capture boundary");
            assert!(error.message.contains("The directory was restored"));
            assert_eq!(fs::read_to_string(path.join("nested.txt")).unwrap(), "checked-out content");
            assert!(git(&["status", "--porcelain"]).trim().is_empty());
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_checkout_to_a_directory_is_restored_on_stale_save() {
        checkout_directory_during_save(false);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn directory_rollback_keeps_a_competing_empty_directory_and_reports_recovery() {
        checkout_directory_during_save(true);
    }

    #[test]
    fn external_write_and_replace_at_the_final_save_boundary_cannot_be_lost() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        super::super::runner::run(root, ["init", "-q"]).unwrap();
        let path = root.join("file.txt");
        fs::write(&path, "original").unwrap();
        let loaded = read(root, "file.txt").unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let worker_barrier = barrier.clone();
        let external_path = path.clone();
        let worker = std::thread::spawn(move || {
            worker_barrier.wait();
            let write = fs::write(&external_path, "IDE in-place");
            let replacement = external_path.with_file_name("replacement.txt");
            fs::write(&replacement, "IDE replacement").unwrap();
            let replace = fs::rename(&replacement, &external_path);
            worker_barrier.wait();
            (write, replace)
        });
        let saved = save_at_boundary(root, "file.txt", &loaded.revision, "editor draft", |phase| {
            if phase == "before-write" {
                barrier.wait();
                barrier.wait();
            }
        });
        let (write, replace) = worker.join().unwrap();
        #[cfg(windows)]
        {
            assert!(write.is_err() && replace.is_err(), "The held OS handle must exclude BOTH competing write methods");
            let saved = saved.unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), "editor draft");
            assert_eq!(fs::read_to_string(PathBuf::from(saved.backup_path.unwrap()).join("file.txt")).unwrap(), "original");
        }
        #[cfg(not(windows))]
        {
            write.unwrap();
            replace.unwrap();
            let error = saved.err().unwrap();
            assert_eq!(error.kind, "stale-file");
            assert_eq!(fs::read_to_string(&path).unwrap(), "IDE replacement");
            let backup = error.details.iter().find_map(|d| d.strip_prefix("backup-path=")).unwrap();
            assert_eq!(fs::read_to_string(Path::new(backup).join("file.txt")).unwrap(), "IDE replacement");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn an_external_file_created_after_capture_is_never_overwritten_or_rolled_back() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        super::super::runner::run(root, ["init", "-q"]).unwrap();
        let path = root.join("file.txt");
        fs::write(&path, "original").unwrap();
        let loaded = read(root, "file.txt").unwrap();
        let error = save_at_boundary(root, "file.txt", &loaded.revision, "editor draft", |phase| {
            if phase == "after-capture" {
                fs::write(&path, "IDE recreated file").unwrap();
            }
        })
        .err()
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "IDE recreated file");
        let backup = error.details.iter().find_map(|d| d.strip_prefix("backup-path=")).unwrap();
        assert_eq!(fs::read_to_string(Path::new(backup).join("file.txt")).unwrap(), "original");
    }
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
