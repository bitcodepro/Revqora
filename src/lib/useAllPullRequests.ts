import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { errorFacts } from "./diagnostics";
import { authorScope, loadAuthorPreferences, matchesPrAuthor, type PrAuthor } from "./prAuthors";
import { appendPullRequests } from "./prCenter";
import { visitPrPages, viewerAuthor } from "./prTracking";
import { uniqueRoots, useLibrary } from "./repositoryLibrary";
import { useRepos } from "./store";
import type { ForgeInfo, PrState, PullRequest } from "./types";

export type RepositoryRequests = {
  forge: ForgeInfo | null;
  scope: string;
  author: PrAuthor | null;
  items: PullRequest[];
  notice?: string;
  /** Code, HTTP status and request ID of the failure, for a diagnostics report. */
  noticeDetails?: string[];
  /** When this repository's list last loaded completely (ms since epoch). */
  loadedAt?: number;
  /** A refresh of this repository is running; `items` may still include earlier rows. */
  loading?: boolean;
  /** Some rows come from an earlier load: the refresh is running or failed. */
  stale?: boolean;
};

const EMPTY: Record<string, RepositoryRequests> = {};
/** Repositories read at once. Each waits on its own server, so slow ones hold fewer others. */
export const PR_SCAN_PARALLEL = 6;

/**
 * Rows to show while a repository refreshes: the rows read so far in this refresh, then the
 * earlier rows not read yet, so the list neither empties nor jumps while pages arrive.
 */
export function refreshingRows(fresh: PullRequest[], earlier: PullRequest[]): PullRequest[] {
  const read = new Set(fresh.map(pull => pull.number));
  return [...fresh, ...earlier.filter(pull => !read.has(pull.number))];
}

/**
 * The groups a new scan starts from. A refresh of the same request status keeps every
 * repository's rows, notices and load time, marked as refreshing; another status starts empty.
 */
export function seedGroups(previous: Record<string, RepositoryRequests> | undefined, roots: string[]): Record<string, RepositoryRequests> {
  if (!previous) return EMPTY;
  const groups: Record<string, RepositoryRequests> = {};
  for (const root of roots) {
    const group = previous[root];
    if (group) groups[root] = { ...group, loading: true, stale: group.items.length > 0 || group.stale };
  }
  return groups;
}

export function useAllPullRequests(state: PrState, mine: boolean) {
  const known = useLibrary(s => s.knownRoots);
  const opened = useRepos(s => s.order);
  // Library edits that keep the same repositories must not restart the scan.
  const rootsKey = JSON.stringify(uniqueRoots([...opened, ...known]));
  const roots = useMemo(() => JSON.parse(rootsKey) as string[], [rootsKey]);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(async () => { setGeneration(n => n + 1); }, []);
  // "Mine" filters the scanned rows, so switching it does not load every repository again.
  const scan = useMemo(() => ({ roots, state, generation }), [roots, state, generation]);
  const [result, setResult] = useState<{ scan: typeof scan; groups: typeof EMPTY; finished: boolean }>();
  const scans = useRef(Promise.resolve());
  // The rows shown now, which a refresh keeps until each repository answers again.
  const latest = useRef(result);
  latest.current = result;
  useEffect(() => {
    window.addEventListener("revqora:forge-accounts", refresh);
    return () => window.removeEventListener("revqora:forge-accounts", refresh);
  }, [refresh]);

  useEffect(() => {
    let current = true;
    const previous = latest.current;
    const seeded = previous && previous.scan.state === scan.state ? seedGroups(previous.groups, scan.roots) : EMPTY;
    const earlier = new Map(Object.entries(seeded).map(([root, group]) => [root, group.items]));
    setResult({ scan, groups: seeded, finished: false });
    function update(root: string, change: (old: RepositoryRequests) => RepositoryRequests) {
      if (!current) return;
      setResult(previous => previous?.scan === scan
        ? { ...previous, groups: { ...previous.groups, [root]: change(previous.groups[root] ?? { forge: null, scope: "", author: null, items: [] }) } }
        : previous);
    }
    scans.current = scans.current.then(async () => {
      if (!current) return;
      await scanPullRequests(scan.roots, scan.state, earlier, () => current, update);
      if (current) setResult(previous => previous?.scan === scan ? { ...previous, finished: true } : previous);
    });
    return () => { current = false; };
  }, [scan]);

  const update = useCallback((root: string, connection: string | null, pull: PullRequest) => {
    setResult(previous => {
      const group = previous?.groups[root];
      if (!previous || !group || group.forge?.connectionRevision !== connection) return previous;
      return {
        ...previous,
        groups: { ...previous.groups, [root]: { ...group, items: group.items.map(row => row.number === pull.number ? pull : row) } },
      };
    });
  }, []);
  const scanned = result?.scan === scan ? result.groups : EMPTY;
  const groups = useMemo(() => mine ? mineOnly(scanned) : scanned, [scanned, mine]);
  return { groups, finished: result?.scan === scan && result.finished, refresh, update };
}

/**
 * Reads the pull requests of `roots`, `parallel` repositories at a time, and reports each
 * page through `update`. `earlier` holds the rows of a refreshed repository: they stay until
 * its refresh completes, then rows that are gone on the server disappear. Nothing is reported
 * once `current()` is false (another status, another library or a newer refresh).
 */
export async function scanPullRequests(roots: string[], state: PrState, earlier: Map<string, PullRequest[]>, current: () => boolean,
  update: (root: string, change: (old: RepositoryRequests) => RepositoryRequests) => void, parallel = PR_SCAN_PARALLEL): Promise<void> {
  let index = 0;
  const report = (root: string, change: (old: RepositoryRequests) => RepositoryRequests) => { if (current()) update(root, change); };
  async function worker() {
    while (current() && index < roots.length) {
      const root = roots[index++];
      let fresh: PullRequest[] = [], freshScope: string | null = null;
      try {
        if (!await api.forgeKind(root) || !current()) {
          // No provider any more: forget the rows of an earlier scan.
          if (earlier.has(root)) report(root, () => ({ forge: null, scope: "", author: null, items: [] }));
          continue;
        }
        const complete = await visitPrPages(cursor => api.prPage(root, state, cursor), current, page => {
          const scope = authorScope(page.forge, page.viewer);
          const author = viewerAuthor(page.viewer) ?? loadAuthorPreferences(root, scope, page.forge).mine;
          fresh = appendPullRequests(freshScope === scope ? fresh : [], page.items);
          freshScope = scope;
          report(root, old => ({ ...old, forge: page.forge, scope, author, items: old.scope === scope ? refreshingRows(fresh, earlier.get(root) ?? []) : fresh }));
        }, null, Infinity);
        if (complete) report(root, old => ({ ...old, items: fresh, notice: undefined, noticeDetails: undefined, loading: false, stale: false, loadedAt: Date.now() }));
      } catch (error) {
        // Rows read before the error stay, and so do earlier rows: marked as not current.
        report(root, old => ({ ...old, notice: errorMessage(error), noticeDetails: errorFacts(error), loading: false, stale: old.items.length > fresh.length }));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, roots.length) }, worker));
}

const AUTHOR_NOTICE = "Set My PR author in this repository to include its pull requests.";

/** "My PR" rows. A page error keeps the rows loaded before it, so they are filtered too. */
export function mineOnly(groups: Record<string, RepositoryRequests>): Record<string, RepositoryRequests> {
  return Object.fromEntries(Object.entries(groups).map(([root, group]) => [root, !group.forge ? group
    : group.author ? { ...group, items: group.items.filter(p => matchesPrAuthor(p, group.author)) }
    : { ...group, items: [], notice: group.notice ? `${group.notice} ${AUTHOR_NOTICE}` : AUTHOR_NOTICE }]));
}

/**
 * Repositories still refreshing (their earlier rows stay visible meanwhile), and the oldest
 * complete load among repositories with a provider: the list is at least that fresh.
 */
export function pullRequestFreshness(groups: Record<string, RepositoryRequests>, finished: boolean): { refreshing: number; loadedAt: number | null } {
  const values = Object.values(groups);
  const loaded = values.filter(group => group.forge && group.loadedAt !== undefined).map(group => group.loadedAt!);
  return { refreshing: finished ? 0 : values.filter(group => group.loading).length, loadedAt: loaded.length ? Math.min(...loaded) : null };
}
