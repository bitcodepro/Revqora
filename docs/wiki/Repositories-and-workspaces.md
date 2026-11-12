# Repositories, the library and workspaces

## Add another repository while one is open

Press **Ctrl+O**, or use **Open repositories…** at the bottom of the Repositories panel. You can also drag a repository folder into the window or use **Ctrl+N → Open repository…**.

The new repository becomes available in the list. You do not need to exit Revqora or close the existing repository.

For a remote project that has not been cloned locally, use **Clone repository…**. The repository library stores paths and organization; it does not make a second copy of your files.

## Work with a long repository list

Open the left Repositories panel with **Ctrl+Alt+R**. Use search, favorites and group filters to find repositories. Open **Repository library and workspaces** from the toolbar to organize saved paths and groups.

| Item | Meaning |
| --- | --- |
| Open repository | Has an active tab/session and can participate in bulk operations. |
| Saved library entry | A known repository path you can reopen. Keeping it in the library does not open it automatically for background Git work. |
| Favorite | A saved repository marked for easier access. |
| Project group | A group can contain subgroups, and a repository can belong to several groups. |
| Workspace | A named set of open repositories and UI layout preferences. |

Closing a repository tab removes it from the open set. It does not delete its folder, commits or branches.

## Fetch all, Pull all and Sync all

These buttons are below the repository search field. They also appear in **All repositories**, which you can open with **Ctrl+Shift+O** or the overview icon.

- **Fetch all** updates remote history for matching open repositories.
- **Pull all** runs Pull for their current branches; individual failures are reported.
- **Sync all** prepares a review of receiving and sending commits for each repository.

The buttons are available in the unfiltered repository list and apply to open repositories.

Incoming/outgoing counts reflect known Git data. Fetch before relying on a count if the server may have changed.

See [Remote operations](https://github.com/bitcodepro/Revqora/wiki/Fetch-Pull-Push-and-Sync) for the difference between these actions.

## Save a workspace

Open the repository library and use **Save current as** to name the current set, for example `Frontend` or `Release work`.

A workspace remembers repository order, the active repository, the History/Changes/PR view, and panel sizes and visibility. The active named workspace tracks subsequent session changes. Select **All Workspaces** to see the library-wide set without editing a named workspace.

## Import and organize nested folders

Use **Import folder…** to find repositories in a folder and its descendants, including working copies inside other repositories. Review the repositories and folder tree before importing. Common dependency and cache folders are skipped by default. Select **Include dependency and cache folders** to search them. **Stop scan** stops the search and keeps the folder in the dialog.

In **Explorer**, drag a group or repository by its row. A line shows insertion before or after another item. A highlighted folder receives the items inside it. Drop on **Drop at top level** to move a group out of its parent or a repository out of its groups. **Ctrl+Z** undoes the latest move.

In **Explorer** and **Repositories**, **Shift+click** selects a range, **Ctrl+click** toggles a row and **Ctrl+Shift+click** adds a range to the selection. Click empty space or press **Escape** to clear the selection. You can configure the corresponding keyboard actions in **Settings → Shortcuts**.

Use **F2** to rename a focused group or repository label. The context menu can also create, move or remove groups and repository memberships. Selecting a group filters **Repositories** to that group and its descendants. These actions organize the library.

Star a group or repository to see it in **Favorites**. A starred group includes its contents and can be collapsed or expanded there. A starred repository appears with its parent path. Opening it in **Favorites** selects its containing group.

## Switch or add a saved set

- **Switch** replaces the current open set and restores the saved layout.
- **Add to session** adds that workspace's repositories to the current session.

Workspace switching changes the app's open tabs and layout. It does not switch Git branches or move uncommitted changes between folders.

If a saved folder is unavailable, inspect the reported partial result. Successful opens remain available and the saved snapshot is preserved. Save conflict-editor drafts before closing the app; session-only unsaved buffers are not a backup.

**Related:** [Interface](https://github.com/bitcodepro/Revqora/wiki/Interface-and-navigation) · [Worktrees](https://github.com/bitcodepro/Revqora/wiki/Worktree-Manager) · [Settings and portable data](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
