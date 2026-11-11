# Fetch, Pull, Push and Sync

## Choose an action

| Action | Use it when… | What happens |
| --- | --- | --- |
| **Fetch** | You want to see what arrived on the server. | Downloads remote history and updates tracking information without integrating it into your current branch. |
| **Pull** | You want to receive upstream changes in the current branch. | Fetches and integrates according to the selected Pull mode. |
| **Push** | You have local commits to publish. | Sends commits to a selected remote branch. |
| **Sync** | You want to review incoming/outgoing commits before choosing actions. | Prepares a receive/send review; Receive is fast-forward only and Send requires selection. |

You can Pull directly. Running Fetch immediately beforehand is optional.

## Add or change a remote

In **Branches → Remotes**, use **Add remote** (the plus button), enter a name such as `origin`, then its Git URL. Fetch to load its branches.

Right-click a remote name for **Copy URL**, **Change URL…**, **Fetch <name>** or **Remove <name>…**. Removing a remote removes local configuration/tracking information; it does not delete the hosted repository. After changing its URL, review the PR API connection again.

For a local branch with the wrong tracking relationship, use its context menu → **Set upstream…** and select the intended remote branch. Check both repository and destination before the next Pull/Push.

## Where is Fetch all?

Open the left **Repositories** panel with **Ctrl+Alt+R**. **Fetch all** is below its search field, beside **Sync all**. **All repositories** also exposes these actions.

The top-bar **Fetch** operates on the current repository's remotes. The left-panel **Fetch all** operates across matching open repositories. With active filters, the labels change to **Fetch filtered**, **Pull filtered** and **Sync filtered**.

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

Choose the mode in Settings. If local and remote histories both contain unique commits, inspect them before choosing merge or rebase. Commit/stash unfinished work when requested; ignored-file collisions and conflicts can also stop an update.

## Use Sync step by step

1. Click **Sync** in the top bar, or **Sync all** in Repositories.
2. Wait for **Review Sync**. It checks the actual server tip for each selected repository.
3. Inspect the current branch, upstream and incoming/outgoing counts.
4. Leave **Receive N** selected if you want incoming commits.
5. Select **Send N** explicitly if you want to publish local commits.
6. Click **Sync selected** and read **Sync results**.

Sync works on each repository's current branch. It does not commit your edits or synchronize every branch in that repository. A clean Git-visible working state and one unambiguous upstream are required. Diverged histories need explicit merge/rebase first.

Canceling the review does not integrate or publish changes. A failed repository does not automatically cancel successful work in other repositories; inspect each result.

## When a completed feature branch has disappeared

A hosting service may delete the source branch after merging its PR. Your local feature branch can still track that now-missing remote branch.

Pull verifies the missing upstream, refreshes/reconciles available remote information and keeps your local branch, index and edits. When available, **Continue on <default branch>** explicitly offers guarded checkout and fast-forward Pull on the server's default branch.

The default may be outside a single-branch clone's fetch configuration. Follow the reported upstream/fetch-settings explanation rather than assuming it was loaded. Your local feature branch is not deleted automatically.

For a *new unpublished branch*, publish it with Push before using Sync. For a *merged and deleted branch*, return to the appropriate continuing branch instead of republishing it unintentionally.

## Auto-fetch and Refresh

Auto-fetch updates known remote history at the configured interval. It does not automatically Pull, Push, commit or refresh PR discussions. **F5** refreshes the local view; use PR-specific refresh buttons for API data.

**Related:** [Branches](https://github.com/bitcodepro/Revqora/wiki/Branches-and-cleanup) · [Authentication](https://github.com/bitcodepro/Revqora/wiki/Accounts-and-providers) · [Troubleshooting](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
