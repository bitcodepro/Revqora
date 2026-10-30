import { WorktreeManager } from "./components/WorktreeManager";
import { finishWorkspaceStartup, startWorkspaceTracking } from "./lib/repositoryWorkspaces";
import { useLibrary } from "./lib/repositoryLibrary";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Columns3, FilePlus2, GitBranch, GitCommitHorizontal, GitGraph, GitPullRequest, Maximize2, Minimize2, RefreshCw, Rows3 } from "lucide-react";
import { PullRequestsView } from "./components/PullRequests";
import { useRepos, type RepoTab } from "./lib/store";
import { resolvedTheme, useSettings } from "./lib/settings";
import { openOverlay, updateBusy, updateRepositoryOperation, useUi, type RepositoryOperation } from "./lib/ui";
import { actionFor, comboFromEvent } from "./lib/shortcuts";
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
import { BranchManager } from "./components/BranchManager";
import { RebaseView } from "./components/RebaseView";
import { StashView } from "./components/StashView";
import { TreeBrowser } from "./components/TreeBrowser";
import { startUpdateChecks } from "./lib/update";
import { createAutoFetch, defaultFetch } from "./lib/autofetch";
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
  const remotesKey = tab.refs?.remotes.map((r) => r.fetchUrl).join("|") ?? "";
  useEffect(() => {
    api.forgeInfo(root).then((f) => setForgeKind(f?.kind ?? null), () => setForgeKind(null));
  }, [root, remotesKey]);
  const conflicts = tab.status?.conflictCount ?? 0;

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
            <button className={`view-tab ${tab.view === "history" ? "on" : ""}`} onClick={() => patch(root, { view: "history" })} title="Ctrl+1">
              <GitCommitHorizontal size={15} /> History
            </button>
            <button className={`view-tab ${tab.view === "changes" ? "on" : ""}`} onClick={() => patch(root, { view: "changes" })} title="Ctrl+2">
              <FilePlus2 size={15} /> Changes
              {changesCount > 0 && <span className={`pill ${conflicts ? "red" : "accent"}`}>{changesCount}</span>}
            </button>
          </div>
          {forgeKind && (
            <button className={`view-tab ${tab.view === "pulls" ? "on" : ""}`} onClick={() => patch(root, { view: "pulls" })} title="Ctrl+3">
              <GitPullRequest size={15} /> {forgeKind === "gitlab" ? "Merge requests" : "Pull requests"}
            </button>
          )}
          <div className="spacer" />
          {tab.view === "history" && (
            <div className="seg history-mode" title={`History layout (${prettyCombo(bindingFor("reviewMode"))})`}>
              {HISTORY_MODES.map((m) => (
                <button key={m} type="button" className={historyMode === m ? "on" : ""} onClick={() => setS({ historyMode: m })}>
                  {m === "graph" ? <GitGraph size={13} /> : m === "review" ? <Rows3 size={13} /> : <Columns3 size={13} />} {m === "graph" ? "Graph" : m === "review" ? "Review" : "Columns"}
                </button>
              ))}
            </div>
          )}
          <button className={`icon-btn focus-toggle ${focusMode ? "active" : ""}`} title={focusMode ? "Exit focus mode" : "Focus on code"} aria-label={focusMode ? "Exit focus mode" : "Focus on code"} aria-pressed={focusMode} onClick={() => setLayout({ focusMode: !focusMode })}>{focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          <button className="icon-btn" title="Refresh (F5)" onClick={() => useRepos.getState().refresh(root)}>
            <RefreshCw size={15} />
          </button>
        </div>
        <OpBanner tab={tab} onResolve={openConflict} />
        {tab.view === "history" && historyMode === "review" ? (
          <div className={`review ${focusMode && commitSelected ? "review-focused" : ""}`} style={{ gridTemplateRows: focusMode || !commitSelected ? "minmax(0, 1fr)" : `minmax(100px, min(${rh}px, 45%)) minmax(0, 1fr)` }}>
            <div className="review-list" hidden={focusMode && !!commitSelected}>
              <GraphView tab={tab} compact onEnterChanges={() => patch(root, { view: "changes" })} />
            </div>
            {!focusMode && commitSelected && <div className="review-resizer"><Splitter dir="h" onDrag={(d) => setRh((h) => Math.max(100, Math.min(400, h + d)))} onEnd={() => setLayout({ reviewListHeight: rh })} /></div>}
            {commitSelected && <div className="details review-details">
              <CommitDetails root={root} oid={commitSelected} onClose={closePreview} />
            </div>}
          </div>
        ) : tab.view === "history" && historyMode === "columns" ? (
          <div className="columns-history" style={{ ["--history-list-w" as string]: `${cw}px`, gridTemplateColumns: commitSelected ? "clamp(180px, var(--history-list-w), 35%) minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
            <div className="columns-commits"><GraphView tab={tab} compact onEnterChanges={() => patch(root, { view: "changes" })} /></div>
            {commitSelected && <>
              <Splitter dir="v" style={{ left: "clamp(180px, var(--history-list-w), 35%)" }} onDrag={(d) => setCw((w) => Math.max(180, Math.min(600, w + d)))} onEnd={() => setLayout({ historyListWidth: cw })} />
              <div className="details columns-details"><CommitDetails root={root} oid={commitSelected} compactMeta onClose={closePreview} /></div>
            </>}
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
        {overlay?.kind === "stash" && <StashView key={overlay.index} root={root} index={overlay.index} />}
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
    return useRepos.getState().refresh(root, { info: true, status: true, refs: true, graph: useRepos.getState().active === root });
  },
  failed: (root, e) => useRepos.getState().patch(root, { fetchError: errorMessage(e) }),
  busy: () => useUi.getState().busy.length > 0 || useUi.getState().repositoryOperations.length > 0 || Object.values(useRepos.getState().tabs).some((t) => t.pendingMutations > 0),
});

/** Fetches the open repositories in the background every few minutes (Settings → Auto fetch). */
function useAutoFetch() {
  const minutes = useSettings((s) => s.autoFetchMinutes);
  useEffect(() => {
    if (!minutes) return;
    const id = setInterval(() => {
      for (const root of Object.keys(useRepos.getState().tabs)) void quietFetch(root);
    }, minutes * 60_000);
    return () => clearInterval(id);
  }, [minutes]);
}

export default function App() {
  useAppearance();
  useEffect(startUpdateChecks, []);
  useAutoFetch();
  const tab = useRepos((s) => (s.active ? s.tabs[s.active] : null));
  const pending = useRepos((s) => Object.values(s.tabs).some((t) => t.pendingMutations > 0));
  const busy = useUi((s) => s.busy.length > 0 || s.repositoryOperations.length > 0) || pending;
  const [dropping, setDropping] = useState(false);
  const restored = useRef(false);
  const overview = useUi((s) => s.repositoryOverview);
  const historyMode = useSettings((s) => s.historyMode);
  const layoutMode = workspaceMode(overview ? "overview" : tab?.view, historyMode);
  const { layout } = useWorkspaceLayout(layoutMode);
  const { focusMode, repositoriesOpen } = layout;
  const repositoryCount = useRepos((s) => s.order.length);
  const hasBookmarks = useLibrary((s) => s.favorites.length > 0 || s.groups.some((g) => g.roots.length > 0));

  useEffect(startWorkspaceTracking, []);
  // Restore the tabs from the previous session.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const { openTabs, activeTab } = useSettings.getState();
    (async () => {
      for (const p of openTabs) {
        try {
          await useRepos.getState().open(p, false);
        } catch {
          /* folder moved or deleted */
        }
      }
      const order = useRepos.getState().order;
      let want = activeTab && order.find((r) => r.toLowerCase() === activeTab.toLowerCase());
      for (const p of await api.startupPaths().catch(() => [] as string[])) {
        try {
          want = (await useRepos.getState().open(p, false)) ?? want;
        } catch {
          /* not a repository */
        }
      }
      useRepos.getState().activate(want ?? useRepos.getState().order[0] ?? null);
      finishWorkspaceStartup();
    })();
  }, []);

  // Backend events.
  useEffect(() => {
    const unsubs: Promise<() => void>[] = [];
    unsubs.push(
      listen<{ repo: string; git: boolean; worktree: boolean }>("repo-changed", (e) => {
        const { repo, git } = e.payload;
        if (!useRepos.getState().tabs[repo]) return;
        useRepos.getState().refresh(repo, git ? { info: true, status: true, refs: true, layers: true, graph: true } : { status: true, layers: true });
        window.dispatchEvent(new CustomEvent("revqora:worktree", { detail: { repo } }));
      }),
    );
    unsubs.push(listen<{ opId: string; line: string }>("op-progress", (e) => updateBusy(e.payload.opId, e.payload.line)));
    unsubs.push(listen<RepositoryOperation>("repository-operation", (e) => {
      updateRepositoryOperation(e.payload);
      if (e.payload.phase === "finished" || e.payload.phase === "failed") {
        // Shared refs can change in another worktree. Refresh all open views.
        for (const root of useRepos.getState().order) {
          if (root === e.payload.repo || useRepos.getState().tabs[root]?.info?.commonDir === e.payload.repositoryKey) void useRepos.getState().refresh(root);
        }
      }
    }));
    unsubs.push(listen<string[]>("open-paths", (e) => e.payload.forEach((p) => A.openRepoPath(p))));
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
      const combo = comboFromEvent(e);
      if (!combo) return;
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, .cm-editor");
      if (typing && !e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
      const id = actionFor(combo) ?? (combo === "Ctrl+Shift+P" ? "palette" : null);
      if (!id) return;
      const st = useRepos.getState();
      const a = st.active;
      const t = a ? st.tabs[a] : null;
      const mode = workspaceMode(useUi.getState().repositoryOverview ? "overview" : t?.view, useSettings.getState().historyMode);
      const layout = useSettings.getState().layouts[mode];
      const run: Record<string, () => void> = {
        palette: () => useUi.getState().setPalette(true),
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
        compare: () => {
          if (!a) return;
          const cur = t?.info?.head.branch ?? "HEAD";
          openOverlay({ kind: "compare", root: a, from: cur, to: t?.refs?.local.find((b) => b.name !== cur)?.name ?? "HEAD" });
        },
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
    <WorkspaceLayoutContext.Provider value={layoutMode}><div className="app">
      <TopBar />
      {busy && <div className="progress-bar" />}
      <div className="app-body">
        <div className="repository-slot" hidden={!repositoriesOpen || focusMode || (!repositoryCount && !hasBookmarks)}><RepositorySidebar /></div>
        <div className="workspace-host">{overview && repositoryCount ? <RepositoryOverview /> : tab ? <RepoWorkspace key={tab.root} tab={tab} /> : <Welcome />}</div>
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
