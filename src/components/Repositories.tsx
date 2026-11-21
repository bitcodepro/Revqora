import { useShallow } from "zustand/react/shallow";
import { useLibrary, uniqueRoots, repositoryKey, groupRepositoryRoots } from "../lib/repositoryLibrary";
import { treeSubtreeIds, visibleTree } from "../lib/libraryTree";
import { groupEditorDialog, repositoryLibraryDialog } from "./RepositoryLibrary";
import { repositoryFolderImportDialog } from "./RepositoryFolderImport";
import { useEffect, useState } from "react";
import { useNavigationSelection } from "../lib/navigationSelection";
import { useRepositoryDrag } from "../lib/explorerMoves";
import { activateRepository as activate, matchesGroupShortcut, renameRepositoryOnKey, repositoryMenu, RepositoryNavigationRow } from "./RepositoryNavigationRow";
import { useSettings } from "../lib/settings";
import { ArrowDown, ArrowUp, FolderGit2, FolderSearch, GitBranch, Pencil, Plus, Search, Star, X } from "lucide-react";
import * as A from "../lib/actions";
import { basename, relativeTime } from "../lib/format";
import { pullRepositories } from "../lib/remoteSync";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { repositoryHasChanges, repositoryIncoming, repositoryOutgoing, repositorySidebarStatus, useListedTabs, useRepos, type RepoTab } from "../lib/store";
import { changesOf, trackingOf, useRepositoryTracking } from "../lib/repositoryTracking";
import { contextMenu, toggleRepositoryOverview, useUi } from "../lib/ui";
import { AheadBehind } from "./bits";
import { Splitter } from "./Overlays";
import { usePanelTitleMenu } from "./PanelWindows";
import { namePathMenu } from "./NamePathMenu";
import { runMenuShortcut } from "./menus";

function RepoState({ tab }: { tab: RepoTab }) {
  if (tab.error) return <span className="pill amber" title={tab.error}>{tab.info ? "Needs attention" : "Unavailable"}</span>;
  const status = repositorySidebarStatus(tab);
  if (!status) return <span className="faint">Loading…</span>;
  if (tab.fetchError) return <span className="pill amber" title={tab.fetchError}>Fetch failed</span>;
  if (tab.info?.state.kind !== "none" || status.conflictCount) return <span className="pill amber">Needs attention</span>;
  if (status.files.length) return <span className="pill amber">{status.files.length} changed</span>;
  if (status.ahead && status.behind) return <span className="pill amber">Diverged</span>;
  return <span className="faint">Clean</span>;
}

export function RepositorySidebar() {
  const panelMenu = usePanelTitleMenu("repositories");
  const order = useRepos((s) => s.order);
  const tabs = useListedTabs();
  const active = useRepos((s) => s.active);
  const overview = useUi((s) => s.repositoryOverview);
  const [query, setQuery] = useState("");
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [changesOnly, setChangesOnly] = useState(false);
  const [outgoingOnly, setOutgoingOnly] = useState(false);
  const tracking = useRepositoryTracking(s => s.byKey), changes = useRepositoryTracking(s => s.changes);
  // Only what this list shows: the library store also changes for unrelated settings.
  const library = useLibrary(useShallow(s => ({ activeGroupId: s.activeGroupId, favorites: s.favorites, groups: s.groups, knownRoots: s.knownRoots, repositoryNames: s.repositoryNames, selectGroup: s.selectGroup })));
  const groupId = library.activeGroupId;
  const actionsCollapsed = useSettings(s => s.repositoryActionsCollapsed);
  const navigation = useNavigationSelection<HTMLDivElement>();
  const { selection, clear: clearSelection } = navigation;
  const drag = useRepositoryDrag();
  const { mode, layout: { repositoriesWidth: width }, setLayout: set } = useWorkspaceLayout();
  const [w, setW] = useState(width);
  useEffect(() => setW(width), [mode, width]);
  const groups = visibleTree(library.groups, () => true, () => false, false);
  const groupFilter = library.groups.find(group => group.id === groupId);
  const scope = groupFilter ? treeSubtreeIds(library.groups, [groupFilter.id]) : null;
  const groupKeys = groupFilter && new Set(groupRepositoryRoots(library.groups, groupFilter.id).map(repositoryKey));
  const candidates = uniqueRoots([...order, ...library.knownRoots]).filter(root => !groupKeys || groupKeys.has(repositoryKey(root)));
  const count = candidates.filter(root => repositoryIncoming(tabs[root], trackingOf(tracking, root)) > 0).length;
  const outgoingCount = candidates.filter(root => repositoryOutgoing(tabs[root], trackingOf(tracking, root)) > 0).length;
  const favorite = new Set(library.favorites.map(repositoryKey));
  const displayName = (root: string) => library.repositoryNames[repositoryKey(root)] ?? tabs[root]?.info?.name ?? basename(root);
  const search = query.trim().toLowerCase();
  const filterUpdates = updatesOnly;
  const visible = candidates.filter(root => `${root} ${displayName(root)}`.toLowerCase().includes(search)
    && (!filterUpdates || repositoryIncoming(tabs[root], trackingOf(tracking, root)) > 0) && (!outgoingOnly || repositoryOutgoing(tabs[root], trackingOf(tracking, root)) > 0) && (!favoritesOnly || favorite.has(repositoryKey(root)))
    && (!changesOnly || repositoryHasChanges(tabs[root], changesOf(changes, root))));
  const selected = visible.filter(root => selection.includes(root));
  const groupIdsByRoot = new Map<string, string[]>();
  for (const group of library.groups) {
    if (scope && !scope.has(group.id)) continue;
    for (const root of group.roots) {
      const key = repositoryKey(root);
      const ids = groupIdsByRoot.get(key) ?? [];
      ids.push(group.id);
      groupIdsByRoot.set(key, ids);
    }
  }
  const placements = (roots: string[]) => roots.flatMap(root => {
    const ids = groupIdsByRoot.get(repositoryKey(root)) ?? [null];
    return ids.map(groupId => ({ root, groupId }));
  });
  return (
    <div ref={navigation.panel} className="repository-sidebar" style={{ width: w }}>
      <header onContextMenu={panelMenu}><FolderGit2 size={15} /><b>Repositories</b><span className="pill">{candidates.length}</span><div className="spacer" /><button aria-label="Hide repositories" className="icon-btn sm" title="Hide repositories" onClick={() => set({ repositoriesOpen: false })}><X size={13} /></button></header>
      <div className="repository-filter input-wrap"><Search size={13} /><input className="input sm" placeholder="Find repository…" aria-label="Find repository" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      {groups.length > 0 && <select className="input sm repository-group-filter" aria-label="Repository group" value={groupId ?? ""} onChange={event => library.selectGroup(event.target.value || null)}><option value="">All repositories</option>{groups.map(({ entry, depth }) => <option key={entry.id} value={entry.id}>{"　".repeat(depth)}{entry.name}</option>)}</select>}
      {/* The same status filters as Explorer; they combine with the search and each other. */}
      <div className="explorer-filters repository-sidebar-filters">
        <button type="button" className={`repository-updates ${favoritesOnly ? "active" : ""}`} aria-label="Favorites" aria-pressed={favoritesOnly}
          title="Show favorite repositories" onClick={() => setFavoritesOnly(!favoritesOnly)}><Star size={13} /><span>Favorites</span></button>
        <button type="button" className={`repository-updates ${updatesOnly ? "active" : ""}`} aria-label="Incoming" aria-pressed={updatesOnly}
          title={`${count} repositories with incoming commits`} onClick={() => setUpdatesOnly(!updatesOnly)}><ArrowDown size={13} /><span>Incoming</span></button>
        <button type="button" className={`repository-updates ${outgoingOnly ? "active" : ""}`} aria-label="Outgoing" aria-pressed={outgoingOnly}
          title={`${outgoingCount} repositories with commits to push`} onClick={() => setOutgoingOnly(!outgoingOnly)}><ArrowUp size={13} /><span>Outgoing</span></button>
        <button type="button" className={`repository-updates ${changesOnly ? "active" : ""}`} aria-label="Changes" aria-pressed={changesOnly}
          title="Show repositories with uncommitted changes" onClick={() => setChangesOnly(!changesOnly)}><Pencil size={13} /><span>Changes</span></button>
      </div>
      {selected.length > 0 && <small className="repository-selection-note">{selected.length} selected</small>}
      <div className="repository-list repository-flat-list" role="list" aria-label="Open repositories" onClick={event => {
        if (!(event.target as HTMLElement).closest("button")) clearSelection();
      }}>
        {visible.map(root => {
          const roots = selected.includes(root) ? selected : [root];
          const source = placements([root]);
          return <RepositoryNavigationRow key={root} root={root} name={displayName(root)} tab={tabs[root]}
            current={root === active && !overview} selected={selected.includes(root)} selection={roots}
            groupId={source.length === 1 ? source[0].groupId ?? undefined : groupId ?? undefined}
            createGroup={() => void groupEditorDialog({ roots, parentId: groupId, onCreated: clearSelection })}
            onPointerDown={event => drag.start(event, placements(roots))}
            onSelectionKeyDown={event => navigation.keyDown(event, visible, root, active)}
            onClick={event => {
              if (drag.suppressClick.current) return;
              if (!navigation.select(visible, root, active, event.shiftKey, event.ctrlKey || event.metaKey)) activate(root);
            }}/>;
        })}
        {!visible.length && <div className="cg-empty">No matching repositories</div>}
      </div>
      {!actionsCollapsed && <div className="repository-actions" role="group" aria-label="Repository sidebar actions">
        <div className="repository-actions-head">
          <button type="button" className={`repository-updates ${updatesOnly ? "active" : ""}`} aria-pressed={updatesOnly} onClick={() => setUpdatesOnly(!updatesOnly)}>{count} with incoming commits{updatesOnly ? " · Show all" : ""}</button>
          <button type="button" className="icon-btn sm" aria-label="Collapse repository actions" title="Collapse repository actions" onClick={() => useSettings.getState().set({ repositoryActionsCollapsed: true })}><X size={13} /></button>
        </div>
        <button type="button" className="btn sm repository-add" onClick={() => void repositoryLibraryDialog()}>Manage library…</button>
        <button className="btn sm repository-add" onClick={() => A.openRepoDialog()}><Plus size={14} /> Open repositories…</button>
        <button type="button" className="btn sm repository-add" onClick={() => void repositoryFolderImportDialog()}><FolderSearch size={14} /> Import folder…</button>
      </div>}
      <Splitter dir="v" style={{ right: -3, left: "auto" }} onDrag={(d) => setW((v) => Math.max(180, Math.min(360, v + d)))} onEnd={() => set({ repositoriesWidth: w })} />
    </div>
  );
}

export function RepositoryOverview() {
  const order = useRepos(s => s.order);
  const tabs = useRepos((s) => s.tabs);
  const names = useLibrary(s => s.repositoryNames);
  const active = useRepos((s) => s.active);
  const busy = useUi((s) => s.busy.length > 0);
  const [query, setQuery] = useState("");
  const navigation = useNavigationSelection<HTMLDivElement>();
  const { selection: selected, clear: clearSelection } = navigation;
  const groupId = useLibrary(s => s.activeGroupId);
  const groups = useLibrary(s => s.groups);
  const group = groups.find(g => g.id === groupId);
  const groupKeys = group && new Set(groupRepositoryRoots(groups, group.id).map(repositoryKey));
  const displayName = (r: string) => names[repositoryKey(r)] ?? tabs[r]?.info?.name ?? basename(r);
  const scoped = order.filter(root => !groupKeys || groupKeys.has(repositoryKey(root)));
  const visible = scoped.filter(root => `${root} ${displayName(root)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const select = (e: React.MouseEvent, root: string) => {
    if (!navigation.select(visible, root, active, e.shiftKey, e.ctrlKey || e.metaKey)) activate(root);
  };
  const incoming = scoped.filter(root => !!repositorySidebarStatus(tabs[root])?.behind).length;
  return (
    <div ref={navigation.panel} className="repository-overview">
      <header><div><h2>Repositories</h2><span className="faint">{group?.name ?? "All repositories"} · {scoped.length} open · {incoming} with incoming commits</span></div><div className="spacer" /><button className="btn sm" data-shortcut="open" onClick={() => A.openRepoDialog()}><Plus size={14} /> Open</button><button type="button" className="icon-btn" title="Close repository overview" aria-label="Close repository overview" onClick={toggleRepositoryOverview}><X size={16}/></button></header>
      <div className="repository-overview-search input-wrap"><Search size={14} /><input className="input" placeholder="Find repository…" aria-label="Find repository in overview" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      {group && <button className="btn sm" type="button" onClick={() => useLibrary.getState().selectGroup(null)}>Clear group filter · {group.name}</button>}
      <div className="repository-table-scroll" onClick={event => {
        if (!(event.target as HTMLElement).closest("tr")) clearSelection();
      }}>
        <table className="repository-table">
          <thead><tr><th>Repository</th><th>Current branch</th><th>Incoming / outgoing</th><th>Working copy</th><th>Last fetch</th><th /></tr></thead>
          <tbody>
            {visible.map((r) => { const t = tabs[r], status = repositorySidebarStatus(t); return (
              <tr key={r} className={`${r === active ? "active" : ""} ${selected.includes(r) ? "batch-selected" : ""}`} onKeyDown={e => {
                navigation.keyDown(e, visible, r, active);
                if (e.defaultPrevented) return;
                renameRepositoryOnKey(e, r);
                if (!matchesGroupShortcut(e)) return;
                const roots = selected.includes(r) ? visible.filter(root => selected.includes(root)) : [r];
                runMenuShortcut(e, repositoryMenu(r, displayName(r), roots, group?.id, () => void groupEditorDialog({roots, parentId: group?.id, onCreated: clearSelection})));
              }} onClick={e => { if (!(e.target as HTMLElement).closest("button")) select(e, r); }} onContextMenu={e => {
                const roots = selected.includes(r) ? visible.filter(root => selected.includes(root)) : [r];
                contextMenu(e, repositoryMenu(r, displayName(r), roots, group?.id, () => void groupEditorDialog({roots, parentId: group?.id, onCreated: clearSelection})));
              }}>
                <td><button className="repository-name" title={r} onClick={e => select(e, r)}><FolderGit2 size={15} />{displayName(r)}</button></td>
                <td title={t?.info?.head.branch ?? ""} onContextMenu={e => { if (t?.info?.head.branch) contextMenu(e, namePathMenu(t.info.head.branch, r, `refs/heads/${t.info.head.branch}`)); }}><GitBranch size={12} /> {t?.info?.head.branch ?? (t?.info?.head.detached ? "Detached HEAD" : "—")}</td>
                <td>{status ? <AheadBehind ahead={status.ahead} behind={status.behind} /> : "…"}</td>
                <td><RepoState tab={t} /></td>
                <td className="faint">{t.lastFetchedAt ? relativeTime(t.lastFetchedAt / 1000) : "Not fetched this session"}</td>
                <td><button className="btn sm" disabled={busy} title="Fetch, then fast-forward every branch of this repository that only lacks incoming commits" onClick={() => void pullRepositories([r])}>Pull</button></td>
              </tr>
            ); })}
          </tbody>
        </table>
        {!visible.length && <div className="cg-empty">{order.length ? "No matching repositories" : "No open repositories"}</div>}
      </div>
      <div className="repository-overview-note">Counts compare the checked-out branch with its upstream after the latest fetch. Right-click a folder, a repository or selected branches in Explorer to fetch, pull or push them; fetching never changes your working copies.</div>
    </div>
  );
}
