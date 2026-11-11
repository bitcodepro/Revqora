# Branches and safe cleanup

**Where:** the Branches panel, branch context menus, **Ctrl+B**, or **Ctrl+N → Branch manager…**.

## Create and switch branches

Click a branch once to open **Branch context** in History with the relevant commits highlighted. **Ctrl+click** or double-click checks out the branch. **Shift+click** selects a range and **Ctrl+Shift+click** toggles one branch in the selection. Press **F2** to rename a focused branch.

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
- Ahead/behind counts compare known histories; Fetch makes remote information current.

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

After squash merge, original feature commits may not be reachable by SHA from `main` even though their changes were integrated. Inspect the PR/result and the deletion comparison before approving an unmerged-history override.

## Bulk cleanup

Select multiple branch rows and use **Delete** or **Delete…** to open the reviewed bulk deletion flow with its checkpoint options.

1. Use the row checkboxes or **Select shown (up to 50)**.
2. Remember that selected branches can remain selected after a search hides them.
3. Open **Review cleanup…**.
4. Set each row's local/remote/both scope, exclude branches to keep and review required consent.
5. Run the reviewed selection and read the per-row results.

Excluded rows remain excluded across review refreshes. Selecting a row only records intent; deletion requires fresh review and execution checks. Changed local/server tips can invalidate the whole confirmation. A partial local/remote failure is reported explicitly and stops later work as described in the result.

Deleting a branch removes a reference. It does not mean deleting a repository or its current working folder. See [Undo Center](https://github.com/bitcodepro/Revqora/wiki/Recovery-and-repository-tools) for available reference recovery.
