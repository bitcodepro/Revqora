//! Reads what a finished `git fetch` reported, beyond its exit code: tags that moved on the
//! server (Git refuses to replace a local tag and fails the whole fetch), and which remotes of a
//! `fetch --all` failed. Also keeps the moved tags until the user updates them.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One fetch's report. Built from the progress/error text Git wrote to stderr.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Report {
    /// Tags the server moved, with the remote that reported them (`None` when Git did not say).
    pub clobbered: Vec<(String, Option<String>)>,
    /// Remotes that failed for another reason, with Git's first error line.
    pub failed: Vec<(String, String)>,
    /// An error line that no `could not fetch <remote>` followed (a single-remote fetch).
    pub trailing: Option<String>,
}

fn problem(line: &str) -> Option<String> {
    let clean = |s: &str| s.trim().to_owned();
    if let Some(rest) = line.strip_prefix("fatal: ").or_else(|| line.strip_prefix("error: ")) {
        return Some(clean(rest));
    }
    line.starts_with("! [").then(|| clean(line))
}

pub(super) fn parse(text: &str) -> Report {
    let mut report = Report::default();
    let mut pending_tags: Vec<String> = Vec::new();
    let mut pending_problem: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(remote) = line.strip_prefix("error: could not fetch ") {
            let remote = remote.trim().to_owned();
            report.clobbered.extend(pending_tags.drain(..).map(|tag| (tag, Some(remote.clone()))));
            if let Some(problem) = pending_problem.take() {
                report.failed.push((remote, problem));
            }
            continue;
        }
        if let Some(spec) = line.strip_prefix("! [rejected]").and_then(|rest| rest.trim_end().strip_suffix("(would clobber existing tag)")) {
            if let Some(name) = spec.split("->").next().map(str::trim).filter(|name| !name.is_empty()) {
                pending_tags.push(name.to_owned());
            }
            continue;
        }
        if pending_problem.is_none() {
            pending_problem = problem(line);
        }
    }
    report.clobbered.extend(pending_tags.into_iter().map(|tag| (tag, None)));
    report.trailing = pending_problem;
    report
}

/// Tags that moved on the server and were kept locally, per repository: tag name to remote.
static MOVED: Mutex<Option<HashMap<PathBuf, BTreeMap<String, String>>>> = Mutex::new(None);

fn key(repo: &Path) -> PathBuf {
    std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_owned())
}

/// Records the moved tags of a fetch. A fetch of every remote replaces the list; a fetch of
/// one remote replaces that remote's entries.
pub(super) fn record(repo: &Path, fetched: Option<&str>, tags: &[(String, String)]) {
    let mut moved = MOVED.lock().unwrap_or_else(|e| e.into_inner());
    let entry = moved.get_or_insert_with(HashMap::new).entry(key(repo)).or_default();
    match fetched {
        Some(remote) => entry.retain(|_, from| from != remote),
        None => entry.clear(),
    }
    entry.extend(tags.iter().cloned());
}

pub(super) fn forget(repo: &Path, tags: &[String]) {
    let mut moved = MOVED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = moved.as_mut().and_then(|all| all.get_mut(&key(repo))) {
        for tag in tags {
            entry.remove(tag);
        }
    }
}

/// Moved tags, sorted, each with the remote that has the new version.
pub(super) fn moved(repo: &Path) -> Vec<(String, String)> {
    let moved = MOVED.lock().unwrap_or_else(|e| e.into_inner());
    moved.as_ref().and_then(|all| all.get(&key(repo))).map(|entry| entry.iter().map(|(t, r)| (t.clone(), r.clone())).collect()).unwrap_or_default()
}

/// The note appended to a fetch's output when tags moved.
pub(super) fn notice(tags: &[(String, String)]) -> String {
    let names: Vec<&str> = tags.iter().map(|(tag, _)| tag.as_str()).collect();
    let shown = if names.len() > 5 { format!("{} and {} more", names[..5].join(", "), names.len() - 5) } else { names.join(", ") };
    format!("Tags changed on the server; your local versions were kept: {shown}. Use Update moved tags to take the server's versions.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moved_tag_alone_is_not_a_failure() {
        let single = "From ../r\n   f06fd97..33a572c main       -> origin/main\n ! [rejected] nightly    -> nightly  (would clobber existing tag)\n";
        assert_eq!(parse(single), Report { clobbered: vec![("nightly".into(), None)], failed: vec![], trailing: None });
    }

    #[test]
    fn fetch_all_names_each_failed_remote() {
        let all = "From ../r\n ! [rejected] nightly    -> nightly  (would clobber existing tag)\nerror: could not fetch origin\nfatal: 'C:/x.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\nerror: could not fetch broken\n";
        let report = parse(all);
        assert_eq!(report.clobbered, vec![("nightly".into(), Some("origin".into()))]);
        assert_eq!(report.failed, vec![("broken".into(), "'C:/x.git' does not appear to be a git repository".into())]);
        assert_eq!(report.trailing, None);
    }

    #[test]
    fn a_single_remote_error_is_trailing() {
        let report = parse("fatal: Authentication failed for 'https://example.invalid/x.git/'\n");
        assert_eq!(report.trailing.as_deref(), Some("Authentication failed for 'https://example.invalid/x.git/'"));
        assert!(report.failed.is_empty() && report.clobbered.is_empty());
    }

    #[test]
    fn records_are_kept_per_remote() {
        let dir = tempfile::tempdir_in(crate::portable::temp_dir().unwrap()).unwrap();
        record(dir.path(), None, &[("a".into(), "origin".into()), ("b".into(), "upstream".into())]);
        record(dir.path(), Some("origin"), &[]);
        assert_eq!(moved(dir.path()), vec![("b".to_owned(), "upstream".to_owned())]);
        forget(dir.path(), &["b".into()]);
        assert!(moved(dir.path()).is_empty());
        assert!(notice(&[("v1".into(), "o".into())]).contains("v1"));
    }
}
