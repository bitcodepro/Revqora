export interface TreeEntry { id: string; name: string; parentId?: string | null }

export function treeAncestors<T extends TreeEntry>(entries: readonly T[], id: string): string[] {
  return ancestorIds(new Map(entries.map(entry => [entry.id, entry.parentId])), id);
}

function ancestorIds(parents: Map<string, string | null | undefined>, id: string): string[] {
  const seen = new Set([id]);
  const result: string[] = [];
  let parent = parents.get(id);
  while (parent && parents.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    result.push(parent);
    parent = parents.get(parent);
  }
  return result;
}

export function visibleTree<T extends TreeEntry>(entries: readonly T[], isMatch: (entry: T) => boolean, isCollapsed: (entry: T) => boolean, filtering: boolean) {
  const keep = new Set<string>();
  const children = new Map<string | null, T[]>();
  const parents = new Map(entries.map(entry => [entry.id, entry.parentId]));
  for (const entry of entries) {
    const parent = entry.parentId && parents.has(entry.parentId) ? entry.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(entry);
    children.set(parent, list);
    if (!filtering || isMatch(entry)) {
      keep.add(entry.id);
      if (filtering) ancestorIds(parents, entry.id).forEach(id => keep.add(id));
    }
  }
  const result: { entry: T; depth: number; hasChildren: boolean; expanded: boolean }[] = [];
  const pending = (children.get(null) ?? []).slice().reverse().map(entry => ({ entry, depth: 0 }));
  while (pending.length) {
    const { entry, depth } = pending.pop()!;
    if (!keep.has(entry.id)) continue;
    const visibleChildren = (children.get(entry.id) ?? []).filter(child => keep.has(child.id));
    const expanded = filtering || !isCollapsed(entry);
    result.push({ entry, depth, hasChildren: visibleChildren.length > 0, expanded });
    if (expanded) pending.push(...visibleChildren.reverse().map(child => ({ entry: child, depth: depth + 1 })));
  }
  return result;
}

export function treeSelection(ids: string[], selected: string[], anchor: string | null, id: string, range: boolean, toggle: boolean): string[] {
  const start = anchor ? ids.indexOf(anchor) : -1, end = ids.indexOf(id);
  if (range && start >= 0 && end >= 0) {
    const between = ids.slice(Math.min(start, end), Math.max(start, end) + 1);
    return toggle ? [...new Set([...selected, ...between])] : between;
  }
  return toggle && selected.includes(id) ? selected.filter(item => item !== id) : toggle ? [...selected, id] : [id];
}

export function moveTreeEntries<T extends TreeEntry>(entries: T[], ids: string[], parentId: string | null): T[] {
  const selected = new Set(ids);
  const parents = new Map(entries.map(entry => [entry.id, entry.parentId]));
  if (ids.some(id => !parents.has(id))) throw Error("One of the selected folders no longer exists.");
  const moving = entries.filter(entry => selected.has(entry.id) && !ancestorIds(parents, entry.id).some(id => selected.has(id)));
  if (!moving.length || (parentId && !entries.some(entry => entry.id === parentId))) throw Error("Choose an existing destination.");
  if (parentId && [parentId, ...ancestorIds(parents, parentId)].some(id => selected.has(id))) throw Error("A folder cannot contain itself.");
  const movingIds = new Set(moving.map(entry => entry.id));
  const names = new Set(entries.filter(entry => !movingIds.has(entry.id) && (entry.parentId ?? null) === parentId).map(entry => entry.name.toLowerCase()));
  for (const entry of moving) {
    const name = entry.name.toLowerCase();
    if (names.has(name)) throw Error(`“${entry.name}” already exists in the destination.`);
    names.add(name);
  }
  return entries.map(entry => movingIds.has(entry.id) ? { ...entry, parentId } : entry);
}
