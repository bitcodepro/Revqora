import { describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { refs: vi.fn() }, errorMessage: (error: unknown) => String(error) }));
vi.mock("./store", () => ({ useRepos: { getState: () => ({ tabs: {} }) } }));
import { api } from "./api";
import { invalidateExplorerBranches, readClosedBranches } from "./explorerBranchReads";
import type { RefsSnapshot } from "./types";

describe("Explorer branch reads of closed repositories", () => {
  it("reuses the first read and reads again only after the repository changed", async () => {
    const refs = vi.mocked(api.refs);
    refs.mockResolvedValue({ local: [] } as unknown as RefsSnapshot);
    await readClosedBranches("C:/never-synced");
    await readClosedBranches("C:/never-synced");
    expect(refs).toHaveBeenCalledTimes(1);
    invalidateExplorerBranches(["C:/never-synced"]);
    await readClosedBranches("C:/never-synced");
    await readClosedBranches("C:/never-synced");
    expect(refs).toHaveBeenCalledTimes(2);
  });
});
