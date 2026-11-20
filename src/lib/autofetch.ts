import { api, isGitError } from "./api";

export interface AutoFetchDeps {
  fetch: (root: string) => Promise<unknown>;
  /** `changed` false: the fetch reported that no ref changed. */
  refresh: (root: string, changed: boolean) => Promise<unknown>;
  busy: () => boolean;
  failed?: (root: string, error: unknown) => void;
}

/**
 * Background fetch for the open repositories. Uses the noninteractive backend command (no
 * credential prompts), never runs twice at once for a repository, and stops for a repository
 * after an authentication failure until the app restarts.
 */
export function createAutoFetch(deps: AutoFetchDeps) {
  const inFlight = new Set<string>();
  const disabled = new Set<string>();
  return async function quietFetch(root: string): Promise<void> {
    if (disabled.has(root) || inFlight.has(root) || deps.busy()) return;
    inFlight.add(root);
    try {
      const result = await deps.fetch(root);
      await deps.refresh(root, refsChanged(result));
    } catch (e) {
      // The repository was busy with another operation: not a failure, try at the next interval.
      if (isGitError(e) && e.kind === "repository-busy") return;
      deps.failed?.(root, e);
      if (isGitError(e) && e.kind === "auth") disabled.add(root);
    } finally {
      inFlight.delete(root);
    }
  };
}

export const defaultFetch = (root: string) => api.fetchBackground(root);

/** False only when the fetch said that no ref changed. */
function refsChanged(result: unknown): boolean {
  return !(typeof result === "object" && result !== null && (result as { refsChanged?: unknown }).refsChanged === false);
}

/** One auto-fetch round: `parallel` repositories at a time, in order, until `current()` ends. */
export async function fetchRound<T>(roots: T[], fetch: (root: T) => Promise<void>, current: () => boolean, parallel: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, roots.length) }, async () => {
    while (current() && next < roots.length) await fetch(roots[next++]);
  }));
}
