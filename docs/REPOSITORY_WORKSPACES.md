# Repository library and reviewed Sync

Open the library from the toolbar's library icon or **Manage library** in the
repository panel. A star keeps a repository accessible after its tab is closed.
Project groups have persistent collapse state; each repository belongs to at most
one group. Search, favorites and the group selector scope the panel's bulk actions
to matching **open** repositories. Closed bookmarks do not perform background Git
or network work until opened. The library keeps previously opened paths available.

On startup, the complete saved repository list and all group memberships appear
together. The last active repository is selected immediately and discovered first.
By default, every saved library repository opens automatically, including grouped
and ungrouped paths that had no open tab. Disable **Settings → Behaviour → Open all
saved repositories** to restore only the previous open tabs. Named workspaces
always retain their own repository set. Closing a tab stops its background work
for the current session; with this option enabled it opens again next startup.
Git discovery and status reads use bounded background queues; inactive repositories
use display-only Git status without hashing dirty contents for mutation proofs.
They do not load full commit histories, layers or squash-merge analysis until selected.
Action previews and execution still read full safety preconditions independently.
**Opening…** means discovery is pending; **Closed** means the tab was deliberately
closed. Ungrouped saved paths remain visible too. An unavailable folder keeps its
place in the session and offers **Try again**, instead of silently disappearing.
Opening several folders or a group registers every row before reading their Git data.

## When Pull protects ignored data

Ignored files are excluded from Git tracking, but may still contain important local
settings or generated data. When Pull detects an incoming file overlapping an ignored
file, directory or link, it stops and shows both paths. Use **Show local path** or
**Inspect ignored files…**, move the conflicting data outside the repository to keep
a copy, then choose **Retry Pull**. Review any saved content before restoring it.
Cancel leaves the local data in place. Changing `.gitignore` alone does not resolve
the overlap. Fetch may already have refreshed remote-tracking information.

An ignored sibling such as `bin/` or `obj/` does not conflict with a new source file
in the same project folder. Revqora checks the incoming path without recursively
scanning build caches or deleting generated files.

Rebase also checks paths touched by the local commits it will replay, including
files that were added and deleted between the two endpoints. Ordinary untracked
files are protected too, since ignore rules can change during replay.

With recursive submodule updates enabled, Pull inspects initialized submodules
and nested modules before updating the parent. Unrelated ignored build outputs
can stay in place. Overlapping local data, removal of a module with local data,
or an unavailable target needed for inspection stops the operation before working
files change. Collision paths include the module directory so **Show local path**
opens the correct location. An empty, deinitialized module remains uninitialized.

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

Sync also refuses replacement refs, legacy grafts and history-override environment
variables. Its Git commands disable replacement/graft interpretation so ancestry,
receiving and publication use physical commit parents. Explicit receive options
override squash, fast-forward and autostash settings while retaining other merge
policies, including signature verification. Receive checks the resulting branch,
exact HEAD and clean working tree before reporting success or updating the tracking
cache.

A recovery checkpoint is created after preflight and before execution. Results
report completed receive/send steps and warnings per repository; one failure does
not stop the remaining repositories. A lost transport response is checked against
the server. An uncertain outcome requires a new review rather than an automatic
retry. Local tracking-cache failures after server success are warnings. Recovery
does not promise to reverse a remote push automatically.
