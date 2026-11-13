# Revqora behavior checklist

Use this checklist with the relevant pages in [docs/wiki](wiki/). The rules below describe expected behavior. Add a rule when a feature is introduced, and change a rule when the user explicitly requests a change to that behavior. If implementation and documentation disagree, reproduce the discrepancy before changing either.

Before opening or updating a PR:

- [ ] Read the sections affected by the change, including shared UI, Git operations, shortcuts and portable state.
- [ ] Exercise the feature through its normal UI or MCP entry point. Cover existing data and adjacent actions that share the changed code.
- [ ] For a regression, reproduce the reported case and verify it with a focused test. Run the project verification from AGENTS.md and record failures and gaps.

## Explorer, Repositories and Branches

- [ ] Explorer shows folders, repositories and branches. Only folders and repositories can move in the tree. Moving a repository keeps its branches with it and changes only the app's organization.
- [ ] Repositories remains available as a flat panel. Clicking a repository highlights its entire row in both themes, even after the pointer leaves. Ctrl/Shift selection has its own styling. Escape clears the multi-selection.
- [ ] Branches remains available as a separate panel. Both surfaces share branch actions. A single click opens branch context while keeping the current checkout. Primary appears first and survives My branches. Favorites can show a branch with its repository and parent folders.
- [ ] Branch rows show ↑/↓ against their upstream. With a configured remote and no upstream, ↑ counts commits absent from the fetched remote branches.
- [ ] Test arrow navigation, F2 and Delete in the relevant panel. Shortcut bindings and hints are discoverable and existing overrides keep working.

- [ ] While a transfer runs for the active repository, Fetch rotates, Pull moves down and Push moves up. The icons return to rest when the operation ends. Reduced-motion mode uses the busy color without movement.

## History and cross-repository search

- [ ] Search all repositories scans the open repositories, including ones whose History view has never loaded. Results appear as each repository completes and are sorted newest first within each repository.
- [ ] A saved compact search dialog grows once when the first results or a repository error arrive. Users can resize it afterward. Its automatic size does not overwrite their saved size.
- [ ] Opening a match selects its repository and commit. Branch context, current-branch history and All branches are distinct scopes. Verify Graph, Review and Columns when changing shared history behavior.

## Working changes, staging and stash

- [ ] Commit Description shows a non-selectable hint while empty. Real draft text can be selected and copied while editing. Leaving the field clears the selection and preserves the draft.

- [ ] Whole-file stage uses the version available at staging time. Staging again updates the index to the latest version. Staging a hunk uses the selected diff and checks that it can still be applied to the index.
- [ ] Apply restores a stash and keeps its entry. Pop drops it after a complete restoration. When conflicts or partial index restoration occur, report them and preserve the stash. Drop preserves a recovery checkpoint and leaves the working files alone.
- [ ] Destructive actions show consequences before confirmation. Branch deletion outside the comparison history offers an explicit confirmation. Remote deletion checks the exact reviewed SHA.

## MCP and portable updates

- [ ] MCP read results and errors distinguish completeness and failures. Confirmable actions respect the configured approval mode, report their final outcome and preserve repository state on cancellation.
- [ ] Update packages verify the checksum, release version and platform before replacing files. On Windows the helper waits for the exact desktop process to exit. A failed installation identifies the operation and path and rolls back changed files. If rollback fails, preserve its backup. Verify that the portable data directory and repositories survive.
