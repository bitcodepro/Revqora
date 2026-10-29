import { beforeEach, describe, expect, it } from "vitest";
import { repositoryKey, restoreLibrary, uniqueRoots, useLibrary } from "./repositoryLibrary";
import { restoreWorkspaceLayouts } from "./workspaceLayouts";

beforeEach(() => useLibrary.setState(restoreLibrary({})));
describe("portable repository library", () => {
  it("deduplicates Windows paths without collapsing distinct Unix repositories", () => {
    expect(repositoryKey("E:\\Code\\Repo\\")).toBe(repositoryKey("e:/code/repo"));
    expect(uniqueRoots(["E:\\Code\\Repo", "e:/code/repo/", "/Code", "/code", "relative", "x\0y", null])).toEqual(["E:\\Code\\Repo", "/Code", "/code"]);
  });
  it("sanitizes corrupted profiles and keeps membership disjoint", () => {
    const lib = restoreLibrary({ groups: [{ id: "g1", name: "One", roots: ["/one"] }, { id: "g2", name: "Two", roots: ["/one", "/two"] }], favorites: ["/one", "relative"], workspaces: [{ id: "w", name: "Work", roots: ["/two"], activeRoot: "/missing", layouts: { graph: { sidebarWidth: -2 } }, views: { "/two": "garbage" } }], activeWorkspaceId: "missing", remember: "bad" });
    expect(lib.groups[1].roots).toEqual(["/two"]); expect(lib.activeWorkspaceId).toBeNull();
    expect(lib.workspaces[0].activeRoot).toBe("/two"); expect(lib.workspaces[0].views).toEqual({});
    expect(lib.workspaces[0].layouts.graph.sidebarWidth).toBeGreaterThan(0);
    expect(lib.knownRoots).toEqual(["/one", "/two"]);
  });
  it("moves repositories between groups and retains closed bookmarks after group deletion", () => {
    const s = useLibrary.getState(), a = s.group("Product"), b = s.group("Tools");
    s.move("/repo", a); s.move("/repo", b); s.favorite("/repo"); s.collapse(b); s.removeGroup(b);
    expect(useLibrary.getState().groups[0].roots).toEqual([]);
    expect(useLibrary.getState().knownRoots).toContain("/repo"); expect(useLibrary.getState().favorites).toContain("/repo");
    expect(() => s.group(" product ")).toThrow("already in use");
  });
  it("relinks a moved or aliased folder across groups, favorites and workspace views", () => {
    const s = useLibrary.getState(), g = s.group("Project");
    s.move("E:/OLD", g); s.favorite("E:/OLD");
    s.save("Work", { roots: ["E:/OLD"], activeRoot: "E:/OLD", views: { "E:/OLD": "changes" }, layouts: restoreWorkspaceLayouts(), historyMode: "columns" });
    s.remember("E:\\actual", "e:/old");
    const lib = useLibrary.getState(); expect(lib.favorites).toEqual(["E:\\actual"]); expect(lib.groups[0].roots).toEqual(["E:\\actual"]);
    expect(lib.workspaces[0]).toMatchObject({ roots: ["E:\\actual"], activeRoot: "E:\\actual", views: { "E:\\actual": "changes" } });
  });
});
