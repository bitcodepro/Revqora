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

/// Git runs without a console of its own (it starts faster). The programs a hook starts must
/// still get no visible console window: PowerShell started by a pre-commit hook reports whether
/// it has one, and cmd.exe runs as well.
#[cfg(windows)]
#[test]
fn programs_a_hook_starts_get_no_visible_console_window() {
    use revqora_lib::git::ops;
    let dir = repo();
    let root = dir.path();
    for (key, value) in [("user.name", "T"), ("user.email", "t@example.invalid"), ("commit.gpgsign", "false")] {
        runner::run(root, ["config", key, value]).unwrap();
    }
    let probe = root.join(".git").join("probe.ps1");
    fs::write(
        &probe,
        r#"$w = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);' -Name Window -Namespace Probe -PassThru
$h = $w::GetConsoleWindow()
"visible=$($h -ne [System.IntPtr]::Zero -and $w::IsWindowVisible($h))"
"#,
    )
    .unwrap();
    let report = root.join(".git").join("report.txt");
    let unix = |path: &std::path::Path| path.to_string_lossy().replace('\\', "/");
    let hook = format!(
        "#!/bin/sh\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '{}' > '{}' 2>&1\ncmd.exe //c \"echo cmd-ran\" >> '{}'\n",
        unix(&probe),
        unix(&report),
        unix(&report)
    );
    fs::write(root.join(".git/hooks/pre-commit"), hook).unwrap();
    fs::write(root.join("a.txt"), "a\n").unwrap();
    ops::stage_paths(root, &["a.txt".to_owned()]).unwrap();
    ops::commit(root, "with a hook", &ops::CommitOptions::default()).unwrap();
    let report = fs::read_to_string(&report).unwrap();
    assert!(report.contains("visible=False"), "{report}");
    assert!(report.contains("cmd-ran"), "{report}");
}
