import { attentionRows, type AttentionFacts, type AttentionFilter, type AttentionReason } from "./prAttention";
import { PR_SCAN_PARALLEL, scanPullRequests, type RepositoryRequests } from "./useAllPullRequests";
import type { ForgeInfo } from "./types";

/**
 * The MCP `pull_request_queue`: the PR Center's "Needs attention" queue for the given
 * repositories, built with the same scan and the same rules, then paged from a snapshot so
 * later pages never mix in a newer scan.
 */
export const QUEUE_PAGE = 50;
/** A scan stops here and reports the repositories and PRs that did not answer in time. */
export const QUEUE_BUDGET_MS = 100_000;
const SNAPSHOT_TTL_MS = 10 * 60_000;
const SNAPSHOTS = 4;

export interface QueueItem {
  repository: string;
  provider: ForgeInfo["kind"];
  project: string;
  number: number;
  title: string;
  author: string;
  url: string;
  draft: boolean;
  head: string;
  base: string;
  reasons: AttentionReason[];
  /** When CI and merge status were read for this PR (ms since epoch), or null. */
  checkedAt: number | null;
}
export interface QueueRepository {
  repository: string;
  provider: ForgeInfo["kind"] | null;
  project: string | null;
  /** "complete", "failed", "incomplete" (did not answer in time), "needs_identity" (the list loaded, but
   * Revqora does not know your account there, so review requests and your own PRs cannot be found) or "no_provider". */
  status: "complete" | "failed" | "incomplete" | "needs_identity" | "no_provider";
  /** When its list last loaded completely (ms since epoch), or null. */
  loadedAt: number | null;
  error: string | null;
}
export interface QueueSnapshot { id: string; key: string; created: number; filter: AttentionFilter; items: QueueItem[]; repositories: QueueRepository[] }

const LATE = "Did not answer in time.";

/** Reads the queue of `roots` for `filter`. Never throws for one repository's failure. */
export async function buildQueue(roots: string[], filter: AttentionFilter, budget = QUEUE_BUDGET_MS, now = () => Date.now()): Promise<Omit<QueueSnapshot, "id" | "key">> {
  const groups: Record<string, RepositoryRequests> = {};
  let live = true;
  const scan = scanPullRequests(roots, "open", new Map(), () => live,
    (root, change) => { groups[root] = change(groups[root] ?? { forge: null, scope: "", author: null, items: [] }); }, PR_SCAN_PARALLEL, () => true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = await Promise.race([scan.then(() => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), budget); })]);
  clearTimeout(timer);
  live = false;
  // Reads still running when the budget ran out count as unread, never as nothing to do.
  for (const group of Object.values(groups)) {
    if (!group.attention) continue;
    group.attention = Object.fromEntries(Object.entries(group.attention).map(([n, facts]): [string, AttentionFacts] => [n, facts.loading ? { error: LATE } : facts]));
  }
  const items = attentionRows(groups, filter).map(({ root, forge, pull, reasons, checkedAt }) => ({
    repository: root, provider: forge.kind, project: forge.project, number: pull.number, title: pull.title, author: pull.author,
    url: pull.url, draft: pull.draft, head: pull.head, base: pull.base, reasons, checkedAt,
  }));
  const repositories = roots.map((root): QueueRepository => {
    const group = groups[root];
    if (group?.notice) {
      return { repository: root, provider: group.forge?.kind ?? null, project: group.forge?.project ?? null, status: "failed", loadedAt: group.loadedAt ?? null, error: group.notice };
    }
    if (!group?.forge) return { repository: root, provider: null, project: null, status: group || !late ? "no_provider" : "incomplete", loadedAt: null, error: group || !late ? null : LATE };
    const complete = group.loadedAt !== undefined;
    return {
      repository: root, provider: group.forge.kind, project: group.forge.project,
      status: !complete ? "incomplete" : group.attentionNotice ? "needs_identity" : "complete",
      loadedAt: group.loadedAt ?? null,
      error: group.attentionNotice ?? (complete ? null : LATE),
    };
  });
  return { created: now(), filter, items, repositories };
}

const snapshots = new Map<string, QueueSnapshot>();
export const queueKey = (roots: string[], filter: AttentionFilter) => JSON.stringify([filter, [...roots].sort()]);

export function keepSnapshot(snapshot: Omit<QueueSnapshot, "id" | "key">, key: string, id = crypto.randomUUID()): QueueSnapshot {
  const kept = { ...snapshot, id, key };
  snapshots.set(id, kept);
  while (snapshots.size > SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
  return kept;
}

/** The snapshot a cursor continues, or null when it expired or belongs to another query. */
export function resumeSnapshot(cursor: string, key: string, now = Date.now()): { snapshot: QueueSnapshot; offset: number } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(cursor); } catch { return null; }
  const { s, o } = (parsed ?? {}) as { s?: unknown; o?: unknown };
  if (typeof s !== "string" || typeof o !== "number" || !Number.isSafeInteger(o) || o < 0) return null;
  const snapshot = snapshots.get(s);
  if (!snapshot || snapshot.key !== key || now - snapshot.created > SNAPSHOT_TTL_MS || o > snapshot.items.length) return null;
  return { snapshot, offset: o };
}

export function queuePage(snapshot: QueueSnapshot, offset = 0) {
  const end = offset + QUEUE_PAGE;
  return {
    filter: snapshot.filter,
    generatedAt: snapshot.created,
    total: snapshot.items.length,
    items: snapshot.items.slice(offset, end),
    repositories: snapshot.repositories,
    nextCursor: end < snapshot.items.length ? JSON.stringify({ s: snapshot.id, o: end }) : null,
  };
}
