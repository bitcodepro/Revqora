# Fetch, Pull and Push

## Choose an action

| Action | Use it when… | What happens |
| --- | --- | --- |
| **Fetch** | You want to see what arrived on the server. | Downloads remote history and updates tracking information without integrating it into your current branch. |
| **Pull** | You want to receive upstream changes in the current branch. | Fetches and integrates according to the selected Pull mode. |
| **Push** | You have local commits to publish. | Sends commits to a selected remote branch. |

You can Pull directly. Running Fetch immediately beforehand is optional.

## Add or change a remote

In **Branches → Remotes**, use **Add remote** (the plus button), enter a name such as `origin`, then its Git URL. Fetch to load its branches.

Right-click a remote name for **Copy URL**, **Change URL…**, **Fetch <name>** or **Remove <name>…**. Removing a remote removes local configuration/tracking information; it does not delete the hosted repository. After changing its URL, review the PR API connection again.

For a local branch with the wrong tracking relationship, use its context menu → **Set upstream…** and select the intended remote branch. Check both repository and destination before the next Pull/Push.

## Where is Fetch all?

Open the left **Repositories** panel with **Ctrl+Alt+R**. **Fetch all** is below its search field. **All repositories** also exposes these actions.

The top-bar **Fetch** operates on the current repository's remotes. **Fetch all** and **Pull all** are available in the unfiltered repository list.

Right-click a branch for **Fetch** or **Pull**. **Fetch** updates its remote, or offers a choice of remotes for a local branch without an upstream. **Pull** uses the selected local branch's upstream and asks before switching branches. For a remote branch, **Pull** uses a local branch that tracks it.

## A normal daily routine

1. Select your repository and working branch.
2. Pull incoming updates when appropriate.
3. Make changes, stage them and Commit.
4. Push your commits.

Before a branch has an upstream, the first Push may ask you to choose the destination and set tracking. `feature/login → origin/feature/login` is a typical relationship.

If a Push response is lost or reports a partial/uncertain result, inspect the server branch before retrying. A new local commit is not required merely because its publication failed.

## Pull modes

| Mode | Behavior |
| --- | --- |
| Fast-forward only | Advances the branch when no history reconciliation is needed. Stops if histories diverged. |
| Merge | Integrates the upstream with a merge when necessary. A non-fast-forward merge is left for review before **Confirm merge** creates its commit. |
| Rebase | Replays local commits on the upstream. Replayed commits get new SHAs. |

Choose the mode in Settings. If local and remote histories both contain unique commits, inspect them before choosing merge or rebase. Ignored-file collisions and untracked files in the way can still stop an update.

### Pull with unfinished changes

You do not need to commit or stash before **Pull**. Revqora sets your local changes aside, pulls, and brings them back:

- Staged work is saved, with its staging, in a stash named `Revqora: changes on <branch> saved before pull`. Other edits are set aside by Git only when the pull brings in commits.
- When everything comes back cleanly, the saved copy is dropped and the result says the changes were set aside and restored.
- When an incoming commit changed the same lines, the pull ends with conflicts. **Changes** lists the conflicted files; use **Resolve** to open them. The named stash stays in **Stashes** as a copy of your changes until you drop it.
- If the pull itself fails (for example, the remote cannot be reached), your changes are put back as they were.

## When a completed feature branch has disappeared

A hosting service may delete the source branch after merging its PR. Your local feature branch can still track that now-missing remote branch.

Pull verifies the missing upstream, refreshes/reconciles available remote information and keeps your local branch, index and edits. When available, **Continue on <default branch>** explicitly offers guarded checkout and fast-forward Pull on the server's default branch.

The default may be outside a single-branch clone's fetch configuration. Follow the reported upstream/fetch-settings explanation rather than assuming it was loaded. Your local feature branch is not deleted automatically.

For a *new unpublished branch*, publish it with Push. For a *merged and deleted branch*, return to the appropriate continuing branch instead of republishing it unintentionally.

## Auto-fetch and Refresh

Auto-fetch updates known remote history at the configured interval. The first round runs 15 seconds after start and fetches four repositories at a time. With **Also fetch repositories that are not open** (on by default) it covers every repository in the library, so Explorer's **Incoming** filter is current without opening each one. It never asks for credentials; a repository that needs them is skipped until restart. It does not automatically Pull, Push, commit or refresh PR discussions. **F5** refreshes the local view; use PR-specific refresh buttons for API data.

A slow or unresponsive remote does not freeze the repository. While Fetch, Pull, Push or Auto-fetch waits on the server, History, Changes and diffs keep loading. Other actions that change the repository (commit, checkout, another Pull) wait their turn and run in the order you started them. Auto-fetch never queues in front of you: when another operation is running, it skips that round quietly and tries again at the next interval. It gives up after 30 seconds without leaving Git lock files behind.

**Related:** [Branches](https://github.com/bitcodepro/Revqora/wiki/Branches-and-cleanup) · [Authentication](https://github.com/bitcodepro/Revqora/wiki/Accounts-and-providers) · [Troubleshooting](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
