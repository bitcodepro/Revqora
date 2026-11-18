import { create } from "zustand";
import { api } from "./api";
import { repositoryKey, uniqueRoots, useLibrary } from "./repositoryLibrary";
import { repositoryQueue } from "./repositoryQueue";
import { repositorySidebarStatus, useRepos, type RepoTab } from "./store";
import type { BranchTracking } from "./types";

/**
 * Incoming and outgoing commits of every repository in the library, also the ones that are not
 * open, for the Explorer's Incoming and Outgoing filters. Each check reads refs only (no working
 * tree scan), several repositories at a time, so the filters are complete moments after start.
 */
export const useRepositoryTracking = create<{ byKey: Record<string, BranchTracking> }>(() => ({ byKey: {} }));

export const trackingOf = (byKey: Record<string, BranchTracking>, root: string): BranchTracking | undefined => byKey[repositoryKey(root)];

const queue = repositoryQueue(6);
/** Reads not started yet, and the read running now, per repository. */
const waiting = new Map<string, Promise<void>>();
const running = new Map<string, Promise<void>>();

const sameTracking = (a: BranchTracking | undefined, b: BranchTracking) => !!a && a.branch === b.branch && a.oid === b.oid &&
  a.upstream === b.upstream && a.ahead === b.ahead && a.behind === b.behind && a.unpublished === b.unpublished;

/**
 * Reads the tracking of `roots` again. Reads of one repository run one after another, so the
 * newest answer wins; requests made while a read waits share it.
 */
export function scanRepositoryTracking(roots: string[]): Promise<void> {
  return Promise.all(uniqueRoots(roots).map(scanOne)).then(() => {});
}

function scanOne(root: string): Promise<void> {
  const key = repositoryKey(root);
  const pending = waiting.get(key);
  if (pending) return pending;
  const job: Promise<void> = (running.get(key) ?? Promise.resolve()).then(() => queue.run(key, async () => {
    waiting.delete(key);
    running.set(key, job);
    try {
      const tracking = await api.repositoryBranchTracking(root);
      useRepositoryTracking.setState(state => sameTracking(state.byKey[key], tracking) ? state : { byKey: { ...state.byKey, [key]: tracking } });
    } catch {
      // A moved or deleted folder shows no counts; opening it reports the problem.
      if (useRepositoryTracking.getState().byKey[key]) {
        useRepositoryTracking.setState(state => {
          const byKey = { ...state.byKey };
          delete byKey[key];
          return { byKey };
        });
      }
    } finally {
      if (running.get(key) === job) running.delete(key);
    }
  }));
  waiting.set(key, job);
  return job;
}

/** Open repositories answer from their own status, except the unpublished count of a branch
 *  without an upstream while the list of branches is not loaded. */
function needsTracking(tab: RepoTab | undefined, previous: RepoTab | undefined, tracking: BranchTracking | undefined) {
  const status = repositorySidebarStatus(tab);
  if (!status?.branch || status.upstream || tab?.refs) return false;
  return status !== repositorySidebarStatus(previous) && (tracking?.branch !== status.branch || tracking.oid !== status.oid)
    || tab?.lastFetchedAt !== previous?.lastFetchedAt;
}

const FOCUS_INTERVAL_MS = 10_000;
let stop: (() => void) | null = null;

/** Checks the whole library now, new repositories when they are added, closed repositories when
 *  the window regains focus (commits made in other tools) and open ones as described above. */
export function startRepositoryTracking(): () => void {
  if (stop) return stop;
  const all = () => uniqueRoots([...useRepos.getState().order, ...useLibrary.getState().knownRoots]);
  void scanRepositoryTracking(all());
  const unsubscribeLibrary = useLibrary.subscribe((state, previous) => {
    if (state.knownRoots === previous.knownRoots) return;
    const known = new Set(previous.knownRoots.map(repositoryKey));
    void scanRepositoryTracking(state.knownRoots.filter(root => !known.has(repositoryKey(root))));
  });
  const unsubscribeRepos = useRepos.subscribe((state, previous) => {
    if (state.tabs === previous.tabs) return;
    const byKey = useRepositoryTracking.getState().byKey;
    // A closed repository keeps the state it had while open: read it again.
    const closed = previous.order.filter(root => !state.tabs[root]);
    // Restored tabs open a few at a time with a full status; their counts appear before that.
    const added = state.order.filter(root => !previous.tabs[root] && !trackingOf(byKey, root));
    const changed = state.order.filter(root => needsTracking(state.tabs[root], previous.tabs[root], trackingOf(byKey, root)));
    if (closed.length || added.length || changed.length) void scanRepositoryTracking([...closed, ...added, ...changed]);
  });
  let lastFocus = Date.now();
  const onFocus = () => {
    if (Date.now() - lastFocus < FOCUS_INTERVAL_MS) return;
    lastFocus = Date.now();
    const tabs = useRepos.getState().tabs;
    void scanRepositoryTracking(all().filter(root => !repositorySidebarStatus(tabs[root])));
  };
  window.addEventListener("focus", onFocus);
  stop = () => {
    unsubscribeLibrary();
    unsubscribeRepos();
    window.removeEventListener("focus", onFocus);
    stop = null;
  };
  return stop;
}
