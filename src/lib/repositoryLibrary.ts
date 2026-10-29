import { create } from "zustand";
import { persist } from "zustand/middleware";
import { restoreWorkspaceLayouts, type HistoryMode, type WorkspaceLayout, type WorkspaceMode } from "./workspaceLayouts";

export type RepositoryView = "history" | "changes" | "pulls";
export interface RepositoryGroup { id: string; name: string; roots: string[]; collapsed: boolean }
export interface WorkspaceSnapshot {
  roots: string[];
  activeRoot: string | null;
  views: Record<string, RepositoryView>;
  layouts: Record<WorkspaceMode, WorkspaceLayout>;
  historyMode: HistoryMode;
}
export interface SavedWorkspace extends WorkspaceSnapshot { id: string; name: string }
export interface LibraryData {
  knownRoots: string[];
  favorites: string[];
  groups: RepositoryGroup[];
  workspaces: SavedWorkspace[];
  activeWorkspaceId: string | null;
}

/** Windows identities are case insensitive; Unix identities are not. */
export function repositoryKey(root: string): string {
  const path = root.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}
const pathValid = (value: unknown): value is string => typeof value === "string" && value.length <= 32768 && !value.includes("\0") && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value);
export function uniqueRoots(value: unknown): string[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).filter((v): v is string => pathValid(v) && !seen.has(repositoryKey(v)) && !!seen.add(repositoryKey(v)));
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const validName = (v: unknown) => typeof v === "string" ? v.trim().slice(0, 80) : "";
export function restoreLibrary(value: unknown): LibraryData {
  const raw = record(value);
  const ids = new Set<string>();
  function entries<T>(values: unknown, build: (v: Record<string, unknown>, id: string, name: string) => T): T[] {
    const names = new Set<string>();
    return (Array.isArray(values) ? values : []).flatMap((value) => {
      const v = record(value), name = validName(v.name), id = typeof v.id === "string" && /^[\w-]{1,100}$/.test(v.id) ? v.id : "";
      if (!name || !id || ids.has(id) || names.has(name.toLowerCase())) return [];
      ids.add(id); names.add(name.toLowerCase());
      return [build(v, id, name)];
    });
  }
  const assigned = new Set<string>();
  const groups = entries(raw.groups, (v, id, name): RepositoryGroup => ({ id, name, collapsed: v.collapsed === true, roots: uniqueRoots(v.roots).filter((r) => !assigned.has(repositoryKey(r)) && !!assigned.add(repositoryKey(r))) }));
  const workspaces = entries(raw.workspaces, (v, id, name): SavedWorkspace => {
    const roots = uniqueRoots(v.roots), views: Record<string, RepositoryView> = {};
    for (const root of roots) { const view = record(v.views)[root]; if (view === "history" || view === "changes" || view === "pulls") views[root] = view; }
    return { id, name, roots, activeRoot: roots.find((r) => typeof v.activeRoot === "string" && repositoryKey(r) === repositoryKey(v.activeRoot)) ?? roots[0] ?? null, views, layouts: restoreWorkspaceLayouts(v), historyMode: v.historyMode === "review" || v.historyMode === "columns" ? v.historyMode : "graph" };
  });
  const favorites = uniqueRoots(raw.favorites);
  return { knownRoots: uniqueRoots([...uniqueRoots(raw.knownRoots), ...favorites, ...groups.flatMap((g) => g.roots), ...workspaces.flatMap((w) => w.roots)]), favorites, groups, workspaces, activeWorkspaceId: workspaces.some((w) => w.id === raw.activeWorkspaceId) ? raw.activeWorkspaceId as string : null };
}
interface LibraryStore extends LibraryData {
  remember: (root: string, alias?: string) => void;
  favorite: (root: string) => void;
  group: (name: string, id?: string) => string;
  move: (root: string, id: string | null) => void;
  collapse: (id: string) => void;
  removeGroup: (id: string) => void;
  save: (name: string, snapshot: WorkspaceSnapshot) => string;
  update: (id: string, snapshot: WorkspaceSnapshot) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
}
function checkedName(name: string, names: string[], current?: string) {
  const next = validName(name);
  if (!next) throw new Error("Enter a name.");
  if (names.some((n) => n !== current && n.toLowerCase() === next.toLowerCase())) throw new Error("This name is already in use.");
  return next;
}
const newId = () => crypto.randomUUID();
export const useLibrary = create<LibraryStore>()(persist((set, get) => ({
  ...restoreLibrary({}),
  remember: (root, alias) => {
    const s = get();
    const remap = (r: string) => repositoryKey(r) === repositoryKey(alias ?? root) ? root : r;
    const list = (roots: string[]) => uniqueRoots(roots.map(remap));
    set({ knownRoots: uniqueRoots([...list(s.knownRoots), root]), favorites: list(s.favorites), groups: s.groups.map((g) => ({ ...g, roots: list(g.roots) })), workspaces: s.workspaces.map((w) => ({ ...w, roots: list(w.roots), activeRoot: w.activeRoot ? remap(w.activeRoot) : null, views: Object.fromEntries(Object.entries(w.views).map(([r, v]) => [remap(r), v])) })) });
  },
  favorite: (root) => { const s = get(); set({ knownRoots: uniqueRoots([...s.knownRoots, root]), favorites: s.favorites.some((r) => repositoryKey(r) === repositoryKey(root)) ? s.favorites.filter((r) => repositoryKey(r) !== repositoryKey(root)) : [...s.favorites, root] }); },
  group: (name, id) => { const s = get(), old = s.groups.find((g) => g.id === id), next = checkedName(name, s.groups.map((g) => g.name), old?.name), key = old?.id ?? newId(); set({ groups: old ? s.groups.map((g) => g.id === key ? { ...g, name: next } : g) : [...s.groups, { id: key, name: next, roots: [], collapsed: false }] }); return key; },
  move: (root, id) => { const s = get(); if (id && !s.groups.some((g) => g.id === id)) return; set({ knownRoots: uniqueRoots([...s.knownRoots, root]), groups: s.groups.map((g) => ({ ...g, roots: [...g.roots.filter((r) => repositoryKey(r) !== repositoryKey(root)), ...(g.id === id ? [root] : [])] })) }); },
  collapse: (id) => set({ groups: get().groups.map((g) => g.id === id ? { ...g, collapsed: !g.collapsed } : g) }),
  removeGroup: (id) => set({ groups: get().groups.filter((g) => g.id !== id) }),
  save: (name, snapshot) => { const s = get(), id = newId(); const next = checkedName(name, s.workspaces.map((w) => w.name)); set({ workspaces: [...s.workspaces, { ...structuredClone(snapshot), id, name: next }], activeWorkspaceId: id }); return id; },
  update: (id, snapshot) => set({ workspaces: get().workspaces.map((w) => w.id === id ? { ...w, ...structuredClone(snapshot) } : w) }),
  rename: (id, name) => { const s = get(), old = s.workspaces.find((w) => w.id === id); if (!old) return; const next = checkedName(name, s.workspaces.map((w) => w.name), old.name); set({ workspaces: s.workspaces.map((w) => w.id === id ? { ...w, name: next } : w) }); },
  remove: (id) => set({ workspaces: get().workspaces.filter((w) => w.id !== id), activeWorkspaceId: get().activeWorkspaceId === id ? null : get().activeWorkspaceId }),
  select: (id) => set({ activeWorkspaceId: id && get().workspaces.some((w) => w.id === id) ? id : null }),
}), { name: "revqora.repositories", version: 1, merge: (stored, current) => ({ ...current, ...restoreLibrary(stored) }) }));
