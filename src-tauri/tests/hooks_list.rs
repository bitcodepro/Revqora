//! Installed hooks are listed from the hooks folder or core.hooksPath; samples are not hooks.
use std::fs;

use revqora_lib::git::{hooks, runner};

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    runner::run(dir.path(), ["init", "-q", "-b", "main"]).unwrap();
    dir
}

#[test]
fn lists_real_hooks_only() {
    let dir = repo();
    let root = dir.path();
    let hooks_dir = root.join(".git/hooks");
    fs::create_dir_all(&hooks_dir).unwrap();
    fs::write(hooks_dir.join("pre-commit"), "#!/bin/sh\nexit 0\n").unwrap();
    fs::write(hooks_dir.join("not-a-hook"), "x").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(hooks_dir.join("pre-commit"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(hooks_dir.join("pre-push"), "#!/bin/sh\n").unwrap(); // not executable: Git skips it
    }
    let h = hooks::list(root).unwrap();
    assert!(h.custom_path.is_none());
    let names: Vec<_> = h.hooks.iter().map(|x| x.name.as_str()).collect();
    assert!(names.contains(&"pre-commit"));
    assert!(!names.iter().any(|n| n.ends_with(".sample") || *n == "not-a-hook"), "{names:?}");
    assert!(h.hooks.iter().find(|x| x.name == "pre-commit").unwrap().active);
    #[cfg(unix)]
    assert!(!h.hooks.iter().find(|x| x.name == "pre-push").unwrap().active);
}

#[test]
fn follows_core_hooks_path() {
    let dir = repo();
    let root = dir.path();
    fs::create_dir_all(root.join("tools/hooks")).unwrap();
    fs::write(root.join("tools/hooks/commit-msg"), "#!/bin/sh\n").unwrap();
    runner::run(root, ["config", "core.hooksPath", "tools/hooks"]).unwrap();
    let h = hooks::list(root).unwrap();
    assert_eq!(h.custom_path.as_deref(), Some("tools/hooks"));
    assert_eq!(h.hooks.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["commit-msg"]);
}
