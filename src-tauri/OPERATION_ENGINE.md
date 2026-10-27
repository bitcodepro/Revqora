# Repository operation engine, journal and recovery (stages 1–3)

- Every existing-repository mutation exposed by Tauri runs through `mutating` in `lib.rs`.
  The client/backend command registry parity is checked by a frontend regression test.
- The FIFO writer queue covers the entire backend operation, including its checks and
  nested Git commands. Independent repositories run concurrently. Linked worktrees and
  path aliases share a queue keyed by the canonical Git common directory.
- The low-level runner participates in the same gate. Fetch, push and maintenance are
  writes. Immutable object creation can run with readers; enclosing mutations still hold
  their writer scope. Nested calls reuse their thread's scope; read-to-write upgrades
  fail instead of deadlocking. Readers do not observe intermediate transaction steps.
- Status includes a SHA-256 state token derived from HEAD, index, refs, local config,
  pending-operation files, stash history and the contents of changed/untracked files.
  Token generation does not refresh or rewrite the index. Hashing large dirty files adds
  I/O; this is correctness-oriented and is not a performance SLA.
- Index comparison uses semantic entries, not cache-tree/stat extensions or index
  storage version. Status observations have monotonic versions so delayed responses
  cannot overwrite newer UI state. Commit waits for the preceding client mutation's
  refresh to finish, not merely for its Git command to return.
- Before a guarded operation starts, its prepared token is checked under the write
  gate, after any wait. A stale operation fails without automatically retrying. Dialogs
  and editors retain their original token. Worktree removal also checks the target's
  token. The client refreshes after success or failure, including between compound calls.
- Commits, staging selections and indexed layer/stash actions retain the displayed
  precondition. Other commands capture a fresh request snapshot while checking the
  displayed destination HEAD. Destructive confirmations prepare and freeze a snapshot;
  rebase/conflict editors receive one atomically with the data they loaded.
- Background squash-merge annotations are coalesced per workspace/ref state and stale
  results are discarded. They must not build up ahead of interactive operations.
- Background fetch/configuration/maintenance remain serialized but do not require the
  old UI token. Existing Git validation and conflict handling remain active. An ordinary
  commit cannot finish a pending merge: the explicit continue/confirmation path is used.
- Ephemeral `repository-operation` events report queued/running/finished/failed states;
  the status bar shows running and queued counts. Completion refreshes related open
  worktrees. These events are transient; the persistent journal is described below.
- Layer actions remain unavailable through the preceding mutation's completion and
  through their own list/status refresh. A fresh layer list alone does not imply that
  the displayed status token has caught up with staging.
- Combined branch deletion uses a dedicated remote operation with an explicit
  `--force-with-lease=<resolved ref>:<reviewed SHA>` on every attempt, including force
  and partial-failure retries. A local state token cannot detect unseen server pushes.
  A lease rejection requires explicit refresh and new consent to the displayed SHA
  and commit counts. The target also binds one push URL; refresh reads that server,
  including when it differs from the fetch server.

## Boundaries

The gate is in-process, not a lock on other Git programs or editors. External processes
can still write after preflight; Git's lock files and operation-specific stale checks
remain necessary. A successful preflight is not a recovery guarantee. The engine does
not provide process cancellation or cross-process Git orchestration. Recovery
checkpoints are a separate service described below.
A UI sequence such as commit then push consists of two backend operations.

## Persistent operation journal (stage 2)

- SQLite lives under portable `data/operation-log/`. UI automation profiles use an
  isolated journal inside their own WebView profile. No log is sent to a service.
- Existing-repository mutations, initialization and cloning record queue/run/result
  times, worktree/common-directory identity, observed HEAD before/after, outcome and
  bounded nested Git command diagnostics. Ordinary read-only UI browsing is not logged.
- A successful Git result remains successful when logging fails. Storage errors are
  visible through the journal button/view; Retry logging checks storage again.
  Failed terminal writes retain up to 2,000 sanitized results in memory. Retry saves
  them transactionally without rerunning Git, preserving genuinely queued/running
  actions. If exact result metadata is unavailable, completed actions are marked
  as having unknown outcomes. Process restart uses session recovery instead.
- Each process holds an OS lock on its session file. Startup and journal reads mark
  orphaned queued/running records as interrupted with UNKNOWN Git outcome. A live
  second instance's work is preserved. An orphan Git process may continue after the
  app exits; the journal never resumes actions or claims to have rolled them back.
- Queries support repository/common worktree scope, result, Unicode-aware search,
  date bounds and stable keyset pagination. Export reads one SQLite snapshot, writes
  JSON atomically and refuses to overwrite the live database. Clearing affects only
  completed entries matching the chosen filters; queued/running actions remain.
- Retention keeps up to 2,000 completed operations for 30 days, within a 50 MiB logical
  payload budget. Each operation records at most 64 commands and 64 KiB of output;
  arguments/output have additional per-field bounds, and omissions are indicated.
  SQLite may retain reusable database/WAL pages after pruning; the payload limit is
  not a promise about the exact physical file size.
- Sanitization happens BEFORE SQLite writes. Standard input and environment values
  are never captured, message/config-value arguments are omitted, and output from
  source/configuration plumbing is omitted. Known URL credentials, auth headers,
  secret assignments, PAT formats and private-key blocks are redacted. Git/server/hook
  output can contain other sensitive text: exported diagnostics still need review.
- Queued/running, succeeded, failed, paused workflows needing attention and interrupted
  sessions have distinct results. A command's non-zero exit code can be a normal Git
  check; the enclosing action's result is recorded separately.

Journal HEAD metadata and diagnostic output are not backups. The separate checkpoint
service below stores recoverable files, index contents and selected Git references.

## Recovery checkpoints and Undo Center (stage 3)

- Manual checkpoints and automatic checkpoints run inside the repository writer gate.
  Automatic capture follows stale-state and pending-operation checks, before reset,
  undo commit, rebase/rewrite, merge/pull, cherry-pick/revert, discard (including lines
  and layers), stash apply/drop, file replacement, branch deletion and pushes. Amend
  has a dedicated capture; removing a worktree captures the target after checking its
  reviewed state. Git is not started if capture fails. A failed subsequent action may
  leave a useful checkpoint; it does not imply the action succeeded.
  Prepared state is checked again after waiting for the checkpoint-storage lock.
  Managed recovery refs are excluded from prepared-state tokens so a failed attempt's
  backup does not invalidate subsequent force consent. User refs, files and index
  changes remain guarded; recovery pin integrity has its own exact-OID checks.
- Data lives beside the executable under `data/repositories/<common-git-dir-hash>/recovery/`, shared by linked
  worktrees. An OS file lock serializes checkpoint creation/recovery/removal across app
  instances. This lock does not coordinate external Git programs or editors.
- Full checkpoints copy the raw index, its shared index when present, and exact bytes
  of changed tracked/untracked paths reported by Git. They preserve staged/unstaged
  differences, deletions, renames, binary files, links and executable modes. Sparse
  checkout patterns and Git-normalized booleans are retained. Recovery applies saved
  settings to the new worktree even if shared settings changed after capture. When
  legacy shared sparsity needs isolation, Git upgrades to worktree-specific config
  (including its native core.worktree/core.bare migration); the original worktree's
  effective settings, sparse patterns, files and index stay intact. Capturing does not refresh or rewrite the source
  index. Before/after state checks and file hashes reject observed concurrent changes;
  they cannot prevent a later external write.
  Restoring drops filesystem-monitor/untracked-cache extensions belonging to the
  original worktree while preserving semantic staging flags, including intent-to-add.
- Immutable Git objects and commits reachable from saved local/remote-tracking heads,
  stash entries and worktree layer refs are pinned under `refs/revqora/recovery/`.
  Index objects (including conflict stages) are pinned as well. Protected refs are not
  included in the normal history graph. Tags are outside this recovery format.
- Files are checksummed; manifests are published after their object pin exists.
  Incomplete/unreadable checkpoints are preserved and reported. Exact compare-and-swap
  deletion refuses a changed pin. Retention removes old managed checkpoints after
  30 days, 100 entries or a 1 GiB saved-file budget; a checkpoint is limited to 100 MiB
  and 20,000 changed paths. Already existing Git objects/history pinned by recovery
  are not included in this file budget, so it is not a physical repository-size cap.
- Undo Center offers search/filtering, inspection, manual capture and deletion.
  Reference recovery creates a NEW local branch, or appends an existing saved stash.
  Workspace recovery creates a NEW branch/worktree at a new path outside existing
  worktrees. Existing branches, files and remote servers are not replaced. A failure
  after creating the new worktree preserves it for inspection and reports its path.
- Workspace recovery restores files and staging, not an active merge/rebase/bisect
  state machine or stage-layer labels. Conflict stages can be recovered for manual
  resolution. Unborn repositories recover with an unborn branch. Dirty submodule
  contents and nested repositories are not backed up; capture refuses modified
  submodules. Ordinary captures exclude ignored files and changes Git deliberately
  hides via index flags. Worktree-removal captures additionally include ignored files
  and refuse removal if the backup exceeds the limits. Remote-tracking refs reflect
  locally observed SHAs; no unseen server history or remote undo is promised.
- Checkpoints contain private project data and stay local. The client's transport
  checks reject mirror/wildcard mappings that would publish or prune private recovery
  refs; ordinary branch/tag mappings remain available. External CLI `push --mirror`
  and equivalent refspecs can publish these refs and must exclude the namespace.

## Regression coverage

Real temporary-repository tests cover FIFO ordering, multi-command isolation, common
worktree identity, independent repositories, queued external changes, equal-size/equal-
timestamp content changes, external ref updates, errors/panics and read-only index safety.
Native UI scenarios additionally block a commit hook, queue fetch and reset, verify the
queue indicator and reject stale reset; another keeps a delete dialog open across an
external Git change and checks that its original consent is preserved.
Additional tests use two clones to advance/replace server history before deletion,
between a partial failure and retry, and after refreshed force consent. The native
staging test delays real IPC responses to expose a new layer list before the prior
staging completion, then checks that layer actions wait for synchronization.

Journal regressions cover real Git commands and HEAD observations, filtering and
pagination, linked worktrees, redaction before persistence/export, output/retention
bounds, read-only storage failures, panic cleanup and concurrent active app sessions.
Native scenarios export/clear a filtered log and terminate/restart the actual app
with one running and one queued action, verifying persistence and unknown outcomes.


## Portable storage

All Revqora-owned runtime files live under `data/` beside the executable: WebView
profile/settings, operation journal, recovery files, discard backups, deleted-branch
records, bisect notes, temporary indexes/messages, and temporary process files.
Repository scopes use SHA-256 of the canonical Git directory; linked worktrees
share the common recovery scope and keep their worktree-specific state separate.
Legacy `.git/revqora/` contents and the squash marker migrate on first access.
Copies are written atomically, synced and compared before removing their originals;
conflicting or linked entries stop migration and preserve the old data. An unwritable
portable directory is an error, never a fallback to AppData or system temp.
The update downloader stages packages beside the executable in `.revqora-update/`.
Native Git objects, refs, indexes and operation state remain in the repository.
Automation may explicitly supply an isolated profile; production ignores external
`WEBVIEW2_USER_DATA_FOLDER` overrides.


Conflict `Take ours/theirs/base/delete` and `Mark unresolved` actions capture the
current working files/index after preflight, before replacement. This preserves
manual resolutions made after the merge began; it is separate from the pre-merge
checkpoint. Capture failures stop the replacement.
Undo Center exposes the loaded detail checkpoint ID, hides stale detail/actions
immediately on row changes, and tests wait for that ID before selecting a reference.
The native regression holds detail responses behind a deterministic IPC gate.


## Reviewed branch deletion (stage 4)

The deletion dialog freezes a plan with a selected surviving comparison branch and
its exact SHA, the local branch SHA, remote mapping/push URL and cached or explicitly
refreshed remote SHA. It shows local-only/remote-only counts, SHA reachability,
content-integration estimates and linked-worktree state. Squash/content integration
is advisory: missing original SHAs still require force consent. An in-use branch
cannot be deleted even with force. The current working files are not discarded.

Changing the comparison/remote selection reloads the plan and resets consent.
External changes never silently update an already visible proof. Local deletion
checks the operation token, comparison SHA, local SHA and worktree usage before and
after creating a checkpoint, then removes the exact ref with update-ref --no-deref
and its expected old SHA. Remote deletion rechecks the comparison and routing,
requires the local branch to remain absent and always sends an exact server-SHA
lease. Partial failure retains the local checkpoint and original remote lease;
refreshing a server tip requires explicit new review, including unmerged history.

Each successful phase returns its actual recovery checkpoint ID. Besides ordinary
repository refs, it pins the reviewed local commit and the actual push-server commit,
even if the fetch URL/cache points elsewhere. The success notice opens that exact
checkpoint in Undo Center. Metadata-cleanup failures after local ref removal are
warnings, so the completed destructive action is not retried. No PR status is claimed
until the PR integration stages are implemented.

Regression coverage includes selected-target deletion, squash consent, checked-out
dirty worktrees with Unicode/quoted paths, changed local/base SHA rejection,
checkpoint failure, leased remote retries and distinct fetch/push servers followed
by reflog expiry/GC and restoration. Native WebView2 scenarios cover the target
selector, reset consent, exact-checkpoint navigation/restoration and worktree guard.

The remote-list `Delete on remote` menu uses the same review, checkpoint and leased
sender. The server ref is resolved from the actual fetch mapping of the displayed
tracking ref, including renamed aliases. Remote-only proofs keep local refs and
working files intact, freeze the presence/SHA of a same-named local branch and allow
that branch as a comparison target even when checked out. No local ref is invented
when the branch exists only on the server. Refreshed server history requires new
consent, and force never disables its exact-SHA lease.

After a successful local deletion, the dialog freezes that mutation's reviewed local
SHA for subsequent replanning. Initial or refreshed previews never replace this
receipt. The native regression advances A to B, refreshes the review, deletes B,
rejects the server update, refreshes/retries remote deletion, then restores the named
local reference from the final success checkpoint and verifies it is exactly B.
