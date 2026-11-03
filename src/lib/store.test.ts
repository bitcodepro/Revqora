import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { status: vi.fn(), repoInfo: vi.fn(), layersState: vi.fn(), refs: vi.fn(), repoExtras: vi.fn(), squashMerged: vi.fn() }, errorMessage: String }));
vi.mock("./settings", () => ({ useSettings: { getState: () => ({ set: vi.fn() }) } }));
vi.mock("./repositoryLibrary", () => ({ useLibrary: { getState: () => ({ remember: vi.fn() }) } }));
vi.mock("./ui", () => ({ useUi: { setState: vi.fn() } }));
import { api } from "./api";
import { useRepos, type RepoTab } from "./store";
import { previewGeneration } from "./commitPreview";
import { repositoryCall, type Invoke } from "./operationClient";
import type { RepoInfo, StatusSummary } from "./types";

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
  it("invalidates mounted immutable interpretations when indexed Git attributes change", async () => {
    const before = { ...snapshot("before", 3), diffContextToken: "attributes-one" };
    const after = { ...snapshot("after", 4), diffContextToken: "attributes-two" };
    useRepos.getState().patch(root, { status: before });
    const generation = previewGeneration(root);
    vi.mocked(api.status).mockResolvedValue(after);
    await useRepos.getState().refresh(root, { background: true, status: true, layers: true });
    expect(previewGeneration(root)).toBe(generation + 1);
    expect(useRepos.getState().tabs[root].diffRefreshVersion).toBe(0);
  });
  it("rejects an old attribute context without invalidating the newer mounted preview", async () => {
    useRepos.getState().patch(root, { status: { ...snapshot("newer", 5), diffContextToken: "new-context" } });
    const generation = previewGeneration(root);
    vi.mocked(api.status).mockResolvedValue({ ...snapshot("older", 4), diffContextToken: "old-context" });
    await useRepos.getState().refresh(root, { background: true, status: true });
    expect(previewGeneration(root)).toBe(generation);
    expect(useRepos.getState().tabs[root].status?.diffContextToken).toBe("new-context");
  });
  it("does not commit using a fresh status while the displayed branch information is still old", async () => {
    const oid = "a".repeat(40);
    const info = (branch: string) => ({ head: { branch, oid } } as RepoInfo);
    const status = { ...snapshot("topic-state", 5), branch: "topic", oid };
    useRepos.getState().patch(root, { status, info: info("main"), pendingMutations: 0 });
    const calls: string[] = [];
    const invoke: Invoke = async <T>(command: string) => {
      calls.push(command);
      if (command === "status") return status as T;
      if (command === "repo_info") return info("topic") as T;
      return "committed" as T;
    };
    await expect(repositoryCall(invoke, "commit", { repo: root, message: "Keep branch review coherent" })).rejects.toMatchObject({ kind: "stale-operation" });
    expect(calls).not.toContain("commit");
    expect(useRepos.getState().tabs[root].info?.head.branch).toBe("topic");
    await expect(repositoryCall(invoke, "commit", { repo: root, message: "Reviewed topic" })).resolves.toBe("committed");
    expect(calls.filter(c => c === "commit")).toHaveLength(1);
  });
});
