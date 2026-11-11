import { create } from "zustand";
import { persist } from "zustand/middleware";
import { restoreWorkspaceLayouts, type HistoryMode, type WorkspaceLayout, type WorkspaceMode } from "./workspaceLayouts";
import { basename } from "./format";
import { moveTreeEntries, treeAncestors, type TreeEntry } from "./libraryTree";

export type RepositoryView = "history" | "changes" | "pulls";
export interface RepositoryGroup extends TreeEntry { roots: string[]; collapsed: boolean }
export interface WorkspaceSnapshot {
  roots: string[];
  activeRoot: string | null;
  views: Record<string, RepositoryView>;
  layouts: Record<WorkspaceMode, WorkspaceLayout>;
  historyMode: HistoryMode;
}
export interface SavedWorkspace extends WorkspaceSnapshot, TreeEntry {
  importedFrom?: string;
  collapsed?: boolean;
  excludedGroupIds?: string[];
}
export interface FolderWorkspace { folder: string; roots: string[]; parentFolder?: string | null }
export interface LibraryData {
  knownRoots: string[];
  repositoryNames: Record<string, string>;
  favorites: string[];
  groups: RepositoryGroup[];
  workspaces: SavedWorkspace[];
  favoriteWorkspaceIds: string[];
  activeWorkspaceId: string | null;
}

/** Windows identities are case insensitive; Unix identities are not. */
export function repositoryKey(root: string): string {
  const normalized = root.replace(/\\/g, "/");
  const path = /^(?:[a-z]:)?\/$/i.test(normalized) ? normalized : normalized.replace(/\/$/, "");
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}
const pathValid = (value: unknown): value is string => typeof value === "string" && value.length <= 32768 && !value.includes("\0") && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value);
export function uniqueRoots(value: unknown): string[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).filter((v): v is string => pathValid(v) && !seen.has(repositoryKey(v)) && !!seen.add(repositoryKey(v)));
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const validName = (v: unknown) => typeof v === "string" ? v.trim().slice(0, 80) : "";
const parent = (v: Record<string, unknown>) => typeof v.parentId === "string" ? { parentId: v.parentId } : v.parentId === null ? { parentId: null } : {};

export function repairTree<T extends TreeEntry>(entries: T[]): T[] {
  const parents = new Map(entries.map(entry => [entry.id, entry.parentId]));
  return entries.map(entry => {
    const seen = new Set([entry.id]);
    let id = entry.parentId;
    while (id) {
      if (!parents.has(id) || seen.has(id)) return { ...entry, parentId: null };
      seen.add(id);
      id = parents.get(id);
    }
    return entry;
  });
}

export function restoreLibrary(value: unknown): LibraryData {
  const raw = record(value);
  const ids = new Set<string>();
  function entries<T>(values: unknown, build: (v: Record<string, unknown>, id: string, name: string) => T): T[] {
    return (Array.isArray(values) ? values : []).flatMap((value) => {
      const v = record(value), name = validName(v.name), id = typeof v.id === "string" && /^[\w-]{1,100}$/.test(v.id) ? v.id : "";
      if (!name || !id || ids.has(id)) return [];
      ids.add(id);
      return [build(v, id, name)];
    });
  }
  const groups = repairTree(entries(raw.groups, (v, id, name): RepositoryGroup => ({ id, name, ...parent(v), collapsed: v.collapsed === true, roots: uniqueRoots(v.roots) })));
  const workspaces = repairTree(entries(raw.workspaces, (v, id, name): SavedWorkspace => {
    const roots = uniqueRoots(v.roots), views: Record<string, RepositoryView> = {};
    for (const root of roots) { const view = record(v.views)[root]; if (view === "history" || view === "changes" || view === "pulls") views[root] = view; }
    const excludedGroupIds = Array.isArray(v.excludedGroupIds) ? groups.filter(g => (v.excludedGroupIds as unknown[]).includes(g.id)).map(g => g.id) : [];
    return { id, name, ...parent(v), ...(v.collapsed === true ? { collapsed: true } : {}), roots, activeRoot: roots.find((r) => typeof v.activeRoot === "string" && repositoryKey(r) === repositoryKey(v.activeRoot)) ?? roots[0] ?? null, views, layouts: restoreWorkspaceLayouts(v), historyMode: v.historyMode === "review" || v.historyMode === "columns" ? v.historyMode : "graph", ...(pathValid(v.importedFrom) ? { importedFrom: v.importedFrom } : {}), ...(excludedGroupIds.length ? { excludedGroupIds } : {}) };
  }));
  const favorites = uniqueRoots(raw.favorites);
  const favoriteWorkspaceIds = Array.isArray(raw.favoriteWorkspaceIds) ? workspaces.filter(w => (raw.favoriteWorkspaceIds as unknown[]).includes(w.id)).map(w => w.id) : [];
  const knownRoots = uniqueRoots([...uniqueRoots(raw.knownRoots), ...favorites, ...groups.flatMap((g) => g.roots), ...workspaces.flatMap((w) => w.roots)]);
  const names = record(raw.repositoryNames);
  const repositoryNames = Object.fromEntries(knownRoots.flatMap(root => {
    const key = repositoryKey(root), name = validName(names[key]);
    return name ? [[key, name]] : [];
  }));
  return { knownRoots, repositoryNames, favorites, groups, workspaces, favoriteWorkspaceIds, activeWorkspaceId: workspaces.some((w) => w.id === raw.activeWorkspaceId) ? raw.activeWorkspaceId as string : null };
}

export function planFolderWorkspaces(workspaces: SavedWorkspace[], groups: FolderWorkspace[]) {
  const existingByFolder = new Map(workspaces.filter(w => w.importedFrom).map(w => [repositoryKey(w.importedFrom!), w]));
  const ids = new Map(groups.map(({folder}) => {
    const key = repositoryKey(folder);
    return [key, existingByFolder.get(key)?.id ?? newId()];
  }));
  const names = new Map<string | null, Set<string>>();
  const namesAt = (id: string | null) => {
    if (!names.has(id)) names.set(id, new Set());
    return names.get(id)!;
  };
  for (const workspace of workspaces) namesAt(workspace.parentId ?? null).add(workspace.name.toLowerCase());
  return groups.map(({ folder, roots, parentFolder }) => {
    const key = repositoryKey(folder);
    const existing = existingByFolder.get(key);
    const parentId = existing?.parentId !== undefined ? existing.parentId : parentFolder ? ids.get(repositoryKey(parentFolder)) ?? null : null;
    const siblings = namesAt(parentId);
    const base = validName(basename(folder)) || "Imported workspace";
    let name = existing?.name ?? base;
    for (let i = 2; siblings.has(name.toLowerCase()) && (!existing || (existing.parentId ?? null) !== parentId); i++) {
      const suffix = ` (${i})`;
      name = base.slice(0, 80 - suffix.length) + suffix;
    }
    siblings.add(name.toLowerCase());
    return { folder, roots, existing, name, id: ids.get(key)!, parentId };
  });
}

export function groupRepositoryRoots(groups: RepositoryGroup[], id: string): string[] {
  return uniqueRoots(groups.filter(group => group.id === id || treeAncestors(groups, group.id).includes(id)).flatMap(group => group.roots));
}

export function groupsInWorkspace(groups: RepositoryGroup[], workspace?: SavedWorkspace): RepositoryGroup[] {
  if (!workspace?.excludedGroupIds?.length) return groups;
  const excluded = new Set(workspace.excludedGroupIds);
  return groups.filter(g => !excluded.has(g.id) && !treeAncestors(groups, g.id).some(id => excluded.has(id)));
}
interface LibraryStore extends LibraryData {
  remember: (root: string, alias?: string) => void;
  renameRepository: (root: string, name: string) => void;
  favorite: (root: string) => void;
  favoriteWorkspace: (id: string) => void;
  group: (name: string, id?: string) => string;
  createGroup: (name: string, roots: string[], groupIds: string[], parentId?: string | null) => string;
  moveGroups: (ids: string[], parentId: string | null) => void;
  move: (root: string, id: string | null) => void;
  addToGroup: (roots: string[], id: string) => void;
  removeFromGroups: (roots: string[], id?: string) => void;
  setWorkspaceGroupsExcluded: (workspaceId: string, groupIds: string[], excluded: boolean) => void;
  collapse: (id: string) => void;
  removeGroups: (ids: string[]) => void;
  save: (name: string, snapshot: WorkspaceSnapshot, activate?: boolean, parentId?: string | null) => string;
  moveWorkspace: (id: string, parentId: string | null) => void;
  collapseWorkspace: (id: string) => void;
  update: (id: string, snapshot: WorkspaceSnapshot) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
}
function checkedName(name: string, names: string[]) {
  const next = validName(name);
  if (!next) throw new Error("Enter a name.");
  if (names.some(n => n.toLowerCase() === next.toLowerCase())) throw new Error("This name is already in use.");
  return next;
}
const newId = () => crypto.randomUUID();
const siblings = <T extends TreeEntry>(entries: T[], parentId: string | null, except?: string) => entries.filter(item => (item.parentId ?? null) === parentId && item.id !== except).map(item => item.name);
function deleteTreeEntries<T extends TreeEntry>(entries: T[], ids: ReadonlySet<string>): T[] {
  // Keep child folders and their contents accessible at the root.
  return entries.filter(entry => !ids.has(entry.id)).map(entry => entry.parentId && ids.has(entry.parentId) ? { ...entry, parentId: null } : entry);
}
export const useLibrary = create<LibraryStore>()(persist((set, get) => ({
  ...restoreLibrary({}),
  remember: (root, alias) => {
    const s = get();
    if ((!alias || alias === root) && s.knownRoots.includes(root)) return;
    const remap = (r: string) => repositoryKey(r) === repositoryKey(alias ?? root) ? root : r;
    const list = (roots: string[]) => uniqueRoots(roots.map(remap));
    const from = repositoryKey(alias ?? root), to = repositoryKey(root);
    const repositoryNames = { ...s.repositoryNames };
    if (from !== to && repositoryNames[from]) {
      repositoryNames[to] ??= repositoryNames[from];
      delete repositoryNames[from];
    }
    set({ knownRoots: uniqueRoots([...list(s.knownRoots), root]), repositoryNames, favorites: list(s.favorites), groups: s.groups.map((g) => ({ ...g, roots: list(g.roots) })), workspaces: s.workspaces.map((w) => ({ ...w, roots: list(w.roots), activeRoot: w.activeRoot ? remap(w.activeRoot) : null, views: Object.fromEntries(Object.entries(w.views).map(([r, v]) => [remap(r), v])) })) });
  },
  renameRepository: (root, name) => set(s => {
    const repositoryNames = { ...s.repositoryNames }, key = repositoryKey(root), next = validName(name);
    if (next) repositoryNames[key] = next;
    else delete repositoryNames[key];
    return { repositoryNames, knownRoots: uniqueRoots([...s.knownRoots, root]) };
  }),
  favorite: (root) => { const s = get(); set({ knownRoots: uniqueRoots([...s.knownRoots, root]), favorites: s.favorites.some((r) => repositoryKey(r) === repositoryKey(root)) ? s.favorites.filter((r) => repositoryKey(r) !== repositoryKey(root)) : [...s.favorites, root] }); },
  favoriteWorkspace: (id) => set(s => !s.workspaces.some(w => w.id === id) ? s : { favoriteWorkspaceIds: s.favoriteWorkspaceIds.includes(id) ? s.favoriteWorkspaceIds.filter(key => key !== id) : [...s.favoriteWorkspaceIds, id] }),
  group: (name, id) => {
    const s = get(), old = s.groups.find(g => g.id === id);
    if (!old) return s.createGroup(name, [], []);
    const next = checkedName(name, siblings(s.groups, old.parentId ?? null, old.id));
    set({ groups: s.groups.map(g => g.id === id ? { ...g, name: next } : g) });
    return old.id;
  },
  createGroup: (name, roots, groupIds, parentId = null) => {
    const s = get(), id = newId(), members = uniqueRoots(roots), keys = new Set(members.map(repositoryKey));
    if (parentId && !s.groups.some(g => g.id === parentId)) throw Error("Choose an existing parent group.");
    const group = { id, name: checkedName(name, siblings(s.groups, parentId)), parentId, roots: members, collapsed: false };
    const groups = [...s.groups.map(g => ({ ...g, roots: g.roots.filter(root => !keys.has(repositoryKey(root))) })), group];
    set({ groups: groupIds.length ? moveTreeEntries(groups, groupIds, id) : groups, knownRoots: uniqueRoots([...s.knownRoots, ...members]) });
    return id;
  },
  moveGroups: (ids, parentId) => set(s => ({ groups: moveTreeEntries(s.groups, ids, parentId) })),
  move: (root, id) => { const s = get(); if (id && !s.groups.some((g) => g.id === id)) return; set({ knownRoots: uniqueRoots([...s.knownRoots, root]), groups: s.groups.map((g) => ({ ...g, roots: [...g.roots.filter((r) => repositoryKey(r) !== repositoryKey(root)), ...(g.id === id ? [root] : [])] })) }); },
  addToGroup: (roots, id) => set(s => {
    if (!s.groups.some(g => g.id === id)) return s;
    return {
      knownRoots: uniqueRoots([...s.knownRoots, ...roots]),
      groups: s.groups.map(g => g.id === id ? { ...g, roots: uniqueRoots([...g.roots, ...roots]) } : g),
    };
  }),
  removeFromGroups: (roots, id) => set(s => {
    const keys = new Set(roots.map(repositoryKey));
    return { groups: s.groups.map(g => id === undefined || g.id === id ? { ...g, roots: g.roots.filter(root => !keys.has(repositoryKey(root))) } : g) };
  }),
  setWorkspaceGroupsExcluded: (workspaceId, groupIds, excluded) => set(s => {
    const ids = new Set(groupIds.filter(id => s.groups.some(g => g.id === id)));
    return { workspaces: s.workspaces.map(w => {
      if (w.id !== workspaceId) return w;
      const previous = w.excludedGroupIds ?? [];
      return { ...w, excludedGroupIds: excluded ? [...new Set([...previous, ...ids])] : previous.filter(id => !ids.has(id)) };
    }) };
  }),
  collapse: (id) => set({ groups: get().groups.map((g) => g.id === id ? { ...g, collapsed: !g.collapsed } : g) }),
  removeGroups: (ids) => set(s => {
    const removed = new Set(ids);
    return {
      groups: deleteTreeEntries(s.groups, removed),
      workspaces: s.workspaces.map(w => w.excludedGroupIds?.some(id => removed.has(id)) ? { ...w, excludedGroupIds: w.excludedGroupIds.filter(id => !removed.has(id)) } : w),
    };
  }),
  save: (name, snapshot, activate = true, parentId = null) => {
    const s = get(), id = newId();
    if (parentId && !s.workspaces.some(w => w.id === parentId)) throw Error("Choose an existing parent workspace.");
    const next = checkedName(name, siblings(s.workspaces, parentId));
    set({
      knownRoots: uniqueRoots([...s.knownRoots, ...snapshot.roots]),
      workspaces: [...s.workspaces, { ...structuredClone(snapshot), id, name: next, parentId }],
      activeWorkspaceId: activate ? id : s.activeWorkspaceId,
    });
    return id;
  },
  moveWorkspace: (id, parentId) => set(s => ({ workspaces: moveTreeEntries(s.workspaces, [id], parentId) })),
  collapseWorkspace: (id) => set(s => ({ workspaces: s.workspaces.map(w => w.id === id ? { ...w, collapsed: !w.collapsed } : w) })),
  update: (id, snapshot) => set({ workspaces: get().workspaces.map((w) => w.id === id ? { ...w, ...structuredClone(snapshot) } : w) }),
  rename: (id, name) => { const s = get(), old = s.workspaces.find(w => w.id === id); if (!old) return; const next = checkedName(name, siblings(s.workspaces, old.parentId ?? null, id)); set({ workspaces: s.workspaces.map(w => w.id === id ? { ...w, name: next } : w) }); },
  remove: (id) => set(s => ({ workspaces: deleteTreeEntries(s.workspaces, new Set([id])), favoriteWorkspaceIds: s.favoriteWorkspaceIds.filter(key => key !== id), activeWorkspaceId: s.activeWorkspaceId === id ? null : s.activeWorkspaceId })),
  select: (id) => set({ activeWorkspaceId: id && get().workspaces.some((w) => w.id === id) ? id : null }),
}), { name: "revqora.repositories", version: 1, merge: (stored, current) => ({ ...current, ...restoreLibrary(stored) }) }));
