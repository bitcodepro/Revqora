# Revqora desktop performance

## Baseline for PR #60

Measured on Windows x64 with Git 2.45.1.windows.1 and the Windows native smoke build for commit `e6a4b1d` from [CI run 43477914539](https://github.com/bitcodepro/Revqora/actions/runs/43477914539). The fixture had 5,275 commits, a main branch of 5,075 commits, a 200-commit topic fork, 32 extra local refs and 33 remote-tracking refs. Each commit edited one small text file. This captures process and IPC overhead on a small, mostly linear history. Wide merge graphs, large diffs and the user's 41-repository workspace need separate measurements.

Commands were timed from WebView2 through Tauri IPC, including response decoding. Direct Git timings include spawning Git for Windows. Repeated results use the median and observed range. The OS filesystem cache was left in its normal state. Cold search means a miss in the application's search cache. These measurements are a baseline, with no performance thresholds in CI.

| Scenario | Median | Observed range |
| --- | ---: | ---: |
| Switch between branch context and HEAD, first 200 rows prepared (8 requests) | 544 ms | 441–789 ms |
| Reload the same HEAD scope, 200 rows | 540 ms | 411–703 ms |
| All branches, prepare 200 rows (3 requests) | 437 ms | 405–458 ms |
| All branches, prepare all 5,275 rows (3 requests) | 436 ms | 402–476 ms |
| Branch and ref snapshot | 365 ms | 327–393 ms |
| Full working-tree status | 681 ms | 601–1,033 ms |
| Open commit metadata and changed-file list | 279 ms | 266–319 ms |
| Load one small committed-file diff | 78 ms | 73–138 ms |
| History message search with the full graph already loaded | 136 ms | 126–148 ms |
| Search all repositories, one repository, All mode (`825`) | 267 ms | 253–347 ms |
| Search all repositories, one repository, Message mode (`PERF-825`) | 221 ms | 192–273 ms |
| Direct Git message search for the same `PERF-825` match | 132 ms | 119–178 ms |

Two UI samples reached the first commit rows in 2.78 and 3.55 s from launch, including WebView2 startup and Playwright attachment. Dispatching a commit selection to a visible row then took 0.95–0.96 s to show the title and 0.96–0.97 s to show the first file's diff. These are individual samples during startup, when other reads can still be in flight. The command-level timings above are more repeatable.

Message search returned the same SHA as direct Git. All mode found the expected message match plus five SHA-prefix matches for `825`. The global All-mode command missed a token found only in a commit body, while the paginated MCP backend command found it. Message, author and hash matching should keep their current semantics when sharing the search implementation.

| Paginated search backend, excluding MCP stdio and desktop bridge | Cold | Warm median (4 repeats) | Cold refs / log | Warm refs median |
| --- | ---: | ---: | ---: | ---: |
| All mode, body-only token | 313 ms | 89 ms | 90 / 211 ms | 84 ms |
| Author by email, first page of 100 | 278 ms | 93 ms | 91 / 180 ms | 87 ms |

All repeated page requests hit the cache. Queue time reported by the backend was 0–1 ms. Direct Git's author search returned all 310 matches in a median of 111 ms. The paginated backend timed only the first 100, so compare complete searches separately.

In a separate sweep, eight local copies of the fixture returned the same 48 hits in each run. With two concurrent requests, the median first result was 262 ms and all repositories completed in 1,147 ms. With four concurrent requests, the median first result was 339 ms and completion fell to 716 ms. Each concurrency setting ran three times, excluding the dialog's debounce and rendering. Higher concurrency improved throughput and delayed the first result in this fixture.

In that run, standalone Git took a median of 102 ms to count the 5,075 HEAD commits and 90 ms to check remote containment for the tip. These include the Git process startup and were measured separately from the app commands.

## Work to prioritize

The Windows audit follow-up moves the exact history count out of first-page loading and accepts the result only for the graph that requested it. It also bounds each automatic fetch to 30 seconds, retries failed watcher subscriptions, restores local-only labels beyond 5,000 commits, includes full message bodies in global All search, and makes the truncation warning visible in every diff layout. The baseline above predates these changes.

On a 60,000-commit synthetic history in the Windows debug build, the median time for `graph_load` to return its first 200 rows fell from 1,656 ms with synchronous counting to 977 ms with deferred counting (41%). Both settings used the same build, with six alternating branch loads per setting and a local Vite frontend. All exact totals matched the selected scope. The separate count still took 666 ms by median. The timer measured the IPC response and excluded rendering. Global All and Message search both found the same SHA for a body-only token, matching direct Git.

The read-path follow-up changes the items below as marked. It was verified with Rust integration tests on temporary repositories (`src-tauri/tests/read_paths.rs`, `src-tauri/tests/commit_details.rs`) and store tests. No timings were taken for it: the baseline table above still describes the earlier build, and the process counts below come from reading the code.

- `commit_details` can return the header and file list without the `for-each-ref --contains` walk. The preview asks for containment in a separate `commit_remote_containment` read, cached by repository, commit and remote-ref snapshot.
- One history build starts 3 fewer Git processes, or 2 fewer while HEAD is unborn: refs are enumerated once for the snapshot and the labels, and HEAD is resolved once. It also skips the local-only `rev-list` while the ref snapshot is unchanged.
- A full status still runs the same reads for its state token. After `git status` they run side by side, and the worktree's Git directory is resolved once instead of twice. With no Git operation in progress, `repo_info` uses 3 Git processes instead of 5.

The speed follow-up of November 2026 adds a recent-branch cache, shares one paged path for global search and adds opt-in stage timings. Its numbers come from Rust only: a temporary `cargo test` harness called the backend functions directly in the Windows debug build, on a `scripts/make-big-repo.py` fixture (60,000 generated commits, 60,639 commits reachable from all refs, 679 local branches, no remote). They exclude IPC, the WebView and rendering, and were not taken through `scripts/ui-driver.mjs`. Medians are over 6 warm samples (5 for search) after one cold round. "Before" was measured on the same fixture before the change.

| Read (debug build, backend only) | Before | After |
|---|---|---|
| Return to `main` (59,337 rows) after viewing a topic branch | 1,885 ms | 347 ms (recent build returned unchanged) |
| Return to a topic branch (1,073 rows) | 277 ms | 246 ms (ref resolution dominates) |
| Global All, first page, 3 queries | 1,047–1,162 ms (31 hits at most) | 1,226–1,239 ms (30 hits, then a cursor) |
| Global Hash, first page | 1,037 ms | 1,108 ms |
| Global Message, first page | 182 ms | 253 ms |

A cold `main` build split into ref resolution 186 ms, Git walk 1,086 ms, local-only marks 60 ms (parallel with the walk), lane layout 415 ms and decorations plus rows 168 ms (1,855 ms in all). A topic-branch build took 276 ms, 186 ms of it for ref resolution. Full status took 84 ms for `git status` and 160 ms for state tokens. `refs_snapshot` took 54 ms for remotes, 328 ms for enumeration with upstream tracking, 101 ms for parsing and branch-creator resolution, 54 ms for stashes and 53 ms for the identity. Upstream comparison did not run because the fixture has no remote.

A global search page now costs about as much as the old single call, slightly more because the cursor scope reads `show-ref` and the call takes the repository read lock. The old call stopped at 31 hits. Each "Show more matches" request repeats a Git walk with `--skip`, so loading many pages stays slow: 7 calls for 549 hits of `#100` took 6,991 ms. The 320 ms debounce and the concurrency of 2 are unchanged, because no workspace-wide sweep with UI latency was measured. First-hit time across a multi-repository workspace was not measured either.

1. **Make the first history page independent of the total.** The UI already requests 200 commits. `graph_load` still waits for `commit_count`, which can run a separate `git rev-list --count` on the entire scope. Publish the first usable rows and branch highlight as soon as they are ready, then compute and cache the exact total by the same history scope and pinned tip SHAs. Keep the total optional while it is being calculated and discard a late total if the graph key changed. Time ref resolution, Git walk, decorations, lane layout, exact count and first visible rows separately. On this fixture, 200 rows and 5,275 rows took roughly the same time in All branches, so reducing the page size alone is unlikely to help.
   *Status: the deferred count is done (see above). An identical history request now keeps the known total. Per-stage timing is done: every `graph_load` answer carries `stages` (ref resolution, Git walk, local-only, lane layout, decorations and rows, and exact count when counted). With `REVQORA_STAGE_TIMINGS=<file>` set, `graph_load`, `graph_commit_count`, `status` and `refs_snapshot` append one JSON line each to that local file. First visible rows are not timed in the WebView. A total cache keyed by scope and tips is open.*
2. **Reuse branch history across switches.** `loadGraph` serializes builds per repo, and the backend keeps one graph per repo. An obsolete in-flight build can delay a new selection. A bounded cache keyed by repository, branch scope, tips and display options would let a recently visited branch appear quickly. Start by reusing stable ref data and skipping identical graph requests. Keep the existing graph-key checks so late pages and background refreshes cannot replace the active branch's rows. Clicking a branch should still show its history context without opening a commit.
   *Status: partly done. `graph_load` returns the previous build with the same key when refs, labels, scope, window and display options are unchanged, and the UI then keeps its loaded rows. A build for another scope reuses the local-only set of the same ref snapshot. A new selection starts beside one obsolete build: each request carries an increasing number, the backend stores only the newest request's graph, and at most two builds run per repository. The bounded recent-branch cache is done: up to 6 builds per repository and 200,000 rows in all, keyed by repository, branch or branch context, worktree row, incoming option and window. A recent build is returned unchanged, with its key, only while refs, labels, HEAD, tips, replace refs, the shallow boundary and grafts all still match. Otherwise it is the starting point for reuse and a new key is produced. The build-order checks still decide which build becomes active. An obsolete Git walk is still not cancelled.*
3. **Search history without constructing a full graph first.** `GraphView` currently awaits `loadEntireHistory` before calling `graph_search`. Query Git or the search backend for matching SHAs in the active history scope, then resolve positions on demand for navigation. Keep cursor validity tied to the search scope and refs. Test matches beyond the first page, an inactive branch, a tag, and a body-only token. Scrolling should keep loading history in pages and search should continue to cover the full selected scope.
   *Status: already in place before this follow-up. `GraphView` calls `history_search` for the active scope and no longer loads the entire history first. Only the last-commit shortcut still does.*
4. **Shorten global search and make the two All modes consistent.** The global dialog waits 320 ms after typing, schedules two repositories at a time, and waits for already-running calls before starting a replacement search. Its backend reads up to 150,000 log records in All/Hash mode and filters them in Rust. Measure both time to first hit and time to complete across a representative workspace. Prioritize the active repo, cancel obsolete reads where practical, and share the paginated search path so All includes full commit bodies and can report more results. Preserve per-repository newest-first ordering, the author/email and SHA matching rules, and incremental rendering. For repeated MCP searches, ref validation accounts for most warm latency. Consider reusing a validated ref snapshot only if external fetch, tag/ref edits, detached HEAD and shallow history changes still invalidate it correctly.
   *Status: mostly done. The dialog and MCP share one paged implementation with full bodies in All mode. The dialog shows 30 matches per repository and offers "Show more matches" while a cursor remains. The active repository is searched first. A new query no longer waits for running calls: obsolete searches start no further requests and their late answers are discarded. Running Git processes are not killed. The debounce, the concurrency and ref-snapshot reuse are unchanged.*
5. **Open commit files before optional remote metadata.** `commit_details` reads the commit and the file list, then waits for `for-each-ref --contains` before returning. The first file's diff starts after details arrive. Measure those stages on small edits, large renames, merge commits and older commits. Return the header and file list early, then fill in remote containment asynchronously. Use an explicit unknown state so actions that depend on remote containment can wait for a fresh answer. The UI already caches immutable commit details and diffs by SHA. Keep invalidation when attributes or relevant refs change.
   *Status: done, except the stage measurements. Containment is `null` (unknown) in the early answer. The preview shows "checking…" until the separate read answers, and "unknown" if it fails. The Actions menu waits for that answer before it states whether the commit is pushed. MCP `commit_details` and the other callers still get containment in one answer.*
6. **Keep repository switching cheap.** Measure cached activation separately from background refresh. Publish cached sidebar and branch data immediately and deduplicate pending status, refs and graph reads. Limit background hydration so switching to a repository does not compete with a sweep of inactive repositories. Keep full status and its state token on paths that guard mutations. For refs, measure enumeration, upstream comparisons and branch creator resolution before changing their schedule. Verify that My Branches, Primary Branch and outgoing/incoming indicators still update after changes made outside Revqora.
   *Status: partly done. Selecting a repository while a full read of the same parts is running or queued joins that read instead of queueing another status, refs, layers and extras pass. Change notifications, explicit refreshes and a missing history still get their own read. Status and repository reads use fewer or parallel Git processes (see above). Separate measurements of cached activation, refs stages and the hydration limit are open.*

## Speed-up of November 2026 (fewer Git processes, Git's own caches)

Starting Git for Windows costs about 60 ms per process on the measurement machine, before it does any work, and several processes started at once slow each other down. Most of this follow-up therefore removes Git processes from the paths the user waits for, and lets Git use its own acceleration data:

- **Background housekeeping** (`git/optimize.rs`). When history loads (at most every 10 minutes per repository, 8 seconds after the trigger) and after a fetch or pull, an incremental commit-graph with changed-path filters is written, and more than 100 loose refs are packed. Git processes for it run at below-normal priority. Measured with direct Git on the fixture below: the first 200 rows of all branches took 773 ms before and 178 ms with packed refs plus commit-graph; `rev-list --count` 744 → 133 ms; a path search 2,285 → 1,162 ms; `for-each-ref --no-merged` 618 → 215 ms; listing all refs 321 → 110 ms.
- **Configuration answers are remembered** (`git/config_cache.rs`): `remote -v`, `var GIT_ATTR_GLOBAL`/`GIT_ATTR_SYSTEM`, `config --get` (identity) and `remote`. An answer is reused only while every configuration file Git reports with `--show-origin` (plus the default global locations, `config.worktree` and HEAD) keeps its size and modification time, and any writing Git command started by Revqora clears them. The Git directory and the common directory are remembered per folder.
- **Ref metadata is remembered per ref target** (`refs::enumerate`). Subjects, authors, dates and ahead/behind counts depend only on the ref's target, its symbolic target, its upstream and the upstream's target. A refresh lists names and targets, and reads metadata only for refs that changed (by name, up to 100) or all of them. A test compares the result with a full `for-each-ref` after every kind of ref change.
- **Batched and parallel reads.** Squash-merge detection uses one `for-each-ref --no-merged=HEAD` and one `merge-tree --stdin` instead of up to 160 processes (older Git keeps the per-branch fallback). The branch card uses one `rev-list --left-right --count` and one range `log`, side by side with the other reads (8 processes in a row before). Refs snapshot reads (remotes, refs, stashes, identity), the graph's ref list and HEAD, and HEAD's branch and commit run in parallel. An idle bisect no longer starts 2 processes per extras refresh. The commit note is requested together with the commit header, and `notes show` / `commit-graph write` no longer take the repository's write lock.

Measured through the app on a `scripts/make-big-repo.py` fixture (60,000 commits, 679 local branches, 1,500 extra loose tags, no commit-graph, no packed refs) with `scripts/perf-probe.mjs` and a click probe. Both builds were optimized dev builds with the same frontend, alternated three times on fresh copies of the fixture. "After" was measured once on the fresh copy and once after the app had stayed open for 25 seconds (housekeeping done). Another Rust build was running on the machine, so the ranges are wide.

| Through the app (median, range) | Before | After, first open | After, housekeeping done |
| --- | ---: | ---: | ---: |
| `refs_snapshot` | 1,240 ms (1,016–1,504) | 699 ms (591–752) | 497 ms (446–539) |
| Full `graph_load` of 60,639 rows | 3,100 ms (2,257–3,625) | 3,187 ms (2,582–3,260) | 2,665 ms (2,138–2,792) |
| Click a commit, header and files shown | 1,006 ms (961–1,023) | — | 444 ms (440–467) |
| Click the next commit | 490 ms (425–659) | — | 329 ms (292–367) |
| `status` | 604 ms (504–724) | 577 ms (541–631) | 527 ms (485–535) |

Launch to the first visible rows varied with WebView2 startup by more than the change (3.2–4.0 s for both builds), so it is not reported as a gain. A first run without the 8-second delay showed that housekeeping competing with the first full history load more than doubled it; the delay and the lower priority removed that.

## Pull requests over Git credentials (November 2026)

Without an API account, Revqora reads the token from Git (`git credential fill`). With Git Credential Manager on Windows that took about 1.9 s per lookup, and every PR request did one, because the token is part of the connection revision. Bitbucket also returns shortened commit IDs, so each PR read asked for both full IDs again.

- **The Git credential is reused for 60 s** per repository and remote URL (`forge::cached_token`). A 401, a newly typed Git credential and **Forget saved Git tokens** drop it. A token changed outside Revqora shows as a changed connection once the minute has passed.
- **Resolved Bitbucket commit IDs are remembered** for the session (`pr_center::resolve_bitbucket_oid`).

Measured on a Bitbucket Cloud test repository with `src-tauri/tests/pr_live_timing.rs` (debug build, warm second round):

| Request | Before | After |
| --- | ---: | ---: |
| PR list (`page`) | 4.0–4.9 s | 0.47 s |
| Open a PR (`detail`) | 8.7–9.0 s | 0.46 s |
| CI checks | 10.6–11.2 s | 0.74 s |
| Changed files | 8.5–21.9 s | 0.47 s |

The first request after the app starts still waits once for Git Credential Manager. Run the probe against another repository with:

```
REVQORA_LIVE_PR_REPO=<path> cargo test --test pr_live_timing -- --ignored --nocapture
```

Further changes in the same pass:

- **One HTTP agent for every API read.** All provider `GET`s share one keep-alive connection pool (`forge_accounts::READS`), so a PR does not pay a new TLS handshake for each of its reads.
- **Merge readiness reads run side by side.** GitHub's repository, branch rules, GraphQL readiness, check runs and commit statuses are fetched in parallel, together with the merge identity (about six sequential round trips before).
- **PR reads are shared in the UI** (`src/lib/prCache.ts`). Identical reads in flight share one request. Review capabilities are reused for 30 s, CI checks for 15 s and files of one PR revision for 5 min. Discussion pages are always asked again, so a PR changed on the server is reported when Discussions opens. Every PR write, account change and explicit refresh forgets them.
- **Refreshing keeps the screen.** **Refresh pull requests** and **⟳** keep the list and the open PR visible while the new data loads. Reopening a list shows its last first page at once, then replaces it. When a background list poll sees a new push or state for the open PR, the detail reloads.
- **Merge readiness polls only where it is shown**: an open PR with **Overview** visible. Other sections keep the last result.
- **All repositories** filters **My pull requests** from the scanned rows, so switching the filter or editing repository groups does not rescan every repository.
- **GitHub mergeability**: `UNKNOWN` (GitHub has not finished its background check after a push) is reported as "still checking", not as a conflict.

## Fetch, Pull and Push (November 2026)

`src-tauri/tests/remote_ops_timing.rs` times the app's operations against a local remote, so the network does not hide Revqora's own work (400 remote branches, 40 untracked files, debug test build). Set `REVQORA_TIMING_DETAIL=1` to list every Git process in start order.

```
cargo test --test remote_ops_timing -- --ignored --nocapture
```

| Operation | Plain Git | Before | After |
| --- | ---: | ---: | ---: |
| Fetch all | 0.45 s, 4 processes | 1.2 s, 11 | 0.9 s, 8 |
| Background fetch | — | 1.3 s, 11 | 0.65 s, 5 |
| Pull (one new commit) | — | 7.4 s, 74 | 5.5 s, 61 |
| Push (one new commit) | 0.76 s, 7 | 3.1 s, 31 | 2.3 s, 25 |

Each Git process costs 70–100 ms on Windows, so the changes remove processes:

- **Configuration answers survive writes that cannot change configuration** (`runner::keeps_configuration`). Every writing command used to clear the configuration cache, so a pull re-read `config --list`, `var GIT_ATTR_*` and remote settings after each `update-ref`, `fetch` or `merge`.
- **Remote and refspec reads use the configuration cache** in fetch pruning, the transport protection and pull.
- **A status read starts its index, ref and attribute reads alongside `git status`** instead of after it.
- **One refresh after an operation.** Fetch, Pull and Push now wait for the refresh the operation's completion event started, instead of queuing a second full refresh with history, refs and squash annotations behind it.
- **Revqora's credential helper is asked first** when it holds a token for the repository (see [Accounts](wiki/Accounts-and-providers.md)). Git Credential Manager took about 1.3 s per request when it had nothing for the host, on every network command and before Revqora's helper.

Pull and Push still create a recovery checkpoint and verify the working copy several times (about seven status reads per pull); those are data-safety checks and stay.

### Waiting on the remote no longer blocks reads

Every writing operation holds a repository lock so two app actions cannot change the same repository at once. It used to hold the lock exclusively for the whole operation, including the time Git waited on the server. A slow remote therefore froze History, Changes and status for that repository, up to the 30-second limit of an automatic fetch.

Now `fetch`, `push` and `ls-remote` inside a writing operation run in a *network section* (`operations::network`, applied by the runner):

- The writer keeps its FIFO turn, so no other writer can start before it finishes. Git's ref updates at the end of a fetch or push never interleave with a commit, checkout or another fetch from the app.
- The lock is downgraded to shared while Git waits, so reads run.
- The writer takes the lock exclusively again before its next local step (Pull's merge or rebase and checks), also when a step panics.
- A state token read during the network wait may describe the refs before the update. An action prepared from it is refused as stale afterwards instead of applied.
- An automatic fetch skips the round when another writer is running or queued (`repository-busy`) instead of queueing in front of the user's action.

`src-tauri/tests/repository_concurrency.rs` covers this with a local remote whose upload-pack and receive-pack first sleep: reads during Fetch, Pull, Push and Auto-fetch; FIFO order of waiting writers; stale tokens; exclusive local steps; panic recovery; nested and parallel network sections; timed-out automatic fetches; and an automatic fetch racing a Pull. Turning the downgrade off makes the read tests fail with "reads waited for the network".

## Repeat the baseline

- Use the same Windows build, the same fixture and one new portable profile per launch. Run startup and navigation separately from search sweeps. Record first visible graph rows, branch highlight, commit header, first diff, first search hit and complete results. Capture at least 20 samples per interaction on a real repository before setting a p95 target.
- For the synthetic fixture, make a linear main branch of 5,075 one-file commits. Fork 200 commits from main commit 4,800. Put a unique subject token at commit 800, a body-only token at commit 810, and give every 17th commit the same author email. Create refs at regular intervals and point a remote-tracking branch to the parent of main. A single `git fast-import` makes the fixture inexpensive to regenerate.
- Use `scripts/ui-driver.mjs` to launch the native smoke build and time the same commands through `window.__TAURI_INTERNALS__.invoke`. Run `graph_load` with limit 200 and the full count, alternate `HEAD` and the topic branch context, and measure `commit_details`, `rev_diff`, `graph_search`, `repository_commit_search` and `repository_commit_search_page` independently. Compare SHAs from equivalent modes and follow every cursor before comparing complete result sets.
- For direct Git, use `git log --branches --remotes --tags HEAD --fixed-strings --regexp-ignore-case --grep=PERF-825 --format=%H`. Replace `--grep` with `--author` for the email query. Use the same refs and query each time. Record application cache state separately from the OS cache, and collect a full MCP-client timing separately from the WebView-to-backend timing.
- Include a large merge-heavy history, a commit touching hundreds of files, and a workspace with about 40 repositories in the next baseline. For parallel search, compare first result, completion and foreground UI latency together before changing concurrency.
