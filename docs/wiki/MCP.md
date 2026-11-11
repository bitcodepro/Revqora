# Connect an external AI client through MCP

1. Open **Settings → General → MCP** and select **Enable MCP**.
2. Choose your client and select **Copy MCP configuration**. Paste the entry into the client's configuration and restart it.
3. Keep Revqora running. Ask the client to call `list_repositories` to discover the repositories you have open.

The client launches the installed executable with `--mcp`. Revqora remembers the **Enable MCP** setting and starts the local bridge when the desktop app opens. The generated configuration includes the path and arguments.

An enabled client can read status, branches, commit history, diffs and PR discussions available in the current workspace. It can open views and propose Git or PR operations. The **MCP request** dialog in Revqora shows the proposed action and its target. Review each request in the desktop app. Operations such as Push and branch deletion can open an additional review. `action_status` reports the outcome for tracked actions or the handoff for other reviews.

A staged rename retains both paths in its diff and approval. For a conflicted file, `file_diff` can show the base, ours and theirs index stages. A paused cherry-pick stays in `waiting_for_resolution` until you continue, skip or abort it in Revqora. The client can request approval to continue or abort with `cherry_pick_continue` or `cherry_pick_abort`.

See [installation commands, configuration examples and available tools](https://github.com/bitcodepro/Revqora/blob/main/README.md#connect-an-external-agent-through-mcp).
