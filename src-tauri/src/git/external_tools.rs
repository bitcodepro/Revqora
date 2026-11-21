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

/// The installed tools as `--tool-help` lists them, for one set of tool settings.
#[derive(Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
struct Lists {
    key: String,
    /// When they were read (seconds since 1970).
    at: u64,
    diff: Vec<String>,
    merge: Vec<String>,
}

/// Lists older than this are still shown, and read again in the background.
const REFRESH_AFTER_SECS: u64 = 24 * 60 * 60;
/// Tool settings kept on disk at most (one per set of settings, the newest).
const KEPT_LISTS: usize = 16;

static MEMO: std::sync::Mutex<Vec<Lists>> = std::sync::Mutex::new(Vec::new());
/// One reading at a time: a second caller waits for it and takes its lists.
static READING: std::sync::Mutex<()> = std::sync::Mutex::new(());
static REFRESHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_secs()).unwrap_or(0)
}

fn lists_file() -> Option<PathBuf> {
    crate::portable::data_dir().map(|dir| dir.join("external-tools.json"))
}

/// The lists read for `key`: from memory, else from `file` (portable data).
fn lookup(key: &str, file: Option<&Path>) -> Option<Lists> {
    let mut memo = MEMO.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(lists) = memo.iter().find(|lists| lists.key == key) {
        return Some(lists.clone());
    }
    let stored: Vec<Lists> = file.and_then(|file| std::fs::read(file).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    let lists = stored.into_iter().find(|lists| lists.key == key)?;
    memo.push(lists.clone());
    Some(lists)
}

/// Keeps `lists` in memory and in `file`, replacing older lists for the same settings.
fn remember(lists: &Lists, file: Option<&Path>) {
    let mut memo = MEMO.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    memo.retain(|known| known.key != lists.key);
    memo.push(lists.clone());
    let Some(file) = file else { return };
    let mut stored: Vec<Lists> = std::fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    stored.retain(|known| known.key != lists.key);
    stored.push(lists.clone());
    stored.sort_by_key(|known| std::cmp::Reverse(known.at));
    stored.truncate(KEPT_LISTS);
    if let Ok(bytes) = serde_json::to_vec(&stored) {
        let _ = std::fs::write(file, bytes);
    }
}

/// What the lists depend on besides the installed programs: the difftool and mergetool
/// settings and `PATH`. Settings only the user or the system gives are the same for every
/// repository, so those lists are shared; a repository with tool settings of its own gets
/// lists of its own (`own`). Read with the configured defaults, in one Git command.
struct ToolSettings {
    key: String,
    own: bool,
    diff_default: Option<String>,
    merge_default: Option<String>,
}

fn tool_settings(repo: &Path) -> ToolSettings {
    use std::hash::{Hash, Hasher};
    let lines = runner::run(repo, ["config", "--show-scope", "--get-regexp", r"^((diff|merge)tool\.|(diff|merge)\.tool$)"]).unwrap_or_default();
    // "<scope>\t<name> <value>"
    let entries: Vec<(&str, &str, &str)> = lines
        .lines()
        .filter_map(|line| {
            let (scope, rest) = line.split_once('\t')?;
            let (name, value) = rest.split_once(' ').unwrap_or((rest, ""));
            Some((scope, name, value.trim()))
        })
        .collect();
    // Like `git config --get`: the last value counts.
    let value = |wanted: &str| entries.iter().rev().find(|(_, name, value)| *name == wanted && !value.is_empty()).map(|(_, _, value)| (*value).to_owned());
    let tools: Vec<&(&str, &str, &str)> = entries.iter().filter(|(_, name, _)| name.starts_with("difftool.") || name.starts_with("mergetool.")).collect();
    let own = tools.iter().any(|(scope, _, _)| matches!(*scope, "local" | "worktree"));
    let mut path = std::collections::hash_map::DefaultHasher::new();
    std::env::var_os("PATH").hash(&mut path);
    let mut key = format!("path={:x}", path.finish());
    for (scope, name, value) in &tools {
        key.push_str(&format!("\n{scope} {name} {value}"));
    }
    if own {
        key = format!("repository={}\n{key}", std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_owned()).display());
    }
    ToolSettings { key, own, diff_default: value("diff.tool").or_else(|| value("merge.tool")), merge_default: value("merge.tool") }
}

/// Runs `git difftool --tool-help` and `git mergetool --tool-help` at once. Git's script
/// checks every tool it knows, about half a minute on Windows. Lists that hold for every
/// repository are read in Git's own folder, not in `repo`: the script's shell would otherwise
/// keep `repo` in use that long, also after Revqora exits. On Windows the script gets a hidden
/// console (other Git commands run without one): its shell starts dozens of processes, and
/// without a console that took half as long again. In the background, at below-normal priority.
fn read_lists(repo: &Path, key: String, own: bool, background: bool) -> Lists {
    static NEUTRAL: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    let neutral = NEUTRAL
        .get_or_init(|| runner::run(repo, ["--exec-path"]).ok().map(|dir| PathBuf::from(dir.trim())).filter(|dir| dir.is_dir()))
        .as_deref()
        .filter(|_| !own);
    let help = |cmd: &str| -> String {
        let mut command = runner::command(repo);
        if let Some(dir) = neutral {
            command.current_dir(dir).env("GIT_CEILING_DIRECTORIES", dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
            command.creation_flags(CREATE_NO_WINDOW | if background { BELOW_NORMAL_PRIORITY_CLASS } else { 0 });
        }
        #[cfg(not(windows))]
        let _ = background;
        let out = command.args([cmd, "--tool-help"]).stdin(Stdio::null()).output();
        out.map(|o| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))).unwrap_or_default()
    };
    let (diff, merge) = std::thread::scope(|scope| {
        let diff = scope.spawn(|| installed(&help("difftool")));
        let merge = installed(&help("mergetool"));
        (diff.join().unwrap_or_default(), merge)
    });
    Lists { key, at: now_secs(), diff, merge }
}

/// The lists for `key`: known ones at once (read again in the background when old), else
/// read now with `read`.
fn lists_for(key: &str, file: Option<&Path>, now: u64, read: impl FnOnce() -> Lists, refresh: impl FnOnce()) -> Lists {
    if let Some(lists) = lookup(key, file) {
        if now.saturating_sub(lists.at) > REFRESH_AFTER_SECS {
            refresh();
        }
        return lists;
    }
    let _reading = READING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(lists) = lookup(key, file) {
        return lists;
    }
    let lists = read();
    remember(&lists, file);
    lists
}

/// Graphical diff and merge tools found on this machine, and the configured defaults. The
/// lists are kept (in memory and in portable data) for the tool settings they were read with,
/// so only the first reading waits for Git; a day later they are read again in the background.
pub fn tools(repo: &Path) -> GitResult<ExternalTools> {
    let ToolSettings { key, own, diff_default, merge_default } = tool_settings(repo);
    let file = lists_file();
    let refresh = || {
        if REFRESHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let (repo, key, file) = (repo.to_owned(), key.clone(), file.clone());
        std::thread::spawn(move || {
            let lists = read_lists(&repo, key, own, true);
            remember(&lists, file.as_deref());
            REFRESHING.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    };
    let lists = lists_for(&key, file.as_deref(), now_secs(), || read_lists(repo, key.clone(), own, false), refresh);
    Ok(ExternalTools { diff_tools: lists.diff, merge_tools: lists.merge, diff_default, merge_default })
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
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    resolve_program_in(name, &std::env::var_os("PATH")?, cfg!(windows).then_some(pathext.as_str()))
}

/// `pathext` is Windows' PATHEXT (None elsewhere). On Windows a bare name is tried with each
/// extension; a name that already ends in one (`notepad.exe`, `code.cmd`) is taken as is.
fn resolve_program_in(name: &str, path: &std::ffi::OsStr, pathext: Option<&str>) -> Option<PathBuf> {
    let given = Path::new(name);
    if given.components().count() > 1 || given.is_absolute() {
        return given.is_file().then(|| given.to_path_buf());
    }
    let exts: Vec<String> = match pathext {
        Some(list) => list.split(';').filter(|x| !x.is_empty()).map(|x| x.to_ascii_lowercase()).collect(),
        None => Vec::new(),
    };
    let lower = name.to_ascii_lowercase();
    let has_ext = exts.iter().any(|e| lower.ends_with(e.as_str()));
    // Elsewhere: the name itself. On Windows: the name when it already has an executable
    // extension, else the name with each extension (never an extension-less file).
    let candidates: Vec<String> = match pathext {
        None => vec![name.to_string()],
        Some(_) if has_ext => vec![name.to_string()],
        Some(_) => exts.iter().map(|e| format!("{name}{e}")).collect(),
    };
    for dir in std::env::split_paths(path) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
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
    fn tool_settings_give_the_defaults_and_tell_a_repository_with_tools_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(dir.path()).args(args).status().unwrap().success());
        git(&["init", "-q"]);
        let plain = tool_settings(dir.path());
        assert!(!plain.own);
        git(&["config", "merge.tool", "first"]);
        git(&["config", "--add", "merge.tool", "meld"]);
        let defaults = tool_settings(dir.path());
        assert_eq!(defaults.merge_default.as_deref(), Some("meld"), "the last value counts");
        git(&["config", "diff.tool", "kdiff3"]);
        let defaults = tool_settings(dir.path());
        assert_eq!(defaults.diff_default.as_deref(), Some("kdiff3"));
        assert!(!defaults.own);
        assert_eq!(defaults.key, plain.key, "a default is no reason to read the lists again");
        git(&["config", "difftool.mine.cmd", "mine \"$LOCAL\" \"$REMOTE\""]);
        let own = tool_settings(dir.path());
        assert!(own.own);
        assert_ne!(own.key, plain.key);
        assert!(own.key.contains("difftool.mine.cmd"), "{}", own.key);
    }

    #[test]
    fn tool_lists_are_read_once_per_settings_and_refreshed_in_the_background_when_old() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("external-tools.json");
        let key = format!("test-{}-{:?}", std::process::id(), std::thread::current().id());
        let read = |diff: &str| Lists { key: key.clone(), at: 1_000, diff: vec![diff.to_owned()], merge: vec!["meld".to_owned()] };
        let first = lists_for(&key, Some(&file), 1_000, || read("meld"), || panic!("nothing to refresh"));
        assert_eq!(first.diff, ["meld"]);
        // Known now: not read again, also after a restart (only the file left).
        let again = lists_for(&key, Some(&file), 2_000, || panic!("read twice"), || panic!("not old"));
        assert_eq!(again, first);
        MEMO.lock().unwrap().retain(|lists| lists.key != key);
        let stored = lists_for(&key, Some(&file), 2_000, || panic!("read after a restart"), || panic!("not old"));
        assert_eq!(stored, first);
        // Old: shown at once, and read again in the background.
        let mut refreshed = false;
        let old = lists_for(&key, Some(&file), 1_000 + REFRESH_AFTER_SECS + 1, || panic!("waited for a reading"), || refreshed = true);
        assert!(refreshed);
        assert_eq!(old, first);
        // Other settings: read for themselves.
        let other = format!("{key}-other");
        let lists = lists_for(&other, Some(&file), 3_000, || Lists { key: other.clone(), at: 3_000, diff: vec![], merge: vec![] }, || {});
        assert!(lists.diff.is_empty());
        assert_eq!(serde_json::from_slice::<Vec<Lists>>(&std::fs::read(&file).unwrap()).unwrap().len(), 2);
    }

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
    fn programs_are_found_on_path_with_or_without_their_extension() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("code.cmd"), "@echo off").unwrap();
        std::fs::write(dir.path().join("notepad.exe"), "").unwrap();
        std::fs::write(dir.path().join("plain"), "").unwrap();
        let path = std::env::join_paths([dir.path()]).unwrap();
        let win = Some(".COM;.EXE;.BAT;.CMD");
        assert_eq!(resolve_program_in("code", &path, win), Some(dir.path().join("code.cmd")));
        assert_eq!(resolve_program_in("code.cmd", &path, win), Some(dir.path().join("code.cmd")));
        assert_eq!(resolve_program_in("notepad.exe", &path, win), Some(dir.path().join("notepad.exe")));
        assert_eq!(resolve_program_in("plain", &path, win), None, "Windows never runs an extension-less file");
        assert_eq!(resolve_program_in("plain", &path, None), Some(dir.path().join("plain")));
        assert_eq!(resolve_program_in("missing", &path, win), None);
    }

    #[test]
    fn tool_help_lists_installed_graphical_tools_only() {
        let help = "'git difftool --tool=<tool>' may be set to one of the following:\n\t\tbc               Use Beyond Compare\n\t\tvimdiff          Use Vim\n\t\tmeld\n\n\tuser-defined:\n\t\tvscode.cmd code --wait --diff $LOCAL $REMOTE\n\nThe following tools are valid, but not currently available:\n\t\tkdiff3\n";
        assert_eq!(installed(help), ["bc", "meld", "vscode"]);
        assert!(installed("nothing here").is_empty());
    }
}
