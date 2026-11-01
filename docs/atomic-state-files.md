# Atomic state replacement with open readers on Windows

The Windows diagnostic matrix for commit `c9adf680f18f96fda9456524a47ac79a4e45d1c3`
identified `state.save_running` → `state.persist` → OS error 5. Run
`41327118607`, job `124909273937`, artifact `windows-agent-diagnostics`,
`normal-sequential.log`: worktree registration and its Git marker were correct;
exit code was null and process output empty. This failed before process launch.

Both the agent store and Workflow Builder used `NamedTempFile::persist` while
readers could hold the destination JSON open. In tempfile 3.27 this Windows path
uses `MoveFileExW(REPLACE_EXISTING)`. It deterministically fails with error 5 even
when a reader uses Rust's default `FILE_SHARE_READ | FILE_SHARE_WRITE |
FILE_SHARE_DELETE`. The app's own history reader can therefore block replacement;
this does not require a PowerShell/Job Object failure or an antivirus hypothesis.
The previous CI artifact identifies the failing replacement, not the exact reader
PID or handle. The open-reader defect is independently reproduced with the same
production save functions.

`git::atomic_file` is now shared by agent state, workflow runs and workflow
definitions. It creates a uniquely named file in the destination directory with
normal attributes and private Unix permissions. Callers retain their bounded JSON
encoding, complete writes and `sync_all` before replacement. `std::fs::rename`
uses the atomic POSIX replacement path on supported Windows filesystems, allowing
existing readers to retain the old snapshot while new opens see the new file.
The implementation already exists in the project's minimum Rust 1.90:
[Rust Windows rename source](https://github.com/rust-lang/rust/blob/1.90.0/library/std/src/sys/fs/windows.rs#L1174).

The destination is never deleted or truncated first. Source and destination must
share the same absolute directory. The tempfile owner cleans its temporary name
on failure; after success only the new destination remains. Files are created
without `FILE_ATTRIBUTE_TEMPORARY`, so the renamed state does not inherit a cache
hint intended for disposable files. No sleep, application retry loop, elevated
permission, changed security policy or extra dependency is introduced. Initial
agent publication retains its existing no-clobber behavior.

Regressions first ran against the previous writers: all three failed on Windows.

- Agent history: retain readers of queued and running records while saving running
  and completed states. Old handles retain their exact old records; new readers
  see the completed output/exit code, and history remains deletable.
- Workflow result: run a real offline Node command behind a readiness/release
  handshake. Hold the running record open before allowing command completion.
  The old writer changes an exit-0 step into `uncertain` after its final save fails;
  the new writer persists `completed` and retains the old reader's running snapshot.
- Workflow catalogue: edit under an open reader. The old reader retains the old
  definition; a fresh read sees the new definition and revision.

The common primitive also tests open-reader replacement with a Unicode filename,
refusal of cross-directory replacement, cleanup and old-state preservation when a
Windows handle denies delete sharing, normal Windows attributes and private Unix
permissions. A genuinely blocking handle or filesystem/permission error remains
an error; the previous valid state is kept. No action is silently retried.

The existing Windows matrix still requires all 20 predeclared cases across normal
and ui-automation configurations. A passing matrix alone is not the explanation:
the held-reader regressions demonstrate failure before the fix and success after it.
