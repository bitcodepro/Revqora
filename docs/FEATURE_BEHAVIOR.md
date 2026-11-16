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
- [ ] A dialog, the command palette or an open context menu takes every shortcut, keeps Tab inside it and returns focus to its opener when it closes. A tool window over the workspace (Blame, Compare, merge editor) keeps application shortcuts and blocks those for the History or Changes selection it covers (stage/unstage, close preview, Find commits). A view shortcut (History, Changes, Pull Requests, review layout, overview) closes a tool window that only shows something and then switches (Branch Manager with edited, unsaved protection rules counts as holding work); a rebase plan, workflow editor, agent request or merge editor stays open and a notice says the view was not switched.

- [ ] While a transfer runs for the active repository, Fetch rotates, Pull moves down and Push moves up. The icons return to rest when the operation ends. Reduced-motion mode uses the busy color without movement.

## History and cross-repository search

- [ ] Opening or filtering branch rows in Explorer may read refs for inactive repositories. It must leave their history graphs unloaded. Keep unchanged cached graphs and rebuild invalidated history on activation.
- [ ] Search all repositories scans the open repositories, including ones whose History view has never loaded. Results appear as each repository completes and are sorted newest first within each repository.
- [ ] A saved compact search dialog grows once when the first results or a repository error arrive. Users can resize it afterward. Its automatic size does not overwrite their saved size.
- [ ] Opening a match selects its repository and commit. Branch context, current-branch history and All branches are distinct scopes. Verify Graph, Review and Columns when changing shared history behavior.
- [ ] When the branch scope changes, History waits for that scope's graph. Updates to the same scope can keep the existing rows visible.
- [ ] History search covers the whole selected scope while the graph stays paged. A match outside the loaded graph is available in the match list and opens its commit by SHA.
- [ ] A selected commit shows its header and files before the pushed/local answer is known: the status reads "checking…" until it arrives and "unknown" if the read fails. CI checks appear only for a commit confirmed as pushed, and the Actions menu waits for the answer. If the answer stays unknown, the menu warns that the commit may already be pushed instead of treating it as local only.
- [ ] End in the commit list selects the last commit with one press, loading the rest of a paged history first. Arrow, Home and End keep working in the pull request list after the clicked row scrolls out of view.
- [ ] History **Filters** (author, literal file/folder path, since/until dates, first parent only, hide merge commits) combine with each other and with the search text (AND). Active filters show as removable chips; filters alone list matching commits. Dates are YYYY-MM-DD and values starting with '-' are rejected.
- [ ] Signature status in History is off by default. When on, only visible rows are checked, in batches; unsigned commits show no mark and a failed check shows "cannot be checked here" rather than a wrong verdict.
- [ ] Line history ("History of this line…", or "History of lines N–M…" for a selected range) and Folder history list only commits that changed those lines or that folder, with their diffs. Opening an entry selects its commit in History. Commit notes never change the commit; an empty note removes it.
- [ ] Diff View options (moved lines, ignore blank lines, more context, diff algorithm) change only the view. Show more context is per file and is disabled while the whole file is shown. Moved-line highlighting ignores short lines and lines replaced in place.
- [ ] A submodule pointer diff shows the old and new commit and the added/dropped commits. When the submodule is not checked out, was added/removed, or lacks the commits, it says why instead of failing.

## Blame

- [ ] Blame options (ignore whitespace, moved lines off / within file / across files, use ignore-revs file) are remembered in settings. A `.git-blame-ignore-revs` file at the worktree root is used when the option is on; a configured `blame.ignoreRevsFile` that does not exist must not make Blame fail.
- [ ] With moved-line detection a line may come from another file; "History of this line…" follows the line in that original file. Blame rejects revisions that are empty or look like options.
- [ ] Ctrl+F finds text in the blamed file (Enter / Shift+Enter next / previous). Up/Down move the focused line, Shift+Up/Down extend the selected range, Enter opens the line's commit.

## Working changes, staging and stash

- [ ] Commit Description shows a non-selectable hint while empty. Real draft text can be selected and copied while editing. Leaving the field clears the selection and preserves the draft.
- [ ] Amend stays on with its draft across refreshes, view switches and repository switches while HEAD is the commit it was turned on for. When HEAD becomes another commit (checkout, pull, a commit made elsewhere), Amend turns off with a notice: the message loaded from the old commit is cleared, typed or edited text stays. A successful commit clears the form.

- [ ] Co-author chips mirror the `Co-authored-by:` lines in the Description: adding appends one trailer after a blank line (or to an existing trailer block), removing deletes only that line, other trailers stay. Recent messages asks before replacing a non-empty draft. Fixup!/squash! from History commit only staged changes and are disabled with a reason when nothing is staged or an operation is in progress. See [Changes and commits](wiki/Changes-and-commits.md).

- [ ] Whole-file stage uses the version available at staging time. Staging again updates the index to the latest version. Staging a hunk uses the selected diff and checks that it can still be applied to the index.
- [ ] Routine Changes observations fingerprint the selected file. Git mutations still use their full preconditions. A diff truncated by the byte budget is marked partial and offers whole-file actions.
- [ ] Line selection: click toggles a line, drag extends, Shift+click selects a range across hunks. Stage block / Unstage block act on one change block of a hunk. With several files picked (Ctrl/Shift+click), right-click on a picked file opens the bulk menu; on an unpicked file it opens that file's menu.
- [ ] The Ignore dialog previews the exact rule appended to .gitignore or info/exclude and escapes special characters. It refuses to write if the ignore file changed since the preview (then shows the current file) and refuses a symlinked ignore file. Stop tracking removes matching files from the index only; they stay on disk.
- [ ] External tools run without a shell. Editor commands fill {file}/{line}/{column} and append the file when {file} is missing. Terminal-only diff/merge tools (vimdiff, nvimdiff, emerge) are refused; with no chosen or configured tool the user is asked to choose one. The merge tool runs without keeping .orig backups and Revqora waits until it closes.
- [ ] Restore on a new branch creates the branch at the stash's base commit, restores the stash with its index and drops it only after it applied.
- [ ] Apply restores a stash and keeps its entry. Pop drops it after a complete restoration. When conflicts or partial index restoration occur, report them and preserve the stash. Drop preserves a recovery checkpoint and leaves the working files alone.
- [ ] Destructive actions show consequences before confirmation. Branch deletion outside the comparison history offers an explicit confirmation. Remote deletion checks the exact reviewed SHA.

## Repository tools

- [ ] Repository tools shows Fetch more history / Fetch full history only for shallow clones. The rerere toggle changes this repository's configuration only; Stage replayed resolutions automatically is offered only while rerere is on.
- [ ] Sparse checkout tab: shows on/off, cone or non-cone mode and the folders/patterns; turning on uses cone mode; adding folders only uses `sparse-checkout add`; removing folders or switching mode confirms first with the files that leave the working tree (cone mode) and the ones with local changes. Git's warning or refusal and the affected files are shown; local edits are never discarded. Turn off explains that every file comes back. All changes are queued, state-checked, logged and checkpointed. Status shows no deletions for sparse-excluded files. In cone mode Git deletes ignored files in folders that leave the working tree: Turn on, Apply, Add, Switch to cone mode and Reapply first list those files and continue only after the user confirms; cancelling changes nothing.
- [ ] Reset (hard, keep), Revert and Rebase onto refuse to start when they would write over an untracked or ignored file, and name the file; nothing is changed. Soft and mixed reset are not affected.
- [ ] Ignored-file safety net: before every operation that writes the working tree (reset, revert, rebase, cherry-pick, merge, pull, checkout, stash apply, continue/skip/abort, bisect, sparse checkout and the like) the individual ignored files (not the contents of wholly ignored folders such as node_modules) are recorded and copied into the operation's recovery checkpoint, which stays on disk and in Recovery after a restart. If they cannot be copied, the operation does not start: a dialog lists exactly those files, and it runs only after the user accepts that list (a changed list asks again; consent is used once). After the operation, finished or failed, files Git changed or deleted are listed for that operation with Restore saved copies, Open Recovery and Keep Git's version. Restore puts back content and permissions, leaves alone any file changed after the operation, and reports which files were restored, left, failed or not attempted. Each changed file can be shown on disk and compared with its saved copy; a copy is never applied automatically.
- [ ] Local paths in the way (ignored-collision): when Git may overwrite local ignored data in any operation (pull, merge, rebase, checkout, reset and the like), the dialog lists every local/incoming path pair and offers Save a copy and continue (the paths, folders included, are copied into the operation's checkpoint and verified before Git runs; if the copy fails nothing runs and the unprotected-files dialog asks again), Continue without a copy (confirmed a second time) or Cancel. The decision covers exactly the listed paths and only the next operation; a longer list asks again. `git stash --all` is never used.
- [ ] Bisect start and each Good / Bad / Skip step refuse when a commit in the remaining range has a file where an untracked or ignored file is, and name the file; commits starting with `-` or unknown commits are rejected.
- [ ] Rebase onto: when the commits to replay include merge commits, the confirmation offers Keep merge commits (default, `--rebase-merges`) or Flatten into a straight line; without merge commits the plain confirmation is shown.
- [ ] Commit with a detached HEAD (no operation in progress) first asks: Create a branch… (creates and checks out a branch at the current commit, then commits), Commit without a branch, or Cancel. Continuing a merge, cherry-pick, revert or rebase never asks.
- [ ] Clone dialog: Sparse checkout runs `clone --sparse` plus `sparse-checkout set --cone` with the optional folders; a failure to add folders keeps the clone and shows a warning. Partial clone status lists promisor remotes and their filter; diffs and history of files whose contents are missing trigger Git's lazy fetch. No Convert to full clone action is offered.
- [ ] The Hooks tab (also "Git hooks…" in the palette) reads core.hooksPath, marks non-executable hooks as skipped and ignores *.sample files. It never runs a hook.
- [ ] Git LFS locks: when the server does not support locks the dialog still lists files and explains why. Unlock tries a normal release first; force unlock needs a separate danger confirmation.
- [ ] Export archive writes the shown revision as zip or tar.gz, chosen by the file name extension.

## Bitbucket credentials

- [ ] The Bitbucket Git prompt accepts a token by itself. With Remember enabled, it offers an optional email for Basic authentication in Pull Requests. Closing the email field submits a token-only sign-in.

## MCP and portable updates

- [ ] MCP read results and errors distinguish completeness and failures. Confirmable actions respect the configured approval mode, report their final outcome and preserve repository state on cancellation.
- [ ] Update packages verify the checksum, release version and platform before replacing files. On Windows the helper waits for the exact desktop process to exit. A failed installation identifies the operation and path and rolls back changed files. If rollback fails, preserve its backup. Verify that the portable data directory and repositories survive.
- [ ] Update card actions wrap inside the card when space is limited. Release notes wrap long links without hiding the end of the text.
- [ ] Error log lists recent application errors independently of Operation log. It copies one entry or all entries, preserves diagnostic codes, redacts credentials before storage and prunes entries older than seven days.
- [ ] Clear log deletes recorded application errors after confirmation. New errors can still be recorded and Operation log is unaffected.
- [ ] On Windows, a briefly locked working file can be read after the lock is released. A persistent read failure reports its file and OS error and does not supply a mutation precondition.

## Drag and drop in History and Branches

- [ ] Dragging a branch badge, a Branches row or History commits (a multi-selection moves together) onto a branch or commit only opens a menu at the drop point; the chosen item runs the existing merge, rebase, cherry-pick, reset, push or pull action with its dialogs. An item that needs another branch says "Switch to … and …", checks it out first and stops if that fails or is cancelled. See [Branches](wiki/Branches-and-cleanup.md#drag-and-drop).
- [ ] Only targets with at least one action show a drop indicator. A plain click, double-click, right-click, Ctrl/Shift selection and lane hover behave as without drag and drop; Esc cancels a drag and an invalid drop changes nothing. Items are disabled with a reason during an operation in progress, on detached HEAD, for a branch checked out in another worktree and when both sides are the same commit.

## Themes

- [ ] The Theme setting offers System, Light, Dark, High contrast light, High contrast dark and saved custom themes. System follows the OS colour scheme and uses the high-contrast variant when the OS asks for more contrast (`prefers-contrast: more` or `forced-colors: active`). Detached panel windows show the same theme, including custom colours. **Toggle dark / light theme** switches to the built-in theme of the other colour scheme, keeps high contrast and never changes a custom theme.
- [ ] The theme editor duplicates a built-in or custom theme, previews unsaved colours at once, and saves, renames, deletes, exports and imports custom themes. Built-in themes cannot be edited. A theme file with an unknown field or colour token, or a value that is not a hex, `rgb()` or `hsl()` colour, is rejected whole with a message naming the problem; nothing from it is applied.
