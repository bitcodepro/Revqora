import { api, isGitError } from "./api";

export interface AutoFetchDeps {
  fetch: (root: string) => Promise<unknown>;
  refresh: (root: string) => Promise<unknown>;
  busy: () => boolean;
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
      await deps.fetch(root);
      await deps.refresh(root);
    } catch (e) {
      if (isGitError(e) && e.kind === "auth") disabled.add(root);
    } finally {
      inFlight.delete(root);
    }
  };
}

export const defaultFetch = (root: string) => api.fetchBackground(root);
