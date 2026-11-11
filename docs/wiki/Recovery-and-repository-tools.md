# Recovery, operation history and repository tools

## Which recovery screen do I need?

| Situation | Start here |
| --- | --- |
| A Git action failed or seems stuck | **Ctrl+N → Operation log…** |
| Restore from a saved recovery point | **Ctrl+N → Undo Center…** |
| Recover a deleted local branch | **Recently deleted branches…** and/or Undo Center |
| Find an older branch/HEAD position | **Undo history (reflog)…** or a branch's reflog |
| Undo the latest local commit while retaining edits | **Undo last commit (keep changes)** |
| Inspect a rebase result or retained conflict draft | **Repository tools** |

## Operation log

Open the relevant entry and read its command, phase, timing, result and error. An operation may be queued behind another action using the same repository, including an agent or validation command.

Use the log to distinguish “not started,” “failed,” “partially completed” and “remote result uncertain.” A partial error does not mean every earlier step was rolled back.

## Undo Center and checkpoints

Select a recovery point and inspect what it contains: reference tips, Git-visible workspace/index data, or a more complete worktree-removal snapshot depending on the operation.

Choose the restoration action offered for that checkpoint and review the destination/state. A local branch restored to a saved SHA is still local; recreating a remote branch needs a separate authorized publication.

Recovery coverage is operation-specific. A saved commit pointer cannot reconstruct uncommitted content that was never captured. Keep important work committed or otherwise backed up before relying on a destructive operation.

## Deleted branches and reflog

**Recently deleted branches** offers recorded local tips with **Restore**. If the desired state is elsewhere, use the reflog to locate an earlier commit, inspect it and create a branch at that commit when appropriate.

Creating a recovery branch is often a useful way to inspect an old result before deciding whether to move an existing branch. Read reset mode descriptions in [Merge, rebase and conflicts](https://github.com/bitcodepro/Revqora/wiki/Merge-rebase-and-conflicts) before resetting files.

## Repository tools

Open **Ctrl+N → Repository tools (gc, maintenance)…**.

| Tool | Purpose |
| --- | --- |
| Size / packed / loose object information | Understand Git object storage. |
| **Write commit-graph** | Build Git's acceleration data for history queries. |
| **Run gc** / **Repack** | Git object maintenance. |
| **Prune unreachable** | Remove unreachable objects according to the operation's Git behavior; recovery availability can be affected. |
| Schedule/stop background maintenance | Manage Git maintenance registration. |
| **Ignored files** | Inspect files excluded from ordinary Git status. |
| **Nested repositories** | Find separate Git repositories inside the working folder. |
| **Validate / conflict drafts** | Run a reviewed check or inspect retained conflict text. |

Maintenance is not a substitute for fixing a failed operation or selecting the correct repository/branch. Read its result before retrying a larger workflow.

## Submodules

Submodules appear in the branch panel. Use the offered initialize/update action for a selected module, **Update submodules**, **Add submodule…**, or **Sync URLs** as needed.

A parent commit records a submodule commit. Moving the submodule checkout and editing files inside it are different changes. Commit work in the submodule repository when needed, then commit the updated submodule reference in the parent.

Submodule initialization/update follows Git configuration and can need network credentials. Inspect dirty module content before updating; parent and module changes have separate histories.

## Git LFS

Install Git LFS separately if the repository uses it. Use **Track files with Git LFS…** to add an intended pattern and inspect **LFS files** for tracked objects.

Tracking changes `.gitattributes`; review and commit that configuration with the relevant changes. Adding a pattern does not automatically migrate all old history or make hosting storage limits disappear.

## Tags, signing and bisect

- To create a tag, right-click its target commit in History and choose **Create tag here…**. Review its name, target and message/type. Existing tags appear under **Branches → Tags**; their context menu offers **Push tag**, branch creation and deletion actions. Ordinary branch publication does not imply every tag was sent.
- Configure signing through the Git/signing controls and installed tools. **Verify signature** reads a commit's signature status; it does not create trust or a key automatically.
- Use the offered **Bisect** actions for a known-good and known-bad revision. Test each candidate, mark Good/Bad/Skip as appropriate, then end/reset the bisect to return to your normal work. Bisect changes checked-out revisions while narrowing the first bad commit.

**Related:** [Worktree removal](https://github.com/bitcodepro/Revqora/wiki/Worktree-Manager) · [Stash and patches](https://github.com/bitcodepro/Revqora/wiki/Stash-stage-layers-and-patches) · [Troubleshooting](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
