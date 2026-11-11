import { api, errorMessage, newOpId } from "./api";
import { useRepos } from "./store";
import { useSettings } from "./settings";
import { planFolderWorkspaces, repairTree, repositoryKey, uniqueRoots, useLibrary, type FolderWorkspace, type SavedWorkspace, type WorkspaceSnapshot } from "./repositoryLibrary";
import { endBusy, startBusy, useUi } from "./ui";
import { validationRunning } from "./validation";

let ready = false;
let switching = false;
interface WorkspaceDrop {
  before: SavedWorkspace[];
  after: SavedWorkspace[];
}
const workspaceDrops: WorkspaceDrop[] = [];
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
  const { roots, activeRoot, views, layouts, historyMode } = saved;
  const old = { roots, activeRoot, views, layouts, historyMode };
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
  useUi.setState({ repositoryGroup: null });
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
    for (const { folder, roots, existing, name, id, parentId } of planFolderWorkspaces(workspaces, groups)) {
      const members = uniqueRoots([...(existing?.roots ?? []), ...roots]);
      const layout = workspaceWithRepositories(existing ?? snapshot, members);
      const imported = { ...existing, ...layout, id, name, parentId, importedFrom: folder };
      if (existing) workspaces[workspaces.indexOf(existing)] = imported;
      else workspaces.push(imported);
    }
    useLibrary.setState({ knownRoots: uniqueRoots([...library.knownRoots, ...roots]), workspaces: repairTree(workspaces) });
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

const sameMembers = (a: SavedWorkspace, b: SavedWorkspace) => a.roots.length === b.roots.length && a.roots.every((root, i) => repositoryKey(root) === repositoryKey(b.roots[i]));

export async function dropWorkspaceRepositories(fromId: string | null, toId: string, paths: string[]): Promise<string[]> {
  const library = useLibrary.getState();
  const destination = library.workspaces.find(w => w.id === toId);
  if (!destination || fromId !== library.activeWorkspaceId || fromId === toId) throw new Error("Choose a workspace from the current repository list.");
  const before = library.workspaces.filter(w => w.id === toId || w.id === fromId).map(w => w.id === fromId ? { ...w, ...workspaceSnapshot() } : w);
  const errors = fromId ? await moveWorkspaceRepositories(fromId, toId, paths) : await editWorkspaceRepositories(toId, [...destination.roots, ...paths]);
  if (!errors.length) {
    const after = useLibrary.getState().workspaces.filter(w => before.some(old => old.id === w.id && !sameMembers(old, w)));
    if (after.length) {
      workspaceDrops.push({ before: before.filter(w => after.some(changed => changed.id === w.id)), after });
      if (workspaceDrops.length > 20) workspaceDrops.shift();
    }
  }
  return errors;
}

export function hasWorkspaceDropToUndo() { return workspaceDrops.length > 0; }

export async function undoWorkspaceDrop(): Promise<string[]> {
  const drop = workspaceDrops.at(-1);
  if (!drop) return [];
  if (workspaceBusy()) throw new Error("Wait for the current operation to finish before undoing the workspace move.");
  const library = useLibrary.getState();
  const current = drop.after.map(expected => {
    const saved = library.workspaces.find(w => w.id === expected.id);
    if (!saved || !sameMembers(saved, expected)) throw new Error("Workspace membership changed after this move. Review its repositories before undoing.");
    return saved.id === library.activeWorkspaceId ? { ...saved, ...workspaceSnapshot() } : saved;
  });
  if (current.some((w, i) => !sameMembers(w, drop.after[i]))) throw new Error("Open repositories changed after this move.");
  const restored = current.map(w => {
    const old = drop.before.find(before => before.id === w.id)!;
    return { ...w, ...workspaceWithRepositories({ ...w, activeRoot: w.activeRoot ?? old.activeRoot, views: { ...old.views, ...w.views } }, old.roots) };
  });
  const save = (applied?: WorkspaceSnapshot) => {
    useLibrary.setState(s => ({ workspaces: s.workspaces.map(w => {
      const next = restored.find(item => item.id === w.id);
      return next ? { ...next, ...(next.id === library.activeWorkspaceId && applied ? applied : {}) } : w;
    }) }));
    workspaceDrops.pop();
  };
  const active = restored.find(w => w.id === library.activeWorkspaceId);
  if (active) return applyWorkspace(active, false, save);
  save();
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
    const active = mapped.get(target.activeRoot ?? "") ?? opened[0] ?? null;
    useRepos.getState().arrange(target.roots.map(root => mapped.get(root)!).filter(Boolean), active);
    for (const [root, view] of Object.entries(target.views)) { const actual = mapped.get(root); if (actual) useRepos.getState().patch(actual, { view }); }
    useSettings.getState().set({ layouts: structuredClone(target.layouts), historyMode: target.historyMode });
    useUi.setState({ overlay: null, repositoryOverview: false, ...(useLibrary.getState().activeWorkspaceId !== target.id ? { repositoryGroup: null } : {}) });
    onApplied?.(workspaceSnapshot());
    useLibrary.getState().select(target.id);
    keepAsUnsaved = false;
    return errors;
  } finally {
    if (keepAsUnsaved) useLibrary.getState().select(null);
    switching = false; endBusy(busy); capture();
  }
}
