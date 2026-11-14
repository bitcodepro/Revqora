# Explorer and repository library

Open **Repository library** from the toolbar, or **Manage library**
from the Repositories panel. A star keeps a repository accessible after its tab is
closed. Groups can contain other groups and repositories can belong to several.
Bulk actions appear in the unfiltered Repositories panel and apply to open
repositories. Closed bookmarks do not perform background Git or network work
until opened. The library keeps previously opened paths available.

On startup, the complete saved repository list and all group memberships appear
together. The last active repository is selected immediately and discovered first.
By default, every saved library repository opens automatically, including grouped
and ungrouped paths that had no open tab. Disable **Settings → Behaviour → Open all
saved repositories** to restore only the previous open tabs. Closing a tab stops its background work
for the current session; with this option enabled it opens again next startup.
Git discovery and status reads use bounded background queues; inactive repositories
use display-only Git status without hashing dirty contents for mutation proofs.
They do not load full commit histories, layers or squash-merge analysis until selected.
Action previews and execution still read full safety preconditions independently.
**Opening…** means discovery is pending; **Closed** means the tab was deliberately
closed. Ungrouped saved paths remain visible too. An unavailable folder keeps its
place in the session and offers **Try again**, instead of silently disappearing.
Opening several folders or a group registers every row before reading their Git data.

## When Pull protects ignored data

Ignored files are excluded from Git tracking, but may still contain important local
settings or generated data. When Pull detects an incoming file overlapping an ignored
file, directory or link, it stops and shows both paths. Use **Show local path** or
**Inspect ignored files…**, move the conflicting data outside the repository to keep
a copy, then choose **Retry Pull**. Review any saved content before restoring it.
Cancel leaves the local data in place. Changing `.gitignore` alone does not resolve
the overlap. Fetch may already have refreshed remote-tracking information.

An ignored sibling such as `bin/` or `obj/` does not conflict with a new source file
in the same project folder. Revqora checks the incoming path without recursively
scanning build caches or deleting generated files.

Rebase also checks paths touched by the local commits it will replay, including
files that were added and deleted between the two endpoints. Ordinary untracked
files are protected too, since ignore rules can change during replay.

With recursive submodule updates enabled, Pull inspects initialized submodules
and nested modules before updating the parent. Unrelated ignored build outputs
can stay in place. Overlapping local data, removal of a module with local data,
or an unavailable target needed for inspection stops the operation before working
files change. Collision paths include the module directory so **Show local path**
opens the correct location. An empty, deinitialized module remains uninitialized.

## Explorer

**Explorer** shows the repository library as a single tree of groups, subgroups
and repositories. Repositories without a named group appear at the top level.
Select **Import folder…** to recreate the folder hierarchy, including repositories
nested within other repositories. Clear **Recreate the folder tree in Explorer**
to import without creating groups.

Selecting a group filters the optional **Repositories** column and the repository
overview to all repositories in that group and its descendants. Each repository
appears once in the flat list. Selection leaves the open tabs, branch and history
layout as they are. Select **All repositories** in Explorer to clear the filter.

Drag groups by their rows to reorder siblings or move them to another level.
Drag repository rows onto a group, or to the top-level target to remove that
placement. **Ctrl+Z** in navigation undoes the last move. Use **Ctrl** or **Shift**
for multiple selection. Right-click the tree to create a top-level group or a row
to create a sibling or subgroup. **F2** renames the focused entry and **Delete**
reviews deletion of the selected group and its descendants.

Existing saved workspaces become groups, with their nesting, repository
memberships and favorites carried over. An existing workspace and group with the
same sibling name remain separate entries with distinct names. Group operations
update only Revqora's library metadata, which is stored in the executable-local
WebView profile. The working copies remain on disk.
