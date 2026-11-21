/** Fetch, Pull and Push for many repositories or branches at once: from folder, repository and
 *  branch menus in Explorer and from the global commands. No dialogs: the list shows the new
 *  counts as each repository finishes, and one message sums it up. */
import { api, errorMessage, newOpId } from "./api";
import { fetchRound } from "./autofetch";
import { basename } from "./format";
import { repositoryKey, uniqueRoots, useLibrary } from "./repositoryLibrary";
import { invalidateExplorerBranches } from "./explorerBranchReads";
import { scanRepositoryTracking, trackingOf, useRepositoryTracking } from "./repositoryTracking";
import { repositoryIncoming, useRepos } from "./store";
import type { BranchesSync } from "./types";
import { endBusy, startBusy, toast, useUi } from "./ui";

export type SyncKind = "fetch" | "pull" | "push";

/** One repository, and the branches to work on: full ref names (`refs/heads/…`,
 *  `refs/remotes/…`) or `HEAD` for the checked-out branch. Without branches: every branch. */
export interface SyncTarget {
  root: string;
  branches?: string[];
}

interface Outcome extends SyncTarget {
  error?: string;
  result?: BranchesSync;
}

let running = false;

/** Repositories worked on at once. Each mostly waits on its server, so a long list goes about
 *  twice as fast as with four, and eight connections stay polite to one server. Automatic
 *  fetches in the background keep to four. */
export const SYNC_PARALLEL = 8;

/** Every repository in the list: the open ones and the library's closed ones. */
export function listedRoots() {
  return uniqueRoots([...useRepos.getState().order, ...useLibrary.getState().knownRoots]);
}

const nameOf = (root: string) => useLibrary.getState().repositoryNames[repositoryKey(root)] ?? useRepos.getState().tabs[root]?.info?.name ?? basename(root);
const firstLine = (text: string) => text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? text;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Merges targets of the same repository; a repository asked for whole stays whole. */
export function mergeTargets(targets: SyncTarget[]): SyncTarget[] {
  const merged = new Map<string, SyncTarget>();
  for (const target of targets) {
    const key = repositoryKey(target.root), known = merged.get(key);
    if (!known) merged.set(key, { root: target.root, branches: target.branches && [...new Set(target.branches)] });
    else if (!known.branches || !target.branches) known.branches = undefined;
    else known.branches = [...new Set([...known.branches, ...target.branches])];
  }
  return [...merged.values()].filter((target) => !target.branches || target.branches.length);
}

/** `SYNC_PARALLEL` repositories at a time; one failing never stops the rest. */
export async function syncRepositories(kind: SyncKind, requested: SyncTarget[]) {
  const targets = mergeTargets(requested);
  if (!targets.length) return;
  if (running || useUi.getState().busy.length) {
    toast.info("Another operation is running", "Try again when it finishes.");
    return;
  }
  running = true;
  const id = newOpId();
  const label = { fetch: "Fetching", pull: "Pulling", push: "Pushing" }[kind];
  const what = targets.every((target) => !target.branches) ? "repositories" : "branches";
  startBusy(id, `${label} ${what} (0/${targets.length})`);
  const outcomes: Outcome[] = [];
  try {
    await fetchRound(targets, async (target) => {
      const { root, branches } = target;
      const outcome: Outcome = { ...target };
      const open = () => !!useRepos.getState().tabs[root];
      try {
        if (kind === "fetch") {
          if (branches) outcome.result = await api.fetchBranches(root, branches, id);
          else await api.fetch(root, null, true, id);
        } else if (kind === "pull") outcome.result = await api.pullBranches(root, branches ?? null, id);
        else outcome.result = await api.pushBranches(root, branches ?? null, id);
        if (kind !== "push" && open()) useRepos.getState().patch(root, { lastFetchedAt: Date.now(), fetchError: null });
      } catch (e) {
        outcome.error = firstLine(errorMessage(e));
        if (kind === "fetch" && open()) useRepos.getState().patch(root, { fetchError: errorMessage(e) });
      }
      await (open()
        ? useRepos.getState().refresh(root, { info: true, status: true, refs: true, graph: useRepos.getState().active === root })
        : scanRepositoryTracking([root]).finally(() => invalidateExplorerBranches([root]))).catch(() => {});
      outcomes.push(outcome);
      useUi.setState((s) => ({ busy: s.busy.map((b) => b.id === id ? { ...b, label: `${label} ${what} (${outcomes.length}/${targets.length})`, line: "" } : b) }));
    }, () => true, SYNC_PARALLEL);
  } finally {
    endBusy(id);
    running = false;
  }
  report(kind, outcomes);
}

function report(kind: SyncKind, outcomes: Outcome[]) {
  const failed = outcomes.filter((o) => o.error).map((o) => `${nameOf(o.root)}: ${o.error}`);
  const skipped = outcomes.flatMap((o) => (o.result?.skipped ?? []).map((k) => `${nameOf(o.root)} · ${k.branch}: ${firstLine(k.reason)}`));
  const updated = outcomes.flatMap((o) => (o.result?.updated ?? []).map((u) => ({ root: o.root, ...u })));
  const list = (lines: string[]) => lines.slice(0, 5).join("\n") + (lines.length > 5 ? `\n…and ${lines.length - 5} more` : "");
  const problems = [...failed, ...skipped];
  const lines = updated.map((u) => `${nameOf(u.root)} · ${u.branch} ${kind === "push" ? "↑" : "+"}${u.commits}`);
  let title: string, detail: string | undefined;
  if (kind === "fetch") {
    // Whole repositories: their incoming counts. Chosen branches: the ones with incoming commits.
    const tracking = useRepositoryTracking.getState().byKey;
    const incoming = outcomes.filter((o) => !o.error && !o.branches && repositoryIncoming(useRepos.getState().tabs[o.root], trackingOf(tracking, o.root)) > 0).map((o) => nameOf(o.root));
    const branchesOnly = outcomes.every((o) => o.branches);
    title = branchesOnly
      ? `Fetched branches in ${outcomes.length - failed.length} of ${plural(outcomes.length, "repository", "repositories")}`
      : `Fetched ${outcomes.length - failed.length} of ${plural(outcomes.length, "repository", "repositories")}`;
    const news = [...(incoming.length ? [`Incoming commits: ${incoming.join(", ")}`] : []), ...lines];
    detail = news.length ? list(news) : "No incoming commits";
    if (problems.length) toast.warning(`${title} · ${failed.length + skipped.length} need${problems.length === 1 ? "s" : ""} attention`, list([...problems, ...news]));
    else toast.success(title, detail);
    return;
  }
  const repositories = new Set(updated.map((u) => u.root)).size;
  const verb = kind === "pull" ? "Pulled" : "Pushed";
  title = updated.length
    ? `${verb} ${plural(updated.length, "branch", "branches")} in ${plural(repositories, "repository", "repositories")}`
    : kind === "pull" ? "Everything is up to date" : "Nothing to push";
  if (problems.length) toast.warning(`${title} · ${problems.length} need${problems.length === 1 ? "s" : ""} attention`, list(problems));
  else toast.success(title, updated.length ? list(lines) : undefined);
}

const whole = (roots: string[]) => roots.map((root): SyncTarget => ({ root }));

/** Fetch every remote of the repositories (every listed repository by default). */
export const fetchRepositories = (roots = listedRoots()) => syncRepositories("fetch", whole(roots));
/** Fetch, then fast-forward every branch that only lacks incoming commits. */
export const pullRepositories = (roots = listedRoots()) => syncRepositories("pull", whole(roots));
/** Push every branch with commits its upstream lacks. */
export const pushRepositories = (roots = listedRoots()) => syncRepositories("push", whole(roots));
/** The checked-out branch of every listed repository. */
export const syncCurrentBranches = (kind: SyncKind) => syncRepositories(kind, listedRoots().map((root) => ({ root, branches: ["HEAD"] })));
