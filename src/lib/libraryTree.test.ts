import { beforeEach, expect, it } from "vitest";
import { folderGroupTree } from "./folderGroupTree";
import { moveTreeEntries, treeSelection, visibleTree } from "./libraryTree";
import { groupRepositoryRoots, planFolderGroups, restoreLibrary, useLibrary } from "./repositoryLibrary";

beforeEach(() => useLibrary.setState(restoreLibrary({})));

it("maps the import root, nested repositories and all intermediate directories", () => {
  const repositories = [
    {root: "D:/base/service", relativePath: "service", workspaceFolder: "D:/base"},
    {root: "D:/base/service/generated/deep/worker", relativePath: "service\\generated\\deep\\worker", workspaceFolder: "D:/base/service/generated/deep"},
  ];
  const tree = folderGroupTree(repositories, new Set(repositories.map(repo => repo.root)));
  expect(tree).toEqual([
    {folder: "D:/base", parentFolder: null, roots: ["D:/base/service"]},
    {folder: "D:/base/service", parentFolder: "D:/base", roots: []},
    {folder: "D:/base/service/generated", parentFolder: "D:/base/service", roots: []},
    {folder: "D:/base/service/generated/deep", parentFolder: "D:/base/service/generated", roots: ["D:/base/service/generated/deep/worker"]},
  ]);
  expect(folderGroupTree(repositories, new Set([repositories[0].root]))).toEqual(tree.slice(0, 1));
  const plan = planFolderGroups([], tree);
  expect(plan.map(item => item.parentId)).toEqual([null, plan[0].id, plan[1].id, plan[2].id]);
  const saved = restoreLibrary({ groups: plan.map(({folder, ...item}) => ({ ...item, importedFrom: folder })) }).groups;
  useLibrary.setState({ groups: saved });
  useLibrary.getState().moveGroups([plan[3].id], null);
  expect(planFolderGroups(useLibrary.getState().groups, tree)[3].parentId).toBeNull();
});

it("creates a parent from selected groups, preserves members, and rejects cycles atomically", () => {
  const lib = useLibrary.getState();
  const a = lib.createGroup("API", ["/api"], []);
  const b = lib.createGroup("Worker", ["/worker"], []);
  const parent = lib.createGroup("Services", [], [a, b]);
  expect(groupRepositoryRoots(useLibrary.getState().groups, parent)).toEqual(["/api", "/worker"]);
  const before = useLibrary.getState().groups;
  expect(() => lib.moveGroups([parent], a)).toThrow("cannot contain itself");
  expect(useLibrary.getState().groups).toBe(before);
  lib.moveGroups([a], null);
  const restored = restoreLibrary(useLibrary.getState());
  expect(restored.groups.find(g => g.id === b)?.parentId).toBe(parent);
  expect(restored.groups.find(g => g.id === a)?.parentId).toBeNull();
});

it("reveals ancestors when filtering and only selects visible ranges", () => {
  const entries = [{id:"a", name:"Parent"}, {id:"b", name:"Child", parentId:"a"}, {id:"c", name:"Other"}];
  expect(visibleTree(entries, () => true, entry => entry.id === "a", false).map(row => row.entry.id)).toEqual(["a", "c"]);
  expect(visibleTree(entries, entry => entry.id === "b", () => true, true).map(row => [row.entry.id, row.depth])).toEqual([["a",0],["b",1]]);
  expect(treeSelection(["a","b","c"], ["c"], "a", "b", true, false)).toEqual(["a","b"]);
  expect(treeSelection(["a","b","c"], ["c"], "a", "b", false, true)).toEqual(["c","b"]);
});

it("reorders siblings and preserves the dragged subtree when crossing levels", () => {
  const entries = [
    {id:"a", name:"A", parentId:null}, {id:"child", name:"Child", parentId:"a"},
    {id:"b", name:"B", parentId:null}, {id:"c", name:"C", parentId:"b"},
  ];
  const reordered = moveTreeEntries(entries, ["a"], null, {siblingId:"b", after:true});
  expect(visibleTree(reordered, () => true, () => false, false).map(row => row.entry.id)).toEqual(["b","c","a","child"]);
  const nested = moveTreeEntries(reordered, ["a"], "b", {siblingId:"c", after:false});
  expect(visibleTree(nested, () => true, () => false, false).map(row => [row.entry.id, row.depth])).toEqual([["b",0],["a",1],["child",2],["c",1]]);
  expect(() => moveTreeEntries(nested, ["b"], "a", {siblingId:"child", after:false})).toThrow("cannot contain itself");
});
