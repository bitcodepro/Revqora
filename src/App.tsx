import { ActivityIndicator } from "./components/ActivityIndicator";
import { createStartupBarrier, type StartupPhase } from "./lib/startupReady";
import { restoreRepositorySession } from "./lib/restoreRepositorySession";
import { StackManager } from "./components/StackManager";
import { HistoryExplorer } from "./components/HistoryExplorer";
import { WorkflowBuilder } from "./components/WorkflowBuilder";
import { AgentWorkspace } from "./components/AgentWorkspace";
import { WorktreeManager } from "./components/WorktreeManager";
import { finishWorkspaceStartup, startWorkspaceTracking } from "./lib/repositoryWorkspaces";
import { useLibrary } from "./lib/repositoryLibrary";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Columns3, FilePlus2, GitBranch, GitCommitHorizontal, GitGraph, GitPullRequest, Maximize2, Minimize2, RefreshCw, Rows3 } from "lucide-react";
import { PullRequestsView } from "./components/PullRequests";
import { useRepos, type RepoTab } from "./lib/store";
import { resolvedTheme, useSettings } from "./lib/settings";
import { openOverlay, toast, updateBusy, updateRepositoryOperation, useUi, type RepositoryOperation } from "./lib/ui";
import { actionFor, comboFromEvent, shortcutTitle } from "./lib/shortcuts";
import { settingsDialog } from "./components/dialogs";
import { repoToolsDialog } from "./components/RepoTools";
import { Onboarding } from "./components/Onboarding";
import { GitMissing } from "./components/GitMissing";
import * as A from "./lib/actions";
import { api, errorMessage } from "./lib/api";
import { WORKTREE } from "./lib/types";
import { CommandPalette, OpBanner, StatusBar, TopBar, Welcome } from "./components/Shell";
import { ContextMenuHost, DialogHost, Splitter, ToastHost } from "./components/Overlays";
import { bindingFor, prettyCombo } from "./lib/shortcuts";
import { Sidebar } from "./components/Sidebar";
import { GraphView } from "./components/GraphView";
import { CommitDetails } from "./components/CommitDetails";
import { ChangesView } from "./components/ChangesView";
import { ConflictEditor } from "./components/ConflictEditor";
import { AskpassHost } from "./components/Askpass";
import { BlameView } from "./components/BlameView";
import { CompareView } from "./components/CompareView";
import { branchCommitCompare } from "./components/BranchCommitCompare";
import { BranchManager } from "./components/BranchManager";
import { RebaseView } from "./components/RebaseView";
import { StashView } from "./components/StashView";
import { TreeBrowser } from "./components/TreeBrowser";
import { startUpdateChecks } from "./lib/update";
import { createAutoFetch, defaultFetch } from "./lib/autofetch";
import { useBackgroundPoll } from "./lib/backgroundPolling";
import { checkPullRequestActivity, resetPullRequestActivity } from "./lib/prTracking";
import { RepositoryOverview, RepositorySidebar } from "./components/Repositories";
import { HISTORY_MODES, workspaceMode } from "./lib/workspaceLayouts";
import { WorkspaceLayoutContext, useWorkspaceLayout } from "./lib/workspaceLayoutContext";
import "./styles/workspace.css";

function useAppearance() {
  const s = useSettings();
  useEffect(() => {
    const apply = () => {
      const t = resolvedTheme(s.theme);
      document.documentElement.dataset.theme = t;
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

function RepositoryContent({ tab }: { tab: RepoTab }) {
  if (!tab.info) return <div className="repository-opening" role="status">
    <h2>{tab.root.split(/[\\/]/).filter(Boolean).at(-1)}</h2>
    <p>{tab.error ? "Repository unavailable" : "Opening repository…"}</p>
    <code>{tab.root}</code>
    {tab.error && <><p role="alert">{tab.error}</p><button type="button" className="btn" onClick={() => void A.openRepoPath(tab.root)}>Try again</button></>}
  </div>;
  return <RepoWorkspace tab={tab} />;
}

function RepoWorkspace({ tab }: { tab: RepoTab }) {
  const root = tab.root;
  const overlay = useUi((s) => (s.overlay && s.overlay.root === tab.root ? s.overlay : null));
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
  const showBranches = branchesOpen && !focusMode;
  const changesCount = tab.status?.files.length ?? 0;
  const [forgeKind, setForgeKind] = useState<string | null>(null);
  const remotesKey = JSON.stringify(tab.refs?.remotes.map(({ name, fetchUrl }) => [name, fetchUrl]) ?? []);
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

  const commitSelected = tab.selected && tab.selected !== WORKTREE ? tab.selected : null;
  const closePreview = () => {
    patch(root, { selected: null, multi: [] });
    setLayout({ focusMode: false });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".review .graph-scroll, .columns-commits .graph-scroll")?.focus({ preventScroll: true }));
  };

  return (
    <div className="workspace" style={{ ["--sidebar-w" as string]: `${showBranches ? sw : 0}px` }}>
      <div className="branches-slot" hidden={!showBranches}><Sidebar tab={tab} /></div>
      {showBranches && <Splitter dir="v" style={{ left: sw }} onDrag={(d) => setSw((w) => Math.max(180, Math.min(420, w + d)))} onEnd={() => setLayout({ sidebarWidth: sw })} />}
      <div className="main">
        <div className="main-head">
          <button className={`btn sm branches-toggle ${showBranches ? "active" : ""}`} aria-expanded={showBranches} title="Toggle branches panel" onClick={() => setLayout({ branchesOpen: !showBranches, focusMode: false })}><GitBranch size={13} /> Branches</button>
          <div className="view-tabs">
            <button className={`view-tab ${tab.view === "history" ? "on" : ""}`} onClick={() => patch(root, { view: "history" })} title={shortcutTitle("History", "history")}>
              <GitCommitHorizontal size={15} /> History
            </button>
            <button className={`view-tab ${tab.view === "changes" ? "on" : ""}`} onClick={() => patch(root, { view: "changes" })} title={shortcutTitle("Changes", "changes")}>
              <FilePlus2 size={15} /> Changes
              {changesCount > 0 && <span className={`pill ${conflicts ? "red" : "accent"}`}>{changesCount}</span>}
            </button>
          </div>
          {forgeKind && (
            <button className={`view-tab ${tab.view === "pulls" ? "on" : ""}`} onClick={() => patch(root, { view: "pulls" })} title={shortcutTitle("Pull requests", "pulls")}>
              <GitPullRequest size={15} /> {forgeKind === "gitlab" ? "Merge requests" : "Pull requests"}
            </button>
          )}
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
          <button className="icon-btn" title={shortcutTitle("Refresh", "refresh")} onClick={() => useRepos.getState().refresh(root)}>
            <RefreshCw size={15} />
          </button>
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
          <div className={`review ${focusMode && commitSelected ? "review-focused" : ""}`} style={{ gridTemplateRows: focusMode || !commitSelected ? "minmax(0, 1fr)" : `minmax(100px, min(${rh}px, 45%)) minmax(0, 1fr)` }}>
            <div className="review-list" hidden={focusMode && !!commitSelected}>
              <GraphView tab={tab} compact onEnterChanges={() => patch(root, { view: "changes" })} />
            </div>
            {!focusMode && commitSelected && <div className="review-resizer"><Splitter dir="h" onDrag={(d) => setRh((h) => Math.max(100, Math.min(400, h + d)))} onEnd={() => setLayout({ reviewListHeight: rh })} /></div>}
            {commitSelected && <div key="commit-preview" className="details review-details">
              <CommitDetails root={root} oid={commitSelected} onClose={closePreview} />
            </div>}
          </div>
        ) : tab.view === "history" && historyMode === "columns" ? (
          <div className="columns-history" style={{ ["--history-list-w" as string]: `${cw}px` }}>
            <div className="columns-commits"><GraphView tab={tab} compact onEnterChanges={() => patch(root, { view: "changes" })} /></div>
            <Splitter dir="v" style={{ left: "var(--history-list-size)" }} onDrag={(d) => setCw((w) => Math.max(180, Math.min(600, w + d)))} onEnd={() => setLayout({ historyListWidth: cw })} />
            {commitSelected ? (
              <div key="commit-preview" className="details columns-details"><CommitDetails root={root} oid={commitSelected} compactMeta onClose={closePreview} /></div>
            ) : (
              <div className="empty columns-placeholder">
                <span className="big"><GitCommitHorizontal size={24} /></span>
                <span>Select a commit to see its files and changes.</span>
              </div>
            )}
          </div>
        ) : tab.view === "history" ? (
          <div className="history">
            <GraphView tab={tab} onEnterChanges={() => patch(root, { view: "changes" })} />
            {commitSelected && (
              <>
                <Splitter dir="h" onDrag={(d) => setDh((h) => Math.max(160, Math.min(window.innerHeight - 260, h - d)))} onEnd={() => setLayout({ detailsHeight: dh })} />
                <div className="details" style={{ height: dh }}>
                  <CommitDetails root={root} oid={commitSelected} onClose={() => patch(root, { selected: null, multi: [] })} />
                </div>
              </>
            )}
          </div>
        ) : tab.view === "pulls" ? (
          <PullRequestsView tab={tab} />
        ) : (
          <ChangesView tab={tab} onOpenConflict={openConflict} />
        )}
        {tab.conflictPath && <ConflictEditor key={`${root}:${tab.conflictPath}`} root={root} path={tab.conflictPath} onClose={() => patch(root, { conflictPath: null })} />}
        {overlay?.kind === "blame" && <BlameView root={root} path={overlay.path} rev={overlay.rev} line={overlay.line} />}
        {overlay?.kind === "branches" && <BranchManager key={root} root={root} />}
        {overlay?.kind === "worktrees" && <WorktreeManager key={root} root={root} />}
        {overlay?.kind === "stacks" && <StackManager key={root} root={root}/>}
        {overlay?.kind === "historyExplorer" && <HistoryExplorer key={root} root={root}/>}
        {overlay?.kind === "workflows" && <WorkflowBuilder key={root} root={root} pull={overlay.pull} />}
        {overlay?.kind === "agents" && <AgentWorkspace key={root} root={root} />}
        {overlay?.kind === "stash" && <StashView key={`${overlay.root}:${overlay.oid}`} root={overlay.root} index={overlay.index} oid={overlay.oid} />}
        {overlay?.kind === "tree" && <TreeBrowser key={overlay.rev} root={root} rev={overlay.rev} />}
        {overlay?.kind === "rebase" && <RebaseView key={overlay.oldest} root={root} oldest={overlay.oldest} />}
        {overlay?.kind === "compare" && <CompareView key={`${overlay.from}..${overlay.to}`} root={root} from={overlay.from} to={overlay.to} direct={overlay.direct} />}
      </div>
    </div>
  );
}

const quietFetch = createAutoFetch({
  fetch: defaultFetch,
  refresh: (root) => {
    useRepos.getState().patch(root, { lastFetchedAt: Date.now(), fetchError: null });
    return useRepos.getState().refresh(root, { background: true, revalidate: true, info: true, status: true, refs: true });
  },
  failed: (root, e) => useRepos.getState().patch(root, { fetchError: errorMessage(e) }),
  busy: () => useUi.getState().busy.length > 0 || useUi.getState().repositoryOperations.length > 0 || Object.values(useRepos.getState().tabs).some((t) => t.pendingMutations > 0),
});

/** Fetches open repositories in the background (Settings → Git auto-fetch). */
function useAutoFetch() {
  const minutes = useSettings((s) => s.autoFetchMinutes);
  useBackgroundPoll(minutes, async current => {
    const { active, order } = useRepos.getState();
    const roots = new Set(active ? [active, ...order] : order);
    for (const root of roots) {
      if (!current()) return;
      if (useRepos.getState().tabs[root]?.info) await quietFetch(root);
    }
  });
}

export default function App() {
  useAppearance();
  useEffect(startUpdateChecks, []);
  useAutoFetch();
  const prPollMinutes = useSettings(s => s.prPollMinutes);
  const prWatches = useSettings(s => s.prWatches);
  useBackgroundPoll(prPollMinutes, checkPullRequestActivity, Object.keys(prWatches).length > 0, prWatches);
  useEffect(() => {
    window.addEventListener("revqora:forge-accounts", resetPullRequestActivity);
    return () => window.removeEventListener("revqora:forge-accounts", resetPullRequestActivity);
  }, []);
  const tab = useRepos((s) => (s.active ? s.tabs[s.active] : null));
  const pending = useRepos((s) => Object.values(s.tabs).some((t) => t.pendingMutations > 0));
  const busy = useUi((s) => s.busy.length > 0 || s.repositoryOperations.some(op => op.command !== "fetch_background")) || pending;
  const [dropping, setDropping] = useState(false);
  const restored = useRef(false);
  const [startupPhase, setStartupPhase] = useState<StartupPhase>("restoring");
  const startup = useRef<ReturnType<typeof createStartupBarrier> | null>(null);
  if (!startup.current) startup.current = createStartupBarrier(setStartupPhase, error => toast.error(error, "Could not register repository opening"));
  const overview = useUi((s) => s.repositoryOverview);
  const historyMode = useSettings((s) => s.historyMode);
  const layoutMode = workspaceMode(overview ? "overview" : tab?.view, historyMode);
  const { layout } = useWorkspaceLayout(layoutMode);
  const { focusMode, repositoriesOpen } = layout;
  const repositoryCount = useRepos((s) => s.order.length);
  const hasBookmarks = useLibrary((s) => s.knownRoots.length > 0);
  const repositoryScope = useLibrary((s) => s.activeWorkspaceId) ?? "all";

  useEffect(startWorkspaceTracking, []);
  // Restore the tabs from the previous session.
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    (async () => {
      // Publish the entire roster before asynchronous Git discovery begins.
      void restoreRepositorySession();
      finishWorkspaceStartup();
      const initial = useRepos.getState().selectionVersion;
      const paths = await api.startupPaths().catch(() => [] as string[]);
      if (paths.length) void useRepos.getState().openMany(paths, useRepos.getState().selectionVersion === initial ? paths.at(-1) : undefined);
    })().then(() => startup.current!.restored(), error => toast.error(error, "Could not restore repository session"));
  }, []);

  // Backend events.
  useEffect(() => {
    const unsubs: Promise<() => void>[] = [];
    unsubs.push(
      listen<{ repo: string; git: boolean; worktree: boolean }>("repo-changed", (e) => {
        const { repo, git } = e.payload;
        if (!useRepos.getState().tabs[repo]) return;
        useRepos.getState().refresh(repo, git ? { background: true, info: true, status: true, refs: true, layers: true, graph: true } : { background: true, status: true, layers: true });
        window.dispatchEvent(new CustomEvent("revqora:worktree", { detail: { repo } }));
      }),
    );
    unsubs.push(listen<{ opId: string; line: string }>("op-progress", (e) => updateBusy(e.payload.opId, e.payload.line)));
    unsubs.push(listen<RepositoryOperation>("repository-operation", (e) => {
      updateRepositoryOperation(e.payload);
      if (e.payload.command === "fetch_background") return;
      if (e.payload.phase === "finished" || e.payload.phase === "failed") {
        // Shared refs can change in another worktree. Refresh all open views.
        for (const root of useRepos.getState().order) {
          if (root === e.payload.repo || useRepos.getState().tabs[root]?.info?.commonDir === e.payload.repositoryKey) void useRepos.getState().refresh(root);
        }
      }
    }));
    const disposeOpenPaths = startup.current!.listener(listen<string[]>("open-paths", (e) => e.payload.forEach((p) => A.openRepoPath(p))));
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
      disposeOpenPaths();
      unsubs.forEach((u) => u.then((f) => f()));
    };
  }, []);

  // Refresh when the window regains focus (changes made in other tools).
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - last < 1500) return;
      last = now;
      const a = useRepos.getState().active;
      if (a) useRepos.getState().refresh(a, { info: true, status: true, refs: true, layers: true });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Global shortcuts (rebindable in Settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, .cm-editor");
      if (typing && !e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
      const id = actionFor(combo);
      if (!id) return;
      const st = useRepos.getState();
      const a = st.active;
      const t = a ? st.tabs[a] : null;
      const mode = workspaceMode(useUi.getState().repositoryOverview ? "overview" : t?.view, useSettings.getState().historyMode);
      const layout = useSettings.getState().layouts[mode];
      const run: Record<string, () => void> = {
        palette: () => useUi.getState().setPalette(true),
        paletteAlternate: () => useUi.getState().setPalette(true),
        open: () => A.openRepoDialog(),
        refresh: () => useUi.getState().repositoryOverview ? void Promise.allSettled(st.order.map((r) => st.refresh(r))) : a && st.refresh(a),
        overview: () => useUi.setState({ repositoryOverview: true }),
        repositoriesPanel: () => useSettings.getState().setLayout(mode, { repositoriesOpen: !layout.repositoriesOpen, focusMode: false }),
        branchesPanel: () => useSettings.getState().setLayout(mode, { branchesOpen: !layout.branchesOpen, focusMode: false }),
        focusMode: () => useSettings.getState().setLayout(mode, { focusMode: !layout.focusMode }),
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
          s.set({ theme: resolvedTheme(s.theme) === "dark" ? "light" : "dark" });
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
        if (["history", "changes", "pulls", "reviewMode"].includes(id)) useUi.setState({ repositoryOverview: false });
        run[id]();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      <TopBar />
      <ActivityIndicator active={busy} />
      <div className="app-body">
        <div className="repository-slot" hidden={!repositoriesOpen || focusMode || (!repositoryCount && !hasBookmarks)}><RepositorySidebar key={repositoryScope} /></div>
        <div className="workspace-host">{overview ? <RepositoryOverview key={repositoryScope} /> : tab ? <RepositoryContent key={tab.root} tab={tab} /> : <Welcome />}</div>
      </div>
      <StatusBar />
      <ContextMenuHost />
      <DialogHost />
      <CommandPalette />
      <ToastHost />
      <AskpassHost />
      <GitMissing />
      <Onboarding />
      {dropping && <div className="drop-hint">Drop a folder to open it</div>}
    </div></WorkspaceLayoutContext.Provider>
  );
}
