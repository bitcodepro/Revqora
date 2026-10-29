import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoTab } from "./store";
vi.mock("./api", () => ({ api: { validationReport: vi.fn(async () => null) }, errorMessage: (e: unknown) => String(e), newOpId: () => "workspace-test" }));
vi.mock("./store", async () => {
  const { create } = await import("zustand");
  return { useRepos: create<{ order: string[]; tabs: Record<string, RepoTab>; active: string | null; open: (r: string) => Promise<string>; close: (r: string) => void; arrange: (r: string[], a: string | null) => void; patch: (r: string, p: Partial<RepoTab>) => void }>((set, get) => ({ order: [], tabs: {}, active: null,
    open: async (r) => { if (r === "/missing") throw new Error("Missing folder"); const s = get(); set({ order: [...new Set([...s.order, r])], tabs: { ...s.tabs, [r]: s.tabs[r] ?? { root: r, view: "history", pendingMutations: 0 } as RepoTab } }); return r; },
    close: (r) => { const tabs = { ...get().tabs }; delete tabs[r]; set({ tabs, order: get().order.filter((p) => p !== r) }); },
    arrange: (r, a) => set({ order: r, active: a }), patch: (r, p) => set({ tabs: { ...get().tabs, [r]: { ...get().tabs[r], ...p } } }),
  })) };
});
import { api } from "./api";
import { useRepos } from "./store";
import { useSettings } from "./settings";
import { useLibrary, restoreLibrary } from "./repositoryLibrary";
import { useUi } from "./ui";
import { finishWorkspaceStartup, startWorkspaceTracking, switchWorkspace, workspaceSnapshot } from "./repositoryWorkspaces";

beforeEach(async () => {
  useRepos.setState({ order: [], tabs: {}, active: null }); useUi.setState({ busy: [], repositoryOperations: [] }); useLibrary.setState(restoreLibrary({}));
  vi.mocked(api.validationReport).mockResolvedValue(null);
  await useRepos.getState().open("/original"); useRepos.setState({ active: "/original" }); finishWorkspaceStartup();
});
describe("workspace transitions", () => {
  it("restores views and layouts without any branch checkout API", async () => {
    const id = useLibrary.getState().save("Target", { ...workspaceSnapshot(), roots: ["/target"], activeRoot: "/target", views: { "/target": "changes" }, historyMode: "columns" });
    useLibrary.getState().select(null);
    await switchWorkspace(id);
    expect(useRepos.getState().order).toEqual(["/target"]); expect(useRepos.getState().tabs["/target"].view).toBe("changes"); expect(useSettings.getState().historyMode).toBe("columns");
  });
  it("preserves the original session and named snapshot when any folder is missing", async () => {
    const id = useLibrary.getState().save("Missing", { ...workspaceSnapshot(), roots: ["/target", "/missing"] });
    useLibrary.getState().select(null);
    const stop = startWorkspaceTracking();
    expect(await switchWorkspace(id)).toHaveLength(1);
    expect(useRepos.getState().order).toEqual(["/original", "/target"]);
    expect(useLibrary.getState().workspaces[0].roots).toEqual(["/target", "/missing"]); expect(useLibrary.getState().activeWorkspaceId).toBeNull(); stop();
  });
  it("adds repositories without replacing layout and automatically saves the active workspace", async () => {
    const first = useLibrary.getState().save("First", workspaceSnapshot());
    const second = useLibrary.getState().save("Second", { ...workspaceSnapshot(), roots: ["/second"], historyMode: "review" });
    useLibrary.getState().select(first); useSettings.getState().set({ historyMode: "columns" });
    const stop = startWorkspaceTracking(); await switchWorkspace(second, true);
    expect(useLibrary.getState().activeWorkspaceId).toBe(first); expect(useLibrary.getState().workspaces.find((w) => w.id === first)?.roots).toEqual(["/original", "/second"]); expect(useSettings.getState().historyMode).toBe("columns"); stop();
  });
  it("blocks replace during validation and prevents concurrent switches", async () => {
    const id = useLibrary.getState().save("Target", { ...workspaceSnapshot(), roots: ["/target"] });
    vi.mocked(api.validationReport).mockResolvedValue({ phase: "running" } as never);
    const first = switchWorkspace(id); await expect(switchWorkspace(id)).rejects.toThrow("Wait"); await expect(first).rejects.toThrow("validation");
    expect(useRepos.getState().order).toEqual(["/original"]); expect(useLibrary.getState().activeWorkspaceId).toBe(id);
  });
});
