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
| 10 | Reviewed bulk branch cleanup | Merged (#17) |
| 11 | Worktree Manager | Merged (#19) |
| 12 | Accounts and forge integrations | Merged (#20) |
| 13 | PR Center: browse, create, edit, templates and diffs | Implemented; review pending |
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

## Stage 11 — Worktree Manager

- Dedicated, virtualized workspace from the toolbar, sidebar and command palette.
  Branch, path, HEAD, staged/untracked/ignored state, ahead/behind, active operation,
  main/current identity, lock reason and missing/prunable registration details.
- Search, All / Changed / Locked / Missing / Detached filters, keyboard navigation,
  deterministic sorting and per-repository preferences. Refresh on external events,
  window focus and a visible ten-second poll; stale responses cannot replace new data.
- Open another worktree as a repository tab without checking out the original branch.
- Preview existing/new-branch or detached creation. New/detached starts are immutable
  commit IDs. Existing branches must be free, direct local refs; occupied branches,
  aliases, existing destinations and overlapping worktree folders are rejected.
  Parent/registration/state changes invalidate the preview. Git errors may leave a
  partial creation; the UI requires a fresh review and never automatically retries.
- Explicit lock/unlock with a reason; locked missing folders are excluded from cleanup.
- Removal verifies main/current/locked state, exact registration/Git identity and
  target/source state. Complete recovery includes working files, ignored paths,
  assume-unchanged/skip-worktree content/absence, empty folders and the raw index.
  A full snapshot is bounded to 100 MiB / 20,000 paths; the worktree stays if capture
  cannot complete. Nested repositories/submodules, directory links and active Git
  operations are blocked. Revqora's own executable/profile cannot be removed.
- Preview/select at most 50 missing registrations. Explicit exclusions survive review
  refresh. Scoped native removal (without force) affects only reviewed missing paths,
  with HEAD recovery pins saved first; branches stay. Reappeared folders and external
  registrations invalidate review. Execution stops after a failure and distinguishes
  removed, kept/not-attempted and unknown results with the saved checkpoint.
- These are optimistic preconditions, not a lock against external IDE/CLI writers.
  Existing Git hooks run normally. Forge PR/agent status belongs to stages 12–16.
- All previous 86 native scenarios remain; nine isolated worktree scenarios cover
  creation modes, source staging, open/current/main restrictions, lock consent,
  complete recovery, identity replacement, stale async previews and scoped cleanup.

## Stage 12 — Accounts and forge integrations

- Global API account manager from the toolbar, settings, command palette and PR view.
  Multiple verified identities on GitHub (including Enterprise), GitLab (including
  installation prefixes), Azure DevOps organizations/collections and Bitbucket Cloud.
- Explicit token authentication: GitHub PAT, GitLab personal token, Azure PAT, Bitbucket
  API token/email or OAuth access token. Browser OAuth registration/sign-in is not
  implemented; Bitbucket Server retains the existing Git-credential integration.
- Tokens are session-only by default. Optional AES-256-GCM encrypted records use a
  password-derived PBKDF2-HMAC-SHA256 key, random salt/nonces and authenticated profile
  metadata. The password/key is never saved. Vault and settings stay in data/accounts
  beside the executable. Restart starts locked; lock clears active session credentials.
  Password rotation and explicit forget/reconnect preserve account metadata.
- Per-common-repository, per-remote account bindings and an explicit active API remote.
  Remote URL changes, removed/locked/expired accounts and stale settings fail closed;
  HTTPS API accounts must match the remote origin; an SSH host alias requires an
  explicit API mapping. They never silently substitute another account or fall back to a Git credential.
  API requests do not follow redirects, forward raw server error bodies, or share a
  host-only token cache. HTTPS is required outside literal loopback IPs (local services).
- Existing PR/checks use the selected identity and remote. Azure gains basic PR list,
  create, source-commit checkout and commit-status support. Repository/namespace path
  components are encoded for the API. PR writes/checkout retain the observed API
  connection revision, including actual remote URL, and reject changed selections.
  Checkout verifies the reviewed PR source SHA, uses a temporary private ref and a
  SHA-specific branch, and never force-updates an existing PR branch or alias.
- Git Fetch/Push still use native Git credential helpers and SSH-agent configuration.
  API identity and commit author are separate, explicitly described in the UI.
- Seven new native scenarios extend the existing worktrees shard to reuse its native
  process/profile and avoid another runner. All previous 95 remain (102 total), including
  actual restart, selected-account routing, encrypted persistence, stale confirmations,
  failed identity replacement, redirect refusal and unchanged files/index/HEAD.

Stages 13–15 expand the PR Center; eight planned stages remain after stage 12.

## Stage 13 — Pull Request Center

- Paged request list with Open / Closed / Merged / All states, loaded-page search,
  direct opening by number, keyboard navigation and virtualized rows. The selected
  API remote/account is visible; switching identities discards obsolete UI responses.
- Separate description and Files views. Long descriptions expand into a scrollable
  reader and remain plain text; provider HTML cannot run or load tracking images.
  Request and file panels collapse/resize with per-repository persistent preferences.
- Create a normal or draft PR from an already published branch; no implicit Push.
  Edit title, multiline description and target branch using a fresh server snapshot.
  Concurrent edits/changed API selections reject before sending a metadata write.
  These are optimistic checks, not atomic multi-provider transactions. Bitbucket
  Server additionally uses its server PR version. Permissions remain server-enforced.
- Committed local templates from provider-specific locations. Linked, binary and
  oversized templates are excluded; replacement of a nonempty description needs
  confirmation. Uncommitted template text never silently becomes a PR description.
- Read-only unified/split diffs with line wrapping and horizontal scroll, rename,
  binary and mode-only changes. GitHub/GitLab/Bitbucket raw patches are bounded and
  cached in memory against observed commit IDs; incomplete hunks/server limits are
  reported. Azure compares immutable merge-base/source blobs, using portable temp
  files without touching HEAD, staging or working files. Oversized previews explain
  the limit and can be opened on the server or reviewed in a local checkout.
  Azure explicitly warns that this content-only preview does not compare Git file
  modes or object types (executable permissions, symlinks and submodules), including
  when identical blob contents produce no text changes.
- No automatic API write retries. An unreadable write response requires checking
  the server before a manual retry; partial field application stays visible in the
  editor. Browser actions use canonical provider URLs and HTTP(S)-only check links.
- Eight native scenarios extend the existing worktrees runner (110 total, all
  previous 102 retained). Real loopback HTTP contracts cover the four managed
  providers; legacy Bitbucket Server remains on Git credentials. Live public-service
  credentials are not required by automated tests.

Stages 14 and 15 add review conversations/submissions, then server checks/protections,
merge and cleanup. Seven planned stages remain after stage 13.
