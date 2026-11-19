//! Repository discovery and in-progress operation state.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::runner::{self, GitError, GitResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub detached: bool,
    pub unborn: bool,
}

#[derive(Deserialize)]
pub struct SourceHead {
    pub branch: Option<String>,
    pub oid: Option<String>,
}

impl SourceHead {
    pub fn verify(&self, repo: &Path) -> GitResult<()> {
        let current = head(repo)?;
        if self.branch != current.branch || self.oid != current.oid {
            return Err(GitError::new("The current branch or commit changed. Review the refreshed view before trying again.").kind("stale-operation"));
        }
        Ok(())
    }
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

pub(super) fn require_directory(path: &Path) -> GitResult<()> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(GitError::new(format!("Repository path is not a folder: {}", path.display())).kind("repository-folder-unavailable")),
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
            Err(GitError::new(format!("Repository folder is unavailable: {}", path.display())).kind("repository-folder-unavailable"))
        }
        Err(error) => Err(error.into()),
    }
}

pub fn discover(path: &Path) -> GitResult<PathBuf> {
    require_directory(path)?;
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

/// What `repo/.git` currently is: a directory, a `gitdir:` file (linked worktree or
/// submodule; its text names the Git directory) or nothing. A worktree moved away and
/// another one added at the same path changes this even though the old Git directory exists.
pub fn dot_git_identity(repo: &Path) -> Option<String> {
    let dot = repo.join(".git");
    let meta = std::fs::metadata(&dot).ok()?;
    if meta.is_dir() {
        return Some(String::new());
    }
    std::fs::read_to_string(&dot).ok()
}

pub fn git_dir(repo: &Path) -> GitResult<PathBuf> {
    // Remembered per folder while `repo/.git` stays the same and the Git directory still
    // exists: hot paths ask for it on every refresh.
    type Remembered = (Option<String>, PathBuf);
    static DIRS: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<PathBuf, Remembered>>> = std::sync::OnceLock::new();
    let dirs = DIRS.get_or_init(Default::default);
    let identity = dot_git_identity(repo);
    // Without `.git` in the folder itself Git searches parent folders: do not remember that.
    if identity.is_some() {
        if let Some((_, dir)) = dirs.lock().get(repo).filter(|(known, dir)| known == &identity && dir.join("HEAD").is_file()) {
            return Ok(dir.clone());
        }
    }
    let s = runner::run(repo, ["rev-parse", "--absolute-git-dir"])?;
    let dir = normalize(PathBuf::from(s.trim()));
    if identity.is_some() && dot_git_identity(repo) == identity {
        dirs.lock().insert(repo.to_path_buf(), (identity, dir.clone()));
    }
    Ok(dir)
}

pub fn head(repo: &Path) -> GitResult<HeadInfo> {
    // HEAD is read on every refresh and twice per journaled operation: answer from Git's
    // files when they are ordinary, without starting two processes.
    if let Some(head) = git_dir(repo).ok().and_then(|gd| head_from_files(&gd)) {
        return Ok(head);
    }
    head_from_git(repo)
}

fn head_from_git(repo: &Path) -> GitResult<HeadInfo> {
    // Both reads are independent: run them side by side.
    let parent = super::operations::Inherited::of(repo);
    let (sym, oid_out) = std::thread::scope(|scope| {
        let oid = scope.spawn(|| parent.run(|| runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD^{commit}"])));
        let sym = runner::exec(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
        (sym, oid.join().unwrap_or_else(|_| Err(GitError::new("Resolve HEAD failed."))))
    });
    let (sym, oid_out) = (sym?, oid_out?);
    let branch = if sym.ok() { Some(sym.text().trim().to_string()) } else { None };
    let oid = if oid_out.ok() { Some(oid_out.text().trim().to_string()) } else { None };
    Ok(HeadInfo { detached: branch.is_none() && oid.is_some(), unborn: oid.is_none(), branch, oid })
}

/// HEAD from the files Git keeps, as `symbolic-ref -q --short HEAD` and
/// `rev-parse -q --verify HEAD^{commit}` would report it: `HEAD` in the Git directory, then the
/// branch as a loose ref in the shared directory, then `packed-refs`.
///
/// None (ask Git) for anything that is not plain: reftable, a HEAD that names something other
/// than a local branch, a branch that is itself a symbolic ref, a short name Git would print
/// differently because another ref has it too, or a branch found nowhere (possibly unborn, or a
/// read during `pack-refs`).
pub(crate) fn head_from_files(gd: &Path) -> Option<HeadInfo> {
    let common = match std::fs::read_to_string(gd.join("commondir")) {
        Ok(text) if !text.trim().is_empty() => {
            let target = normalize(PathBuf::from(text.trim()));
            if target.is_absolute() {
                target
            } else {
                gd.join(target)
            }
        }
        _ => gd.to_path_buf(),
    };
    if common.join("reftable").exists() || gd.join("reftable").exists() {
        return None;
    }
    let text = std::fs::read_to_string(gd.join("HEAD")).ok()?;
    let text = text.trim_end_matches(['\n', '\r']);
    let object = |value: &str| (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    let Some(target) = text.strip_prefix("ref: ") else {
        return object(text).then(|| HeadInfo { branch: None, oid: Some(text.to_owned()), detached: true, unborn: false });
    };
    let name = target.strip_prefix("refs/heads/")?;
    if name.is_empty() || target.contains("..") || target.contains('\\') {
        return None;
    }
    let packed = match std::fs::read_to_string(common.join("packed-refs")) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return None,
    };
    let packed_oid = |refname: &str| {
        packed
            .lines()
            .filter(|line| !line.starts_with(['#', '^']))
            .find_map(|line| line.split_once(' ').filter(|(_, r)| *r == refname).map(|(oid, _)| oid.to_owned()))
    };
    let exists = |refname: &str| common.join(refname).is_file() || packed_oid(refname).is_some();
    // `--short` keeps "heads/<name>" when another ref has the same short name.
    if [format!("refs/{name}"), format!("refs/tags/{name}"), format!("refs/remotes/{name}"), format!("refs/remotes/{name}/HEAD")].iter().any(|r| exists(r)) {
        return None;
    }
    let oid = match std::fs::read_to_string(common.join(target)) {
        Ok(loose) => {
            let loose = loose.trim_end_matches(['\n', '\r']).to_owned();
            object(&loose).then_some(loose)?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => packed_oid(target).filter(|oid| object(oid))?,
        Err(_) => return None,
    };
    Some(HeadInfo { branch: Some(name.to_owned()), oid: Some(oid), detached: false, unborn: false })
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

/// Remove Git's generated conflict footer while preserving literal comment lines
/// in the commit message. The original message can itself contain such a block.
pub fn cherry_pick_message(repo: &Path, gd: &Path, incoming: &str) -> GitResult<String> {
    let message = std::fs::read_to_string(gd.join("MERGE_MSG"))?;
    let original = runner::run(repo, ["log", "-1", "--format=format:%B", incoming, "--"])?;
    let original_body = original.trim_end_matches(['\r', '\n']);
    let text = message.trim_end_matches(['\r', '\n']);
    if text == original_body {
        return Ok(message);
    }
    let Some((body, footer)) = text.rsplit_once("\n\n").or_else(|| text.rsplit_once("\r\n\r\n")) else {
        return Ok(message);
    };
    let mut lines = footer.lines();
    let Some(marker) = lines.next().and_then(|line| line.strip_suffix(" Conflicts:")) else {
        return Ok(message);
    };
    let path_prefix = format!("{marker}\t");
    if marker.is_empty() || marker.contains(char::is_whitespace) || lines.clone().next().is_none() || !lines.all(|line| line.starts_with(&path_prefix)) {
        return Ok(message);
    }
    if original_body.ends_with(footer) && !body.starts_with(original_body) {
        return Ok(message);
    }
    if body.trim_end_matches(['\r', '\n']) == original_body {
        return Ok(original);
    }
    Ok(format!("{}\n", body.trim_end_matches(['\r', '\n'])))
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
        st.message = cherry_pick_message(repo, gd, &ch).ok();
        st.incoming = Some(ch);
        return st;
    }
    if let Some(rv) = read_trim(&gd.join("REVERT_HEAD")) {
        st.kind = "revert".into();
        st.incoming_label = subject_of(repo, &rv);
        st.incoming = Some(rv);
        st.message = std::fs::read_to_string(gd.join("MERGE_MSG")).ok();
        return st;
    }
    // `gd` is this worktree's Git directory: no second lookup for the storage folder.
    let squash = super::storage::dir_for(gd).ok().map(|dir| dir.join("squash-target"));
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

/// The working tree root and Git directory of `path`. Remembered per folder while `path/.git`
/// stays the same and the Git directory still exists, like [`git_dir`]: every refresh asks.
fn location(path: &Path) -> GitResult<(PathBuf, PathBuf)> {
    type Remembered = (Option<String>, PathBuf, PathBuf);
    static PLACES: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<PathBuf, Remembered>>> = std::sync::OnceLock::new();
    let places = PLACES.get_or_init(Default::default);
    let identity = dot_git_identity(path);
    if identity.is_some() {
        if let Some((_, root, gd)) = places.lock().get(path).filter(|(known, root, gd)| known == &identity && root.is_dir() && gd.join("HEAD").is_file()) {
            return Ok((root.clone(), gd.clone()));
        }
    }
    // One Git process answers both questions. Unusual output (a path containing a line
    // break) falls back to the separate reads.
    let both = runner::exec(path, ["rev-parse", "--show-toplevel", "--absolute-git-dir"])?;
    let text = both.text();
    let lines: Vec<&str> = text.lines().collect();
    let (root, gd) = match lines.as_slice() {
        [top, git] if both.ok() && !top.trim().is_empty() && !git.trim().is_empty() => {
            (normalize(PathBuf::from(top.trim())), normalize(PathBuf::from(git.trim())))
        }
        _ => {
            let root = discover(path)?;
            let gd = git_dir(&root)?;
            (root, gd)
        }
    };
    if identity.is_some() && dot_git_identity(path) == identity {
        places.lock().insert(path.to_path_buf(), (identity, root.clone(), gd.clone()));
    }
    Ok((root, gd))
}

pub fn info(path: &Path) -> GitResult<RepoInfo> {
    // One Git process answers both questions on every refresh. Unusual output (a path
    // containing a line break) falls back to the separate reads.
    require_directory(path)?;
    let (root, gd) = location(path)?;
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
    super::config_cache::exec(repo, &["config", "--get", key]).ok().filter(|o| o.ok()).map(|o| o.text().trim().to_string())
}

pub fn config_set(repo: &Path, key: &str, value: &str, global: bool) -> GitResult<()> {
    if global {
        runner::run(repo, ["config", "--global", key, value])?;
    } else {
        runner::run(repo, ["config", key, value])?;
    }
    Ok(())
}

#[cfg(test)]
mod head_tests {
    use super::*;

    fn git(repo: &Path, args: &[&str]) -> String {
        runner::run(repo, args).unwrap().trim().to_string()
    }

    fn same_as_git(repo: &Path) -> Option<HeadInfo> {
        let gd = git_dir(repo).unwrap();
        let files = head_from_files(&gd);
        let from_git = head_from_git(repo).unwrap();
        if let Some(files) = &files {
            assert_eq!(
                (&files.branch, &files.oid, files.detached, files.unborn),
                (&from_git.branch, &from_git.oid, from_git.detached, from_git.unborn),
                "files and Git disagree in {}",
                repo.display()
            );
        }
        files
    }

    #[test]
    fn head_read_from_files_matches_git_or_defers_to_it() {
        let dir = tempfile::tempdir_in(crate::portable::temp_dir().unwrap()).unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-qb", "main"]);
        for (key, value) in [("user.name", "Fixture"), ("user.email", "fixture@example.test"), ("commit.gpgsign", "false")] {
            git(&repo, &["config", key, value]);
        }
        // Unborn: the branch exists nowhere, so Git is asked.
        assert!(same_as_git(&repo).is_none());
        assert!(head(&repo).unwrap().unborn);

        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "one"]);
        let loose = same_as_git(&repo).expect("a loose branch is read from files");
        assert_eq!(loose.branch.as_deref(), Some("main"));

        // Packed branch: no loose file left.
        git(&repo, &["pack-refs", "--all"]);
        assert!(!repo.join(".git/refs/heads/main").exists());
        assert!(same_as_git(&repo).is_some());

        // A nested branch name, then a detached HEAD.
        git(&repo, &["switch", "-qc", "feature/x"]);
        assert_eq!(same_as_git(&repo).unwrap().branch.as_deref(), Some("feature/x"));
        git(&repo, &["switch", "-q", "--detach", "HEAD"]);
        let detached = same_as_git(&repo).expect("a detached HEAD is read from files");
        assert!(detached.detached && detached.branch.is_none());

        // A tag with the branch's name: Git prints "heads/main", so the files defer to Git.
        git(&repo, &["switch", "-q", "main"]);
        git(&repo, &["tag", "main"]);
        assert!(same_as_git(&repo).is_none());
        assert_eq!(head(&repo).unwrap().branch.as_deref(), Some("heads/main"));
        git(&repo, &["tag", "-d", "main"]);

        // A linked worktree keeps HEAD in its own Git directory and branches in the shared one.
        let linked = dir.path().join("linked");
        git(&repo, &["worktree", "add", "-q", "-b", "side", linked.to_str().unwrap()]);
        assert_eq!(same_as_git(&linked).unwrap().branch.as_deref(), Some("side"));
        git(&repo, &["pack-refs", "--all"]);
        assert_eq!(same_as_git(&linked).unwrap().branch.as_deref(), Some("side"));

        // Repository info uses the same answers and is remembered per folder.
        let info = info(&linked).unwrap();
        assert_eq!(info.head.branch.as_deref(), Some("side"));
        assert_eq!(normalize(PathBuf::from(&info.root)), normalize(linked.clone()));
    }
}
