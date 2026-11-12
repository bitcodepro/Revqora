import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basename } from "./format";
import { moveTreeEntries, treeSubtreeIds, type TreeEntry, type TreePlacement } from "./libraryTree";

export type RepositoryView = "history" | "changes" | "pulls";
export interface RepositoryGroup extends TreeEntry {
  roots: string[];
  collapsed: boolean;
  favorite?: boolean;
  importedFrom?: string;
}
export interface FolderGroup { folder: string; roots: string[]; parentFolder?: string | null }
export interface RepositoryPlacement { root: string; groupId: string | null }
export interface RepositoryDropPlacement { siblingRoot: string; after: boolean }
export interface LibraryData {
  knownRoots: string[];
  repositoryNames: Record<string, string>;
  favorites: string[];
  groups: RepositoryGroup[];
  activeGroupId: string | null;
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
  const entries = (values: unknown) => (Array.isArray(values) ? values : []).flatMap(value => {
    const v = record(value), name = validName(v.name);
    const id = typeof v.id === "string" && /^[\w-]{1,100}$/.test(v.id) ? v.id : "";
    return id && name ? [{ id, name, ...parent(v), collapsed: v.collapsed === true, roots: uniqueRoots(v.roots),
      ...(v.favorite === true ? { favorite: true } : {}),
      ...(pathValid(v.importedFrom) ? { importedFrom: v.importedFrom } : {}) }] : [];
  });
  const deduplicate = (groups: RepositoryGroup[]) => groups.filter(group => !ids.has(group.id) && !!ids.add(group.id));
  const groups = repairTree(deduplicate(entries(raw.groups)));
  // Versions with separate workspaces already gave each saved workspace a unique id.
  // Keep those ids and paths so parent links, active selection and re-imports survive.
  const saved = repairTree(deduplicate(entries(raw.workspaces)));
  const favoriteIds = new Set(Array.isArray(raw.favoriteWorkspaceIds) ? raw.favoriteWorkspaceIds : []);
  for (const item of saved) {
    groups.push({ ...item, name: availableGroupName(item.name, siblings(groups, item.parentId ?? null)),
      ...(favoriteIds.has(item.id) ? { favorite: true } : {}) });
  }
  const favorites = uniqueRoots(raw.favorites);
  const knownRoots = uniqueRoots([...uniqueRoots(raw.knownRoots), ...favorites, ...groups.flatMap(group => group.roots)]);
  const names = record(raw.repositoryNames);
  const repositoryNames = Object.fromEntries(knownRoots.flatMap(root => {
    const key = repositoryKey(root), name = validName(names[key]);
    return name ? [[key, name]] : [];
  }));
  const requested = raw.activeGroupId === undefined ? raw.activeWorkspaceId : raw.activeGroupId;
  return { knownRoots, repositoryNames, favorites, groups, activeGroupId: groups.find(group => group.id === requested)?.id ?? null };
}

function availableGroupName(base: string, names: string[]) {
  const used = new Set(names.map(name => name.toLowerCase()));
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    name = base.slice(0, 80 - suffix.length) + suffix;
  }
  return name;
}

export function planFolderGroups(existingGroups: RepositoryGroup[], groups: FolderGroup[]) {
  const existingByFolder = new Map(existingGroups.filter(w => w.importedFrom).map(w => [repositoryKey(w.importedFrom!), w]));
  const ids = new Map(groups.map(({folder}) => {
    const key = repositoryKey(folder);
    return [key, existingByFolder.get(key)?.id ?? newId()];
  }));
  const names = new Map<string | null, Set<string>>();
  const namesAt = (id: string | null) => {
    if (!names.has(id)) names.set(id, new Set());
    return names.get(id)!;
  };
  for (const group of existingGroups) namesAt(group.parentId ?? null).add(group.name.toLowerCase());
  return groups.map(({ folder, roots, parentFolder }) => {
    const key = repositoryKey(folder);
    const existing = existingByFolder.get(key);
    const parentId = existing?.parentId !== undefined ? existing.parentId : parentFolder ? ids.get(repositoryKey(parentFolder)) ?? null : null;
    const siblings = namesAt(parentId);
    const base = validName(basename(folder)) || "Imported group";
    let name = existing?.name ?? base;
    for (let i = 2; siblings.has(name.toLowerCase()) && (!existing || (existing.parentId ?? null) !== parentId); i++) {
      const suffix = ` (${i})`;
      name = base.slice(0, 80 - suffix.length) + suffix;
    }
    siblings.add(name.toLowerCase());
    return { folder, roots, existing, name, id: ids.get(key)!, parentId };
  });
}

export function groupRepositoryRoots(groups: readonly RepositoryGroup[], id: string): string[] {
  const subtree = treeSubtreeIds(groups, [id]);
  return uniqueRoots(groups.filter(group => subtree.has(group.id)).flatMap(group => group.roots));
}

/** Unassigned repositories appear at the root of Explorer, in the implicit Default group. */
export function defaultGroupRoots(roots: string[], groups: readonly RepositoryGroup[]): string[] {
  const assigned = new Set(groups.flatMap(group => group.roots.map(repositoryKey)));
  return roots.filter(root => !assigned.has(repositoryKey(root)));
}

interface LibraryStore extends LibraryData {
  remember: (root: string, alias?: string) => void;
  renameRepository: (root: string, name: string) => void;
  favorite: (root: string) => void;
  favoriteGroup: (id: string) => void;
  group: (name: string, id?: string) => string;
  createGroup: (name: string, roots: string[], groupIds: string[], parentId?: string | null) => string;
  importGroups: (roots: string[], folders: FolderGroup[]) => void;
  moveGroups: (ids: string[], parentId: string | null, placement?: TreePlacement) => void;
  move: (root: string, id: string | null) => void;
  addToGroup: (roots: string[], id: string) => void;
  moveRepositories: (repositories: RepositoryPlacement[], to: string | null, placement?: RepositoryDropPlacement) => void;
  removeFromGroups: (roots: string[], id?: string) => void;
  collapse: (id: string) => void;
  selectGroup: (id: string | null) => void;
  removeGroups: (ids: string[]) => void;
}
function checkedName(name: string, names: string[]) {
  const next = validName(name);
  if (!next) throw new Error("Enter a name.");
  if (names.some(n => n.toLowerCase() === next.toLowerCase())) throw new Error("This name is already in use.");
  return next;
}
const newId = () => crypto.randomUUID();
const siblings = <T extends TreeEntry>(entries: T[], parentId: string | null, except?: string) => entries.filter(item => (item.parentId ?? null) === parentId && item.id !== except).map(item => item.name);
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
    set({ knownRoots: uniqueRoots([...list(s.knownRoots), root]), repositoryNames, favorites: list(s.favorites),
      groups: s.groups.map(g => ({ ...g, roots: list(g.roots) })) });
  },
  renameRepository: (root, name) => set(s => {
    const repositoryNames = { ...s.repositoryNames }, key = repositoryKey(root), next = validName(name);
    if (next) repositoryNames[key] = next;
    else delete repositoryNames[key];
    return { repositoryNames, knownRoots: uniqueRoots([...s.knownRoots, root]) };
  }),
  favorite: root => set(s => {
    const key = repositoryKey(root);
    const exists = s.favorites.some(r => repositoryKey(r) === key);
    return { knownRoots: uniqueRoots([...s.knownRoots, root]),
      favorites: exists ? s.favorites.filter(r => repositoryKey(r) !== key) : [...s.favorites, root] };
  }),
  favoriteGroup: id => set(s => ({ groups: s.groups.map(group => group.id === id ? { ...group, favorite: !group.favorite } : group) })),
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
    const groups = [...s.groups.map(g => ({ ...g, roots: g.roots.filter(root => !keys.has(repositoryKey(root))), collapsed: g.id === parentId ? false : g.collapsed })), group];
    set({ groups: groupIds.length ? moveTreeEntries(groups, groupIds, id) : groups, knownRoots: uniqueRoots([...s.knownRoots, ...members]) });
    return id;
  },
  importGroups: (roots, folders) => set(s => {
    const groups = [...s.groups];
    for (const { folder, roots: members, existing, id, name, parentId } of planFolderGroups(s.groups, folders)) {
      const next = { ...existing, id, name, parentId, importedFrom: folder, collapsed: existing?.collapsed ?? false,
        roots: uniqueRoots([...(existing?.roots ?? []), ...members]) };
      if (existing) groups[groups.indexOf(existing)] = next;
      else groups.push(next);
    }
    return { groups: repairTree(groups), knownRoots: uniqueRoots([...s.knownRoots, ...roots]) };
  }),
  moveGroups: (ids, parentId, placement) => set(s => ({
    groups: moveTreeEntries(s.groups, ids, parentId, placement).map(group =>
      group.id === parentId && !placement && group.collapsed ? { ...group, collapsed: false } : group),
  })),
  move: (root, id) => set(s => {
    if (id && !s.groups.some(group => group.id === id)) return s;
    return { knownRoots: uniqueRoots([...s.knownRoots, root]), groups: s.groups.map(group => ({
      ...group, roots: [...group.roots.filter(path => repositoryKey(path) !== repositoryKey(root)), ...(group.id === id ? [root] : [])],
    })) };
  }),
  addToGroup: (roots, id) => set(s => {
    if (!s.groups.some(g => g.id === id)) return s;
    return { knownRoots: uniqueRoots([...s.knownRoots, ...roots]),
      groups: s.groups.map(g => g.id === id ? { ...g, roots: uniqueRoots([...g.roots, ...roots]) } : g) };
  }),
  moveRepositories: (repositories, to, placement) => set(s => {
    if (to && !s.groups.some(group => group.id === to)) return s;
    const moving = placement ? repositories : repositories.filter(item => item.groupId !== to);
    const roots = uniqueRoots(moving.map(item => item.root));
    if (!roots.length) return s;
    const movingKeys = new Set(roots.map(repositoryKey));
    const sibling = placement && repositoryKey(placement.siblingRoot);
    if (sibling) {
      const destination = to ? s.groups.find(group => group.id === to)!.roots : defaultGroupRoots(s.knownRoots, s.groups);
      if (movingKeys.has(sibling) || !destination.some(root => repositoryKey(root) === sibling)) return s;
    }
    const insert = (existing: string[]) => {
      if (!placement) return uniqueRoots([...existing, ...roots]);
      const result = existing.filter(root => !movingKeys.has(repositoryKey(root)));
      const index = result.findIndex(root => repositoryKey(root) === sibling);
      result.splice(index + Number(placement.after), 0, ...roots);
      return result;
    };
    const sources = new Map<string | null, Set<string>>();
    for (const { root, groupId } of moving) {
      const keys = sources.get(groupId) ?? new Set();
      keys.add(repositoryKey(root));
      sources.set(groupId, keys);
    }
    const knownRoots = !to && placement ? insert(s.knownRoots) : uniqueRoots([...s.knownRoots, ...roots]);
    const groups = s.groups.map(group => {
      const keys = to ? sources.get(group.id) : movingKeys;
      const members = group.id === to ? insert(group.roots) : keys ? group.roots.filter(root => !keys.has(repositoryKey(root))) : group.roots;
      const collapsed = group.id === to ? false : group.collapsed;
      return collapsed === group.collapsed && members.length === group.roots.length && members.every((root, i) => root === group.roots[i])
        ? group : { ...group, roots: members, collapsed };
    });
    const changes: Partial<LibraryData> = {};
    if (knownRoots.length !== s.knownRoots.length || knownRoots.some((root, i) => root !== s.knownRoots[i])) changes.knownRoots = knownRoots;
    if (groups.some((group, i) => group !== s.groups[i])) changes.groups = groups;
    return changes.groups || changes.knownRoots ? changes : s;
  }),
  removeFromGroups: (roots, id) => set(s => {
    const keys = new Set(roots.map(repositoryKey));
    return { groups: s.groups.map(g => id === undefined || g.id === id ? { ...g, roots: g.roots.filter(root => !keys.has(repositoryKey(root))) } : g) };
  }),
  collapse: id => set(s => ({ groups: s.groups.map(g => g.id === id ? { ...g, collapsed: !g.collapsed } : g) })),
  selectGroup: id => set(s => ({ activeGroupId: s.groups.some(group => group.id === id) ? id : null })),
  removeGroups: ids => set(s => {
    const removed = treeSubtreeIds(s.groups, ids);
    return { groups: s.groups.filter(group => !removed.has(group.id)),
      activeGroupId: s.activeGroupId && removed.has(s.activeGroupId) ? null : s.activeGroupId };
  }),
}), {
  name: "revqora.repositories",
  version: 2,
  partialize: ({ knownRoots, repositoryNames, favorites, groups, activeGroupId }) => ({ knownRoots, repositoryNames, favorites, groups, activeGroupId }),
  migrate: restoreLibrary,
  merge: (stored, current) => ({ ...current, ...restoreLibrary(stored) }),
}));
