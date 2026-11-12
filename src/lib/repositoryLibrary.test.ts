import { beforeEach, describe, expect, it } from "vitest";
import { defaultGroupRoots, groupRepositoryRoots, repositoryKey, restoreLibrary, uniqueRoots, useLibrary } from "./repositoryLibrary";
import { recordExplorerMove, undoExplorerMove } from "./explorerMoves";

beforeEach(() => useLibrary.setState(restoreLibrary({})));

describe("Explorer library", () => {
  it("migrates groups, workspace ancestry, favorites, membership and selection", () => {
    const library = restoreLibrary({
      knownRoots: ["/standalone"],
      repositoryNames: { "/api": "API alias" },
      groups: [{ id: "existing", name: "Project", roots: ["/api"] }],
      workspaces: [
        { id: "project", name: "Project", roots: ["/api"], importedFrom: "/source", collapsed: true },
        { id: "services", name: "Services", parentId: "project", roots: ["/worker", "relative"] },
      ],
      activeWorkspaceId: "services",
      favoriteWorkspaceIds: ["project"],
      favorites: ["/worker"],
    });
    expect(library.groups).toEqual([
      { id: "existing", name: "Project", roots: ["/api"], collapsed: false },
      { id: "project", name: "Project (2)", roots: ["/api"], importedFrom: "/source", collapsed: true, favorite: true },
      { id: "services", name: "Services", parentId: "project", roots: ["/worker"], collapsed: false },
    ]);
    expect(library.activeGroupId).toBe("services");
    expect(library.favorites).toEqual(["/worker"]);
    expect(library.repositoryNames["/api"]).toBe("API alias");
    expect(groupRepositoryRoots(library.groups, "project")).toEqual(["/api", "/worker"]);
    expect(defaultGroupRoots(library.knownRoots, library.groups)).toEqual(["/standalone"]);
    expect(restoreLibrary(library)).toEqual(library);
  });

  it("matches Windows aliases without folding Unix identities", () => {
    expect(uniqueRoots(["C:\\Repos\\One", "c:/repos/one/", "/One", "/one", "relative"])).toEqual(["C:\\Repos\\One", "/One", "/one"]);
    expect(repositoryKey("C:/")).toBe("c:/");
    const library = useLibrary.getState();
    const group = library.createGroup("One", ["D:/alias"], []);
    library.renameRepository("D:/alias", "Friendly");
    library.favorite("D:/alias");
    library.remember("D:/actual", "D:/alias");
    expect(useLibrary.getState().groups.find(item => item.id === group)?.roots).toEqual(["D:/actual"]);
    expect(useLibrary.getState().repositoryNames).toEqual({ "d:/actual": "Friendly" });
    expect(useLibrary.getState().favorites).toEqual(["D:/actual"]);
  });

  it("moves selected placements to another group and safely undoes successive moves", () => {
    const library = useLibrary.getState();
    library.remember("/loose");
    const source = library.createGroup("Source", ["/repo"], []);
    const extra = library.createGroup("Other membership", [], []);
    library.addToGroup(["/repo"], extra);
    const destination = library.createGroup("Destination", [], []);
    const before = useLibrary.getState().groups;
    recordExplorerMove(() => library.moveRepositories([{ root: "/repo", groupId: source }, { root: "/loose", groupId: null }], destination));
    expect(groupRepositoryRoots(useLibrary.getState().groups, source)).toEqual([]);
    expect(groupRepositoryRoots(useLibrary.getState().groups, extra)).toEqual(["/repo"]);
    expect(groupRepositoryRoots(useLibrary.getState().groups, destination)).toEqual(["/repo", "/loose"]);
    recordExplorerMove(() => library.moveGroups([destination], source));
    expect(groupRepositoryRoots(useLibrary.getState().groups, source)).toEqual(["/repo", "/loose"]);
    expect(undoExplorerMove()).toBe(true);
    expect(undoExplorerMove()).toBe(true);
    expect(useLibrary.getState().groups).toBe(before);
    recordExplorerMove(() => library.moveGroups([destination], source));
    library.group("Renamed", destination);
    expect(undoExplorerMove()).toBe(false);
    expect(useLibrary.getState().groups.find(item => item.id === destination)?.name).toBe("Renamed");
  });

  it("deletes a subtree, clears its filter and returns its repositories to the default group", () => {
    const library = useLibrary.getState();
    const parent = library.createGroup("Parent", ["/one"], []);
    const child = library.createGroup("Child", ["/two"], [], parent);
    const other = library.createGroup("Other", ["/three"], []);
    library.selectGroup(child);
    library.removeGroups([parent]);
    const after = useLibrary.getState();
    expect(after.activeGroupId).toBeNull();
    expect(after.groups.map(group => group.id)).toEqual([other]);
    expect(defaultGroupRoots(after.knownRoots, after.groups)).toEqual(["/one", "/two"]);
  });

  it("imports the nested hierarchy once and preserves a moved imported group's identity", () => {
    const library = useLibrary.getState();
    const folders = [
      { folder: "/root", parentFolder: null, roots: ["/root/api"] },
      { folder: "/root/sub", parentFolder: "/root", roots: ["/root/sub/worker"] },
    ];
    const roots = ["/root/api", "/root/sub/worker"];
    library.importGroups(roots, folders);
    const [root, child] = useLibrary.getState().groups;
    expect(child.parentId).toBe(root.id);
    library.moveGroups([child.id], null);
    library.importGroups(roots, folders);
    expect(useLibrary.getState().groups.map(group => [group.id, group.parentId, group.roots])).toEqual([
      [root.id, null, ["/root/api"]], [child.id, null, ["/root/sub/worker"]],
    ]);
  });
});
