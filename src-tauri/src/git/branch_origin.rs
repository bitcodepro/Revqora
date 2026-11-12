//! Local creation provenance, never inferred from commit authors.
//! Git transports do not publish a branch creator. Missing/expired logs and
//! branches merely imported from a remote therefore have unknown provenance.
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub(super) const RECORD_CREATION_REFLOG: [&str; 2] = ["-c", "core.logAllRefUpdates=true"];
pub(super) const STACK_LAYER_CREATION: &str = "Revqora: add dependent stack layer";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    pub name: String,
    pub email: String,
}

pub struct Reader {
    logs: PathBuf,
    remaining: usize,
}
impl Reader {
    pub fn new(root: &Path) -> Self {
        Self { logs: super::operations::repository_key(root).join("logs"), remaining: 16 * 1024 * 1024 }
    }
    pub fn creator(&mut self, full_ref: &str) -> Option<Creator> {
        parse(&self.read(full_ref)?, full_ref.strip_prefix("refs/heads/")?)
    }
    fn read(&mut self, full_ref: &str) -> Option<String> {
        if (full_ref != "HEAD" && !full_ref.starts_with("refs/heads/")) || !Path::new(full_ref).components().all(|p| matches!(p, Component::Normal(_))) {
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
        String::from_utf8(bytes).ok()
    }
}

/// A source can be recorded by name, or by the matching HEAD checkout when
/// Git created the branch from HEAD. An arbitrary starting commit has no name.
pub(super) fn named_source(root: &Path, reference: &str) -> Option<String> {
    let mut reader = Reader::new(root);
    let name = reference.strip_prefix("refs/heads/")?;
    let log = reader.read(reference)?;
    if let Some(source) = log.lines().rev().find_map(|line| {
        let (_, _, message) = actor(line)?;
        message.strip_prefix("Branch: copied ")?.split_once(" to ").map(|(source, _)| source)
    }) {
        return Some(source.to_owned());
    }
    let line = log.lines().next()?;
    let (old, _, message) = actor(line)?;
    if !old.bytes().all(|b| b == b'0') {
        return None;
    }
    let source = message.strip_prefix("branch: Created from ")?;
    if source != "HEAD" && source != "@" {
        return Some(source.to_owned());
    }
    let original = log
        .lines()
        .find_map(|line| {
            let (_, _, message) = actor(line)?;
            message.strip_prefix("Branch: renamed refs/heads/")?.split_once(" to refs/heads/").map(|(old, _)| old)
        })
        .unwrap_or(name);
    let meta = line.split_once('\t')?.0;
    let created_oid = meta.split(' ').nth(1)?;
    let timestamp = meta.rsplit_once(' ')?.0.rsplit_once(' ')?.1;
    let head = reader.read("HEAD")?;
    let mut sources = head.lines().filter_map(|line| {
        let (previous, _, action) = actor(line)?;
        let (from, to) = action.strip_prefix("checkout: moving from ")?.split_once(" to ")?;
        let meta = line.split_once('\t')?.0;
        let next = meta.split(' ').nth(1)?;
        let time = meta.rsplit_once(' ')?.0.rsplit_once(' ')?.1;
        (to == original && previous == created_oid && next == created_oid && time == timestamp).then_some(from)
    });
    let first = sources.next()?;
    sources.all(|source| source == first).then(|| format!("refs/heads/{first}"))
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

/// Resolve named inputs while creating a branch, so Git's own creation record
/// retains the namespace that was actually selected. Keep ancestry expressions
/// unchanged and preserve Git's upstream/autosetup behavior for named refs.
pub(super) fn qualified_start(root: &Path, start: &str) -> super::runner::GitResult<String> {
    let reference = super::runner::run(root, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", start])?;
    let reference = reference.trim();
    Ok(if ["refs/heads/", "refs/remotes/", "refs/tags/"].iter().any(|prefix| reference.starts_with(prefix)) && !reference.contains(['\n', '\r']) {
        reference.to_owned()
    } else {
        start.to_owned()
    })
}

/// branch/switch accept A...B as a unique merge base, unlike rev-parse and
/// worktree add. Resolve that shorthand to an immutable commit before recording
/// creation provenance; never silently choose one of multiple merge bases.
pub(super) fn branch_start(root: &Path, start: &str) -> super::runner::GitResult<String> {
    let Some((left, right)) = start.split_once("...") else {
        return qualified_start(root, start);
    };
    let bases =
        super::runner::run(root, ["merge-base", "--all", "--", if left.is_empty() { "HEAD" } else { left }, if right.is_empty() { "HEAD" } else { right }])?;
    let base = bases.trim();
    if !matches!(base.len(), 40 | 64) || !base.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(super::runner::GitError::new("The branch start must have exactly one merge base.").kind("invalid-start"));
    }
    Ok(base.to_owned())
}

fn local_creation_source(start: &str, name: &str) -> bool {
    if start == "HEAD" || start == "@" || (4..=64).contains(&start.len()) && start.bytes().all(|b| b.is_ascii_hexdigit()) {
        return true;
    }
    // Git has already validated this commit-ish when writing the creation
    // entry. These operators cannot be literal ref names; this is an explicit
    // revision selection, not importing the unchanged remote-tracking branch.
    if start.contains(['~', '^']) {
        return true;
    }
    if let Some((_, selector)) = start.split_once("@{") {
        // @{u}/@{upstream}/@{push} select a possibly remote branch, rather
        // than a historical reflog entry. Their old unqualified form cannot
        // establish local creation; new Revqora writes resolve the namespace.
        return selector.split_once('}').is_some_and(|(selector, _)| !["u", "upstream", "push"].iter().any(|alias| selector.eq_ignore_ascii_case(alias)));
    }
    if start.starts_with("refs/heads/") || start.starts_with("refs/tags/") {
        return true;
    }
    // A differently named source records creation of this local branch, even
    // when Git logged the start as "main" instead of "refs/heads/main".
    // A same-name remote source can be a tracking checkout. Its actor does
    // not prove who originally created that branch on the server.
    let Some(source) = start.strip_prefix("refs/remotes/").or_else(|| (!start.starts_with("refs/")).then_some(start)) else {
        return false;
    };
    !source.is_empty() && source != name && !source.ends_with(&format!("/{name}"))
}

fn parse(log: &str, name: &str) -> Option<Creator> {
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
        && (message == STACK_LAYER_CREATION
            || message.starts_with("commit (initial): ")
            || message.strip_prefix("branch: Created from ").is_some_and(|start| local_creation_source(start, original)));
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
        assert_eq!(parse(&log, "b").unwrap().email, "creator@example.invalid");
    }
    #[test]
    fn stack_layer_creation_records_its_creator() {
        assert_eq!(parse(&line('0', "creator@example.invalid", STACK_LAYER_CREATION), "layer").unwrap().email, "creator@example.invalid");
        assert!(parse(&line('a', "editor@example.invalid", STACK_LAYER_CREATION), "layer").is_none());
    }
    #[test]
    fn cloning_tracking_and_expired_logs_do_not_claim_ownership() {
        for log in [
            line('0', "me@example.invalid", "clone: from remote"),
            line('0', "me@example.invalid", "branch: Created from origin/topic"),
            line('0', "me@example.invalid", "branch: Created from refs/remotes/origin/topic"),
            line('a', "me@example.invalid", "commit: Mine"),
        ] {
            assert!(parse(&log, "topic").is_none());
        }
        assert!(parse(&line('0', "me@example.invalid", "branch: Created from refs/remotes/origin/main"), "new-feature").is_some());
        let renamed = line('0', "me@example.invalid", "branch: Created from removed-remote/topic")
            + &line('a', "me@example.invalid", "Branch: renamed refs/heads/topic to refs/heads/renamed");
        assert!(parse(&renamed, "renamed").is_none());
    }
    #[test]
    fn copy_has_its_own_creator() {
        let log = line('0', "original@example.invalid", "branch: Created from main")
            + &line('a', "copier@example.invalid", "Branch: copied refs/heads/a to refs/heads/b");
        assert_eq!(parse(&log, "b").unwrap().email, "copier@example.invalid");
        let expired = line('a', "original@example.invalid", "commit: Old surviving entry")
            + &line('a', "copier@example.invalid", "Branch: copied refs/heads/a to refs/heads/b");
        assert_eq!(parse(&expired, "b").unwrap().email, "copier@example.invalid");
        assert_eq!(parse(&line('a', "copier@example.invalid", "Branch: copied refs/heads/a to refs/heads/b"), "b").unwrap().email, "copier@example.invalid");
    }
    #[test]
    fn historical_namespaces_are_not_guessed_from_unqualified_names() {
        let log = line('0', "creator@example.invalid", "branch: Created from feature/topic");
        assert!(parse(&log, "topic").is_none());
        let local = line('0', "creator@example.invalid", "branch: Created from refs/heads/feature/topic");
        assert_eq!(parse(&local, "topic").unwrap().email, "creator@example.invalid");
        let remote = line('0', "creator@example.invalid", "branch: Created from refs/remotes/feature/topic");
        assert!(parse(&remote, "topic").is_none());
    }
    #[test]
    fn differently_named_starts_keep_the_actual_reflog_actor() {
        for start in ["main", "feature/other", "origin/main", "refs/remotes/origin/main"] {
            let log =
                line('0', "creator@example.invalid", &format!("branch: Created from {start}")) + &line('a', "other@example.invalid", "commit: Later work");
            assert_eq!(parse(&log, "topic").unwrap().email, "creator@example.invalid", "{start}");
        }
        let same = line('0', "creator@example.invalid", "branch: Created from topic");
        assert!(parse(&same, "topic").is_none());
    }
    #[test]
    fn explicit_revision_expressions_are_not_plain_remote_imports() {
        for start in ["HEAD~1", "main^", "main^{commit}", "@{-1}", "origin/topic~1", "refs/remotes/origin/topic^0"] {
            assert!(parse(&line('0', "creator@example.invalid", &format!("branch: Created from {start}")), "topic").is_some(), "{start}");
        }
        for start in [
            "origin/topic",
            "refs/remotes/origin/topic",
            "@{u}",
            "@{U}",
            "main@{upstream}",
            "main@{UPSTREAM}",
            "main@{UpStReAm}",
            "refs/heads/main@{push}",
            "main@{PUSH}",
            "main@{PuSh}",
        ] {
            assert!(parse(&line('0', "creator@example.invalid", &format!("branch: Created from {start}")), "topic").is_none(), "{start}");
        }
    }
}
