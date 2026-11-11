# Worktree Manager

**Where:** **Worktrees** in the toolbar, **Ctrl+N → Worktree manager…**, or the Worktrees section of the branch panel.

## When to use a worktree

Use separate working folders when you need to work on more than one branch without repeatedly stashing or switching the same folder.

Example:

| Folder | Checked-out branch | Purpose |
| --- | --- | --- |
| `D:\Projects\app` | `main` | Shared branch / normal checkout |
| `D:\Projects\app-login` | `feature/login` | Feature work |
| `D:\Projects\app-hotfix` | `hotfix/payment` | Urgent fix |

Each folder has its own files and staging. Git objects and references are shared. A branch already checked out in another worktree normally cannot be checked out again.

## Create a worktree

1. Open Worktree Manager and choose **New worktree**.
2. Select the offered mode: existing branch, new branch or detached commit.
3. Enter the branch/start revision and destination folder.
4. Choose **Review creation**.
5. Check the exact path and starting commit.
6. Choose **Create worktree**; optionally open it afterward.

Choose a separate destination outside the existing working folder. Nested/existing/redirected paths and branches already in use can be rejected.

Creation keeps the original folder's uncommitted work and index in place. It does not copy unfinished edits into the new branch's working folder.

## Open a worktree

Select it and choose **Open worktree**. Revqora opens that folder as a repository tab; the original working folder stays on its own branch.

When an agent has finished, **Open changes** in Agent Workspace opens the same kind of independent working copy.

## Lock and unlock

Use **Lock worktree** with a reason when the folder should be retained, including a checkout on a temporarily disconnected drive. Use **Unlock worktree** after reviewing that reason when removal or cleanup is intended.

A lock protects the worktree registration from normal removal/pruning. It does not prevent file editing or make the folder a security boundary.

## Remove a worktree

Choose **Review removal** and inspect:

- The exact folder and Git identity.
- The branch/commit and whether it is current, main or locked.
- Dirty and ignored content.
- What the recovery checkpoint will contain.

Removal can be refused for an active/current/main worktree, running operations, nested repositories/submodules, links or an incomplete recovery capture. If extra consent is offered for dirty content, review it before continuing.

Removing a worktree removes its working folder/registration. Its branch is not automatically deleted; branch cleanup is a separate action.

## Clean up missing registrations

If a folder was already removed outside Git, use **Review missing entries**. Review the listed paths, uncheck anything to keep, then confirm the eligible selected registrations.

This cleans Git's worktree records for reviewed missing paths. It does not mean deleting every branch in the list. Locked missing worktrees are kept, and a folder that reappears invalidates the corresponding review.

For unexpected results, inspect the per-item result and [Undo Center](https://github.com/bitcodepro/Revqora/wiki/Recovery-and-repository-tools).
