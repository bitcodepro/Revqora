import { createContext, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, PanelTop } from "lucide-react";
import { contextMenu, openOverlay, toast, useUi } from "../lib/ui";
import { registerUiSurface, surfaceDocument } from "../lib/uiSurfaces";
import { useSettings } from "../lib/settings";
import { useRepos } from "../lib/store";
import { workspaceMode } from "../lib/workspaceLayouts";

const panelNames = {
  workspaces: "Workspaces", repositories: "Repositories", branches: "Branches",
  history: "Commit history", commit: "Commit preview", changes: "Changes",
  pulls: "Pull requests", worktrees: "Worktree manager",
};
export type PanelId = keyof typeof panelNames;
type Panels = Partial<Record<PanelId, Window>>;
interface PanelWindows {
  panels: Panels;
  detach: (id: PanelId) => void;
  attach: (id: PanelId) => void;
}
const Context = createContext<PanelWindows>({ panels: {}, detach: () => {}, attach: () => {} });
export const usePanelWindows = () => useContext(Context);

export function PanelWindowsProvider({ children }: { children: ReactNode }) {
  const [panels, setPanels] = useState<Panels>({});
  const sessions = useRef(new Map<PanelId, { view: Window; close: () => void; check: () => void }>());
  const attach = (id: PanelId) => {
    const session = sessions.current.get(id);
    if (!session) return;
    session.close();
    const repos = useRepos.getState();
    const root = repos.active;
    const current = root ? repos.tabs[root] : null;
    const settings = useSettings.getState();
    const mode = workspaceMode(useUi.getState().repositoryOverview ? "overview" : current?.view, settings.historyMode);
    if (id === "workspaces") {
      settings.set({ workspacesOpen: true });
      settings.setLayout(mode, { focusMode: false });
    } else if (id === "repositories") {
      settings.setLayout(mode, { repositoriesOpen: true, focusMode: false });
    } else if (root && current) {
      useUi.setState({ repositoryOverview: false });
      if (id === "branches") settings.setLayout(workspaceMode(current.view, settings.historyMode), { branchesOpen: true, focusMode: false });
      else if (id === "worktrees") openOverlay({ kind: "worktrees", root });
      else {
        const view = id === "history" || id === "commit" ? "history" : id;
        repos.patch(root, { view });
        if (id === "history") settings.setLayout(workspaceMode(view, settings.historyMode), { focusMode: false });
      }
    }
    window.focus();
  };
  const detach = (id: PanelId) => {
    const existing = sessions.current.get(id);
    if (existing && !existing.view.closed) { existing.view.focus(); return; }
    existing?.close();
    let size = "";
    try { size = localStorage.getItem(`revqora:detached-size:${id}`) ?? ""; } catch { /* Defaults. */ }
    const [width, height] = size.split("x").map(Number);
    const view = window.open("about:blank", "_blank", `popup,width=${Math.max(380, Math.min(1800, width || 930))},height=${Math.max(280, Math.min(1400, height || 720))}`);
    if (!view) { toast.warning("Could not open a separate window"); return; }
    const started = performance.now();
    let doc: Document | null = null;
    const syncTheme = () => {
      if (!doc) return;
      doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
      doc.documentElement.style.cssText = document.documentElement.style.cssText;
    };
    const theme = new MutationObserver(syncTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    const unregister = registerUiSurface(view);
    const onContext = (event: MouseEvent) => {
      if (!(event.target as HTMLElement)?.closest?.("input, textarea, .cm-editor, .selectable, .code")) event.preventDefault();
    };
    const rememberSize = () => {
      if (view.innerWidth < 300 || view.innerHeight < 220) return;
      try { localStorage.setItem(`revqora:detached-size:${id}`, `${view.innerWidth}x${view.innerHeight}`); } catch { /* Optional. */ }
    };
    let resizeTimer: ReturnType<typeof setTimeout>;
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(rememberSize, 180); };
    const close = () => {
      if (sessions.current.get(id)?.view !== view) return;
      sessions.current.delete(id);
      theme.disconnect();
      unregister();
      clearTimeout(resizeTimer);
      view.removeEventListener("resize", onResize);
      doc?.removeEventListener("contextmenu", onContext);
      if (useUi.getState().menu?.surface === view) useUi.getState().closeMenu();
      useUi.getState().dialogs.filter(dialog => dialog.surface === view).forEach(dialog => dialog.resolve(null));
      if (!view.closed) { rememberSize(); view.close(); }
      setPanels(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    };
    const check = () => {
      if (view.closed) { close(); return; }
      const next = surfaceDocument(view);
      if (!next?.body) {
        if (performance.now() - started > 4000) { close(); toast.warning("Could not open a separate window"); }
        return;
      }
      if (doc === next) return;
      doc?.removeEventListener("contextmenu", onContext);
      doc = next;
      doc.title = `${panelNames[id]} · Revqora`;
      syncTheme();
      for (const sheet of document.head.querySelectorAll("style, link[rel=stylesheet]")) {
        const copy = doc.importNode(sheet, true);
        if (sheet instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = sheet.href;
        doc.head.append(copy);
      }
      doc.addEventListener("contextmenu", onContext);
      view.addEventListener("resize", onResize);
      setPanels(current => ({ ...current, [id]: view }));
      if (id === "workspaces") useSettings.getState().set({ workspacesOpen: true });
    };
    sessions.current.set(id, { view, close, check });
    check();
    view.focus();
  };
  useEffect(() => {
    const closeAll = () => [...sessions.current.values()].forEach(session => session.close());
    const poll = setInterval(() => {
      for (const session of sessions.current.values()) session.check();
    }, 500);
    window.addEventListener("beforeunload", closeAll);
    return () => { clearInterval(poll); window.removeEventListener("beforeunload", closeAll); closeAll(); };
  }, []);
  return <Context.Provider value={{ panels, detach, attach }}>{children}</Context.Provider>;
}

export function usePanelWindowMenu(hasRepository: boolean, hasCommit: boolean) {
  const { panels, attach, detach } = usePanelWindows();
  return (Object.keys(panelNames) as PanelId[]).map(id => ({
      label: panels[id] ? `Return ${panelNames[id]} to main window` : `Open ${panelNames[id]} in separate window`,
      icon: panels[id] ? <PanelTop size={14}/> : <ExternalLink size={14}/>,
      disabled: !panels[id] && (id === "commit" ? !hasCommit : id !== "workspaces" && id !== "repositories" && !hasRepository),
      onClick: () => panels[id] ? attach(id) : detach(id),
  }));
}

export function usePanelTitleMenu(id: PanelId) {
  const { panels, detach } = usePanelWindows();
  return (event: ReactMouseEvent<HTMLElement>) => {
    if (panels[id] || (event.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) return;
    contextMenu(event, [{ label: "Detach", icon: <ExternalLink size={14}/>, onClick: () => detach(id) }]);
  };
}

export function PanelWindowsButton({ hasRepository, hasCommit }: { hasRepository: boolean; hasCommit: boolean }) {
  const menu = usePanelWindowMenu(hasRepository, hasCommit);
  return <button type="button" className="icon-btn" title="Panels in separate windows" aria-label="Panels in separate windows"
    onClick={event => contextMenu(event, menu)}><ExternalLink size={16}/></button>;
}

export function DetachedPanel({ id, children }: { id: PanelId; children: ReactNode }) {
  const { panels, attach } = usePanelWindows();
  const target = panels[id];
  const body = target && surfaceDocument(target)?.body;
  if (!body) return null;
  return createPortal(<section className="detached-panel">
    <header onContextMenu={event => contextMenu(event, [{ label: "Attach", icon: <PanelTop size={14}/>, onClick: () => attach(id) }])}>
      <b>{panelNames[id]}</b><button type="button" className="btn sm" title="Attach to the main window" onClick={() => attach(id)}><PanelTop size={14}/> Return to main window</button>
    </header>
    <div className={`detached-content detached-${id}`}>{children ?? <div className="empty">Select a repository or commit in the main window.</div>}</div>
  </section>, body, id);
}

export function DetachedPlaceholder({ id }: { id: PanelId }) {
  const { panels, attach } = usePanelWindows();
  return <div className="empty detached-placeholder">
    <button type="button" className="btn" onClick={() => panels[id]?.focus()}>{panelNames[id]} is in a separate window</button>
    <button type="button" className="btn sm" onClick={() => attach(id)}>Return panel</button>
  </div>;
}
