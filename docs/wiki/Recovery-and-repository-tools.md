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
| **Reuse recorded conflict resolutions (rerere)** | Let Git replay conflict resolutions you made before; optionally **Stage replayed resolutions automatically**. |
| **Fetch more history** / **Fetch full history** | Shown for shallow clones: add the chosen number of commits, or remove the shallow boundary. |
| **Hooks** tab | List the hooks Git runs in this repository. |
| **Sparse checkout** tab | Check out only chosen folders, and see whether the repository is a partial clone. See below. |

### Sparse checkout and partial clone

The **Sparse checkout** tab shows whether sparse checkout is on, its mode and its folders (cone mode) or patterns (non-cone mode).

- **Turn on sparse checkout** uses cone mode: top-level files are always checked out, plus everything in the listed folders and the files directly inside their parent folders. Add folders by typing a path or by picking from the list of folders at HEAD; remove them with **Remove**, then **Apply folder list**. Additions only run `git sparse-checkout add`; any removal runs `git sparse-checkout set --cone`.
- Before a change that removes files, a confirmation shows how many tracked files leave the working tree and which of them have local changes. Git keeps modified files in place and Revqora lists them with Git's own message afterwards (older Git refuses the whole change instead; the message and the files are shown). Nothing is discarded. Files that leave stay in the repository and come back when their folder is added again.
- **Switch to non-cone mode** turns the folders into gitignore-style patterns (`/*`, `!/*/`, `/folder/`); **Switch to cone mode** keeps the patterns that name a folder and lists the ones that will be dropped. **Reapply** applies the patterns again after a checkout or merge brought files back. **Turn off** brings every tracked file back (in a partial clone Git also downloads them).
- Every change goes through the repository operation queue, checks the displayed state, appears in the Operation log and saves a recovery checkpoint that records the previous patterns (a reference checkpoint when the working tree cannot be captured).
- With Git older than 2.35 the mode is selected with `git sparse-checkout init` before `set`; Git 2.35+ uses `set --cone` / `--no-cone`.
- The clone dialog's **Sparse checkout (start with only the top-level files)** runs `git clone --sparse` and then `sparse-checkout set --cone` with the optional folders. A blobless partial clone is recommended alongside it. If the folders cannot be added, the clone is kept and a warning explains how to add them.
- The **Partial clone** section lists promisor remotes and their filter (`remote.<name>.promisor`, `remote.<name>.partialclonefilter`). Git downloads missing file contents on demand, so diffs, blame and checkout of files outside the downloaded set need the remote. Converting a partial clone to a full clone is not offered: `git fetch --refetch` needs Git 2.36+ and does not restore objects that are only reachable from local commits, stashes or other remotes, so removing the promisor configuration afterwards could leave the repository with missing objects.

### Git hooks

Open **Repository tools → Hooks**, or **Git hooks…** in the command palette. The tab shows the hooks folder (including a `core.hooksPath` override) and each installed hook as **runs** or **skipped** (not executable, so Git skips it). **Open** shows the script as text. Sample files (`*.sample`) do not run. To skip hooks for one commit, use **Skip hooks** in the commit box.

Maintenance is not a substitute for fixing a failed operation or selecting the correct repository/branch. Read its result before retrying a larger workflow.

## Submodules

Submodules appear in the branch panel. Use the offered initialize/update action for a selected module, **Update submodules**, **Add submodule…**, or **Sync URLs** as needed.

A parent commit records a submodule commit. Moving the submodule checkout and editing files inside it are different changes. Commit work in the submodule repository when needed, then commit the updated submodule reference in the parent.

Submodule initialization/update follows Git configuration and can need network credentials. Inspect dirty module content before updating; parent and module changes have separate histories.

## Git LFS

Install Git LFS separately if the repository uses it. Use **Track files with Git LFS…** to add an intended pattern and inspect **LFS files** for tracked objects.

The **Git LFS files** dialog also shows file locks when the server supports them. Each file shows **locked by** its owner, or a **Lock** button; **Unlock** releases a lock. If the server refuses because someone else holds the lock, Revqora asks whether to **Force unlock**; the owner may lose work. **Refresh locks** reloads them. When locks are not available, the dialog says why and lists files only.

Tracking changes `.gitattributes`; review and commit that configuration with the relevant changes. Adding a pattern does not automatically migrate all old history or make hosting storage limits disappear.

## Tags, signing and bisect

- To create a tag, right-click its target commit in History and choose **Create tag here…**. Review its name, target and message/type. Existing tags appear under **Branches → Tags**; their context menu offers **Push tag**, branch creation and deletion actions. Ordinary branch publication does not imply every tag was sent.
- Configure signing through the Git/signing controls and installed tools. **Verify signature** reads a commit's signature status; it does not create trust or a key automatically.
- Use the offered **Bisect** actions for a known-good and known-bad revision. Test each candidate, mark Good/Bad/Skip as appropriate, then end/reset the bisect to return to your normal work. Bisect changes checked-out revisions while narrowing the first bad commit.

**Related:** [Worktree removal](https://github.com/bitcodepro/Revqora/wiki/Worktree-Manager) · [Stash and patches](https://github.com/bitcodepro/Revqora/wiki/Stash-stage-layers-and-patches) · [Troubleshooting](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
