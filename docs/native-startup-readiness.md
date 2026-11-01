# Native startup and repository acknowledgement

A rendered React root, readable localStorage and a working Tauri invoke bridge do
not imply that tab restoration or event registration has finished. Scenario 133
previously emitted `open-paths` in this gap. An event could be lost, or the still
running restoration could subsequently activate an older tab.

The app now publishes `data-app-startup=ready` only after both independent gates:

- The saved-tab loop and startup paths have completed, the chosen tab is active
  and `finishWorkspaceStartup` has returned.
- The current `open-paths` registration promise has resolved. A disposed
  StrictMode registration cannot declare a newer pending setup ready.

Before this, the marker reports `restoring` or `connecting`. Failed registration
is visible and never becomes a false ready state. The root's `aria-busy` follows
this startup state. The native driver requires readiness alongside its existing
URL, storage, bridge and DOM checks; the transport-only preflight remains separate.

`openAgentRepository` waits for readiness, emits exactly one opening event and
then waits for the active repository header's full root path. A different
directory with the same basename does not satisfy this acknowledgement. Native
Windows path namespaces and separators are normalized for comparison; Unix path
case remains significant. The existing visible-name check remains afterwards.

No delay is used as a readiness assumption. There is no retry of the opening event,
no injected task history and no change to the existing task/log/no-replay checks.

Regression checks cover both gate completion orders, disposal of an unresolved
StrictMode setup, registration failure, a ready document with pending startup,
and exact-path acknowledgement. The headless React agent suite independently
holds registration and restoration gates, starts with a stale selected repository
and exercises all five scenarios through reload. IPC is mocked in that renderer
check; the existing native Windows scenario 133 remains required in CI.
