//! Local creation provenance, never inferred from commit authors.
//! Git transports do not publish a branch creator. Missing/expired logs and
//! branches merely imported from a remote therefore have unknown provenance.
use serde::Serialize;
use std::{
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
    remotes: Vec<String>,
    remaining: usize,
}
impl Reader {
    pub fn new(root: &Path, remotes: Vec<String>) -> Self {
        Self { logs: super::operations::repository_key(root).join("logs"), remotes, remaining: 16 * 1024 * 1024 }
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
        parse(std::str::from_utf8(&bytes).ok()?, &self.remotes, full_ref.strip_prefix("refs/heads/")?)
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

fn parse(log: &str, remotes: &[String], name: &str) -> Option<Creator> {
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
    // An expired first entry cannot identify the original creator. In
    // particular, the oldest surviving commit's author is not a substitute.
    if !old.bytes().all(|b| b == b'0') {
        return None;
    }
    let mut creator = if let Some(start) = message.strip_prefix("branch: Created from ") {
        let source = start.strip_prefix("refs/remotes/").unwrap_or(start);
        if source.ends_with(&format!("/{original}")) || remotes.iter().any(|r| source.strip_prefix(&format!("{r}/")).is_some_and(|branch| branch == original)) {
            None
        } else {
            Some(who)
        }
    } else if message.starts_with("commit (initial): ") {
        Some(who)
    } else {
        None
    };
    for line in lines {
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
        assert_eq!(parse(&log, &[], "b").unwrap().email, "creator@example.invalid");
    }
    #[test]
    fn cloning_tracking_and_expired_logs_do_not_claim_ownership() {
        for log in [
            line('0', "me@example.invalid", "clone: from remote"),
            line('0', "me@example.invalid", "branch: Created from origin/topic"),
            line('0', "me@example.invalid", "branch: Created from refs/remotes/origin/topic"),
            line('a', "me@example.invalid", "commit: Mine"),
        ] {
            assert!(parse(&log, &["origin".into()], "topic").is_none());
        }
        assert!(parse(&line('0', "me@example.invalid", "branch: Created from origin/main"), &["origin".into()], "new-feature").is_some());
        let renamed = line('0', "me@example.invalid", "branch: Created from removed-remote/topic")
            + &line('a', "me@example.invalid", "Branch: renamed refs/heads/topic to refs/heads/renamed");
        assert!(parse(&renamed, &[], "renamed").is_none());
    }
    #[test]
    fn copy_has_its_own_creator() {
        let log = line('0', "original@example.invalid", "branch: Created from main")
            + &line('a', "copier@example.invalid", "Branch: copied refs/heads/a to refs/heads/b");
        assert_eq!(parse(&log, &[], "b").unwrap().email, "copier@example.invalid");
    }
}
