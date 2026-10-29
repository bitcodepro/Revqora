# Repository library and reviewed Sync

Open the library from the toolbar's library icon or **Manage library** in the
repository panel. A star keeps a repository accessible after its tab is closed.
Project groups have persistent collapse state; each repository belongs to at most
one group. Search, favorites and the group selector scope the panel's bulk actions
to matching **open** repositories. Closed bookmarks do not perform background Git
or network work until opened. The library keeps previously opened paths available.

## Workspaces

**Save current as** creates a named workspace. The active workspace automatically
tracks its repository set/order, active repository, History/Changes/PR view, history
mode and panel visibility/sizes in every mode. Select **Unsaved session** before
changing the current set when you want to preserve the named snapshot unchanged.

**Switch** opens the saved set, closes other repository tabs and restores layout.
**Add repositories** adds the saved set to the current session without replacing
its layout. These actions do not check out Git branches or change working files.
Running Git operations and validation block replacement. Unsaved conflict buffers
in closing tabs require confirmation and remain available for the app session.
Save those buffers before quitting. Missing folders are reported individually;
successful opens remain available, no original tabs are closed, and the named
snapshot is preserved. The partial result becomes an unsaved session.

Library metadata uses the same executable-local WebView profile as other settings.
It contains paths and UI preferences, not credentials or copies of working files.

## Sync

Sync prepares each selected repository independently and reads its actual server
tip. Preparation fetches commit objects without changing local branches, tracking
refs, tags, index or working files. The review shows local/server revisions and
incoming/outgoing counts. **Receive** defaults on for incoming commits; **Send**
defaults off and must be selected explicitly. Cancel performs no synchronization.

Execution rechecks the reviewed repository state, upstream mapping and server SHA
after acquiring the repository writer queue. Receive fast-forwards only to the
reviewed SHA, with autostash and overwriting ignored files disabled. Send publishes
one fixed SHA to one reviewed upstream ref, verifies ancestry and uses a server
SHA lease. It never intentionally rewrites server history, mirrors other refs or
publishes tags, regardless of the configured remote's mirror/followTags options.

Dirty, conflicted, detached, unborn, bare, diverged or ambiguous-upstream repositories
are skipped with reasons. A missing server branch must first be published with Push.
Fetch and push must resolve to the same single server. Custom upstream destinations
outside `refs/remotes/` require the existing individual Git actions.

A recovery checkpoint is created after preflight and before execution. Results
report completed receive/send steps and warnings per repository; one failure does
not stop the remaining repositories. A lost transport response is checked against
the server. An uncertain outcome requires a new review rather than an automatic
retry. Local tracking-cache failures after server success are warnings. Recovery
does not promise to reverse a remote push automatically.
