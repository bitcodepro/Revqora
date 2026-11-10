import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FolderKanban, LayoutGrid, Search, Star, X } from "lucide-react";
import { useLibrary } from "../lib/repositoryLibrary";
import { dropWorkspaceRepositories, openAllWorkspaces, switchWorkspace } from "../lib/repositoryWorkspaces";
import { useSettings } from "../lib/settings";
import { toast, useUi } from "../lib/ui";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { Splitter } from "./Overlays";
import { repositoryLibraryDialog } from "./RepositoryLibrary";

export function WorkspacesSidebar({ onClose }: { onClose: () => void }) {
  const workspaces = useLibrary(s => s.workspaces);
  const active = useLibrary(s => s.activeWorkspaceId);
  const favorites = useLibrary(s => s.favoriteWorkspaceIds);
  const busy = useUi(s => s.busy.length > 0 || s.repositoryOperations.length > 0);
  const favoritesOnly = useSettings(s => s.workspaceFavoritesOnly);
  const [query, setQuery] = useState("");
  const { layout, setLayout } = useWorkspaceLayout();
  const [width, setWidth] = useState(layout.workspacesWidth);
  useEffect(() => setWidth(layout.workspacesWidth), [layout.workspacesWidth]);
  const filter = query.trim().toLowerCase();
  const rows = workspaces.filter(w => (!favoritesOnly || favorites.includes(w.id)) && w.name.toLowerCase().includes(filter));
  const open = async (id: string) => {
    try {
      const errors = await switchWorkspace(id);
      if (errors.length) toast.warning("Workspace could not open every repository", errors.join("\n"));
    } catch (error) { toast.error(error); }
  };

  return <aside className="repository-sidebar workspace-sidebar" aria-label="Workspaces" style={{ width }}>
    <header><FolderKanban size={15}/><b>Workspaces</b><span className="pill">{workspaces.length}</span><div className="spacer"/><button type="button" className="icon-btn sm" aria-label="Hide Workspaces" onClick={onClose}><X size={13}/></button></header>
    <div className="repository-filter input-wrap"><Search size={13}/><input className="input sm" aria-label="Find workspace" placeholder="Find workspace…" value={query} onChange={e => setQuery(e.target.value)}/></div>
    <button type="button" className={`repository-updates ${favoritesOnly ? "active" : ""}`} aria-pressed={favoritesOnly} onClick={() => useSettings.getState().set({ workspaceFavoritesOnly: !favoritesOnly })}>Favorites</button>
    <button type="button" className={`repository-overview-link ${active === null ? "active" : ""}`} aria-current={active === null} disabled={busy} onClick={openAllWorkspaces}><LayoutGrid size={14}/> All Workspaces</button>
    <div className="repository-list" role="list" aria-label="Saved workspaces">
      {rows.map(w => <div role="listitem" className={`repository-item ${active === w.id ? "active" : ""}`} key={w.id} data-workspace-drop={!busy && active !== w.id ? w.id : undefined}>
        <button type="button" className="icon-btn sm workspace-star" title={favorites.includes(w.id) ? "Remove favorite" : "Add favorite"} aria-label={`Favorite workspace ${w.name}`} aria-pressed={favorites.includes(w.id)} onClick={() => useLibrary.getState().favoriteWorkspace(w.id)}><Star size={13}/></button>
        <button type="button" className="repository-select" aria-current={active === w.id} disabled={busy} title={w.name} onClick={() => void open(w.id)}><span className="repository-label">{w.name}</span><small className="faint">{w.roots.length}</small></button>
      </div>)}
      {!rows.length && <div className="cg-empty">No matching workspaces</div>}
    </div>
    <button type="button" className="btn sm repository-add" onClick={() => void repositoryLibraryDialog()}>Manage library…</button>
    <Splitter dir="v" style={{ right: -3, left: "auto" }} onDrag={delta => setWidth(w => Math.max(150, Math.min(390, w + delta)))} onEnd={() => setLayout({ workspacesWidth: width })}/>
  </aside>;
}

async function dropRepositories(source: string | null, target: string, roots: string[]) {
  const library = useLibrary.getState();
  const workspace = library.workspaces.find(w => w.id === target);
  if (!workspace || source === target || source !== library.activeWorkspaceId) return;
  try {
    const errors = await dropWorkspaceRepositories(source, target, roots);
    if (errors.length) toast.warning("Workspace could not open every repository", errors.join("\n"));
    else toast.success(`${roots.length} ${roots.length === 1 ? "repository" : "repositories"} ${source ? "moved" : "added"}`, `${workspace.name} · Ctrl+Z to undo`);
  } catch (error) { toast.error(error); }
}

export function useWorkspaceRepositoryDrag() {
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cancel.current?.(), []);
  return {
    suppressClick,
    start(e: ReactPointerEvent<HTMLButtonElement>, roots: string[]) {
      if (e.button !== 0) return;
      const doc = e.currentTarget.ownerDocument, view = doc.defaultView;
      if (!view || !doc.querySelector("[data-workspace-drop]")) return;
      cancel.current?.();
      const { pointerId, clientX, clientY } = e;
      const source = useLibrary.getState().activeWorkspaceId;
      let dragging = false;
      let target: HTMLElement | null = null;
      const marker = doc.createElement("div");
      marker.className = "repository-drag-label";
      marker.textContent = `${roots.length} ${roots.length === 1 ? "repository" : "repositories"}`;
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        if (!dragging && Math.hypot(event.clientX - clientX, event.clientY - clientY) < 6) return;
        if (!dragging) { dragging = true; doc.body.append(marker); }
        event.preventDefault();
        marker.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
        const next = doc.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workspace-drop]") ?? null;
        if (target === next) return;
        target?.classList.remove("workspace-drop-active");
        target = next;
        target?.classList.add("workspace-drop-active");
      };
      const cleanup = () => {
        marker.remove();
        target?.classList.remove("workspace-drop-active");
        view.removeEventListener("pointermove", move);
        view.removeEventListener("pointerup", up);
        view.removeEventListener("pointercancel", cleanup);
        view.removeEventListener("blur", cleanup);
        cancel.current = null;
      };
      const up = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        const id = target?.dataset.workspaceDrop;
        cleanup();
        if (!dragging) return;
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        if (id) void dropRepositories(source, id, roots);
      };
      cancel.current = cleanup;
      view.addEventListener("pointermove", move);
      view.addEventListener("pointerup", up);
      view.addEventListener("pointercancel", cleanup);
      view.addEventListener("blur", cleanup);
    },
  };
}
