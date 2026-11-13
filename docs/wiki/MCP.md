# Connect an external AI client through MCP

1. Open **Settings → General → MCP** and select **Enable MCP**.
2. Choose your client and select **Copy MCP configuration**. Paste the entry into the client's configuration and restart it.
3. Keep Revqora running. Ask the client to call `list_repositories` to discover the repositories you have open.

The client launches the installed executable with `--mcp`. Revqora remembers the **Enable MCP** setting and starts the local bridge when the desktop app opens. The generated configuration includes the path and arguments.

An enabled client can read status, branches, commit history, diffs and PR discussions available in the current workspace. It can open views and request Git or PR operations. Under **Approval mode**, choose **Ask my approval** for desktop review, **Full approve** for automatic execution, or **Ask before deleting** for confirmation of operations that delete or discard data. Revqora saves the mode. Automatic requests that need additional choices return the required fields through `action_status`.

A staged rename retains both paths in its diff and approval. For a conflicted file, `file_diff` can show the base, ours and theirs index stages. A paused cherry-pick stays in `waiting_for_resolution` until you continue, skip or abort it in Revqora. After resolving the working file, the client can `stage` its path to mark it resolved, then request `cherry_pick_continue`. Use `cherry_pick_abort` to cancel the cherry-pick.

Pass `diffVersion` with the next page's `offset`. For a long line, use its `lineIndex` as `offset` and `nextTextOffset` as `lineOffset`. `review_pending` returns the active action ID when another MCP request is in progress. Use `list_stashes` to find a stash and `stash_apply` or `stash_pop` to restore it, with optional `restoreIndex`.

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
| `sync` | | `receive`, `send` for automatic sync |
| `create_pr` | `title`, `branch` and `base` for automatic creation | `message`, `draft` for automatic creation |
| `review_pr` | `number` | `revision`, `reviewKind`, `message` |
| `merge_pr` | `number` | `revision`, `method`, `message` |
| `pr_workflow` | `number` | `revision` |
| `start_workflow` | `target` is the recipe ID, plus `branch` and `base` | |
| `review_workflow_step` | `target` is the run ID | |

`create_branch` resolves the starting point before confirmation and reports the created branch and SHA. Without `base` it starts from `HEAD`. You can qualify a local branch as `refs/heads/<name>`. A missing branch or commit returns `branch_not_found` or `commit_not_found` before confirmation. A Stage path missing from `repository_status` returns `file_not_found`. If it appears there but cannot be staged, Revqora returns `file_not_eligible`. Revqora rechecks the relevant state before executing.

If a provider write returns `result_unverified`, inspect the PR, reviews or merge status on the provider before retrying. Revqora guards against duplicate writes when the first result is uncertain.

The MCP confirmation dialog expires after 120 seconds. The action reports `cancelled` with reason `approval_timed_out`, and the desktop releases the next request.

## Checkout and stash recovery

`checkout` reports the previous and current branch, conflicts and the dirty action it used. If it created a stash, `stash` contains its full `oid`, `index`, `switchSource` and whether it was `kept`. A successful `move` restores the changes and removes its temporary stash. `changesRestored` indicates a completed restoration, including the index. Check the reported index against `list_stashes` if other stash operations have run since checkout.

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
