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

1. **Make the first history page independent of the total.** The UI already requests 200 commits. `graph_load` still waits for `commit_count`, which can run a separate `git rev-list --count` on the entire scope. Publish the first usable rows and branch highlight as soon as they are ready, then compute and cache the exact total by the same history scope and pinned tip SHAs. Keep the total optional while it is being calculated and discard a late total if the graph key changed. Time ref resolution, Git walk, decorations, lane layout, exact count and first visible rows separately. On this fixture, 200 rows and 5,275 rows took roughly the same time in All branches, so reducing the page size alone is unlikely to help.
2. **Reuse branch history across switches.** `loadGraph` serializes builds per repo, and the backend keeps one graph per repo. An obsolete in-flight build can delay a new selection. A bounded cache keyed by repository, branch scope, tips and display options would let a recently visited branch appear quickly. Start by reusing stable ref data and skipping identical graph requests. Keep the existing graph-key checks so late pages and background refreshes cannot replace the active branch's rows. Clicking a branch should still show its history context without opening a commit.
3. **Search history without constructing a full graph first.** `GraphView` currently awaits `loadEntireHistory` before calling `graph_search`. Query Git or the search backend for matching SHAs in the active history scope, then resolve positions on demand for navigation. Keep cursor validity tied to the search scope and refs. Test matches beyond the first page, an inactive branch, a tag, and a body-only token. Scrolling should keep loading history in pages and search should continue to cover the full selected scope.
4. **Shorten global search and make the two All modes consistent.** The global dialog waits 320 ms after typing, schedules two repositories at a time, and waits for already-running calls before starting a replacement search. Its backend reads up to 150,000 log records in All/Hash mode and filters them in Rust. Measure both time to first hit and time to complete across a representative workspace. Prioritize the active repo, cancel obsolete reads where practical, and share the paginated search path so All includes full commit bodies and can report more results. Preserve per-repository newest-first ordering, the author/email and SHA matching rules, and incremental rendering. For repeated MCP searches, ref validation accounts for most warm latency. Consider reusing a validated ref snapshot only if external fetch, tag/ref edits, detached HEAD and shallow history changes still invalidate it correctly.
5. **Open commit files before optional remote metadata.** `commit_details` reads the commit and the file list, then waits for `for-each-ref --contains` before returning. The first file's diff starts after details arrive. Measure those stages on small edits, large renames, merge commits and older commits. Return the header and file list early, then fill in remote containment asynchronously. Use an explicit unknown state so actions that depend on remote containment can wait for a fresh answer. The UI already caches immutable commit details and diffs by SHA. Keep invalidation when attributes or relevant refs change.
6. **Keep repository switching cheap.** Measure cached activation separately from background refresh. Publish cached sidebar and branch data immediately and deduplicate pending status, refs and graph reads. Limit background hydration so switching to a repository does not compete with a sweep of inactive repositories. Keep full status and its state token on paths that guard mutations. For refs, measure enumeration, upstream comparisons and branch creator resolution before changing their schedule. Verify that My Branches, Primary Branch and outgoing/incoming indicators still update after changes made outside Revqora.

## Repeat the baseline

- Use the same Windows build, the same fixture and one new portable profile per launch. Run startup and navigation separately from search sweeps. Record first visible graph rows, branch highlight, commit header, first diff, first search hit and complete results. Capture at least 20 samples per interaction on a real repository before setting a p95 target.
- For the synthetic fixture, make a linear main branch of 5,075 one-file commits. Fork 200 commits from main commit 4,800. Put a unique subject token at commit 800, a body-only token at commit 810, and give every 17th commit the same author email. Create refs at regular intervals and point a remote-tracking branch to the parent of main. A single `git fast-import` makes the fixture inexpensive to regenerate.
- Use `scripts/ui-driver.mjs` to launch the native smoke build and time the same commands through `window.__TAURI_INTERNALS__.invoke`. Run `graph_load` with limit 200 and the full count, alternate `HEAD` and the topic branch context, and measure `commit_details`, `rev_diff`, `graph_search`, `repository_commit_search` and `repository_commit_search_page` independently. Compare SHAs from equivalent modes and follow every cursor before comparing complete result sets.
- For direct Git, use `git log --branches --remotes --tags HEAD --fixed-strings --regexp-ignore-case --grep=PERF-825 --format=%H`. Replace `--grep` with `--author` for the email query. Use the same refs and query each time. Record application cache state separately from the OS cache, and collect a full MCP-client timing separately from the WebView-to-backend timing.
- Include a large merge-heavy history, a commit touching hundreds of files, and a workspace with about 40 repositories in the next baseline. For parallel search, compare first result, completion and foreground UI latency together before changing concurrency.
