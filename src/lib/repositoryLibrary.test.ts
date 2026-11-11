import { beforeEach, describe, expect, it } from "vitest";
import { groupRepositoryRoots, groupsInWorkspace, planFolderWorkspaces, repositoryKey, restoreLibrary, uniqueRoots, useLibrary } from "./repositoryLibrary";
import { restoreWorkspaceLayouts } from "./workspaceLayouts";

beforeEach(() => useLibrary.setState(restoreLibrary({})));
describe("portable repository library", () => {
  it("deduplicates Windows paths without collapsing distinct Unix repositories", () => {
    expect(repositoryKey("E:\\Code\\Repo\\")).toBe(repositoryKey("e:/code/repo"));
    expect(uniqueRoots(["E:\\Code\\Repo", "e:/code/repo/", "/Code", "/code", "relative", "x\0y", null])).toEqual(["E:\\Code\\Repo", "/Code", "/code"]);
  });
  it("sanitizes corrupted profiles and keeps memberships in distinct groups", () => {
    const lib = restoreLibrary({ groups: [{ id: "g1", name: "One", roots: ["/one"] }, { id: "g2", name: "Two", roots: ["/one", "/two"] }], favorites: ["/one", "relative"], workspaces: [{ id: "w", name: "Work", roots: ["/two"], activeRoot: "/missing", layouts: { graph: { sidebarWidth: -2 } }, views: { "/two": "garbage" } }], activeWorkspaceId: "missing", remember: "bad" });
    expect(lib.groups[1].roots).toEqual(["/one", "/two"]); expect(lib.activeWorkspaceId).toBeNull();
    expect(lib.workspaces[0].activeRoot).toBe("/two"); expect(lib.workspaces[0].views).toEqual({});
    expect(lib.workspaces[0].layouts.graph.sidebarWidth).toBeGreaterThan(0);
    expect(lib.knownRoots).toEqual(["/one", "/two"]);
  });
  it("moves repositories between groups and retains closed bookmarks after group deletion", () => {
    const s = useLibrary.getState(), a = s.group("Product"), b = s.group("Tools");
    s.move("/repo", a); s.move("/repo", b); s.favorite("/repo"); s.collapse(b); s.removeGroups([b]);
    expect(useLibrary.getState().groups[0].roots).toEqual([]);
    expect(useLibrary.getState().knownRoots).toContain("/repo"); expect(useLibrary.getState().favorites).toContain("/repo");
    expect(() => s.group(" product ")).toThrow("already in use");
  });
  it("removes a repository from one or all groups without touching workspace roots", () => {
    const s = useLibrary.getState();
    const parent = s.createGroup("Project", ["D:/repo"], []);
    const child = s.createGroup("Build", ["/tools"], [], parent);
    s.addToGroup(["D:/repo", "d:\\repo"], child);
    s.favorite("D:/repo");
    s.save("Work", { roots: ["D:/repo"], activeRoot: "D:/repo", views: {}, layouts: restoreWorkspaceLayouts(), historyMode: "graph" });
    const before = restoreLibrary(useLibrary.getState());
    expect(groupRepositoryRoots(before.groups, parent)).toEqual(["D:/repo", "/tools"]);
    expect(before.groups.find(g => g.id === child)?.roots).toEqual(["/tools", "D:/repo"]);
    s.removeFromGroups(["d:\\repo"], child);
    expect(useLibrary.getState().groups.map(g => g.roots)).toEqual([["D:/repo"], ["/tools"]]);
    s.addToGroup(["D:/repo"], child);
    s.removeFromGroups(["D:/repo"]);
    const after = useLibrary.getState();
    expect(after.groups.map(g => g.roots)).toEqual([[], ["/tools"]]);
    expect(after.workspaces[0].roots).toEqual(["D:/repo"]);
    expect(after.knownRoots).toContain("D:/repo");
    expect(after.favorites).toEqual(["D:/repo"]);
  });
  it("excludes group subtrees from one workspace and deletes entire selected trees", () => {
    const s = useLibrary.getState();
    const parent = s.createGroup("Project", ["/product"], []);
    const child = s.createGroup("Build", ["/tools"], [], parent);
    const leaf = s.createGroup("Leaf", [], [], child);
    const other = s.group("Other");
    const snapshot = { roots: ["/product", "/tools"], activeRoot: "/product", views: {}, layouts: restoreWorkspaceLayouts(), historyMode: "graph" as const };
    const work = s.save("Work", snapshot);
    const backup = s.save("Backup", snapshot, false, work);
    const nested = s.save("Nested", snapshot, true, backup);
    const unrelated = s.save("Unrelated", snapshot, false);
    s.favoriteWorkspace(nested);
    s.setWorkspaceGroupsExcluded(work, [parent], true);
    const restored = restoreLibrary(useLibrary.getState());
    expect(groupsInWorkspace(restored.groups, restored.workspaces[0]).map(g => g.id)).toEqual([other]);
    expect(groupsInWorkspace(restored.groups, restored.workspaces[1]).map(g => g.id)).toEqual([parent, child, leaf, other]);
    expect(restored.workspaces[0].roots).toEqual(snapshot.roots);
    s.setWorkspaceGroupsExcluded(work, [parent], false);
    expect(groupsInWorkspace(useLibrary.getState().groups, useLibrary.getState().workspaces[0])).toHaveLength(4);
    s.setWorkspaceGroupsExcluded(unrelated, [leaf], true);
    s.removeGroups([parent, other]);
    expect(useLibrary.getState().groups).toEqual([]);
    s.remove(work);
    expect(useLibrary.getState().workspaces).toMatchObject([{ id: unrelated, parentId: null, roots: snapshot.roots, excludedGroupIds: [] }]);
    expect(useLibrary.getState().activeWorkspaceId).toBeNull();
    expect(useLibrary.getState().favoriteWorkspaceIds).toEqual([]);
    expect(useLibrary.getState().knownRoots).toEqual(snapshot.roots);
  });
  it("moves a repository out of its source group and keeps its other memberships", () => {
    const s = useLibrary.getState();
    const origin = s.createGroup("Origin", ["/nested/repo"], []);
    const other = s.createGroup("Other", [], []);
    const target = s.createGroup("Target", [], []);
    s.addToGroup(["/nested/repo"], other);
    s.moveGroupRepositories(["/nested/repo"], origin, target);
    expect(useLibrary.getState().groups.map(group => group.roots)).toEqual([[], ["/nested/repo"], ["/nested/repo"]]);
  });
  it("relinks a moved or aliased folder across groups, favorites and workspace views", () => {
    const s = useLibrary.getState(), g = s.group("Project");
    s.move("E:/OLD", g); s.favorite("E:/OLD");
    s.renameRepository("e:/old", "Backend API");
    s.save("Work", { roots: ["E:/OLD"], activeRoot: "E:/OLD", views: { "E:/OLD": "changes" }, layouts: restoreWorkspaceLayouts(), historyMode: "columns" });
    s.remember("E:\\actual", "e:/old");
    const lib = useLibrary.getState(); expect(lib.favorites).toEqual(["E:\\actual"]); expect(lib.groups[0].roots).toEqual(["E:\\actual"]);
    expect(lib.workspaces[0]).toMatchObject({ roots: ["E:\\actual"], activeRoot: "E:\\actual", views: { "E:\\actual": "changes" } });
    expect(restoreLibrary(lib).repositoryNames).toEqual({ "e:/actual": "Backend API" });
    s.renameRepository("E:/actual", "");
    expect(useLibrary.getState().repositoryNames).toEqual({});
  });
  it("preserves folder provenance and keeps unrelated workspaces with the same name separate", () => {
    const library = restoreLibrary({ workspaces: [
      { id: "manual", name: "Backend", roots: ["/other/project"] },
      { id: "imported", name: "My services", importedFrom: "E:\\Projects\\backend", roots: ["E:\\Projects\\backend\\one"] },
    ] });
    const plans = planFolderWorkspaces(library.workspaces, [
      { folder: "e:/projects/backend", roots: ["E:/Projects/backend/two"] },
      { folder: "/first/backend", roots: ["/first/backend/repo"] },
      { folder: "/second/Backend", roots: ["/second/Backend/repo"] },
    ]);
    expect(plans.map(({ name, existing }) => [name, existing?.id])).toEqual([
      ["My services", "imported"], ["backend (2)", undefined], ["Backend (3)", undefined],
    ]);
  });
});
