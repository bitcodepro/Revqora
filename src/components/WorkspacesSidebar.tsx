import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronRight, FolderKanban, GripVertical, LayoutGrid, Pencil, Search, Star, Trash2, Unlink, X } from "lucide-react";
import { useLibrary, type SavedWorkspace } from "../lib/repositoryLibrary";
import { dropWorkspaceRepositories, openAllWorkspaces } from "../lib/repositoryWorkspaces";
import { visibleTree, type TreePlacement } from "../lib/libraryTree";
import { findTreeDrop, useLibraryPointerDrag } from "../lib/libraryDrag";
import { useSettings } from "../lib/settings";
import { contextMenu, toast, useUi, type MenuItem } from "../lib/ui";
import { prettyCombo, bindingFor } from "../lib/shortcuts";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { Splitter } from "./Overlays";
import { usePanelTitleMenu } from "./PanelWindows";
import { runMenuShortcut } from "./menus";
import { deleteWorkspaceDialog, openWorkspace, renameWorkspaceDialog, workspaceCreationMenu } from "./RepositoryLibrary";

export function WorkspacesSidebar({ onClose }: { onClose: () => void }) {
  const workspaces = useLibrary(s => s.workspaces);
  const active = useLibrary(s => s.activeWorkspaceId);
  const favorites = useLibrary(s => s.favoriteWorkspaceIds);
  const busy = useUi(s => s.busy.length > 0 || s.repositoryOperations.length > 0);
  const menu = (workspace?: SavedWorkspace, row = false): MenuItem[] => [
    ...workspaceCreationMenu(row ? workspace : undefined, busy),
    { label: "Rename workspace…", shortcut: "renameItem", icon: <Pencil size={14}/>, disabled: !workspace, onClick: () => { if (workspace) void renameWorkspaceDialog(workspace); } },
    ...(workspace?.parentId ? [{ label: "Remove from parent workspace", shortcut: "workspace-unlink", icon: <Unlink size={14}/>, onClick: () => move(workspace.id, null) }] : []),
    { label: "Delete workspace…", shortcut: "deleteItem", icon: <Trash2 size={14}/>, danger: true, disabled: busy || !workspace, onClick: () => { if (workspace) void deleteWorkspaceDialog(workspace); } },
  ];
  const activeWorkspace = workspaces.find(w => w.id === active);
  const panelMenu = usePanelTitleMenu("workspaces", menu(activeWorkspace));
  const favoritesOnly = useSettings(s => s.workspaceFavoritesOnly);
  const [query, setQuery] = useState("");
  const drag = useLibraryPointerDrag();
  const { layout, setLayout } = useWorkspaceLayout();
  const [width, setWidth] = useState(layout.workspacesWidth);
  useEffect(() => setWidth(layout.workspacesWidth), [layout.workspacesWidth]);
  const filter = query.trim().toLowerCase();
  const rows = visibleTree(workspaces, w => (!favoritesOnly || favorites.includes(w.id)) && w.name.toLowerCase().includes(filter), w => !!w.collapsed, favoritesOnly || !!filter);
  const move = (id: string, parent: string | null, placement?: TreePlacement) => {
    try {
      const library = useLibrary.getState();
      library.moveWorkspace(id, parent, placement);
      if (parent && !placement && library.workspaces.find(w => w.id === parent)?.collapsed) library.collapseWorkspace(parent);
    } catch (error) { toast.error(error); }
  };
  return <aside className="repository-sidebar workspace-sidebar" aria-label="Workspaces" style={{ width }} onContextMenu={e => {
    if (!(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) contextMenu(e, menu());
  }}>
    <header onContextMenu={panelMenu}><FolderKanban size={15}/><b>Workspaces</b><span className="pill">{workspaces.length}</span><div className="spacer"/><button type="button" className="icon-btn sm" aria-label="Hide Workspaces" onClick={onClose}><X size={13}/></button></header>
    <div className="repository-filter input-wrap"><Search size={13}/><input className="input sm" aria-label="Find workspace" placeholder="Find workspace…" value={query} onChange={e => setQuery(e.target.value)}/></div>
    <button type="button" className={`repository-updates ${favoritesOnly ? "active" : ""}`} aria-pressed={favoritesOnly} onClick={() => useSettings.getState().set({ workspaceFavoritesOnly: !favoritesOnly })}>Favorites</button>
    <button type="button" className={`repository-overview-link ${active === null ? "active" : ""}`} aria-current={active === null} disabled={busy && !drag.moving} onClick={openAllWorkspaces} data-tree-workspace=""><LayoutGrid size={14}/> {drag.moving ? "Move to top level" : "All Workspaces"}</button>
    <div className="repository-list" role="list" aria-label="Saved workspaces">
      {rows.map(({entry: w, depth, hasChildren, expanded}) => <div role="listitem" className={`repository-item library-tree-row ${active === w.id ? "active" : ""}`}
        style={{ "--tree-depth": Math.min(depth, 8) } as React.CSSProperties} key={w.id} data-workspace-drop={!busy && active !== w.id ? w.id : undefined} data-tree-workspace={w.id}
        onKeyDown={e => runMenuShortcut(e, menu(w, true))} onContextMenu={e => contextMenu(e, menu(w, true))}>
        {hasChildren ? <button type="button" className="icon-btn sm" aria-label={`${expanded ? "Collapse" : "Expand"} ${w.name}`} aria-expanded={expanded} onClick={() => useLibrary.getState().collapseWorkspace(w.id)}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button> : <span className="library-tree-spacer"/>}
        <button type="button" className="icon-btn sm workspace-star" title={favorites.includes(w.id) ? "Remove favorite" : "Add favorite"} aria-label={`Favorite workspace ${w.name}`} aria-pressed={favorites.includes(w.id)} onClick={() => useLibrary.getState().favoriteWorkspace(w.id)}><Star size={13}/></button>
        <button type="button" className="repository-select" aria-current={active === w.id} aria-disabled={busy} title={w.name} onClick={() => { if (!busy && active !== w.id) void openWorkspace(w.id); }}><span className="repository-label">{w.name}</span><small className="faint">{w.roots.length}</small></button>
        <span className="library-drag-handle" title={`Drag ${w.name} to reorder or nest it`} onPointerDown={e => {
          drag.start(e, w.name, findTreeDrop("data-tree-workspace", workspaces, [w.id]), target => move(w.id, target.parentId, target.placement));
        }}><GripVertical size={13}/></span>
      </div>)}
      {!rows.length && <div className="cg-empty">No matching workspaces</div>}
    </div>
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
    else {
      const undo = prettyCombo(bindingFor("workspaceUndo"));
      toast.success(`${roots.length} ${roots.length === 1 ? "repository" : "repositories"} ${source ? "moved" : "added"}`, undo ? `${workspace.name} · ${undo} to undo` : workspace.name);
    }
  } catch (error) { toast.error(error); }
}

export function useWorkspaceRepositoryDrag() {
  const drag = useLibraryPointerDrag();
  return {
    suppressClick: drag.suppressClick,
    start(e: ReactPointerEvent<HTMLButtonElement>, roots: string[], fromGroup: string | null, allowWorkspace: boolean) {
      if (!e.currentTarget.ownerDocument.querySelector(allowWorkspace ? "[data-workspace-drop], [data-repository-group-drop]" : "[data-repository-group-drop]")) return;
      const source = useLibrary.getState().activeWorkspaceId;
      drag.start<{ kind: "group" | "workspace"; id: string | null }>(e, `${roots.length} ${roots.length === 1 ? "repository" : "repositories"}`, hit => {
        const element = hit?.closest<HTMLElement>("[data-repository-group-drop]");
        const group = element?.dataset.repositoryGroupDrop;
        if (element && group !== undefined && (group || fromGroup) && (group || null) !== fromGroup) {
          return { element, value: { kind: "group" as const, id: group || null } };
        }
        const workspace = allowWorkspace ? hit?.closest<HTMLElement>("[data-workspace-drop]") : null;
        const id = workspace?.dataset.workspaceDrop;
        return workspace && id ? { element: workspace, value: { kind: "workspace" as const, id } } : null;
      }, target => {
        if (target.kind === "workspace" && target.id) void dropRepositories(source, target.id, roots);
        if (target.kind === "group" && useLibrary.getState().activeWorkspaceId === source) {
          useLibrary.getState().moveGroupRepositories(roots, fromGroup, target.id);
        }
      });
    },
  };
}
