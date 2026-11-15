//! Installed Git hooks: where Git looks for them (core.hooksPath or the hooks folder) and which
//! of the known hook names are present and would run.
use std::path::Path;

use serde::Serialize;

use super::runner::{self, GitResult};

/// Hook names Git runs (githooks(5)).
pub const KNOWN_HOOKS: &[&str] = &[
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "fsmonitor-watchman",
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
    "post-index-change",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    pub name: String,
    /// Absolute path of the hook file.
    pub path: String,
    /// Git runs it (on Unix only files with the executable bit; on Windows any file).
    pub active: bool,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hooks {
    /// The folder Git reads hooks from.
    pub dir: String,
    /// Set by core.hooksPath (shared or tool-managed hooks), not the repository's own folder.
    pub custom_path: Option<String>,
    pub hooks: Vec<Hook>,
}

pub fn list(repo: &Path) -> GitResult<Hooks> {
    let rel = runner::run(repo, ["rev-parse", "--git-path", "hooks"])?;
    let rel = rel.trim();
    let dir = if Path::new(rel).is_absolute() { Path::new(rel).to_path_buf() } else { repo.join(rel) };
    let custom_path = runner::run(repo, ["config", "--get", "core.hooksPath"]).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let mut hooks = Vec::new();
    for name in KNOWN_HOOKS {
        let path = dir.join(name);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        hooks.push(Hook { name: (*name).to_string(), path: path.to_string_lossy().into_owned(), active: runs(&meta), size: meta.len() });
    }
    Ok(Hooks { dir: dir.to_string_lossy().into_owned(), custom_path, hooks })
}

#[cfg(unix)]
fn runs(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
fn runs(_meta: &std::fs::Metadata) -> bool {
    true
}
