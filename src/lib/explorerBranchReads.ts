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

function recentRead(root: string): BranchRead | undefined {
  const entry = recent.get(root);
  if (entry && Date.now() - entry.at < RECENT_MS) return entry.read;
  recent.delete(root);
  return undefined;
}

function readClosedBranches(root: string) {
  const known = recentRead(root);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(root);
  if (pending) return pending;
  const result = reads.run(root, () => api.refs(root))
    .then((refs): BranchRead => ({ refs }), (error): BranchRead => ({ error: errorMessage(error) }))
    .then(read => {
      if ("refs" in read) recent.set(root, { at: Date.now(), read });
      return read;
    })
    .finally(() => inFlight.delete(root));
  inFlight.set(root, result);
  return result;
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
  return closed;
}
