import { expect, it } from "vitest";
import { branchConnection, branchPairs } from "./branchPresentation";
import type { BranchInfo } from "./types";
const branch = (patch: Partial<BranchInfo> = {}): BranchInfo => ({ name:"topic",fullName:"refs/heads/topic",oid:"a".repeat(40),upstream:null,upstreamFullName:null,ahead:0,behind:0,gone:false,isHead:false,remote:null,time:0,subject:"",author:"",...patch });
const remote = branch({name:"origin/different",fullName:"refs/remotes/origin/different",remote:"origin"});

it("pairs configured full refs across renamed branches and preserves remote-only branches", () => {
  const local = branch({upstream:"origin/different",upstreamFullName:remote.fullName,ahead:2,behind:3});
  const other = branch({name:"fork/different",fullName:"refs/remotes/fork/different",remote:"fork"});
  const pairs = branchPairs([local,branch({fullName:"refs/heads/second",upstreamFullName:remote.fullName})],[remote,other]);
  expect(pairs.upstreams.get(local.fullName)).toBe(remote);
  expect(pairs.remoteOnly).toEqual([other]);
  expect(branchConnection(local).kind).toBe("paired");
  expect([local.ahead,local.behind]).toEqual([2,3]);
});
it("does not guess pairings by matching names, short refs, or OIDs", () => {
  const local = branch({name:"origin/different",upstream:"origin/different",upstreamFullName:"refs/heads/origin/different"});
  expect(branchPairs([local,branch()],[remote]).remoteOnly).toEqual([remote]);
  expect(branchConnection(local).kind).toBe("local");
  expect(branchConnection(branch()).title).toContain("no upstream");
});
it("marks only missing remote upstreams as remote deleted and keeps them out of pairs", () => {
  const gone = branch({upstream:remote.name,upstreamFullName:remote.fullName,gone:true});
  expect(branchConnection(gone).kind).toBe("gone");
  expect(branchPairs([gone],[remote]).remoteOnly).toEqual([remote]);
  expect(branchConnection(branch({gone:true,upstreamFullName:"refs/heads/deleted"})).kind).toBe("local");
});
