use revqora_lib::git::{file_editor, runner};
use std::{fs, path::Path};

fn git(root: &Path, args: &[&str]) -> String {
    runner::run(root, args.iter().copied()).unwrap()
}
fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    for args in [
        vec!["init", "-qb", "main"],
        vec!["config", "user.name", "Editor test"],
        vec!["config", "user.email", "editor@example.invalid"],
        vec!["config", "core.autocrlf", "false"],
        vec!["config", "commit.gpgsign", "false"],
    ] {
        git(root, &args);
    }
    fs::write(root.join("file.txt"), "base\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "base"]);
    temp
}
#[test]
fn saves_exact_utf8_bytes_with_backup_without_changing_the_index_or_head() {
    let temp = fixture();
    let root = temp.path();
    fs::write(root.join("file.txt"), "prepared\n").unwrap();
    git(root, &["add", "file.txt"]);
    let original = "\u{feff}\tУкраїна\r\n\tcurrent\r\n";
    fs::write(root.join("file.txt"), original).unwrap();
    let index = fs::read(root.join(".git/index")).unwrap();
    let head = git(root, &["rev-parse", "HEAD"]);
    let loaded = file_editor::read(root, "file.txt").unwrap();
    assert_eq!(loaded.content, original);
    let latest = "\u{feff}    Україна\r\n    edited without a final newline";
    let saved = file_editor::save(root, "file.txt", &loaded.revision, latest).unwrap();
    assert_eq!(fs::read(root.join("file.txt")).unwrap(), latest.as_bytes());
    let backup = std::path::PathBuf::from(saved.backup_path.unwrap());
    assert_eq!(fs::read(backup.join("file.txt")).unwrap(), original.as_bytes());
    assert!(!backup.starts_with(root));
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(git(root, &["show", ":file.txt"]), "prepared\n");
    assert_eq!(git(root, &["rev-parse", "HEAD"]), head);
    assert_eq!(saved.file.revision, file_editor::read(root, "file.txt").unwrap().revision);
    assert!(file_editor::save(root, "file.txt", &saved.file.revision, latest).unwrap().backup_path.is_none());
    assert_eq!(fs::read_dir(root).unwrap().count(), 2, "No atomic temporary file may remain in the repository");
}
#[test]
fn external_edits_and_even_a_same_commit_branch_checkout_reject_the_old_draft() {
    let temp = fixture();
    let root = temp.path();
    let loaded = file_editor::read(root, "file.txt").unwrap();
    fs::write(root.join("file.txt"), "IDE changes\n").unwrap();
    assert_eq!(file_editor::save(root, "file.txt", &loaded.revision, "old draft").err().unwrap().kind, "stale-file");
    assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "IDE changes\n");
    let loaded = file_editor::read(root, "file.txt").unwrap();
    git(root, &["switch", "-c", "other"]);
    assert_eq!(file_editor::save(root, "file.txt", &loaded.revision, "wrong branch").err().unwrap().kind, "stale-file");
    assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "IDE changes\n");
}
#[test]
fn metadata_escape_binary_oversized_and_nested_repository_paths_cannot_be_written() {
    let temp = fixture();
    let root = temp.path();
    let config = fs::read(root.join(".git/config")).unwrap();
    for path in ["../file.txt", ".git/config", "sub/../file.txt", ""] {
        assert!(file_editor::read(root, path).is_err());
        assert!(file_editor::save(root, path, "none", "changed").is_err());
    }
    assert_eq!(fs::read(root.join(".git/config")).unwrap(), config);
    fs::write(root.join("binary"), [0, 1, 2]).unwrap();
    assert!(file_editor::read(root, "binary").is_err());
    fs::write(root.join("encoding"), [0xff, 0xfe, 0x20, 0]).unwrap();
    assert!(file_editor::read(root, "encoding").is_err());
    fs::write(root.join("large"), vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
    assert!(file_editor::read(root, "large").is_err());
    fs::create_dir(root.join("nested")).unwrap();
    git(&root.join("nested"), &["init", "-q"]);
    fs::write(root.join("nested/file.txt"), "child work").unwrap();
    assert!(file_editor::read(root, "nested/file.txt").is_err());
    let loaded = file_editor::read(root, "file.txt").unwrap();
    assert!(file_editor::save(root, "file.txt", &loaded.revision, "nul\0content").is_err());
    assert!(file_editor::save(root, "file.txt", &loaded.revision, &"x".repeat(2 * 1024 * 1024 + 1)).is_err());
    assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "base\n");
}
#[test]
fn read_only_files_are_kept_and_permissions_survive_save() {
    let temp = fixture();
    let root = temp.path();
    let path = root.join("file.txt");
    let original = fs::metadata(&path).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let loaded = file_editor::read(root, "file.txt").unwrap();
    assert!(file_editor::save(root, "file.txt", &loaded.revision, "changed").is_err());
    fs::set_permissions(&path, original).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "base\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mode = fs::metadata(&path).unwrap().permissions();
    let loaded = file_editor::read(root, "file.txt").unwrap();
    file_editor::save(root, "file.txt", &loaded.revision, "new\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(mode.mode(), fs::metadata(&path).unwrap().permissions().mode());
    }
    #[cfg(windows)]
    assert_eq!(mode.readonly(), fs::metadata(&path).unwrap().permissions().readonly());
}
#[cfg(unix)]
#[test]
fn links_to_files_and_directories_are_never_followed() {
    use std::os::unix::fs::symlink;
    let temp = fixture();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), "outside").unwrap();
    symlink(outside.path().join("secret"), temp.path().join("link")).unwrap();
    symlink(outside.path(), temp.path().join("folder")).unwrap();
    for path in ["link", "folder/secret"] {
        assert!(file_editor::read(temp.path(), path).is_err());
        assert!(file_editor::save(temp.path(), path, "none", "changed").is_err());
    }
    assert_eq!(fs::read_to_string(outside.path().join("secret")).unwrap(), "outside");
}
#[cfg(windows)]
#[test]
fn a_locking_reader_cannot_destroy_the_original_or_change_staging() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = fixture();
    let root = temp.path();
    let path = root.join("file.txt");
    let index = fs::read(root.join(".git/index")).unwrap();
    let loaded = file_editor::read(root, "file.txt").unwrap();
    let reader = fs::OpenOptions::new().read(true).share_mode(3).open(&path).unwrap();
    let error = file_editor::save(root, "file.txt", &loaded.revision, "draft\n").err().expect("A handle denying delete sharing must block replacement");
    assert!(error.message.contains("original file and your draft are kept"), "{error:?}");
    assert!(error.details.iter().any(|d| d == "os_error=5" || d == "os_error=32"), "{error:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "base\n");
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read_dir(root).unwrap().count(), 2, "A failed save must remove its temporary file");
    drop(reader);
    file_editor::save(root, "file.txt", &loaded.revision, "draft\n").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "draft\n");
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
}
#[cfg(windows)]
#[test]
fn directory_junctions_and_alternate_streams_are_rejected() {
    use std::os::windows::process::CommandExt;
    let temp = fixture();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("file.txt"), "outside").unwrap();
    let status = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(temp.path().join("junction"))
        .arg(outside.path())
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
    let config = fs::read(temp.path().join(".git/config")).unwrap();
    for path in ["junction/file.txt", "file.txt:stream", ".git./config", ".git /config"] {
        assert!(file_editor::read(temp.path(), path).is_err());
        assert!(file_editor::save(temp.path(), path, "none", "changed").is_err());
    }
    assert_eq!(fs::read(temp.path().join(".git/config")).unwrap(), config);
    assert_eq!(fs::read_to_string(outside.path().join("file.txt")).unwrap(), "outside");
}
