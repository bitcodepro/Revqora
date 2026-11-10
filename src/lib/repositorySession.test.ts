import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const saved = vi.hoisted(() => ({ set: vi.fn(), addRecent: vi.fn(), remember: vi.fn() }));
vi.mock("./api", () => ({ api: Object.fromEntries(["repoOpen", "repoInfo", "status", "repositorySidebarStatus", "refs", "repoExtras", "layersState", "squashMerged", "graphLoad", "watchRepo", "unwatchRepo"].map(name => [name, vi.fn()])), errorMessage: String }));
vi.mock("./settings", () => ({ useSettings: { getState: () => saved } }));
vi.mock("./repositoryLibrary", async original => ({ ...await original<typeof import("./repositoryLibrary")>(), useLibrary: { getState: () => saved } }));
vi.mock("./ui", () => ({ useUi: { setState: vi.fn() } }));
import { api } from "./api";
import { useRepos } from "./store";
import { repositoryKey } from "./repositoryLibrary";
import type { RepoInfo, StatusSummary } from "./types";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const info = (root: string) => ({ root, name: root.split("/").at(-1), head: { branch: "main", oid: "a".repeat(40) }, state: { kind: "none" } }) as RepoInfo;
const status = { branch: "main", oid: "a".repeat(40), files: [], stateToken: "fresh", stateVersion: 1 } as unknown as StatusSummary;
beforeEach(() => {
  vi.resetAllMocks();
  useRepos.setState({ order: [], tabs: {}, active: null });
  vi.mocked(api.repoOpen).mockImplementation(async root => info(root));
  vi.mocked(api.repoInfo).mockImplementation(async root => info(root));
  vi.mocked(api.status).mockResolvedValue(status);
  vi.mocked(api.repositorySidebarStatus).mockResolvedValue({ ...status, stateToken: null });
  vi.mocked(api.refs).mockResolvedValue({ local: [], remote: [], remotes: [], tags: [], stashes: [] });
  vi.mocked(api.repoExtras).mockResolvedValue(null as never);
  vi.mocked(api.layersState).mockResolvedValue(null as never);
  vi.mocked(api.graphLoad).mockResolvedValue({ key: "graph", total: 0, maxLanes: 0, headIndex: 0 });
  vi.mocked(api.squashMerged).mockResolvedValue([]);
  vi.mocked(api.watchRepo).mockResolvedValue(undefined);
  vi.mocked(api.unwatchRepo).mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(useRepos.getState().order.map(root => useRepos.getState().refresh(root, { background: true, summary: true })));
  for (const root of [...useRepos.getState().order]) useRepos.getState().close(root);
});

describe("repository session restoration", () => {
  it("publishes all 40 repositories and the last selection before discovery, without persisting partial sessions", async () => {
    const roots = Array.from({ length: 40 }, (_, i) => `/session/repo-${i}`);
    const gate = deferred<void>();
    let running = 0, peak = 0;
    vi.mocked(api.repoOpen).mockImplementation(async root => { running++; peak = Math.max(peak, running); await gate.promise; running--; return info(root); });
    const restore = useRepos.getState().openMany(roots, roots[39]);
    expect(useRepos.getState().order).toEqual(roots);
    expect(Object.keys(useRepos.getState().tabs)).toHaveLength(40);
    expect(useRepos.getState().active).toBe(roots[39]);
    expect(api.repoOpen).toHaveBeenCalledTimes(4);
    expect(vi.mocked(api.repoOpen).mock.calls[0][0]).toBe(roots[39]);
    expect(saved.set.mock.calls.every(([value]) => value.activeTab === roots[39] && value.openTabs.length === 40)).toBe(true);
    gate.resolve();
    expect((await restore).every(result => result.status === "fulfilled")).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
    expect(saved.set.mock.calls.every(([value]) => value.activeTab === roots[39] && value.openTabs.length === 40)).toBe(true);
    // Inactive roots get fresh sidebar status, never 39 full histories / layer walks.
    for (const method of [api.graphLoad, api.repoExtras, api.layersState, api.squashMerged, api.refs]) {
      expect(vi.mocked(method).mock.calls.every(args => args[0] === roots[39])).toBe(true);
    }
    expect(saved.addRecent).not.toHaveBeenCalled();
    expect(vi.mocked(api.repositorySidebarStatus).mock.calls).toHaveLength(39);
    expect(useRepos.getState().tabs[roots[0]].status).toBeNull();
    expect(useRepos.getState().tabs[roots[0]].sidebarStatus?.stateToken).toBeNull();
  });

  it("does not let a slow/missing folder block other roots, erase it or reset a newer selection", async () => {
    const slow = deferred<RepoInfo>();
    vi.mocked(api.repoOpen).mockImplementation(root => root === "/slow" ? slow.promise : root === "/missing" ? Promise.reject(new Error("Folder moved")) : Promise.resolve(info(root)));
    const restore = useRepos.getState().openMany(["/slow", "/missing", "/ready", "/queued"], "/slow");
    await vi.waitFor(() => expect(useRepos.getState().tabs["/ready"].info).not.toBeNull());
    useRepos.getState().activate("/ready");
    slow.resolve(info("/slow"));
    const results = await restore;
    expect(results[1].status).toBe("rejected");
    expect(useRepos.getState().active).toBe("/ready");
    expect(useRepos.getState().order).toEqual(["/slow", "/missing", "/ready", "/queued"]);
    expect(useRepos.getState().tabs["/missing"]).toMatchObject({ opening: false, error: "Error: Folder moved" });
    vi.mocked(api.repoOpen).mockResolvedValue(info("/missing"));
    await useRepos.getState().open("/missing");
    expect(useRepos.getState().tabs["/missing"]).toMatchObject({ opening: false, error: null });
  });

  it("deduplicates Windows spelling and remaps canonical paths without moving the selection", async () => {
    const gate = deferred<RepoInfo>();
    vi.mocked(api.repoOpen).mockReturnValue(gate.promise);
    const first = useRepos.getState().open("E:\\Repo", false);
    const second = useRepos.getState().open("e:/repo/", true);
    expect(useRepos.getState().order).toEqual(["E:\\Repo"]);
    expect(api.repoOpen).toHaveBeenCalledTimes(1);
    gate.resolve(info("E:/canonical"));
    await Promise.all([first, second]);
    expect(useRepos.getState().order).toEqual(["E:/canonical"]);
    expect(repositoryKey(useRepos.getState().active!)).toBe("e:/canonical");
    expect(saved.remember).toHaveBeenCalledWith("E:/canonical", "E:\\Repo");
  });

  it("does not resurrect a closed discovery or publish its data into a reopened tab", async () => {
    const old = deferred<RepoInfo>();
    vi.mocked(api.repoOpen).mockImplementationOnce(() => old.promise);
    const first = useRepos.getState().open("/closed");
    useRepos.getState().close("/closed");
    const second = useRepos.getState().open("/closed");
    await second;
    const calls = vi.mocked(api.watchRepo).mock.calls.length;
    old.resolve({ ...info("/closed"), name: "old-discovery" });
    expect(await first).toBeNull();
    expect(useRepos.getState().tabs["/closed"].info?.name).toBe("closed");
    expect(api.watchRepo).toHaveBeenCalledTimes(calls);
  });

  it("loads an inactive history only on selection and keeps watcher refreshes lightweight", async () => {
    await useRepos.getState().openMany(["/selected", "/background"], "/selected");
    await useRepos.getState().refresh("/selected", { summary: true });
    vi.mocked(api.graphLoad).mockClear();
    vi.mocked(api.layersState).mockClear();
    await useRepos.getState().refresh("/background", { background: true, info: true, status: true, refs: true, layers: true, graph: true });
    expect(api.graphLoad).not.toHaveBeenCalled();
    expect(api.layersState).not.toHaveBeenCalled();
    useRepos.getState().activate("/background");
    await vi.waitFor(() => expect(api.graphLoad).toHaveBeenCalledWith("/background", "HEAD", false, 2000, true));
  });

  it("keeps lightweight observations out of mutation guards and reads full proofs for an explicit bulk preview", async () => {
    await useRepos.getState().openMany(["/guard-active", "/guard-background"], "/guard-active");
    const root = "/guard-background";
    expect(useRepos.getState().tabs[root].status).toBeNull();
    useRepos.getState().patch(root, { status: { ...status, stateToken: "full-proof", stateVersion: 4 } });
    vi.mocked(api.repositorySidebarStatus).mockResolvedValue({ ...status, stateToken: null, ahead: 3, stateVersion: 5 });
    await useRepos.getState().refresh(root, { background: true, status: true });
    expect(useRepos.getState().tabs[root].status?.stateToken).toBe("full-proof");
    expect(useRepos.getState().tabs[root].sidebarStatus?.ahead).toBe(3);
    vi.mocked(api.status).mockResolvedValue({ ...status, stateToken: "reviewed-proof", stateVersion: 6 });
    await useRepos.getState().refresh(root, { info: true, status: true, guard: true });
    expect(useRepos.getState().tabs[root].status?.stateToken).toBe("reviewed-proof");
    expect(useRepos.getState().tabs[root].sidebarStatus?.stateVersion).toBe(6);
  });

  it("loads details when opening a group selects an already discovered inactive repository", async () => {
    await useRepos.getState().openMany(["/group-current", "/group-selected"], "/group-current");
    expect(useRepos.getState().tabs["/group-selected"].graph).toBeNull();
    await useRepos.getState().openMany(["/group-selected"], "/group-selected");
    await vi.waitFor(() => expect(useRepos.getState().tabs["/group-selected"].graph).not.toBeNull());
    expect(useRepos.getState().active).toBe("/group-selected");
  });
});
