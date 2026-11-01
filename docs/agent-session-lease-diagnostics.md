# Agent session lease: repeated macOS failures

Two PR #25 runs failed after the agent worker reported completion:

- Commit `8f361770b06a7e2f8ee1f37588bb38f2fcc9beb7`, run `41317946829`,
  macOS job `124882115832`: `interrupted_history_requires_explicit_process_stop_acknowledgement`
  could not acquire the session lease during acknowledgement.
- Commit `f70430784c7e8ef6e4fcc0999befb9eef7889086`, run `41318721043`,
  macOS job `124884423575`: `detached_descendant_holding_output_cannot_keep_the_agent_queue_locked`
  observed `done=true` but could not immediately acquire the lease.

The old worker already closed its `File` before setting `done`. Reordering these
two lines, adding a sleep or retrying acquisition would not address the defect.
The acquired lease was represented by a raw `File`, so release depended on close.
That includes the short-lived lease probe in `agents::list`, not only the worker.

`fs2` uses `flock` on these Unix targets. A descriptor duplicated by `dup` or `fork`
shares the open-file description and its lock. Closing the owner's descriptor
does not suffice while a child still holds a copy. `CLOEXEC` closes that copy at
exec, not at fork. A concurrent process launch can therefore extend lock lifetime
beyond the worker or history probe that acquired it. Apple's documented semantics:
[flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html).

## Fix and regression evidence

The shared `SessionLease` guard explicitly unlocks before closing. Only a
successfully acquired lock constructs the guard; failed probes cannot unlock an
existing owner. Drop covers read probes, early returns and unwinding. The normal
worker calls fallible `release` before publishing `done`, reports unlock/persistence
errors as interrupted results and includes them in the operation journal.
Live history keeps reporting a busy session until this finalization is finished.
Acknowledging an in-process cleanup failure also clears its old live snapshot;
otherwise it could overwrite the acknowledged record in subsequent reads.

Acquisition diagnostics retain the operation, safe path, I/O kind and native OS
error. The two existing tests keep their immediate-acquisition assertions and
original timeouts; failures now include their whitelisted fixture task snapshot.
Prompts, arguments and environment variables are not added to diagnostics.

Four tests use the production guard:

1. Failed probes leave the current owner locked.
2. A close-only control reproduces retention through a duplicated descriptor;
   explicit unlock clears it even if another copy remains alive.
3. Explicit release and Drop permit a new owner while an old descriptor copy is
   still alive. Closing that old copy does not unlock the new owner.
4. A real `/bin/sh` child is held between fork and exec by a socket handshake.
   Its inherited lease descriptor retains `CLOEXEC`. The child is still paused
   when the old owner finishes and a new owner must acquire the lock. No scheduling
   sleep or blind retry determines the outcome; cleanup releases and reaps the child.

An offline Linux harness compiles the actual production module with the same
`fs2 0.4.3`. All four tests pass sequentially and with four test threads. Replacing
guard Drop with the previous close-only behavior makes test 4 fail deterministically
with `WouldBlock`, while the child remains paused. Windows agent regressions and
strict lint are checked separately. Full macOS application validation remains a
required CI job; the harness is not a substitute for it.

The previous CI logs do not record the PID or descriptor that retained the lock.
The inherited-descriptor defect and its fix are reproduced, but the exact owner
in each historical macOS failure cannot be recovered from those logs. If the new
CI still fails, preserve its new OS context and task snapshot and investigate
that failure; do not classify it as random or automatically retry the test.
