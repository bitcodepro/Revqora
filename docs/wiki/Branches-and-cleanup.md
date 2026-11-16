# Branches and safe cleanup

**Where:** the Branches panel, branch context menus, **Ctrl+B**, or **Ctrl+N → Branch manager…**.

## Create and switch branches

Click a branch once to open **Branch context** in History with the relevant commits highlighted. Double-click or the context menu's **Check out** checks out the branch; **Ctrl+click** toggles it in the selection. **Shift+click** selects a range and **Ctrl+Shift+click** adds a range to the selection. Press **F2** to rename a focused branch.

Right-click a branch and choose **Set as primary branch** to pin it in the branch panel, including under **My branches**. History shows its name and available tracking counts. Use **Clear primary branch** to remove the pin.

1. Use **New branch** and enter a name such as `feature/login`.
2. Review the starting branch/commit.
3. Choose whether to check out the new branch.

A branch is a reference to a commit. Uncommitted edits are files in a working folder. Creating and checking out a branch from the current commit normally keeps those files in place; the edits are included in whichever branch you later commit them on.

**Example:** you edit `1.txt` while on `main`, then create and check out `feature/test` from the current HEAD. The edit remains visible. If you Commit there, the new commit belongs to `feature/test`; `main` still points to its original commit.

Switching to an existing branch with conflicting file changes can be refused. Commit, stash or use a separate [worktree](https://github.com/bitcodepro/Revqora/wiki/Worktree-Manager) as appropriate.

## Understand local and remote branches

- `feature/login` is a local branch.
- `origin/feature/login` is your cached view of a branch on remote `origin`.
- The upstream links the two for Pull and related operations.
- **↑** shows outgoing commits and **↓** shows incoming commits relative to the configured upstream. For a local branch with a configured remote but no upstream, **↑** counts commits absent from the fetched remote branches. Fetch refreshes these counts.

Checking out a remote branch can create a local tracking branch. A checkout of an individual commit instead creates detached HEAD state; create a branch before keeping new work there.

## Use Branch Manager

Choose a comparison base, then search and use the available state filters, such as merged/unmerged, stale or diverged. Inspect the selected branch's upstream, activity, worktree use and comparison before taking action.

Protected patterns such as `main`, `master`, `develop` and `release/*` help keep shared branches out of cleanup. Application protection rules supplement the server's own permissions and protections.

Rename is available through branch actions. A remote rename needs its own review because it changes server references; it is not simply a display-name edit.

## Delete locally, remotely or both

1. Select the branch and open **Review deletion…**.
2. Check the actual local and remote target names and SHAs.
3. Leave **Also delete remote branch** unchecked for local-only deletion.
4. Select it only when you also intend to delete the reviewed remote target.
5. Review unmerged/diverged history, worktree use and recovery information before confirming.

A local branch can track a differently named remote branch. Review the actual target rather than assuming both names match. A remote-only deletion is available from a remote branch action.

After squash merge, original feature commits may not be reachable by SHA from `main` even though their changes were integrated. When the selected tips have commits outside the comparison branch, Revqora shows the warning before deletion. Choose **Delete local branch anyway**, **Delete remote branch anyway** or **Delete local & remote anyway** to confirm. If the server tip changes during review, refresh and confirm the new SHA.

## Bulk cleanup

Select multiple branch rows and use **Delete** or **Delete…** to open the reviewed bulk deletion flow with its checkpoint options.

1. Use the row checkboxes or **Select shown (up to 50)**.
2. Remember that selected branches can remain selected after a search hides them.
3. Open **Review cleanup…**.
4. Set each row's local/remote/both scope, exclude branches to keep and review required consent.
5. Run the reviewed selection and read the per-row results.

Excluded rows remain excluded across review refreshes. Selecting a row only records intent; deletion requires fresh review and execution checks. Changed local/server tips can invalidate the whole confirmation. A partial local/remote failure is reported explicitly and stops later work as described in the result.

Deleting a branch removes a reference. It does not mean deleting a repository or its current working folder. See [Undo Center](https://github.com/bitcodepro/Revqora/wiki/Recovery-and-repository-tools) for available reference recovery.

## Drag and drop

In History and in the Branches panel you can drag a branch (its badge on a History row, or its row in Branches) or commits (a History row; a multi-selection moves together). Press and move the pointer; a plain click never starts a drag. Only targets that offer an action are outlined, and **Esc** cancels.

Dropping never starts an operation. It opens a menu at the drop point, and the item you choose runs the same action as the context menus, with the same dialogs and confirmations:

| Drag | Onto | Menu |
| --- | --- | --- |
| Branch | Local branch | **Merge A into B…**, **Rebase A onto B** (local A only), **Compare A with B** |
| Remote-tracking branch | The local branch that tracks it | Also **Pull B from origin/B**, and **Fast-forward B to origin/B** when B is only behind |
| Local branch | Its upstream | **Push A to origin/A…**, **Rebase A onto origin/A**, **Compare** |
| Local branch | Another remote-tracking branch | **Rebase A onto …**, **Compare** |
| Commits | Local branch | **Cherry-pick N commits onto B** |
| Local branch | Commit | **Reset A to this commit…**, **Rebase A onto this commit** |

Merge, cherry-pick, reset, rebase and push act on the checked-out branch. When the receiving branch is not checked out, the item says so (**Switch to B and merge A…**), checks it out first and stops if that fails or is cancelled. An item is disabled, with the reason beside it, while a merge, rebase or cherry-pick is in progress, while HEAD is detached, when the branch to switch to is checked out in another worktree, or when both sides point to the same commit. Commits on a commit, anything on a tag, and a branch on itself offer nothing.

Every one of these actions is also in the branch and commit context menus after checking out the receiving branch, so the keyboard can reach them.
