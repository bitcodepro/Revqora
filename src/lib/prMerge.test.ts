import {describe,expect,it} from "vitest";
import {canMerge,mergeDraftKey,needsCleanupForce} from "./prMerge";
import type {PrMergePlan} from "./types";
const plan:PrMergePlan={revision:"proof",detailRevision:"metadata",sourceSha:"a",targetSha:"b",actor:"Merger",actorId:"1",methods:[{id:"queue",label:"Add to queue",explanation:""}],checks:[],rules:[],blockers:[],notices:[],queueState:null,merged:false};
describe("reviewed merge actions",()=>{
 it("enables only the reviewed server method and never a blocked or merged request",()=>{expect(canMerge(plan,"queue")).toBe(true);expect(canMerge(plan,"merge")).toBe(false);expect(canMerge({...plan,blockers:["Required review missing"]},"queue")).toBe(false);expect(canMerge({...plan,merged:true},"queue")).toBe(false);expect(canMerge(null,"queue")).toBe(false);});
 it("keeps pending merge result keys scoped to repository, account and request across source refreshes",()=>{const k=mergeDraftKey("D:/Repo","connection","actor",42);expect(k).toBe(mergeDraftKey("D:/Repo","connection","actor",42));expect(k).not.toBe(mergeDraftKey("D:/Other","connection","actor",42));expect(k).not.toBe(mergeDraftKey("D:/Repo","connection","another",42));expect(k).not.toBe(mergeDraftKey("D:/Repo","connection","actor",43));});
 it("requires explicit outside-history consent only for the selected cleanup destinations",()=>{const p={localUnmerged:0,remoteUnmerged:3,proof:{baseOid:"base"}};expect(needsCleanupForce(true,false,p)).toBe(false);expect(needsCleanupForce(false,true,p)).toBe(true);expect(needsCleanupForce(true,true,p)).toBe(true);expect(needsCleanupForce(true,false,{...p,proof:{baseOid:null}})).toBe(true);});
});
