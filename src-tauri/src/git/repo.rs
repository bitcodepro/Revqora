//! Repository discovery and in-progress operation state.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::runner::{self, GitError, GitResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub detached: bool,
    pub unborn: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpState {
    /// "none" | "merge" | "squash" | "rebase" | "cherry-pick" | "revert" | "am" | "bisect"
    pub kind: String,
    /// The commit being merged / picked / reverted.
    pub incoming: Option<String>,
    /// Human label for the incoming side ("feature/login", "abc1234 Fix bug").
    pub incoming_label: Option<String>,
    pub message: Option<String>,
    pub step: Option<u32>,
    pub total: Option<u32>,
    /// For rebase: the branch being rebased and the commit it is replayed onto.
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub stopped_at: Option<String>,
    /// Git's amend marker distinguishes an Edit stop from a picked conflict.
    pub editing_commit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub git_dir: String,
    pub common_dir: String,
    pub name: String,
    pub head: HeadInfo,
    pub state: OpState,
    pub is_bare: bool,
}

pub fn discover(path: &Path) -> GitResult<PathBuf> {
    if !path.exists() {
        return Err(GitError::new(format!("Folder does not exist: {}", path.display())).kind("not-a-repo"));
    }
    let out = runner::exec(path, ["rev-parse", "--show-toplevel"])?;
    if !out.ok() {
        return Err(GitError::new(format!("{} is not inside a Git repository.", path.display())).kind("not-a-repo"));
    }
    let top = out.text().trim().to_string();
    Ok(normalize(PathBuf::from(top)))
}

/// Normalizes paths returned by git (forward slashes on Windows) into native form.
pub fn normalize(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(p.to_string_lossy().replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        p
    }
}

pub fn git_dir(repo: &Path) -> GitResult<PathBuf> {
    let s = runner::run(repo, ["rev-parse", "--absolute-git-dir"])?;
    Ok(normalize(PathBuf::from(s.trim())))
}

pub fn head(repo: &Path) -> GitResult<HeadInfo> {
    let sym = runner::exec(repo, ["symbolic-ref", "-q", "--short", "HEAD"])?;
    let branch = if sym.ok() { Some(sym.text().trim().to_string()) } else { None };
    let oid_out = runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD^{commit}"])?;
    let oid = if oid_out.ok() { Some(oid_out.text().trim().to_string()) } else { None };
    Ok(HeadInfo { detached: branch.is_none() && oid.is_some(), unborn: oid.is_none(), branch, oid })
}

fn read_trim(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn subject_of(repo: &Path, oid: &str) -> Option<String> {
    runner::run(repo, ["log", "-1", "--format=%h %s", oid]).ok().map(|s| s.trim().to_string())
}

/// Extracts "feature/x" from "Merge branch 'feature/x' into main".
fn merge_label(msg: &str) -> Option<String> {
    let first = msg.lines().next()?;
    for prefix in ["Merge branch '", "Merge remote-tracking branch '", "Merge tag '", "Merge commit '"] {
        if let Some(rest) = first.strip_prefix(prefix) {
            if let Some(end) = rest.find('\'') {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

pub fn op_state(repo: &Path, gd: &Path) -> OpState {
    let mut st = OpState {
        kind: "none".into(),
        incoming: None,
        incoming_label: None,
        message: None,
        step: None,
        total: None,
        head_name: None,
        onto: None,
        stopped_at: None,
        editing_commit: false,
    };
    let rebase_merge = gd.join("rebase-merge");
    let rebase_apply = gd.join("rebase-apply");
    if rebase_merge.is_dir() {
        st.kind = "rebase".into();
        st.step = read_trim(&rebase_merge.join("msgnum")).and_then(|s| s.parse().ok());
        st.total = read_trim(&rebase_merge.join("end")).and_then(|s| s.parse().ok());
        st.head_name = read_trim(&rebase_merge.join("head-name")).map(|s| s.trim_start_matches("refs/heads/").to_string());
        st.onto = read_trim(&rebase_merge.join("onto"));
        st.stopped_at = read_trim(&rebase_merge.join("stopped-sha"));
        st.editing_commit = read_trim(&rebase_merge.join("amend")).is_some();
        st.message = read_trim(&rebase_merge.join("message"));
        if let Some(s) = &st.stopped_at {
            st.incoming_label = subject_of(repo, s);
            st.incoming = Some(s.clone());
        }
        return st;
    }
    if rebase_apply.is_dir() {
        st.kind = if rebase_apply.join("applying").exists() { "am".into() } else { "rebase".into() };
        st.step = read_trim(&rebase_apply.join("next")).and_then(|s| s.parse().ok());
        st.total = read_trim(&rebase_apply.join("last")).and_then(|s| s.parse().ok());
        st.head_name = read_trim(&rebase_apply.join("head-name")).map(|s| s.trim_start_matches("refs/heads/").to_string());
        st.onto = read_trim(&rebase_apply.join("onto"));
        return st;
    }
    if let Some(mh) = read_trim(&gd.join("MERGE_HEAD")) {
        st.kind = "merge".into();
        let first = mh.lines().next().unwrap_or("").to_string();
        st.message = std::fs::read_to_string(gd.join("MERGE_MSG")).ok();
        st.incoming_label = st.message.as_deref().and_then(merge_label).or_else(|| subject_of(repo, &first));
        st.incoming = Some(first);
        return st;
    }
    if let Some(ch) = read_trim(&gd.join("CHERRY_PICK_HEAD")) {
        st.kind = "cherry-pick".into();
        st.incoming_label = subject_of(repo, &ch);
        st.incoming = Some(ch);
        st.message = std::fs::read_to_string(gd.join("MERGE_MSG")).ok();
        return st;
    }
    if let Some(rv) = read_trim(&gd.join("REVERT_HEAD")) {
        st.kind = "revert".into();
        st.incoming_label = subject_of(repo, &rv);
        st.incoming = Some(rv);
        st.message = std::fs::read_to_string(gd.join("MERGE_MSG")).ok();
        return st;
    }
    let squash = super::storage::dir(repo).ok().map(|dir| dir.join("squash-target"));
    if gd.join("SQUASH_MSG").exists() && squash.as_ref().is_some_and(|p| p.is_file()) {
        st.kind = "squash".into();
        st.message = std::fs::read_to_string(gd.join("SQUASH_MSG")).ok();
        st.incoming_label = squash.as_deref().and_then(read_trim);
        return st;
    }
    if gd.join("BISECT_LOG").exists() {
        st.kind = "bisect".into();
    }
    st
}

pub fn info(path: &Path) -> GitResult<RepoInfo> {
    let root = discover(path)?;
    let gd = git_dir(&root)?;
    let head = head(&root)?;
    let state = op_state(&root, &gd);
    let name = root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| root.to_string_lossy().into_owned());
    Ok(RepoInfo {
        root: root.to_string_lossy().into_owned(),
        git_dir: gd.to_string_lossy().into_owned(),
        common_dir: super::operations::repository_key(&root).to_string_lossy().into_owned(),
        name,
        head,
        state,
        is_bare: false,
    })
}

pub fn init(path: &Path, initial_branch: &str) -> GitResult<RepoInfo> {
    std::fs::create_dir_all(path)?;
    runner::run(path, ["init", "-b", initial_branch])?;
    info(path)
}

/// Reads a git config value (any scope) or None.
pub fn config_get(repo: &Path, key: &str) -> Option<String> {
    runner::exec(repo, ["config", "--get", key]).ok().filter(|o| o.ok()).map(|o| o.text().trim().to_string())
}

pub fn config_set(repo: &Path, key: &str, value: &str, global: bool) -> GitResult<()> {
    if global {
        runner::run(repo, ["config", "--global", key, value])?;
    } else {
        runner::run(repo, ["config", key, value])?;
    }
    Ok(())
}
