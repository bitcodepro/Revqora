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

When a search, favorites/group filter or another scope is active, the buttons may read **Fetch filtered**, **Pull filtered** or **Sync filtered**. Check the visible scope before starting. Closed library bookmarks are not included.

Incoming/outgoing counts reflect known Git data. Fetch before relying on a count if the server may have changed.

See [Remote operations](https://github.com/bitcodepro/Revqora/wiki/Fetch-Pull-Push-and-Sync) for the difference between these actions.

## Save a workspace

Open the repository library and use **Save current as** to name the current set, for example `Frontend` or `Release work`.

A workspace remembers repository order, the active repository, the History/Changes/PR view, and panel sizes and visibility. The active named workspace tracks subsequent session changes. Select **All Workspaces** to see the library-wide set without editing a named workspace.

## Import and organize nested folders

Use **Import folder…** to scan the folder and its descendants, including folders inside Git repositories. The import makes the chosen folder the root of a workspace tree. The folder directly above each repository becomes its workspace. Selecting a workspace shows its direct repositories. Expand its row to see child workspaces.

Drag a workspace by its handle onto another workspace, or drop it on **Move to top level**. In the Repositories panel, **Ctrl** toggles selected rows and **Shift** selects a range. Drag the selection onto a workspace. **Ctrl+Z** undoes the latest repository move.

Right-click selected repositories and choose **Create group**, then name it in the sidebar. In the **Groups** panel, select groups the same way and use **Create group** to put them inside another group. Selecting a group filters Repositories to that group and its descendants.

Use **F2** to rename a focused workspace, group or repository label. Right-click a group to remove it from its parent, remove it from the current workspace or delete it. You can restore a group to the current workspace from the library's Groups tab. A repository's menu removes it from one group or all groups. **Delete** opens the workspace or group deletion review. Working folders stay on disk.

## Switch or add a saved set

- **Switch** replaces the current open set and restores the saved layout.
- **Add to session** adds that workspace's repositories to the current session.

Workspace switching changes the app's open tabs and layout. It does not switch Git branches or move uncommitted changes between folders.

If a saved folder is unavailable, inspect the reported partial result. Successful opens remain available and the saved snapshot is preserved. Save conflict-editor drafts before closing the app; session-only unsaved buffers are not a backup.

**Related:** [Interface](https://github.com/bitcodepro/Revqora/wiki/Interface-and-navigation) · [Worktrees](https://github.com/bitcodepro/Revqora/wiki/Worktree-Manager) · [Settings and portable data](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
