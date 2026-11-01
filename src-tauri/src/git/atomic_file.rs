//! Atomic state replacement while readers retain a snapshot of the old file.
//! tempfile::persist uses only MoveFileExW on Windows. std::fs::rename (already
//! in Rust 1.90) also supports FileRenameInfoEx with POSIX replacement semantics.
use std::{
    fs::{self, OpenOptions},
    io,
    path::Path,
};
use tempfile::NamedTempFile;

pub(super) fn new_in(parent: &Path) -> io::Result<NamedTempFile> {
    if !parent.is_absolute() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Atomic state storage requires an absolute directory."));
    }
    tempfile::Builder::new().make_in(parent, |path| {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Normal attributes from creation: a renamed file must not retain
        // FILE_ATTRIBUTE_TEMPORARY. Keep the normal tempfile cleanup owner.
        options.open(path)
    })
}

/// The caller writes/validates all bytes and syncs the file before replacement.
/// Both names must be in one directory. Never delete/truncate the destination,
/// copy across volumes, or retry after failure. On success Drop only attempts
/// cleanup of the old temporary name, which no longer exists.
pub(super) fn replace(temporary: NamedTempFile, destination: &Path) -> io::Result<()> {
    if !destination.is_absolute() || temporary.path().parent() != destination.parent() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Atomic state replacement requires the same absolute directory."));
    }
    fs::rename(temporary.path(), destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::File,
        io::{Read, Write},
    };
    fn prepared(dir: &Path, text: &str) -> NamedTempFile {
        let mut file = new_in(dir).unwrap();
        file.write_all(text.as_bytes()).unwrap();
        file.as_file().sync_all().unwrap();
        file
    }
    #[test]
    fn replacement_retains_old_reader_and_publishes_complete_new_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state — Україна.json");
        replace(prepared(dir.path(), "{\"phase\":\"running\"}"), &path).unwrap();
        let mut reader = File::open(&path).unwrap();
        replace(prepared(dir.path(), "{\"phase\":\"completed\",\"output\":\"done\"}"), &path)
            .expect("An open reader sharing deletion must not prevent atomic replacement");
        let mut old = String::new();
        reader.read_to_string(&mut old).unwrap();
        assert_eq!(old, "{\"phase\":\"running\"}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"phase\":\"completed\",\"output\":\"done\"}");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[cfg(windows)]
    #[test]
    fn a_handle_denying_delete_sharing_keeps_previous_state_and_cleans_temporary() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        replace(prepared(dir.path(), "previous"), &path).unwrap();
        let reader = OpenOptions::new().read(true).share_mode(3).open(&path).unwrap();
        let replacement = prepared(dir.path(), "next");
        let source = replacement.path().to_owned();
        let error = replace(replacement, &path).expect_err("A reader denying delete sharing must still protect the destination");
        assert!(matches!(error.raw_os_error(), Some(5 | 32)), "Unexpected replacement error: {error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "previous");
        assert!(!source.exists());
        drop(reader);
    }
    #[test]
    fn a_different_parent_is_rejected_without_touching_the_destination() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let path = target.path().join("state.json");
        fs::write(&path, "previous").unwrap();
        let file = prepared(source.path(), "next");
        let temp = file.path().to_owned();
        assert_eq!(replace(file, &path).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        assert_eq!(fs::read_to_string(&path).unwrap(), "previous");
        assert!(!temp.exists());
    }
    #[cfg(windows)]
    #[test]
    fn state_files_never_inherit_temporary_attributes() {
        use std::os::windows::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let file = prepared(dir.path(), "state");
        assert_eq!(file.as_file().metadata().unwrap().file_attributes() & 0x100, 0);
    }
    #[cfg(unix)]
    #[test]
    fn state_files_remain_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(prepared(dir.path(), "state").as_file().metadata().unwrap().permissions().mode() & 0o077, 0);
    }
}
