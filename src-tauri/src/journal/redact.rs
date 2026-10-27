//! Sanitize BEFORE persistence, not just when rendering/exporting the journal.
use std::sync::OnceLock;

use regex::Regex;

pub fn text(value: &str) -> String {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        vec![
            (Regex::new(r"(?i)((?:https?|ssh|git|ftp)://)[^\s@]+@").unwrap(), "$1[redacted]@"),
            (Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----").unwrap(), "[private key omitted]"),
            (Regex::new(r"(?i)([?&](?:access_token|token|auth|key|password|signature|sig|code)=)[^&\s]+").unwrap(), "$1[redacted]"),
            (Regex::new(r"(?im)((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+").unwrap(), "$1[redacted]"),
            (
                Regex::new(r#"(?i)["']?\b(password|passwd|token|secret|credential|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)"#).unwrap(),
                "$1=[redacted]",
            ),
            (
                Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b").unwrap(),
                "[redacted]",
            ),
        ]
    });
    rules.iter().fold(value.to_owned(), |s, (pattern, replacement)| pattern.replace_all(&s, *replacement).into_owned())
}

pub fn bounded(value: &str, bytes: usize) -> (String, bool) {
    if value.len() <= bytes {
        return (value.to_owned(), false);
    }
    let mut end = bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

pub fn args(args: &[String]) -> Vec<String> {
    if args.first().is_some_and(|a| a == "grep") {
        return vec!["grep".into(), "[search arguments omitted]".into()];
    }
    let mut hidden = false;
    let mut config_key = false;
    let mut config_value = false;
    args.iter()
        .map(|arg| {
            if hidden || config_value {
                hidden = false;
                config_value = false;
                return "[argument omitted]".into();
            }
            if config_key && !arg.starts_with('-') {
                config_key = false;
                config_value = true;
            }
            if arg == "config" {
                config_key = true;
            }
            if matches!(arg.as_str(), "-m" | "--message" | "-F" | "--file" | "--author" | "--committer" | "-c" | "--config-env") {
                hidden = true;
            }
            if arg.starts_with('-') && !arg.starts_with("--") {
                if let Some((position, _)) = arg.char_indices().find(|(_, c)| *c == 'm' || *c == 'F') {
                    if position + 1 == arg.len() {
                        hidden = true;
                    } else {
                        return format!("{}[argument omitted]", &arg[..position + 1]);
                    }
                }
            }
            if ["--message=", "--file=", "--author=", "--committer=", "--config-env="].iter().any(|p| arg.starts_with(p)) {
                return format!("{}=[argument omitted]", arg.split('=').next().unwrap());
            }
            if (arg.starts_with("-m") || arg.starts_with("-F")) && arg.len() > 2 {
                return format!("{}[argument omitted]", &arg[..2]);
            }
            bounded(&text(arg), 1024).0
        })
        .take(48)
        .collect()
}

pub fn output_allowed(args: &[String]) -> bool {
    // Content queries and plumbing can return complete source/configuration data.
    // Capture diagnostics of user-facing Git actions, never stdin/environment.
    matches!(
        args.first().map(String::as_str),
        Some(
            "fetch"
                | "push"
                | "clone"
                | "pull"
                | "merge"
                | "rebase"
                | "cherry-pick"
                | "revert"
                | "reset"
                | "checkout"
                | "branch"
                | "tag"
                | "stash"
                | "worktree"
                | "submodule"
                | "lfs"
                | "gc"
                | "prune"
                | "repack"
                | "maintenance"
                | "commit-graph"
                | "init"
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_credentials_before_truncation_and_export() {
        let raw = "https://user:password@example.com/repo?token=abcdef&other=ok\nAuthorization: Bearer abcdef\npassword=secret\nghp_1234567890ABC glpat-1234567890ABC github_pat_1234567890ABC";
        let clean = text(raw);
        for secret in ["user:password", "token=abcdef", "Bearer abcdef", "password=secret", "ghp_123", "glpat-123", "github_pat_123"] {
            assert!(!clean.contains(secret), "{clean}");
        }
        assert!(clean.contains("other=ok"));
        let json = text(r#"{"accessToken":"jsonSecret","client_secret":"clientSecret"}"#);
        assert!(!json.contains("jsonSecret") && !json.contains("clientSecret"));
        assert!(!text("-----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n-----END OPENSSH PRIVATE KEY-----").contains("private material"));
        assert_eq!(bounded("абв", 3), ("а".into(), true));
    }
    #[test]
    fn omits_message_config_and_header_arguments() {
        let clean =
            args(&["-c", "http.extraHeader=Authorization: Bearer secret", "commit", "-m", "Private message", "--author=Private identity"].map(str::to_owned));
        assert!(!clean.join(" ").contains("secret"));
        assert!(!clean.join(" ").contains("Private"));
        let clean = args(&["config", "--add", "credential.helper", "Private value"].map(str::to_owned));
        assert!(!clean.join(" ").contains("Private value"));
        assert!(!output_allowed(&["diff".into()]));
        assert!(!output_allowed(&["config".into()]));
        assert!(!output_allowed(&["cat-file".into()]));
        assert!(output_allowed(&["fetch".into()]));
    }
}
