import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { authorScope, loadAuthorPreferences, matchesPrAuthor, type PrAuthor } from "./prAuthors";
import { appendPullRequests } from "./prCenter";
import { visitPrPages, viewerAuthor } from "./prTracking";
import { uniqueRoots, useLibrary } from "./repositoryLibrary";
import { useRepos } from "./store";
import type { ForgeInfo, PrState, PullRequest } from "./types";

type RepositoryRequests = {
  forge: ForgeInfo | null;
  scope: string;
  author: PrAuthor | null;
  items: PullRequest[];
  notice?: string;
};

const EMPTY: Record<string, RepositoryRequests> = {};

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
  useEffect(() => {
    window.addEventListener("revqora:forge-accounts", refresh);
    return () => window.removeEventListener("revqora:forge-accounts", refresh);
  }, [refresh]);

  useEffect(() => {
    let current = true;
    let index = 0;
    setResult({ scan, groups: EMPTY, finished: false });
    function update(root: string, change: (old: RepositoryRequests) => RepositoryRequests) {
      if (!current) return;
      setResult(previous => previous?.scan === scan
        ? { ...previous, groups: { ...previous.groups, [root]: change(previous.groups[root] ?? { forge: null, scope: "", author: null, items: [] }) } }
        : previous);
    }
    async function worker() {
      while (current && index < scan.roots.length) {
        const root = scan.roots[index++];
        try {
          if (!await api.forgeKind(root) || !current) continue;
          await visitPrPages(cursor => api.prPage(root, scan.state, cursor), () => current, page => {
            const scope = authorScope(page.forge, page.viewer);
            const author = viewerAuthor(page.viewer) ?? loadAuthorPreferences(root, scope, page.forge).mine;
            update(root, old => ({ forge: page.forge, scope, author, items: appendPullRequests(old.scope === scope ? old.items : [], page.items) }));
          }, null, Infinity);
        } catch (error) {
          update(root, old => ({ ...old, notice: errorMessage(error) }));
        }
      }
    }
    scans.current = scans.current.then(async () => {
      if (!current) return;
      await Promise.all(Array.from({ length: Math.min(3, scan.roots.length) }, worker));
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

function mineOnly(groups: Record<string, RepositoryRequests>): Record<string, RepositoryRequests> {
  return Object.fromEntries(Object.entries(groups).map(([root, group]) => [root, group.notice || !group.forge ? group
    : group.author ? { ...group, items: group.items.filter(p => matchesPrAuthor(p, group.author)) }
    : { ...group, items: [], notice: "Set My PR author in this repository to include its pull requests." }]));
}
