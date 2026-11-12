import { useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Folder, FolderPlus, FolderTree, GripVertical, Pencil, Trash2, Unlink, X } from "lucide-react";
import { treeSelection, visibleTree, type TreePlacement } from "../lib/libraryTree";
import { findTreeDrop, useLibraryPointerDrag } from "../lib/libraryDrag";
import { groupRepositoryRoots, groupsInWorkspace, useLibrary } from "../lib/repositoryLibrary";
import { useSettings } from "../lib/settings";
import { contextMenu, toast, useUi, type MenuItem } from "../lib/ui";
import { deleteGroupsDialog, groupCreationMenu, groupEditorDialog, renameGroupDialog } from "./RepositoryLibrary";
import { runMenuShortcut } from "./menus";
import { Splitter } from "./Overlays";

export function GroupsSidebar() {
  const allGroups = useLibrary(s => s.groups);
  const workspace = useLibrary(s => s.workspaces.find(w => w.id === s.activeWorkspaceId));
  const groups = groupsInWorkspace(allGroups, workspace);
  const active = useUi(s => s.repositoryGroup);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const drag = useLibraryPointerDrag();
  const storedWidth = useSettings(s => s.groupsWidth);
  const [width, setWidth] = useState(storedWidth);
  const search = query.trim().toLowerCase();
  const rows = visibleTree(groups, g => g.name.toLowerCase().includes(search), g => g.collapsed, !!search);
  const visible = rows.map(({entry}) => entry.id);
  const setActive = (id: string | null) => useUi.setState({ repositoryGroup: id });
  const deleteSelected = async (ids: string[]) => {
    const removed = await deleteGroupsDialog(ids);
    if (removed) {
      setSelected(current => current.filter(id => !removed.has(id)));
      if (anchor.current && removed.has(anchor.current)) anchor.current = null;
    }
  };
  const removeFromWorkspace = (ids: string[]) => {
    const library = useLibrary.getState();
    if (!workspace || library.activeWorkspaceId !== workspace.id) return;
    library.setWorkspaceGroupsExcluded(workspace.id, ids, true);
    const updated = useLibrary.getState().workspaces.find(w => w.id === workspace.id);
    const remaining = groupsInWorkspace(library.groups, updated);
    setSelected(current => current.filter(id => remaining.some(group => group.id === id)));
    if (active && !remaining.some(group => group.id === active)) setActive(null);
  };
  const move = (ids: string[], parent: string | null, placement?: TreePlacement) => {
    try {
      const library = useLibrary.getState();
      library.moveGroups(ids, parent, placement);
      if (parent && !placement && library.groups.find(g => g.id === parent)?.collapsed) library.collapse(parent);
    } catch (error) { toast.error(error); }
  };
  return <aside className="repository-sidebar groups-sidebar" aria-label="Groups" style={{width}} onContextMenu={e => {
    if (!(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) contextMenu(e, groupCreationMenu());
  }}>
    <header><FolderTree size={15}/><b>Groups</b><span className="pill">{groups.length}</span><div className="spacer"/>
      <button type="button" className="icon-btn sm" aria-label="Hide Groups" onClick={() => useSettings.getState().set({groupsOpen: false})}><X size={13}/></button>
    </header>
    <div className="repository-filter"><input className="input sm" aria-label="Find group" placeholder="Find group…" value={query} onChange={e => setQuery(e.target.value)}/></div>
    <button type="button" className={`repository-overview-link ${active === null ? "active" : ""}`}
      aria-current={active === null} onClick={() => { setActive(null); setSelected([]); anchor.current = null; }} data-tree-group="" data-repository-group-drop="">
      <FolderTree size={14}/>{drag.moving ? "Move to top level" : "All groups"}
    </button>
    <div className="repository-list" role="list" aria-label="Repository groups">
      {rows.map(({entry: group, depth, hasChildren, expanded}) => {
        const ids = selected.includes(group.id) ? visible.filter(id => selected.includes(id)) : [group.id];
        const parent = groups.every(item => !ids.includes(item.id) || (item.parentId ?? null) === (group.parentId ?? null)) ? group.parentId : null;
        const menu: MenuItem[] = [
          ...groupCreationMenu(group),
          ...(ids.length > 1 ? [{label: "Group selected…", shortcut: "group-selected", icon: <FolderPlus size={14}/>, onClick: () => void groupEditorDialog({children: ids, parentId: parent, onCreated: () => setSelected([])})}] : []),
          { label: "Rename group…", shortcut: "renameItem", icon: <Pencil size={14}/>, onClick: () => void renameGroupDialog(group) },
          ...(group.parentId ? [{ label: "Remove from parent group", shortcut: "group-unlink", icon: <Unlink size={14}/>, onClick: () => move([group.id], null) }] : []),
          ...(workspace ? [{ label: `Remove from workspace · ${workspace.name}`, shortcut: "group-remove-workspace", icon: <Unlink size={14}/>, onClick: () => removeFromWorkspace(ids) }] : []),
          { label: ids.length === 1 ? "Delete group…" : `Delete ${ids.length} groups…`, shortcut: "deleteItem", icon: <Trash2 size={14}/>, danger: true, onClick: () => void deleteSelected(ids) },
        ];
        return <div key={group.id} role="listitem" style={{ "--tree-depth": Math.min(depth, 8) } as CSSProperties}
          className={`repository-item library-tree-row ${active === group.id ? "active" : ""} ${selected.includes(group.id) ? "batch-selected" : ""}`}
          data-tree-group={group.id} data-repository-group-drop={group.id} onKeyDown={e => {
            if (e.key === "Escape") setSelected([]);
            runMenuShortcut(e, menu);
          }} onContextMenu={e => contextMenu(e, menu)}>
          {hasChildren ? <button type="button" className="icon-btn sm" aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`} aria-expanded={expanded} onClick={() => useLibrary.getState().collapse(group.id)}>
            {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
          </button> : <span className="library-tree-spacer"/>}
          <button type="button" className="repository-select" aria-current={active === group.id} aria-pressed={selected.includes(group.id)} title={group.name} onClick={e => {
            const toggle = e.ctrlKey || e.metaKey;
            if (e.shiftKey || toggle) {
              setSelected(treeSelection(visible, selected, anchor.current, group.id, e.shiftKey, toggle));
              if (!e.shiftKey || !anchor.current) anchor.current = group.id;
            } else {
              setSelected([]);
              anchor.current = group.id;
              setActive(group.id);
            }
          }}><Folder size={14}/><span className="repository-label">{group.name}</span><small className="faint">{groupRepositoryRoots(groups, group.id).length}</small></button>
          <span className="library-drag-handle" title={`Drag ${group.name} to reorder or nest it`} onPointerDown={e => {
            drag.start(e, ids.length === 1 ? group.name : `${ids.length} groups`, findTreeDrop("data-tree-group", groups, ids),
              target => move(ids, target.parentId, target.placement));
          }}><GripVertical size={13}/></span>
        </div>;
      })}
      {!rows.length && <div className="cg-empty">{search ? "No matching groups" : "No groups yet"}</div>}
    </div>
    <Splitter dir="v" style={{right: -3, left: "auto"}} onDrag={delta => setWidth(w => Math.max(150, Math.min(390, w + delta)))} onEnd={() => useSettings.getState().set({groupsWidth: width})}/>
  </aside>;
}
