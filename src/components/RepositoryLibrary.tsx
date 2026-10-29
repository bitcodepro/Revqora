import { useState } from "react";
import { ChevronDown, ChevronRight, Library, Star } from "lucide-react";
import { basename } from "../lib/format";
import { errorMessage } from "../lib/api";
import { useLibrary, repositoryKey } from "../lib/repositoryLibrary";
import { useRepos } from "../lib/store";
import { switchWorkspace, workspaceSnapshot } from "../lib/repositoryWorkspaces";
import { retainedConflictDrafts } from "../lib/conflictStudio";
import { showDialog, toast, useUi } from "../lib/ui";
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
export async function openWorkspace(id: string, add = false) {
  if (!add) {
    const target = useLibrary.getState().workspaces.find((w) => w.id === id);
    if (!target) return;
    const drafts = useRepos.getState().order.filter((r) => !target.roots.some((p) => repositoryKey(p) === repositoryKey(r))).flatMap((r) => retainedConflictDrafts(r).map((d) => `${basename(r)} / ${d.path}`));
    if (drafts.length && !await confirmDialog({ title: "Keep conflict drafts and switch?", message: "These unsaved drafts stay in this app session. Reopen their repositories to continue editing. Save them before quitting the app.", details: drafts, confirm: "Keep drafts and switch" })) return;
  }
  try {
    const errors = await switchWorkspace(id, add);
    if (errors.length) await showDialog<void>((close) => <Modal title="Workspace needs attention" subtitle="Successfully opened repositories remain available. The saved workspace was preserved." onClose={close} footer={<button type="button" className="btn primary" onClick={() => close()}>Close</button>}><div className="code-list">{errors.join("\n")}</div></Modal>);
  } catch (e) { toast.error("Could not switch workspace", errorMessage(e)); }
}
export function WorkspacePicker() {
  const workspaces = useLibrary((s) => s.workspaces), active = useLibrary((s) => s.activeWorkspaceId);
  const busy = useUi((s) => s.busy.length > 0);
  if (!workspaces.length) return null;
  return <select className="input sm workspace-picker" aria-label="Workspace" disabled={busy} value={active ?? ""} onChange={(e) => e.target.value ? void openWorkspace(e.target.value) : useLibrary.getState().select(null)}><option value="">Unsaved session</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>;
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
    {section === "repositories" && <><input className="input" aria-label="Find saved repository" placeholder="Find by name or path…" value={query} onChange={(e) => setQuery(e.target.value)} /><div className="library-list">{roots.map((root) => <div className="library-row" key={root}>
      <FavoriteButton root={root} /><div className="grow-text"><b>{basename(root)}</b><div className="batch-note library-path" title={root}>{root}</div></div>
      <select className="input sm library-group-select" aria-label={`Group for ${basename(root)}`} value={lib.groups.find((g) => g.roots.some((r) => repositoryKey(r) === repositoryKey(root)))?.id ?? ""} onChange={(e) => lib.move(root, e.target.value || null)}><option value="">Ungrouped</option>{lib.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
      <button type="button" className="btn sm" disabled={busy} onClick={() => { void openLibraryRepository(root); close(); }}>{tabs[root] ? "Activate" : "Open"}</button>
    </div>)}</div>{!roots.length && <div className="cg-empty">Open a repository to add it to your library.</div>}</>}
    {section === "groups" && <><button type="button" className="btn sm" onClick={() => void named("New project group", "", (name) => { lib.group(name); })}>New group</button><div className="library-list">{lib.groups.map((g) => <div className="library-row" key={g.id}>
      <button type="button" className="icon-btn sm" title={g.collapsed ? "Expand group" : "Collapse group"} aria-expanded={!g.collapsed} onClick={() => lib.collapse(g.id)}>{g.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button><div className="grow-text"><b>{g.name}</b><div className="batch-note">{g.roots.length} repositories</div></div>
      <button type="button" className="btn sm" disabled={busy || !g.roots.length} onClick={async () => { for (const root of g.roots) await openLibraryRepository(root); }}>Open group</button>
      <button type="button" className="btn sm" onClick={() => void named("Rename group", g.name, (n) => { lib.group(n, g.id); })}>Rename</button>
      <button type="button" className="btn sm" onClick={async () => { if (await confirmDialog({ title: "Delete group?", message: "Repositories stay in the library and on disk.", confirm: "Delete group" })) lib.removeGroup(g.id); }}>Delete</button>
    </div>)}</div><div className="batch-note">Assign repositories to groups on the Repositories tab.</div></>}
    {section === "workspaces" && <><div className="callout">Each workspace remembers its repository set, active repository, selected views and panel sizes for every mode. Changes are saved automatically. Switching opens folders and restores the layout; Git branches and working files stay as they are.</div>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void named("Save workspace as", "", (name) => { lib.save(name, workspaceSnapshot()); })}>Save current as…</button>
      <div className="library-list">{lib.workspaces.map((w) => <div className="library-row" key={w.id}><div className="grow-text"><b>{w.name}{w.id === lib.activeWorkspaceId ? " · Active" : ""}</b><div className="batch-note">{w.roots.length} repositories · {w.historyMode}</div></div>
        <button type="button" className="btn sm" disabled={busy} onClick={() => { close(); void openWorkspace(w.id); }}>Switch</button><button type="button" className="btn sm" disabled={busy} onClick={() => { close(); void openWorkspace(w.id, true); }}>Add repositories</button>
        <button type="button" className="btn sm" onClick={() => void named("Rename workspace", w.name, (name) => lib.rename(w.id, name))}>Rename</button><button type="button" className="btn sm" onClick={async () => { if (await confirmDialog({ title: "Delete saved workspace?", message: "Open repositories and their files stay as they are.", confirm: "Delete workspace" })) lib.remove(w.id); }}>Delete</button>
      </div>)}</div></>}
  </Modal>;
}
