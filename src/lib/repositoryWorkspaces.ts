import { api, errorMessage, newOpId } from "./api";
import { useRepos } from "./store";
import { useSettings } from "./settings";
import { planFolderWorkspaces, repositoryKey, uniqueRoots, useLibrary, type FolderWorkspace, type SavedWorkspace, type WorkspaceSnapshot } from "./repositoryLibrary";
import { endBusy, startBusy, useUi } from "./ui";
import { validationRunning } from "./validation";

let ready = false;
let switching = false;
export function workspaceSnapshot(): WorkspaceSnapshot {
  const r = useRepos.getState(), s = useSettings.getState();
  return structuredClone({ roots: r.order, activeRoot: r.active, views: Object.fromEntries(r.order.map((root) => [root, r.tabs[root].view])), layouts: s.layouts, historyMode: s.historyMode });
}
export function workspaceWithRepositories(snapshot: WorkspaceSnapshot, paths: string[]): WorkspaceSnapshot {
  const roots = uniqueRoots(paths);
  const views = new Map(Object.entries(snapshot.views).map(([root, view]) => [repositoryKey(root), view]));
  return {
    roots,
    activeRoot: roots.find((root) => snapshot.activeRoot && repositoryKey(root) === repositoryKey(snapshot.activeRoot)) ?? roots[0] ?? null,
    views: Object.fromEntries(roots.flatMap((root) => {
      const view = views.get(repositoryKey(root));
      return view ? [[root, view]] : [];
    })),
    layouts: snapshot.layouts,
    historyMode: snapshot.historyMode,
  };
}
function capture() {
  if (!ready || switching) return;
  const library = useLibrary.getState(), saved = library.workspaces.find((w) => w.id === library.activeWorkspaceId);
  if (!saved) return;
  const snapshot = workspaceSnapshot();
  const { id: _id, name: _name, importedFrom: _importedFrom, ...old } = saved;
  if (JSON.stringify(old) !== JSON.stringify(snapshot)) library.update(saved.id, snapshot);
}
export function finishWorkspaceStartup() {
  const library = useLibrary.getState(), saved = library.workspaces.find((w) => w.id === library.activeWorkspaceId);
  // A missing startup directory must never erase the saved workspace.
  if (saved && saved.roots.some((r) => !useRepos.getState().order.some((p) => repositoryKey(p) === repositoryKey(r)))) library.select(null);
  else if (saved) {
    for (const root of useRepos.getState().order) if (saved.views[root]) useRepos.getState().patch(root, { view: saved.views[root] });
  }
  ready = true;
  capture();
}
export function startWorkspaceTracking() {
  const a = useRepos.subscribe(capture), b = useSettings.subscribe(capture);
  return () => { a(); b(); };
}
export function workspaceBusy(): boolean {
  const r = useRepos.getState();
  return switching || useUi.getState().busy.length > 0 || useUi.getState().repositoryOperations.length > 0 || r.order.some((root) => r.tabs[root].pendingMutations > 0);
}
export function openAllWorkspaces() {
  if (switching) return;
  capture();
  switching = true;
  try {
    registerAllWorkspaceRepositories();
  } finally { switching = false; }
}

function registerAllWorkspaceRepositories(preferred?: string) {
  const library = useLibrary.getState();
  const repos = useRepos.getState();
  const overview = useUi.getState().repositoryOverview;
  const roots = uniqueRoots([...repos.order, ...library.knownRoots]);
  // Publish the full roster while workspace capture is suspended.
  void repos.openMany(roots, repos.active ? undefined : preferred ?? roots[0]);
  library.select(null);
  if (overview && !repos.active && roots.length) useUi.setState({ repositoryOverview: true });
}

export function importFolderRepositories(roots: string[], groups: FolderWorkspace[]) {
  if (switching) throw new Error("Wait for the workspace switch to finish before importing repositories.");
  if (!roots.length) return;
  capture();
  switching = true;
  try {
    const snapshot = workspaceSnapshot();
    const library = useLibrary.getState();
    const workspaces = [...library.workspaces];
    for (const { folder, roots, existing, name } of planFolderWorkspaces(workspaces, groups)) {
      const members = uniqueRoots([...(existing?.roots ?? []), ...roots]);
      const layout = workspaceWithRepositories(existing ?? snapshot, members);
      const imported = { ...layout, id: existing?.id ?? crypto.randomUUID(), name, importedFrom: folder };
      if (existing) workspaces[workspaces.indexOf(existing)] = imported;
      else workspaces.push(imported);
    }
    useLibrary.setState({ knownRoots: uniqueRoots([...library.knownRoots, ...roots]), workspaces });
    registerAllWorkspaceRepositories(roots[0]);
    useUi.setState({ repositoryOverview: true });
  } finally { switching = false; }
}

export async function switchWorkspace(id: string, add = false): Promise<string[]> {
  const saved = useLibrary.getState().workspaces.find((w) => w.id === id);
  if (!saved) throw new Error("This workspace no longer exists.");
  return applyWorkspace(saved, add);
}

export async function editWorkspaceRepositories(id: string, roots: string[]): Promise<string[]> {
  const library = useLibrary.getState(), saved = library.workspaces.find((w) => w.id === id);
  if (!saved) throw new Error("This workspace no longer exists.");
  if (workspaceBusy()) throw new Error("Wait for the current operation to finish before editing workspaces.");
  const active = library.activeWorkspaceId === id;
  const updated = workspaceWithRepositories(active ? workspaceSnapshot() : saved, roots);
  if (!active) {
    library.update(id, updated);
    return [];
  }
  return applyWorkspace({ ...saved, ...updated }, false);
}

export async function moveWorkspaceRepositories(fromId: string, toId: string, paths: string[]): Promise<string[]> {
  if (workspaceBusy()) throw new Error("Wait for the current operation to finish before moving repositories.");
  const library = useLibrary.getState();
  const source = library.workspaces.find((workspace) => workspace.id === fromId);
  const destination = library.workspaces.find((workspace) => workspace.id === toId);
  if (!source || !destination || fromId === toId) throw new Error("Choose two different workspaces.");
  const active = library.activeWorkspaceId;
  const current = workspaceSnapshot();
  const from = active === fromId ? current : source;
  const to = active === toId ? current : destination;
  const selected = new Set(paths.map(repositoryKey));
  const moving = from.roots.filter((root) => selected.has(repositoryKey(root)));
  if (!moving.length || moving.length !== selected.size) throw new Error("Review the current repository selection and try again.");
  const nextSource = workspaceWithRepositories(from, from.roots.filter((root) => !selected.has(repositoryKey(root))));
  const nextDestination = workspaceWithRepositories({ ...to, views: { ...from.views, ...to.views } }, [...to.roots, ...moving]);

  const saveMove = (applied?: WorkspaceSnapshot) => {
    useLibrary.setState((state) => ({
      knownRoots: uniqueRoots([...state.knownRoots, ...moving]),
      workspaces: state.workspaces.map((workspace) => {
        if (workspace.id === fromId) return { ...workspace, ...(active === fromId && applied ? applied : nextSource) };
        if (workspace.id === toId) return { ...workspace, ...(active === toId && applied ? applied : nextDestination) };
        return workspace;
      }),
    }));
  };
  if (active === fromId) return applyWorkspace({ ...source, ...nextSource }, false, saveMove);
  if (active === toId) return applyWorkspace({ ...destination, ...nextDestination }, false, saveMove);
  saveMove();
  return [];
}

async function applyWorkspace(saved: SavedWorkspace, add: boolean, onApplied?: (snapshot: WorkspaceSnapshot) => void): Promise<string[]> {
  if (workspaceBusy()) throw new Error("Wait for the current operation to finish before switching workspaces.");
  const target = structuredClone(saved), original = [...useRepos.getState().order];
  const originalRoots = new Map(original.map((root) => [repositoryKey(root), root]));
  capture(); switching = true;
  const busy = newOpId(), errors: string[] = [], opened: string[] = [], mapped = new Map<string, string>();
  let keepAsUnsaved = false;
  startBusy(busy, `Opening workspace ${target.name}`);
  try {
    if (!add) {
      const reports = await Promise.all(original.map((root) => api.validationReport(root)));
      if (reports.some(validationRunning)) throw new Error("Finish or cancel running validation before switching workspaces.");
      if (useRepos.getState().order.some((r) => useRepos.getState().tabs[r].pendingMutations) || useUi.getState().repositoryOperations.length) throw new Error("An operation started. Wait for it to finish.");
    }
    // Keep the previous workspace selected during discovery. If the switch
    // fails after opening tabs, keep the partial session without saving it.
    keepAsUnsaved = true;
    await Promise.all(target.roots.map(async root => {
      try {
        const existing = originalRoots.get(repositoryKey(root));
        const repos = useRepos.getState();
        const actual = existing && repos.tabs[existing]?.info ? existing : await repos.open(root, false);
        if (actual) { opened.push(actual); mapped.set(root, actual); }
        else errors.push(`${root}: Could not open repository`);
      }
      catch (e) { errors.push(`${root}: ${errorMessage(e)}`); }
    }));
    // Keep the original session and saved layout intact on any partial failure.
    if (errors.length) return errors;
    if (add) { keepAsUnsaved = false; return errors; }
    const reports = await Promise.all(useRepos.getState().order.map((root) => api.validationReport(root)));
    if (reports.some(validationRunning) || useRepos.getState().order.some((r) => useRepos.getState().tabs[r].pendingMutations) || useUi.getState().repositoryOperations.length) {
      errors.push("An operation started while repositories were opening. No repositories were closed."); return errors;
    }
    if (onApplied) {
      const expected = new Set([...original, ...opened]);
      const current = useRepos.getState().order;
      if (current.length !== expected.size || current.some((root) => !expected.has(root))) {
        return ["Open repositories changed while the move was in progress. Review the selection and try again."];
      }
    }
    for (const root of original) if (!opened.includes(root)) useRepos.getState().close(root);
    for (const [root, view] of Object.entries(target.views)) { const actual = mapped.get(root); if (actual) useRepos.getState().patch(actual, { view }); }
    const active = mapped.get(target.activeRoot ?? "") ?? opened[0] ?? null;
    useRepos.getState().arrange(target.roots.map(root => mapped.get(root)!).filter(Boolean), active);
    useSettings.getState().set({ layouts: structuredClone(target.layouts), historyMode: target.historyMode });
    useUi.setState({ overlay: null, repositoryOverview: false });
    onApplied?.(workspaceSnapshot());
    useLibrary.getState().select(target.id);
    keepAsUnsaved = false;
    return errors;
  } finally {
    if (keepAsUnsaved) useLibrary.getState().select(null);
    switching = false; endBusy(busy); capture();
  }
}
