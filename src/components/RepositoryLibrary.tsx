import { useState } from "react";
import { namePathMenu } from "./NamePathMenu";
import { ChevronDown, ChevronRight, Library, Star } from "lucide-react";
import { basename } from "../lib/format";
import { errorMessage } from "../lib/api";
import { useLibrary, repositoryKey, uniqueRoots, type SavedWorkspace } from "../lib/repositoryLibrary";
import { useRepos } from "../lib/store";
import { editWorkspaceRepositories, openAllWorkspaces, switchWorkspace, workspaceSnapshot, workspaceWithRepositories } from "../lib/repositoryWorkspaces";
import { retainedConflictDrafts } from "../lib/conflictStudio";
import { contextMenu, showDialog, toast, useUi } from "../lib/ui";
import { confirmDialog, promptDialog } from "./dialogs";
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

function WorkspaceEditor({ workspace, close }: { workspace?: SavedWorkspace; close: () => void }) {
  const order = useRepos((s) => s.order);
  const known = useLibrary((s) => s.knownRoots), groups = useLibrary((s) => s.groups);
  const busy = useUi((s) => s.busy.length > 0);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [openAfter, setOpenAfter] = useState(true);
  const [selected, setSelected] = useState(() => new Set((workspace?.roots ?? order).map(repositoryKey)));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roots = uniqueRoots([...(workspace?.roots ?? []), ...order, ...known]);
  const groupByRoot = new Map(groups.flatMap((item) => item.roots.map((root) => [repositoryKey(root), item.id] as const)));
  const search = query.trim().toLowerCase();
  const shown = roots.filter((root) => root.toLowerCase().includes(search) && (!group || (groupByRoot.get(repositoryKey(root)) ?? "ungrouped") === group));
  const allShownSelected = shown.every((root) => selected.has(repositoryKey(root)));
  const changed = workspace && (selected.size !== workspace.roots.length || workspace.roots.some((root) => !selected.has(repositoryKey(root))));
  const canSave = !busy && !submitting && (workspace ? changed : !!name.trim());
  const setIncluded = (paths: string[], included: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const root of paths) {
      if (included) next.add(repositoryKey(root));
      else next.delete(repositoryKey(root));
    }
    return next;
  });
  const submit = async () => {
    if (!canSave) return;
    const paths = roots.filter((root) => selected.has(repositoryKey(root)));
    setError(null);
    if (!workspace) {
      try {
        const current = workspaceSnapshot();
        const draft = workspaceWithRepositories(current, paths);
        const alreadyOpen = current.roots.length === draft.roots.length && current.roots.every((root, i) => repositoryKey(root) === repositoryKey(draft.roots[i]));
        const id = useLibrary.getState().save(name, draft, openAfter && alreadyOpen);
        close();
        if (openAfter && !alreadyOpen) void openWorkspace(id);
      } catch (e) { setError(errorMessage(e)); }
      return;
    }
    setSubmitting(true);
    try {
      if (useLibrary.getState().activeWorkspaceId === workspace.id && !await confirmWorkspaceDrafts(paths)) return;
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
      <span className="batch-note">{selected.size} selected</span>
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
    {error && <div className="callout warn workspace-editor-error" role="alert">{error}</div>}
  </Modal>;
}

function workspaceEditorDialog(workspace?: SavedWorkspace) {
  return showDialog<void>((close) => <WorkspaceEditor workspace={workspace} close={close} />);
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
  const roots = [...new Set([...order, ...lib.knownRoots])].filter((r) => r.toLowerCase().includes(query.toLowerCase()));
  return <Modal title="Repository library" wide subtitle="Favorites, project groups and saved workspaces" onClose={close} footer={<button type="button" className="btn primary" onClick={close}>Done</button>}>
    <div className="seg library-tabs">{["repositories", "groups", "workspaces"].map((s) => <button type="button" key={s} className={section === s ? "on" : ""} onClick={() => setSection(s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}</div>
    {section === "repositories" && <><input className="input" aria-label="Find saved repository" placeholder="Find by name or path…" value={query} onChange={(e) => setQuery(e.target.value)} /><div className="library-list">{roots.map((root) => <div className="library-row" key={root} onContextMenu={e => contextMenu(e, namePathMenu(basename(root), root, null))}>
      <FavoriteButton root={root} /><div className="grow-text"><b>{basename(root)}</b><div className="batch-note library-path" title={root}>{root}</div></div>
      <select className="input sm library-group-select" aria-label={`Group for ${basename(root)}`} value={lib.groups.find((g) => g.roots.some((r) => repositoryKey(r) === repositoryKey(root)))?.id ?? ""} onChange={(e) => lib.move(root, e.target.value || null)}><option value="">Ungrouped</option>{lib.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
      <button type="button" className="btn sm" disabled={busy} onClick={() => { void openLibraryRepository(root); close(); }}>{tabs[root] ? "Activate" : "Open"}</button>
    </div>)}</div>{!roots.length && <div className="cg-empty">Open a repository to add it to your library.</div>}</>}
    {section === "groups" && <><button type="button" className="btn sm" onClick={() => void named("New project group", "", (name) => { lib.group(name); })}>New group</button><div className="library-list">{lib.groups.map((g) => <div className="library-row" key={g.id}>
      <button type="button" className="icon-btn sm" title={g.collapsed ? "Expand group" : "Collapse group"} aria-expanded={!g.collapsed} onClick={() => lib.collapse(g.id)}>{g.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button><div className="grow-text"><b>{g.name}</b><div className="batch-note">{g.roots.length} repositories</div></div>
      <button type="button" className="btn sm" disabled={busy || !g.roots.length} onClick={async () => { const results = await useRepos.getState().openMany(g.roots, g.roots[0]); for (const result of results) if (result.status === "rejected") toast.error(result.reason, "Could not open repository"); }}>Open group</button>
      <button type="button" className="btn sm" onClick={() => void named("Rename group", g.name, (n) => { lib.group(n, g.id); })}>Rename</button>
      <button type="button" className="btn sm" onClick={async () => { if (await confirmDialog({ title: "Delete group?", message: "Repositories stay in the library and on disk.", confirm: "Delete group" })) lib.removeGroup(g.id); }}>Delete</button>
    </div>)}</div><div className="batch-note">Assign repositories to groups on the Repositories tab.</div></>}
    {section === "workspaces" && <><div className="callout">Each workspace remembers its repository set, active repository, selected views and panel sizes for every mode. Changes are saved automatically. Switching opens folders and restores the layout; Git branches and working files stay as they are.</div>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void workspaceEditorDialog()}>New workspace…</button>
      <div className="library-list">{lib.workspaces.map((w) => <div className="library-row" key={w.id}><div className="grow-text"><b>{w.name}{w.id === lib.activeWorkspaceId ? " · Active" : ""}</b><div className="batch-note">{w.roots.length} repositories · {w.historyMode}</div></div>
        <button type="button" className="btn sm" disabled={busy} onClick={() => { close(); void openWorkspace(w.id); }}>Switch</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void workspaceEditorDialog(w)}>Edit repositories…</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => { close(); void openWorkspace(w.id, true); }} title="Open all repositories from this workspace in the current session">Add to session</button>
        <button type="button" className="btn sm" onClick={() => void named("Rename workspace", w.name, (name) => lib.rename(w.id, name))}>Rename</button><button type="button" className="btn sm" onClick={async () => { if (await confirmDialog({ title: "Delete saved workspace?", message: "Open repositories and their files stay as they are.", confirm: "Delete workspace" })) lib.remove(w.id); }}>Delete</button>
      </div>)}</div></>}
  </Modal>;
}
