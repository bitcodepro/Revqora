use revqora_lib::git::{commit, extras, runner};
use std::fs;
use std::path::PathBuf;

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Preview проверка");
        fs::create_dir(&root).unwrap();
        let r = Self { _temp: temp, root };
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.autocrlf", "false"],
            vec!["config", "core.hooksPath", ".git/hooks"],
        ] {
            r.git(&args);
        }
        r
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(&self.root, args).unwrap().trim().into()
    }
    fn commit(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-qm", message]);
        self.git(&["rev-parse", "HEAD"])
    }
}

#[test]
fn one_diff_preserves_root_rename_binary_and_unusual_paths_without_index_writes() {
    let r = Repo::new();
    fs::write(r.root.join("original файл.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
    fs::write(r.root.join("binary.bin"), [0, 1, 2]).unwrap();
    let root = r.commit("Root");
    let first = commit::details(&r.root, &root).unwrap();
    assert_eq!(first.files.len(), 2);
    assert_eq!(first.files.iter().find(|f| f.path == "original файл.txt").unwrap().additions, Some(5));
    fs::rename(r.root.join("original файл.txt"), r.root.join("renamed файл.txt")).unwrap();
    fs::write(r.root.join("renamed файл.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
    fs::write(r.root.join("binary.bin"), [0, 3, 4, 5]).unwrap();
    #[cfg(unix)]
    let odd = "colon:name\twith\nnewline.txt";
    #[cfg(windows)]
    let odd = "space and 'quote'.txt";
    fs::write(r.root.join(odd), "new\n").unwrap();
    let tip = r.commit("Rename and binary");
    let before = fs::read(r.root.join(".git/index")).unwrap();
    let d = commit::details(&r.root, &tip).unwrap();
    assert_eq!(d.files.len(), 3);
    let rename = d.files.iter().find(|f| f.status == "R").unwrap();
    assert_eq!(rename.old_path.as_deref(), Some("original файл.txt"));
    assert_eq!(rename.path, "renamed файл.txt");
    assert_eq!((rename.additions, rename.deletions), (Some(1), Some(0)));
    let binary = d.files.iter().find(|f| f.path == "binary.bin").unwrap();
    assert!(binary.binary);
    assert_eq!(binary.additions, None);
    let unusual = d.files.iter().find(|f| f.path == odd).unwrap();
    assert_eq!((unusual.additions, unusual.deletions), (Some(1), Some(0)));
    assert_eq!(fs::read(r.root.join(".git/index")).unwrap(), before);
    fs::remove_file(r.root.join(odd)).unwrap();
    let deleted = r.commit("Delete unusual path");
    let removal = commit::details(&r.root, &deleted).unwrap();
    assert_eq!(removal.files.len(), 1);
    assert_eq!(removal.files[0].status, "D");
    assert_eq!((removal.files[0].additions, removal.files[0].deletions), (Some(0), Some(1)));
    r.git(&["branch", "side", &root]);
    r.git(&["checkout", "-q", "side"]);
    fs::write(r.root.join("side.txt"), "side\n").unwrap();
    r.commit("Side");
    r.git(&["checkout", "-q", "main"]);
    r.git(&["merge", "--no-ff", "-qm", "Merge", "side"]);
    let merge = commit::details(&r.root, "HEAD").unwrap();
    assert_eq!(merge.parents.len(), 2);
    assert_eq!(merge.files.len(), 1);
    assert_eq!(merge.files[0].path, "side.txt");
    assert_eq!(merge.diff_base.as_deref(), Some(deleted.as_str()));
}

#[test]
fn preview_never_verifies_signatures_even_when_git_enables_show_signature() {
    let r = Repo::new();
    fs::write(r.root.join("file.txt"), "content\n").unwrap();
    let tip = r.commit("Unsigned");
    let raw = runner::run(&r.root, ["cat-file", "commit", &tip]).unwrap();
    let (headers, body) = raw.split_once("\n\n").unwrap();
    let signed = format!("{headers}\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n{body}");
    let oid = runner::run_env(&r.root, ["hash-object", "-t", "commit", "-w", "--stdin"], &[], Some(signed.as_bytes())).unwrap();
    let verifier = r.root.join("verify.sh");
    fs::write(&verifier, "#!/bin/sh\nprintf attempted > .git/verification-started\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&verifier, fs::Permissions::from_mode(0o755)).unwrap();
    }
    r.git(&["config", "gpg.format", "openpgp"]);
    r.git(&["config", "gpg.program", verifier.to_str().unwrap()]);
    r.git(&["config", "log.showSignature", "true"]);
    let d = commit::details(&r.root, oid.trim()).unwrap();
    assert_eq!(d.subject, "Unsigned");
    assert_eq!(d.files.len(), 1);
    assert!(!r.root.join(".git/verification-started").exists());
    extras::signature(&r.root, oid.trim()).unwrap();
    assert!(r.root.join(".git/verification-started").exists());
}
