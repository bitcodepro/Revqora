import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { repositoryQueue } from "./repositoryQueue";
import { useRepos } from "./store";
import type { RefsSnapshot } from "./types";

type BranchRead = { refs: RefsSnapshot } | { error: string };
const reads = repositoryQueue();
const inFlight = new Map<string, Promise<BranchRead>>();
// Branches of closed repositories read for an Explorer search or filter. Typing, clearing and
// typing again reuses them for a short while instead of reading every repository again.
const recent = new Map<string, { at: number; read: BranchRead }>();
const RECENT_MS = 20_000;
// Bumped when a repository changed: a read that started before is not kept for reuse.
const generations = new Map<string, number>();

function recentRead(root: string): BranchRead | undefined {
  const entry = recent.get(root);
  if (entry && Date.now() - entry.at < RECENT_MS) return entry.read;
  recent.delete(root);
  return undefined;
}

/** Branches of a closed repository, reused for a short while (exported for tests). */
export function readClosedBranches(root: string) {
  const known = recentRead(root);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(root);
  if (pending) return pending;
  const generation = generations.get(root) ?? 0;
  const result = reads.run(root, () => api.refs(root))
    .then((refs): BranchRead => ({ refs }), (error): BranchRead => ({ error: errorMessage(error) }))
    .then(read => {
      // A repository that never changed has no generation yet: 0, as when the read started.
      if ("refs" in read && (generations.get(root) ?? 0) === generation) recent.set(root, { at: Date.now(), read });
      return read;
    })
    .finally(() => inFlight.delete(root));
  inFlight.set(root, result);
  return result;
}

const invalidated = new Set<(roots: string[]) => void>();

/** Drops the branches read for closed repositories after Fetch, Pull or Push changed them, and
 *  reads them again where Explorer shows them, so branch rows and their menus are current. */
export function invalidateExplorerBranches(roots: string[]) {
  for (const root of roots) {
    recent.delete(root);
    generations.set(root, (generations.get(root) ?? 0) + 1);
  }
  for (const listener of invalidated) listener(roots);
}

export function useExplorerBranchReads(roots: string[]) {
  const [closed, setClosed] = useState<Record<string, BranchRead | undefined>>({});
  const tracked = useRef(new Map<string, () => void>());
  const requestKey = JSON.stringify(roots);
  useEffect(() => {
    const requested = new Set<string>(JSON.parse(requestKey));
    for (const [root, release] of tracked.current) {
      if (requested.has(root)) continue;
      release();
      tracked.current.delete(root);
    }
    for (const root of requested) {
      if (!tracked.current.has(root)) tracked.current.set(root, useRepos.getState().trackBranchRefs(root));
    }
  }, [requestKey]);
  useEffect(() => () => {
    for (const release of tracked.current.values()) release();
    tracked.current.clear();
  }, []);

  const closedRoots = roots.filter(root => !useRepos.getState().tabs[root]);
  const closedKey = JSON.stringify(closedRoots);
  useEffect(() => {
    let cancelled = false;
    const requested = JSON.parse(closedKey) as string[];
    setClosed(current => Object.fromEntries(requested.flatMap(root => {
      const read = current[root] ?? recentRead(root);
      return read ? [[root, read]] : [];
    })));
    // Schedule only the next few reads. Closing Explorer or clearing a filter
    // drops the rest of the batch before it reaches Git.
    let next = 0;
    void Promise.all(Array.from({ length: Math.min(4, requested.length) }, async () => {
      while (!cancelled && next < requested.length) {
        const root = requested[next++]!;
        const result = await readClosedBranches(root);
        if (!cancelled) setClosed(current => ({ ...current, [root]: result }));
      }
    }));
    return () => { cancelled = true; };
  }, [closedKey]);
  useEffect(() => {
    let active = true;
    const listener = (changed: string[]) => {
      const shown = new Set(JSON.parse(closedKey) as string[]);
      for (const root of changed.filter(root => shown.has(root))) {
        // A read started before the change may still be in flight: read again after it.
        void (inFlight.get(root) ?? Promise.resolve()).then(() => readClosedBranches(root)).then(read => {
          if (active) setClosed(current => ({ ...current, [root]: read }));
        });
      }
    };
    invalidated.add(listener);
    return () => { active = false; invalidated.delete(listener); };
  }, [closedKey]);
  return closed;
}
