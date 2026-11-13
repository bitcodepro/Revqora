# Explorer and repository library

## Open and reopen repositories

Press **Ctrl+O** to open a local repository alongside those already open. You can also drag its folder into Revqora or use **Ctrl+N** and choose **Open repository…**. To start from a remote URL, choose **Clone repository…** from the command palette.

Revqora remembers repository paths in **Repository library**, available from the right side of the toolbar. Closing a repository leaves its library entry and working copy on disk. Click the saved entry in Explorer to reopen it.

By default, Revqora opens all saved repositories at startup. To restore only the previously open tabs, turn off **Open all saved repositories** in Settings.

## Browse and filter repositories

**Explorer** opens by default. It shows groups, subgroups, repositories and branches in one tree. Expand a repository to see its branches, including saved repositories you have closed. Click a branch to open its history context. The branch context menu has the same actions as the **Branches** panel, which you can still open separately with **Ctrl+Alt+B**.

Use **Find in Explorer** to search by folder, repository or branch. **My branches** uses the creator filter for each repository and keeps its primary branch visible at the top. Right-click a branch and choose **Set as primary branch** to pin it in both Explorer and the Branches panel.

Press **Ctrl+Alt+R** to show the optional **Repositories** panel as a flat list. Selecting a group in Explorer limits this list and the repository overview to that group and its descendants. A repository appears once in the flat list even if it belongs to several groups. Select **All repositories** in Explorer to clear the group filter.

Star a group, repository or branch to find it under **Favorites**. A starred group shows its folders and repositories. A starred branch appears with its repository and parent folders, even if those items have no stars.

## Import and organize groups

Use **Import folder…** to find Git repositories under a parent folder, including working copies inside other repositories. Review the matches before importing. Leave **Recreate the folder tree in Explorer** selected to create groups from the directory hierarchy. Use **Stop scan** to cancel a scan and **Include dependency and cache folders** if you need to search those directories.

Right-click empty space in Explorer to create a top-level group. Right-click an existing group to create a sibling or subgroup. Select repository rows and use **Create group** in their context menu to group them together. **F2** renames a focused group or repository label.

Drag a group or repository to move it in Explorer. Its branches move with it. An insertion line marks a position between items, and a highlighted folder receives the item inside it. Use **Drop at top level** to move an item to the root of Explorer. **Ctrl+Z** undoes the most recent Explorer move.

Use **Shift+click** to select a range, **Ctrl+click** to toggle a row, and **Ctrl+Shift+click** to add a range to the selection. Click empty space or press **Escape** to clear the selection. Arrow keys move focus through visible Explorer rows.

Use the context menu to remove a repository from a group or from all groups. **Delete** opens a review for the selected groups and their descendants. These operations update Revqora's library and leave working copies on disk. Saved workspaces from older versions are carried over as Explorer groups.

## Fetch all, Pull all and Sync all

These actions appear in the unfiltered **Repositories** panel and the **All repositories** overview. Open the overview with **Ctrl+Shift+O**. The bulk actions use the open repository set. Incoming and outgoing counts reflect the last known Git data.

- **Fetch all** downloads remote updates.
- **Pull all** lets you review which repositories can fast-forward their checked-out branches.
- **Sync all** lets you review incoming and outgoing commits before choosing what to receive or send.

**Related** · [Interface and navigation](https://github.com/bitcodepro/Revqora/wiki/Interface-and-navigation) · [Remote operations](https://github.com/bitcodepro/Revqora/wiki/Fetch-Pull-Push-and-Sync) · [Settings and portable data](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
