# Connect an external AI client through MCP

1. Open **Settings → General → MCP** and select **Enable MCP**.
2. Choose your client and select **Copy MCP configuration**. Paste the entry into the client's configuration and restart it.
3. Keep Revqora running. Ask the client to call `list_repositories` to discover the repositories you have open.

The client launches the installed executable with `--mcp`. Revqora remembers the **Enable MCP** setting and starts the local bridge when the desktop app opens. The generated configuration includes the path and arguments.

An enabled client can read status, branches, commit history, diffs and PR discussions available in the current workspace. It can open views and request Git or PR operations. Under **Approval mode**, choose **Ask my approval** for desktop review, **Full approve** for automatic execution, or **Ask before deleting** for confirmation of operations that delete or discard data. Revqora saves the mode. Automatic requests that need additional choices return the required fields through `action_status`.

A staged rename retains both paths in its diff and approval. For a conflicted file, `file_diff` can show the base, ours and theirs index stages. A paused cherry-pick stays in `waiting_for_resolution` until you continue, skip or abort it in Revqora. The client can request approval to continue or abort with `cherry_pick_continue` or `cherry_pick_abort`.

Pass `diffVersion` with the next page's `offset`. For a long line, use its `lineIndex` as `offset` and `nextTextOffset` as `lineOffset`. `review_pending` returns the active action ID when another MCP request is in progress. Use `list_stashes` to find a stash and `stash_apply` or `stash_pop` to restore it, with optional `restoreIndex`.

See [installation commands, configuration examples and available tools](https://github.com/bitcodepro/Revqora/blob/main/README.md#connect-an-external-agent-through-mcp).
