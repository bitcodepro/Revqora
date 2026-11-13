# Settings, shortcuts and troubleshooting

## Settings and portable data

Open **Settings** with **Ctrl+,**. Configure the available theme, font, shortcut, Git detection, Pull mode, auto-fetch, avatars and update options there.

Use **About Revqora** for the installed version, author and project links. The author is [bitcodepro](https://github.com/bitcodepro).

Revqora-owned settings, account vault, recovery payloads, logs, agent history/profiles, workflows, caches and temporary data live under `data` beside the executable, or beside `Revqora.app` on macOS. Git's repository metadata remains in the repository.

On Windows, the WebView profile and UI preferences live in `data/webview`. Close the app before copying the entire portable installation. Keep `data` if you want to retain drafts, settings, accounts and recovery history. Existing system credential helpers/SSH keys and external CLI installations remain separately managed.

Native macOS browser-managed preferences are not fully portable in the same way as Windows WebView2 preferences.

An available update appears in the status bar. Check the release/version and follow the update controls; portable data is retained by the updater. Missing a feature described in this Wiki? Compare your installed version with [Releases](https://github.com/bitcodepro/Revqora/releases).

Revqora checks at startup and, by default, every hour while open. Turn off
**Check for updates every hour** to keep the startup check. Use **Check now**
or right-click the toolbar and select **Check Updates** for a manual check.
On Windows, the main window starts maximized. Revqora restores normal bounds
when they match the display and uses the available work area if the monitor
configuration changes.

## Default shortcuts

Change bindings in **Settings → Shortcuts**. Search for commands such as
**Operation log**, **Delete focused item**, **Copy diff file name**, or an action
that currently has no shortcut. On macOS, Command also matches Ctrl-based shortcuts.

**Export shortcuts…** writes a Revqora JSON backup. **Import shortcuts…** accepts
that backup, a VS Code keybindings file or a Rider custom keymap XML. Review the
proposed matches and choose what to assign.

| Shortcut | Action |
| --- | --- |
| Ctrl+O | Open another repository |
| Ctrl+N / Ctrl+Shift+P | Command palette |
| Ctrl+1 / Ctrl+2 / Ctrl+3 | History / Changes / Pull Requests |
| Ctrl+Shift+R | Cycle Graph, Review, Columns |
| Ctrl+Alt+W / Ctrl+Alt+R / Ctrl+Alt+B | Show or hide Workspaces, Repositories or Branches |
| Ctrl+Shift+Enter | Focus on code |
| Ctrl+Shift+O | All repositories |
| Ctrl+B | New branch |
| Ctrl+Shift+F | Fetch current repository |
| Ctrl+Shift+↓ / Ctrl+Shift+↑ | Pull / Push |
| Ctrl+Shift+S | Stash |
| Ctrl+Shift+C | Compare branches |
| Ctrl+Shift+E | Browse files |
| Ctrl+Enter | Commit from the commit form |
| F5 | Refresh local view |
| F2 | Rename the focused workspace, group, repository label or branch |
| Delete | Review deletion of the focused workspace, groups or branches |
| ↑ / ↓ | Navigate commits in History or changed files in Changes |
| Ctrl+↑ / Ctrl+↓ | Change the selected file in a commit preview |
| F7 / Shift+F7 | Next / previous diff change |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous repository |
| Ctrl+W | Close repository tab |
| Ctrl+, | Settings |
| Alt+↑ / Alt+↓ | Previous / next conflict block in the editor |
| Ctrl+S | Save in the conflict editor |

## Common questions

### I cannot find Fetch all

Show **Repositories** with **Ctrl+Alt+R**. Look below its search field, or open **All repositories**. Clear active filters to show the bulk actions. See [Remote operations](https://github.com/bitcodepro/Revqora/wiki/Fetch-Pull-Push-and-Sync).

### Git Push works, but Pull Requests says no credential is available

Open **Accounts…**, verify the active remote and select a suitable API account, then **Use for PR and checks**. If the vault is Locked, unlock it. An SSH key used by Git does not provide an API token. See [Accounts](https://github.com/bitcodepro/Revqora/wiki/Accounts-and-providers).

### Pull says the configured upstream was not fetched

Check whether the remote source branch was deleted after merge. Fetch/review the branch's current upstream, and use the offered default-branch continuation when appropriate. In a restricted clone, the default branch may be outside the configured fetch mappings.

If the branch still exists, inspect remote/fetch settings rather than treating it as deleted. Authentication/network errors need their own resolution. Do not republish a completed deleted branch unless that is actually intended.

### PR state or comments look older than the website

Use **Reload request** for the selected PR and **Refresh pull requests** for the list. Select the correct discussion/review feed and load additional pages. Auto-fetch concerns Git history, not live PR comments.

### Commit is disabled

Check staged changes, the message, unresolved conflicts and the current operation. A normal commit uses staged content. See [Changes and commits](https://github.com/bitcodepro/Revqora/wiki/Changes-and-commits).

### Git refuses to switch branches because of local changes

Inspect the named files. Commit, stash or use a separate worktree before switching when needed. Unstage alone does not remove working edits.

### The app says the prepared repository state changed

An IDE, terminal, watcher-visible edit or earlier operation changed the state used by the review. Refresh and review again. Inspect any partial result before retrying a publication or deletion.

### A command is Queued or an agent task is interrupted

Check **Operation log**, active validation and Agent Workspace. Linked worktrees share the repository operation queue. For an interrupted agent, inspect remaining processes before **Confirm process stopped…**. Restarting is not a request to replay it.

### Some actions are unavailable for my provider

Read the action's explanation and [PR Center provider notes](https://github.com/bitcodepro/Revqora/wiki/Pull-Request-Center). Token permissions, incomplete data and provider capabilities affect what can be offered. **Open pull request in browser** provides access to server-only actions.

## Report a problem

Open a [GitHub issue](https://github.com/bitcodepro/Revqora/issues) with the version from About, OS, action/steps, expected result and relevant error or screenshot. Remove tokens and private code from shared logs. State whether an operation actually changed Git/server state before the error.
