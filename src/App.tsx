import { ActivityIndicator } from "./components/ActivityIndicator";
import type { IgnoredReport } from "./components/IgnoredFilesChanged";
import { createStartupBarrier, type StartupPhase } from "./lib/startupReady";
import { restoreRepositorySession } from "./lib/restoreRepositorySession";
import { undoExplorerMove } from "./lib/explorerMoves";
import { keyboardOwner, shortcutBlocked, viewSwitchUnderTool, VIEW_SWITCHES } from "./lib/keyboardOwner";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listenMcpDesktop } from "./lib/mcpDesktop";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Columns3, FilePlus2, GitCommitHorizontal, GitGraph, GitPullRequest, Maximize2, Minimize2, RefreshCw, Rows3 } from "lucide-react";
import { noteOperationEnd, rememberOperationRefresh, retryRepositoryWatch, useRepos, type RepoTab } from "./lib/store";
import { resolvedTheme, toggledThemePref, useSettings } from "./lib/settings";
import { applyTheme } from "./lib/themeApply";
import { closeOverlay, openOverlay, toast, toggleCommitMaximized, toggleRepositoryOverview, updateBusy, updateRepositoryOperation, useUi, type RepositoryOperation } from "./lib/ui";
import { actionFor, matchesShortcut, PANEL_NAMES, shortcutTitle } from "./lib/shortcuts";
import { settingsDialog } from "./components/dialogs";
import { repoToolsDialog } from "./components/RepoTools";
import { Onboarding } from "./components/Onboarding";
import { GitMissing } from "./components/GitMissing";
import * as A from "./lib/actions";
import { api, errorMessage, isGitError } from "./lib/api";
import { WORKTREE } from "./lib/types";
import { CommandPalette, OpBanner, paletteShortcut, StatusBar, TopBar, Welcome } from "./components/Shell";
import { ContextMenuHost, DialogHost, Splitter, ToastHost } from "./components/Overlays";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { bindingFor, prettyCombo } from "./lib/shortcuts";
import { Sidebar } from "./components/Sidebar";
import { GraphView } from "./components/GraphView";
import { CommitDetails } from "./components/CommitDetails";
import { ChangesView } from "./components/ChangesView";
import { AskpassHost } from "./components/Askpass";
import { branchCommitCompare } from "./components/BranchCommitCompare";
import { startUpdateChecks } from "./lib/update";
import { autoFetchRound, createAutoFetch, defaultFetch, urlHost } from "./lib/autofetch";
import { useBackgroundPoll } from "./lib/backgroundPolling";
import { checkPullRequestActivity, resetPullRequestActivity } from "./lib/prTracking";
import { refreshRepositoryView } from "./lib/prRefresh";
import { RepositoryOverview, RepositorySidebar } from "./components/Repositories";
import { HISTORY_MODES, workspaceMode } from "./lib/workspaceLayouts";
import { WorkspaceLayoutContext, useWorkspaceLayout } from "./lib/workspaceLayoutContext";
import { RepositoryExplorer } from "./components/RepositoryExplorer";
import { repositoryGitChanged, scanRepositoryChanges, scanRepositoryTracking, startRepositoryTracking } from "./lib/repositoryTracking";
import { uniqueRoots, useLibrary } from "./lib/repositoryLibrary";
import { DetachedPanel, DetachedPlaceholder, PanelWindowsProvider, usePanelTitleMenu, usePanelWindows, type PanelId } from "./components/PanelWindows";
import "./styles/workspace.css";

// Full-screen tools open on demand, so their code stays out of the startup bundle.
const ConflictEditor = lazy(() => import("./components/ConflictEditor").then((m) => ({ default: m.ConflictEditor })));
const WorkflowBuilder = lazy(() => import("./components/WorkflowBuilder").then((m) => ({ default: m.WorkflowBuilder })));
const WorktreeManager = lazy(() => import("./components/WorktreeManager").then((m) => ({ default: m.WorktreeManager })));
const PullRequestsView = lazy(() => import("./components/PullRequests").then((m) => ({ default: m.PullRequestsView })));
const StackManager = lazy(() => import("./components/StackManager").then((m) => ({ default: m.StackManager })));
const HistoryExplorer = lazy(() => import("./components/HistoryExplorer").then((m) => ({ default: m.HistoryExplorer })));
const AgentWorkspace = lazy(() => import("./components/AgentWorkspace").then((m) => ({ default: m.AgentWorkspace })));
const BlameView = lazy(() => import("./components/BlameView").then((m) => ({ default: m.BlameView })));
const CompareView = lazy(() => import("./components/CompareView").then((m) => ({ default: m.CompareView })));
const BranchManager = lazy(() => import("./components/BranchManager").then((m) => ({ default: m.BranchManager })));
const RebaseView = lazy(() => import("./components/RebaseView").then((m) => ({ default: m.RebaseView })));
const StashView = lazy(() => import("./components/StashView").then((m) => ({ default: m.StashView })));
const TreeBrowser = lazy(() => import("./components/TreeBrowser").then((m) => ({ default: m.TreeBrowser })));

function useAppearance() {
  // Only the appearance fields: any other settings write must not re-render the whole app.
  const s = {
    theme: useSettings((st) => st.theme),
    uiFontSize: useSettings((st) => st.uiFontSize),
    codeFontSize: useSettings((st) => st.codeFontSize),
    uiFont: useSettings((st) => st.uiFont),
    codeFont: useSettings((st) => st.codeFont),
  };
  useEffect(() => {
    const apply = () => {
      const t = resolvedTheme(s.theme);
      applyTheme();
      getCurrentWindow()
        .setTheme(t)
        .catch(() => {});
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [s.theme]);
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--fs", `${s.uiFontSize}px`);
    r.setProperty("--fs-code", `${s.codeFontSize}px`);
    r.setProperty("--font-ui", `"${s.uiFont}", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`);
    r.setProperty("--font-code", `"${s.codeFont}", "Cascadia Code", Consolas, monospace`);
  }, [s.uiFontSize, s.codeFontSize, s.uiFont, s.codeFont]);
}

function RepositoryRefresh({ root }: { root: string }) {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { await refreshRepositoryView(root); }
    finally { setBusy(false); }
  };
  return <button type="button" className="icon-btn" aria-label="Refresh" data-shortcut="refresh" disabled={busy} aria-busy={busy} onClick={() => void refresh()}>
    <RefreshCw size={15} className={busy ? "spin" : ""} />
  </button>;
}

function RepositoryContent({ tab, combinedPulls }: { tab: RepoTab; combinedPulls: boolean }) {
  if (!tab.info && !combinedPulls) return <div className="repository-opening" role="status">
    <h2>{tab.root.split(/[\\/]/).filter(Boolean).at(-1)}</h2>
    <p>{tab.error ? "Repository unavailable" : "Opening repository…"}</p>
    <code>{tab.root}</code>
    {tab.error && <><p role="alert">{tab.error}</p><button type="button" className="btn" onClick={() => void A.openRepoPath(tab.root)}>Try again</button></>}
  </div>;
  return <RepoWorkspace tab={tab} combinedPulls={combinedPulls} />;
}

const repositoryRemotesKey = (tab: RepoTab) => JSON.stringify(tab.refs?.remotes.map(({ name, fetchUrl }) => [name, fetchUrl]) ?? []);

function RepoWorkspace({ tab, combinedPulls }: { tab: RepoTab; combinedPulls: boolean }) {
  const { panels } = usePanelWindows();
  const historyMenu = usePanelTitleMenu("history");
  const changesMenu = usePanelTitleMenu("changes");
  const pullMenu = usePanelTitleMenu("pulls");
  const root = tab.root;
  const overlay = useUi(s => s.overlay && (s.overlay.root === root || (combinedPulls && s.overlay.kind === "workflows" && s.overlay.pull)) ? s.overlay : null);
  const patch = useRepos((s) => s.patch);
  const { mode, layout, setLayout } = useWorkspaceLayout();
  const sidebarW = layout.sidebarWidth;
  const detailsH = layout.detailsHeight;
  const setS = useSettings((s) => s.set);
  const [sw, setSw] = useState(sidebarW);
  const [dh, setDh] = useState(detailsH);
  const historyMode = useSettings((s) => s.historyMode);
  const reviewH = layout.reviewListHeight;
  const [rh, setRh] = useState(reviewH);
  const [cw, setCw] = useState(layout.historyListWidth);
  useEffect(() => setSw(sidebarW), [mode, sidebarW]);
  useEffect(() => setDh(detailsH), [mode, detailsH]);
  useEffect(() => setRh(reviewH), [mode, reviewH]);
  useEffect(() => setCw(layout.historyListWidth), [mode, layout.historyListWidth]);
  const branchesOpen = layout.branchesOpen;
  const focusMode = layout.focusMode;
  // The open commit expanded to the whole workspace (see toggleCommitMaximized).
  const commitMaximized = useUi(s => s.commitMaximized);
  const maximized = commitMaximized && tab.view === "history" && !panels.commit && !!tab.selected && tab.selected !== WORKTREE;
  // Closing the commit or leaving History restores the layout, so the next commit opens normally.
  useEffect(() => { if (commitMaximized && !maximized) toggleCommitMaximized(false); }, [commitMaximized, maximized]);
  const maximize = { on: maximized, toggle: () => toggleCommitMaximized() };
  const showBranches = branchesOpen && !focusMode && !maximized && !panels.branches;
  const changesCount = tab.status?.files.length ?? 0;
  const [forgeKind, setForgeKind] = useState<string | null>(null);
  const remotesKey = repositoryRemotesKey(tab);
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const id = ++generation;
      api.forgeKind(root).then(kind => { if (id === generation) setForgeKind(kind); }, () => { /* Keep the last known provider if discovery fails. */ });
    };
    refresh();
    window.addEventListener("revqora:forge-accounts", refresh);
    return () => { generation++; window.removeEventListener("revqora:forge-accounts", refresh); };
  }, [root, remotesKey]);
  const conflicts = tab.status?.conflictCount ?? 0;
  const switchSource = tab.info?.head.branch ? `refs/heads/${tab.info.head.branch}` : `HEAD/${tab.info?.head.oid ?? ""}`;
  const switchStashes = tab.refs?.stashes.filter((stash) => stash.switchSource === switchSource) ?? [];
  const latestSwitchStash = switchStashes[0];

  const openConflict = (path: string) => patch(root, { conflictPath: path, view: "changes", changeSel: { kind: "conflict", path } });

  const commitSelected = !panels.commit && tab.selected && tab.selected !== WORKTREE ? tab.selected : null;
  const historyList = (compact: boolean) => panels.history ? <DetachedPlaceholder id="history"/> : <GraphView tab={tab} compact={compact} onEnterChanges={() => patch(root, { view: "changes" })}/>;
  const closePreview = () => {
    patch(root, { selected: null, multi: [] });
    setLayout({ focusMode: false });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".review .graph-scroll, .columns-commits .graph-scroll")?.focus({ preventScroll: true }));
  };

  return (
    <div className="workspace" style={{ ["--sidebar-w" as string]: `${showBranches ? sw : 0}px` }}>
      <div className="branches-slot" hidden={!showBranches}>{!panels.branches && tab.info && <Sidebar key={root} tab={tab} />}</div>
      {showBranches && <Splitter dir="v" style={{ left: sw }} onDrag={(d) => setSw((w) => Math.max(180, Math.min(420, w + d)))} onEnd={() => setLayout({ sidebarWidth: sw })} />}
      <div className="main">
        <div className="main-head" hidden={maximized}>
          <div className="view-tabs">
            <button className={`view-tab ${tab.view === "history" ? "on" : ""}`} onContextMenu={historyMenu} onClick={() => patch(root, { view: "history" })} title={shortcutTitle("History", "history")}>
              <GitCommitHorizontal size={15} /> History
            </button>
            <button className={`view-tab ${tab.view === "changes" ? "on" : ""}`} onContextMenu={changesMenu} onClick={() => patch(root, { view: "changes" })} title={shortcutTitle("Changes", "changes")}>
              <FilePlus2 size={15} /> Changes
              {changesCount > 0 && <span className={`pill ${conflicts ? "red" : "accent"}`}>{changesCount}</span>}
            </button>
          </div>
          <button className={`view-tab ${tab.view === "pulls" ? "on" : ""}`} onContextMenu={pullMenu} onClick={() => patch(root, { view: "pulls" })} title={shortcutTitle("Pull requests", "pulls")}>
            <GitPullRequest size={15} /> {!combinedPulls && forgeKind === "gitlab" ? "Merge requests" : "Pull requests"}
          </button>
          <div className="spacer" />
          {tab.view === "history" && (
            <div className="seg history-mode" title={`History layout (${prettyCombo(bindingFor("reviewMode"))})`}>
              {HISTORY_MODES.map((m) => (
                <button key={m} type="button" className={historyMode === m ? "on" : ""} aria-pressed={historyMode === m} onClick={() => setS({ historyMode: m })}>
                  {m === "graph" ? <GitGraph size={13} /> : m === "review" ? <Rows3 size={13} /> : <Columns3 size={13} />} {m === "graph" ? "Graph" : m === "review" ? "Review" : "Columns"}
                </button>
              ))}
            </div>
          )}
          <button className={`icon-btn focus-toggle ${focusMode ? "active" : ""}`} title={focusMode ? "Exit focus mode" : "Focus on code"} aria-label={focusMode ? "Exit focus mode" : "Focus on code"} aria-pressed={focusMode} onClick={() => setLayout({ focusMode: !focusMode })}>{focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          <RepositoryRefresh key={root} root={root} />
        </div>
        <OpBanner tab={tab} onResolve={openConflict} />
        {latestSwitchStash && <div className="branch-switch-stash hstack">
          <span>{switchStashes.length === 1 ? "This branch has saved changes" : `${switchStashes.length} stashes saved for this branch`}</span>
          <button type="button" className="btn sm" onClick={() => openOverlay({ kind: "stash", root, index: latestSwitchStash.index, oid: latestSwitchStash.oid })}>View stash</button>
          <button type="button" className="btn sm" disabled={!!tab.pendingMutations || !!conflicts || !tab.status?.stateToken || tab.status.branch !== tab.info?.head.branch || tab.info?.state.kind !== "none" || tab.status.files.length > 0}
            title={tab.status?.files.length ? "Save current changes before restoring this stash" : undefined}
            onClick={() => void A.stashApply(root, latestSwitchStash.index, true, latestSwitchStash.oid)}>Restore stash</button>
        </div>}
        {tab.view === "history" && historyMode === "review" ? (
          <div className={`review ${(focusMode || maximized) && commitSelected ? "review-focused" : ""}`} style={{ gridTemplateRows: focusMode || maximized || !commitSelected ? "minmax(0, 1fr)" : `minmax(100px, min(${rh}px, 45%)) minmax(0, 1fr)` }}>
            <div className="review-list" hidden={(focusMode || maximized) && !!commitSelected}>
              {historyList(true)}
            </div>
            {!focusMode && !maximized && commitSelected && <div className="review-resizer"><Splitter dir="h" onDrag={(d) => setRh((h) => Math.max(100, Math.min(400, h + d)))} onEnd={() => setLayout({ reviewListHeight: rh })} /></div>}
            {commitSelected && <div key="commit-preview" className="details review-details">
              <CommitDetails root={root} oid={commitSelected} onClose={closePreview} maximize={maximize} />
            </div>}
          </div>
        ) : tab.view === "history" && historyMode === "columns" ? (
          <div className={`columns-history ${maximized ? "columns-maximized" : ""}`} style={{ ["--history-list-w" as string]: `${cw}px` }}>
            <div className="columns-commits" hidden={maximized}>{historyList(true)}</div>
            {!maximized && <Splitter dir="v" style={{ left: "var(--history-list-size)" }} onDrag={(d) => setCw((w) => Math.max(180, Math.min(600, w + d)))} onEnd={() => setLayout({ historyListWidth: cw })} />}
            {commitSelected ? (
              <div key="commit-preview" className="details columns-details"><CommitDetails root={root} oid={commitSelected} compactMeta onClose={closePreview} maximize={maximize} /></div>
            ) : (
              <div className="empty columns-placeholder">
                <span className="big"><GitCommitHorizontal size={24} /></span>
                <span>Select a commit to see its files and changes.</span>
              </div>
            )}
          </div>
        ) : tab.view === "history" ? (
          <div className={`history ${maximized ? "history-maximized" : ""}`}>
            {historyList(false)}
            {commitSelected && (
              <>
                {!maximized && <Splitter dir="h" onDrag={(d) => setDh((h) => Math.max(160, Math.min(window.innerHeight - 260, h - d)))} onEnd={() => setLayout({ detailsHeight: dh })} />}
                <div className="details" style={maximized ? undefined : { height: dh }}>
                  <CommitDetails root={root} oid={commitSelected} onClose={() => patch(root, { selected: null, multi: [] })} maximize={maximize} />
                </div>
              </>
            )}
          </div>
        ) : tab.view === "pulls" ? (
          panels.pulls ? <DetachedPlaceholder id="pulls"/> : <Suspense fallback={null}><PullRequestsView tab={tab} remotesKey={remotesKey} /></Suspense>
        ) : (
          panels.changes ? <DetachedPlaceholder id="changes"/> : <ChangesView tab={tab} onOpenConflict={openConflict} />
        )}
        <Suspense fallback={null}>
          {tab.conflictPath && <ConflictEditor key={`${root}:${tab.conflictPath}`} root={root} path={tab.conflictPath} onClose={() => patch(root, { conflictPath: null })} />}
          {overlay?.kind === "blame" && <BlameView root={root} path={overlay.path} rev={overlay.rev} line={overlay.line} />}
          {overlay?.kind === "branches" && <BranchManager key={root} root={root} />}
          {overlay?.kind === "worktrees" && !panels.worktrees && <WorktreeManager key={root} root={root} />}
          {overlay?.kind === "stacks" && <StackManager key={root} root={root}/>}
          {overlay?.kind === "historyExplorer" && <HistoryExplorer key={root} root={root}/>}
          {overlay?.kind === "workflows" && <WorkflowBuilder key={overlay.root} root={overlay.root} pull={overlay.pull} />}
          {overlay?.kind === "agents" && <AgentWorkspace key={root} root={root} />}
          {overlay?.kind === "stash" && <StashView key={`${overlay.root}:${overlay.oid}`} root={overlay.root} index={overlay.index} oid={overlay.oid} />}
          {overlay?.kind === "tree" && <TreeBrowser key={overlay.rev} root={root} rev={overlay.rev} />}
          {overlay?.kind === "rebase" && <RebaseView key={overlay.oldest} root={root} oldest={overlay.oldest} autosquash={overlay.autosquash} />}
          {overlay?.kind === "compare" && <CompareView key={`${overlay.from}..${overlay.to}`} root={root} from={overlay.from} to={overlay.to} direct={overlay.direct} />}
        </Suspense>
      </div>
    </div>
  );
}

const quietFetch = createAutoFetch({
  fetch: defaultFetch,
  refresh: async (root, changed) => {
    // A repository that is not open only needs its incoming and outgoing counts.
    if (!useRepos.getState().tabs[root]) return changed ? scanRepositoryTracking([root]) : undefined;
    useRepos.getState().patch(root, { lastFetchedAt: Date.now(), fetchError: null });
    // Most automatic fetches bring nothing: then branches, counts and history are as shown.
    if (!changed) return;
    return useRepos.getState().refresh(root, { background: true, revalidate: true, info: true, status: true, refs: true });
  },
  failed: (root, e) => { if (useRepos.getState().tabs[root]) useRepos.getState().patch(root, { fetchError: errorMessage(e) }); },
  serverOf: root => {
    const remotes = useRepos.getState().tabs[root]?.refs?.remotes ?? [];
    const remote = remotes.find(r => r.name === "origin") ?? remotes[0];
    return remote ? urlHost(remote.fetchUrl) : null;
  },
  serversOf: root => [...new Set((useRepos.getState().tabs[root]?.refs?.remotes ?? []).map(r => urlHost(r.fetchUrl)).filter((host): host is string => !!host))],
  // Other background fetches of the same round do not count as the user's work.
  busy: () => useUi.getState().busy.length > 0 || useUi.getState().repositoryOperations.some(op => op.command !== "fetch_background")
    || Object.values(useRepos.getState().tabs).some((t) => t.pendingMutations > 0),
});

/** Away from the window at least this long before focus reads the shown repository again. */
const FOCUS_REFRESH_AFTER_MS = 3_000;

/** Background fetches running at once (each waits on its own server). */
const AUTO_FETCH_PARALLEL = 4;
/** The first round starts shortly after launch instead of one interval later. */
const FIRST_AUTO_FETCH_MS = 15_000;

/** Fetches open repositories, and with Settings → Git auto-fetch → "Also fetch repositories that
 *  are not open" the whole library, so Incoming is current without opening each repository. */
function useAutoFetch() {
  const minutes = useSettings((s) => s.autoFetchMinutes);
  useBackgroundPoll(minutes, async current => {
    const { active, order } = useRepos.getState();
    const library = useSettings.getState().autoFetchLibrary ? useLibrary.getState().knownRoots : [];
    const roots = uniqueRoots([...(active ? [active] : []), ...order, ...library]);
    await autoFetchRound(roots, quietFetch, root => {
      const tab = useRepos.getState().tabs[root];
      // An open repository is fetched once it has loaded.
      return !tab || !!tab.info;
    }, current, AUTO_FETCH_PARALLEL);
  }, false, undefined, FIRST_AUTO_FETCH_MS);
}

export default function App() {
  return <PanelWindowsProvider><MainApp/></PanelWindowsProvider>;
}

function MainApp() {
  const { panels, attach, detach, toggleSidebar } = usePanelWindows();
  useAppearance();
  useEffect(startUpdateChecks, []);
  useAutoFetch();
  const prPollMinutes = useSettings(s => s.prPollMinutes);
  const prWatches = useSettings(s => s.prWatches);
  const prWatchMineSince = useSettings(s => s.prWatchMineSince);
  const prWatchRevision = useMemo(() => ({ prWatches, prWatchMineSince }), [prWatches, prWatchMineSince]);
  useBackgroundPoll(prPollMinutes, checkPullRequestActivity, !!prWatchMineSince || Object.keys(prWatches).length > 0, prWatchRevision);
  useEffect(() => {
    window.addEventListener("revqora:forge-accounts", resetPullRequestActivity);
    return () => window.removeEventListener("revqora:forge-accounts", resetPullRequestActivity);
  }, []);
  // Only what the shell itself needs: the active tab changes several times per refresh, and
  // the shell (top bar, status bar, Explorer) must not re-render with it.
  const activeView = useRepos((s) => (s.active ? s.tabs[s.active]?.view : undefined));
  const prAllRepositories = useSettings(s => s.prAllRepositories);
  const combinedPulls = prAllRepositories && activeView === "pulls";
  const pending = useRepos((s) => Object.values(s.tabs).some((t) => t.pendingMutations > 0));
  const busy = useUi((s) => s.busy.length > 0 || s.repositoryOperations.some(op => op.command !== "fetch_background")) || pending;
  const [dropping, setDropping] = useState(false);
  const restored = useRef(false);
  const [startupPhase, setStartupPhase] = useState<StartupPhase>("restoring");
  const startup = useRef<ReturnType<typeof createStartupBarrier> | null>(null);
  if (!startup.current) startup.current = createStartupBarrier(setStartupPhase, error => toast.error(error, "Could not register repository opening"));
  const overview = useUi((s) => s.repositoryOverview);
  const historyMode = useSettings((s) => s.historyMode);
  const layoutMode = workspaceMode(overview ? "overview" : activeView, historyMode);
  const { layout } = useWorkspaceLayout(layoutMode);
  const { focusMode, repositoriesOpen } = layout;
  const explorerOpen = useSettings(s => s.explorerOpen);
  // RepoWorkspace clears the flag when no commit is open in History; the overview never shows one.
  const commitMaximized = useUi(s => s.commitMaximized) && !overview;

  // Restore the tabs from the previous session.
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    (async () => {
      // Publish the entire roster before asynchronous Git discovery begins.
      void restoreRepositorySession();
      const initial = useRepos.getState().selectionVersion;
      const paths = await api.startupPaths().catch(() => [] as string[]);
      if (paths.length) {
        void useRepos.getState().openMany(paths, useRepos.getState().selectionVersion === initial ? paths.at(-1) : undefined).then(results => {
          // A folder named on the command line that is not a repository: offer to find the
          // repositories inside it, as opening it from the window does.
          const named = uniqueRoots(paths);
          results.forEach((result, index) => {
            if (result.status === "rejected" && isGitError(result.reason) && result.reason.kind === "not-a-repo") void A.offerNotRepository(named[index]);
          });
        });
      }
    })().then(() => startup.current!.restored(), error => toast.error(error, "Could not restore repository session"));
  }, []);

  // Backend events.
  useEffect(() => {
    let disposed = false;
    const unsubs: Promise<() => void>[] = [];
    const mcpListener = listenMcpDesktop();
    unsubs.push(mcpListener);
    const restoreMcp = mcpListener.then(() => {
      if (!disposed) return api.mcpRestore();
    }).catch(error => {
      if (!disposed) toast.error(error, "Could not restore MCP access");
    });
    unsubs.push(
      listen<string>("repo-watch-failed", (e) => retryRepositoryWatch(e.payload)),
      listen<{ repo: string; git: boolean; worktree: boolean; since?: number }>("repo-changed", (e) => {
        const { repo, git, since } = e.payload;
        if (!useRepos.getState().tabs[repo]) return;
        // Parts read after the change (an operation's own refresh) are not read again.
        useRepos.getState().refresh(repo, git ? { background: true, revalidate: true, info: true, status: true, refs: true, layers: true, graph: true } : { background: true, status: true, layers: true, changesDisplay: true }, { since });
        // Remote refs moved (push or fetch in another tool): the unpublished count may be stale.
        if (git) repositoryGitChanged(repo);
        window.dispatchEvent(new CustomEvent("revqora:worktree", { detail: { repo } }));
      }),
    );
    unsubs.push(listen<{ repo: string; report: IgnoredReport }>("ignored-files-changed", (e) => { void import("./components/IgnoredFilesChanged").then((m) => m.ignoredFilesChangedDialog(e.payload.repo, e.payload.report)); }));
    unsubs.push(listen<{ opId: string; line: string }>("op-progress", (e) => updateBusy(e.payload.opId, e.payload.line)));
    unsubs.push(listen<RepositoryOperation>("repository-operation", (e) => {
      updateRepositoryOperation(e.payload);
      if ((e.payload.phase === "finished" || e.payload.phase === "failed") && !useRepos.getState().tabs[e.payload.repo]
        // Auto-fetch reads the counts of a repository that is not open itself (quietFetch).
        && e.payload.command !== "fetch_background") {
        // A repository that is not open (an MCP client): update its counts.
        void scanRepositoryTracking([e.payload.repo]);
        void scanRepositoryChanges([e.payload.repo]);
      }
      if (e.payload.command === "fetch_background") return;
      if (e.payload.phase === "finished" || e.payload.phase === "failed") {
        // Shared refs can change in another worktree. Refresh all open views; parts read after
        // the operation ended (by the caller that waited for it) are not read again.
        noteOperationEnd(e.payload.repo, e.payload.at);
        const since = e.payload.at;
        for (const root of useRepos.getState().order) {
          if (root === e.payload.repo) rememberOperationRefresh(e.payload.id, useRepos.getState().refresh(root, undefined, { since }));
          else if (useRepos.getState().tabs[root]?.info?.commonDir === e.payload.repositoryKey) void useRepos.getState().refresh(root, undefined, { since });
        }
      }
    }));
    const openPathsListener = listen<string[]>("open-paths", (e) => e.payload.forEach((p) => A.openRepoPath(p)));
    const disposeOpenPaths = startup.current!.listener(openPathsListener.then(async stop => {
      await restoreMcp;
      return stop;
    }));
    unsubs.push(
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "over" || e.payload.type === "enter") setDropping(true);
        else if (e.payload.type === "leave") setDropping(false);
        else if (e.payload.type === "drop") {
          setDropping(false);
          for (const p of e.payload.paths) A.openRepoPath(p);
        }
      }),
    );
    return () => {
      disposed = true;
      disposeOpenPaths();
      unsubs.forEach(u => void u.then(stop => stop(), () => {}));
    };
  }, []);

  // Incoming and outgoing commits of the whole library, for the Explorer filters.
  useEffect(() => startRepositoryTracking(), []);

  // Refresh when the window regains focus (changes made in other tools). The file watcher
  // already reports those; this is the safety net for changes it cannot see. Parts read after
  // the window lost focus are not read again, and a short switch (Alt+Tab and back) reads nothing.
  useEffect(() => {
    let last = 0, blurredAt: number | null = null;
    const onBlur = () => { blurredAt = Date.now(); };
    const onFocus = () => {
      const now = Date.now(), since = blurredAt;
      blurredAt = null;
      if (since === null || now - since < FOCUS_REFRESH_AFTER_MS || now - last < 1500) return;
      last = now;
      const a = useRepos.getState().active;
      // Background revalidation: commit previews stay, nothing flashes; real changes still update.
      if (a) useRepos.getState().refresh(a, { info: true, status: true, refs: true, layers: true, background: true, revalidate: true }, { since });
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("blur", onBlur); window.removeEventListener("focus", onFocus); };
  }, []);

  // Global shortcuts (rebindable in Settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement;
      const owner = target?.ownerDocument ?? document;
      const inNavigation = target?.closest?.(".repository-sidebar") || (target === owner.body && useSettings.getState().explorerOpen);
      if (matchesShortcut(e, "workspaceUndo") && inNavigation &&
          !target.closest("input, textarea, select, [contenteditable], .cm-editor") && !shortcutBlocked("workspaceUndo", keyboardOwner(owner)) && undoExplorerMove()) {
        e.preventDefault();
        toast.success("Explorer move undone");
        return;
      }
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, .cm-editor");
      if (typing && !e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
      const id = actionFor(e);
      if (!id) return;
      // A dialog, the palette or an open menu owns the keyboard: nothing runs behind it. A tool
      // window (Blame, Compare, the merge editor) blocks only what acts on the view it covers.
      if (shortcutBlocked(id, keyboardOwner(owner))) return;
      // Typing never starts network or repository work by a stray chord.
      if (typing && ["fetch", "pull", "push", "stash", "branch"].includes(id)) return;
      const st = useRepos.getState();
      const a = st.active;
      const t = a ? st.tabs[a] : null;
      const mode = workspaceMode(useUi.getState().repositoryOverview ? "overview" : t?.view, useSettings.getState().historyMode);
      const layout = useSettings.getState().layouts[mode];
      const run: Record<string, () => void> = {
        palette: () => { window.focus(); useUi.getState().setPalette(true); },
        paletteAlternate: () => { window.focus(); useUi.getState().setPalette(true); },
        open: () => A.openRepoDialog(),
        refresh: () => useUi.getState().repositoryOverview ? void Promise.allSettled(st.order.map((r) => st.refresh(r))) : a && refreshRepositoryView(a),
        overview: toggleRepositoryOverview,
        workspacesPanel: () => toggleSidebar("explorer"),
        repositoriesPanel: () => toggleSidebar("repositories"),
        branchesPanel: () => toggleSidebar("branches"),
        focusMode: () => useSettings.getState().setLayout(mode, { focusMode: !layout.focusMode }),
        commitMaximize: () => {
          // Restoring always works; expanding needs a commit open in History of the main window.
          const open = !useUi.getState().repositoryOverview && t?.view === "history" && !!t.selected && t.selected !== WORKTREE && !panels.commit;
          if (useUi.getState().commitMaximized || open) toggleCommitMaximized();
        },
        history: () => a && st.patch(a, { view: "history" }),
        changes: () => a && st.patch(a, { view: "changes" }),
        pulls: () => a && st.patch(a, { view: "pulls" }),
        reviewMode: () => {
          const s = useSettings.getState();
          s.set({ historyMode: HISTORY_MODES[(HISTORY_MODES.indexOf(s.historyMode) + 1) % HISTORY_MODES.length] });
          if (a) st.patch(a, { view: "history" });
        },
        fetch: () => a && A.fetchAll(a),
        pull: () => a && A.pull(a),
        push: () => a && A.push(a),
        branch: () => a && A.createBranch(a, null, t?.info?.head.branch ?? "HEAD"),
        stash: () => a && A.stash(a),
        compare: () => a && void branchCommitCompare(a),
        browse: () => a && openOverlay({ kind: "tree", root: a, rev: "HEAD" }),
        tools: () => a && repoToolsDialog(a),
        theme: () => {
          const s = useSettings.getState();
          s.set({ theme: toggledThemePref() });
        },
        settings: () => settingsDialog(a),
        closeTab: () => a && st.close(a),
        nextTab: () => {
          if (st.order.length < 2) return;
          const i = a ? st.order.indexOf(a) : -1;
          st.activate(st.order[(i + 1) % st.order.length]);
        },
        prevTab: () => {
          if (st.order.length < 2) return;
          const i = a ? st.order.indexOf(a) : 0;
          st.activate(st.order[(i - 1 + st.order.length) % st.order.length]);
        },
      };
      if (run[id]) {
        e.preventDefault();
        if (VIEW_SWITCHES.has(id)) {
          // Never change the view unseen behind a tool window.
          const under = viewSwitchUnderTool(keyboardOwner(owner), useUi.getState().overlay?.kind ?? null, !!t?.conflictPath, !!owner.querySelector(".conflict-overlay[data-unsaved]"));
          if (under === "keep-tool") {
            toast.info("Close the open tool first", "It holds work in progress, so the view was not switched.");
            return;
          }
          if (under === "close-tool") closeOverlay();
        }
        if (["history", "changes", "pulls", "reviewMode"].includes(id)) useUi.setState({ repositoryOverview: false });
        run[id]();
        return;
      }
      if (e.repeat || typing) return;
      const panel = id.startsWith("window-") ? id.slice(7) as PanelId : null;
      if (panel && Object.hasOwn(PANEL_NAMES, panel)) {
        if (panels[panel]) { e.preventDefault(); attach(panel); return; }
        if (panel !== "explorer" && panel !== "repositories" && !t?.info) return;
        if (panel === "commit" && (!t?.selected || t.selected === WORKTREE)) return;
        e.preventDefault();
        detach(panel);
        return;
      }
      if (id === "repository-actions") {
        e.preventDefault();
        const settings = useSettings.getState();
        settings.set({ repositoryActionsCollapsed: !settings.repositoryActionsCollapsed });
        if (settings.repositoryActionsCollapsed && (panels.repositories || !layout.repositoriesOpen || layout.focusMode)) toggleSidebar("repositories");
        return;
      }
      const historyMode = HISTORY_MODES.find(value => id === `layout-${value}`);
      if (historyMode && a && t?.info) {
        e.preventDefault();
        useSettings.getState().set({ historyMode });
        useUi.setState({ repositoryOverview: false });
        st.patch(a, { view: "history" });
        return;
      }
      if (id === "close-preview" && a && t?.selected && t.selected !== WORKTREE) {
        e.preventDefault();
        st.patch(a, { selected: null, multi: [] });
        return;
      }
      if (id === "worktree-manager" && panels.worktrees) {
        e.preventDefault();
        panels.worktrees.focus();
        return;
      }
      const command = paletteShortcut(id, t?.info ? t : null);
      if (command) {
        e.preventDefault();
        command();
      }
    };
    const surfaces = [window, ...Object.values(panels)];
    for (const view of surfaces) view.addEventListener("keydown", onKey);
    return () => { for (const view of surfaces) view.removeEventListener("keydown", onKey); };
  }, [panels, attach, detach, toggleSidebar]);

  // Block the default browser context menu outside our own menus.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .cm-editor, .selectable, .code")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  return (
    <WorkspaceLayoutContext.Provider value={layoutMode}><div className="app" data-app-startup={startupPhase} aria-busy={startupPhase !== "ready"}>
      <ErrorBoundary area="Toolbar" quiet><TopBar /></ErrorBoundary>
      <ActivityIndicator active={busy} />
      <div className="app-body">
        {explorerOpen && !focusMode && !panels.explorer && <ErrorBoundary area="Explorer"><RepositoryExplorer onClose={closeExplorer} hidden={commitMaximized}/></ErrorBoundary>}
        <div className="repository-slot" hidden={!!panels.repositories || !repositoriesOpen || focusMode || commitMaximized}>{!panels.repositories && <ErrorBoundary area="Repositories"><RepositorySidebar /></ErrorBoundary>}</div>
        <div className="workspace-host">{overview ? <ErrorBoundary area="Repository overview"><RepositoryOverview /></ErrorBoundary> : <ActiveRepositoryContent combinedPulls={combinedPulls} />}</div>
      </div>
      <ErrorBoundary area="Status bar" quiet><StatusBar /></ErrorBoundary>
      <ErrorBoundary area="Menu" quiet><ContextMenuHost /></ErrorBoundary>
      <ErrorBoundary area="Dialog" quiet><DialogHost /></ErrorBoundary>
      <ErrorBoundary area="Command palette" quiet><CommandPalette /></ErrorBoundary>
      <ErrorBoundary area="Notifications" quiet><ToastHost /></ErrorBoundary>
      <ErrorBoundary area="Sign-in prompt" quiet><AskpassHost /></ErrorBoundary>
      <GitMissing />
      <ErrorBoundary area="Welcome" quiet><Onboarding /></ErrorBoundary>
      {dropping && <div className="drop-hint">Drop a folder to open it</div>}
      <DetachedPanel id="explorer"><ErrorBoundary area="Explorer"><RepositoryExplorer onClose={() => attach("explorer")}/></ErrorBoundary></DetachedPanel>
      <DetachedPanel id="repositories"><ErrorBoundary area="Repositories"><RepositorySidebar/></ErrorBoundary></DetachedPanel>
      <ActiveRepositoryPanels attach={attach} prAllRepositories={prAllRepositories} />
    </div></WorkspaceLayoutContext.Provider>
  );
}

const closeExplorer = () => useSettings.getState().set({ explorerOpen: false });

function showMainChanges(root: string, path?: string) {
  useUi.setState({ repositoryOverview: false });
  useRepos.getState().patch(root, path ? { conflictPath: path, view: "changes", changeSel: { kind: "conflict", path } } : { view: "changes" });
  window.focus();
}

/** The shown repository's workspace: the only part of the main window that follows every
 *  change of the active tab. */
function ActiveRepositoryContent({ combinedPulls }: { combinedPulls: boolean }) {
  const tab = useRepos((s) => (s.active ? s.tabs[s.active] : null));
  return <ErrorBoundary area="This view" resetKey={tab?.root}>
    {tab ? <RepositoryContent key={combinedPulls ? "all-pull-requests" : tab.root} tab={tab} combinedPulls={combinedPulls} /> : <Welcome />}
  </ErrorBoundary>;
}

/** Panels of the shown repository that were moved to their own windows. */
function ActiveRepositoryPanels({ attach, prAllRepositories }: { attach: (id: PanelId) => void; prAllRepositories: boolean }) {
  const tab = useRepos((s) => (s.active ? s.tabs[s.active] : null));
  return <>
    <DetachedPanel id="branches">{tab?.info && <ErrorBoundary area="Branches" resetKey={tab.root}><Sidebar key={tab.root} tab={tab} onHide={() => attach("branches")}/></ErrorBoundary>}</DetachedPanel>
    <DetachedPanel id="history">{tab?.info && <ErrorBoundary area="History" resetKey={tab.root}><GraphView key={tab.root} tab={tab} onEnterChanges={() => showMainChanges(tab.root)}/></ErrorBoundary>}</DetachedPanel>
    <DetachedPanel id="commit">{tab?.selected && tab.selected !== WORKTREE ? <ErrorBoundary area="Commit details" resetKey={tab.selected}><CommitDetails key={tab.root} root={tab.root} oid={tab.selected} onClose={() => useRepos.getState().patch(tab.root, { selected: null, multi: [] })}/></ErrorBoundary> : null}</DetachedPanel>
    <DetachedPanel id="pulls">{tab && (tab.info || prAllRepositories) && <ErrorBoundary area="Pull requests" resetKey={tab.root}><Suspense fallback={null}><PullRequestsView key={prAllRepositories ? "all-pull-requests" : tab.root} tab={tab} remotesKey={repositoryRemotesKey(tab)}/></Suspense></ErrorBoundary>}</DetachedPanel>
    <DetachedPanel id="changes">{tab?.info && <ErrorBoundary area="Changes" resetKey={tab.root}><ChangesView key={tab.root} tab={tab} onOpenConflict={path => showMainChanges(tab.root, path)}/></ErrorBoundary>}</DetachedPanel>
    <DetachedPanel id="worktrees">{tab?.info && <ErrorBoundary area="Worktrees" resetKey={tab.root}><Suspense fallback={null}><WorktreeManager key={tab.root} root={tab.root} floating onClose={() => attach("worktrees")}/></Suspense></ErrorBoundary>}</DetachedPanel>
  </>;
}
