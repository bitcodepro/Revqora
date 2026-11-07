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
import { editWorkspaceRepositories, finishWorkspaceStartup, startWorkspaceTracking, switchWorkspace, workspaceSnapshot, workspaceWithRepositories } from "./repositoryWorkspaces";

beforeEach(async () => {
  useRepos.setState({ order: [], tabs: {}, active: null }); useUi.setState({ busy: [], repositoryOperations: [] }); useLibrary.setState(restoreLibrary({}));
  vi.mocked(api.validationReport).mockResolvedValue(null);
  await useRepos.getState().open("/original"); useRepos.setState({ active: "/original" }); finishWorkspaceStartup();
});
describe("workspace transitions", () => {
  it("keeps saved order and selection when independent repository opens finish out of order", async () => {
    const id = useLibrary.getState().save("Parallel target", { ...workspaceSnapshot(), roots: ["/first", "/second"], activeRoot: "/second" });
    const original = useRepos.getState().open;
    let first!: () => void, second!: () => void;
    const a = new Promise<void>(resolve => { first = resolve; }), b = new Promise<void>(resolve => { second = resolve; });
    const mock = vi.spyOn(useRepos.getState(), "open").mockImplementation(async root => { await (root === "/first" ? a : b); return original(root, false); });
    try {
      const switching = switchWorkspace(id);
      await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
      second(); await vi.waitFor(() => expect(useRepos.getState().order).toContain("/second")); first();
      expect(await switching).toEqual([]);
      expect(useRepos.getState().order).toEqual(["/first", "/second"]);
      expect(useRepos.getState().active).toBe("/second");
    } finally { first(); second(); useRepos.setState({ open: original }); }
  });
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
  it("creates and edits an inactive workspace without changing the current session", async () => {
    const library = useLibrary.getState();
    library.remember("/original"); library.remember("/saved");
    const current = library.save("Current", workspaceSnapshot());
    const id = library.save("Selected repositories", workspaceWithRepositories(workspaceSnapshot(), ["/saved"]), false);
    expect(useLibrary.getState().activeWorkspaceId).toBe(current);
    expect(useLibrary.getState().workspaces.find((w) => w.id === id)).toMatchObject({ roots: ["/saved"], activeRoot: "/saved", views: {} });
    expect(await editWorkspaceRepositories(id, ["/original"])).toEqual([]);
    expect(useRepos.getState().order).toEqual(["/original"]);
    expect(useLibrary.getState().activeWorkspaceId).toBe(current);
    expect(useLibrary.getState().workspaces.find((w) => w.id === id)?.roots).toEqual(["/original"]);
    expect(useLibrary.getState().knownRoots).toEqual(["/original", "/saved"]);
  });
  it("applies active membership edits and preserves the library, other workspaces and layout", async () => {
    const library = useLibrary.getState();
    library.remember("/original"); library.remember("/saved");
    await useRepos.getState().open("/saved");
    useRepos.getState().patch("/saved", { view: "changes" });
    const current = library.save("Current", workspaceSnapshot());
    const other = library.save("Other", workspaceSnapshot(), false);
    const layouts = useSettings.getState().layouts;
    expect(await editWorkspaceRepositories(current, ["/saved"])).toEqual([]);
    expect(useRepos.getState().order).toEqual(["/saved"]);
    expect(useRepos.getState().active).toBe("/saved");
    expect(useRepos.getState().tabs["/saved"].view).toBe("changes");
    expect(useLibrary.getState().workspaces.find((w) => w.id === current)).toMatchObject({ roots: ["/saved"], layouts });
    expect(useLibrary.getState().workspaces.find((w) => w.id === other)?.roots).toEqual(["/original", "/saved"]);
    expect(useLibrary.getState().knownRoots).toEqual(["/original", "/saved"]);
  });
  it("keeps the saved membership and original tabs if an active edit cannot open a folder", async () => {
    const id = useLibrary.getState().save("Current", workspaceSnapshot());
    expect(await editWorkspaceRepositories(id, ["/missing"])).toHaveLength(1);
    expect(useRepos.getState().order).toEqual(["/original"]);
    expect(useLibrary.getState().workspaces.find((w) => w.id === id)?.roots).toEqual(["/original"]);
  });
  it("blocks replace during validation and prevents concurrent switches", async () => {
    const id = useLibrary.getState().save("Target", { ...workspaceSnapshot(), roots: ["/target"] });
    vi.mocked(api.validationReport).mockResolvedValue({ phase: "running" } as never);
    const first = switchWorkspace(id); await expect(switchWorkspace(id)).rejects.toThrow("Wait"); await expect(first).rejects.toThrow("validation");
    expect(useRepos.getState().order).toEqual(["/original"]); expect(useLibrary.getState().activeWorkspaceId).toBe(id);
  });
});
