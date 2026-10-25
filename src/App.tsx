import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Columns3, FilePlus2, GitCommitHorizontal, GitGraph, GitPullRequest, RefreshCw } from "lucide-react";
import { PullRequestsView } from "./components/PullRequests";
import { useRepos, type RepoTab } from "./lib/store";
import { resolvedTheme, useSettings } from "./lib/settings";
import { openOverlay, updateBusy, useUi } from "./lib/ui";
import { actionFor, comboFromEvent } from "./lib/shortcuts";
import { settingsDialog } from "./components/dialogs";
import { repoToolsDialog } from "./components/RepoTools";
import { Onboarding } from "./components/Onboarding";
import { GitMissing } from "./components/GitMissing";
import * as A from "./lib/actions";
import { api } from "./lib/api";
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
import { RebaseView } from "./components/RebaseView";
import { StashView } from "./components/StashView";
import { TreeBrowser } from "./components/TreeBrowser";
import { startUpdateChecks } from "./lib/update";

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
  const sidebarW = useSettings((s) => s.sidebarWidth);
  const detailsH = useSettings((s) => s.detailsHeight);
  const setS = useSettings((s) => s.set);
  const [sw, setSw] = useState(sidebarW);
  const [dh, setDh] = useState(detailsH);
  const historyMode = useSettings((s) => s.historyMode);
  const reviewW = useSettings((s) => s.reviewListWidth);
  const [rw, setRw] = useState(reviewW);
  const changesCount = tab.status?.files.length ?? 0;
  const [forgeKind, setForgeKind] = useState<string | null>(null);
  const remotesKey = tab.refs?.remotes.map((r) => r.fetchUrl).join("|") ?? "";
  useEffect(() => {
    api.forgeInfo(root).then((f) => setForgeKind(f?.kind ?? null), () => setForgeKind(null));
  }, [root, remotesKey]);
  const conflicts = tab.status?.conflictCount ?? 0;

  const openConflict = (path: string) => patch(root, { conflictPath: path, view: "changes", changeSel: { kind: "conflict", path } });

  const commitSelected = tab.selected && tab.selected !== WORKTREE ? tab.selected : null;

  return (
    <div className="workspace" style={{ ["--sidebar-w" as string]: `${sw}px` }}>
      <Sidebar tab={tab} />
      <Splitter dir="v" style={{ left: sw }} onDrag={(d) => setSw((w) => Math.max(200, Math.min(520, w + d)))} onEnd={() => setS({ sidebarWidth: sw })} />
      <div className="main">
        <div className="main-head">
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
            <div className="seg history-mode" title={`Graph or Review layout (${prettyCombo(bindingFor("reviewMode"))})`}>
              {(["graph", "review"] as const).map((m) => (
                <button key={m} type="button" className={historyMode === m ? "on" : ""} onClick={() => setS({ historyMode: m })}>
                  {m === "graph" ? <GitGraph size={13} /> : <Columns3 size={13} />} {m === "graph" ? "Graph" : "Review"}
                </button>
              ))}
            </div>
          )}
          <button className="icon-btn" title="Refresh (F5)" onClick={() => useRepos.getState().refresh(root)}>
            <RefreshCw size={15} />
          </button>
        </div>
        <OpBanner tab={tab} onResolve={openConflict} />
        {tab.view === "history" && historyMode === "review" ? (
          <div className="review" style={{ gridTemplateColumns: `${rw}px minmax(0, 1fr)` }}>
            <div className="review-list">
              <GraphView tab={tab} compact onEnterChanges={() => patch(root, { view: "changes" })} />
            </div>
            <Splitter dir="v" style={{ left: rw }} onDrag={(d) => setRw((w) => Math.max(240, Math.min(640, w + d)))} onEnd={() => setS({ reviewListWidth: rw })} />
            <div className="details review-details">
              {commitSelected ? (
                <CommitDetails root={root} oid={commitSelected} />
              ) : (
                <div className="empty">
                  <h3>Select a commit</h3>
                  <div>↑ / ↓ move between commits, Alt+↑ / Alt+↓ between files, F7 to the next change.</div>
                </div>
              )}
            </div>
          </div>
        ) : tab.view === "history" ? (
          <div className="history">
            <GraphView tab={tab} onEnterChanges={() => patch(root, { view: "changes" })} />
            {commitSelected && (
              <>
                <Splitter dir="h" onDrag={(d) => setDh((h) => Math.max(160, Math.min(window.innerHeight - 260, h - d)))} onEnd={() => setS({ detailsHeight: dh })} />
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
        {tab.conflictPath && <ConflictEditor key={tab.conflictPath} root={root} path={tab.conflictPath} onClose={() => patch(root, { conflictPath: null })} />}
        {overlay?.kind === "blame" && <BlameView root={root} path={overlay.path} rev={overlay.rev} line={overlay.line} />}
        {overlay?.kind === "stash" && <StashView key={overlay.index} root={root} index={overlay.index} />}
        {overlay?.kind === "tree" && <TreeBrowser key={overlay.rev} root={root} rev={overlay.rev} />}
        {overlay?.kind === "rebase" && <RebaseView key={overlay.oldest} root={root} oldest={overlay.oldest} />}
        {overlay?.kind === "compare" && <CompareView key={`${overlay.from}..${overlay.to}`} root={root} from={overlay.from} to={overlay.to} />}
      </div>
    </div>
  );
}

/** Fetches the open repositories in the background every few minutes (Settings → Auto fetch). */
function useAutoFetch() {
  const minutes = useSettings((s) => s.autoFetchMinutes);
  useEffect(() => {
    if (!minutes) return;
    const id = setInterval(() => {
      for (const root of Object.keys(useRepos.getState().tabs)) void A.quietFetch(root);
    }, minutes * 60_000);
    return () => clearInterval(id);
  }, [minutes]);
}

export default function App() {
  useAppearance();
  useEffect(startUpdateChecks, []);
  useAutoFetch();
  const tab = useRepos((s) => (s.active ? s.tabs[s.active] : null));
  const busy = useUi((s) => s.busy.length > 0);
  const [dropping, setDropping] = useState(false);
  const restored = useRef(false);

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
      const run: Record<string, () => void> = {
        palette: () => useUi.getState().setPalette(true),
        open: () => A.openRepoDialog(),
        refresh: () => a && st.refresh(a),
        history: () => a && st.patch(a, { view: "history" }),
        changes: () => a && st.patch(a, { view: "changes" }),
        pulls: () => a && st.patch(a, { view: "pulls" }),
        reviewMode: () => {
          const s = useSettings.getState();
          s.set({ historyMode: s.historyMode === "review" ? "graph" : "review" });
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
    <div className="app">
      <TopBar />
      {busy && <div className="progress-bar" />}
      <div style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>{tab ? <RepoWorkspace key={tab.root} tab={tab} /> : <Welcome />}</div>
      <StatusBar />
      <ContextMenuHost />
      <DialogHost />
      <CommandPalette />
      <ToastHost />
      <AskpassHost />
      <GitMissing />
      <Onboarding />
      {dropping && <div className="drop-hint">Drop a folder to open it</div>}
    </div>
  );
}
