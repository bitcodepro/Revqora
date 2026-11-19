import type { Parts } from "./store";

/** Parts of a repository view that a refresh reads, and when each read last started. */
export type ReadPart = "info" | "status" | "changes" | "refs" | "layers" | "graph";
export type ReadStamps = Partial<Record<ReadPart, number>>;

/**
 * The parts of `parts` that still need a read for a change that happened at `since`
 * (`Date.now()` clock; the backend reports the same wall clock). A read that started at or
 * after the change already includes it, also while it is still running. A watcher burst
 * caused by Revqora's own Git writes, the operation's completion event and the caller that
 * waited for the operation therefore share one read instead of three. Null when every
 * requested part is covered. A Changes-only status (open diff fingerprint) covers a
 * working-file event, but not a full status request, which needs the mutation token.
 */
export function unreadParts(stamps: ReadStamps | undefined, parts: Parts, since: number): Parts | null {
  const fresh = (part: ReadPart) => (stamps?.[part] ?? Number.NEGATIVE_INFINITY) >= since;
  const left: Parts = { ...parts };
  if (left.info && fresh("info")) left.info = false;
  if (left.status && (fresh("status") || (left.changesDisplay && fresh("changes")))) left.status = false;
  if (left.refs && fresh("refs")) left.refs = false;
  if (left.layers && fresh("layers")) left.layers = false;
  if (left.graph && fresh("graph")) left.graph = false;
  return left.info || left.status || left.refs || left.layers || left.graph ? left : null;
}

/**
 * When the change an operation made is complete: its completion time when that event was
 * seen after the caller started it, otherwise now (later than the operation's end, so only
 * reads that began after the caller got the answer count).
 */
export function changeTime(ended: number | undefined, startedAt: number, now = Date.now()): number {
  return ended !== undefined && ended >= startedAt ? Math.min(ended, now) : now;
}
