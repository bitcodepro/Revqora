# Agent Workspace

Open a repository and choose **Agent Workspace** in the toolbar or command palette.
Choose **New task**, an installed executable, its arguments, a starting revision and
the task. Review the exact commit, new branch/folder and CLI permissions before
enabling **Start agent**. Nothing is sent to a service before this explicit action.
The default worktree folder is under portable data. If the app itself is installed
inside the repository you are opening, choose a new **Worktree folder** outside that
repository; nested worktrees are rejected. This is an explicit working-copy location,
not relocated internal storage: logs, profiles and history still stay beside the exe.

## CLI setup

Install and authenticate your CLI yourself. Revqora does not install agents, manage
AI subscriptions, copy your existing home directory or ask for AI tokens in a text
field. The built-in presets use noninteractive stdin:

- Codex: `exec --sandbox workspace-write -`.
- Claude Code: `--print --permission-mode acceptEdits --no-session-persistence`.
- Other CLI: supply its own arguments; it must accept the prompt on stdin and exit
  without an interactive terminal. Arguments are a JSON string array, not shell code.

On Windows select a native `.exe`. For an npm installation select `node.exe` and
insert the absolute CLI entry script before its flags, e.g.
`["D:\\Tools\\agent\\cli.js", "exec", "--sandbox", "workspace-write", "-"]`.
`.cmd` and `.bat` wrappers are deliberately not launched through a shell.

The launch review shows the portable agent home and lets you open its folder. Before
the first run, authenticate from a terminal with the same environment. For example,
using the exact **Portable agent home** shown by Revqora in a dedicated PowerShell:

```powershell
$env:HOME = 'D:\Revqora\data\agents\profiles\codex'
$env:USERPROFILE = $env:HOME
$env:CODEX_HOME = Join-Path $env:HOME 'codex'
$env:CLAUDE_CONFIG_DIR = Join-Path $env:HOME 'claude'
$env:XDG_CONFIG_HOME = Join-Path $env:HOME 'config'
$env:XDG_CACHE_HOME = Join-Path $env:HOME 'cache'
$env:XDG_DATA_HOME = Join-Path $env:HOME 'local'
$env:APPDATA = $env:XDG_CONFIG_HOME
$env:LOCALAPPDATA = $env:XDG_DATA_HOME
$env:TEMP = Join-Path $env:HOME 'temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
& 'D:\Tools\codex.exe' login
```

For Claude choose its reviewed home path and installed CLI's login flow instead.
CLI authentication/configuration files belong to that CLI; secure them as you would
its usual profile. Revqora redirects common directory variables; custom tools or
explicit absolute paths in their configuration can have their own side effects.

The presets follow the official [Codex noninteractive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Installed
versions and permissions may differ. Errors are shown in diagnostics; Revqora never
falls back to bypassing permissions.

## Running and reviewing

Follow output/diagnostics in the task screen; **Stop process tree** works without
waiting for the Git queue. A timeout or nonzero exit keeps the worktree and output.
Closing the screen leaves the task running. Normal application exit requests a stop.

The app queues other operations on this repository until the agent's process tree
stops. Other repositories remain usable. Linked worktrees share refs and objects;
this is not a container or security sandbox. The CLI is instructed to avoid commits,
pushes, merges and ref edits, but Revqora cannot enforce that instruction on arbitrary
tools. Review trusted executables and repository configuration before running them.

After stopping, use **Open changes** to open that working copy. Diff, staging and
commit tools work normally there. The exact base SHA remains in the task record for
manual comparisons. A zero exit code only means the process completed, not that the
changes passed review or tests. Nothing is automatically committed or published.

Worktrees are retained and locked until you explicitly unlock/remove them in
**Worktree Manager**. Its existing recovery/review checks apply. **Forget history**
only deletes a task record/log; it never removes files, a branch or a worktree.

Task history stores the prompt, executable/arguments and up to 128 KiB per output
stream under portable repository data. Output is drained after truncation, so a
verbose process does not deadlock. There is a 100-record limit and no silent eviction.
Do not place secrets in command arguments, prompts or log-producing commands.

An unexpected exit leaves an **interrupted** result. Especially on Unix, tools may
outlive a crashed app. Inspect/stop those processes yourself, then choose **Confirm
process stopped**. This records an abandoned result; it never claims success or
automatically resumes the task. New launches stay blocked until this acknowledgement.
