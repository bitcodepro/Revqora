import type { CommitSearchHit, CommitSearchPage } from "./types";

/** Matches loaded per repository before the dialog shows "Show more matches". */
export const WORKSPACE_SEARCH_PAGE = 30;
/** Repositories searched at the same time. Not changed without a measured workspace sweep. */
export const WORKSPACE_PARALLEL_SEARCHES = 2;
/** Typing pause before a search starts. */
export const WORKSPACE_SEARCH_DEBOUNCE_MS = 320;

export interface RepositorySearchResult {
  hits: CommitSearchHit[];
  /** Continue with this cursor for more matches; null when the repository is complete. */
  cursor: string | null;
  error?: string;
}

export type FetchSearchPage = (root: string, cursor: string | null) => Promise<CommitSearchPage>;

/** The active repository first, the others in workspace order. */
export function prioritizeRoots(roots: readonly string[], active: string | null | undefined): string[] {
  if (!active || !roots.includes(active)) return [...roots];
  return [active, ...roots.filter((root) => root !== active)];
}

/** Adds a page to the matches already shown: no duplicates, newest author date first (stable). */
export function mergeHits(existing: readonly CommitSearchHit[], next: readonly CommitSearchHit[]): CommitSearchHit[] {
  const seen = new Set(existing.map((hit) => hit.oid));
  const merged = [...existing, ...next.filter((hit) => !seen.has(hit.oid) && seen.add(hit.oid))];
  return merged.sort((a, b) => b.authorTime - a.authorTime);
}

/**
 * Loads pages of one repository until `target` more matches arrived or it is complete.
 * Publishes every page so results render incrementally. Returns null once `isCurrent`
 * turns false: an obsolete search never publishes and stops before its next request.
 */
export async function loadRepositoryMatches(
  root: string,
  start: RepositorySearchResult,
  fetchPage: FetchSearchPage,
  isCurrent: () => boolean,
  publish: (root: string, result: RepositorySearchResult) => void,
  target = WORKSPACE_SEARCH_PAGE,
): Promise<RepositorySearchResult | null> {
  let result = start;
  const wanted = start.hits.length + target;
  let cursor = start.cursor;
  let first = !start.hits.length && !start.cursor;
  while (first || cursor) {
    first = false;
    let page: CommitSearchPage;
    try {
      page = await fetchPage(root, cursor);
    } catch (error) {
      if (!isCurrent()) return null;
      result = { ...result, error: error instanceof Error ? error.message : String(error) };
      publish(root, result);
      return result;
    }
    if (!isCurrent()) return null;
    cursor = page.nextCursor;
    result = { hits: mergeHits(result.hits, page.commits), cursor };
    publish(root, result);
    if (result.hits.length >= wanted) break;
  }
  return result;
}

/**
 * Searches every repository with at most `concurrency` requests at a time, in the given
 * order (put the active repository first). A replacement search does not wait for this one:
 * once `isCurrent` is false no new request starts and no further result is published.
 */
export async function searchRepositories(
  roots: readonly string[],
  fetchPage: FetchSearchPage,
  isCurrent: () => boolean,
  publish: (root: string, result: RepositorySearchResult) => void,
  concurrency = WORKSPACE_PARALLEL_SEARCHES,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (isCurrent() && next < roots.length) {
      const root = roots[next++];
      await loadRepositoryMatches(root, { hits: [], cursor: null }, fetchPage, isCurrent, publish);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, roots.length)) }, worker));
}
