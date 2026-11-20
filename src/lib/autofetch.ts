import { api, errorMessage, isGitError } from "./api";
import { recordError } from "./errorLog";

export interface AutoFetchDeps {
  fetch: (root: string) => Promise<unknown>;
  /** `changed` false: the fetch reported that no ref changed. */
  refresh: (root: string, changed: boolean) => Promise<unknown>;
  busy: () => boolean;
  failed?: (root: string, error: unknown) => void;
  /** Writes a failure to the error log (tests replace it). */
  log?: (root: string, error: unknown) => void;
}

/** What one automatic fetch of a repository did. */
export type AutoFetchResult = "fetched" | "skipped" | "transient" | "failed";

/** Failures in a row before a network problem of one repository goes to the error log. */
export const LOG_AFTER_FAILURES = 3;

/** A fetch nobody asked for that the network ended (time limit, stall, no connection, VPN
 *  down): the next round tries again, and the error log is not filled with one entry per
 *  repository and round. */
export function transientFetchFailure(error: unknown): boolean {
  if (!isGitError(error)) return false;
  if (["git-timeout", "network-stalled", "cancelled", "repository-busy"].includes(error.kind)) return true;
  return /could not resolve host|failed to connect|couldn't connect|connection (was )?(reset|refused|timed out|closed)|timed out|operation too slow|network is unreachable|unable to access|early eof|ssl/i.test(error.message);
}

const defaultLog = (root: string, error: unknown) => recordError("fetch_background", error, root);

/**
 * Background fetch for the open repositories. Uses the noninteractive backend command (no
 * credential prompts), never runs twice at once for a repository, and stops for a repository
 * after an authentication failure until the app restarts.
 *
 * A repository whose fetch the network ended waits longer each time (the next round, then 1,
 * 3 and at most 7 rounds skipped); it goes to the error log once after
 * {@link LOG_AFTER_FAILURES} such failures in a row. Other failures are logged once per message.
 */
export function createAutoFetch(deps: AutoFetchDeps) {
  const inFlight = new Set<string>();
  const disabled = new Set<string>();
  const failures = new Map<string, { count: number; skip: number; logged: string | null }>();
  const log = deps.log ?? defaultLog;
  return async function quietFetch(root: string): Promise<AutoFetchResult> {
    if (disabled.has(root) || inFlight.has(root) || deps.busy()) return "skipped";
    const failure = failures.get(root);
    if (failure && failure.skip > 0) {
      failure.skip--;
      return "skipped";
    }
    inFlight.add(root);
    try {
      const result = await deps.fetch(root);
      failures.delete(root);
      await deps.refresh(root, refsChanged(result));
      return "fetched";
    } catch (e) {
      // The repository was busy with another operation: not a failure, try at the next interval.
      if (isGitError(e) && e.kind === "repository-busy") return "skipped";
      deps.failed?.(root, e);
      if (isGitError(e) && e.kind === "auth") disabled.add(root);
      const state = failures.get(root) ?? { count: 0, skip: 0, logged: null };
      failures.set(root, state);
      state.count++;
      if (transientFetchFailure(e)) {
        state.skip = Math.min(7, 2 ** (state.count - 1) - 1);
        if (state.count === LOG_AFTER_FAILURES) log(root, withMessage(e, `Automatic fetch failed ${LOG_AFTER_FAILURES} times in a row. Last error: ${errorMessage(e)}`));
        return "transient";
      }
      const message = errorMessage(e);
      if (state.logged !== message) {
        state.logged = message;
        log(root, e);
      }
      return "failed";
    } finally {
      inFlight.delete(root);
    }
  };
}

function withMessage(error: unknown, message: string) {
  return isGitError(error) ? { ...error, message } : { kind: "error", message };
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
