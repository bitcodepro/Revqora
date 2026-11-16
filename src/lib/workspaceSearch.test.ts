import { describe, expect, it } from "vitest";
import type { CommitSearchHit, CommitSearchPage } from "./types";
import { loadRepositoryMatches, mergeHits, prioritizeRoots, searchRepositories, type RepositorySearchResult } from "./workspaceSearch";

const hit = (oid: string, authorTime: number): CommitSearchHit => ({ oid, subject: oid, author: "A", authorTime, refs: "" });
const page = (commits: CommitSearchHit[], nextCursor: string | null = null): CommitSearchPage =>
  ({ commits, nextCursor, hasMore: nextCursor !== null, diagnostics: { queueMs: 0, gitMs: 0, refsMs: 0, logMs: 0, cacheHit: false } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("workspace commit search", () => {
  it("searches the active repository first and keeps the others in order", () => {
    expect(prioritizeRoots(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(prioritizeRoots(["a", "b"], null)).toEqual(["a", "b"]);
    expect(prioritizeRoots(["a", "b"], "gone")).toEqual(["a", "b"]);
  });

  it("merges pages newest first without duplicates", () => {
    const merged = mergeHits([hit("x", 5), hit("y", 3)], [hit("y", 3), hit("z", 4), hit("w", 1)]);
    expect(merged.map((item) => item.oid)).toEqual(["x", "z", "y", "w"]);
  });

  it("follows cursors until a page of matches is loaded, then continues on demand", async () => {
    const calls: (string | null)[] = [];
    const pages: Record<string, CommitSearchPage> = {
      start: page(Array.from({ length: 20 }, (_, index) => hit(`a${index}`, 100 - index)), "c1"),
      c1: page(Array.from({ length: 20 }, (_, index) => hit(`b${index}`, 50 - index)), "c2"),
      c2: page([hit("last", 1)]),
    };
    const fetchPage = async (_root: string, cursor: string | null) => { calls.push(cursor); return pages[cursor ?? "start"]; };
    const published: number[] = [];
    const first = await loadRepositoryMatches("r", { hits: [], cursor: null }, fetchPage, () => true, (_root, result) => published.push(result.hits.length));
    expect(calls).toEqual([null, "c1"]);
    expect(published).toEqual([20, 40]);
    expect(first?.cursor).toBe("c2");
    const more = await loadRepositoryMatches("r", first!, fetchPage, () => true, () => undefined);
    expect(calls).toEqual([null, "c1", "c2"]);
    expect(more?.hits).toHaveLength(41);
    expect(more?.cursor).toBeNull();
  });

  it("reports a repository error without stopping the others", async () => {
    const results: Record<string, RepositorySearchResult> = {};
    await searchRepositories(["bad", "good"], async (root) => {
      if (root === "bad") throw new Error("not a repository");
      return page([hit("g", 1)]);
    }, () => true, (root, result) => { results[root] = result; });
    expect(results.bad.error).toBe("not a repository");
    expect(results.good.hits.map((item) => item.oid)).toEqual(["g"]);
  });

  it("limits concurrency and lets a replacement start without waiting for obsolete reads", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<CommitSearchPage>>>();
    let running = 0;
    let peak = 0;
    const fetchPage = (root: string) => {
      running++;
      peak = Math.max(peak, running);
      const wait = deferred<CommitSearchPage>();
      pending.set(root, wait);
      return wait.promise.finally(() => { running--; });
    };
    let generation = 1;
    const stale: string[] = [];
    const old = searchRepositories(["a", "b", "c", "d"], fetchPage, () => generation === 1, (root) => stale.push(root), 2);
    await Promise.resolve();
    expect([...pending.keys()]).toEqual(["a", "b"]);
    expect(peak).toBe(2);

    // The query changes while a and b are still running.
    generation = 2;
    const fresh: string[] = [];
    const replacement = searchRepositories(["c"], async (root) => page([hit(`${root}-new`, 1)]), () => generation === 2, (root) => fresh.push(root), 2);
    await replacement;
    expect(fresh).toEqual(["c"]);

    // Late answers of the obsolete search are discarded and start no further reads.
    pending.get("a")!.resolve(page([hit("a-old", 1)]));
    pending.get("b")!.resolve(page([hit("b-old", 1)]));
    await old;
    expect(stale).toEqual([]);
    expect([...pending.keys()]).toEqual(["a", "b"]);
  });
});
