import { describe, expect, it, vi } from "vitest";

let running = 0;
let most = 0;
const started: string[] = [];
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: {
    fetch: async (root: string) => {
      started.push(root);
      running++;
      most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      return "";
    },
  },
}));
vi.mock("./repositoryTracking", () => ({
  scanRepositoryTracking: () => Promise.resolve(),
  trackingOf: () => undefined,
  useRepositoryTracking: { getState: () => ({ byKey: {} }) },
}));
vi.mock("./explorerBranchReads", () => ({ invalidateExplorerBranches: () => {} }));

describe("Fetch all", () => {
  it("works on eight repositories at once and reaches every one", async () => {
    const { syncRepositories, SYNC_PARALLEL } = await import("./remoteSync");
    const roots = Array.from({ length: 30 }, (_, i) => `/fleet/repo-${i}`);
    await syncRepositories("fetch", roots.map(root => ({ root })));
    expect(SYNC_PARALLEL).toBe(8);
    expect(most).toBe(8);
    expect(started).toEqual(roots);
  });
});
