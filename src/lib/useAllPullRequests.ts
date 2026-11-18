import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { errorFacts } from "./diagnostics";
import { authorScope, loadAuthorPreferences, matchesPrAuthor, type PrAuthor } from "./prAuthors";
import { appendPullRequests } from "./prCenter";
import { ATTENTION_PARALLEL, attentionCandidates, IDENTITY_NOTICE, type AttentionFacts } from "./prAttention";
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
  /** Provider reads for the "Needs attention" queue, by PR number. */
  attention?: Record<number, AttentionFacts>;
  /** Why this repository's queue may be incomplete (for example, an unknown identity). */
  attentionNotice?: string;
};

/** Runs at most `n` tasks at once, in the order they were queued. */
export function limiter(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running >= n) await new Promise<void>(resolve => waiting.push(resolve));
    running++;
    try { return await task(); } finally { running--; waiting.shift()?.(); }
  };
}
/** Shared by the PR Center and the MCP queue, so together they never exceed it. */
const attentionSlots = limiter(ATTENTION_PARALLEL);

/**
 * Reads CI, merge readiness and review state for the open PRs of one repository that need the
 * viewer. Earlier answers stay until a new one arrives; an error replaces the answer, so a
 * failed read is never shown as an earlier success.
 */
export async function readAttention(root: string, group: Pick<RepositoryRequests, "forge" | "author" | "items">, current: () => boolean,
  report: (change: (old: RepositoryRequests) => RepositoryRequests) => void, run: <T>(task: () => Promise<T>) => Promise<T> = attentionSlots): Promise<void> {
  const connection = group.forge?.connectionRevision;
  if (!group.forge) return;
  if (!group.author) { report(old => ({ ...old, attentionNotice: IDENTITY_NOTICE })); return; }
  const { check, skipped } = attentionCandidates(group.items, group.author);
  const skippedText = `Not checked: more than ${check.length} of your requests in this repository. Open the PR to see its status.`;
  report(old => {
    const attention: Record<number, AttentionFacts> = {};
    for (const n of check) attention[n] = { ...old.attention?.[n], loading: true, error: undefined, skipped: undefined };
    for (const n of skipped) attention[n] = { skipped: skippedText };
    return { ...old, attention, attentionNotice: undefined };
  });
  const settle = (n: number, facts: AttentionFacts) => report(old => ({ ...old, attention: { ...old.attention, [n]: facts } }));
  await Promise.all(check.map(n => run(async () => {
    if (!current()) return;
    if (!connection) { settle(n, { error: "Choose an API account for this repository." }); return; }
    try { settle(n, { value: await api.prAttention(root, n, connection) }); }
    catch (error) { settle(n, { error: errorMessage(error) }); }
  })));
}

const EMPTY: Record<string, RepositoryRequests> = {};
/** Rows of an earlier scan per repository, with the author scope (project and account) they belong to. */
export type EarlierRows = Map<string, { scope: string; items: PullRequest[] }>;
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

export function useAllPullRequests(state: PrState, mine: boolean, attention = false) {
  const known = useLibrary(s => s.knownRoots);
  const opened = useRepos(s => s.order);
  // Library edits that keep the same repositories must not restart the scan.
  const rootsKey = JSON.stringify(uniqueRoots([...opened, ...known]));
  const roots = useMemo(() => JSON.parse(rootsKey) as string[], [rootsKey]);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(async () => { setGeneration(n => n + 1); }, []);
  // Turning the attention queue on reads the provider for the PRs that need you; turning it
  // off keeps the rows and reads nothing more.
  const wantAttention = useRef(attention);
  wantAttention.current = attention;
  const [attentionEpoch, setAttentionEpoch] = useState(0);
  const attentionWasOn = useRef(attention);
  useEffect(() => {
    if (attention && !attentionWasOn.current) setAttentionEpoch(n => n + 1);
    attentionWasOn.current = attention;
  }, [attention]);
  // "Mine" filters the scanned rows, so switching it does not load every repository again.
  const scan = useMemo(() => ({ roots, state, generation, attentionEpoch }), [roots, state, generation, attentionEpoch]);
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
    const earlier: EarlierRows = new Map(Object.entries(seeded).map(([root, group]) => [root, { scope: group.scope, items: group.items }]));
    setResult({ scan, groups: seeded, finished: false });
    function update(root: string, change: (old: RepositoryRequests) => RepositoryRequests) {
      if (!current) return;
      setResult(previous => previous?.scan === scan
        ? { ...previous, groups: { ...previous.groups, [root]: change(previous.groups[root] ?? { forge: null, scope: "", author: null, items: [] }) } }
        : previous);
    }
    scans.current = scans.current.then(async () => {
      if (!current) return;
      await scanPullRequests(scan.roots, scan.state, earlier, () => current, update, PR_SCAN_PARALLEL, () => wantAttention.current && scan.state !== "closed" && scan.state !== "merged");
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
 * page through `update`. `earlier` holds the rows of a refreshed repository with the project
 * and account they were read for: they stay until its refresh completes, then rows that are
 * gone on the server disappear. Once a page comes from another project or account, those rows
 * are dropped for the rest of the scan. Nothing is reported
 * once `current()` is false (another status, another library or a newer refresh).
 */
export async function scanPullRequests(roots: string[], state: PrState, earlier: EarlierRows, current: () => boolean,
  update: (root: string, change: (old: RepositoryRequests) => RepositoryRequests) => void, parallel = PR_SCAN_PARALLEL, attention: () => boolean = () => false): Promise<void> {
  let index = 0;
  const report = (root: string, change: (old: RepositoryRequests) => RepositoryRequests) => { if (current()) update(root, change); };
  async function worker() {
    while (current() && index < roots.length) {
      const root = roots[index++];
      let fresh: PullRequest[] = [], freshScope: string | null = null, forge: ForgeInfo | null = null, author: PrAuthor | null = null;
      try {
        if (!await api.forgeKind(root) || !current()) {
          // No provider any more: forget the rows of an earlier scan.
          if (earlier.has(root)) report(root, () => ({ forge: null, scope: "", author: null, items: [] }));
          continue;
        }
        const complete = await visitPrPages(cursor => api.prPage(root, state, cursor), current, page => {
          const scope = authorScope(page.forge, page.viewer);
          fresh = appendPullRequests(freshScope === scope ? fresh : [], page.items);
          freshScope = scope;
          forge = page.forge;
          author = viewerAuthor(page.viewer) ?? loadAuthorPreferences(root, scope, page.forge).mine;
          const retained = earlier.get(root);
          if (retained && retained.scope !== scope) earlier.delete(root);
          const keep = retained?.scope === scope ? retained.items : [];
          report(root, old => ({ ...old, forge: page.forge, scope, author, items: refreshingRows(fresh, keep) }));
        }, null, Infinity);
        if (complete) report(root, old => ({ ...old, items: fresh, notice: undefined, noticeDetails: undefined, loading: false, stale: false, loadedAt: Date.now() }));
        if (complete && attention() && current()) await readAttention(root, { forge, author, items: fresh }, current, change => report(root, change));
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
