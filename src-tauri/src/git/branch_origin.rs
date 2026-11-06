//! Local creation provenance, never inferred from commit authors.
//! Git transports do not publish a branch creator. Missing/expired logs and
//! branches merely imported from a remote therefore have unknown provenance.
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    pub name: String,
    pub email: String,
}

pub struct Reader {
    logs: PathBuf,
    references: HashSet<String>,
    remaining: usize,
}
impl Reader {
    pub fn new(root: &Path, references: HashSet<String>) -> Self {
        Self { logs: super::operations::repository_key(root).join("logs"), references, remaining: 16 * 1024 * 1024 }
    }
    pub fn creator(&mut self, full_ref: &str) -> Option<Creator> {
        if !full_ref.starts_with("refs/heads/") || !Path::new(full_ref).components().all(|p| matches!(p, Component::Normal(_))) {
            return None;
        }
        let path = self.logs.join(full_ref);
        if !std::fs::symlink_metadata(&path).ok()?.file_type().is_file() {
            return None;
        }
        let file = File::open(path).ok()?;
        let size = usize::try_from(file.metadata().ok()?.len()).ok()?;
        // This optional label must not slow repository activation by scanning
        // arbitrarily large histories. Unsupported reftable logs stay unknown.
        if size > 256 * 1024 || size > self.remaining {
            return None;
        }
        self.remaining -= size;
        let mut bytes = Vec::with_capacity(size);
        file.take(256 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 256 * 1024 || !bytes.ends_with(b"\n") {
            return None;
        }
        parse(std::str::from_utf8(&bytes).ok()?, Some(&self.references), full_ref.strip_prefix("refs/heads/")?)
    }
}

fn actor(line: &str) -> Option<(&str, Creator, &str)> {
    let (meta, message) = line.split_once('\t')?;
    let mut parts = meta.splitn(3, ' ');
    let old = parts.next()?;
    let new = parts.next()?;
    if ![old, new].iter().all(|id| matches!(id.len(), 40 | 64) && id.bytes().all(|b| b.is_ascii_hexdigit())) {
        return None;
    }
    let identity = parts.next()?;
    let end = identity.rfind('>')?;
    let start = identity[..end].rfind('<')?;
    let email = identity[start + 1..end].trim();
    let name = identity[..start].trim();
    if email.is_empty() || email.chars().any(char::is_control) || name.chars().any(char::is_control) {
        return None;
    }
    Some((old, Creator { name: name.into(), email: email.into() }, message.trim_end_matches('\r')))
}

fn local_creation_source(start: &str, name: &str, references: Option<&HashSet<String>>) -> bool {
    if start == "HEAD" || start == "@" || start.len() >= 4 && start.bytes().all(|b| b.is_ascii_hexdigit()) {
        return true;
    }
    let Some(references) = references else {
        return false;
    };
    // Respect actual ref namespaces and Git's local-branch precedence. A slash
    // in a local branch name is not evidence that it names a remote.
    if references.contains(&format!("refs/heads/{start}")) || start.starts_with("refs/heads/") && references.contains(start) {
        return true;
    }
    if references.contains(&format!("refs/tags/{start}")) || start.starts_with("refs/tags/") && references.contains(start) {
        return true;
    }
    let remote = if start.starts_with("refs/remotes/") { start.to_owned() } else { format!("refs/remotes/{start}") };
    references.contains(&remote) && !remote.ends_with(&format!("/{name}"))
}

fn parse(log: &str, references: Option<&HashSet<String>>, name: &str) -> Option<Creator> {
    // A rename preserves creation provenance, including an imported branch's
    // unknown creator. Compare its source with the name before the first rename.
    let original = log
        .lines()
        .find_map(|line| {
            let (_, _, message) = actor(line)?;
            message.strip_prefix("Branch: renamed refs/heads/")?.split_once(" to refs/heads/").map(|(old, _)| old)
        })
        .unwrap_or(name);
    let mut lines = log.lines();
    let (old, who, message) = actor(lines.next()?)?;
    // Expired history starts unknown, but a later copy is itself a new branch
    // creation and still identifies its copier (even if it is the first entry).
    let created = old.bytes().all(|b| b == b'0')
        && (message.starts_with("commit (initial): ")
            || message.strip_prefix("branch: Created from ").is_some_and(|start| local_creation_source(start, original, references)));
    let mut creator = created.then_some(who);
    for line in log.lines() {
        let (_, who, message) = actor(line)?;
        // Copying creates a new branch, whereas renaming retains provenance.
        if message.starts_with("Branch: copied ") {
            creator = Some(who);
        }
    }
    creator
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(old: char, email: &str, message: &str) -> String {
        format!("{} {} Person <{email}> 1700000000 +0000\t{message}\n", old.to_string().repeat(40), "a".repeat(40))
    }
    #[test]
    fn creator_survives_other_peoples_commits_and_renaming() {
        let log = line('0', "creator@example.invalid", "branch: Created from HEAD")
            + &line('a', "other@example.invalid", "commit: Others work")
            + &line('a', "renamer@example.invalid", "Branch: renamed refs/heads/a to refs/heads/b");
        assert_eq!(parse(&log, None, "b").unwrap().email, "creator@example.invalid");
    }
    #[test]
    fn cloning_tracking_and_expired_logs_do_not_claim_ownership() {
        for log in [
            line('0', "me@example.invalid", "clone: from remote"),
            line('0', "me@example.invalid", "branch: Created from origin/topic"),
            line('0', "me@example.invalid", "branch: Created from refs/remotes/origin/topic"),
            line('a', "me@example.invalid", "commit: Mine"),
        ] {
            assert!(parse(&log, None, "topic").is_none());
        }
        let references = HashSet::from(["refs/remotes/origin/main".into()]);
        assert!(parse(&line('0', "me@example.invalid", "branch: Created from origin/main"), Some(&references), "new-feature").is_some());
        let renamed = line('0', "me@example.invalid", "branch: Created from removed-remote/topic")
            + &line('a', "me@example.invalid", "Branch: renamed refs/heads/topic to refs/heads/renamed");
        assert!(parse(&renamed, None, "renamed").is_none());
    }
    #[test]
    fn copy_has_its_own_creator() {
        let log = line('0', "original@example.invalid", "branch: Created from main")
            + &line('a', "copier@example.invalid", "Branch: copied refs/heads/a to refs/heads/b");
        assert_eq!(parse(&log, None, "b").unwrap().email, "copier@example.invalid");
        let expired = line('a', "original@example.invalid", "commit: Old surviving entry")
            + &line('a', "copier@example.invalid", "Branch: copied refs/heads/a to refs/heads/b");
        assert_eq!(parse(&expired, None, "b").unwrap().email, "copier@example.invalid");
        assert_eq!(
            parse(&line('a', "copier@example.invalid", "Branch: copied refs/heads/a to refs/heads/b"), None, "b").unwrap().email,
            "copier@example.invalid"
        );
    }
    #[test]
    fn local_names_with_slashes_are_not_remote_imports() {
        let log = line('0', "creator@example.invalid", "branch: Created from feature/topic");
        let references = HashSet::from(["refs/heads/feature/topic".into()]);
        assert_eq!(parse(&log, Some(&references), "topic").unwrap().email, "creator@example.invalid");
        assert!(parse(&log, None, "topic").is_none());
        let remote = HashSet::from(["refs/remotes/feature/topic".into()]);
        assert!(parse(&log, Some(&remote), "topic").is_none());
    }
}
