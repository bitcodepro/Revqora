import { useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Folder, FolderPlus, FolderTree, GripVertical, Pencil, Trash2, Unlink, X } from "lucide-react";
import { treeAncestors, treeSelection, visibleTree } from "../lib/libraryTree";
import { groupRepositoryRoots, groupsInWorkspace, useLibrary } from "../lib/repositoryLibrary";
import { useSettings } from "../lib/settings";
import { matchesShortcut } from "../lib/shortcuts";
import { contextMenu, toast, useUi } from "../lib/ui";
import { confirmDialog } from "./dialogs";
import { isPlainDelete } from "./LibraryMenus";
import { Splitter } from "./Overlays";

export function InlineGroupName({ initial = "", label = "Group name", save, cancel }: {
  initial?: string; label?: string; save: (name: string) => void; cancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  return <form className="inline-group-form" onSubmit={e => {
    e.preventDefault();
    try { save(name); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
    <input className="input sm" aria-label={label} placeholder={label} maxLength={80} value={name} autoFocus onFocus={e => e.currentTarget.select()} onChange={e => { setName(e.target.value); setError(""); }} />
    <button type="submit" className="btn sm primary" disabled={!name.trim()}>{initial ? "Save" : "Create"}</button>
    <button type="button" className="icon-btn sm" aria-label="Cancel group edit" onClick={cancel}><X size={14}/></button>
    {error && <small className="red" role="alert">{error}</small>}
  </form>;
}

export async function deleteGroupsDialog(ids: string[]) {
  const library = useLibrary.getState();
  const selected = library.groups.filter(group => ids.includes(group.id));
  if (!selected.length) return false;
  const hasChildren = library.groups.some(group => group.parentId && ids.includes(group.parentId) && !ids.includes(group.id));
  const title = selected.length === 1 ? "Delete group" : `Delete ${selected.length} groups`;
  if (!await confirmDialog({
    title: title + "?",
    confirm: title,
    message: "Repositories stay in the library and in their workspaces." + (hasChildren ? " Any remaining subgroups move to the top level." : ""),
    details: selected.map(group => group.name),
    danger: true,
  })) return false;
  useLibrary.getState().removeGroups(ids);
  if (ids.some(id => useUi.getState().repositoryGroup === id)) useUi.setState({repositoryGroup: null});
  return true;
}

export function GroupsSidebar() {
  const allGroups = useLibrary(s => s.groups);
  const workspace = useLibrary(s => s.workspaces.find(w => w.id === s.activeWorkspaceId));
  const groups = groupsInWorkspace(allGroups, workspace);
  const active = useUi(s => s.repositoryGroup);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [edit, setEdit] = useState<{ ids: string[]; parent?: string | null; rename?: string } | null>(null);
  const [moving, setMoving] = useState<string[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const storedWidth = useSettings(s => s.groupsWidth);
  const [width, setWidth] = useState(storedWidth);
  const search = query.trim().toLowerCase();
  const rows = visibleTree(groups, g => g.name.toLowerCase().includes(search), g => g.collapsed, !!search);
  const visible = rows.map(({entry}) => entry.id);
  const setActive = (id: string | null) => useUi.setState({ repositoryGroup: id });
  const deleteSelected = async (ids: string[]) => {
    if (await deleteGroupsDialog(ids)) {
      setSelected(current => current.filter(id => !ids.includes(id)));
      if (anchor.current && ids.includes(anchor.current)) anchor.current = null;
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
  const move = (ids: string[], parent: string | null) => {
    try {
      const library = useLibrary.getState();
      library.moveGroups(ids, parent);
      if (parent && library.groups.find(g => g.id === parent)?.collapsed) library.collapse(parent);
    } catch (error) { toast.error(error); }
    finally { setMoving([]); setTarget(null); }
  };
  const drop = (id: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!moving.length || (id && [id, ...treeAncestors(groups, id)].some(parent => moving.includes(parent)))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setTarget(id ?? "root");
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!moving.length || e.dataTransfer.getData("application/x-revqora-group") !== moving[0]) return;
      e.preventDefault();
      move(moving, id);
    },
  });
  return <aside className="repository-sidebar groups-sidebar" aria-label="Groups" style={{width}}>
    <header><FolderTree size={15}/><b>Groups</b><span className="pill">{groups.length}</span><div className="spacer"/>
      <button type="button" className="icon-btn sm" aria-label="New group" onClick={() => setEdit({ids: []})}><FolderPlus size={14}/></button>
      <button type="button" className="icon-btn sm" aria-label="Hide Groups" onClick={() => useSettings.getState().set({groupsOpen: false})}><X size={13}/></button>
    </header>
    <div className="repository-filter"><input className="input sm" aria-label="Find group" placeholder="Find group…" value={query} onChange={e => setQuery(e.target.value)}/></div>
    <button type="button" className={`repository-overview-link ${active === null ? "active" : ""} ${target === "root" ? "workspace-drop-active" : ""}`}
      aria-current={active === null} onClick={() => { setActive(null); setSelected([]); anchor.current = null; }} {...drop(null)}>
      <FolderTree size={14}/>{moving.length ? "Move to top level" : "All groups"}
    </button>
    {edit && <InlineGroupName key={edit.rename ?? edit.ids.join(",")} initial={groups.find(g => g.id === edit.rename)?.name} cancel={() => setEdit(null)} save={name => {
      const library = useLibrary.getState();
      const id = edit.rename ? library.group(name, edit.rename) : library.createGroup(name, [], edit.ids, edit.parent);
      if (edit.parent && library.groups.find(g => g.id === edit.parent)?.collapsed) library.collapse(edit.parent);
      setEdit(null);
      setSelected([]);
      setActive(id);
    }}/>}
    <div className="repository-list" role="list" aria-label="Repository groups">
      {rows.map(({entry: group, depth, hasChildren, expanded}) => {
        const ids = selected.includes(group.id) ? visible.filter(id => selected.includes(id)) : [group.id];
        const parent = groups.every(item => !ids.includes(item.id) || (item.parentId ?? null) === (group.parentId ?? null)) ? group.parentId : null;
        const rename = () => setEdit({ids: [], rename: group.id});
        return <div key={group.id} role="listitem" style={{ "--tree-depth": Math.min(depth, 8) } as CSSProperties}
          className={`repository-item library-tree-row ${active === group.id ? "active" : ""} ${selected.includes(group.id) ? "batch-selected" : ""} ${target === group.id ? "workspace-drop-active" : ""}`}
          {...drop(group.id)} onKeyDown={e => {
            if (e.key === "Escape") setSelected([]);
            if (isPlainDelete(e)) {
              e.preventDefault();
              e.stopPropagation();
              void deleteSelected(ids);
              return;
            }
            if (e.repeat || !matchesShortcut(e, "renameItem")) return;
            e.preventDefault();
            e.stopPropagation();
            rename();
          }} onContextMenu={e => contextMenu(e, [
            { label: "Create group", icon: <FolderPlus size={14}/>, onClick: () => setEdit({ ids, parent }) },
            { label: "Create subgroup", icon: <FolderPlus size={14}/>, onClick: () => setEdit({ ids: [], parent: group.id }) },
            { label: "Rename group…", icon: <Pencil size={14}/>, onClick: rename },
            ...(group.parentId ? [{ label: "Remove from parent group", icon: <Unlink size={14}/>, onClick: () => move([group.id], null) }] : []),
            ...(workspace ? [{ label: `Remove from workspace · ${workspace.name}`, icon: <Unlink size={14}/>, onClick: () => removeFromWorkspace(ids) }] : []),
            { label: ids.length === 1 ? "Delete group…" : `Delete ${ids.length} groups…`, icon: <Trash2 size={14}/>, hint: "Delete", danger: true, onClick: () => void deleteSelected(ids) },
          ])}>
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
          <span className="library-drag-handle" draggable title={`Drag ${group.name} to move it`} onDragStart={e => {
            e.dataTransfer.setData("application/x-revqora-group", ids[0]);
            e.dataTransfer.effectAllowed = "move";
            setMoving(ids);
          }} onDragEnd={() => { setMoving([]); setTarget(null); }}><GripVertical size={13}/></span>
        </div>;
      })}
      {!rows.length && <div className="cg-empty">{search ? "No matching groups" : "No groups yet"}</div>}
    </div>
    <Splitter dir="v" style={{right: -3, left: "auto"}} onDrag={delta => setWidth(w => Math.max(150, Math.min(390, w + delta)))} onEnd={() => useSettings.getState().set({groupsWidth: width})}/>
  </aside>;
}
