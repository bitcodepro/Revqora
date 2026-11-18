import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchTracking } from "./types";

const mocks = vi.hoisted(() => ({ repositoryBranchTracking: vi.fn(), repositoryChangeCount: vi.fn() }));
vi.mock("./api", () => ({ api: mocks, errorMessage: String }));
vi.mock("./store", () => ({
  repositorySidebarStatus: () => null,
  useRepos: { getState: () => ({ order: [], tabs: {} }), subscribe: () => () => {} },
}));
vi.mock("./repositoryLibrary", async original => ({
  ...await original<typeof import("./repositoryLibrary")>(),
  useLibrary: { getState: () => ({ knownRoots: [] }), subscribe: () => () => {} },
}));

const { changesOf, scanRepositoryChanges, scanRepositoryTracking, trackingOf, useRepositoryTracking } = await import("./repositoryTracking");

const tracking = (change: Partial<BranchTracking> = {}): BranchTracking =>
  ({ branch: "main", oid: "a", upstream: "origin/main", ahead: 0, behind: 0, unpublished: null, ...change });

describe("repository tracking", () => {
  beforeEach(() => {
    mocks.repositoryBranchTracking.mockReset();
    mocks.repositoryChangeCount.mockReset();
    useRepositoryTracking.setState({ byKey: {}, changes: {} });
  });

  it("checks every repository of the library, several at a time", async () => {
    let running = 0, peak = 0;
    mocks.repositoryBranchTracking.mockImplementation(async (root: string) => {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      return tracking({ ahead: root.endsWith("7") ? 2 : 0 });
    });
    const roots = Array.from({ length: 40 }, (_, i) => `C:/work/repo-${i}`);
    await scanRepositoryTracking(roots);
    expect(mocks.repositoryBranchTracking).toHaveBeenCalledTimes(40);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    const byKey = useRepositoryTracking.getState().byKey;
    expect(roots.filter(root => (trackingOf(byKey, root)?.ahead ?? 0) > 0)).toEqual(["C:/work/repo-7", "C:/work/repo-17", "C:/work/repo-27", "C:/work/repo-37"]);
  });

  it("reads one repository at a time, shares a waiting read and keeps the newest answer", async () => {
    const answers: ((value: BranchTracking) => void)[] = [];
    mocks.repositoryBranchTracking.mockImplementation(() => new Promise(resolve => answers.push(resolve)));
    const first = scanRepositoryTracking(["C:/work/one"]);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    // While the first read runs, two more requests become one read after it.
    const second = scanRepositoryTracking(["C:/work/one"]);
    const third = scanRepositoryTracking(["C:/work/one"]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(answers).toHaveLength(1);
    answers[0](tracking({ ahead: 1 }));
    await first;
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1](tracking({ ahead: 3 }));
    await Promise.all([second, third]);
    expect(mocks.repositoryBranchTracking).toHaveBeenCalledTimes(2);
    expect(trackingOf(useRepositoryTracking.getState().byKey, "C:/work/one")?.ahead).toBe(3);
  });

  it("reads every branch before any change count, so Incoming and Outgoing fill first", async () => {
    const order: string[] = [];
    mocks.repositoryBranchTracking.mockImplementation(async (root: string) => { order.push(`branch ${root}`); return tracking(); });
    mocks.repositoryChangeCount.mockImplementation(async (root: string) => { order.push(`changes ${root}`); return root.endsWith("3") ? 4 : 0; });
    const roots = Array.from({ length: 12 }, (_, i) => `C:/work/repo-${i}`);
    await Promise.all([scanRepositoryTracking(roots), scanRepositoryChanges(roots)]);
    const lastBranch = Math.max(...order.flatMap((entry, i) => entry.startsWith("branch") ? [i] : []));
    const firstChanges = order.findIndex(entry => entry.startsWith("changes"));
    expect(lastBranch).toBeLessThan(firstChanges + 6);
    const changes = useRepositoryTracking.getState().changes;
    expect(roots.filter(root => (changesOf(changes, root) ?? 0) > 0)).toEqual(["C:/work/repo-3"]);
  });

  it("drops the counts of a repository that can no longer be read", async () => {
    mocks.repositoryBranchTracking.mockResolvedValueOnce(tracking({ ahead: 1 })).mockRejectedValueOnce(new Error("not a repository"));
    await scanRepositoryTracking(["C:/work/moved"]);
    expect(trackingOf(useRepositoryTracking.getState().byKey, "C:/work/moved")).toBeDefined();
    await scanRepositoryTracking(["C:/work/moved"]);
    expect(trackingOf(useRepositoryTracking.getState().byKey, "C:/work/moved")).toBeUndefined();
  });
});
