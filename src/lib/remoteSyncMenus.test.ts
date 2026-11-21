import { describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
vi.mock("./remoteSync", () => ({ syncRepositories: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); } }));

const { branchFolderSyncMenu, selectionSyncMenu } = await import("../components/RemoteSyncMenus");

const labels = (items: { label?: string }[]) => items.map(item => item.label);
const none = { folders: [], repositories: [], branches: [] };

describe("Fetch, Pull and Push menu items", () => {
  it("names what the right-click acts on", () => {
    expect(labels(selectionSyncMenu({ ...none, folders: [["/a", "/b"]] }))).toEqual(["Fetch all branches in folder", "Pull all branches in folder", "Push all branches in folder"]);
    expect(labels(selectionSyncMenu({ ...none, folders: [["/a"], ["/b"]] }))[0]).toBe("Fetch all branches in selected folders");
    expect(labels(selectionSyncMenu({ ...none, repositories: ["/a"] }))[1]).toBe("Pull all branches");
    expect(labels(selectionSyncMenu({ ...none, repositories: ["/a", "/b"] }))[2]).toBe("Push all branches in selected repositories");
    expect(labels(selectionSyncMenu({ ...none, branches: [{ root: "/a", branches: ["refs/heads/x"] }, { root: "/b", branches: ["refs/heads/y"] }] }))[0]).toBe("Fetch all selected branches");
    expect(labels(selectionSyncMenu({ folders: [["/a"]], repositories: [], branches: [{ root: "/b", branches: ["refs/heads/y"] }] }))[1]).toBe("Pull all selected items");
  });

  it("acts on folders and repositories whole and on selected branches alone", () => {
    calls.length = 0;
    selectionSyncMenu({ folders: [["/a", "/b"]], repositories: ["/c"], branches: [{ root: "/d", branches: ["refs/heads/x"] }] })[2].onClick!();
    expect(calls).toEqual([["push", [{ root: "/a" }, { root: "/b" }, { root: "/c" }, { root: "/d", branches: ["refs/heads/x"] }]]]);
  });

  it("pulls and pushes only the local branches of a selection that holds remote branches", () => {
    calls.length = 0;
    const remoteOnly = selectionSyncMenu({ ...none, branches: [{ root: "/a", branches: ["refs/remotes/origin/x"] }, { root: "/a", branches: ["refs/remotes/origin/y"] }] });
    expect(remoteOnly[0]!.disabled).toBe(false);
    expect(remoteOnly.slice(1)).toMatchObject([
      { disabled: true, hint: "Remote branches can only be fetched" },
      { disabled: true, hint: "Remote branches can only be fetched" },
    ]);
    const mixed = selectionSyncMenu({ ...none, branches: [{ root: "/a", branches: ["refs/remotes/origin/x"] }, { root: "/a", branches: ["refs/heads/y"] }] });
    mixed[0]!.onClick!();
    mixed[1]!.onClick!();
    expect(calls).toEqual([
      ["fetch", [{ root: "/a", branches: ["refs/remotes/origin/x"] }, { root: "/a", branches: ["refs/heads/y"] }]],
      ["pull", [{ root: "/a", branches: ["refs/heads/y"] }]],
    ]);
  });

  it("offers only Fetch for a folder of remote-only branches and nothing for an empty folder", () => {
    expect(labels(branchFolderSyncMenu("/a", ["refs/remotes/origin/feature/x"], true))).toEqual(["Fetch all branches in folder"]);
    expect(branchFolderSyncMenu("/a", []).every(item => item.disabled)).toBe(true);
  });
});
