//! Revqora-owned repository files live beside the executable, never in `.git`.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use sha2::{Digest, Sha256};

use super::{operations, repo, runner::GitResult};

fn directory(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir()) {
        return Err(io::Error::other("Revqora storage cannot be a link or a file."));
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn digest(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(hash.finalize().to_vec())
}

// Copy atomically across volumes, verify before removing the old file, and never
// overwrite a different destination. Interrupted migrations can resume safely.
fn migrate(source: &Path, target: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(source) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() {
        return Err(io::Error::other("Legacy Revqora storage contains a link; it was preserved."));
    }
    if meta.is_dir() {
        directory(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            migrate(&entry.path(), &target.join(entry.file_name()))?;
        }
        fs::remove_dir(source)?;
    } else if meta.is_file() {
        if fs::symlink_metadata(target).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err(io::Error::other("Unsafe migration destination; old data was preserved."));
        }
        if !target.exists() {
            let mut copy = tempfile::NamedTempFile::new_in(target.parent().unwrap())?;
            io::copy(&mut File::open(source)?, &mut copy)?;
            copy.as_file().sync_all()?;
            copy.persist_noclobber(target).map_err(|e| e.error)?;
        }
        if digest(source)? != digest(target)? {
            return Err(io::Error::other("Revqora storage migration found different copies; both were preserved."));
        }
        fs::remove_file(source)?;
    } else {
        return Err(io::Error::other("Unsupported legacy storage entry; it was preserved."));
    }
    Ok(())
}

fn location(git_dir: &Path) -> io::Result<PathBuf> {
    let canonical = fs::canonicalize(git_dir).unwrap_or_else(|_| git_dir.to_owned());
    #[cfg(windows)]
    let canonical = PathBuf::from(canonical.to_string_lossy().to_lowercase());
    let git_dir = canonical.as_path();
    let parent = crate::portable::runtime_dir()?.join("repositories");
    directory(&parent)?;
    let key = format!("{:x}", Sha256::digest(git_dir.as_os_str().as_encoded_bytes()));
    let target = parent.join(key);
    directory(&target)?;
    static MIGRATED: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashSet<PathBuf>>> = std::sync::OnceLock::new();
    let migrated = MIGRATED.get_or_init(Default::default);
    if migrated.lock().contains(&target) {
        return Ok(target);
    }
    let lock_path = target.join(".storage.lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(io::Error::other("Revqora storage lock cannot be a link."));
    }
    let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(lock_path)?;
    lock.lock_exclusive()?;
    migrate(&git_dir.join("revqora"), &target)?;
    migrate(&git_dir.join("revqora-squash"), &target.join("squash-target"))?;
    migrated.lock().insert(target.clone());
    Ok(target)
}

/// Per-worktree state (messages, temporary indexes, bisect notes, discard backups).
pub fn dir(root: &Path) -> GitResult<PathBuf> {
    let gd = repo::git_dir(root)?;
    Ok(location(&fs::canonicalize(&gd).unwrap_or(gd))?)
}

/// Checkpoints are shared by all linked worktrees of a repository.
pub fn common(root: &Path) -> GitResult<PathBuf> {
    Ok(location(&operations::repository_key(root))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_repository_files_move_to_portable_storage() {
        let tmp = tempfile::tempdir().unwrap();
        super::super::runner::run(tmp.path(), ["init", "-q"]).unwrap();
        let gd = tmp.path().join(".git");
        fs::create_dir_all(gd.join("revqora/trash/old")).unwrap();
        fs::write(gd.join("revqora/trash/old/file.txt"), b"old discarded bytes").unwrap();
        fs::write(gd.join("revqora/deleted-branches.json"), b"[]").unwrap();
        fs::write(gd.join("revqora-squash"), "feature/old").unwrap();
        let portable = dir(tmp.path()).unwrap();
        assert!(portable.starts_with(crate::portable::runtime_dir().unwrap()));
        assert_eq!(fs::read(portable.join("trash/old/file.txt")).unwrap(), b"old discarded bytes");
        assert_eq!(fs::read(portable.join("squash-target")).unwrap(), b"feature/old");
        assert!(!gd.join("revqora").exists());
        assert!(!gd.join("revqora-squash").exists());
        assert_eq!(common(tmp.path()).unwrap(), portable);
        assert_eq!(dir(tmp.path()).unwrap(), portable);
    }

    #[test]
    fn migration_resumes_and_preserves_conflicting_data() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        fs::create_dir_all(old.join("recovery/cp-test")).unwrap();
        fs::write(old.join("recovery/cp-test/bytes"), b"private\0\r\n").unwrap();
        migrate(&old, &new).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read(new.join("recovery/cp-test/bytes")).unwrap(), b"private\0\r\n");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("note"), "original").unwrap();
        fs::write(new.join("note"), "different").unwrap();
        assert!(migrate(&old, &new).is_err());
        assert_eq!(fs::read(old.join("note")).unwrap(), b"original");
        assert_eq!(fs::read(new.join("note")).unwrap(), b"different");
        fs::write(new.join("note"), "original").unwrap();
        migrate(&old, &new).unwrap();
        assert!(!old.exists());
    }
}
