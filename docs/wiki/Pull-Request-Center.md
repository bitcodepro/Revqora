# Pull Request Center

**Where:** **Pull Requests / Ctrl+3**. GitLab merge requests use the same workspace.

## Open the correct request

1. Check the API provider, active remote and account in the PR Center header.
2. Filter by **Open**, **Closed**, **Merged** or **All**.
3. Search the loaded list or open a request by number when offered.
4. Select the request and read its source → target branch line.

List rows show the state, the author and, when the service reports them in its list, comments, approvals, requested changes and merge conflicts. The CI result appears on a row after you open that request.

The left request list can be hidden/resized to leave more room for the selected PR.

Choose **All repositories** in the scope selector to combine requests from the open repositories in the current workspace. Use **My pull requests** to filter to your own requests. The list retains the same detail pane and shows a repository name and source → target for each request. Repositories with no matching PRs have no rows. When Revqora resolves your author, the **My pull requests** entry shows the name.

## Create or edit a PR

Publish the source branch with Push first. Then choose **New** / **New PR**, select source and target branches, and enter the title and description.

Committed local templates may be available. Review before replacing a description you already wrote. Choose an ordinary or draft PR explicitly as appropriate; draft status is not required by Revqora.

Use **⋯ → Edit PR** to change supported metadata. If the request or account changed since the editor loaded, refresh and review the new version before resubmitting.

Creating a PR does not push unpublished local edits for you. Later commits pushed to the same PR source branch update the existing PR.

## Read Overview, Files and Discussions

Under the title, the **status strip** sums up the request: CI checks, approvals or requested changes, merge blockers and discussions. Click checks or blockers to open **Overview**, and discussions to open **Discussions**. The button on the right is the next step: **Merge…** for an open request (**Merge on Bitbucket** for Bitbucket Cloud) and **Delete source branch…** after a merge. Bitbucket Cloud loads CI checks only when you choose **Load CI checks**, because a token with PR access alone may not read them.

| Section | What to do |
| --- | --- |
| **Overview** | Read/expand the description and inspect checks, policies and merge readiness. |
| **Files** | Select a changed file; use unified/split diff, wrapping and scrolling. |
| **Discussions** | Read comments/threads, load more, filter resolved/outdated items and inspect review history. |

GitHub general comments and submitted reviews are separate feeds. If a review is missing, select the relevant feed and load its available pages.

**Check out** is an explicit operation to fetch/check out the reviewed source commit locally. Reading Files or Discussions does not require changing your current working branch.

## Comments and review actions

For an inline comment, select the supported old/new diff line-number action. The app binds it to the displayed file, side and revision. A stale or unmappable line cannot be posted as though it belonged to the current source.

Use thread actions to reply, resolve or reopen when the provider and your permissions allow it. Choose **Review ▾** and then **Comment**, **Approve** or **Request changes**; actions your account may not take are disabled, with the reason below them.

The **⋯** menu next to **Check out** holds **Edit PR**, **PR workflow…**, **Open in browser**, **Copy URL** and **Watch this PR**.

**Send reply** shows progress while the provider receives the reply. On success, the editor closes and the discussion refreshes. If submission fails, you can continue editing the local draft. Use the refresh buttons on the request list or in **Discussions** for their respective data.

Turn on **My PR alerts** to track your open requests across repositories in the workspace. **⋯ → Watch this PR** watches just one request; a bell next to its title shows it. Set your PR author if the provider credential lacks profile access.

Local drafts are retained when you close an editor. A saved draft from an older source may need explicit restoration. Submission is a separate action.

If publication reports an uncertain outcome, check the server and the offered result controls before sending again. Closing/reopening is not confirmation that the first send failed.

## Connection problems

**Check connection…** in the PR Center header tests Git and each API capability of the repository separately (see [Accounts](https://github.com/bitcodepro/Revqora/wiki/Accounts-and-providers)). A list error offers **Check connection…** and **Copy diagnostics…**; in the all-repositories list, each repository that needs attention has both actions, so the report names that repository, its provider and the HTTP status and request ID of the failure.

## Refresh behavior

- **Refresh pull requests** refreshes the request list.
- **⟳** next to the **⋯** menu reloads the selected request: details, checks, files and discussions.
- Use the discussion feed's load controls for remaining pages.
- The visible merge-readiness panel checks requirements approximately every ten seconds; this is not a live discussion subscription.

If GitHub shows Closed/Merged but the app still shows Open, reload the selected request and refresh the list/filter as needed. Git Fetch and auto-fetch do not fetch discussion comments.

## Merge and source cleanup

1. Inspect CI checks, required reviews and server policies.
2. Open **Merge…** / **Review merge…**.
3. Review the exact source, destination, method and acknowledgments.
4. Submit and wait for the server-confirmed result.

Available methods follow the provider/project settings. **Add to merge queue** means queued, not already merged. Azure completion can also remain pending until the server confirms it. Bitbucket Cloud merge opens the service website where an appropriate source lease is unavailable.

After a confirmed merge, **Delete source branch…** separately reviews local/remote deletion. It keeps protected, changed, occupied or unsupported sources rather than bundling an unreviewed delete into merge.

## Provider differences

- GitHub prevents self-approval and supports its own review/queue policies.
- GitLab Request Changes is not exposed by this integration.
- Azure's content preview identifies its file-mode/object-type limitation; identical text does not prove that executable permissions, symlinks or submodules are unchanged.
- Bitbucket discussion/approval/merge capabilities differ between Cloud and Server. Incomplete previews are labeled.

Use **Open pull request in browser** when the app reports a limit or an action must be completed on the service.

**Related:** [API accounts](https://github.com/bitcodepro/Revqora/wiki/Accounts-and-providers) · [PR agent workflows](https://github.com/bitcodepro/Revqora/wiki/PR-agent-workflows) · [Branch cleanup](https://github.com/bitcodepro/Revqora/wiki/Branches-and-cleanup)
