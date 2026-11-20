import {describe,it,expect} from "vitest";
import {branchesInFolder,selectSidebarBranches,sidebarBranchPreferences} from "./sidebarBranches";
import type {BranchInfo} from "./types";
const b=(name:string,email:string,time:number)=>({name,fullName:`refs/heads/${name}`,author:"Unrelated tip author",authorEmail:"tip@example.invalid",creator:{name:email.split("@")[0],email},time,upstream:null} as BranchInfo);
describe("sidebar branch ownership filter and activity order",()=>{
  const rows=[b("old","me@example.invalid",1),b("other","other@example.invalid",30),b("feature/recent","ME@example.invalid",20)];
  it("uses recorded creators even when somebody else authored the latest commit",()=>{expect(selectSidebarBranches(rows,{onlyMine:true,sort:"recent"},"","me@example.invalid","").map(b=>b.name)).toEqual(["feature/recent","old"]);const unknown={...rows[0],creator:null,authorEmail:"me@example.invalid"};expect(selectSidebarBranches([unknown],{onlyMine:true,sort:"recent"},"","me@example.invalid","")).toEqual([]);});
  it("supports custom names/emails, name order and branch search together",()=>{expect(selectSidebarBranches(rows,{onlyMine:true,sort:"recent"},"other",null,"").map(b=>b.name)).toEqual(["other"]);expect(selectSidebarBranches(rows,{onlyMine:false,sort:"name"},"",null,"").map(b=>b.name)).toEqual(["feature/recent","old","other"]);expect(selectSidebarBranches(rows,{onlyMine:true,sort:"recent"},"","me@example.invalid","feature")).toHaveLength(1);});
  it("defaults to recent activity with all branches and never guesses an absent identity",()=>{expect(sidebarBranchPreferences(null)).toEqual({onlyMine:false,sort:"recent"});expect(selectSidebarBranches(rows,{onlyMine:true,sort:"recent"},"",null,"")).toEqual([]);});
});
describe("branches in a branch folder", () => {
  const branch = (name: string, fullName = `refs/heads/${name}`) => ({ name, fullName } as BranchInfo);
  it("takes every branch under the folder, not only the ones the tree shows", () => {
    const local = [branch("feature/a"), branch("feature/deep/b"), branch("featured"), branch("main")];
    // feature/deep/b may be hidden by search or pinned as the primary branch: still included.
    expect(branchesInFolder(local, "feature")).toEqual(["refs/heads/feature/a", "refs/heads/feature/deep/b"]);
    expect(branchesInFolder(local, "feature/deep")).toEqual(["refs/heads/feature/deep/b"]);
  });
  it("matches remote folders under their remote", () => {
    const remote = [branch("origin/feature/a", "refs/remotes/origin/feature/a"), branch("fork/feature/a", "refs/remotes/fork/feature/a")];
    expect(branchesInFolder(remote, "origin/feature")).toEqual(["refs/remotes/origin/feature/a"]);
  });
});
