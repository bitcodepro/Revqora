import { useLayoutEffect, useState } from "react";
import { namePathMenu } from "./NamePathMenu";
import { ChevronDown, ChevronRight, FolderPlus, Library, Star } from "lucide-react";
import { basename } from "../lib/format";
import { errorMessage } from "../lib/api";
import { defaultGroupRoots, groupRepositoryRoots, useLibrary, repositoryKey, uniqueRoots, type RepositoryGroup } from "../lib/repositoryLibrary";
import { treeSubtreeIds, visibleTree } from "../lib/libraryTree";
import { matchesShortcut } from "../lib/shortcuts";
import { useRepos } from "../lib/store";
import { contextMenu, showDialog, toast, useUi, type MenuItem } from "../lib/ui";
import { confirmDialog, promptDialog } from "./dialogs";
import { repositoryMembershipMenu } from "./LibraryMenus";
import { Modal } from "./Modal";

export async function openLibraryRepository(root: string) {
  try { await useRepos.getState().open(root); } catch (e) { toast.error("Could not open repository", errorMessage(e)); }
}
export function FavoriteButton({ root }: { root: string }) {
  const favorite = useLibrary((s) => s.favorites.some((r) => repositoryKey(r) === repositoryKey(root)));
  return <button type="button" className={`icon-btn sm repository-star ${favorite ? "active" : ""}`} aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${basename(root)}`} aria-pressed={favorite} onClick={() => useLibrary.getState().favorite(root)}><Star size={13} fill={favorite ? "currentColor" : "none"} /></button>;
}
async function named(title: string, initial: string, action: (name: string) => void) {
  const name = await promptDialog({ title, initial, label: "Name", validate: (v) => v.trim().length > 80 ? "Use at most 80 characters." : null });
  if (name !== null) try { action(name); } catch (e) { toast.error(title, errorMessage(e)); }
}
interface GroupDraft { roots?: string[]; children?: string[]; parentId?: string | null; onCreated?: () => void }

function GroupEditor({ draft, close }: { draft: GroupDraft; close: () => void }) {
  const order = useRepos((s) => s.order);
  const tabs = useRepos(s => s.tabs);
  const known = useLibrary(s => s.knownRoots);
  const groups = useLibrary(s => s.groups);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [selected, setSelected] = useState(() => new Set((draft.roots ?? []).map(repositoryKey)));
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const reconcile = (state: ReturnType<typeof useRepos.getState>) => {
      const aliases = new Map(state.order.flatMap((root) =>
        (state.tabs[root]?.openAliases ?? []).map((alias) => [repositoryKey(alias), repositoryKey(root)] as const)));
      if (!aliases.size) return;
      // Update the draft at relink time. Closing a tab discards its aliases,
      // but the selected repository must stay selected in the library.
      setSelected((current) => [...current].some((key) => aliases.has(key))
        ? new Set([...current].map((key) => aliases.get(key) ?? key))
        : current);
    };
    const unsubscribe = useRepos.subscribe((state, previous) => {
      if (state.order !== previous.order) reconcile(state);
    });
    reconcile(useRepos.getState());
    return unsubscribe;
  }, []);
  const roots = uniqueRoots([...(draft.roots ?? []), ...order, ...known]);
  const paths = roots.filter(root => selected.has(repositoryKey(root)));
  const inScope = group ? new Set((group === "default" ? defaultGroupRoots(roots, groups) : groupRepositoryRoots(groups, group)).map(repositoryKey)) : null;
  const search = query.trim().toLowerCase();
  const shown = roots.filter(root => root.toLowerCase().includes(search) && (!inScope || inScope.has(repositoryKey(root))));
  const allShownSelected = shown.every(root => selected.has(repositoryKey(root)));
  const canSave = !!name.trim() && !paths.some(root => tabs[root]?.opening);
  const setIncluded = (rows: string[], checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const root of rows) {
      if (checked) next.add(repositoryKey(root));
      else next.delete(repositoryKey(root));
    }
    return next;
  });
  const submit = () => {
    if (!canSave || paths.some(root => useRepos.getState().tabs[root]?.opening)) return;
    try {
      const library = useLibrary.getState();
      const id = library.createGroup(name, paths, draft.children ?? [], draft.parentId);
      library.selectGroup(id);
      draft.onCreated?.();
      close();
    } catch (e) { setError(errorMessage(e)); }
  };
  return <Modal title="New group" wide
    subtitle="Choose repositories to move into this group."
    onClose={close} onSubmit={submit}
    footer={<><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary" disabled={!canSave}>Create group</button></>}>
    <label className="field">Group name<input className="input" maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
    {!!draft.children?.length && <div className="batch-note">{draft.children.length} groups will move into the new group.</div>}
    <div className="workspace-editor-filters">
      <input className="input" aria-label="Find repository" placeholder="Find by name or path…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {groups.length > 0 && <select className="input" aria-label="Filter repositories by group" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">All repositories</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="default">Default group</option></select>}
    </div>
    <div className="workspace-editor-selection">
      <span className="batch-note">{paths.length} selected</span>
      <button type="button" className="btn sm" disabled={!shown.length} onClick={() => setIncluded(shown, !allShownSelected)}>{shown.length > 0 && allShownSelected ? "Clear shown" : "Select shown"}</button>
    </div>
    <div className="library-list workspace-editor-list">
      {shown.map((root) => <label className="library-row" key={repositoryKey(root)}>
        <input type="checkbox" checked={selected.has(repositoryKey(root))} onChange={(e) => setIncluded([root], e.target.checked)} />
        <span className="grow-text"><b>{basename(root)}</b><span className="batch-note library-path" title={root}>{root}</span></span>
      </label>)}
      {!shown.length && <div className="cg-empty">{roots.length ? "No matching repositories." : "Open a repository to add it to the library."}</div>}
    </div>
    {error && <div className="callout warn workspace-editor-error" role="alert">{error}</div>}
  </Modal>;
}

export function groupEditorDialog(groupDraft: GroupDraft = {}) {
  return showDialog<void>(close => <GroupEditor draft={groupDraft} close={close}/>);
}

export function groupCreationMenu(group?: RepositoryGroup): MenuItem[] {
  return [
    { label: "Create group", shortcut: "group-create", icon: <FolderPlus size={14}/>, onClick: () => void groupEditorDialog({parentId: group?.parentId}) },
    ...(group ? [{ label: "Create subgroup", shortcut: "group-sub", icon: <FolderPlus size={14}/>, onClick: () => void groupEditorDialog({parentId: group.id}) }] : []),
  ];
}

export function renameGroupDialog(group: RepositoryGroup) {
  return named("Rename group", group.name, name => { useLibrary.getState().group(name, group.id); });
}

export async function deleteGroupsDialog(ids: string[]) {
  const library = useLibrary.getState();
  const selected = treeSubtreeIds(library.groups, ids);
  const affected = library.groups.filter(group => selected.has(group.id));
  if (!affected.length) return null;
  const title = affected.length === 1 ? "Delete group" : `Delete ${affected.length} groups`;
  if (!await confirmDialog({
    title: title + "?",
    confirm: title,
    message: "Selected groups and their subgroups will be removed. Their repositories stay in the library.",
    details: affected.map(group => group.name),
    danger: true,
  })) return null;
  const current = useLibrary.getState();
  const removed = treeSubtreeIds(current.groups, ids);
  current.removeGroups(ids);
  return removed;
}

function renameLibraryRow(event: React.KeyboardEvent, rename: () => unknown) {
  if (event.repeat || (event.target as HTMLElement).closest("input, textarea, select") || !matchesShortcut(event, "renameItem")) return;
  event.preventDefault();
  event.stopPropagation();
  void rename();
}

export async function renameRepositoryDialog(root: string) {
  const library = useLibrary.getState();
  const original = useRepos.getState().tabs[root]?.info?.name ?? basename(root);
  const initial = library.repositoryNames[repositoryKey(root)] ?? original;
  const name = await promptDialog({ title: "Rename repository", initial, label: "Display name", help: `This changes the label in Revqora. Enter ${original} to restore the original name.`, validate: v => v.trim().length > 80 ? "Use at most 80 characters." : null });
  if (name !== null) useLibrary.getState().renameRepository(root, name.trim() === original ? "" : name);
}

export function repositoryLibraryDialog() { return showDialog<void>((close) => <RepositoryLibrary close={close} />); }
export function RepositoryLibraryButton() { return <button type="button" className="icon-btn" title="Repository library" data-shortcut="repository-library" aria-label="Repository library" onClick={() => void repositoryLibraryDialog()}><Library size={16} /></button>; }
function RepositoryLibrary({ close }: { close: () => void }) {
  const lib = useLibrary(), tabs = useRepos((s) => s.tabs), order = useRepos((s) => s.order);
  const busy = useUi((s) => s.busy.length > 0);
  const [section, setSection] = useState("repositories"), [query, setQuery] = useState("");
  const displayName = (root: string) => lib.repositoryNames[repositoryKey(root)] ?? basename(root);
  const roots = [...new Set([...order, ...lib.knownRoots])].filter((r) => (r + " " + displayName(r)).toLowerCase().includes(query.toLowerCase()));
  const groupRows = visibleTree(lib.groups, () => true, () => false, false);
  return <Modal title="Repository library" wide subtitle="Favorites and project groups" onClose={close} footer={<button type="button" className="btn primary" onClick={close}>Done</button>}>
    <div className="seg library-tabs">{["repositories", "groups"].map((s) => <button type="button" key={s} className={section === s ? "on" : ""} onClick={() => setSection(s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}</div>
    {section === "repositories" && <><input className="input" aria-label="Find saved repository" placeholder="Find by name or path…" value={query} onChange={(e) => setQuery(e.target.value)} /><div className="library-list">{roots.map((root) => {
      const memberships = lib.groups.filter(g => g.roots.some(r => repositoryKey(r) === repositoryKey(root)));
      return <div className="library-row" key={root} tabIndex={0} onKeyDown={e => renameLibraryRow(e, () => renameRepositoryDialog(root))} onContextMenu={e => contextMenu(e, [...repositoryMembershipMenu([root], memberships.length === 1 ? memberships[0].id : undefined), ...namePathMenu(displayName(root), root, null)])}>
      <FavoriteButton root={root} /><div className="grow-text"><b>{displayName(root)}</b><div className="batch-note library-path" title={root}>{root}</div></div>
      <select className="input sm library-group-select" aria-label={`Group for ${basename(root)}`} title="Move to a single group" value={memberships.length > 1 ? "__multiple" : memberships[0]?.id ?? ""} onChange={(e) => lib.move(root, e.target.value || null)}><option value="">Default group</option>{memberships.length > 1 && <option value="__multiple" disabled>Multiple groups</option>}{groupRows.map(({entry: g, depth}) => <option key={g.id} value={g.id}>{"　".repeat(depth)}{g.name}</option>)}</select>
      <button type="button" className="btn sm" disabled={busy} onClick={() => { void openLibraryRepository(root); close(); }}>{tabs[root] ? "Activate" : "Open"}</button>
    </div>;
    })}</div>{!roots.length && <div className="cg-empty">Open a repository to add it to your library.</div>}</>}
    {section === "groups" && <><div className="library-list library-tree-menu" aria-label="Saved groups" onContextMenu={e => contextMenu(e, groupCreationMenu())}>{groupRows.map(({entry: g, depth}) => <div className="library-row" key={g.id} style={{ paddingInlineStart: 8 + Math.min(depth, 8) * 12 }} onContextMenu={e => contextMenu(e, groupCreationMenu(g))}>
      <button type="button" className="icon-btn sm" title={g.collapsed ? "Expand group in navigation" : "Collapse group in navigation"} aria-expanded={!g.collapsed} onClick={() => lib.collapse(g.id)}>{g.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button><div className="grow-text"><b>{g.name}</b><div className="batch-note">{groupRepositoryRoots(lib.groups, g.id).length} repositories</div></div>
      <button type="button" className="btn sm" disabled={busy || !groupRepositoryRoots(lib.groups, g.id).length} onClick={async () => { const roots = groupRepositoryRoots(lib.groups, g.id); const results = await useRepos.getState().openMany(roots, roots[0]); for (const result of results) if (result.status === "rejected") toast.error(result.reason, "Could not open repository"); }}>Open group</button>
      <button type="button" className="btn sm" onClick={() => void renameGroupDialog(g)}>Rename</button>
      <button type="button" className="btn sm" onClick={() => void deleteGroupsDialog([g.id])}>Delete</button>
    </div>)}</div><div className="batch-note">Move repositories and groups in Explorer.</div></>}
  </Modal>;
}
