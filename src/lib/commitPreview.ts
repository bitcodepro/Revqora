import { api } from "./api";
import type { CommitDetails, DiffOptions, FileDiff } from "./types";
import { detailsBytes, diffBytes } from "./sizeEstimate";

/** Small in-memory LRU. Huge responses and failures are never retained. */
export class PreviewCache<T> {
  private entries = new Map<string, { value: T; weight: number }>();
  private pending = new Map<string, Promise<T>>();
  private weight = 0;
  /** `weigh` estimates the memory an answer holds without copying it. */
  constructor(private count = 48, private budget = 8 * 1024 * 1024, private entryLimit = 2 * 1024 * 1024, private weigh: (value: T) => number = (value) => 2 * JSON.stringify(value).length) {}
  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  invalidate(matches: (key: string) => boolean) {
    for (const [key, entry] of this.entries) if (matches(key)) { this.weight -= entry.weight; this.entries.delete(key); }
    for (const key of this.pending.keys()) if (matches(key)) this.pending.delete(key);
  }
  load(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.peek(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const promise: Promise<T> = Promise.resolve().then(loader).then((value) => {
      try {
        if (this.pending.get(key) !== promise) return value;
        const weight = this.weigh(value) + 2 * key.length;
        if (weight <= Math.min(this.entryLimit, this.budget)) {
          this.entries.set(key, { value, weight }); this.weight += weight;
          while (this.entries.size > this.count || this.weight > this.budget) {
            const oldest = this.entries.keys().next().value!;
            this.weight -= this.entries.get(oldest)!.weight; this.entries.delete(oldest);
          }
        }
      } catch { /* A cache must not turn a successful Git read into an error. */ }
      return value;
    });
    this.pending.set(key, promise);
    const done = () => { if (this.pending.get(key) === promise) this.pending.delete(key); };
    void promise.then(done, done);
    return promise;
  }
}

// Invalidation is observable independently of repository/ref state. A refresh
// must restart a mounted preview even when the selected immutable OID is unchanged.
const generations = new Map<string, number>();
const subscribers = new Map<string, Set<() => void>>();
export const previewGeneration = (root: string) => generations.get(root) ?? 0;
export function subscribePreview(root: string, listener: () => void) {
  let listeners = subscribers.get(root);
  if (!listeners) { listeners = new Set(); subscribers.set(root, listeners); }
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(root); };
}

const details = new PreviewCache<CommitDetails>(48, 8 * 1024 * 1024, 2 * 1024 * 1024, detailsBytes);
const diffs = new PreviewCache<FileDiff>(64, 16 * 1024 * 1024, 2 * 1024 * 1024, diffBytes);
const immutable = (oid: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid);
export const detailsKey = (root: string, oid: string, remoteRefs: string) => JSON.stringify([root, oid, remoteRefs]);
export const diffKey = (root: string, from: string | null, oid: string, path: string, opts: DiffOptions) => JSON.stringify([root, from, oid, path, opts]);
export const peekDetails = (key: string, oid: string) => immutable(oid) ? details.peek(key) : undefined;
// The preview opens with the header and file list. Remote containment walks history
// from every remote tip, so it is a separate read with its own unknown state.
export const loadDetails = (key: string, root: string, oid: string) => immutable(oid) ? details.load(key, () => api.commitDetails(root, oid, undefined, true)) : api.commitDetails(root, oid, undefined, true);
const containment = new PreviewCache<boolean>(256, 1024 * 1024, 2 * 1024 * 1024, () => 16);
/** Keyed by the remote-ref snapshot: a fetch or push changes the answer. */
export const containmentKey = (root: string, oid: string, remoteRefs: string) => JSON.stringify([root, oid, remoteRefs]);
/** undefined = unknown: not asked yet, or invalidated since. */
export const peekContainment = (key: string) => containment.peek(key);
export const loadContainment = (key: string, root: string, oid: string) => containment.load(key, () => api.commitRemoteContainment(root, oid));
export const peekDiff = (key: string, oid: string) => immutable(oid) ? diffs.peek(key) : undefined;
export const loadDiff = (key: string, root: string, from: string | null, oid: string, path: string, opts: DiffOptions) => immutable(oid) ? diffs.load(key, () => api.revDiff(root, from, oid, path, opts, true)) : api.revDiff(root, from, oid, path, opts, true);

/** Attributes/config may change the interpretation of immutable trees. */
export function invalidatePreview(root: string) {
  // Every key is a JSON array that starts with the root.
  const prefix = `${JSON.stringify([root]).slice(0, -1)},`;
  const matches = (key: string) => key.startsWith(prefix);
  details.invalidate(matches); diffs.invalidate(matches); containment.invalidate(matches);
  generations.set(root, previewGeneration(root) + 1);
  for (const listener of subscribers.get(root) ?? []) listener();
}
