# Repository operation engine (stage 1)

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
  worktrees. This is not the persistent operation journal planned for stage 2.
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
remain necessary. A successful preflight is not a recovery guarantee. Checkpoints,
process cancellation, cross-process orchestration and a persistent journal are outside
stage 1. A UI sequence such as commit then push consists of two backend operations.

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
