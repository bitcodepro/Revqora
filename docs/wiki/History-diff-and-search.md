# History, diff and search

**Where:** **History / Ctrl+1**, commit/file context menus, **Compare branches…**, and **History Explorer** in the command palette.

## Inspect history and a commit

Use **History scope** to show the current branch, an explicit local or remote branch, or **All branches (local and fetched)**. Clicking a branch in the sidebar opens **Branch context**. The app highlights that branch's own commits, shows the source or comparison branch, and includes the configured primary branch. Click a graph lane to highlight its commits. Use **Clear line highlight** to release it.

History opens with up to 200 commits and extends as you scroll. The count shows the full scope when available. Commit search includes older commits. On a local branch, the eye icon shows or hides fetched commits marked **Incoming**. Pull applies those commits to the local branch.

Hover a Graph row and press **↑ / ↓** to move the highlight. Press **Enter** to open that commit. With a preview open, **↑ / ↓** change commits and **Ctrl+↑ / Ctrl+↓** change the selected file.

Select a commit to see its author, SHA, message and changed files. Choose a file to read its diff. Open **Message** for a long description; **Close** dismisses the preview without changing your branch.

The graph shows relationships between commits. Labels identify branches, tags and the checked-out HEAD. Use search and filters to narrow a large history by the supported message, author, SHA, path or code criteria.

## Read a diff

Right-click the filename above the diff and choose **Copy name** to copy the full filename with its extension.

- **Unified** combines additions and removals in one view.
- **Side-by-side** puts old and new content next to each other.
- **Wrap lines** fits long lines inside the visible pane.
- With wrapping off, use horizontal scrolling.
- **F7 / Shift+F7** jump between changes.

Use **Find in diff (Ctrl+F)** to search the open diff. Where offered, **Show the whole file** expands its context and **Ignore whitespace** reduces whitespace noise. Turn whitespace ignoring off when checking formatting-only changes; it changes the view, not the file.

Check file status and metadata as well as text: rename, binary, executable-bit and object-type changes can matter. An unavailable or partial preview is not evidence that the file did not change. Image comparisons are available for supported image files; arbitrary binary formats are not rendered as text.

## Compare branches or commits

In a comparison's commit lists, right-click a commit or drag it to the other branch's list to start a reviewed cherry-pick to that branch.

Open **Ctrl+N → Compare branches…** or a branch's comparison action. Review the selected revisions and comparison mode/direction. A direct endpoint comparison and a comparison based on a common ancestor answer different questions.

Example: compare `main` with `feature/login` to inspect the feature. Reading the comparison does not merge either branch.

**Browse files (HEAD)** opens a revision's tree without checking it out. Right-click a tracked file in Changes or a commit's changed-file list for **File history** and **Blame** / **Blame at this commit**. Select a history entry to inspect its recorded changes. Blame points to the recorded commit/author; it does not establish why a change was made.

## Search actual changed code

Open **History Explorer: search changed code…** and choose **Literal changed lines**.

1. Enter a literal string, for example `RefreshToken`.
2. Optionally restrict the repository-relative file or directory, such as `src/auth`.
3. Choose **Search changes**.
4. Open a matching commit and inspect its actual diff.
5. Use **Load more changes** when offered.

This is case-sensitive text search in added/deleted lines across available local history, including local/remote-tracking refs and tags. It does not search remote issue descriptions or resolve programming-language references. Fetch first if the required history is not local.

## Find changes inside a function or JSON subtree

Select **Symbol body / JSON subtree** and supply the complete source-file path.

- TypeScript/C#: enter a declaration name, such as `refreshToken` or `Service.Run`.
- JSON: enter a JSON pointer such as `/ports`.
- For JSON, `$` selects the whole document; `/` means a property whose name is empty.

This mode compares bodies/subtrees in C#, TypeScript/TSX and JSON, including changes that did not touch a function's name line. It scans first-parent file revisions in pages of 25 and pins the starting HEAD. Use ordinary File history for renames; this mode follows the current path.

**Related:** [Review layouts](https://github.com/bitcodepro/Revqora/wiki/Interface-and-navigation) · [Rebase and commit operations](https://github.com/bitcodepro/Revqora/wiki/Merge-rebase-and-conflicts) · [PR file previews](https://github.com/bitcodepro/Revqora/wiki/Pull-Request-Center)
