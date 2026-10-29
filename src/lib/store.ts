import { useLibrary } from "./repositoryLibrary";
import { invalidatePreview } from "./commitPreview";
// Repository tabs and their cached state.
import { create } from "zustand";
import { api, errorMessage } from "./api";
import { useSettings } from "./settings";
import { useUi } from "./ui";
import type { GraphSummary, LayersState, RefsSnapshot, RepoExtras, RepoInfo, StatusSummary } from "./types";
import { WORKTREE } from "./types";
import { setOperationHooks } from "./operationClient";

export type View = "history" | "changes" | "pulls";

export type ChangeSel =
  | { kind: "unstaged"; path: string; untracked: boolean }
  | { kind: "staged"; path: string }
  | { kind: "conflict"; path: string }
  | { kind: "layer"; layer: number; path: string };

export interface RepoTab {
  pendingMutations: number;
  root: string;
  info: RepoInfo | null;
  status: StatusSummary | null;
  refs: RefsSnapshot | null;
  /** Branches whose changes are already in HEAD without a merge link (squash / rebase merged). */
  squashMerged: string[];
  extras: RepoExtras | null;
  layers: LayersState | null;
  graph: GraphSummary | null;
  graphVersion: number;
  graphLoading: boolean;
  graphHasWorktree: boolean;
  branchFilter: string | null;
  graphLimit: number;
  view: View;
  selected: string | null;
  multi: string[];
  changeSel: ChangeSel | null;
  conflictPath: string | null;
  error: string | null;
  loaded: boolean;
  lastFetchedAt: number | null;
  fetchError: string | null;
}

export interface Parts {
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
  open: (path: string, activate?: boolean) => Promise<string | null>;
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
    graphLoading: false,
    graphHasWorktree: false,
    branchFilter: null,
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

export const useRepos = create<RepoStore>()((set, get) => ({
  tabs: {},
  order: [],
  active: null,

  open: async (path, activate = true) => {
    let info: RepoInfo;
    try {
      info = await api.repoOpen(path);
    } catch (e) {
      throw e;
    }
    const root = info.root;
    useLibrary.getState().remember(root, path);
    const s = get();
    if (!s.tabs[root]) {
      const tab = emptyTab(root);
      tab.info = info;
      set({ tabs: { ...s.tabs, [root]: tab }, order: [...s.order, root] });
    }
    if (activate) {
      set({ active: root });
      useUi.setState({ repositoryOverview: false });
    }
    useSettings.getState().addRecent(root);
    persistTabs();
    api.watchRepo(root).catch(() => {});
    // Load in the background so restoring several tabs does not wait for every history.
    void get().refresh(root, ALL);
    return root;
  },

  close: (root) => {
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
    set({ tabs, order, active });
    api.unwatchRepo(root).catch(() => {});
    persistTabs();
    if (active && active !== s.active) void get().refresh(active, ALL);
  },

  activate: (root) => {
    set({ active: root });
    useUi.setState({ repositoryOverview: false });
    persistTabs();
    if (root) void get().refresh(root, { info: true, status: true, refs: true, graph: true });
  },

  arrange: (roots, active) => {
    const order = [...new Set([...roots, ...get().order])].filter((r) => !!get().tabs[r]);
    set({ order, active: active && order.includes(active) ? active : order[0] ?? null });
    persistTabs();
  },

  patch: (root, p) => {
    const t = get().tabs[root];
    if (!t) return;
    // A delayed read started before a queued mutation must not replace its newer state.
    if (p.status && (p.status.stateVersion ?? 0) < (t.status?.stateVersion ?? 0)) {
      p = { ...p };
      delete p.status;
    }
    set({ tabs: { ...get().tabs, [root]: { ...t, ...p } } });
  },

  refresh: async (root, parts = ALL) => {
    invalidatePreview(root);
    if (inflight.has(root)) {
      pending.set(root, merge(pending.get(root), parts));
      return inflight.get(root);
    }
    const job = (async () => {
      let todo: Parts | undefined = parts;
      while (todo) {
        await refreshOnce(root, todo);
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
  observed: (root) => useRepos.getState().tabs[root]?.status?.stateToken ?? null,
  observedHead: (root) => useRepos.getState().tabs[root]?.info?.head ?? null,
  refreshed: (root, status, info) => {
    if (useRepos.getState().tabs[root]) useRepos.getState().patch(root, { status, info });
  },
});

async function refreshOnce(root: string, parts: Parts) {
  const store = useRepos.getState();
  if (!store.tabs[root]) return;
  const patch: Partial<RepoTab> = {};
  // Everything starts at once; the history only waits for the (fast) status, which decides
  // whether the "Uncommitted changes" row is part of the graph.
  const infoP = parts.info || parts.status ? api.repoInfo(root) : Promise.resolve(null);
  const statusP = parts.status ? api.status(root) : Promise.resolve(null);
  const refsP = parts.refs ? api.refs(root) : Promise.resolve(null);
  const extrasP = parts.refs || parts.info ? api.repoExtras(root).catch(() => null) : Promise.resolve(null);
  const layersP = parts.layers || parts.status ? api.layersState(root).catch(() => null) : Promise.resolve(null);
  for (const p of [infoP, refsP]) p.catch(() => {}); // rejections are handled below
  let graphP: Promise<void> | null = null;
  try {
    const status = await statusP;
    const tab = useRepos.getState().tabs[root];
    if (!tab) return;
    const st = status ?? tab.status;
    const dirty = !!st && st.files.length > 0;
    if (status) useRepos.getState().patch(root, { status });
    if (parts.graph || dirty !== tab.graphHasWorktree || !tab.graph) graphP = loadGraph(root, dirty);
    const [info, refs, layers, extras] = await Promise.all([infoP, refsP, layersP, extrasP]);
    if (info) patch.info = info;
    if (refs) patch.refs = refs;
    if (extras) patch.extras = extras;
    if (layers) patch.layers = layers;
    patch.error = null;
  } catch (e) {
    patch.error = errorMessage(e);
  }
  if (!useRepos.getState().tabs[root]) return;
  useRepos.getState().patch(root, { ...patch, loaded: true });
  if (patch.refs) updateSquashMerged(root);
  // Wait for history only when it was explicitly requested; a dirty/clean toggle reloads it in the background.
  if (graphP && parts.graph) await graphP;
}

export async function loadGraph(root: string, includeWorktree?: boolean) {
  const store = useRepos.getState();
  const tab = store.tabs[root];
  if (!tab) return;
  const dirty = includeWorktree ?? (!!tab.status && tab.status.files.length > 0);
  store.patch(root, { graphLoading: true });
  try {
    // First paint: the newest commits without the full ordered walk, then the whole history.
    if (!tab.graph) {
      const quick = await api.graphLoad(root, tab.branchFilter, dirty, 2000, true).catch(() => null);
      const t0 = useRepos.getState().tabs[root];
      if (quick && t0 && !t0.graph) useRepos.getState().patch(root, { graph: quick, graphVersion: t0.graphVersion + 1, graphHasWorktree: dirty });
    }
    const summary = await api.graphLoad(root, tab.branchFilter, dirty, useRepos.getState().tabs[root]?.graphLimit ?? tab.graphLimit);
    const t = useRepos.getState().tabs[root];
    if (!t) return;
    let selected = t.selected;
    if (selected === WORKTREE && !dirty) selected = null;
    useRepos.getState().patch(root, { graph: summary, graphVersion: t.graphVersion + 1, graphLoading: false, graphHasWorktree: dirty, selected });
  } catch (e) {
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
