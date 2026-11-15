//! External diff / merge tools (through Git's own difftool / mergetool configuration) and an
//! external editor opened at a line. Nothing goes through a shell: commands are argv lists.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use super::runner::{self, GitError, GitResult};

/// Git's empty tree, the "before" side of a root commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Tools that need a terminal. Revqora has none to give them, so Git would wait forever.
const TERMINAL_TOOLS: &[&str] = &["vimdiff", "vimdiff1", "vimdiff2", "vimdiff3", "nvimdiff", "nvimdiff1", "nvimdiff2", "nvimdiff3", "emerge"];

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExternalTools {
    /// Graphical tools Git knows and found installed (`--tool-help`, "may be set to").
    pub diff_tools: Vec<String>,
    pub merge_tools: Vec<String>,
    /// The repository's / user's configured defaults (`diff.tool`, `merge.tool`), if any.
    pub diff_default: Option<String>,
    pub merge_default: Option<String>,
}

/// Names listed under "may be set to the following" in `git difftool/mergetool --tool-help`:
/// the tools found on this machine (the "available" list follows other headings).
fn installed(help: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in help.lines() {
        let trimmed = line.trim();
        if trimmed.contains("may be set to") {
            inside = true;
            continue;
        }
        if inside {
            if trimmed.is_empty() {
                continue;
            }
            if !line.starts_with(char::is_whitespace) {
                break; // the next section
            }
            // User-defined tools are listed as "<name>.cmd <command>".
            let first = trimmed.split_whitespace().next().unwrap_or("");
            let name = first.strip_suffix(".cmd").unwrap_or(first);
            if !name.is_empty() && !TERMINAL_TOOLS.contains(&name) && valid_tool(name) && !out.iter().any(|n| n == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

fn valid_tool(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn config(repo: &Path, key: &str) -> Option<String> {
    runner::run(repo, ["config", "--get", key]).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub fn tools(repo: &Path) -> GitResult<ExternalTools> {
    let help = |cmd: &str| -> String {
        let out = runner::command(repo).args([cmd, "--tool-help"]).stdin(Stdio::null()).output();
        out.map(|o| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))).unwrap_or_default()
    };
    Ok(ExternalTools {
        diff_tools: installed(&help("difftool")),
        merge_tools: installed(&help("mergetool")),
        diff_default: config(repo, "diff.tool").or_else(|| config(repo, "merge.tool")),
        merge_default: config(repo, "merge.tool"),
    })
}

/// The tool to run: the chosen one, else Git's configured default. Without either Git would
/// fall back to a terminal tool and hang, so ask the user to choose.
fn pick(repo: &Path, chosen: Option<&str>, key: &str, what: &str) -> GitResult<String> {
    let tool = chosen.map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).or_else(|| config(repo, key));
    match tool {
        Some(t) if TERMINAL_TOOLS.contains(&t.as_str()) => {
            Err(GitError::new(format!("{t} runs in a terminal, which Revqora cannot show. Choose a graphical {what} tool in Settings.")).kind("terminal-tool"))
        }
        Some(t) if valid_tool(&t) => Ok(t),
        Some(t) => Err(GitError::new(format!("\"{t}\" is not a valid {what} tool name.")).kind("invalid-argument")),
        None => Err(GitError::new(format!("Choose an external {what} tool in Settings → Diff first.")).kind("no-external-tool")),
    }
}

fn check_path(path: &str) -> GitResult<()> {
    if path.is_empty() || path.split('/').any(|p| p == "..") {
        return Err(GitError::new("Invalid file path.").kind("invalid-argument"));
    }
    Ok(())
}

fn check_rev(rev: &str) -> GitResult<()> {
    if rev.starts_with('-') || rev.is_empty() || rev.chars().any(|c| c.is_whitespace()) {
        return Err(GitError::new("Invalid revision.").kind("invalid-argument"));
    }
    Ok(())
}

/// Runs a tool until it is closed. Errors carry Git's message (e.g. the tool is missing).
fn run_until_closed(repo: &Path, args: &[String]) -> GitResult<()> {
    let out = runner::command(repo)
        .args(args)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| GitError::new(format!("Could not start Git: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(GitError::new(if message.is_empty() { "The external tool reported an error.".into() } else { message }).kind("external-tool-failed"))
}

/// Which two versions of `path` to compare: the working file against the index ("unstaged"),
/// the index against HEAD ("staged"), or a commit against its parent / another commit.
pub fn difftool(repo: &Path, path: &str, side: &str, from: Option<&str>, to: Option<&str>, tool: Option<&str>) -> GitResult<()> {
    check_path(path)?;
    let tool = pick(repo, tool, "diff.tool", "diff")?;
    let mut args: Vec<String> = vec!["difftool".into(), "--no-prompt".into(), format!("--tool={tool}")];
    match side {
        "unstaged" => {}
        "staged" => args.push("--cached".into()),
        "commits" => {
            let to = to.ok_or_else(|| GitError::new("Choose a commit to compare.").kind("invalid-argument"))?;
            let from = from.unwrap_or(EMPTY_TREE);
            check_rev(from)?;
            check_rev(to)?;
            args.push(from.into());
            args.push(to.into());
        }
        _ => return Err(GitError::new("Unknown comparison.").kind("invalid-argument")),
    }
    args.push("--".into());
    args.push(path.into());
    run_until_closed(repo, &args)
}

/// Resolves a conflicted file in the merge tool. Git stages the result when the tool reports
/// success; Revqora refreshes afterwards. No backup `.orig` files are left behind.
pub fn mergetool(repo: &Path, path: &str, tool: Option<&str>) -> GitResult<()> {
    check_path(path)?;
    let tool = pick(repo, tool, "merge.tool", "merge")?;
    let args: Vec<String> =
        ["-c", "mergetool.keepBackup=false", "mergetool", "--no-prompt", &format!("--tool={tool}"), "--", path].iter().map(|s| s.to_string()).collect();
    run_until_closed(repo, &args)
}

/// Splits an editor command template into arguments: spaces separate, double or single quotes
/// group. `{file}`, `{line}` and `{column}` are replaced inside arguments; without `{file}` the
/// file is added as the last argument.
pub fn editor_argv(template: &str, file: &str, line: u32, column: u32) -> GitResult<Vec<String>> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in template.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => {
                current.push(c);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return Err(GitError::new("The editor command has an unclosed quote.").kind("invalid-editor-command"));
    }
    if started {
        args.push(current);
    }
    if args.is_empty() {
        return Err(GitError::new("The editor command is empty.").kind("invalid-editor-command"));
    }
    let has_file = args.iter().any(|a| a.contains("{file}"));
    let mut out: Vec<String> = args
        .into_iter()
        .map(|a| a.replace("{file}", file).replace("{line}", &line.max(1).to_string()).replace("{column}", &column.max(1).to_string()))
        .collect();
    if !has_file {
        out.push(file.to_string());
    }
    Ok(out)
}

/// Finds a program on PATH, including Windows `.cmd`/`.bat` launchers (VS Code's `code` is
/// `code.cmd`). Rust quotes arguments safely for those when the full path is given.
fn resolve_program(name: &str) -> Option<PathBuf> {
    let given = Path::new(name);
    if given.components().count() > 1 || given.is_absolute() {
        return given.is_file().then(|| given.to_path_buf());
    }
    let exts: Vec<String> = if cfg!(windows) {
        let mut e = vec![String::new()];
        e.extend(
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()).split(';').filter(|x| !x.is_empty()).map(|x| x.to_ascii_lowercase()),
        );
        e
    } else {
        vec![String::new()]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() && (cfg!(windows) && !ext.is_empty() || !cfg!(windows)) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Opens `path` (inside the repository) in the configured editor at `line`.
pub fn open_in_editor(repo: &Path, path: &str, line: u32, column: u32, template: &str) -> GitResult<()> {
    check_path(path)?;
    let full = repo.join(path);
    let file = full.to_string_lossy().into_owned();
    let argv = editor_argv(template, &file, line, column)?;
    let program = resolve_program(&argv[0])
        .ok_or_else(|| GitError::new(format!("The editor \"{}\" was not found. Check the command in Settings → Diff.", argv[0])).kind("editor-not-found"))?;
    std::process::Command::new(program)
        .args(&argv[1..])
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| GitError::new(format!("Could not start the editor: {e}")).kind("editor-not-found"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_templates_split_like_a_command_line_without_a_shell() {
        let argv = editor_argv("code --goto {file}:{line}:{column}", "C:/r/a b.rs", 12, 3).unwrap();
        assert_eq!(argv, ["code", "--goto", "C:/r/a b.rs:12:3"]);
        let argv = editor_argv("\"C:/Program Files/Ed/ed.exe\" -n{line}", "f.txt", 0, 0).unwrap();
        assert_eq!(argv, ["C:/Program Files/Ed/ed.exe", "-n1", "f.txt"]);
        let argv = editor_argv("subl '{file}:{line}' ; rm -rf /", "x", 2, 1).unwrap();
        assert_eq!(argv, ["subl", "x:2", ";", "rm", "-rf", "/"], "no shell: separators are plain arguments");
        assert!(editor_argv("  ", "x", 1, 1).is_err());
        assert!(editor_argv("ed \"unclosed", "x", 1, 1).is_err());
    }

    #[test]
    fn tool_help_lists_installed_graphical_tools_only() {
        let help = "'git difftool --tool=<tool>' may be set to one of the following:\n\t\tbc               Use Beyond Compare\n\t\tvimdiff          Use Vim\n\t\tmeld\n\n\tuser-defined:\n\t\tvscode.cmd code --wait --diff $LOCAL $REMOTE\n\nThe following tools are valid, but not currently available:\n\t\tkdiff3\n";
        assert_eq!(installed(help), ["bc", "meld", "vscode"]);
        assert!(installed("nothing here").is_empty());
    }
}
