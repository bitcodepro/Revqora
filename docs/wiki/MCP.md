# Connect an external AI client through MCP

1. Open **Settings → General → MCP** and select **Enable MCP**.
2. Choose your client and select **Copy MCP configuration**. Paste the entry into the client's configuration and restart it.
3. Keep Revqora running. Ask the client to call `list_repositories` to discover the repositories you have open.

The client launches the installed executable with `--mcp`. Revqora remembers the **Enable MCP** setting and starts the local bridge when the desktop app opens. The generated configuration includes the path and arguments.

An enabled client can read status, branches, commit history, diffs and PR discussions available in the current workspace. It can open views and request Git or PR operations. Under **Approval mode**, choose **Ask my approval** for desktop review, **Full approve** for automatic execution, or **Ask before deleting** for confirmation of operations that delete or discard data, merge or approve pull requests, or push anywhere other than the branch's own upstream. Revqora saves the mode. Automatic requests that need additional choices return the required fields through `action_status`.

A staged rename retains both paths in its diff and approval. For a conflicted file, `file_diff` can show the base, ours and theirs index stages. A paused cherry-pick stays in `waiting_for_resolution` until you continue, skip or abort it in Revqora. After resolving the working file, the client can `stage` its path to mark it resolved, then request `cherry_pick_continue`. Use `cherry_pick_abort` to cancel the cherry-pick.

Pass `diffVersion` with the next page's `offset`. For a long line, use its `lineIndex` as `offset` and `nextTextOffset` as `lineOffset`. `review_pending` returns the active action ID when another MCP request is in progress. Use `list_stashes` to find a stash and `stash_apply` or `stash_pop` to restore it, with optional `restoreIndex`.

## Search and repository status

`search_commits` searches local branches, remote-tracking branches, tags and HEAD. The default `all` mode matches the full message, author name or email, SHA prefix and ref labels. Matching is case-insensitive. Follow `nextCursor` whenever `hasMore` is true.

`repository_status` returns up to 200 paths. For the next page, pass `files.nextOffset` as `offset` and reuse `statusVersion` from the first page. If the status changed, the request returns `stale_state`. Start again at offset zero. `stateVersion` is a monotonic observation counter and can advance between unchanged reads.

## Request action parameters

Every `request_action` requires `repository` and `action`. Extra parameters that the selected action does not use return `invalid_arguments`.

| Action | Required action parameters | Optional parameters |
| --- | --- | --- |
| `stage`, `unstage` | `paths` from `repository_status` | |
| `commit` | `message` | |
| `create_branch` | `target` is the new branch name | `base` is a local branch or full commit SHA |
| `checkout` | `target` is a local branch | `dirtyAction` accepts `stash` or `move` |
| `delete_branch` | `target` is a local branch | `force` for automatic deletion |
| `cherry_pick` | `target` is a full commit SHA | |
| `cherry_pick_continue`, `cherry_pick_abort` | | |
| `stash` | | `message`, `includeUntracked`, `keepIndex` |
| `stash_apply`, `stash_pop` | `stashIndex` and full stash SHA as `target` | `restoreIndex` defaults to `true` |
| `stash_drop` | `stashIndex` and full stash SHA as `target` | |
| `fetch`, `pull` | | `prune` defaults to `false` in all approval modes |
| `push` | | `remote`, `remoteBranch`, `force`, `setUpstream` for automatic push |
| `create_pr` | `title`, `branch` and `base` for automatic creation | `message`, `draft` |
| `review_pr` | `number` | `revision`, `reviewKind`, `message` |
| `merge_pr` | `number` | `revision`, `method`, `message` |
| `pr_workflow` | `number` | `revision` |
| `start_workflow` | `target` is the recipe ID, plus `branch` and `base` | |
| `review_workflow_step` | `target` is the run ID | |

`create_branch` resolves the starting point before confirmation and reports the created branch and SHA. Without `base` it starts from `HEAD`. You can qualify a local branch as `refs/heads/<name>`. A missing branch or commit returns `branch_not_found` or `commit_not_found` before confirmation. A Stage path missing from `repository_status` returns `file_not_found`. If it appears there but cannot be staged, Revqora returns `file_not_eligible`. Revqora rechecks the relevant state before executing.

With approval, `create_pr` opens Revqora's PR editor filled with the requested title, source and target branches, description and draft setting. You can change them before creating. While the editor is open the action stays `awaiting_confirmation`; it then reports `succeeded` with the created PR's `number`, `url`, `branch` and `base`, or `cancelled` when the editor is closed. `review_pr` with `reviewKind` shows the review kind and message in the approval and submits that review once approved. Without `reviewKind` it opens the review dialog and reports `handed_off`. Bitbucket Cloud pull requests are merged on Bitbucket: `merge_pr` returns `pr_action_unavailable` before asking for approval.

If a provider write returns `result_unverified`, inspect the PR, reviews or merge status on the provider before retrying. Revqora guards against duplicate writes when the first result is uncertain.

The former `sync` action returns `action_removed`. Use `fetch`, `pull` or `push` for the desired operation.

The MCP confirmation dialog expires after 120 seconds. The action reports `cancelled` with reason `approval_timed_out`, and the desktop releases the next request.

`pull_request_queue` lists the open pull requests that need you, as the PR Center's **Needs attention** filter does, across the repositories open in Revqora or for one `repository`. Pass `filter` (`any`, `review`, `changes`, `ci`, `merge` or `check`). Each item carries its `reasons` and `checkedAt`; each repository its `status` (`complete`, `failed`, `incomplete`, `needs_identity` or `no_provider`), `loadedAt` and `error`, so a failed or slow provider is reported instead of looking empty. `needs_identity` means the list loaded but Revqora does not know your account there; set **My PR author** in the PR Center or use a verified API account. Follow `nextCursor` with the same filter and repository; an expired cursor returns `stale_state`.

A `pull_request` or `pull_request_queue` read has a 120-second desktop deadline. Files and checks return their revision and accept an expected revision to detect stale requests. For diff, pass the revision and file ID returned by files. Bitbucket profile verification uses the selected PR connection. For personal tokens, `/user` requires `read:user:bitbucket` (OAuth: `account`).

## Checkout and stash recovery

`checkout` reports the previous and current branch, conflicts and the dirty action it used. If it created a stash, `stash` contains its full `oid`, `index`, `switchSource` and whether it was `kept`. A successful `move` restores the changes and removes its temporary stash. `changesRestored` indicates a completed restoration, including the index. Check the reported index against `list_stashes` if other stash operations have run since checkout.

A checkout phase of `succeeded` confirms the branch switch. When applying moved changes produces conflicts, the result still reports `changesRestored: false`, the conflicted paths, the retained stash and `nextStep: "resolve_conflicts"`.

| Checkout `nextStep` | What to do |
| --- | --- |
| `return_to_source` | Switch back to the source branch when ready to restore its changes. |
| `restore_stash` | Use the `restoreStash` index and SHA with `stash_apply` or `stash_pop`. Returning to the branch leaves restoration under your control. |
| `save_changes_before_restore` | Save the current working changes before applying the identified stash. |
| `resolve_conflicts` | Resolve the reported conflicts in Revqora. |
| `inspect_worktree_and_stash` | Read the action message, status and stash list before retrying. |
| `none` | No follow-up is needed. |

`stash_drop` removes the exact stash entry without applying it. Revqora uses the deletion approval policy and returns a `checkpoint` ID. To recover the entry, open **Undo Center**, find that checkpoint and restore the saved stash reference.

See [installation commands, configuration examples and available tools](https://github.com/bitcodepro/Revqora/blob/main/README.md#connect-an-external-agent-through-mcp).
