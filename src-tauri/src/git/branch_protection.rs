//! Action-scoped Branch Manager policy. The reviewed target is validated by the
//! caller before checking names; force consent never overrides this policy.
use super::{
    branch_deletion::RemoteBranchTarget,
    runner::{GitError, GitResult},
};

fn matches(name: &str, pattern: &str) -> bool {
    // Match the frontend's UTF-16 wildcard semantics, including non-BMP names.
    let name: Vec<u16> = name.encode_utf16().collect();
    let pattern: Vec<u16> = pattern.encode_utf16().collect();
    let (mut n, mut p, mut star, mut retry) = (0, 0, None, 0);
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == u16::from(b'?') || pattern[p] == name[n]) {
            n += 1;
            p += 1;
        } else if p < pattern.len() && pattern[p] == u16::from(b'*') {
            star = Some(p);
            p += 1;
            retry = n;
        } else if let Some(s) = star {
            p = s + 1;
            retry += 1;
            n = retry;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == u16::from(b'*') {
        p += 1;
    }
    p == pattern.len()
}

pub fn require_allowed(rules: Option<&[String]>, local: Option<&str>, target: Option<&RemoteBranchTarget>) -> GitResult<()> {
    let Some(rules) = rules else { return Ok(()) };
    let blocked = |name: &str| {
        GitError::new(format!("{name} is protected by Branch Manager rules. Change its rule before deleting this branch.")).kind("protected-branch")
    };
    if rules.len() > 100 || rules.iter().any(|r| r.trim().is_empty() || r.trim() != r || r.encode_utf16().count() > 256) {
        return Err(GitError::new("Invalid Branch Manager protection rules. Reopen the review.").kind("protected-branch"));
    }
    let mut names: Vec<&str> = local.into_iter().collect();
    if let Some(target) = target {
        names.push(target.remote_ref.strip_prefix("refs/heads/").ok_or_else(|| blocked(&target.remote_ref))?);
        names.push(target.tracking_ref.strip_prefix("refs/remotes/").unwrap_or(&target.tracking_ref));
    }
    for name in names {
        if rules.iter().any(|rule| matches(name, rule)) {
            return Err(blocked(name));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::matches;
    #[test]
    fn wildcard_semantics_match_frontend() {
        assert!(matches("release/v1/hotfix", "release/*"));
        assert!(matches("main", "mai?"));
        assert!(!matches("domain", "main"));
        assert!(!matches("main", "[a-z]*"));
        assert!(!matches("🦀", "?"));
        assert!(matches("🦀", "??"));
    }
}
