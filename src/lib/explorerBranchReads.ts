import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { repositoryQueue } from "./repositoryQueue";
import { useRepos } from "./store";
import type { RefsSnapshot } from "./types";

type BranchRead = { refs: RefsSnapshot } | { error: string };
const reads = repositoryQueue();
const inFlight = new Map<string, Promise<BranchRead>>();

function readClosedBranches(root: string) {
  const pending = inFlight.get(root);
  if (pending) return pending;
  const result = reads.run(root, () => api.refs(root))
    .then(refs => ({ refs }), error => ({ error: errorMessage(error) }))
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
    setClosed(current => Object.fromEntries(requested.filter(root => current[root]).map(root => [root, current[root]])));
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
