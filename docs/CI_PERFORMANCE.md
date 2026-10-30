# CI performance

The native suite uses real WebView2, real Git repositories, exact reference/index
assertions and recovery checks. Performance changes must preserve those assertions
and scenario-level timeouts. A missing, failed or cancelled suite is not a pass.

## Measured baseline

Run [41052963280](https://github.com/bitcodepro/Revqora/actions/runs/41052963280),
Windows job 124053853565, commit `7d9d5a9`, cold runner. Times below are derived
from timestamped job logs; the UI suite was cancelled, so its duration is partial.

| Phase | UTC start/end | Elapsed |
| --- | --- | ---: |
| Runner setup, checkout, Node/Rust/npm, WebView2 | 12:08:36–12:09:14 | 38s |
| Debug host compilation and transport probe | 12:09:14–12:12:45 | 211s |
| Repeated helper/core/frontend verification | 12:12:45–12:21:40 | 535s |
| Release build and portable ZIP | 12:21:40–12:32:47 | 667s |
| Native startup and scenarios 1–80; then cancellation | 12:32:47–12:53:43 | 1256s |

The same core checks also run in the required Windows quick job. The native job
previously compiled a debug host solely to probe transport before compiling a
release host. Both costs sat on the native critical path.

Largest intervals between scenario completion messages were 38 (branch deletion,
243s), 40 (20 repositories, 88s), 80 (aliased upstream protection, 82s), 79
(standard upstream protection, 65s), 43 (dark theme, 62s), and 39 (deletion recovery,
54s). These intervals can include fixture preparation between cases; they are
not exact scenario durations. The new instrumentation measures case bodies.

Case 43 had a specific avoidable wait: it read an absent Changes input while
History was active, waited the 60s action timeout, then swallowed the exception.
It now switches to Changes, waits for the actual summary field and requires an
empty value before testing the theme. Other fixed waits used for debounce/race
assertions remain; they do not account for the multi-minute bottleneck.

## Execution structure

1. Required quick checks run on Windows, Linux and macOS as before. The Windows
   matrix job also retains clippy/all-targets and Rust tests with `ui-automation`
   enabled, outside the native critical path. Both Rust feature configurations
   remain checked; moving them does not drop the former full job's checks.
2. `windows-native-build` runs `verify --build-only`: one release build, portable
   ZIP and a transport probe using that release executable. No debug host is
   built. The ZIP's SHA-256 is passed to every consumer; consumers verify it
   before extracting. No native executable is cached between commits.
3. Three independent `windows-smoke` jobs use that exact build, separate runners,
   temporary directories, Git repositories, CDP ports and portable profiles:
   core (1–71), workspace/branch manager (72–80), cleanup (81–86). Core retains
   the fresh-profile preference replay/storage-readiness boundary. Tail suites
   create their own state instead of depending on core's mutated repositories.
4. All six cleanup scenarios run unchanged, including exclusions, mixed deletion
   and recovery, protection/consent, server-only stale preflight, fetched local
   staleness and partial server rejection. Coverage checks reject missing or
   extra scenario counts. Fail-fast is disabled across the native matrix.
5. Read-only version selection waits only for release-tooling tests, so all five
   production packages build alongside quick/native verification, followed by the
   existing downloaded-package verifier. Production packages still omit the
   automation feature. Publishing requires the complete native matrix, all
   quick checks and verified packages.

Download caches are disabled after a measured cache-service egress failure
(see below). npm/crates are fetched normally. The built native ZIP is reused only
inside the same workflow, with its exact SHA-256. Application data and recovery
payloads are never cached. The overall 45-minute timeout was not increased: the build job has
25 minutes and each native suite has 30 minutes. This separates budgets and
removes repeated/serial work; it does not establish a measured speedup by itself.

## First measured optimized run

Run [41061754285](https://github.com/bitcodepro/Revqora/actions/runs/41061754285)
at `7b5f6f9` passed every check, all 86 native scenarios and all five downloaded
archive/checksum pairs. The complete Windows build/native gate took 30m16s from
its first job start, compared with cancellation at about 45m after case 80 in the
baseline. Core execution took 998.56s; workspace 166.72s; cleanup 182.77s.
The fixed dark-theme case took 3.09s. Core's five launches totalled 6.08s,
69 screenshots 10.18s and 410 CLI verification commands 43.72s. The largest cases
were branch deletion 239.34s, 20 repositories 112.14s and deletion recovery 57.49s.

The entire workflow, including packages, took 45m30s. This is distinct from the
Windows gate. Intel macOS setup-node took 10m02s: Node was already in the runner's
tool cache, but npm-cache restoration emitted `Egress is over the account limit`
and the step continued only later. Compilation itself then took 11m21s. Package
jobs also waited for the 22m33s Windows quick/feature job before starting.

The follow-up disables optional npm/Cargo download caches rather than relying on
an unavailable cache service, and starts read-only version selection/package
builds alongside the required quick/native checks. Neither change bypasses any
publication gate or modifies a test assertion. Successful final-head CI is still
required; this first run does not establish the follow-up's achieved runtime.

## Measurements on new runs

`verify` reports each stage immediately and writes build timing JSON to
`windows-native-build-timings`. Build and native jobs also record preparation
time (checkout, tools, dependencies, runtime/artifact setup) before starting
compilation/scenarios. Runner provisioning remains visible in GitHub's job timing.
Each native suite uploads `ui-smoke-<suite>` even
on failure, containing screenshots and `timings.json`. The JSON is updated after
each scenario, startup/shutdown and screenshot, retaining partial results.
Summaries show the slowest stages/cases plus process-call, screenshot and app
startup/shutdown totals. Process arguments and credentials are not recorded.
Nested timings overlap and must not be summed to calculate total runtime.

Compare end-to-end workflow time and runner minutes separately. Parallel jobs
reduce latency but can increase total runner usage. Use actual setup/build/native
and package timings from the final-head run before claiming an achieved speedup.
The cold release compiler remains on the critical path; further compilation-cache
work should be driven by those measurements and preserve feature/profile isolation.

`npm run verify` still runs the complete local sequence by default. `--quick`
skips build/native tests; `--build-only` is only the CI producer and is not a
replacement for verification. Native windows must not be launched locally while
the user is testing the app.
