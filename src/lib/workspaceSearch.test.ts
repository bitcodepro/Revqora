import { describe, expect, it } from "vitest";
import { relativeTime } from "./format";
import type { CommitSearchHit, CommitSearchPage } from "./types";
import { exclusiveLoads, loadRepositoryMatches, mergeHits, prioritizeRoots, searchHitText, searchRepositories, searchResultsText, type RepositorySearchResult } from "./workspaceSearch";

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

  it("refuses overlapping loads of one repository, so a late page cannot rewind newer matches", async () => {
    const thirty = Array.from({ length: 30 }, (_, index) => hit(`a${index}`, 1000 - index));
    const pending: Array<ReturnType<typeof deferred<CommitSearchPage>>> = [];
    const fetchPage = () => { const d = deferred<CommitSearchPage>(); pending.push(d); return d.promise; };
    let shown: RepositorySearchResult = { hits: thirty, cursor: "c1" };
    const publish = (_root: string, result: RepositorySearchResult) => { shown = result; };
    let changes = 0;
    const loads = exclusiveLoads(() => changes++);
    const first = loads.run("r", () => loadRepositoryMatches("r", shown, fetchPage, () => true, publish));
    expect(loads.busy("r")).toBe(true);
    expect(await loads.run("r", () => loadRepositoryMatches("r", shown, fetchPage, () => true, publish))).toBe(false);
    expect(pending).toHaveLength(1);
    pending[0].resolve(page(Array.from({ length: 30 }, (_, index) => hit(`b${index}`, 500 - index)), "c2"));
    expect(await first).toBe(true);
    expect(loads.busy("r")).toBe(false);
    expect(changes).toBe(2);
    expect(shown.hits).toHaveLength(60);
    expect(shown.cursor).toBe("c2");
    // The next "Show more" continues from the latest result.
    const second = loads.run("r", () => loadRepositoryMatches("r", shown, fetchPage, () => true, publish));
    pending[1].resolve(page(Array.from({ length: 30 }, (_, index) => hit(`c${index}`, 100 - index))));
    await second;
    expect(shown.hits).toHaveLength(90);
    expect(shown.cursor).toBeNull();
  });

  it("keeps the initial search and Show more of one repository from overlapping", async () => {
    const gate = deferred<CommitSearchPage>();
    const loads = exclusiveLoads();
    const search = searchRepositories(["r"], () => gate.promise, () => true, () => {}, 1, loads);
    await Promise.resolve();
    expect(loads.busy("r")).toBe(true);
    expect(await loads.run("r", async () => {})).toBe(false);
    gate.resolve(page([hit("x", 1)]));
    await search;
    expect(loads.busy("r")).toBe(false);
  });
});

describe("copied search results", () => {
  const now = 1_000_000;
  const match: CommitSearchHit = { oid: "a".repeat(40), subject: "Fix login", author: "Ann", authorTime: now - 7200, refs: "main" };
  const age = relativeTime(now - 7200, now);
  it("copies a match with its full hash, author, age and refs", () => {
    expect(searchHitText(match, now)).toBe(`Fix login\n${"a".repeat(40)} · Ann · ${age} · main`);
    expect(searchHitText({ ...match, subject: "", refs: "" }, now)).toBe(`(no commit message)\n${"a".repeat(40)} · Ann · ${age}`);
  });
  it("copies every repository name with its matches and errors", () => {
    expect(searchResultsText([{ name: "api", hits: [match] }, { name: "web", hits: [], error: "Search failed" }], now))
      .toBe(`api\n\n${searchHitText(match, now)}\n\n\nweb\n\nSearch failed`);
  });
});
