# Windows agent launch diagnosis — PR #24

The cause of the historical `Access is denied (os error 5)` failure is **not yet
established**. A passing repetition is not evidence that the failure was random
or that its cause has been fixed.

Historical evidence: commit `86072242f0090a8ceaa902a28af02a57278d620e`,
[Windows job 124842010384](https://github.com/bitcodepro/Revqora/actions/runs/41304498734/job/124842010384),
`explicit_worktree_destination_is_reviewed_and_nested_locations_are_rejected`.
The task became failed instead of completed. The log retained only the generic
I/O error, so it cannot distinguish worktree/file operations from process startup.
The ordinary configuration passed; the automation configuration failed. The old
log does not justify assigning this to any particular Win32 API, antivirus rule,
permission, Git operation or scheduling race.

## Diagnostic changes

- `runner.rs` retains the original native OS code in `GitError.details`. It stays
  separate from `GitError.code`, which continues to mean the Git exit code.
- `agents.rs` attaches operation names and escaped paths to worktree creation,
  inspection, head verification and locking; executable verification; record
  creation/write/sync/persistence; portable-directory setup; temporary stdin
  creation/write/flush/rewind/handle cloning; process spawn/poll/wait; periodic and
  final state saves. A final save failure no longer hides the primary error.
- Windows `process_tree::spawn` distinguishes CreateJobObjectW,
  SetInformationJobObject, Command::spawn, AssignProcessToJobObject,
  CreateToolhelp32Snapshot, Thread32First/Next, OpenThread and ResumeThread.
  Native errors are captured before handle cleanup. Handle cleanup remains RAII;
  a suspended child is still killed and waited on after setup failure.
- Test failure snapshots whitelist task ID, phase, exit code, detailed error,
  bounded fixture stdout/stderr, expected/actual paths, registration and state-file
  presence. Filesystem probes distinguish missing paths from denied inspection.
  Task/Request/Command debug dumps, prompts, argument lists and environment dumps
  are deliberately excluded. Regression tests use private sentinel strings to
  verify this boundary.

`CREATE_SUSPENDED`, `CREATE_NO_WINDOW`, kill-on-job-close,
`THREAD_SUSPEND_RESUME`, and existing termination/wait cleanup are retained.
No extra access rights, elevation, timeout increases, skipped assertions, automatic
retries or breakaway flags are introduced. The quoting correction is unchanged.

The error-capture rule follows the Win32 contracts for
[OpenThread](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openthread)
and [ResumeThread](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread):
read the failure code before another API can replace it.

## Reproduction experiment

Run from the repository after setting `REVQORA_TEST_TMP`, `TEMP`, `TMP` and
`TMPDIR` to the same dedicated task directory:

```powershell
node scripts/agent-windows-diagnostics.mjs --out D:\task\logs\agent-matrix
```

The script builds both lib-test executables sequentially and resolves their exact
paths from Cargo JSON artifacts. It never rebuilds an executable while running it.
It records executable SHA-256, OS release, Rust/Git versions, exit status and logs.
Its fixed matrix has 20 fixture executions, zero automatic retries:

| Workload | Ordinary | ui-automation |
| --- | ---: | ---: |
| Isolated process | 1 | 1 |
| Four simultaneous tasks within a process | 4 | 4 |
| Both configurations running an isolated case simultaneously | 1 | 1 |
| Both configurations running four simultaneous tasks each | 4 | 4 |

Every failure remains in the summary and causes a nonzero script result, even if
the other planned workloads pass. These are offline fixtures running the original
PowerShell `echo outside-copy`; no AI service is invoked.

Local evidence: Windows x64 release `10.0.26300`, Rust `1.98.1`, Git
`2.45.1.windows.1`. All 20 matrix executions passed. The earlier ordinary smoke
also passed its single and four-way cases. This does **not** reproduce the original
CI environment or establish the historical failing operation. The new CI records
the same matrix on its Windows runner and retains the evidence as an artifact,
including when an earlier test step failed.

A separate negative control launches a directory instead of an executable. Both
configurations produce real OS code 5 at Command::spawn, and the regression asserts
that the stage/code survive cleanup. This validates the new diagnosis, **not** the
cause of the historical CI failure. Other regressions check OS-code conversion,
secret redaction, diagnostic snapshots and the unchanged completion/nested-folder
assertions under four-way concurrency.

Local verification completed: `npm run verify -- --quick` (128 Rust unit tests,
the existing Git workflow suites, TypeScript, frontend and fixture checks), clippy
with warnings denied in both configurations, and 27 release-tooling tests. Native
WebView2/release/package checks are delegated to full CI; no native app window was
opened locally.

## Current decision

The minimal evidence-backed fix is to preserve the lost operation/error context.
There is no evidence-backed behavioral workaround for the historical access denial
yet. If it recurs, use the annotated operation and path to choose a narrow fix;
do not mask it with repeated execution, elevated access or relaxed expectations.
Full CI must remain required, and this PR must not be merged while it is failing.
