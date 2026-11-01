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
| 13 | PR Center: browse, create, edit, templates and diffs | Merged (#21) |
| 14 | PR Center: comments, threads and review submissions | Merged (#22) |
| 15 | PR Center: CI, server protections, merge and branch cleanup | Merged (#23) |
| 16 | Agent Workspace | Merged (#24) |
| 17 | Workflow Builder | Implemented; review pending |
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

## Stage 14 — PR discussions and published reviews

- Dedicated Discussions view with pagination, loaded-text search, resolved/unresolved/
  outdated filters and readable plain-text comments. GitHub PR comments and review
  history are separate feeds; other providers show their current approval/vote state.
- Inline comments from old/new line numbers in unified and split diffs. Native code
  verifies the cached PR snapshot, actual path, side and displayed line before posting.
  GitHub pins commit_id; GitLab uses base/start/head SHAs. Azure additionally verifies
  source, target and common commits against the latest iteration and resolves the file's
  changeTrackingId before attaching a line. Unmappable anchors fail without publishing.
- Replies, resolve and reopen use a fresh discussion proof and current capabilities.
  GitHub global thread IDs are checked against repository and PR membership. Long
  GitHub threads can load their remaining replies; explicit size limits never look like
  a complete empty conversation. Bitbucket replies are collected from loaded pages.
- Explicit Comment / Approve / Request Changes submission. GitHub forbids self-review;
  GitLab approval eligibility comes from its approval API; server authorization remains
  final for token scopes and policies. Identity checks and writes share one credential,
  including native Git-helper fallback. Stale PRs/accounts/threads reject before writes.
- Provider semantics are visible: GitHub can submit summary and vote together. Other
  providers publish votes separately from comments. Azure Request Changes means waiting
  for author (vote -5), not rejection. GitLab Request Changes is not exposed by this REST
  integration; Bitbucket Server voting needs a verified API identity and remains on the
  server. Unsupported actions are disabled instead of being posted as fake reviews.
- Portable local drafts are scoped to repository, API identity, PR, source and target.
  Closing keeps text, success clears that draft, failures retain it. Drafts from earlier
  source commits require explicit restoration. The bounded store never evicts drafts
  silently. No review action is sent automatically or retried after an uncertain result.
- After publication the PR context refreshes before enabling further actions. Review
  writes are serialized per repository and never stage, commit, fetch or change files.
  Checks are optimistic where providers have no atomic lease; permissions may still
  change or a source may move during a server request.
- Ten additional native scenarios reuse the existing worktrees shard (120 total,
  retaining the previous 110). Loopback contract tests exercise real Rust HTTP requests
  for the four managed providers, permission/identity failures, stale and uncertain
  writes, exact anchors and unchanged Git HEAD/index/working files.

Stage 15 adds CI/protection-aware merging and branch cleanup. Six stages remain after 14.
## Stage 15 — CI/protection-aware merging and separate source cleanup

- Live merge readiness in PR Overview, with explicit refresh and a visible ten-second
  poll. Loaded CI states, server requirements, required review decisions, actor and
  immutable source/observed target IDs remain distinct. Unknown/incomplete policy or
  check responses never look like a green empty result. CI follows pagination headers,
  includes later-page failures and has explicit complete-preview size/page limits.
- GitHub: classic protection summaries, applicable branch rulesets, review decision and
  server merge state. Repository/ruleset-enabled merge, squash and rebase methods are
  filtered for linear history. Required merge queues expose only Add to merge queue,
  with ordinary priority and the expected source SHA. Queued is never shown as merged.
- GitLab: current user's merge eligibility and detailed merge status (pipelines,
  approvals, discussions and other server requirements); project merge and squash
  settings determine available actions. Commit statuses and the MR pipeline are shown.
  The client does not reconfigure project merge settings or schedule auto-merge.
- Azure: blocking policy evaluations and permitted merge strategies, merge-conflict
  status and commit CI. Completion pins lastMergeSourceCommit; policy bypass, work-item
  transitions and automatic source deletion are disabled. Rebase strategies explicitly
  explain that Azure rewrites the source. Accepted completion remains pending until the
  PR is confirmed completed. Existing auto-complete is displayed instead of resubmitted.
- Bitbucket Server: merge vetoes, configured built-in strategies, paged builds and a
  version-conditional merge. Native Git credentials and server permissions remain final.
  Bitbucket Cloud's API has no expected-source-SHA merge lease: checks remain visible,
  but merging directs users to Bitbucket instead of silently merging a newer source.
- A separate merge confirmation reviews the source, destination and selected method;
  an optional message persists locally. Every write re-fetches the full review proof,
  checks the same credential identity used for sending and pins the expected source
  SHA (or Bitbucket Server version). Policy bypass is never requested. These checks do
  not atomically freeze a destination branch against other server writers.
- A durable pending-result marker is saved before IPC, scoped to repository/API actor/PR
  across source updates. Closing/reopening cannot silently retry an uncertain request.
  Checking a result does not resend it. Queue/async acceptance is distinct from success;
  no local Git work or branch cleanup follows automatically.
- Source cleanup is a separate explicit review, available only for a server-confirmed
  merged PR in the same repository. Fork sources, default/destination branches, changed
  local/server tips, occupied local branches, ambiguous fetch mappings and separate push
  destinations are kept. Local Branch Manager protection rules apply to every deletion.
  GitHub/GitLab source protection is also inspected; native server authorization remains
  final for all providers. No automatic API branch deletion is bundled with merge.
- Choose local-only, remote-only or both. Deletion reuses existing comparison/force
  consent, reference recovery checkpoints, local CAS and remote exact-SHA leases.
  Squash integration is never treated as full commit reachability. A remote failure
  after local deletion reports partial completion and retains the deleted SHA checkpoint.
  No failed cleanup is retried automatically. Files and the index are preserved.
- Eight additional native scenarios extend the existing worktrees shard (128 total;
  all prior 120 remain). Headless renderer checks use mocked IPC; Rust loopback contracts
  separately exercise real provider HTTP requests and Git cleanup/lease failures.

Five planned stages remain after stage 15: Agent Workspace, Workflow Builder,
Automated PR Workflow, semantic diff/history tools and stacked branches.

## Stage 16 — Agent Workspace

- Dedicated task screen from the toolbar and command palette. Codex CLI and Claude
  Code argument presets, plus a custom stdin-driven CLI. The user selects a native
  executable and literal JSON argument array; no shell interpolation, downloading,
  hidden installation, implicit authentication or automatic task submission.
- Review title, full prompt, command, exact starting commit, unique new branch,
  worktree, portable CLI profile and timeout before explicit code/service consent.
  Changed executable/state/registration invalidates launch. A durable task ID prevents
  replay, including after a lost IPC response or closing/reopening the confirmation.
- Newly registered and locked worktrees default beside the executable, with an
  explicit alternative working-copy folder (e.g. when the app is inside this repo). CLI home,
  Codex/Claude config, XDG config/cache/data and temporary-directory variables point
  into portable profiles. Existing user credentials are not copied. Authenticate the
  installed CLI in that profile; provider subscriptions/login remain external.
- Live bounded stdout/stderr, elapsed time, exit code, cancellation, four-hour maximum
  timeout, portable persisted prompt/history/logs and operation-journal entries. Logs
  are checkpointed during execution. Process groups on Unix / Windows Job Objects
  terminate descendants on stop, timeout and normal completion. Poll and stop bypass
  the Git queue. Up to 100 history records; explicit forgetting retains all Git files.
- One agent per common repository, including linked worktrees and windows sharing
  this portable data directory;
  independent repositories can run concurrently. The app's common repository writer
  transaction remains held until the process tree stops, so other app reads/writes
  for that repository wait. An external IDE/CLI does not participate in that queue.
- After completion open the worktree and inspect changes using existing diff/commit
  tools. Worktree Manager handles explicit unlock/recovery-aware removal. No implicit
  commit, push, merge, branch deletion, worktree deletion or automatic retries.
- A worktree is working-file separation, not an OS security sandbox. CLI permissions,
  repository hooks/configuration and external tools can still affect shared Git refs
  or other files. The agent receives an instruction to leave edits uncommitted; this
  is not enforcement. CLI failures/auth problems remain visible rather than bypassing
  permissions. Executable fingerprints do not freeze scripts/config/models it loads.
- Unknown records after an unexpected app exit remain interrupted; Revqora cannot
  guarantee a Unix child was killed after a crash. New tasks and history deletion stay
  blocked until the user explicitly confirms those processes have stopped. Results
  remain unknown, never silently completed or replayed.
- Real offline CLI/Git tests cover source HEAD/index/file preservation, replay/stale
  rejection, portable environment, bounded output, cancellation, timeout and restart
  acknowledgement. Five new native UI scenarios retain the previous 128 (133 total)
  in the existing runner. No real AI account is required for automated verification.

Four stages remain after stage 16: Workflow Builder, Automated PR Workflow,
semantic diff/history tools and stacked branches.

## Stage 17 — Workflow Builder

- Toolbar and command-palette workspace with saved recipes, run history and step
  progress. Typed visual editor supports reordering, labels, conditions and
  per-command timeouts. Up to 50 recipes, 16 steps per recipe and 50 retained runs;
  explicit deletion/forgetting never removes branches, files, PRs or recovery data.
- Steps: require clean Git-visible files; require a branch; create/check out a new
  branch from an exact commit; cherry-pick exact non-merge commits; run a literal
  shell test/build command; publish an exact commit; create an ordinary PR using
  the selected API connection. No implicit merge, cleanup or force-history rewrite.
- New runs freeze a copy of the recipe and parameters. The user reviews each next
  step; every command, Git mutation and publication needs its own consent. No
  background rule runs a later step. Checks do not require mutation consent.
- Only whole structured Git fields expand the branch/base parameters. Commands and
  PR title/description remain literal. Arbitrary shell commands can change files,
  call services and execute tools; they are not a sandbox. Never put secrets in
  recipes: commands and their output are retained locally beside the executable.
- Conditions inspect current Git-visible clean/dirty status; false conditions stop
  or explicitly record a skip. Ignored files are outside the clean check. Branch
  checkout uses --no-overwrite-ignore; occupied/existing branch names are not reused.
  Cherry-pick conflicts stop with recovery retained; resolve/abort in existing tools.
- Publication checks physical history, rejects replace refs/grafts, requires one
  identical fetch/push URL and uses isolated command-scoped transport. It publishes
  the exact reviewed OID to one heads ref with an exact server-ref lease, disabling
  tag following and submodule pushes. No tracking configuration is changed. Fetch
  missing destination history with the individual Git tools before reviewing again.
- PR creation requires the current source commit already published on the selected
  remote and binds the API identity. It reuses provider validation and ordinary PR
  creation; no merge, policy bypass or branch cleanup follows. Server permissions
  remain final. Source observation and PR creation are optimistic where the provider
  cannot atomically pin the source; a concurrent server writer can still advance it.
- Per-common-repository execution uses the existing operation queue, plus a portable
  run lock across windows sharing this data folder. Poll/stop bypass the writer gate.
  Commands use the existing cancellable validation process tree and recovery snapshot;
  output in run history is bounded to 8 KiB per stream per step, with visible truncation.
- A durable running marker consumes the step before dispatch. Failed or interrupted
  actions are never retried automatically, including lost IPC responses and restarts.
  Unknown remote results or worker interruptions require checking Git/server state and
  explicit acknowledgement before another run. Acknowledgement abandons the record;
  it does not undo changes or claim success. Stop cancels command process trees; Git
  and HTTP steps stop after the current action, without unsafe partial interruption.
- Definitions use revision-conditional writes. Native JSON readers/writers share an
  8 MiB serialized limit, including escaped output; records/settings/logs/temp stay in
  portable data. An external IDE/CLI does not participate in the app operation queue.
- Six native scenarios extend the worktrees shard (139 total, retaining the prior 133).
  Headless React checks exercise the editor/reviews with mocked IPC and real offline
  commands; real Rust/Git tests separately check stale/replay guards, conflicts,
  ignored-file preservation, conditional non-execution, cancellation and publication.

Three stages remain: Automated PR Workflow, semantic diff/history tools and stacked
branches. Automated agent-review/CI rules belong to stage 18; no such automation is
silently enabled by a saved recipe.
