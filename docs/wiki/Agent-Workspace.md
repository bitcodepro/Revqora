# Agent Workspace

**Where:** toolbar agent action or **Ctrl+N → Agent Workspace…**.

Agent Workspace launches an installed command-line agent in a separate reviewed worktree. Use it when you want the agent's edits separated from your current working files, with task output and history available inside Revqora.

## What you need

- An installed Codex, Claude Code or other supported noninteractive CLI.
- Authentication and any required subscription for that CLI.
- A repository and starting commit available locally.

Revqora does not include an AI subscription or install the agent for you. A worktree separates working files; it is not an operating-system sandbox. The selected program still has the permissions granted by its own configuration and the OS.

## Start a task

1. Open Agent Workspace and choose **New task**.
2. Select the agent preset and enter a descriptive task title.
3. Choose the installed **Executable**.
4. Check **Arguments (JSON array)**.
5. Enter the task instructions and starting revision.
6. Check the proposed new branch/folder and timeout.
7. Choose **Review launch**.
8. Read the executable, arguments, exact base commit, new worktree, complete prompt and **Portable agent home**.
9. Give the displayed consent and choose **Start agent**.

Changing launch fields invalidates the earlier review. Review the new values before starting.

Example instruction:

> Inspect the login error handling. Add a regression test for an expired session and make the smallest required fix. Do not commit or push. Explain the changes and tests performed.

Inspect your installed CLI's own permissions/settings before running it. The requested “do not commit” behavior is an instruction to the tool, not an enforcement boundary for arbitrary programs.

## Windows executable selection

Choose a native `.exe`. For an npm-installed CLI, select `node.exe` and place the absolute CLI entry-script path first in the JSON argument array, before that CLI's flags. JSON backslashes must be escaped.

The built-in preset supplies its noninteractive flags. Do not paste a complete shell command into the arguments field: it expects separate strings. `.cmd` and `.bat` wrappers are not launched through a shell here.

## Why does the CLI ask to log in again?

Tasks use the reviewed **Portable agent home** beside Revqora. Credentials in your usual terminal profile may not exist there.

Use the profile path shown in the launch review and follow the installed CLI's authentication procedure for that environment. Revqora does not copy your home-directory credentials automatically. See the detailed [CLI/profile setup guide](https://github.com/bitcodepro/Revqora/blob/main/docs/AGENT_WORKSPACE.md).

## Follow output and inspect the result

Select a task to read its phase, stdout/stderr, diagnostics and exit result. Closing the workspace screen leaves a running task active. Other Git mutations for the same shared repository wait while the task is running; other repositories remain usable.

After completion, choose **Open changes**. Inspect the agent worktree using normal diff, staging, commit and test tools. A zero exit code means the process finished successfully, not that the changes passed review. Commit and publication remain your explicit actions.

## Stop and clean up

- **Stop process tree** requests termination of the managed task/process tree and keeps its working copy.
- After an interrupted run, inspect whether external processes remain, then use **Confirm process stopped…** when appropriate.
- **Forget history** removes the task record/log; it keeps the worktree, branch and files.
- Unlock/remove retained agent worktrees through [Worktree Manager](https://github.com/bitcodepro/Revqora/wiki/Worktree-Manager) after reviewing their changes.

Task records retain prompts/arguments and bounded output locally. Avoid putting secrets in prompts or arguments. Restart restores task history without automatically replaying tasks.

## Is this an MCP manager?

This screen runs CLI processes. MCP servers/tools, when supported, are configured in the chosen agent CLI's own environment. Revqora's Agent Workspace is not a central MCP connection manager.

**Next:** [Workflow Builder](https://github.com/bitcodepro/Revqora/wiki/Workflow-Builder) · [PR agent workflow](https://github.com/bitcodepro/Revqora/wiki/PR-agent-workflows)
