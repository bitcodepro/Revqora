import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, FolderSearch, FolderTree, LayoutGrid, Pencil, Search, Star, Trash2, Unlink, X } from "lucide-react";
import { defaultGroupRoots, explorerRepositoryKey, orderExplorerSiblings, repositoryKey, uniqueRoots, useLibrary, type RepositoryGroup, type RepositoryPlacement } from "../lib/repositoryLibrary";
import { treeSubtreeIds, visibleTree } from "../lib/libraryTree";
import { findExplorerDrop, useLibraryPointerDrag } from "../lib/libraryDrag";
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

const rowSteps = [
  { shortcut: "explorerNextRow", step: 1, extend: false },
  { shortcut: "explorerPreviousRow", step: -1, extend: false },
  { shortcut: "explorerExtendNext", step: 1, extend: true },
  { shortcut: "explorerExtendPrevious", step: -1, extend: true },
];

export function RepositoryExplorer({ onClose }: { onClose: () => void }) {
  const groups = useLibrary(s => s.groups), known = useLibrary(s => s.knownRoots);
  const activeGroup = useLibrary(s => s.activeGroupId), names = useLibrary(s => s.repositoryNames);
  const favorites = useLibrary(s => s.favorites), explorerOrder = useLibrary(s => s.explorerOrder);
  const order = useRepos(s => s.order), tabs = useRepos(s => s.tabs), active = useRepos(s => s.active);
  const overview = useUi(s => s.repositoryOverview);
  const favoritesOnly = useSettings(s => s.explorerFavoritesOnly);
  const { layout, setLayout } = useWorkspaceLayout();
  const [width, setWidth] = useState(layout.workspacesWidth);
  useEffect(() => setWidth(layout.workspacesWidth), [layout.workspacesWidth]);
  const [query, setQuery] = useState("");
  const [incomingOnly, setIncomingOnly] = useState(false);
  const [collapsedFavorites, setCollapsedFavorites] = useState<Set<string>>(() => new Set());
  const navigation = useNavigationSelection<HTMLElement>();
  const tree = useRef<HTMLDivElement>(null);
  const [focusedEntry, setFocusedEntry] = useState<string | null>();
  const focusedId = focusedEntry === undefined ? activeGroup : focusedEntry;
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
  const favoriteGroups = favoritesOnly ? treeSubtreeIds(groups, groups.filter(group => group.favorite).map(group => group.id)) : null;
  const rows = visibleTree(entries, entry => {
    if (entry.kind === "group") return !incomingOnly && (!favoriteGroups || favoriteGroups.has(entry.id)) && entry.name.toLowerCase().includes(search);
    const favorite = favoriteKeys.has(repositoryKey(entry.root)) || !!entry.parentId && !!favoriteGroups?.has(entry.parentId);
    return (!incomingOnly || incoming.has(entry.root)) && (!favoritesOnly || favorite) && `${entry.name} ${entry.root}`.toLowerCase().includes(search);
  }, entry => entry.kind === "group" && (favoritesOnly ? collapsedFavorites.has(entry.id) : entry.group.collapsed),
    !!search || favoritesOnly || incomingOnly, !favoritesOnly && (!!search || incomingOnly),
    (siblings, parentId) => orderExplorerSiblings(siblings, explorerOrder[parentId ?? ""],
      entry => entry.kind === "group" ? entry.id : explorerRepositoryKey(entry.root)));
  const visibleEntries = rows.map(row => row.entry);
  const visibleIds = visibleEntries.map(entry => entry.id);
  const selectedRows = visibleEntries.filter(entry => selection.includes(entry.id));
  const siblingIds = (entry: ExplorerEntry) => visibleEntries
    .filter(row => (row.parentId ?? null) === (entry.parentId ?? null)).map(row => row.id);
  const select = (event: React.MouseEvent, entry: ExplorerEntry, activate: () => void) => {
    setFocusedEntry(entry.id);
    if (!navigation.select(visibleIds, entry.id, null, event.shiftKey, event.ctrlKey || event.metaKey)) activate();
  };
  const focusRow = (id: string) => {
    const row = tree.current?.querySelector<HTMLButtonElement>(`[data-explorer-entry="${CSS.escape(id)}"] > .repository-select`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const rowIdFrom = (target: EventTarget) => (target as HTMLElement).closest<HTMLElement>("[data-explorer-entry]")?.dataset.explorerEntry;
  const selectionKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const id = rowIdFrom(event.target);
    const entry = visibleEntries.find(row => row.id === id);
    if (!entry || event.currentTarget.ownerDocument.body.classList.contains("explorer-dragging")) return;
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    if (matchesShortcut(event, "explorerSelectAll")) {
      consume();
      if (event.repeat) return;
      const extend = navigation.selectedAllAt(entry.id);
      const parent = extend && visibleEntries.find(row => row.id === entry.parentId);
      const target = parent || entry;
      navigation.selectAll(siblingIds(target), target.id, extend);
      if (parent) focusRow(parent.id);
      return;
    }
    const step = rowSteps.find(item => matchesShortcut(event, item.shortcut));
    if (step) {
      consume();
      const next = visibleIds[visibleIds.indexOf(entry.id) + step.step];
      if (next) {
        navigation.select(visibleIds, next, entry.id, step.extend, false);
        focusRow(next);
      }
      return;
    }
    navigation.keyDown(event, visibleIds, entry.id, null);
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
    <button type="button" className={`repository-overview-link ${activeGroup === null && focusedId === null ? "active" : ""}`} aria-current={activeGroup === null} aria-label="All repositories"
      data-tree-group="" data-tooltip="Show all repositories or drop items here to move them to the top level" onClick={() => { clearSelection(); setFocusedEntry(null); library().selectGroup(null); }}>
      <LayoutGrid size={14}/><span className="explorer-overview-text">All repositories</span><span className="explorer-overview-drop-text" aria-hidden="true">Move to top level</span>
    </button>
    <div ref={tree} className="repository-list explorer-tree" role="tree" aria-label="Groups and repositories" aria-multiselectable="true"
      onKeyDown={selectionKeys} onFocus={event => { const id = rowIdFrom(event.target); if (id) setFocusedEntry(id); }}
      onClick={event => {
        if (!(event.target as HTMLElement).closest("button")) { clearSelection(); setFocusedEntry(null); }
      }}>
      {rows.map(({ entry, depth, expanded, hasChildren }) => {
        if (entry.kind === "repository") {
          const items = placements(entry);
          return <RepositoryNavigationRow key={entry.id} root={entry.root} name={entry.name} tab={tabs[entry.root]}
            depth={depth} explorer={{ id: entry.id, focused: focusedId === entry.id }} current={entry.root === active && !overview} selected={selection.includes(entry.id)} groupId={entry.parentId ?? undefined}
            selection={uniqueRoots(items.map(item => item.root))}
            createGroup={() => void groupEditorDialog({ roots: uniqueRoots(items.map(item => item.root)), parentId: entry.parentId, onCreated: clearSelection })}
            onPointerDown={event => repositoryDrag.start(event, items)}
            onClick={event => {
              if (repositoryDrag.suppressClick.current) return;
              select(event, entry, () => {
                if (favoritesOnly && favoriteKeys.has(repositoryKey(entry.root))) library().selectGroup(entry.parentId);
                activateRepository(entry.root);
              });
            }}/>;
        }
        const { group } = entry;
        const chosen = group.id === activeGroup, selected = selection.includes(group.id);
        const toggle = () => {
          if (!favoritesOnly) { library().collapse(group.id); return; }
          setCollapsedFavorites(current => {
            const next = new Set(current);
            if (next.has(group.id)) next.delete(group.id);
            else next.add(group.id);
            return next;
          });
        };
        const startDrag = (event: React.PointerEvent<HTMLElement>) => {
          const ids = groupIds(group.id);
          const findTarget = findExplorerDrop(groups, treeSubtreeIds(groups, ids), new Set());
          folderDrag.start(event, group.name, findTarget, target => {
            try { recordExplorerMove(() => library().moveGroups(ids, target.parentId, target.placement)); }
            catch (error) { toast.error(error); }
          });
        };
        return <div key={group.id} role="treeitem" aria-level={depth + 1} aria-label={group.name} aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined} data-tree-group={group.id} data-explorer-entry={entry.id}
          className={`repository-item library-tree-row ${chosen ? "active" : ""} ${focusedId === entry.id ? "explorer-focused" : ""} ${selected ? "batch-selected" : ""}`}
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
            onPointerDown={startDrag}
            onDoubleClick={event => { if (hasChildren && !event.ctrlKey && !event.metaKey && !event.shiftKey) toggle(); }}
            onClick={event => { if (!folderDrag.suppressClick.current) select(event, entry, () => library().selectGroup(group.id)); }}>
            {expanded && hasChildren ? <FolderOpen size={15}/> : <Folder size={15}/>}
            <span className="repository-label">{group.name}</span>
          </button>
          <button type="button" className={`icon-btn sm repository-star ${group.favorite ? "active" : ""}`}
            aria-label={`${group.favorite ? "Unfavorite" : "Favorite"} group ${group.name}`} aria-pressed={!!group.favorite} onClick={() => library().favoriteGroup(group.id)}>
            <Star size={13} fill={group.favorite ? "currentColor" : "none"}/>
          </button>
        </div>;
      })}
      <div className="explorer-root-drop" data-explorer-root-drop aria-hidden="true"><span>Drop at top level</span></div>
      {!rows.length && <div className="cg-empty">{search || favoritesOnly || incomingOnly ? "No matching groups or repositories" : "Open a repository or import a folder"}</div>}
    </div>
    <Splitter dir="v" style={{ right: -3, left: "auto" }} onDrag={delta => setWidth(w => Math.max(175, Math.min(420, w + delta)))} onEnd={() => setLayout({ workspacesWidth: width })}/>
  </aside>;
}
