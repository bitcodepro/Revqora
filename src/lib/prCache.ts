/**
 * Short-lived memory of pull request reads. Each hosting-service request costs 0.3–0.6 s,
 * and the PR Center asked for the same data again on every tab switch, remount and status
 * counter. Identical reads in flight always share one request; finished answers are reused
 * for `ttlMs`. Any PR write and an explicit refresh forget everything, so a refresh asks the
 * server again.
 */
type Entry = { at: number; pending: boolean; value: Promise<unknown> };

const entries = new Map<string, Entry>();
const LIMIT = 300;

export function cachedPrRead<T>(key: unknown[], ttlMs: number, read: () => Promise<T>): Promise<T> {
  const id = JSON.stringify(key);
  const now = Date.now();
  const old = entries.get(id);
  if (old && (old.pending || now - old.at < ttlMs)) return old.value as Promise<T>;
  const value = read();
  const entry: Entry = { at: now, pending: true, value };
  entries.set(id, entry);
  value.then(() => { entry.pending = false; entry.at = Date.now(); }, () => { if (entries.get(id) === entry) entries.delete(id); });
  if (entries.size > LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  return value;
}

/** Forget remembered PR reads (after a write, an account change or an explicit refresh). */
export function forgetPrReads() {
  entries.clear();
}

/** Reuse windows. Files of one PR revision never change; CI and discussions do. */
export const PR_READ_TTL = { inFlight: 0, changing: 15_000, discussions: 30_000, pinned: 5 * 60_000 } as const;
