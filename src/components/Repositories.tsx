import { useLibrary, uniqueRoots, repositoryKey, groupRepositoryRoots } from "../lib/repositoryLibrary";
import { treeSubtreeIds, visibleTree } from "../lib/libraryTree";
import { groupEditorDialog, repositoryLibraryDialog } from "./RepositoryLibrary";
import { repositoryFolderImportDialog } from "./RepositoryFolderImport";
import { SyncButton } from "./SyncRepositories";
import { useEffect, useState } from "react";
import { useNavigationSelection } from "../lib/navigationSelection";
import { useRepositoryDrag } from "../lib/explorerMoves";
import { activateRepository as activate, matchesGroupShortcut, renameRepositoryOnKey, repositoryMenu, RepositoryNavigationRow } from "./RepositoryNavigationRow";
import { useSettings } from "../lib/settings";
import { ArrowDownToLine, Check, CircleAlert, FolderGit2, FolderSearch, GitBranch, LayoutGrid, Plus, RefreshCw, Search, X } from "lucide-react";
import { api, errorMessage, newOpId } from "../lib/api";
import * as A from "../lib/actions";
import { basename, relativeTime } from "../lib/format";
import { pullBlockReason, runRepositoryBatch, type BatchResult } from "../lib/repositoryBatch";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { repositorySidebarStatus, useRepos, type RepoTab } from "../lib/store";
import { contextMenu, endBusy, showDialog, startBusy, toast, toggleRepositoryOverview, useUi } from "../lib/ui";
import { AheadBehind } from "./bits";
import { Modal } from "./Modal";
import { Splitter } from "./Overlays";
import { usePanelTitleMenu } from "./PanelWindows";
import { namePathMenu } from "./NamePathMenu";
import { runMenuShortcut } from "./menus";

let running = false;
let choosingPull = false;

async function runBatch(roots: string[], kind: "fetch" | "pull") {
  if (running || useUi.getState().busy.length || !roots.length) return;
  running = true;
  const id = newOpId();
  startBusy(id, kind === "fetch" ? "Fetching repositories" : "Updating repositories");
  let results: BatchResult[] = [];
  try {
    results = await runRepositoryBatch(roots, kind, {
      read: async (root) => {
        const [info, status] = await Promise.all([api.repoInfo(root), api.status(root)]);
        return { info, status };
      },
      fetch: async (root) => {
        try {
          const out = await api.fetch(root, null, true, id);
          useRepos.getState().patch(root, { lastFetchedAt: Date.now(), fetchError: null });
          return out;
        } catch (e) {
          useRepos.getState().patch(root, { fetchError: errorMessage(e) });
          throw e;
        }
      },
      // This path never rebases, stashes, or creates a merge commit.
      pull: async (root) => {
        const out = await api.pull(root, "ff-only", id);
        if (!["done", "fastForward", "upToDate", "upstreamGone"].includes(out.status)) throw new Error(out.message || "Pull needs attention");
        useRepos.getState().patch(root, { lastFetchedAt: Date.now(), fetchError: null });
        return out;
      },
      refresh: (root) => useRepos.getState().refresh(root, { info: true, status: true, refs: true, graph: useRepos.getState().active === root }),
      isOpen: (root) => !!useRepos.getState().tabs[root],
      progress: (root, index, total) => useUi.setState((s) => ({
        busy: s.busy.map((b) => b.id === id ? { ...b, label: `${kind === "fetch" ? "Fetching" : "Pulling"} ${basename(root)} (${index}/${total})`, line: "" } : b),
      })),
    });
  } finally {
    endBusy(id);
    running = false;
  }
  const done = results.filter((r) => r.status === "done").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const summary = `${done} ${kind === "fetch" ? "fetched" : "updated"} · ${skipped} skipped · ${failed} failed`;
  if (!failed && !skipped) toast.success(summary);
  else toast.warning(summary, "Open the results to see which repositories need attention.");
  if (kind === "pull" || failed || skipped) {
    await showDialog<void>((close) => (
      <Modal title={kind === "fetch" ? "Fetch results" : "Pull results"} subtitle={summary} onClose={() => close()} footer={<button className="btn primary" onClick={() => close()}>Done</button>}>
        <div className="batch-list">
          {results.map((r) => (
            <div className="batch-row" key={r.root}>
              {r.status === "done" ? <Check size={16} className="green" /> : <CircleAlert size={16} className="amber" />}
              <div className="grow-text"><b>{basename(r.root)}</b><div className="batch-note">{r.message}</div></div>
              <button className="btn sm" onClick={() => { activate(r.root); close(); }}>Open</button>
            </div>
          ))}
        </div>
      </Modal>
    ));
  }
}

export function fetchRepositories(roots = useRepos.getState().order) {
  return runBatch(roots, "fetch");
}

export async function pullRepositories(onlyRoots?: string[]) {
  if (choosingPull || running || useUi.getState().busy.length) return;
  choosingPull = true;
  const roots = onlyRoots ?? useRepos.getState().order;
  try {
    // Refresh the preview as well as rechecking each repository during execution.
    await Promise.allSettled(roots.map((r) => useRepos.getState().refresh(r, { info: true, status: true, guard: true })));
    const tabs = roots.map((r) => useRepos.getState().tabs[r]).filter((t): t is RepoTab => !!t);
    const selected = await showDialog<string[] | null>((close) => <PullRepositoriesDialog tabs={tabs} close={close} />);
    if (selected?.length) await runBatch(selected, "pull");
  } finally {
    choosingPull = false;
  }
}

function PullRepositoriesDialog({ tabs, close }: { tabs: RepoTab[]; close: (roots: string[] | null) => void }) {
  const [selected, setSelected] = useState(() => new Set(tabs.filter((t) => !t?.fetchError && !pullBlockReason(t)).map((t) => t.root)));
  const submit = () => selected.size && close([...selected]);
  return (
    <Modal title="Pull repositories" subtitle={`${selected.size} selected · checked-out branches only`} onClose={() => close(null)} onSubmit={submit}
      footer={<><button type="button" className="btn" onClick={() => close(null)}>Cancel</button><button type="submit" className="btn primary" disabled={!selected.size}>Pull ({selected.size})</button></>}>
      <div className="callout">Fast-forward only. Repositories with local changes, diverged history, failed fetches or an operation in progress need individual attention. Use Fetch all first to check for remote updates.</div>
      <div className="batch-list">
        {tabs.map((t) => {
          const reason = t?.fetchError ? "Fetch failed — fetch this repository first" : pullBlockReason(t);
          return (
            <label className="batch-row" key={t.root} title={t.root}>
              <input type="checkbox" disabled={!!reason} checked={selected.has(t.root)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(t.root); else n.delete(t.root); return n; })} />
              <div className="grow-text"><b>{t?.info?.name ?? basename(t.root)}</b><div className="batch-note">{reason ?? `${t?.status?.branch} · fast-forward`}</div></div>
              <AheadBehind ahead={t?.status?.ahead ?? 0} behind={t?.status?.behind ?? 0} />
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

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

function SyncButtons({ roots }: { roots: string[] }) {
  const busy = useUi((s) => s.busy.length > 0);
  return (
    <div className="repository-sync">
      <SyncButton roots={roots} label="Sync all" shortcut="sync-all" />
      <button className="btn sm" data-shortcut="fetch-all" disabled={busy || !roots.length} onClick={() => void fetchRepositories(roots)}><RefreshCw size={13} /> Fetch all</button>
      <button className="btn sm" data-shortcut="pull-all" disabled={busy || !roots.length} onClick={() => void pullRepositories(roots)}><ArrowDownToLine size={13} /> Pull all</button>
    </div>
  );
}

export function RepositorySidebar() {
  const panelMenu = usePanelTitleMenu("repositories");
  const order = useRepos((s) => s.order);
  const tabs = useRepos((s) => s.tabs);
  const active = useRepos((s) => s.active);
  const overview = useUi((s) => s.repositoryOverview);
  const [query, setQuery] = useState("");
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const library = useLibrary();
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
  const count = candidates.filter(root => (repositorySidebarStatus(tabs[root])?.behind ?? 0) > 0).length;
  const favorite = new Set(library.favorites.map(repositoryKey));
  const displayName = (root: string) => library.repositoryNames[repositoryKey(root)] ?? tabs[root]?.info?.name ?? basename(root);
  const search = query.trim().toLowerCase();
  const filterUpdates = updatesOnly && !actionsCollapsed;
  const visible = candidates.filter(root => `${root} ${displayName(root)}`.toLowerCase().includes(search)
    && (!filterUpdates || !!repositorySidebarStatus(tabs[root])?.behind) && (!favoritesOnly || favorite.has(repositoryKey(root))));
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
      <header onContextMenu={panelMenu}><FolderGit2 size={15} /><b>Repositories</b><span className="pill">{candidates.length}</span><div className="spacer" /><button className="icon-btn sm" title="Hide repositories" onClick={() => set({ repositoriesOpen: false })}><X size={13} /></button></header>
      <div className="repository-filter input-wrap"><Search size={13} /><input className="input sm" placeholder="Find repository…" aria-label="Find repository" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      {groups.length > 0 && <select className="input sm repository-group-filter" aria-label="Repository group" value={groupId ?? ""} onChange={event => library.selectGroup(event.target.value || null)}><option value="">All repositories</option>{groups.map(({ entry, depth }) => <option key={entry.id} value={entry.id}>{"　".repeat(depth)}{entry.name}</option>)}</select>}
      {!search && !filterUpdates && !favoritesOnly && !groupFilter && <SyncButtons roots={order} />}
      <button type="button" className={`repository-updates ${favoritesOnly ? "active" : ""}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>Favorites{favoritesOnly ? " · Show all" : ""}</button>
      <button className={`repository-overview-link ${overview ? "active" : ""}`} aria-pressed={overview} onClick={() => { clearSelection(); toggleRepositoryOverview(); }}><LayoutGrid size={14} /> All repositories</button>
      {selected.length > 0 && <small className="repository-selection-note">{selected.length} selected</small>}
      <div className="repository-list" role="list" aria-label="Open repositories" onClick={event => {
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
      <header><div><h2>Repositories</h2><span className="faint">{group?.name ?? "All repositories"} · {scoped.length} open · {incoming} with incoming commits</span></div><div className="spacer" />{!query.trim() && !group && <SyncButtons roots={order} />}<button className="btn sm" data-shortcut="open" onClick={() => A.openRepoDialog()}><Plus size={14} /> Open</button><button type="button" className="icon-btn" title="Close repository overview" aria-label="Close repository overview" onClick={toggleRepositoryOverview}><X size={16}/></button></header>
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
                <td><button className="btn sm" disabled={busy || !!t?.fetchError || !!pullBlockReason({ info: t.info, status })} onClick={() => void pullRepositories([r])}>Pull</button></td>
              </tr>
            ); })}
          </tbody>
        </table>
        {!visible.length && <div className="cg-empty">{order.length ? "No matching repositories" : "No open repositories"}</div>}
      </div>
      <div className="repository-overview-note">Counts compare the checked-out branch with its upstream after the latest fetch. Fetch all checks for new commits without changing your working copies.</div>
    </div>
  );
}
