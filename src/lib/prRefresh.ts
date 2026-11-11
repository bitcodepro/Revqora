import { useRepos } from "./store";

const PR_REFRESH = "revqora:refresh-pr-view";
type RefreshRequest = { root: string; track: (request: Promise<unknown>) => void };

export function onPrRefresh(root: string, refresh: () => Promise<unknown> | void) {
  const listener = (event: Event) => {
    const request = (event as CustomEvent<RefreshRequest>).detail;
    if (request.root !== root) return;
    const task = refresh();
    if (task) request.track(task);
  };
  window.addEventListener(PR_REFRESH, listener);
  return () => window.removeEventListener(PR_REFRESH, listener);
}

export async function refreshRepositoryView(root: string) {
  const repos = useRepos.getState();
  const tasks: Promise<unknown>[] = [repos.refresh(root)];
  if (repos.tabs[root]?.view === "pulls") {
    window.dispatchEvent(new CustomEvent<RefreshRequest>(PR_REFRESH, { detail: { root, track: task => { tasks.push(task); } } }));
  }
  await Promise.allSettled(tasks);
}
