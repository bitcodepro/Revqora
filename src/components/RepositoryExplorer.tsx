import { useEffect, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, FolderSearch, FolderTree, GripVertical, LayoutGrid, Pencil, Search, Star, Trash2, Unlink, X } from "lucide-react";
import { defaultGroupRoots, repositoryKey, uniqueRoots, useLibrary, type RepositoryGroup, type RepositoryPlacement } from "../lib/repositoryLibrary";
import { visibleTree } from "../lib/libraryTree";
import { findTreeDrop, useLibraryPointerDrag } from "../lib/libraryDrag";
import { recordExplorerMove, useRepositoryDrag } from "../lib/explorerMoves";
import { basename } from "../lib/format";
import { useSettings } from "../lib/settings";
import { repositorySidebarStatus, useRepos } from "../lib/store";
import { contextMenu, toast, useUi, type MenuItem } from "../lib/ui";
import { bindingFor, matchesShortcut, prettyCombo } from "../lib/shortcuts";
import { useNavigationSelection } from "../lib/navigationSelection";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { usePanelTitleMenu } from "./PanelWindows";
import { deleteGroupsDialog, groupCreationMenu, groupEditorDialog, renameGroupDialog } from "./RepositoryLibrary";
import { activateRepository, RepositoryNavigationRow } from "./RepositoryNavigationRow";
import { repositoryFolderImportDialog } from "./RepositoryFolderImport";
import { isDeleteShortcut } from "./LibraryMenus";
import { runMenuShortcut } from "./menus";
import { Splitter } from "./Overlays";

type ExplorerEntry =
  | { kind: "group"; id: string; parentId?: string | null; name: string; group: RepositoryGroup }
  | { kind: "repository"; id: string; parentId: string | null; name: string; root: string };

export function RepositoryExplorer({ onClose }: { onClose: () => void }) {
  const groups = useLibrary(s => s.groups), known = useLibrary(s => s.knownRoots);
  const activeGroup = useLibrary(s => s.activeGroupId), names = useLibrary(s => s.repositoryNames);
  const favorites = useLibrary(s => s.favorites);
  const order = useRepos(s => s.order), tabs = useRepos(s => s.tabs), active = useRepos(s => s.active);
  const overview = useUi(s => s.repositoryOverview);
  const favoritesOnly = useSettings(s => s.explorerFavoritesOnly);
  const { layout, setLayout } = useWorkspaceLayout();
  const [width, setWidth] = useState(layout.workspacesWidth);
  useEffect(() => setWidth(layout.workspacesWidth), [layout.workspacesWidth]);
  const [query, setQuery] = useState("");
  const [incomingOnly, setIncomingOnly] = useState(false);
  const navigation = useNavigationSelection<HTMLElement>();
  const { selection, clear: clearSelection } = navigation;
  const folderDrag = useLibraryPointerDrag(), repositoryDrag = useRepositoryDrag();
  const library = useLibrary.getState;
  const paths = uniqueRoots([...order, ...known]);
  const canonical = new Map(paths.map(root => [repositoryKey(root), root]));
  const favoriteKeys = new Set(favorites.map(repositoryKey));
  const incoming = new Set(paths.filter(root => !!repositorySidebarStatus(tabs[root])?.behind));
  const label = (root: string) => names[repositoryKey(root)] ?? tabs[root]?.info?.name ?? basename(root);
  const repositoryEntry = (path: string, parentId: string | null): ExplorerEntry => {
    const key = repositoryKey(path), root = canonical.get(key) ?? path;
    return { kind: "repository", id: JSON.stringify([parentId, key]), parentId, name: label(root), root };
  };
  const entries: ExplorerEntry[] = [
    ...groups.map((group): ExplorerEntry => ({ kind: "group", id: group.id, parentId: group.parentId, name: group.name, group })),
    ...groups.flatMap(group => group.roots.map(root => repositoryEntry(root, group.id))),
    ...defaultGroupRoots(uniqueRoots([...known, ...order]), groups).map(root => repositoryEntry(root, null)),
  ];
  const search = query.trim().toLowerCase();
  const rows = visibleTree(entries, entry => {
    if (entry.kind === "group") return !incomingOnly && (!favoritesOnly || !!entry.group.favorite) && entry.name.toLowerCase().includes(search);
    return (!incomingOnly || incoming.has(entry.root)) && (!favoritesOnly || favoriteKeys.has(repositoryKey(entry.root))) && `${entry.name} ${entry.root}`.toLowerCase().includes(search);
  }, entry => entry.kind === "group" && entry.group.collapsed, !!search || favoritesOnly || incomingOnly);
  const selectedRows = rows.filter(({ entry }) => selection.includes(entry.id)).map(({ entry }) => entry);
  const selectionContext = (entry: ExplorerEntry) => {
    const peers = rows.map(row => row.entry).filter(row => row.kind === entry.kind);
    const current = entry.kind === "group" ? activeGroup
      : peers.find(row => row.kind === "repository" && row.root === active && row.parentId === entry.parentId)?.id ?? null;
    return { ids: peers.map(row => row.id), current };
  };
  const select = (event: React.MouseEvent, entry: ExplorerEntry, activate: () => void) => {
    const { ids, current } = selectionContext(entry);
    if (!navigation.select(ids, entry.id, current, event.shiftKey, event.ctrlKey || event.metaKey)) activate();
  };
  const selectionKeys = (event: React.KeyboardEvent, entry: ExplorerEntry) => {
    const { ids, current } = selectionContext(entry);
    navigation.keyDown(event, ids, entry.id, current);
  };
  const groupIds = (id: string) => selection.includes(id)
    ? selectedRows.filter(entry => entry.kind === "group").map(entry => entry.id) : [id];
  const placements = (entry: Extract<ExplorerEntry, { kind: "repository" }>): RepositoryPlacement[] =>
    (selection.includes(entry.id)
      ? selectedRows.filter(row => row.kind === "repository") : [entry])
      .map(row => ({ root: row.root, groupId: row.parentId }));
  const remove = async (ids: string[]) => { if (await deleteGroupsDialog(ids)) clearSelection(); };
  const rootMenu: MenuItem[] = [
    ...groupCreationMenu(),
    { label: "Import folder…", shortcut: "import-folder", icon: <FolderSearch size={14}/>, onClick: () => void repositoryFolderImportDialog() },
  ];
  const groupMenu = (group: RepositoryGroup): MenuItem[] => {
    const ids = groupIds(group.id);
    return [
      ...groupCreationMenu(group),
      ...(ids.length > 1 ? [{ label: "Group selected groups", shortcut: "group-selected", icon: <FolderPlus size={14}/>,
        onClick: () => void groupEditorDialog({ children: ids, parentId: group.parentId, onCreated: clearSelection }) }] : []),
      { separator: true },
      { label: "Rename group…", icon: <Pencil size={14}/>, hint: prettyCombo(bindingFor("renameItem")), onClick: () => void renameGroupDialog(group) },
      ...(group.parentId ? [{ label: "Move to top level", shortcut: "group-unlink", icon: <Unlink size={14}/>, onClick: () => {
        try { recordExplorerMove(() => library().moveGroups([group.id], null)); } catch (error) { toast.error(error); }
      } }] : []),
      { label: ids.length === 1 ? "Delete group…" : "Delete selected groups…", icon: <Trash2 size={14}/>,
        hint: prettyCombo(bindingFor("deleteItem")), onClick: () => void remove(ids) },
    ];
  };
  const panelMenu = usePanelTitleMenu("explorer", rootMenu);

  return <aside ref={navigation.panel} className="repository-sidebar explorer-sidebar" aria-label="Explorer" style={{ width }} onContextMenu={event => {
    if (!(event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) contextMenu(event, rootMenu);
  }}>
    <header onContextMenu={panelMenu}><FolderTree size={15}/><b>Explorer</b><div className="spacer"/>
      <button type="button" className="icon-btn sm" aria-label="Hide Explorer" onClick={onClose}><X size={13}/></button>
    </header>
    <div className="repository-filter input-wrap"><Search size={13}/><input className="input sm" aria-label="Find in Explorer" placeholder="Find group or repository…" value={query} onChange={e => setQuery(e.target.value)}/></div>
    <div className="explorer-filters">
      <button type="button" className={`repository-updates ${favoritesOnly ? "active" : ""}`} aria-pressed={favoritesOnly}
        onClick={() => useSettings.getState().set({ explorerFavoritesOnly: !favoritesOnly })}>Favorites</button>
      <button type="button" className={`repository-updates ${incomingOnly ? "active" : ""}`} aria-pressed={incomingOnly}
        title="Show repositories with incoming commits" onClick={() => setIncomingOnly(!incomingOnly)}>Incoming{incoming.size ? ` · ${incoming.size}` : ""}</button>
    </div>
    <button type="button" className={`repository-overview-link ${activeGroup === null ? "active" : ""}`} aria-current={activeGroup === null} aria-label="All repositories"
      data-tree-group="" data-tooltip="Show all repositories or drop items here to move them to the top level" onClick={() => { clearSelection(); library().selectGroup(null); }}>
      <LayoutGrid size={14}/><span className="explorer-overview-text">All repositories</span><span className="explorer-overview-drop-text" aria-hidden="true">Move to top level</span>
    </button>
    <div className="repository-list explorer-tree" role="tree" aria-label="Groups and repositories" aria-multiselectable="true" onClick={event => {
      if (!(event.target as HTMLElement).closest(".repository-item")) clearSelection();
    }}>
      {rows.map(({ entry, depth, expanded, hasChildren }) => {
        if (entry.kind === "repository") {
          const items = placements(entry);
          return <RepositoryNavigationRow key={entry.id} root={entry.root} name={entry.name} tab={tabs[entry.root]}
            depth={depth} current={entry.root === active && !overview} selected={selection.includes(entry.id)} groupId={entry.parentId ?? undefined}
            selection={uniqueRoots(items.map(item => item.root))}
            createGroup={() => void groupEditorDialog({ roots: uniqueRoots(items.map(item => item.root)), parentId: entry.parentId, onCreated: clearSelection })}
            onPointerDown={event => repositoryDrag.start(event, items)}
            onSelectionKeyDown={event => selectionKeys(event, entry)}
            onClick={event => { if (!repositoryDrag.suppressClick.current) select(event, entry, () => activateRepository(entry.root)); }}/>;
        }
        const { group } = entry;
        const chosen = group.id === activeGroup, selected = selection.includes(group.id);
        const toggle = () => library().collapse(group.id);
        const startDrag = (event: React.PointerEvent<HTMLElement>) => {
          const ids = groupIds(group.id);
          folderDrag.start(event, group.name, findTreeDrop(groups, ids), target => {
            try { recordExplorerMove(() => library().moveGroups(ids, target.parentId, target.placement)); }
            catch (error) { toast.error(error); }
          });
        };
        return <div key={group.id} role="treeitem" aria-level={depth + 1} aria-label={group.name} aria-selected={chosen || selected}
          aria-expanded={hasChildren ? expanded : undefined} data-tree-group={group.id}
          className={`repository-item library-tree-row ${chosen ? "active" : ""} ${selected ? "batch-selected" : ""}`}
          style={{ "--tree-depth": Math.min(depth, 12) } as CSSProperties}
          onContextMenu={event => contextMenu(event, groupMenu(group))}
          onKeyDown={event => {
            if (!event.repeat && matchesShortcut(event, "renameItem")) {
              event.preventDefault(); event.stopPropagation(); void renameGroupDialog(group);
            } else if (isDeleteShortcut(event)) {
              event.preventDefault(); event.stopPropagation(); void remove(groupIds(group.id));
            } else runMenuShortcut(event, groupMenu(group));
          }}>
          {hasChildren ? <button type="button" className="icon-btn sm" aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`} aria-expanded={expanded} onClick={toggle}>
            {expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
          </button> : <span className="library-tree-spacer"/>}
          <button type="button" className="repository-select" aria-current={chosen} title={group.name}
            data-shortcut="renameItem" data-tooltip="Rename group · Drag to move · Shift+click selects a range"
            onPointerDown={startDrag} onKeyDown={event => selectionKeys(event, entry)}
            onDoubleClick={event => { if (hasChildren && !event.ctrlKey && !event.metaKey && !event.shiftKey) toggle(); }}
            onClick={event => { if (!folderDrag.suppressClick.current) select(event, entry, () => library().selectGroup(group.id)); }}>
            {expanded && hasChildren ? <FolderOpen size={15}/> : <Folder size={15}/>}
            <span className="repository-label">{group.name}</span>
          </button>
          <button type="button" className={`icon-btn sm repository-star ${group.favorite ? "active" : ""}`}
            aria-label={`${group.favorite ? "Unfavorite" : "Favorite"} group ${group.name}`} aria-pressed={!!group.favorite} onClick={() => library().favoriteGroup(group.id)}>
            <Star size={13} fill={group.favorite ? "currentColor" : "none"}/>
          </button>
          <span className="library-drag-handle" title={`Drag ${group.name} to reorder or nest it`} onPointerDown={startDrag}><GripVertical size={13}/></span>
        </div>;
      })}
      <div className="explorer-root-drop" data-explorer-root-drop aria-hidden="true"><span>Drop at top level</span></div>
      {!rows.length && <div className="cg-empty">{search || favoritesOnly || incomingOnly ? "No matching groups or repositories" : "Open a repository or import a folder"}</div>}
    </div>
    <Splitter dir="v" style={{ right: -3, left: "auto" }} onDrag={delta => setWidth(w => Math.max(175, Math.min(420, w + delta)))} onEnd={() => setLayout({ workspacesWidth: width })}/>
  </aside>;
}
