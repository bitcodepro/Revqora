import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeInfo, PrAttention, PullRequest } from "./types";

const api = vi.hoisted(() => ({ forgeKind: vi.fn(), prPage: vi.fn(), prAttention: vi.fn() }));
vi.mock("./api", () => ({ api, errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
const { buildQueue, keepSnapshot, queueKey, queuePage, resumeSnapshot, QUEUE_PAGE } = await import("./prQueue");
const { attentionRows } = await import("./prAttention");

const forge = (project: string) => ({ kind: "github", api: "https://api.github.com", project, connectionRevision: `conn-${project}`, accountLogin: "alice" } as ForgeInfo);
const viewer = { id: "1", login: "alice" };
const pull = (number: number, change: Partial<PullRequest> = {}): PullRequest => ({
  number, title: `PR ${number}`, author: "bob", authorId: "2", authorLogin: "bob", head: `t${number}`, base: "main", url: `https://example.test/${number}`,
  draft: false, state: "open", created: new Date(Date.UTC(2026, 10, 1, 0, number)).toISOString(), headSha: `sha${number}`, ...change,
});
const mine = (number: number) => pull(number, { author: "alice", authorId: "1", authorLogin: "alice" });
const attention = (number: number, change: Partial<PrAttention>): PrAttention =>
  ({ number, revision: "r", headSha: `sha${number}`, checkedAt: 5, ci: "passed", failedChecks: [], merge: "blocked", blockers: ["x"], ...change });

beforeEach(() => {
  vi.resetAllMocks();
  api.forgeKind.mockResolvedValue("github");
});

describe("MCP pull request queue", () => {
  it("returns the PR Center's rows with per-repository status, errors and check times", async () => {
    api.prPage.mockImplementation(async (root: string) => {
      if (root === "/broken") throw new Error("HTTP 401: sign in again");
      return { forge: forge(root.slice(1)), viewer, nextCursor: null, items: [mine(1), pull(2, { reviewers: [{ id: "1", login: "alice", name: "Alice", state: "requested" }] }), pull(3)] };
    });
    api.prAttention.mockImplementation(async (root: string, number: number) => {
      if (root === "/flaky") throw new Error("HTTP 502");
      return attention(number, { ci: "failed", failedChecks: ["build"] });
    });
    const queue = await buildQueue(["/ok", "/flaky", "/broken"], "any", 5_000, () => 42);
    expect(queue.items.map(i => [i.repository, i.number, i.reasons.map(r => r.kind)])).toEqual([
      ["/flaky", 2, ["review"]], ["/ok", 2, ["review"]], ["/flaky", 1, ["check"]], ["/ok", 1, ["ci"]],
    ]);
    expect(queue.items.find(i => i.repository === "/ok" && i.number === 1)?.checkedAt).toBe(5);
    expect(queue.items.find(i => i.repository === "/flaky" && i.number === 1)?.reasons[0].text).toBe("CI and merge status unavailable: HTTP 502");
    expect(queue.repositories.map(r => [r.repository, r.status, r.error])).toEqual([
      ["/ok", "complete", null], ["/flaky", "complete", null], ["/broken", "failed", "HTTP 401: sign in again"],
    ]);
    // Only your own requests are read from the provider, never other people's.
    expect(api.prAttention.mock.calls.map(([root, number, connection]) => [root, number, connection]).sort()).toEqual([["/flaky", 1, "conn-flaky"], ["/ok", 1, "conn-ok"]]);
  });

  it("matches the PR Center's queue for the same groups", async () => {
    api.prPage.mockResolvedValue({ forge: forge("ok"), viewer, nextCursor: null, items: [mine(1), mine(2)] });
    api.prAttention.mockImplementation(async (_root: string, number: number) => attention(number, number === 2 ? { merge: "ready", blockers: [] } : {}));
    const queue = await buildQueue(["/ok"], "merge");
    const center = attentionRows({ "/ok": { forge: forge("ok"), author: { key: "id:1", label: "alice", login: "alice" }, items: [mine(1), mine(2)],
      attention: { 1: { value: attention(1, {}) }, 2: { value: attention(2, { merge: "ready", blockers: [] }) } } } }, "merge");
    expect(queue.items.map(i => [i.repository, i.number, i.reasons])).toEqual(center.map(r => [r.root, r.pull.number, r.reasons]));
  });

  it("reports a repository whose account is unknown instead of calling it complete", async () => {
    api.prPage.mockResolvedValue({ forge: forge("anon"), viewer: null, nextCursor: null, items: [pull(1), pull(2)] });
    const queue = await buildQueue(["/anon"], "any");
    expect(queue.items).toEqual([]);
    expect(queue.repositories.map(r => [r.repository, r.status, !!r.error])).toEqual([["/anon", "needs_identity", true]]);
    expect(api.prAttention).not.toHaveBeenCalled();
  });

  it("reports a provider that does not answer in time instead of an empty queue", async () => {
    api.prPage.mockImplementation((root: string) => root === "/slow" ? new Promise(() => {}) : Promise.resolve({ forge: forge("ok"), viewer, nextCursor: null, items: [mine(1)] }));
    api.prAttention.mockReturnValue(new Promise(() => {}));
    const queue = await buildQueue(["/ok", "/slow"], "check", 50);
    expect(queue.items.map(i => [i.repository, i.reasons[0].text])).toEqual([["/ok", "CI and merge status unavailable: Did not answer in time."]]);
    expect(queue.repositories.find(r => r.repository === "/slow")).toMatchObject({ status: "incomplete", error: "Did not answer in time." });
  });

  it("pages from one snapshot and rejects a cursor for another query", () => {
    const items = Array.from({ length: QUEUE_PAGE + 5 }, (_, n) => ({ repository: "/ok", number: n + 1 })) as never[];
    const key = queueKey(["/ok"], "any");
    const snapshot = keepSnapshot({ created: Date.now(), filter: "any", items, repositories: [] }, key);
    const first = queuePage(snapshot);
    expect(first.items).toHaveLength(QUEUE_PAGE);
    expect(first.total).toBe(QUEUE_PAGE + 5);
    const resumed = resumeSnapshot(first.nextCursor!, key)!;
    expect(queuePage(resumed.snapshot, resumed.offset)).toMatchObject({ nextCursor: null, total: QUEUE_PAGE + 5 });
    expect(queuePage(resumed.snapshot, resumed.offset).items).toHaveLength(5);
    expect(resumeSnapshot(first.nextCursor!, queueKey(["/ok"], "ci"))).toBeNull();
    expect(resumeSnapshot(first.nextCursor!, key, Date.now() + 11 * 60_000)).toBeNull();
    expect(resumeSnapshot("not json", key)).toBeNull();
  });
});
