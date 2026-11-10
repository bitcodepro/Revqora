import { repositoryKey, uniqueRoots, useLibrary } from "./repositoryLibrary";
import { repositoryQueue } from "./repositoryQueue";
import { invalidatePreview } from "./commitPreview";
import {forgetGraphRows} from "./graphRowsCache";
import {forgetWorkingDiff} from "./workingDiffSnapshot";
// Repository tabs and their cached state.
import { create } from "zustand";
import { api, errorMessage } from "./api";
import { useSettings } from "./settings";
import { useUi } from "./ui";
import type { GraphSummary, LayersState, RefsSnapshot, RepoExtras, RepoInfo, StatusSummary } from "./types";
import { WORKTREE } from "./types";
import { setOperationHooks } from "./operationClient";

export type View = "history" | "changes" | "pulls";
export const CURRENT_HISTORY_BRANCH = "HEAD";

export type ChangeSel =
  | { kind: "unstaged"; path: string; untracked: boolean }
  | { kind: "staged"; path: string }
  | { kind: "conflict"; path: string }
  | { kind: "layer"; layer: number; path: string };

export interface RepoTab {
  pendingMutations: number;
  root: string;
  openAliases?: string[];
  info: RepoInfo | null;
  status: StatusSummary | null;
  /** Display-only observation; never supplies mutation or diff preconditions. */
  sidebarStatus?: StatusSummary | null;
  refs: RefsSnapshot | null;
  /** Branches whose changes are already in HEAD without a merge link (squash / rebase merged). */
  squashMerged: string[];
  extras: RepoExtras | null;
  layers: LayersState | null;
  graph: GraphSummary | null;
  graphVersion: number;
  historyJump?: string | null;
  diffRefreshVersion: number;
  graphLoading: boolean;
  graphHasWorktree: boolean;
  branchFilter: string | null;
  viewedBranch?: string | null;
  graphLimit: number;
  view: View;
  selected: string | null;
  multi: string[];
  changeSel: ChangeSel | null;
  conflictPath: string | null;
  error: string | null;
  loaded: boolean;
  opening?: boolean;
  lastFetchedAt: number | null;
  fetchError: string | null;
}

export interface Parts {
  /** Refresh cached UI without reloading history or previews for unchanged refs. */
  revalidate?: boolean;
  /** Sidebar observations do not need histories, layers or branch analysis. */
  summary?: boolean;
  /** Explicit action preview needs full mutation preconditions even off-screen. */
  guard?: boolean;
  /** Filesystem observation, rather than an explicit refresh/action. */
  background?: boolean;
  info?: boolean;
  status?: boolean;
  refs?: boolean;
  layers?: boolean;
  graph?: boolean;
}

export const ALL: Parts = { info: true, status: true, refs: true, layers: true, graph: true };

interface RepoStore {
  tabs: Record<string, RepoTab>;
  order: string[];
  active: string | null;
  selectionVersion: number;
  open: (path: string, activate?: boolean) => Promise<string | null>;
  openMany: (paths: string[], active?: string | null) => Promise<PromiseSettledResult<string | null>[]>;
  close: (root: string) => void;
  activate: (root: string | null) => void;
  arrange: (roots: string[], active: string | null) => void;
  patch: (root: string, p: Partial<RepoTab>) => void;
  refresh: (root: string, parts?: Parts) => Promise<void>;
}

function emptyTab(root: string): RepoTab {
  return {
    pendingMutations: 0,
    root,
    info: null,
    status: null,
    refs: null,
    squashMerged: [],
    extras: null,
    layers: null,
    graph: null,
    graphVersion: 0,
    diffRefreshVersion: 0,
    graphLoading: false,
    graphHasWorktree: false,
    branchFilter: CURRENT_HISTORY_BRANCH,
    graphLimit: 150_000,
    view: "history",
    selected: null,
    multi: [],
    changeSel: null,
    conflictPath: null,
    error: null,
    loaded: false,
    lastFetchedAt: null,
    fetchError: null,
  };
}

const inflight = new Map<string, Promise<void>>();
const pending = new Map<string, Parts>();
const squashJobs = new Map<string, { wanted: string; done: string; running: boolean }>();
const openingQueue = repositoryQueue();
const summaryQueue = repositoryQueue();
const openingJobs = new Map<string, Promise<string | null>>();
const lifetimes = new Map<string, symbol>();

function existingRoot(path: string) {
  return useRepos.getState().order.find(root => repositoryKey(root) === repositoryKey(path));
}

function carryRepositoryView(tabs: RepoStore["tabs"], root: string | null, from: RepoTab | undefined) {
  const next = root ? tabs[root] : undefined;
  if (next && from && next.view !== from.view) return { ...tabs, [next.root]: { ...next, view: from.view } };
  return tabs;
}

/** Publish the entire roster before starting any asynchronous Git discovery. */
function register(paths: string[], active?: string | null): string[] {
  const state = useRepos.getState(), tabs = { ...state.tabs }, order = [...state.order];
  const roots = uniqueRoots(paths).map(path => {
    const root = order.find(r => repositoryKey(r) === repositoryKey(path)) ?? path;
    if (!tabs[root]) {
      tabs[root] = { ...emptyTab(root), opening: true };
      lifetimes.set(root, Symbol(root));
      order.push(root);
    }
    return root;
  });
  const selected = active ? order.find(r => repositoryKey(r) === repositoryKey(active)) : undefined;
  const next = selected ?? state.active ?? order[0] ?? null;
  useRepos.setState(active === undefined ? { tabs, order } : {
    tabs: carryRepositoryView(tabs, next, state.active ? state.tabs[state.active] : undefined),
    order, active: next, selectionVersion: state.selectionVersion + 1,
  });
  if (active !== undefined) useUi.setState({ repositoryOverview: false });
  persistTabs();
  return roots;
}

function hydrate(root: string): Promise<string | null> {
  const prior = openingJobs.get(root);
  if (prior) return prior;
  if (useRepos.getState().tabs[root]?.info) return Promise.resolve(root);
  const lifetime = lifetimes.get(root);
  const current = () => lifetimes.get(root) === lifetime && !!useRepos.getState().tabs[root];
  const job = openingQueue.run(root, async () => {
    if (!current()) return null;
    useRepos.getState().patch(root, { opening: true, error: null });
    try {
      const info = await api.repoOpen(root);
      if (!current()) return null;
      const actual = existingRoot(info.root) ?? info.root;
      const state = useRepos.getState();
      if (actual !== root) {
        const tabs = { ...state.tabs }, original = tabs[root];
        const existing = tabs[actual];
        delete tabs[root];
        tabs[actual] = {
          ...(existing ?? { ...original, root: actual }),
          openAliases: uniqueRoots([...(existing?.openAliases ?? []), ...(original.openAliases ?? []), root]),
        };
        lifetimes.delete(root);
        if (!lifetimes.has(actual)) lifetimes.set(actual, lifetime ?? Symbol(actual));
        const active = state.active === root ? actual : state.active;
        useRepos.setState({
          tabs: carryRepositoryView(tabs, active, state.active === root ? original : undefined),
          order: [...new Set(state.order.map(r => r === root ? actual : r))], active,
        });
      }
      useRepos.getState().patch(actual, { info, opening: false, error: null });
      useLibrary.getState().remember(actual, root);
      if (actual !== root) persistTabs();
      const actualLifetime = lifetimes.get(actual);
      void api.watchRepo(actual).then(() => {
        if (!useRepos.getState().tabs[actual]) return api.unwatchRepo(actual);
      }).catch(() => {});
      if (useRepos.getState().active === actual) void useRepos.getState().refresh(actual, ALL);
      else await useRepos.getState().refresh(actual, { background: true, summary: true, status: true });
      return lifetimes.get(actual) === actualLifetime ? actual : null;
    } catch (error) {
      if (current()) useRepos.getState().patch(root, { opening: false, loaded: true, error: errorMessage(error) });
      throw error;
    }
  });
  openingJobs.set(root, job);
  void job.finally(() => { if (openingJobs.get(root) === job) openingJobs.delete(root); }).catch(() => {});
  return job;
}

/** Coalesce background branch analysis; rapid refreshes must not create a Git backlog. */
function updateSquashMerged(root: string) {
  const tab = useRepos.getState().tabs[root];
  if (!tab?.refs) return;
  const key = `${tab.status?.oid ?? ""}|${[...tab.refs.local, ...tab.refs.remote].map((b) => `${b.name}:${b.oid}`).join("|")}`;
  let job = squashJobs.get(root);
  if (!job) { job = { wanted: key, done: "", running: false }; squashJobs.set(root, job); }
  job.wanted = key;
  if (job.running || job.done === key) return;
  job.running = true;
  const current = job;
  void (async () => {
    try {
      while (current.done !== current.wanted && squashJobs.get(root) === current && useRepos.getState().tabs[root]) {
        const wanted = current.wanted;
        try {
          const squashMerged = await api.squashMerged(root);
          if (squashJobs.get(root) === current && current.wanted === wanted && useRepos.getState().tabs[root]) useRepos.getState().patch(root, { squashMerged });
        } catch { /* This optional annotation must not block the workspace. */ }
        current.done = wanted;
      }
    } finally { current.running = false; }
  })();
}

function merge(a: Parts | undefined, b: Parts): Parts {
  return {
    revalidate: a ? !!a.revalidate && !!b.revalidate : b.revalidate,
    summary: a ? !!a.summary && !!b.summary : b.summary,
    guard: a?.guard || b.guard,
    background: a ? !!a.background && !!b.background : b.background,
    info: a?.info || b.info,
    status: a?.status || b.status,
    refs: a?.refs || b.refs,
    layers: a?.layers || b.layers,
    graph: a?.graph || b.graph,
  };
}

function persistTabs() {
  const { order, active } = useRepos.getState();
  useSettings.getState().set({ openTabs: order, activeTab: active });
}

function includeWorkingChanges(tab: RepoTab, dirty: boolean) {
  const branch = tab.info?.head?.branch;
  return dirty && (!tab.branchFilter || tab.branchFilter === CURRENT_HISTORY_BRANCH || !!branch && tab.branchFilter === `refs/heads/${branch}`);
}

export const useRepos = create<RepoStore>()((set, get) => ({
  tabs: {},
  order: [],
  active: null,
  selectionVersion: 0,

  open: async (path, activate = true) => {
    const [root] = register([path], activate ? path : undefined);
    if (!root) return null;
    if (activate) get().activate(root);
    const actual = await hydrate(root);
    if (actual && activate) useSettings.getState().addRecent(actual);
    return actual;
  },

  openMany: (paths, active) => {
    const roots = register(paths, active);
    if (active !== undefined && get().active && get().tabs[get().active!]?.info) get().activate(get().active);
    // Selection is an intent recorded now, never a late activation after I/O.
    const first = get().active;
    const prioritized = [...roots].sort((a, b) => Number(b === first) - Number(a === first));
    const jobs = new Map(prioritized.map(root => [root, hydrate(root)]));
    return Promise.allSettled(roots.map(root => jobs.get(root)!));
  },

  close: (root) => {
    forgetGraphRows(root);
    forgetWorkingDiff(root);
    lifetimes.delete(root);
    openingJobs.delete(root);
    pending.delete(root);
    graphRequests.set(root, (graphRequests.get(root) ?? 0) + 1);
    invalidatePreview(root);
    squashJobs.delete(root);
    const s = get();
    const order = s.order.filter((r) => r !== root);
    const tabs = { ...s.tabs };
    delete tabs[root];
    let active = s.active;
    if (active === root) {
      const i = s.order.indexOf(root);
      active = order[Math.min(i, order.length - 1)] ?? null;
    }
    set({ tabs: carryRepositoryView(tabs, active, s.active ? s.tabs[s.active] : undefined), order, active, selectionVersion: s.selectionVersion + Number(active !== s.active) });
    api.unwatchRepo(root).catch(() => {});
    persistTabs();
    if (active && active !== s.active) get().activate(active);
  },

  activate: (root) => {
    const s = get();
    set({ tabs: carryRepositoryView(s.tabs, root, s.active ? s.tabs[s.active] : undefined), active: root, selectionVersion: s.selectionVersion + 1 });
    useUi.setState({ repositoryOverview: false });
    persistTabs();
    if (root) {
      openingQueue.prioritize(root);
      summaryQueue.prioritize(root);
      if (get().tabs[root]?.info) void get().refresh(root, {...ALL,graph:!get().tabs[root].graph,background:true,revalidate:true});
      else void hydrate(root).catch(() => {});
    }
  },

  arrange: (roots, active) => {
    const order = [...new Set([...roots, ...get().order])].filter((r) => !!get().tabs[r]);
    set({ order });
    get().activate(active && order.includes(active) ? active : order[0] ?? null);
  },

  patch: (root, p) => {
    const t = get().tabs[root];
    if (!t) return;
    // A delayed read started before a queued mutation must not replace its newer state.
    if (p.status && (p.status.stateVersion ?? 0) < (t.status?.stateVersion ?? 0)) {
      p = { ...p };
      delete p.status;
    }
    if (p.status && (p.status.stateVersion ?? 0) >= (t.sidebarStatus?.stateVersion ?? 0)) p = { ...p, sidebarStatus: p.status };
    if (p.sidebarStatus && (p.sidebarStatus.stateVersion ?? 0) < Math.max(t.sidebarStatus?.stateVersion ?? 0, t.status?.stateVersion ?? 0)) {
      p = { ...p }; delete p.sidebarStatus;
    }
    if (p.status?.diffContextToken && p.status.diffContextToken !== t.status?.diffContextToken) {
      // An index-only .gitattributes edit can arrive as an ordinary status event.
      // Invalidate interpretation independently from unrelated worktree content.
      invalidatePreview(root);
    }
    set({ tabs: { ...get().tabs, [root]: { ...t, ...p } } });
  },

  refresh: async (root, parts = ALL) => {
    if (!get().tabs[root] || get().tabs[root].opening) return;
    if (get().active !== root) parts = { ...parts, summary: true, graph: false, layers: false, refs: false };
    // Ordinary working-file activity does not change immutable commit previews.
    // Metadata/attribute events and explicit refreshes still invalidate them.
    if (!parts.revalidate && (!parts.background || parts.info || parts.refs || parts.graph)) invalidatePreview(root);
    if (!parts.background) {
      const tab = get().tabs[root];
      if (tab) get().patch(root, { diffRefreshVersion: tab.diffRefreshVersion + 1 });
    }
    if (inflight.has(root)) {
      pending.set(root, merge(pending.get(root), parts));
      return inflight.get(root);
    }
    const job = (async () => {
      let todo: Parts | undefined = parts;
      while (todo) {
        const read = todo;
        if (read.summary) await summaryQueue.run(root, () => refreshOnce(root, read));
        else await refreshOnce(root, read);
        todo = pending.get(root);
        pending.delete(root);
      }
    })();
    inflight.set(root, job);
    try {
      await job;
    } finally {
      inflight.delete(root);
    }
  },
}));

setOperationHooks({
  pending: (root, delta) => {
    const tab = useRepos.getState().tabs[root];
    if (tab) useRepos.getState().patch(root, { pendingMutations: Math.max(0, tab.pendingMutations + delta) });
  },
  observed: (root) => {
    const tab = useRepos.getState().tabs[root];
    const status = tab?.status, head = tab?.info?.head;
    // Status can finish before repo_info during an external checkout. A token
    // for the new branch is not a coherent displayed precondition while its
    // heading is still old. Let operationClient re-read and reject that mismatch.
    if (head && status && (head.branch !== status.branch || head.oid !== status.oid)) return null;
    return status?.stateToken ?? null;
  },
  observedHead: (root) => useRepos.getState().tabs[root]?.info?.head ?? null,
  refreshed: (root, status, info) => {
    if (useRepos.getState().tabs[root]) useRepos.getState().patch(root, { status, info });
  },
});

async function refreshOnce(root: string, parts: Parts) {
  const store = useRepos.getState();
  if (!store.tabs[root]) return;
  const lifetime = lifetimes.get(root);
  const current = () => !!useRepos.getState().tabs[root] && lifetimes.get(root) === lifetime;
  const patch: Partial<RepoTab> = {};
  const before = store.tabs[root];
  let updatedRefs = false;
  // Everything starts at once; the history only waits for the (fast) status, which decides
  // whether the "Uncommitted changes" row is part of the graph.
  const infoP = parts.info || (parts.status && !parts.summary) ? api.repoInfo(root) : Promise.resolve(null);
  const sidebarOnly = parts.summary && !parts.guard;
  const statusP = parts.status ? (sidebarOnly ? api.repositorySidebarStatus(root) : api.status(root)) : Promise.resolve(null);
  const refsP = parts.refs ? api.refs(root).then(refs => {
    // Keep the existing rows during a quiet check if their data is identical.
    if (parts.revalidate && JSON.stringify(refs) === JSON.stringify(before.refs)) return null;
    return refs;
  }) : Promise.resolve(null);
  const extrasP = !parts.summary && (parts.refs || parts.info) ? api.repoExtras(root).catch(() => null) : Promise.resolve(null);
  const layersP = !parts.summary && (parts.layers || parts.status) ? api.layersState(root).catch(() => null) : Promise.resolve(null);
  // Publish independently: slow layers/extras must not hide local branch info
  // or refs that are already ready. The full status still owns action guards.
  void infoP.then(info=>{if(info&&current())useRepos.getState().patch(root,{info});}).catch(()=>{});
  void refsP.then(refs=>{
    if(!refs||!current())return;
    const state=useRepos.getState(), scope=state.tabs[root]?.branchFilter;
    const missing=scope?.startsWith("refs/") && !refs.local.some(branch=>branch.fullName===scope) && !refs.remote.some(branch=>branch.fullName===scope);
    state.patch(root,missing?{refs,branchFilter:CURRENT_HISTORY_BRANCH,selected:null,multi:[],historyJump:null}:{refs});
    if(missing)void loadGraph(root);
  }).catch(()=>{});
  for (const p of [infoP, refsP]) p.catch(() => {}); // rejections are handled below
  const initialDirty=!!(before.status??before.sidebarStatus)?.files.length;
  let graphP: Promise<void> | null = !parts.summary&&parts.graph&&!before.graph?loadGraph(root,initialDirty):null;
  try {
    const status = await statusP;
    const tab = useRepos.getState().tabs[root];
    if (!tab || !current()) return;
    const st = status ?? tab.status;
    const dirty = !!st && st.files.length > 0;
    if (status) useRepos.getState().patch(root, sidebarOnly ? { sidebarStatus: status } : { status });
    if (!parts.summary && ((parts.graph&&!graphP) || includeWorkingChanges(tab, dirty) !== (graphP?includeWorkingChanges(before, initialDirty):tab.graphHasWorktree) || !tab.graph&&!graphP)) graphP = loadGraph(root, dirty);
    const [info, refs] = await Promise.all([infoP, refsP]);
    const graphHeadChanged=info&&before.graph?.headOid!==undefined&&before.graph.headOid!==(info.head.oid??"");
    const graphChanged=graphHeadChanged||(info&&JSON.stringify(info.head)!==JSON.stringify(before.info?.head))||!!refs;
    if(parts.revalidate&&current()&&graphChanged){invalidatePreview(root);if(!graphP)graphP=loadGraph(root,dirty);}
    const [layers, extras] = await Promise.all([layersP, extrasP]);
    updatedRefs = !!refs;
    if (extras) patch.extras = extras;
    if (layers) patch.layers = layers;
    patch.error = null;
  } catch (e) {
    patch.error = errorMessage(e);
  }
  if (!current()) return;
  useRepos.getState().patch(root, { ...patch, loaded: true });
  if (updatedRefs) updateSquashMerged(root);
  // Wait for history only when it was explicitly requested; a dirty/clean toggle reloads it in the background.
  if (graphP && parts.graph) await graphP;
}

const graphRequests = new Map<string, number>();
const graphQueues = new Map<string, Promise<void>>();

// The backend has one graph-row cache per repository. Serialize builds so an
// older filter cannot finish last and replace the cache behind a newer view.
export async function loadGraph(root: string, includeWorktree?: boolean) {
  const request = (graphRequests.get(root) ?? 0) + 1;
  graphRequests.set(root, request);
  const previous = graphQueues.get(root);
  const job = (async () => {
    if (previous) await previous.catch(() => {});
    if (graphRequests.get(root) !== request) return;
    await loadGraphOnce(root, includeWorktree, () => graphRequests.get(root) === request);
  })();
  graphQueues.set(root, job);
  try { await job; } finally { if (graphQueues.get(root) === job) graphQueues.delete(root); }
}

async function loadGraphOnce(root: string, includeWorktree: boolean | undefined, current: () => boolean) {
  const store = useRepos.getState();
  const tab = store.tabs[root];
  if (!tab) return;
  const dirty = includeWorkingChanges(tab, includeWorktree ?? (!!tab.status && tab.status.files.length > 0));
  const showIncoming = !useSettings.getState().hideIncomingByRepo[root];
  store.patch(root, { graphLoading: true });
  try {
    // First paint: the newest commits without the full ordered walk, then the whole history.
    if (!tab.graph) {
      const quick = await api.graphLoad(root, tab.branchFilter, dirty, 2000, true, showIncoming).catch(() => null);
      if (!current()) return;
      const t0 = useRepos.getState().tabs[root];
      if (quick && t0 && !t0.graph) useRepos.getState().patch(root, { graph: quick, graphVersion: t0.graphVersion + 1, graphHasWorktree: dirty });
    }
    const summary = await api.graphLoad(root, tab.branchFilter, dirty, useRepos.getState().tabs[root]?.graphLimit ?? tab.graphLimit, false, showIncoming);
    if (!current()) return;
    const t = useRepos.getState().tabs[root];
    if (!t) return;
    let selected = t.selected;
    if (selected === WORKTREE && !dirty) selected = null;
    useRepos.getState().patch(root, { graph: summary, graphVersion: t.graphVersion + 1, graphLoading: false, graphHasWorktree: dirty, selected });
  } catch (e) {
    if (!current()) return;
    useRepos.getState().patch(root, { graphLoading: false, error: errorMessage(e) });
  }
}

export function useActiveTab(): RepoTab | null {
  return useRepos((s) => (s.active ? s.tabs[s.active] ?? null : null));
}

export function activeRoot(): string | null {
  return useRepos.getState().active;
}

export function getTab(root: string): RepoTab | undefined {
  return useRepos.getState().tabs[root];
}

export function repositorySidebarStatus(tab: RepoTab | undefined) {
  return tab?.sidebarStatus ?? tab?.status ?? null;
}
