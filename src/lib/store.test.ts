import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { status: vi.fn(), repoInfo: vi.fn(), layersState: vi.fn(), refs: vi.fn(), repoExtras: vi.fn(), squashMerged: vi.fn() }, errorMessage: String }));
vi.mock("./settings", () => ({ useSettings: { getState: () => ({ set: vi.fn() }) } }));
vi.mock("./repositoryLibrary", () => ({ useLibrary: { getState: () => ({ remember: vi.fn() }) } }));
vi.mock("./ui", () => ({ useUi: { setState: vi.fn() } }));
import { api } from "./api";
import { useRepos, type RepoTab } from "./store";
import { previewGeneration } from "./commitPreview";
import type { StatusSummary } from "./types";

const root = "/quiet-diff";
const snapshot = (token: string, version: number) => ({ stateToken: token, stateVersion: version, files: [{ path: "selected.txt", diffToken: "same-content", index: ".", worktree: "M" }] }) as StatusSummary;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.status).mockResolvedValue(snapshot("after-wal", 2));
  vi.mocked(api.repoInfo).mockResolvedValue(null as never);
  vi.mocked(api.layersState).mockResolvedValue(null as never);
  vi.mocked(api.repoExtras).mockResolvedValue(null as never);
  useRepos.setState({ order: [root], active: root, tabs: { [root]: { root, status: snapshot("before-wal", 1), graph: {}, graphHasWorktree: true, diffRefreshVersion: 0 } as RepoTab } });
});
describe("background repository observation", () => {
  it("updates the full mutation guard without invalidating previews for ordinary worktree activity", async () => {
    const generation = previewGeneration(root);
    await useRepos.getState().refresh(root, { background: true, status: true, layers: true });
    const tab = useRepos.getState().tabs[root];
    expect(tab.status?.stateToken).toBe("after-wal");
    expect(tab.status?.files[0].diffToken).toBe("same-content");
    expect(previewGeneration(root)).toBe(generation);
    expect(tab.diffRefreshVersion).toBe(0);
  });
  it("keeps an explicit refresh effective even if the file token did not change", async () => {
    const generation = previewGeneration(root);
    await useRepos.getState().refresh(root, { status: true, layers: true });
    expect(previewGeneration(root)).toBe(generation + 1);
    expect(useRepos.getState().tabs[root].diffRefreshVersion).toBe(1);
  });
  it("still invalidates immutable previews for a metadata/attributes notification", async () => {
    const generation = previewGeneration(root);
    await useRepos.getState().refresh(root, { background: true, info: true, status: true });
    expect(previewGeneration(root)).toBe(generation + 1);
  });
  it("does not let an older observation replace a newer mutation precondition", async () => {
    useRepos.getState().patch(root, { status: snapshot("newer", 3) });
    await useRepos.getState().refresh(root, { background: true, status: true });
    expect(useRepos.getState().tabs[root].status?.stateToken).toBe("newer");
  });
});
