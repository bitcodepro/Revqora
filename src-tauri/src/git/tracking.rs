//! Incoming and outgoing commits of the current branch, without reading the working tree.
//!
//! The Explorer's Incoming and Outgoing filters cover every repository in the library, also
//! the ones that are not open. `git status` would scan each working tree; this reads HEAD from
//! the repository's files and the branch from one `for-each-ref` (plus one `rev-list` for a
//! branch without an upstream). Starting a Git process is the main cost on Windows.

use super::runner::{self, GitResult};
use super::{history, operations};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchTracking {
    /// Short name of the current branch; `None` for a detached HEAD.
    pub branch: Option<String>,
    /// Commit of the current branch; `None` before its first commit.
    pub oid: Option<String>,
    /// Configured upstream, also when its remote branch is gone.
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    /// For a branch without an upstream: commits absent from every fetched remote branch.
    pub unpublished: Option<usize>,
}

pub fn branch_tracking(repo: &Path) -> GitResult<BranchTracking> {
    operations::read(repo, || {
        let Some(reference) = head_reference(repo)? else {
            // Detached HEAD: Push has no branch to send.
            return Ok(BranchTracking::default());
        };
        let branch = reference.strip_prefix("refs/heads/").unwrap_or(&reference).to_owned();
        let format = "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)";
        let refs = runner::run(repo, ["for-each-ref", format, reference.as_str()])?;
        // A pattern also matches refs below it (`main` matches `main/x`): take the exact ref.
        let Some(fields) = refs.lines().map(|line| line.split('\0').collect::<Vec<_>>()).find(|fields| fields.first() == Some(&reference.as_str())) else {
            // A branch without commits yet.
            return Ok(BranchTracking { branch: Some(branch), ..BranchTracking::default() });
        };
        let field = |index: usize| fields.get(index).copied().unwrap_or("");
        let oid = field(1).to_owned();
        let upstream = Some(field(2)).filter(|name| !name.is_empty()).map(str::to_owned);
        let (ahead, behind) = parse_track(field(3));
        let unpublished = match upstream {
            Some(_) => None,
            None => Some(history::run(repo, ["rev-list", "--count", oid.as_str(), "--not", "--remotes", "--"])?.trim().parse().unwrap_or(0)),
        };
        Ok(BranchTracking { branch: Some(branch), oid: Some(oid), upstream, ahead, behind, unpublished })
    })
}

/// Staged, unstaged and untracked entries, for the Changes filter of a repository that is not
/// open. One `git status` without rename detection; an untracked folder counts once instead of
/// listing every file in it. Like every read, it never rewrites the index.
pub fn change_count(repo: &Path) -> GitResult<usize> {
    operations::read(repo, || {
        let raw = runner::run_bytes(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames"])?;
        Ok(raw.split(|byte| *byte == 0).filter(|entry| !entry.is_empty()).count())
    })
}

/// The branch HEAD points to; `None` when HEAD is detached.
fn head_reference(repo: &Path) -> GitResult<Option<String>> {
    if let Some(head) = head_file(repo) {
        match head.strip_prefix("ref: ") {
            // The reftable format keeps HEAD in the table; its file names a placeholder.
            Some(reference) if reference.starts_with("refs/heads/") && reference != "refs/heads/.invalid" => return Ok(Some(reference.to_owned())),
            None if head.len() >= 40 && head.bytes().all(|b| b.is_ascii_hexdigit()) => return Ok(None),
            _ => {}
        }
    }
    let head = runner::exec(repo, ["symbolic-ref", "-q", "HEAD"])?;
    Ok(head.ok().then(|| head.text().trim().to_owned()))
}

/// HEAD as written in `<repo>/.git/HEAD` (or the linked worktree's Git directory), without
/// starting Git. Anything unusual is left to Git.
fn head_file(repo: &Path) -> Option<String> {
    let dot_git = repo.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let link = std::fs::read_to_string(&dot_git).ok()?;
        let path = PathBuf::from(link.strip_prefix("gitdir:")?.trim());
        if path.is_absolute() {
            path
        } else {
            repo.join(path)
        }
    };
    Some(std::fs::read_to_string(git_dir.join("HEAD")).ok()?.trim().to_owned())
}

fn parse_track(track: &str) -> (usize, usize) {
    let count = |prefix: &str| track.split(',').find_map(|part| part.trim().strip_prefix(prefix)?.parse().ok()).unwrap_or(0);
    (count("ahead "), count("behind "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repo: &Path, args: &[&str]) {
        runner::run(repo, args).unwrap();
    }

    fn commit(repo: &Path, name: &str) {
        std::fs::write(repo.join(name), name).unwrap();
        git(repo, &["add", name]);
        git(repo, &["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", name]);
    }

    #[test]
    fn reports_outgoing_and_incoming_commits_without_reading_the_working_tree() {
        let fixture = tempfile::tempdir().unwrap();
        let origin = fixture.path().join("origin.git");
        let repo = fixture.path().join("work");
        std::fs::create_dir(&repo).unwrap();
        git(fixture.path(), &["init", "-q", "--bare", origin.to_str().unwrap()]);
        git(&repo, &["init", "-qb", "main"]);
        assert_eq!(branch_tracking(&repo).unwrap(), BranchTracking { branch: Some("main".into()), ..Default::default() }, "unborn branch");

        commit(&repo, "one.txt");
        commit(&repo, "two.txt");
        let unpublished = branch_tracking(&repo).unwrap();
        assert_eq!((unpublished.upstream.as_deref(), unpublished.unpublished), (None, Some(2)), "no remote yet: every commit is unpublished");

        git(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
        git(&repo, &["push", "-qu", "origin", "main"]);
        commit(&repo, "three.txt");
        std::fs::write(repo.join("dirty.txt"), "not part of tracking").unwrap();
        let ahead = branch_tracking(&repo).unwrap();
        assert_eq!((ahead.upstream.as_deref(), ahead.ahead, ahead.behind, ahead.unpublished), (Some("origin/main"), 1, 0, None));

        git(&repo, &["push", "-q", "origin", "main"]);
        git(&repo, &["reset", "-q", "--hard", "HEAD~1"]);
        let behind = branch_tracking(&repo).unwrap();
        assert_eq!((behind.ahead, behind.behind), (0, 1));

        git(&repo, &["switch", "-qc", "feature"]);
        commit(&repo, "feature.txt");
        let feature = branch_tracking(&repo).unwrap();
        assert_eq!(
            (feature.branch.as_deref(), feature.upstream.as_deref(), feature.unpublished),
            (Some("feature"), None, Some(1)),
            "only the commit absent from origin/main"
        );

        let linked = fixture.path().join("linked");
        git(&repo, &["worktree", "add", "-q", "-b", "linked-branch", linked.to_str().unwrap()]);
        assert_eq!(branch_tracking(&linked).unwrap().branch.as_deref(), Some("linked-branch"), "a linked worktree reads its own HEAD");

        git(&repo, &["switch", "-q", "--detach"]);
        assert_eq!(branch_tracking(&repo).unwrap(), BranchTracking::default(), "detached HEAD has nothing to push");
        assert_eq!(head_file(&repo).map(|head| head.len()), Some(40));
    }

    #[test]
    fn counts_staged_unstaged_and_untracked_entries_without_touching_the_index() {
        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path();
        git(repo, &["init", "-qb", "main"]);
        commit(repo, "tracked.txt");
        assert_eq!(change_count(repo).unwrap(), 0);
        let index = std::fs::read(repo.join(".git/index")).unwrap();
        std::fs::write(repo.join("tracked.txt"), "edited").unwrap();
        std::fs::create_dir_all(repo.join("build/deep")).unwrap();
        std::fs::write(repo.join("build/deep/a.o"), "x").unwrap();
        std::fs::write(repo.join("build/b.o"), "x").unwrap();
        assert_eq!(change_count(repo).unwrap(), 2, "an edit and one untracked folder");
        assert_eq!(std::fs::read(repo.join(".git/index")).unwrap(), index, "a read must not rewrite the index");
        std::fs::write(repo.join("staged.txt"), "new").unwrap();
        git(repo, &["add", "staged.txt"]);
        assert_eq!(change_count(repo).unwrap(), 3);
    }

    #[test]
    fn parses_upstream_track() {
        assert_eq!(parse_track("ahead 3, behind 2"), (3, 2));
        assert_eq!(parse_track("behind 7"), (0, 7));
        assert_eq!(parse_track("gone"), (0, 0));
        assert_eq!(parse_track(""), (0, 0));
    }
}
