# Revqora behavior checklist

Use this checklist with the relevant pages in [docs/wiki](wiki/). The rules below describe expected behavior. Add a rule when a feature is introduced, and change a rule when the user explicitly requests a change to that behavior. If implementation and documentation disagree, reproduce the discrepancy before changing either.

Before opening or updating a PR:

- [ ] Read the sections affected by the change, including shared UI, Git operations, shortcuts and portable state.
- [ ] Exercise the feature through its normal UI or MCP entry point. Cover existing data and adjacent actions that share the changed code.
- [ ] For a regression, reproduce the reported case and verify it with a focused test. Run the project verification from AGENTS.md and record failures and gaps.

## Explorer, Repositories and Branches

- [ ] Explorer shows folders, repositories and branches. Only folders and repositories can move in the tree. Moving a repository keeps its branches with it and changes only the app's organization.
- [ ] Explorer highlights the active repository after switches from any panel or shortcut. Keyboard focus and multi-selection are independent. History, Changes, Branches and repository-scoped Pull Requests follow the active repository.
- [ ] Repositories remains available as a flat panel. Clicking a repository highlights its entire row in both themes, even after the pointer leaves. Ctrl/Shift selection has its own styling. Escape clears the multi-selection.
- [ ] Branches remains available as a separate panel. Both surfaces share branch actions. A single click opens branch context while keeping the current checkout. Primary appears first and survives My branches. Favorites can show a branch with its repository and parent folders.
- [ ] Branch rows show ↑/↓ against their upstream. With a configured remote and no upstream, ↑ counts commits absent from the fetched remote branches.
- [ ] Explorer's Incoming and Changes filters use the last known repository status and keep the parent folders of matching repositories visible. Changes includes staged, unstaged and untracked files.
- [ ] Closing a repository keeps its Explorer entry. Remove from Explorer closes the selected repositories and clears their saved placements and favorites while preserving their working copies.
- [ ] Test arrow navigation, F2 and Delete in the relevant panel. Shortcut bindings and hints are discoverable and existing overrides keep working.

- [ ] While a transfer runs for the active repository, Fetch rotates, Pull moves down and Push moves up. The icons return to rest when the operation ends. Reduced-motion mode uses the busy color without movement.

## History and cross-repository search

- [ ] Opening or filtering branch rows in Explorer may read refs for inactive repositories. It must leave their history graphs unloaded. Keep unchanged cached graphs and rebuild invalidated history on activation.
- [ ] Search all repositories scans the open repositories, including ones whose History view has never loaded. Results appear as each repository completes and are sorted newest first within each repository.
- [ ] A saved compact search dialog grows once when the first results or a repository error arrive. Users can resize it afterward. Its automatic size does not overwrite their saved size.
- [ ] Opening a match selects its repository and commit. Branch context, current-branch history and All branches are distinct scopes. Verify Graph, Review and Columns when changing shared history behavior.
- [ ] When the branch scope changes, History waits for that scope's graph. Updates to the same scope can keep the existing rows visible.
- [ ] History search covers the whole selected scope while the graph stays paged. A match outside the loaded graph is available in the match list and opens its commit by SHA.

## Working changes, staging and stash

- [ ] Commit Description shows a non-selectable hint while empty. Real draft text can be selected and copied while editing. Leaving the field clears the selection and preserves the draft.

- [ ] Whole-file stage uses the version available at staging time. Staging again updates the index to the latest version. Staging a hunk uses the selected diff and checks that it can still be applied to the index.
- [ ] Routine Changes observations fingerprint the selected file. Git mutations still use their full preconditions. A diff truncated by the byte budget is marked partial and offers whole-file actions.
- [ ] Apply restores a stash and keeps its entry. Pop drops it after a complete restoration. When conflicts or partial index restoration occur, report them and preserve the stash. Drop preserves a recovery checkpoint and leaves the working files alone.
- [ ] Destructive actions show consequences before confirmation. Branch deletion outside the comparison history offers an explicit confirmation. Remote deletion checks the exact reviewed SHA.

## Bitbucket credentials

- [ ] The Bitbucket Git prompt accepts a token by itself. With Remember enabled, it offers an optional email for Basic authentication in Pull Requests. Closing the email field submits a token-only sign-in.

## MCP and portable updates

- [ ] MCP read results and errors distinguish completeness and failures. Confirmable actions respect the configured approval mode, report their final outcome and preserve repository state on cancellation.
- [ ] Update packages verify the checksum, release version and platform before replacing files. On Windows the helper waits for the exact desktop process to exit. A failed installation identifies the operation and path and rolls back changed files. If rollback fails, preserve its backup. Verify that the portable data directory and repositories survive.
- [ ] Update card actions wrap inside the card when space is limited. Release notes wrap long links without hiding the end of the text.
- [ ] Error log lists recent application errors independently of Operation log. It copies one entry or all entries, preserves diagnostic codes, redacts credentials before storage and prunes entries older than seven days.
- [ ] Clear log deletes recorded application errors after confirmation. New errors can still be recorded and Operation log is unaffected.
- [ ] On Windows, a briefly locked working file can be read after the lock is released. A persistent read failure reports its file and OS error and does not supply a mutation precondition.
