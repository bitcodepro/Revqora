import { api, errorMessage, newOpId } from "./api";
import { useRepos } from "./store";
import { useSettings } from "./settings";
import { repositoryKey, useLibrary, type WorkspaceSnapshot } from "./repositoryLibrary";
import { endBusy, startBusy, useUi } from "./ui";
import { validationRunning } from "./validation";

let ready = false;
let switching = false;
export function workspaceSnapshot(): WorkspaceSnapshot {
  const r = useRepos.getState(), s = useSettings.getState();
  return structuredClone({ roots: r.order, activeRoot: r.active, views: Object.fromEntries(r.order.map((root) => [root, r.tabs[root].view])), layouts: s.layouts, historyMode: s.historyMode });
}
function capture() {
  if (!ready || switching) return;
  const library = useLibrary.getState(), saved = library.workspaces.find((w) => w.id === library.activeWorkspaceId);
  if (!saved) return;
  const snapshot = workspaceSnapshot();
  const { id: _id, name: _name, ...old } = saved;
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
export async function switchWorkspace(id: string, add = false): Promise<string[]> {
  if (workspaceBusy()) throw new Error("Wait for the current operation to finish before switching workspaces.");
  const library = useLibrary.getState(), saved = library.workspaces.find((w) => w.id === id);
  if (!saved) throw new Error("This workspace no longer exists.");
  const target = structuredClone(saved), original = [...useRepos.getState().order], previous = library.activeWorkspaceId;
  capture(); switching = true;
  const busy = newOpId(), errors: string[] = [], opened: string[] = [], mapped = new Map<string, string>();
  startBusy(busy, `Opening workspace ${target.name}`);
  try {
    if (!add) {
      const reports = await Promise.all(original.map((root) => api.validationReport(root)));
      if (reports.some(validationRunning)) throw new Error("Finish or cancel running validation before switching workspaces.");
      if (useRepos.getState().order.some((r) => useRepos.getState().tabs[r].pendingMutations) || useUi.getState().repositoryOperations.length) throw new Error("An operation started. Wait for it to finish.");
    }
    library.select(null);
    for (const root of target.roots) {
      try { const actual = await useRepos.getState().open(root, false); if (actual) { opened.push(actual); mapped.set(root, actual); } else errors.push(`${root}: Could not open repository`); }
      catch (e) { errors.push(`${root}: ${errorMessage(e)}`); }
    }
    // Keep the original session and saved layout intact on any partial failure.
    if (errors.length) return errors;
    if (add) { useLibrary.getState().select(previous); return errors; }
    const reports = await Promise.all(useRepos.getState().order.map((root) => api.validationReport(root)));
    if (reports.some(validationRunning) || useRepos.getState().order.some((r) => useRepos.getState().tabs[r].pendingMutations) || useUi.getState().repositoryOperations.length) {
      errors.push("An operation started while repositories were opening. No repositories were closed."); return errors;
    }
    for (const root of original) if (!opened.includes(root)) useRepos.getState().close(root);
    for (const [root, view] of Object.entries(target.views)) { const actual = mapped.get(root); if (actual) useRepos.getState().patch(actual, { view }); }
    const active = mapped.get(target.activeRoot ?? "") ?? opened[0] ?? null;
    useRepos.getState().arrange(opened, active);
    useSettings.getState().set({ layouts: structuredClone(target.layouts), historyMode: target.historyMode });
    useUi.setState({ overlay: null, repositoryOverview: false });
    useLibrary.getState().select(id);
    return errors;
  } finally { switching = false; endBusy(busy); capture(); }
}
