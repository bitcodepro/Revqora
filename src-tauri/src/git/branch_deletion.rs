//! Resolve destructive server targets from fetch mappings, never from display names.
use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::runner::{self, GitError, GitResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranchTarget {
    pub label: String,
    pub remote: String,
    pub remote_ref: String,
    pub tracking_ref: String,
    pub oid: String,
    pub is_upstream: bool,
}

fn substitute(pattern: &str, replacement: &str, value: &str) -> Option<String> {
    match (pattern.split_once('*'), replacement.split_once('*')) {
        (None, None) => (pattern == value).then(|| replacement.to_owned()),
        (Some((prefix, suffix)), Some((left, right))) if !suffix.contains('*') && !right.contains('*') => {
            let middle = value.strip_prefix(prefix)?.strip_suffix(suffix)?;
            Some(format!("{left}{middle}{right}"))
        }
        _ => None,
    }
}

fn excluded(spec: &str, source: &str) -> bool {
    spec.strip_prefix('^').is_some_and(|pattern| substitute(pattern, pattern, source).is_some())
}

pub fn targets(repo: &Path, name: &str) -> GitResult<Vec<RemoteBranchTarget>> {
    runner::run(repo, ["check-ref-format", "--branch", name])?;
    let local_ref = format!("refs/heads/{name}");
    let upstream = runner::run(repo, ["for-each-ref", "--format=%(refname)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream)", &local_ref])?;
    let upstream: Vec<&str> = upstream.lines().find(|line| line.split('\t').next() == Some(local_ref.as_str())).unwrap_or("").split('\t').collect();
    let refs = runner::run(repo, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)"])?;
    let mut result = Vec::new();
    for remote in runner::run(repo, ["remote"])?.lines() {
        let config = runner::exec(repo, ["config", "--get-all", &format!("remote.{remote}.fetch")])?;
        if config.code != 0 && config.code != 1 {
            return Err(runner::to_error("git config --get-all", &config));
        }
        let config_text = config.text();
        let specs: Vec<&str> = config_text.lines().collect();
        for line in refs.lines() {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() != 3 || !fields[2].is_empty() || fields[0].starts_with("refs/heads/") {
                continue;
            }
            let tracking_ref = fields[0];
            let mut sources = BTreeSet::new();
            for spec in &specs {
                let spec = spec.strip_prefix('+').unwrap_or(spec);
                if let Some((source, destination)) = spec.split_once(':') {
                    if let Some(source) = substitute(destination, source, tracking_ref) {
                        if source.starts_with("refs/heads/") && !specs.iter().any(|s| excluded(s, &source)) {
                            sources.insert(source);
                        }
                    }
                }
            }
            // Git resolves the configured upstream even when its tracking name was renamed.
            let is_upstream = upstream.len() == 4 && upstream[1] == remote && upstream[3] == tracking_ref;
            let source = if is_upstream {
                if !upstream[2].starts_with("refs/heads/") || !sources.contains(upstream[2]) {
                    continue;
                }
                upstream[2].to_owned()
            } else if sources.len() == 1 {
                sources.into_iter().next().unwrap()
            } else {
                continue;
            };
            if !is_upstream && source != local_ref {
                continue;
            }
            result.push(RemoteBranchTarget {
                label: format!("{remote}/{}", source.strip_prefix("refs/heads/").unwrap()),
                remote: remote.to_owned(),
                remote_ref: source,
                tracking_ref: tracking_ref.to_owned(),
                oid: fields[1].to_owned(),
                is_upstream,
            });
        }
    }
    result.sort_by(|a, b| b.is_upstream.cmp(&a.is_upstream).then(a.label.cmp(&b.label)));
    result.dedup_by(|a, b| a.remote == b.remote && a.remote_ref == b.remote_ref);
    Ok(result)
}

pub fn delete(repo: &Path, name: &str, force: bool, target: Option<&RemoteBranchTarget>) -> GitResult<()> {
    if let Some(target) = target {
        if !targets(repo, name)?.contains(target) {
            return Err(GitError::new("The remote branch mapping or tip changed. Reopen the deletion dialog.").kind("stale-selection"));
        }
        if !force {
            // `branch -d` accepts commits merged only into the upstream we are about to remove.
            // Require a surviving checkout to retain BOTH tips before deleting either label.
            for tip in [&format!("refs/heads/{name}"), &target.oid] {
                let out = runner::exec(repo, ["merge-base", "--is-ancestor", tip, "HEAD"])?;
                if out.code == 1 {
                    return Err(GitError::new(
                        "Branch history is not fully merged into the current checkout. Confirm force deletion before deleting either branch.",
                    )
                    .kind("not-merged"));
                }
                if !out.ok() {
                    return Err(runner::to_error("git merge-base", &out));
                }
            }
        }
    }
    super::ops::delete_branch(repo, name, force)
}
