import { useId, useLayoutEffect, useState } from "react";
import { namePathMenu } from "./NamePathMenu";
import { ArrowRightLeft, ChevronDown, ChevronRight, Library, Star } from "lucide-react";
import { basename } from "../lib/format";
import { errorMessage } from "../lib/api";
import { groupRepositoryRoots, useLibrary, repositoryKey, uniqueRoots, type SavedWorkspace } from "../lib/repositoryLibrary";
import { visibleTree } from "../lib/libraryTree";
import { matchesShortcut } from "../lib/shortcuts";
import { useRepos } from "../lib/store";
import { editWorkspaceRepositories, moveWorkspaceRepositories, openAllWorkspaces, switchWorkspace, workspaceBusy, workspaceSnapshot, workspaceWithRepositories } from "../lib/repositoryWorkspaces";
import { retainedConflictDrafts } from "../lib/conflictStudio";
import { contextMenu, showDialog, toast, useUi } from "../lib/ui";
import { confirmDialog, promptDialog } from "./dialogs";
import { deleteGroupsDialog } from "./GroupsSidebar";
import { isPlainDelete, repositoryMembershipMenu } from "./LibraryMenus";
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
async function confirmWorkspaceDrafts(roots: string[]) {
  const included = new Set(roots.map(repositoryKey));
  const drafts = useRepos.getState().order.filter((root) => !included.has(repositoryKey(root))).flatMap((root) => retainedConflictDrafts(root).map((draft) => `${basename(root)} / ${draft.path}`));
  return !drafts.length || await confirmDialog({ title: "Keep conflict drafts and switch?", message: "These unsaved drafts stay in this app session. Reopen their repositories to continue editing. Save them before quitting the app.", details: drafts, confirm: "Keep drafts and switch" });
}
export async function openWorkspace(id: string, add = false) {
  if (!add) {
    const target = useLibrary.getState().workspaces.find((w) => w.id === id);
    if (!target) return;
    if (!await confirmWorkspaceDrafts(target.roots)) return;
  }
  try {
    const errors = await switchWorkspace(id, add);
    if (errors.length) await showDialog<void>((close) => <Modal title="Workspace needs attention" subtitle="Successfully opened repositories remain available. The saved workspace was preserved." onClose={close} footer={<button type="button" className="btn primary" onClick={() => close()}>Close</button>}><div className="code-list">{errors.join("\n")}</div></Modal>);
  } catch (e) { toast.error("Could not switch workspace", errorMessage(e)); }
}

const discoveringRepositories = (state: ReturnType<typeof useRepos.getState>) => state.order.some((root) => state.tabs[root]?.opening);

function WorkspaceEditor({ workspace, parentId, close }: { workspace?: SavedWorkspace; parentId?: string; close: () => void }) {
  const order = useRepos((s) => s.order);
  const discovering = useRepos(discoveringRepositories);
  const known = useLibrary((s) => s.knownRoots), groups = useLibrary((s) => s.groups);
  const savedRoots = useLibrary((s) => s.workspaces.find((item) => item.id === workspace?.id)?.roots);
  const busy = useUi((s) => s.busy.length > 0);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [openAfter, setOpenAfter] = useState(true);
  const [selected, setSelected] = useState(() => new Set((savedRoots ?? workspace?.roots ?? order).map(repositoryKey)));
  const [submitting, setSubmitting] = useState(false);
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
  const original = new Set((savedRoots ?? []).map(repositoryKey));
  const roots = uniqueRoots([...(savedRoots ?? []), ...order, ...known]);
  const paths = roots.filter((root) => selected.has(repositoryKey(root)));
  const groupByRoot = new Map(groups.flatMap((item) => item.roots.map((root) => [repositoryKey(root), item.id] as const)));
  const search = query.trim().toLowerCase();
  const shown = roots.filter((root) => root.toLowerCase().includes(search) && (!group || (groupByRoot.get(repositoryKey(root)) ?? "ungrouped") === group));
  const allShownSelected = shown.every((root) => selected.has(repositoryKey(root)));
  const changed = paths.length !== original.size || paths.some((root) => !original.has(repositoryKey(root)));
  const canSave = !busy && !submitting && !discovering && (workspace ? changed : !!name.trim());
  const setIncluded = (rows: string[], checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const root of rows) {
      if (checked) next.add(repositoryKey(root));
      else next.delete(repositoryKey(root));
    }
    return next;
  });
  const submit = async () => {
    if (!canSave || discoveringRepositories(useRepos.getState())) return;
    setError(null);
    if (!workspace) {
      try {
        const current = workspaceSnapshot();
        const draft = workspaceWithRepositories(current, paths);
        const alreadyOpen = current.roots.length === draft.roots.length && current.roots.every((root, i) => repositoryKey(root) === repositoryKey(draft.roots[i]));
        const id = useLibrary.getState().save(name, draft, openAfter && alreadyOpen, parentId);
        close();
        if (openAfter && !alreadyOpen) void openWorkspace(id);
      } catch (e) { setError(errorMessage(e)); }
      return;
    }
    setSubmitting(true);
    try {
      if (useLibrary.getState().activeWorkspaceId === workspace.id) {
        if (!await confirmWorkspaceDrafts(paths) || discoveringRepositories(useRepos.getState())) return;
      }
      const errors = await editWorkspaceRepositories(workspace.id, paths);
      if (errors.length) {
        setError(["The saved workspace was preserved. Repositories opened during the attempt remain in an unsaved session.", ...errors].join("\n"));
        return;
      }
      close();
    } catch (e) { setError(errorMessage(e)); }
    finally { setSubmitting(false); }
  };
  return <Modal title={workspace ? `Edit repositories · ${workspace.name}` : "New workspace"} wide
    subtitle="Check the repositories to include. Unchecked repositories stay in the library and on disk."
    onClose={() => { if (!submitting) close(); }} onSubmit={() => void submit()}
    footer={<><button type="button" className="btn" disabled={submitting} onClick={close}>Cancel</button><button type="submit" className="btn primary" disabled={!canSave}>{submitting ? "Saving…" : workspace ? "Save changes" : "Create workspace"}</button></>}>
    {!workspace && <label className="field">Workspace name<input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>}
    <div className="workspace-editor-filters">
      <input className="input" aria-label="Find repository" placeholder="Find by name or path…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {groups.length > 0 && <select className="input" aria-label="Filter repositories by group" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">All groups</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="ungrouped">Ungrouped</option></select>}
    </div>
    <div className="workspace-editor-selection">
      <span className="batch-note">{paths.length} selected</span>
      <button type="button" className="btn sm" disabled={submitting || !shown.length} onClick={() => setIncluded(shown, !allShownSelected)}>{shown.length > 0 && allShownSelected ? "Clear shown" : "Select shown"}</button>
    </div>
    <div className="library-list workspace-editor-list">
      {shown.map((root) => <label className="library-row" key={repositoryKey(root)}>
        <input type="checkbox" checked={selected.has(repositoryKey(root))} disabled={submitting} onChange={(e) => setIncluded([root], e.target.checked)} />
        <span className="grow-text"><b>{basename(root)}</b><span className="batch-note library-path" title={root}>{root}</span></span>
      </label>)}
      {!shown.length && <div className="cg-empty">{roots.length ? "No matching repositories." : "Open a repository to add it to the library."}</div>}
    </div>
    {!workspace && <label className="check-row"><input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} />Open after creating</label>}
    {discovering && <div className="batch-note" role="status">Opening repositories… You can save when they are ready.</div>}
    {error && <div className="callout warn workspace-editor-error" role="alert">{error}</div>}
  </Modal>;
}

export function workspaceEditorDialog(workspace?: SavedWorkspace, parentId?: string) {
  return showDialog<void>((close) => <WorkspaceEditor workspace={workspace} parentId={parentId} close={close} />);
}

export function renameWorkspaceDialog(workspace: SavedWorkspace) {
  return named("Rename workspace", workspace.name, name => useLibrary.getState().rename(workspace.id, name));
}

export async function deleteWorkspaceDialog(workspace: SavedWorkspace) {
  if (workspaceBusy()) return;
  const hasChildren = useLibrary.getState().workspaces.some(item => item.parentId === workspace.id);
  if (await confirmDialog({ title: "Delete saved workspace?", message: workspace.name + " will be removed from Workspaces. Repositories and their files stay available." + (hasChildren ? " Its sub-workspaces move to the top level." : ""), confirm: "Delete workspace", danger: true })) {
    if (workspaceBusy()) {
      toast.warning("Wait for the current operation before deleting the workspace.");
      return;
    }
    const library = useLibrary.getState();
    const active = library.activeWorkspaceId === workspace.id;
    library.remove(workspace.id);
    if (active) openAllWorkspaces();
  }
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

function WorkspaceMove({ fromId, close }: { fromId: string; close: () => void }) {
  const workspaces = useLibrary((s) => s.workspaces);
  const discovering = useRepos(discoveringRepositories);
  const destinationId = useId();
  const source = workspaces.find((workspace) => workspace.id === fromId);
  const [destination, setDestination] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");
  const roots = source?.roots ?? [];
  const paths = roots.filter((root) => selected.has(repositoryKey(root)));
  const shown = roots.filter((root) => root.toLowerCase().includes(query.trim().toLowerCase()));
  const allShownSelected = shown.every((root) => selected.has(repositoryKey(root)));
  const canMove = !moving && !discovering && paths.length > 0 && workspaces.some((workspace) => workspace.id === destination);

  function select(rows: string[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const root of rows) {
        const key = repositoryKey(root);
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  async function submit() {
    if (!canMove) return;
    setMoving(true);
    setError("");
    try {
      if (useLibrary.getState().activeWorkspaceId === fromId) {
        const remaining = roots.filter((root) => !selected.has(repositoryKey(root)));
        if (!await confirmWorkspaceDrafts(remaining)) return;
      }
      if (discoveringRepositories(useRepos.getState())) throw new Error("Wait for the repositories to finish opening.");
      const errors = await moveWorkspaceRepositories(fromId, destination, paths);
      if (errors.length) {
        setError(errors.join("\n"));
        return;
      }
      close();
      toast.success(paths.length === 1 ? "Repository moved" : `${paths.length} repositories moved`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setMoving(false); }
  }

  return <Modal title={`Move repositories · ${source?.name ?? "Workspace"}`} icon={<ArrowRightLeft size={20} />} wide
    subtitle="Move the selected repositories to another workspace. Working folders stay on disk."
    onClose={() => { if (!moving) close(); }} onSubmit={() => void submit()}
    footer={<><button type="button" className="btn" disabled={moving} onClick={close}>Cancel</button>
      <button type="submit" className="btn primary" disabled={!canMove}>{moving ? "Moving…" : `Move ${paths.length} ${paths.length === 1 ? "repository" : "repositories"}`}</button></>}>
    <div className="field">
      <label htmlFor={destinationId}>Destination workspace</label>
      <select id={destinationId} className="input" value={destination} disabled={moving} onChange={(event) => setDestination(event.target.value)}>
        <option value="">Choose a workspace…</option>
        {workspaces.filter((workspace) => workspace.id !== fromId).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>
    </div>
    <div className="workspace-editor-filters"><input className="input" aria-label="Find repository to move" placeholder="Find by name or path…" value={query} disabled={moving} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="workspace-editor-selection">
      <span className="batch-note">{paths.length} of {roots.length} selected</span>
      <button type="button" className="btn sm" disabled={moving || !shown.length} onClick={() => select(shown, !allShownSelected)}>
        {shown.length && allShownSelected ? "Clear selection" : query.trim() ? "Select shown" : "Select all"}
      </button>
    </div>
    <div className="library-list workspace-editor-list">
      {shown.map((root) => <label className="library-row" key={repositoryKey(root)}>
        <input type="checkbox" checked={selected.has(repositoryKey(root))} disabled={moving} onChange={(event) => select([root], event.target.checked)} />
        <div className="grow-text"><b>{basename(root)}</b><div className="batch-note library-path" title={root}>{root}</div></div>
      </label>)}
      {!shown.length && <div className="cg-empty">No matching repositories</div>}
    </div>
    {error && <div className="callout warn workspace-editor-error" role="alert">{error}</div>}
  </Modal>;
}

export function WorkspacePicker() {
  const workspaces = useLibrary((s) => s.workspaces), active = useLibrary((s) => s.activeWorkspaceId);
  const busy = useUi((s) => s.busy.length > 0);
  if (!workspaces.length) return null;
  return <select className="input sm workspace-picker" aria-label="Workspace" disabled={busy} value={active ?? ""} onChange={(e) => e.target.value ? void openWorkspace(e.target.value) : openAllWorkspaces()}><option value="">All Workspaces</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>;
}
export function repositoryLibraryDialog() { return showDialog<void>((close) => <RepositoryLibrary close={close} />); }
export function RepositoryLibraryButton() { return <button type="button" className="icon-btn" title="Repository library and workspaces" aria-label="Repository library and workspaces" onClick={() => void repositoryLibraryDialog()}><Library size={16} /></button>; }
function RepositoryLibrary({ close }: { close: () => void }) {
  const lib = useLibrary(), tabs = useRepos((s) => s.tabs), order = useRepos((s) => s.order);
  const busy = useUi((s) => s.busy.length > 0);
  const [section, setSection] = useState("repositories"), [query, setQuery] = useState("");
  const displayName = (root: string) => lib.repositoryNames[repositoryKey(root)] ?? basename(root);
  const roots = [...new Set([...order, ...lib.knownRoots])].filter((r) => (r + " " + displayName(r)).toLowerCase().includes(query.toLowerCase()));
  const activeWorkspace = lib.workspaces.find(w => w.id === lib.activeWorkspaceId);
  const workspaceRows = visibleTree(lib.workspaces, () => true, () => false, false);
  const groupRows = visibleTree(lib.groups, () => true, () => false, false);
  return <Modal title="Repository library" wide subtitle="Favorites, project groups and saved workspaces" onClose={close} footer={<button type="button" className="btn primary" onClick={close}>Done</button>}>
    <div className="seg library-tabs">{["repositories", "groups", "workspaces"].map((s) => <button type="button" key={s} className={section === s ? "on" : ""} onClick={() => setSection(s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}</div>
    {section === "repositories" && <><input className="input" aria-label="Find saved repository" placeholder="Find by name or path…" value={query} onChange={(e) => setQuery(e.target.value)} /><div className="library-list">{roots.map((root) => {
      const memberships = lib.groups.filter(g => g.roots.some(r => repositoryKey(r) === repositoryKey(root)));
      return <div className="library-row" key={root} tabIndex={0} onKeyDown={e => renameLibraryRow(e, () => renameRepositoryDialog(root))} onContextMenu={e => contextMenu(e, [...repositoryMembershipMenu([root], memberships.length === 1 ? memberships[0].id : undefined), ...namePathMenu(displayName(root), root, null)])}>
      <FavoriteButton root={root} /><div className="grow-text"><b>{displayName(root)}</b><div className="batch-note library-path" title={root}>{root}</div></div>
      <select className="input sm library-group-select" aria-label={`Group for ${basename(root)}`} title="Move to a single group" value={memberships.length > 1 ? "__multiple" : memberships[0]?.id ?? ""} onChange={(e) => lib.move(root, e.target.value || null)}><option value="">Ungrouped</option>{memberships.length > 1 && <option value="__multiple" disabled>Multiple groups</option>}{groupRows.map(({entry: g, depth}) => <option key={g.id} value={g.id}>{"　".repeat(depth)}{g.name}</option>)}</select>
      <button type="button" className="btn sm" disabled={busy} onClick={() => { void openLibraryRepository(root); close(); }}>{tabs[root] ? "Activate" : "Open"}</button>
    </div>;
    })}</div>{!roots.length && <div className="cg-empty">Open a repository to add it to your library.</div>}</>}
    {section === "groups" && <><button type="button" className="btn sm" onClick={() => void named("New project group", "", (name) => { lib.group(name); })}>New group</button><div className="library-list">{groupRows.map(({entry: g, depth}) => <div className="library-row" key={g.id} style={{ paddingInlineStart: 8 + Math.min(depth, 8) * 12 }}>
      <button type="button" className="icon-btn sm" title={g.collapsed ? "Expand group in navigation" : "Collapse group in navigation"} aria-expanded={!g.collapsed} onClick={() => lib.collapse(g.id)}>{g.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button><div className="grow-text"><b>{g.name}</b><div className="batch-note">{groupRepositoryRoots(lib.groups, g.id).length} repositories</div></div>
      <button type="button" className="btn sm" disabled={busy || !groupRepositoryRoots(lib.groups, g.id).length} onClick={async () => { const roots = groupRepositoryRoots(lib.groups, g.id); const results = await useRepos.getState().openMany(roots, roots[0]); for (const result of results) if (result.status === "rejected") toast.error(result.reason, "Could not open repository"); }}>Open group</button>
      <button type="button" className="btn sm" onClick={() => void named("Rename group", g.name, (n) => { lib.group(n, g.id); })}>Rename</button>
      {activeWorkspace?.excludedGroupIds?.includes(g.id) && <button type="button" className="btn sm" onClick={() => lib.setWorkspaceGroupsExcluded(activeWorkspace.id, [g.id], false)}>Restore to workspace</button>}
      <button type="button" className="btn sm" onClick={() => void deleteGroupsDialog([g.id])}>Delete</button>
    </div>)}</div><div className="batch-note">Assign repositories to groups on the Repositories tab.</div></>}
    {section === "workspaces" && <><div className="callout">Each workspace remembers its repository set, active repository, selected views and panel sizes for every mode. Changes are saved automatically. Switching opens folders and restores the layout; Git branches and working files stay as they are.</div>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void workspaceEditorDialog()}>New workspace…</button>
      <div className="library-list">{workspaceRows.map(({entry: w, depth}) => <div className="library-row" key={w.id} tabIndex={0} style={{ paddingInlineStart: 8 + Math.min(depth, 8) * 12 }} onKeyDown={e => {
        if (isPlainDelete(e)) {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) void deleteWorkspaceDialog(w);
        } else renameLibraryRow(e, () => renameWorkspaceDialog(w));
      }}><div className="grow-text"><b>{w.name}{w.id === lib.activeWorkspaceId ? " · Active" : ""}</b><div className="batch-note">{w.roots.length} {w.roots.length === 1 ? "repository" : "repositories"} · {w.historyMode}</div></div>
        <button type="button" className="btn sm" disabled={busy} onClick={() => { close(); void openWorkspace(w.id); }}>Switch</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void workspaceEditorDialog(w)}>Edit repositories…</button>
        <button type="button" className="btn sm" title="Move repositories to another workspace" disabled={busy || !w.roots.length || lib.workspaces.length < 2}
          onClick={() => void showDialog<void>((done) => <WorkspaceMove fromId={w.id} close={done} />)}>Move repositories…</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => { close(); void openWorkspace(w.id, true); }} title="Open all repositories from this workspace in the current session">Add to session</button>
        <button type="button" className="btn sm" onClick={() => void renameWorkspaceDialog(w)}>Rename</button><button type="button" className="btn sm" disabled={busy} onClick={() => void deleteWorkspaceDialog(w)}>Delete</button>
      </div>)}</div></>}
  </Modal>;
}
