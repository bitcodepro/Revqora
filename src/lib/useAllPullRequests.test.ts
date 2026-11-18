import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorOf } from "./prAuthors";
import type { ForgeInfo, PullRequest } from "./types";
import { mineOnly, pullRequestFreshness, readAttention, refreshingRows, scanPullRequests, seedGroups, type RepositoryRequests } from "./useAllPullRequests";

const api = vi.hoisted(() => ({ forgeKind: vi.fn(), prPage: vi.fn(), prAttention: vi.fn() }));
vi.mock("./api", () => ({ api, errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));

const forge = { kind: "github", api: "https://api.github.com", project: "team/repo", accountLogin: "alice" } as ForgeInfo;
const pull = (number: number, id: string, login: string) => ({ number, authorId: id, authorLogin: login, author: login } as PullRequest);
const mine = pull(1, "1", "alice"), theirs = pull(2, "2", "bob");
const group = (change: Partial<RepositoryRequests>): RepositoryRequests => ({ forge, scope: "scope", author: authorOf(mine), items: [mine, theirs], ...change });

describe("My PR across repositories", () => {
  it("keeps only the configured author's pull requests", () => {
    expect(mineOnly({ "/repo": group({}) })["/repo"].items).toEqual([mine]);
  });

  it("still filters the rows loaded before a later page failed and keeps the error", () => {
    const filtered = mineOnly({ "/repo": group({ notice: "Page 2 could not be loaded." }) })["/repo"];
    expect(filtered.items).toEqual([mine]);
    expect(filtered.notice).toBe("Page 2 could not be loaded.");
  });

  it("shows nothing for a repository without My PR author, even after a page error", () => {
    const unset = mineOnly({ "/repo": group({ author: null }) })["/repo"];
    expect(unset.items).toEqual([]);
    expect(unset.notice).toBe("Set My PR author in this repository to include its pull requests.");
    const failed = mineOnly({ "/repo": group({ author: null, notice: "Page 2 could not be loaded." }) })["/repo"];
    expect(failed.items).toEqual([]);
    expect(failed.notice).toBe("Page 2 could not be loaded. Set My PR author in this repository to include its pull requests.");
  });

  it("leaves a repository that failed before its first page unchanged", () => {
    const before = { forge: null, scope: "", author: null, items: [], notice: "Sign in again." };
    expect(mineOnly({ "/repo": before })["/repo"]).toBe(before);
  });
});

type Page = { forge: ForgeInfo; viewer: { id: string; login: string }; items: PullRequest[]; nextCursor: string | null };
const titled = (number: number, title = `PR ${number}`) => ({ ...pull(number, "1", "alice"), title } as PullRequest);
const page = (items: PullRequest[], nextCursor: string | null = null): Page => ({ forge, viewer: { id: "1", login: "alice" }, items, nextCursor });

/** Runs one scan over `roots` from `start`, applying every reported change like the hook does. */
async function scan(roots: string[], start: Record<string, RepositoryRequests> = {}, current = () => true, parallel?: number) {
  const groups: Record<string, RepositoryRequests> = { ...start };
  const snapshots: Record<string, RepositoryRequests>[] = [];
  const earlier = new Map(Object.entries(start).map(([root, group]) => [root, { scope: group.scope, items: group.items }]));
  await scanPullRequests(roots, "open", earlier, current, (root, change) => {
    groups[root] = change(groups[root] ?? { forge: null, scope: "", author: null, items: [] });
    snapshots.push(structuredClone(groups));
  }, parallel);
  return { groups, snapshots };
}

describe("refreshing pull requests across repositories", () => {
  beforeEach(() => {
    api.forgeKind.mockReset().mockResolvedValue("github");
    api.prPage.mockReset();
  });

  it("keeps earlier rows visible while pages arrive, then drops rows gone on the server", async () => {
    const loaded = (await (async () => {
      api.prPage.mockResolvedValueOnce(page([titled(3), titled(2)], "p2")).mockResolvedValueOnce(page([titled(1)]));
      return scan(["/repo"]);
    })()).groups;
    expect(loaded["/repo"].items.map(p => p.number)).toEqual([3, 2, 1]);
    const start = seedGroups(loaded, ["/repo"]);
    expect(start["/repo"]).toMatchObject({ loading: true, stale: true });

    // #3 changed, #1 was merged meanwhile, #4 is new.
    api.prPage.mockResolvedValueOnce(page([titled(4), titled(3, "PR 3 renamed")], "p2")).mockResolvedValueOnce(page([titled(2)]));
    const { groups, snapshots } = await scan(["/repo"], start);
    expect(snapshots[0]["/repo"].items.map(p => p.number)).toEqual([4, 3, 2, 1]);
    expect(snapshots[0]["/repo"].items[1].title).toBe("PR 3 renamed");
    expect(Math.min(...snapshots.map(groups => groups["/repo"].items.length))).toBeGreaterThanOrEqual(3);
    expect(groups["/repo"].items.map(p => p.number)).toEqual([4, 3, 2]);
    expect(groups["/repo"]).toMatchObject({ loading: false, stale: false });
    expect(groups["/repo"].loadedAt).toBeGreaterThan(0);
  });

  it("keeps a repository's earlier rows, marked stale, when its refresh fails, and clears the notice once it works", async () => {
    const start = seedGroups({ "/repo": { forge, scope: "github:1", author: null, items: [titled(1), titled(2)], loadedAt: 1000 } }, ["/repo"]);
    api.prPage.mockRejectedValueOnce(new Error("API rate limit reached."));
    const failed = (await scan(["/repo"], start)).groups["/repo"];
    expect(failed).toMatchObject({ notice: "API rate limit reached.", stale: true, loading: false, loadedAt: 1000 });
    expect(failed.items.map(p => p.number)).toEqual([1, 2]);
    expect(pullRequestFreshness({ "/repo": failed }, true)).toEqual({ refreshing: 0, loadedAt: 1000 });

    api.prPage.mockResolvedValueOnce(page([titled(2)]));
    const fixed = (await scan(["/repo"], seedGroups({ "/repo": failed }, ["/repo"]))).groups["/repo"];
    expect(fixed).toMatchObject({ notice: undefined, stale: false });
    expect(fixed.items.map(p => p.number)).toEqual([2]);
  });

  it("never brings back rows of another project or account on a later page, even after a page error", async () => {
    // The rows were read for another account; the refresh now reads as alice (viewer 1).
    const start = seedGroups({ "/repo": { forge, scope: "earlier account", author: null, items: [titled(7, "other 7"), titled(8, "other 8")] } }, ["/repo"]);
    for (const second of [() => Promise.resolve(page([titled(2)])), () => Promise.reject(new Error("Page 2 could not be loaded."))]) {
      api.prPage.mockReset().mockResolvedValueOnce(page([titled(1)], "p2")).mockImplementationOnce(second);
      const { groups, snapshots } = await scan(["/repo"], start);
      for (const shown of snapshots) expect(shown["/repo"].items.map(p => p.number)).not.toContain(7);
      expect(groups["/repo"].items.every(p => p.number < 7)).toBe(true);
      expect(groups["/repo"].scope).not.toBe("earlier account");
    }
  });

  it("applies nothing once the scan is no longer current (another status or a newer refresh)", async () => {
    let current = true;
    let answer!: (value: Page) => void;
    api.prPage.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    const running = scan(["/repo"], {}, () => current);
    await vi.waitFor(() => expect(api.prPage).toHaveBeenCalled());
    current = false;
    answer(page([titled(1)]));
    expect((await running).snapshots).toEqual([]);
  });

  it("a slow repository holds one reader, so the other repositories finish meanwhile", async () => {
    const order: string[] = [];
    api.prPage.mockImplementation(async (root: string) => {
      await new Promise(resolve => setTimeout(resolve, root === "/slow" ? 60 : 1));
      order.push(root);
      return page([titled(1)]);
    });
    await scan(["/slow", ...Array.from({ length: 10 }, (_, i) => `/fast-${i}`)], {}, () => true, 6);
    expect(order.at(-1)).toBe("/slow");
    expect(order).toHaveLength(11);
  });

  it("orders refreshed rows first and earlier rows not read yet after them", () => {
    expect(refreshingRows([titled(5), titled(3)], [titled(3, "old"), titled(2), titled(1)]).map(p => [p.number, p.title])).toEqual([[5, "PR 5"], [3, "PR 3"], [2, "PR 2"], [1, "PR 1"]]);
    expect(seedGroups(undefined, ["/repo"])).toEqual({});
    expect(seedGroups({ "/gone": group({}) }, ["/repo"])).toEqual({});
  });
});

describe("Attention reads", () => {
  const connected = { ...forge, connectionRevision: "conn" } as ForgeInfo;
  const own = (number: number) => ({ ...mine, number, headSha: `sha${number}`, state: "open", created: `2026-11-0${number}T00:00:00Z` } as PullRequest);
  it("keeps the earlier answer while reading again, and replaces it with an error instead of keeping it", async () => {
    let state: RepositoryRequests = group({ forge: connected, items: [own(1), own(2)], attention: { 1: { value: { headSha: "sha1", ci: "failed" } as never } } });
    const seen: RepositoryRequests[] = [];
    let release!: () => void;
    api.prAttention.mockImplementation((_root: string, number: number) => number === 1
      ? new Promise((_, reject) => { release = () => reject(new Error("HTTP 502")); })
      : Promise.resolve({ number, headSha: "sha2", ci: "passed" }));
    const done = readAttention("/repo", state, () => true, change => { state = change(state); seen.push(state); }, task => task());
    expect(seen[0].attention?.[1]).toMatchObject({ loading: true, value: { ci: "failed" } });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await done;
    expect(state.attention?.[1]).toEqual({ error: "HTTP 502" });
    expect(state.attention?.[2]?.value).toMatchObject({ ci: "passed" });
  });

  it("asks for an identity before reading anything", async () => {
    let state = group({ forge: connected, author: null });
    await readAttention("/repo", state, () => true, change => { state = change(state); });
    expect(state.attentionNotice).toMatch(/does not know your account/);
    expect(api.prAttention).not.toHaveBeenCalled();
  });
});
