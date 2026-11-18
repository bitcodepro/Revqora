//! Copyable diagnostics reports (Error log, Operation log, PR Center, Check connection).
//!
//! The UI supplies the lines that describe one problem; this module adds the versions and
//! platform and removes what must never be shared: tokens, authorization headers,
//! credentials in URLs, private keys and file contents (diff lines).
use serde::Deserialize;

use crate::journal::redact;

const LINE_LIMIT: usize = 600;
const REPORT_LIMIT: usize = 24 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    /// Where the report was made: "Error log", "Operation log", "PR Center", "Check connection".
    pub source: String,
    /// "Label: value" lines and plain lines, in display order.
    pub lines: Vec<String>,
}

pub struct Environment {
    pub app_version: String,
    pub git_version: String,
    pub created_ms: i64,
    /// The user's home folder, shown as `~` (it usually contains the account name).
    pub home: Option<String>,
}

/// Replaces the home folder in paths with `~`, with either separator and any letter case.
fn shorten_home(text: &str, home: Option<&str>) -> String {
    let Some(home) = home.map(|home| home.trim_end_matches(['/', '\\'])).filter(|home| home.len() > 3) else { return text.to_owned() };
    let mut out = text.to_owned();
    for variant in [home.to_owned(), home.replace('\\', "/"), home.replace('/', "\\")] {
        let pattern = regex::RegexBuilder::new(&regex::escape(&variant)).case_insensitive(true).build();
        if let Ok(pattern) = pattern {
            out = pattern.replace_all(&out, "~").into_owned();
        }
    }
    out
}

/// Lines that carry file contents: diff headers and hunks, and added or removed lines.
fn is_file_content(line: &str) -> bool {
    let trimmed = line.trim_start();
    ["diff --git ", "@@ ", "+++ ", "--- ", "Binary files "].iter().any(|prefix| trimmed.starts_with(prefix))
}

pub fn report(input: &Input, environment: &Environment) -> String {
    let mut lines = vec![
        "Revqora diagnostics report".to_owned(),
        format!("Revqora: {}", environment.app_version),
        format!("Git: {}", environment.git_version),
        format!("Platform: {} {}", std::env::consts::OS, std::env::consts::ARCH),
        format!("Created: {}", crate::git::forge::iso_from_millis(environment.created_ms)),
        format!("Source: {}", input.source),
        String::new(),
    ];
    let mut omitted = false;
    for entry in &input.lines {
        // Redact the whole entry first: a private key spans several lines.
        let entry = shorten_home(&redact::text(entry), environment.home.as_deref());
        // Once a diff starts, the rest of the entry up to a blank line is file content.
        let mut in_block = false;
        for line in entry.lines() {
            if is_file_content(line) {
                in_block = true;
            }
            if in_block {
                if line.trim().is_empty() {
                    in_block = false;
                } else {
                    omitted = true;
                    continue;
                }
            }
            lines.push(redact::bounded(line, LINE_LIMIT).0);
        }
    }
    if omitted {
        lines.push("[file contents omitted]".into());
    }
    let text = lines.join("\n");
    let (mut text, cut) = redact::bounded(&text, REPORT_LIMIT);
    if cut {
        text.push_str("\n[report shortened]");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment() -> Environment {
        Environment { app_version: "0.1.66".into(), git_version: "git version 2.45.1.windows.1".into(), created_ms: 0, home: Some(r"C:\Users\Person".into()) }
    }

    #[test]
    fn a_report_names_the_environment_and_keeps_diagnostic_facts() {
        let input = Input {
            source: "Check connection".into(),
            lines: vec![
                "Remote: origin · https://bitbucket.org/team/repo.git".into(),
                "✗ Account profile — limited · HTTP 403 · request ID AB12:34CD · 210 ms".into(),
            ],
        };
        let text = report(&input, &environment());
        assert!(text.starts_with("Revqora diagnostics report\nRevqora: 0.1.66\nGit: git version 2.45.1.windows.1\nPlatform: "), "{text}");
        assert!(text.contains("Created: 1970-01-01"), "{text}");
        assert!(text.contains("Source: Check connection"));
        assert!(text.contains("HTTP 403 · request ID AB12:34CD · 210 ms"));
    }

    #[test]
    fn a_report_never_contains_secrets_or_file_contents() {
        let input = Input {
            source: "Error log".into(),
            lines: vec![
                "Remote: https://someone:hunter2secret@example.com/team/repo.git".into(),
                "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789".into(),
                "PRIVATE-TOKEN: glpat-abcdefghijklmnop".into(),
                "request https://example.com/api?access_token=queryTokenValue&page=2".into(),
                "Git: fatal: Authentication failed with token=plainTokenValue".into(),
                "Bitbucket ATATT3xFfGF0abcdefghijklmnopqrstu".into(),
                "-----BEGIN OPENSSH PRIVATE KEY-----\nkeymaterial\n-----END OPENSSH PRIVATE KEY-----".into(),
                "diff --git a/secret.env b/secret.env\n@@ -1 +1 @@\n-PASSWORD_HINT=old value\n+fileContentLine\n".into(),
                "After the diff".into(),
            ],
        };
        let text = report(&input, &environment());
        for secret in [
            "hunter2secret",
            "someone:",
            "ghp_abcdef",
            "glpat-abc",
            "queryTokenValue",
            "plainTokenValue",
            "ATATT3x",
            "keymaterial",
            "fileContentLine",
            "PASSWORD_HINT",
            "secret.env",
        ] {
            assert!(!text.contains(secret), "{secret} leaked:\n{text}");
        }
        assert!(text.contains("page=2") && text.contains("After the diff") && text.contains("[file contents omitted]"), "{text}");
    }

    #[test]
    fn the_home_folder_becomes_a_tilde() {
        let input = Input { source: "Error log".into(), lines: vec![r"Path: c:\users\person\work\repo and C:/Users/Person/other".into()] };
        let text = report(&input, &environment());
        assert!(text.contains(r"Path: ~\work\repo and ~/other"), "{text}");
        assert!(!text.to_lowercase().contains("person"));
    }

    #[test]
    fn long_reports_are_bounded() {
        let input = Input { source: "Operation log".into(), lines: vec!["x".repeat(5_000); 100] };
        let text = report(&input, &environment());
        assert!(text.len() < REPORT_LIMIT + 64);
        assert!(text.ends_with("[report shortened]"));
    }
}
