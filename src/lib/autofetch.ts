import { api, errorMessage, isGitError } from "./api";
import { recordError } from "./errorLog";

export interface AutoFetchDeps {
  fetch: (root: string) => Promise<unknown>;
  /** `changed` false: the fetch reported that no ref changed. */
  refresh: (root: string, changed: boolean) => Promise<unknown>;
  busy: () => boolean;
  failed?: (root: string, error: unknown) => void;
  /** The server a repository fetches from, when known (an open repository's remotes). */
  serverOf?: (root: string) => string | null;
  /** Every server a repository's fetch asks (one per remote host), when known. */
  serversOf?: (root: string) => string[];
  /** Writes a failure to the error log (tests replace it). */
  log?: (root: string, error: unknown) => void;
}

/** What one automatic fetch of a repository did. */
export type AutoFetchResult = "fetched" | "skipped" | "transient" | "failed";

/** Detail of a failed fetch that still moved refs (`REFS_CHANGED_DETAIL` in ops.rs). */
export const REFS_CHANGED = "refs-changed=true";

/** Failures in a row before a network problem of one repository goes to the error log. */
export const LOG_AFTER_FAILURES = 3;

/** A fetch nobody asked for that the network ended (time limit, stall, no connection, VPN
 *  down): the next round tries again, and the error log is not filled with one entry per
 *  repository and round. */
export function transientFetchFailure(error: unknown): boolean {
  if (!isGitError(error)) return false;
  if (["git-timeout", "network-stalled", "server-unavailable", "cancelled", "repository-busy"].includes(error.kind)) return true;
  // The server answered: a refused sign-in, no permission or no such repository (HTTP 4xx) is
  // not the network, although Git's message also says "unable to access".
  if (/returned error: 4\d\d\b/i.test(error.message)) return false;
  return /could not resolve host|failed to connect|couldn't connect|connection (was )?(reset|refused|timed out|closed)|timed out|operation too slow|network is unreachable|unable to access|early eof|ssl/i.test(error.message);
}

const defaultLog = (root: string, error: unknown) => recordError("fetch_background", error, root);

/** The host of a remote URL (`https://host/…`, `ssh://user@host:22/…`, `user@host:path`). */
export function urlHost(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(url) ?? /^(?:[^@/\\:]+@)?([^/\\:]+):(?!\/\/)/.exec(url);
  return match && !/^[a-z]$/i.test(match[1]) ? match[1].toLowerCase() : null;
}

/** The server a failed fetch names: the URL Git could not reach, or the host it could not resolve or connect to. */
export function failedServer(error: unknown): string | null {
  const message = isGitError(error) ? `${error.message}\n${error.stderr ?? ""}` : String(error ?? "");
  const url = /'([a-z][a-z0-9+.-]*:\/\/[^']+)'/i.exec(message);
  if (url) return urlHost(url[1]);
  const host = /(?:could not resolve host|connect to host|could not resolve hostname)[:\s]+([a-z0-9.-]+)/i.exec(message);
  return host ? host[1].toLowerCase() : null;
}

/**
 * Background fetch for the open repositories. Uses the noninteractive backend command (no
 * credential prompts), never runs twice at once for a repository, and stops for a repository
 * after an authentication failure until the app restarts.
 *
 * A repository whose fetch the network or its server ended waits longer each time (the next
 * round, then 1 and at most 3 rounds skipped); it goes to the error log once after
 * {@link LOG_AFTER_FAILURES} such failures in a row. Other failures are logged once per message,
 * and end such a row.
 */
export function createAutoFetch(deps: AutoFetchDeps) {
  const inFlight = new Set<string>();
  const disabled = new Set<string>();
  // `network`: network failures in a row (another failure ends the row).
  const failures = new Map<string, { network: number; skip: number; logged: string | null }>();
  // Learned from failures, for repositories that are not open.
  const servers = new Map<string, string>();
  // The server the last failure of a repository named (its remotes can be on several servers).
  const named = new Map<string, string>();
  const log = deps.log ?? defaultLog;
  const quietFetch = async function quietFetch(root: string): Promise<AutoFetchResult> {
    if (disabled.has(root) || inFlight.has(root) || deps.busy()) return "skipped";
    const failure = failures.get(root);
    if (failure && failure.skip > 0) {
      failure.skip--;
      return "skipped";
    }
    inFlight.add(root);
    named.delete(root);
    try {
      const result = await deps.fetch(root);
      failures.delete(root);
      await deps.refresh(root, refsChanged(result));
      return "fetched";
    } catch (e) {
      // The repository was busy with another operation: not a failure, try at the next interval.
      if (isGitError(e) && e.kind === "repository-busy") return "skipped";
      // One remote failed after others were fetched: what came in is shown. Started before
      // `failed`, which then shows the error.
      const partly = isGitError(e) && e.details.includes(REFS_CHANGED) ? deps.refresh(root, true).catch(() => {}) : null;
      deps.failed?.(root, e);
      await partly;
      const server = failedServer(e);
      if (server) {
        servers.set(root, server);
        named.set(root, server);
      }
      if (isGitError(e) && e.kind === "auth") disabled.add(root);
      const state = failures.get(root) ?? { network: 0, skip: 0, logged: null };
      failures.set(root, state);
      if (transientFetchFailure(e)) {
        state.network++;
        state.skip = Math.min(3, 2 ** (state.network - 1) - 1);
        if (state.network === LOG_AFTER_FAILURES) log(root, withMessage(e, `Automatic fetch failed ${LOG_AFTER_FAILURES} times in a row. Last error: ${errorMessage(e)}`));
        return "transient";
      }
      state.network = 0;
      state.skip = 0;
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
  /** The server `root` fetches from, if known. */
  const server = (root: string) => deps.serverOf?.(root) ?? servers.get(root) ?? null;
  /** The server the last failed fetch of `root` could not reach: the one Git named, else the one
   *  `root` fetches from. A failure on a mirror counts for the mirror's server, not for origin's.
   *  False: Git named none and the fetch asked several servers, so none can be blamed. */
  const failedAt = (root: string): string | null | false => {
    const name = named.get(root);
    if (name) return name;
    if ((deps.serversOf?.(root).length ?? 0) > 1) return false;
    return server(root);
  };
  return Object.assign(quietFetch, { server, failedAt });
}

/** Failures in one round before the rest of a server's repositories wait for the next round. */
export const SERVER_FAILURES_PER_ROUND = 2;

/**
 * One automatic fetch round. A server that failed twice (down, answering 502, unreachable)
 * is not asked again this round, and its other repositories wait; repositories on other
 * servers are still fetched. Two failures that name no server (time limits) mean the
 * connection itself is down: the round ends.
 */
export async function autoFetchRound(
  roots: string[],
  quietFetch: ((root: string) => Promise<AutoFetchResult>) & { server: (root: string) => string | null; failedAt?: (root: string) => string | null | false },
  eligible: (root: string) => boolean,
  current: () => boolean,
  parallel: number,
): Promise<void> {
  const failedServers = new Map<string, number>();
  let unknown = 0;
  const down = (server: string | null) => !!server && (failedServers.get(server) ?? 0) >= SERVER_FAILURES_PER_ROUND;
  await fetchRound(roots, async root => {
    if (!eligible(root) || down(quietFetch.server(root))) return;
    if (await quietFetch(root) !== "transient") return;
    const server = (quietFetch.failedAt ?? quietFetch.server)(root);
    // Several servers and Git named none: it counts for no server, and is no sign that the
    // connection is down either.
    if (server === false) return;
    if (server) failedServers.set(server, (failedServers.get(server) ?? 0) + 1);
    else unknown++;
  }, () => current() && unknown < SERVER_FAILURES_PER_ROUND, parallel);
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
