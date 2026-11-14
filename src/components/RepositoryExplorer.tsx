import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, FolderSearch, FolderTree, LayoutGrid, Loader2, Pencil, Search, Star, Trash2, Unlink, UserRound, X } from "lucide-react";
import { defaultGroupRoots, explorerRepositoryKey, orderExplorerSiblings, repositoryKey, uniqueRoots, useLibrary, type RepositoryGroup, type RepositoryPlacement } from "../lib/repositoryLibrary";
import { treeSubtreeIds, visibleTree } from "../lib/libraryTree";
import { findExplorerDrop, useLibraryPointerDrag } from "../lib/libraryDrag";
import { recordExplorerMove, useRepositoryDrag } from "../lib/explorerMoves";
import { errorMessage } from "../lib/api";
import { loadBranchPreferences } from "../lib/branchManager";
import { useExplorerBranchReads } from "../lib/explorerBranchReads";
import { selectExplorerBranches } from "../lib/explorerBranches";
import type { BranchInfo, RefsSnapshot } from "../lib/types";
import { basename } from "../lib/format";
import { useSettings } from "../lib/settings";
import { repositorySidebarStatus, useRepos } from "../lib/store";
import { contextMenu, toast, useUi, type MenuItem } from "../lib/ui";
import { bindingFor, matchesShortcut, prettyCombo } from "../lib/shortcuts";
import { useNavigationSelection } from "../lib/navigationSelection";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { usePanelTitleMenu, usePanelWindows } from "./PanelWindows";
import { ExplorerBranchRow } from "./ExplorerBranchRow";
import { deleteGroupsDialog, groupCreationMenu, groupEditorDialog, renameGroupDialog } from "./RepositoryLibrary";
import { activateRepository, RepositoryNavigationRow } from "./RepositoryNavigationRow";
import { repositoryFolderImportDialog } from "./RepositoryFolderImport";
import { isDeleteShortcut } from "./LibraryMenus";
import { runMenuShortcut } from "./menus";
import { Splitter } from "./Overlays";

type ExplorerEntry =
  | { kind: "group"; id: string; parentId?: string | null; name: string; group: RepositoryGroup }
  | { kind: "repository"; id: string; parentId: string | null; name: string; root: string }
  | { kind: "branch"; id: string; parentId: string; name: string; root: string; branch: BranchInfo; refs: RefsSnapshot; upstream?: BranchInfo };

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
  const reveal = useUi(s => s.explorerReveal);
  const favoritesOnly = useSettings(s => s.explorerFavoritesOnly);
  const myBranchesOnly = useSettings(s => s.explorerMyBranchesOnly);
  const branchFavorites = useSettings(s => s.branchFavoritesByRepo);
  const primaryBranches = useSettings(s => s.primaryBranchByRepo);
  const { panels } = usePanelWindows();
  const [authorQueries, setAuthorQueries] = useState<Record<string, string>>({});
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ root: string; query: string }>).detail;
      if (detail) setAuthorQueries(current => ({ ...current, [repositoryKey(detail.root)]: detail.query }));
    };
    window.addEventListener("revqora:branch-author", changed);
    return () => window.removeEventListener("revqora:branch-author", changed);
  }, []);
  const folderHover = useSettings(s => s.explorerFolderHover);
  const hoverColor = (theme: keyof typeof folderHover) => {
    const { color, opacity } = folderHover[theme];
    return `color-mix(in srgb, ${color} ${opacity}%, transparent)`;
  };
  const { layout, setLayout } = useWorkspaceLayout();
  const [width, setWidth] = useState(layout.workspacesWidth);
  useEffect(() => setWidth(layout.workspacesWidth), [layout.workspacesWidth]);
  const [query, setQuery] = useState("");
  const [incomingOnly, setIncomingOnly] = useState(false);
  const [changesOnly, setChangesOnly] = useState(false);
  const [collapsedFavorites, setCollapsedFavorites] = useState<Set<string>>(() => new Set());
  const [expandedRepositories, setExpandedRepositories] = useState<Set<string>>(() => new Set());
  const [collapsedFilteredRepos, setCollapsedFilteredRepos] = useState<Set<string>>(() => new Set());
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
  const hasChanges = (root: string) => !!repositorySidebarStatus(tabs[root])?.files.length;
  const label = (root: string) => names[repositoryKey(root)] ?? tabs[root]?.info?.name ?? basename(root);
  const repositoryEntry = (path: string, parentId: string | null): Extract<ExplorerEntry, { kind: "repository" }> => {
    const key = repositoryKey(path), root = canonical.get(key) ?? path;
    return { kind: "repository", id: JSON.stringify([parentId, key]), parentId, name: label(root), root };
  };
  const repositories = [
    ...groups.flatMap(group => group.roots.map(root => repositoryEntry(root, group.id))),
    ...defaultGroupRoots(paths, groups).map(root => repositoryEntry(root, null)),
  ];
  const search = query.trim().toLocaleLowerCase();
  const branchFilter = !!search || favoritesOnly || myBranchesOnly;
  const statusFiltered = incomingOnly || changesOnly;
  const matchesStatus = (root: string) => (!incomingOnly || incoming.has(root)) && (!changesOnly || hasChanges(root));
  const needsBranches = (entry: typeof repositories[number]) => matchesStatus(entry.root) &&
    (expandedRepositories.has(repositoryKey(entry.root)) || myBranchesOnly || !!search ||
      favoritesOnly && !!branchFavorites[repositoryKey(entry.root)]?.length);
  const requested = repositories.filter(needsBranches);
  const requestedRoots = uniqueRoots(requested.map(entry => entry.root));
  const branchReads = useExplorerBranchReads(requestedRoots);
  const branchLists = new Map(requestedRoots.flatMap(root => {
    const key = repositoryKey(root), read = branchReads[root];
    const refs = tabs[root]?.refs ?? (read && "refs" in read ? read.refs : null);
    if (!refs) return [];
    const branches = selectExplorerBranches(refs, {
      primary: primaryBranches[key], favorites: branchFavorites[key], favoritesOnly, myBranchesOnly,
      authorQuery: myBranchesOnly ? authorQueries[key] ?? loadBranchPreferences(root).authorQuery : "",
    });
    return [[root, { refs, ...branches }] as const];
  }));
  const branchEntries = requested.flatMap((entry): ExplorerEntry[] => {
    const list = branchLists.get(entry.root);
    if (!list) return [];
    return list.rows.map(branch => ({
      kind: "branch", id: JSON.stringify([entry.id, branch.fullName]), parentId: entry.id,
      name: branch.name, root: entry.root, branch, refs: list.refs, upstream: list.upstreams.get(branch.fullName),
    }));
  });
  const entries: ExplorerEntry[] = [
    ...groups.map((group): ExplorerEntry => ({ kind: "group", id: group.id, parentId: group.parentId, name: group.name, group })),
    ...repositories,
    ...branchEntries,
  ];
  const favoriteGroups = favoritesOnly ? treeSubtreeIds(groups, groups.filter(group => group.favorite).map(group => group.id)) : null;
  const matchesTree = (entry: ExplorerEntry) => {
    if (entry.kind === "group") return !myBranchesOnly && !statusFiltered && (!favoriteGroups || favoriteGroups.has(entry.id)) && entry.name.toLocaleLowerCase().includes(search);
    if (!matchesStatus(entry.root)) return false;
    if (entry.kind === "branch") return entry.name.toLocaleLowerCase().includes(search);
    const favorite = favoriteKeys.has(repositoryKey(entry.root)) || !!entry.parentId && !!favoriteGroups?.has(entry.parentId);
    const pending = !branchLists.has(entry.root) && !tabs[entry.root]?.refsError && !tabs[entry.root]?.error && !branchReads[entry.root];
    return (!myBranchesOnly || pending) && (!favoritesOnly || favorite) && (entry.name + " " + entry.root).toLocaleLowerCase().includes(search);
  };
  const isRepositoryExpanded = (entry: typeof repositories[number], hasBranches: boolean) => {
    return branchFilter && hasBranches ? !collapsedFilteredRepos.has(entry.id) : expandedRepositories.has(repositoryKey(entry.root));
  };
  const rows = visibleTree(entries, matchesTree, entry => {
    if (entry.kind === "branch") return false;
    if (entry.kind === "repository") return !isRepositoryExpanded(entry, !!branchLists.get(entry.root)?.rows.length);
    return favoritesOnly ? collapsedFavorites.has(entry.id) : !search && !statusFiltered && !myBranchesOnly && !!entry.group.collapsed;
  }, branchFilter || statusFiltered, false, (siblings, parentId) => {
    // Branch order is determined per repository. Only folders and repository
    // placements participate in the persisted drag order.
    if (siblings[0]?.kind === "branch") return siblings;
    return orderExplorerSiblings(siblings, explorerOrder[parentId ?? ""],
      entry => entry.kind === "repository" ? explorerRepositoryKey(entry.root) : entry.id);
  });
  const toggleRepository = (entry: typeof repositories[number], hasBranches: boolean) => {
    const filtered = branchFilter && hasBranches;
    const id = filtered ? entry.id : repositoryKey(entry.root);
    (filtered ? setCollapsedFilteredRepos : setExpandedRepositories)(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const branchNavigation = (root: string, run: (actual: string) => void) => {
    const repos = useRepos.getState();
    if (repos.tabs[root]?.info) {
      if (repos.active !== root) repos.activate(root);
      else useUi.setState({ repositoryOverview: false });
      run(root);
      return;
    }
    const opening = repos.open(root);
    const intent = useRepos.getState().selectionVersion;
    void opening.then(actual => {
      if (actual && useRepos.getState().selectionVersion === intent) run(actual);
    }, error => toast.error("Could not open repository", errorMessage(error)));
  };

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
    return !!row;
  };
  useEffect(() => {
    if (!reveal) return;
    setQuery("");
    setIncomingOnly(false);
    setChangesOnly(false);
    useSettings.getState().set({ explorerMyBranchesOnly: false });
    clearSelection();
    setFocusedEntry(reveal);
  }, [reveal, clearSelection]);
  useEffect(() => {
    if (reveal && focusedEntry === reveal && focusRow(reveal)) useUi.setState({ explorerReveal: null });
  });
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
  const toggleFavorites = () => {
    setCollapsedFilteredRepos(new Set());
    useSettings.getState().set({ explorerFavoritesOnly: !favoritesOnly });
  };
  const toggleMyBranches = () => {
    setCollapsedFilteredRepos(new Set());
    setCollapsedFavorites(new Set());
    useSettings.getState().set({ explorerMyBranchesOnly: !myBranchesOnly });
  };
  const panelMenu = usePanelTitleMenu("explorer", rootMenu);

  return <aside ref={navigation.panel} className="repository-sidebar explorer-sidebar" aria-label="Explorer" style={{
    width, "--explorer-folder-hover-dark": hoverColor("dark"), "--explorer-folder-hover-light": hoverColor("light"),
  } as CSSProperties} onKeyDown={event => {
    if (event.defaultPrevented || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    runMenuShortcut(event, [
      { shortcut: "explorer-favorites", onClick: toggleFavorites },
      { shortcut: "explorer-my-branches", onClick: toggleMyBranches },
      { shortcut: "explorer-incoming", onClick: () => setIncomingOnly(on => !on) },
      { shortcut: "explorer-changes", onClick: () => setChangesOnly(on => !on) },
    ]);
  }} onContextMenu={event => {
    if (!(event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) contextMenu(event, rootMenu);
  }}>
    <header onContextMenu={panelMenu}><FolderTree size={15}/><b>Explorer</b><div className="spacer"/>
      <button type="button" className="icon-btn sm" aria-label="Hide Explorer" onClick={onClose}><X size={13}/></button>
    </header>
    <div className="repository-filter input-wrap"><Search size={13}/><input className="input sm" aria-label="Find in Explorer" placeholder="Find folder, repository or branch…" value={query} onChange={event => { setCollapsedFilteredRepos(new Set()); setQuery(event.target.value); }}/></div>
    <div className="explorer-filters">
      <button type="button" className={`repository-updates ${favoritesOnly ? "active" : ""}`} aria-label="Favorites" aria-pressed={favoritesOnly}
        data-shortcut="explorer-favorites" title="Show favorite folders, repositories and branches"
        onClick={toggleFavorites}><Star size={13}/><span>Favorites</span></button>
      <button type="button" className={`repository-updates explorer-my-branches ${myBranchesOnly ? "active" : ""}`} aria-label="My branches" aria-pressed={myBranchesOnly}
        data-shortcut="explorer-my-branches" title="Show branches you created and each repository’s primary branch"
        onClick={toggleMyBranches}><UserRound size={13}/><span>Mine</span></button>
      <button type="button" className={`repository-updates ${incomingOnly ? "active" : ""}`} aria-label="Incoming" aria-pressed={incomingOnly}
        data-shortcut="explorer-incoming" title={`${incoming.size} repositories with incoming commits`}
        onClick={() => setIncomingOnly(on => !on)}><ArrowDown size={13}/><span>Incoming</span></button>
      <button type="button" className={`repository-updates ${changesOnly ? "active" : ""}`} aria-label="Changes" aria-pressed={changesOnly}
        data-shortcut="explorer-changes" title="Show repositories with uncommitted changes"
        onClick={() => setChangesOnly(on => !on)}><Pencil size={13}/><span>Changes</span></button>
    </div>
    <button type="button" className={`repository-overview-link ${activeGroup === null && focusedId === null ? "active" : ""}`} aria-current={activeGroup === null} aria-label="All repositories"
      data-tree-group="" data-tooltip="Show all repositories or drop items here to move them to the top level" onClick={() => { clearSelection(); setFocusedEntry(null); library().selectGroup(null); }}>
      <LayoutGrid size={14}/><span className="explorer-overview-text">All repositories</span><span className="explorer-overview-drop-text" aria-hidden="true">Move to top level</span>
    </button>
    <div ref={tree} className="repository-list explorer-tree" role="tree" aria-label="Folders, repositories and branches" aria-multiselectable="true"
      onKeyDown={selectionKeys} onFocus={event => { const id = rowIdFrom(event.target); if (id) setFocusedEntry(id); }}
      onClick={event => {
        if (!(event.target as HTMLElement).closest("button")) { clearSelection(); setFocusedEntry(null); }
      }}>
      {rows.map(({ entry, depth, expanded, hasChildren }) => {
        if (entry.kind === "branch") {
          const key = repositoryKey(entry.root), reference = entry.branch.fullName;
          return <ExplorerBranchRow key={entry.id} id={entry.id} root={entry.root} branch={entry.branch} refs={entry.refs} upstream={entry.upstream}
            depth={depth} primary={primaryBranches[key] === reference} favorite={branchFavorites[key]?.includes(reference) ?? false}
            focused={focusedId === entry.id} selected={selection.includes(entry.id)}
            viewed={entry.root === active && !overview && tabs[entry.root]?.viewedBranch === reference}
            historyDetached={!!panels.history} withRepository={run => branchNavigation(entry.root, run)}
            onSelect={(event, activate) => select(event, entry, activate)}/>;
        }
        if (entry.kind === "repository") {
          const items = placements(entry);
          const toggle = () => toggleRepository(entry, !!branchLists.get(entry.root)?.rows.length);
          const read = branchReads[entry.root];
          const branchError = tabs[entry.root]?.refsError ?? (!tabs[entry.root]?.info ? tabs[entry.root]?.error : null) ?? (read && "error" in read ? read.error : undefined);
          const hasRefs = branchLists.has(entry.root);
          return <Fragment key={entry.id}><RepositoryNavigationRow root={entry.root} name={entry.name} tab={tabs[entry.root]}
            depth={depth} explorer={{ id: entry.id, focused: focusedId === entry.id, expanded, toggle, remove: () => {
              const roots = uniqueRoots(items.map(item => item.root));
              const keys = new Set(roots.map(repositoryKey));
              const repos = useRepos.getState();
              repos.order.filter(root => keys.has(repositoryKey(root))).forEach(repos.close);
              library().removeRepositories(roots);
              clearSelection();
              setFocusedEntry(null);
            } }} current={entry.root === active && !overview} selected={selection.includes(entry.id)} groupId={entry.parentId ?? undefined}
            selection={uniqueRoots(items.map(item => item.root))}
            createGroup={() => void groupEditorDialog({ roots: uniqueRoots(items.map(item => item.root)), parentId: entry.parentId, onCreated: clearSelection })}
            onPointerDown={event => repositoryDrag.start(event, items)}
            onClick={event => {
              if (repositoryDrag.suppressClick.current) return;
              select(event, entry, () => {
                if (favoritesOnly && favoriteKeys.has(repositoryKey(entry.root))) library().selectGroup(entry.parentId);
                activateRepository(entry.root);
              });
            }}/>
            {expanded && !hasChildren && <div className="explorer-branch-status" role="status"
              style={{ "--tree-depth": Math.min(depth + 1, 12) } as CSSProperties}
              title={branchError}>
              {branchError ? "Could not read branches" : hasRefs ? "No branches" : <><Loader2 className="spin" size={13}/> Loading branches…</>}
            </div>}
          </Fragment>;
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
          {hasChildren ? <button type="button" className="icon-btn sm library-tree-toggle" aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`} aria-expanded={expanded} onClick={toggle}>
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
      {!rows.length && <div className="cg-empty">{branchFilter || statusFiltered ? "No matching folders, repositories or branches" : "Open a repository or import a folder"}</div>}
    </div>
    <Splitter dir="v" style={{ right: -3, left: "auto" }} onDrag={delta => setWidth(w => Math.max(175, Math.min(420, w + delta)))} onEnd={() => setLayout({ workspacesWidth: width })}/>
  </aside>;
}
