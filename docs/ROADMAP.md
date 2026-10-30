# Revqora implementation roadmap

This is the agreed sequence. The commit-preview performance fix in PR #10 is
cross-cutting work and does not consume a feature stage.

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Repository operation queues and state preconditions | Merged (#6) |
| 2 | Persistent operation journal | Merged (#7) |
| 3 | Recovery checkpoints and Undo Center | Merged (#8) |
| 4 | Reviewed branch deletion | Merged (#9) |
| 5 | Ignored files, partial stash, autosquash, nested repositories, remote branch rename | Merged (#11) |
| 6 | Rebase Studio: affected refs, force-push implications, result comparison, recovery | Merged (#12, #13) |
| 7 | Conflict Studio: Base panel, navigation, user-selected validation commands | Merged (#14) |
| 8 | Repository favorites, project groups, workspaces and explicit Sync | Merged (#15) |
| 9 | Advanced Branch Manager | Merged (#16) |
| 10 | Reviewed bulk branch cleanup | Implemented; review pending |
| 11 | Worktree Manager | Planned |
| 12 | Accounts and forge integrations | Planned |
| 13 | PR Center: browse, create, edit, templates and diffs | Planned |
| 14 | PR Center: comments, threads and review submissions | Planned |
| 15 | PR Center: CI, server protections, merge and branch cleanup | Planned |
| 16 | Agent Workspace | Planned |
| 17 | Workflow Builder | Planned |
| 18 | Automated PR Workflow | Planned |
| 19 | Semantic diff and history tools | Planned |
| 20 | Stacked branches | Planned |

Performance, compatibility, external-Git changes and data-safety regressions apply
to every stage. Application data remains portable beside the executable.

## Stage 9 — Advanced Branch Manager

- Dedicated workspace accessible from the toolbar, branch sidebar and command palette.
- Local/remote scope, author/message/SHA search, stable sorting, and All / Active /
  Merged / Unmerged / Stale / Diverged / Protected filters. Active includes checked-out
  worktrees; stale uses the tip commit date, not branch creation or checkout time.
- Batched read-only metadata, virtualized rows, upstream ahead/behind and missing
  upstream indicators, tip author/date/message, and occupied/locked/prunable worktrees.
- Explicit comparison base and immutable commit IDs for selected branch comparisons.
  Reachability uses original history, ignoring replacement refs and legacy grafts;
  it does not prove squash/rebase patch integration or safe deletion.
- Configurable local protection patterns (main, master, develop, release/* by default).
  Remote protection considers actual server source refs, including aliased mappings.
  Ambiguous/unmapped remote references disable destructive manager actions.
- Existing reviewed rename/deletion actions; current or occupied branches cannot be
  deleted from this screen. Per-repository scope, filter, base, sort, age and rules persist.
- External Git changes refresh the screen; stale asynchronous results are discarded.
  Remote counts describe cached tracking references until an explicit/background Fetch.

Bulk cleanup remains stage 10; forge-side protections and PR status are later stages.

## Stage 10 — Reviewed bulk branch cleanup

- Select individual rows or up to 50 branches from the current manager filter.
  Selection retains the inventory SHA; hidden selections are counted explicitly.
- Per-row local-only, remote-only (keep local), or combined deletion. Ambiguous
  mappings require individual review; a server destination cannot appear twice.
- One review shows exact tips, divergence, commits outside a surviving local base,
  worktrees and protection failures; risky rows require individual force consent.
- A single repository writer turn checks the complete batch before its first
  mutation, including actual server tips and protections on every destination.
  Each row is revalidated before execution; local CAS and remote SHA leases remain.
- Reference recovery checkpoints precede deletions. Results distinguish complete,
  partial, failed and skipped rows and link their checkpoints in Undo Center.
  The sequence stops on failure; a partial batch is never automatically retried.
- This is not a cross-server transaction. Working files are kept. Counts use
  physical commit ancestry, not replace refs; squash integration is not proof of
  retained history. Forge PR status/server policy discovery belongs to later stages.
