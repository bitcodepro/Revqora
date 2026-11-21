import { create } from "zustand";
import { api } from "./api";
import { repositoryKey, uniqueRoots, useLibrary } from "./repositoryLibrary";
import { repositoryQueue } from "./repositoryQueue";
import { repositorySidebarStatus, useRepos, type RepoTab } from "./store";
import type { BranchTracking } from "./types";

/**
 * Incoming and outgoing commits of every repository in the library, also the ones that are not
 * open, for the Explorer's Incoming and Outgoing filters, and the number of changed entries of
 * repositories that are not open, for its Changes filter. Branch tracking reads refs only (no
 * working-tree scan). All branch reads are queued before change counts, several repositories
 * at a time, so Incoming and Outgoing are complete first.
 */
export const useRepositoryTracking = create<{ byKey: Record<string, BranchTracking>; changes: Record<string, number> }>(() => ({ byKey: {}, changes: {} }));

export const trackingOf = (byKey: Record<string, BranchTracking>, root: string): BranchTracking | undefined => byKey[repositoryKey(root)];
export const changesOf = (changes: Record<string, number>, root: string): number | undefined => changes[repositoryKey(root)];

const queue = repositoryQueue(6);
/** Reads not started yet, and the read running now, per kind and repository. */
const waiting = new Map<string, Promise<void>>();
const running = new Map<string, Promise<void>>();

const sameTracking = (a: BranchTracking | undefined, b: BranchTracking) => !!a && a.branch === b.branch && a.oid === b.oid &&
  a.upstream === b.upstream && a.ahead === b.ahead && a.behind === b.behind && a.unpublished === b.unpublished;

type Field = "byKey" | "changes";
type Update = { field: Field; key: string; value?: unknown; same: (a: unknown, b: unknown) => boolean };

/**
 * Answers that arrive close together (a library sweep answers several repositories at a time)
 * are applied in one state change, so the Explorer and the rows render once for all of them
 * instead of once per repository. A scan finishes once its answer is applied.
 */
const updates: Update[] = [];
let flushing: Promise<void> | null = null;
const FLUSH_MS = 16;

function apply(update: Update): Promise<void> {
  updates.push(update);
  flushing ??= new Promise<void>(resolve => setTimeout(() => {
    flushing = null;
    const batch = updates.splice(0);
    useRepositoryTracking.setState(state => {
      const next: Partial<Record<Field, Record<string, unknown>>> = {};
      for (const { field, key, value, same } of batch) {
        const values = next[field] ?? state[field] as Record<string, unknown>;
        if (value === undefined ? !(key in values) : same(values[key], value)) continue;
        const copy = next[field] ??= { ...values };
        if (value === undefined) delete copy[key];
        else copy[key] = value;
      }
      return Object.keys(next).length ? next as Partial<typeof state> : state;
    });
    resolve();
  }, FLUSH_MS));
  return flushing;
}

/**
 * Reads the tracking of `roots` again. Reads of one repository run one after another, so the
 * newest answer wins; requests made while a read waits share it.
 */
export function scanRepositoryTracking(roots: string[]): Promise<void> {
  return Promise.all(uniqueRoots(roots).map(root => scanOne("byKey", root, api.repositoryBranchTracking, sameTracking))).then(() => {});
}

/** Reads the number of changed entries of `roots` again (for repositories that are not open). */
export function scanRepositoryChanges(roots: string[]): Promise<void> {
  return Promise.all(uniqueRoots(roots).map(root => scanOne("changes", root, api.repositoryChangeCount, (a, b) => a === b))).then(() => {});
}

function scanOne<T>(field: Field, root: string, load: (root: string) => Promise<T>, same: (a: T | undefined, b: T) => boolean): Promise<void> {
  const key = repositoryKey(root), jobKey = `${field}:${key}`;
  const pending = waiting.get(jobKey);
  if (pending) return pending;
  const job: Promise<void> = (running.get(jobKey) ?? Promise.resolve()).then(() => queue.run(jobKey, async () => {
    waiting.delete(jobKey);
    running.set(jobKey, job);
    try {
      const value = await load(root);
      await apply({ field, key, value, same: same as (a: unknown, b: unknown) => boolean });
    } catch {
      // A moved or deleted folder shows no counts; opening it reports the problem.
      await apply({ field, key, same: () => false });
    } finally {
      if (running.get(jobKey) === job) running.delete(jobKey);
    }
  }));
  waiting.set(jobKey, job);
  return job;
}

/** Branch tracking of `roots`, then the change counts of those that are not open. */
function scanClosed(roots: string[]) {
  void scanRepositoryTracking(roots);
  const tabs = useRepos.getState().tabs;
  void scanRepositoryChanges(roots.filter(root => !tabs[root]));
}

/** Open repositories answer from their own status, except the unpublished count of a branch
 *  without an upstream while the list of branches is not loaded. */
function needsTracking(tab: RepoTab | undefined, previous: RepoTab | undefined, tracking: BranchTracking | undefined) {
  const status = repositorySidebarStatus(tab);
  if (!status?.branch || status.upstream || tab?.refs) return false;
  return status !== repositorySidebarStatus(previous) && (tracking?.branch !== status.branch || tracking.oid !== status.oid)
    || tab?.lastFetchedAt !== previous?.lastFetchedAt;
}

/**
 * Git data of an open repository changed on disk (the watcher: a push, fetch or commit made in
 * another tool). Its counts come from tracking while its status is loading, and the unpublished
 * count of a branch without an upstream does while its list of branches is not loaded; a push
 * or fetch changes that count without changing the branch or HEAD, so read it again.
 */
export function repositoryGitChanged(root: string): void {
  const tab = useRepos.getState().tabs[root];
  if (!tab || tab.refs) return;
  const status = repositorySidebarStatus(tab);
  if (status && (!status.branch || status.upstream)) return;
  void scanRepositoryTracking([root]);
}

const FOCUS_INTERVAL_MS = 10_000;
const FOCUS_AWAY_MS = 30_000;
const FIRST_SWEEP_MAX_DELAY_MS = 4_000;
let stop: (() => void) | null = null;

/** Checks the whole library now, new repositories when they are added, closed repositories when
 *  the window regains focus (edits and commits made in other tools) and open ones as described
 *  above. Open repositories count their changes in their own status. */
export function startRepositoryTracking(): () => void {
  if (stop) return stop;
  const all = () => uniqueRoots([...useRepos.getState().order, ...useLibrary.getState().knownRoots]);
  // The first sweep reads every repository of the library: let the shown repository's history
  // appear first (or wait at most a few seconds), so it does not compete with that.
  let swept = false;
  const sweep = () => {
    if (swept) return;
    swept = true;
    window.clearTimeout(sweepTimer);
    unsubscribeShown();
    scanClosed(all());
  };
  const shownReady = () => {
    const state = useRepos.getState(), tab = state.active ? state.tabs[state.active] : null;
    return !tab || !!tab.graph || !!tab.error;
  };
  const sweepTimer = window.setTimeout(sweep, FIRST_SWEEP_MAX_DELAY_MS);
  const unsubscribeShown = useRepos.subscribe(() => { if (shownReady()) sweep(); });
  if (useRepos.getState().order.length === 0 || shownReady()) sweep();
  const unsubscribeLibrary = useLibrary.subscribe((state, previous) => {
    if (state.knownRoots === previous.knownRoots) return;
    const known = new Set(previous.knownRoots.map(repositoryKey));
    scanClosed(state.knownRoots.filter(root => !known.has(repositoryKey(root))));
  });
  const unsubscribeRepos = useRepos.subscribe((state, previous) => {
    if (state.tabs === previous.tabs) return;
    const byKey = useRepositoryTracking.getState().byKey;
    // A closed repository keeps the state it had while open: read it again.
    const closed = previous.order.filter(root => !state.tabs[root]);
    // Restored tabs open a few at a time with a full status; their counts appear before that.
    const added = state.order.filter(root => !previous.tabs[root] && !trackingOf(byKey, root));
    const changed = state.order.filter(root => needsTracking(state.tabs[root], previous.tabs[root], trackingOf(byKey, root)));
    if (closed.length) scanClosed(closed);
    if (added.length || changed.length) void scanRepositoryTracking([...added, ...changed]);
  });
  let lastFocus = Date.now(), blurredAt: number | null = null;
  // Reads every closed repository: only after the user was away long enough to have worked in
  // other tools, not when focus returns from a dialog, a detached panel or a quick switch.
  const onBlur = () => { blurredAt = Date.now(); };
  const onFocus = () => {
    const away = blurredAt === null ? 0 : Date.now() - blurredAt;
    blurredAt = null;
    if (away < FOCUS_AWAY_MS || Date.now() - lastFocus < FOCUS_INTERVAL_MS) return;
    lastFocus = Date.now();
    const tabs = useRepos.getState().tabs;
    scanClosed(all().filter(root => !repositorySidebarStatus(tabs[root])));
  };
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  stop = () => {
    window.clearTimeout(sweepTimer);
    unsubscribeShown();
    unsubscribeLibrary();
    unsubscribeRepos();
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    stop = null;
  };
  return stop;
}
