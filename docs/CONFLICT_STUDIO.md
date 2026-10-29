# Conflict Studio

Open **Resolve conflicts** from the operation banner, or open a conflicted file
from Changes. Ours and Theirs retain Git's meaning for the current operation;
during rebase the labels identify the target and the replayed commit.

- **Base** shows the common ancestor read-only. Its visibility is remembered in
  the portable profile. Add/add conflicts explicitly show that no ancestor exists.
- The file selector and **Alt+PageUp / Alt+PageDown** switch conflicted files.
  **Alt+Up / Alt+Down** navigate remaining conflict blocks in Result.
- Result starts from the actual working file, including partial manual edits.
  CRLF files are normalized inside the editor and written back with CRLF.
- Unsaved working-tree conflict buffers survive file/repository navigation and
  closing/reopening the editor **in the current app session**. They do not survive
  app exit: use **Save draft** to persist them. Save draft keeps the index
  unresolved. **Save & mark resolved** stages the result and moves to the next file.
- Saves and whole-file resolution actions use the observed repository state and
  create recovery checkpoints. External changes reject stale saves. **Review
  current versions** reloads the Git sides; if the disk result differs, it shows
  both texts and requires consent before retaining the old draft with a new guard.
- Resolution never finishes a merge or creates its commit automatically.
- If a file is resolved from Changes, external Git, or an abort, its unsaved
  session buffer is retained for recovery but no longer blocks validation.
  **Validate → Retained drafts for resolved files** lets you view/copy or discard
  it without changing the working file or index. This is also available after
  an operation ends via **Repository tools → Validate / conflict drafts**.

## Optional tests and builds

Choose **Validate** in the editor or operation banner. Enter a command explicitly
(for example `npm test`, `dotnet test`, or `cargo test`), review the command and
working directory, then choose **Run command**. Commands are remembered per
repository in the portable profile. Repository scripts/configuration are never
automatically executed or imported as trusted commands.

Commands use `cmd.exe /D /S /C` on Windows and `/bin/sh -c` on Unix, with closed
stdin. The timeout defaults to 300 seconds and can be set to 1–1800 seconds.
Output is limited to 128 KiB per stream and kept in memory for the app session.
The UI shows stdout, stderr, elapsed time and exit code. **Cancel check** stops
the command and its process group/job; background descendants in that group/job
are also stopped at completion. Deliberately detached Unix processes are outside
this process-group guarantee.

Checks share the repository's mutation queue, including linked worktrees. A
recovery checkpoint of Git-visible workspace files and the index is created
before execution; ignored build output is excluded. Other Git mutations remain
queued until the command ends.

A passing result is current only while the Git-visible state matches both the
start and end of the check and there are no unsaved conflict drafts. A command
that modifies tracked/untracked files invalidates its own result. Changes to
ignored output alone do not invalidate it. Existing watchers detect IDE/CLI edits.
After a failed, cancelled or stale check, finishing merge/rebase requires explicit
acknowledgment; validation remains optional.

Application-owned files continue to live in portable data beside the executable.
Commands chosen by the user can write their own tool-specific data; Revqora does
not sandbox those tools or change their configured cache locations.
