import { describe, expect, it } from "vitest";
import { restoreWorktreePreferences, selectWorktrees, worktreePreferencesKey, worktreeRemovalBlock } from "./worktreeManager";
import type { ManagedWorktree } from "./types";
const row=(patch:Partial<ManagedWorktree>={}):ManagedWorktree=>({path:"D:/repos/topic",head:"a".repeat(40),branch:"topic",detached:false,bare:false,locked:false,prunable:false,isCurrent:false,isMain:false,exists:true,changedFiles:0,staged:0,untracked:0,ignored:0,operation:"none",ahead:0,behind:0,error:null,...patch});
describe("worktree manager decisions",()=>{
  it("treats main, current, locked, missing, unreadable and operating folders as distinct removal blockers",()=>{
    for(const patch of [{isMain:true},{isCurrent:true},{locked:true},{exists:false},{error:"Unreadable"},{operation:"rebase"}])expect(worktreeRemovalBlock(row(patch))).not.toBeNull();
    // Dirty worktrees can enter review; consent and a complete checkpoint are server-side requirements.
    expect(worktreeRemovalBlock(row({changedFiles:3,ignored:2}))).toBeNull();
  });
  it("finds ignored-only changes and keeps missing/locked/detached filters independent",()=>{
    const dirty=row({path:"D:/ignored",ignored:1}),locked=row({path:"D:/locked",locked:true,exists:false}),detached=row({path:"D:/detached",branch:null,detached:true});
    const all=[row(),dirty,locked,detached],prefs=restoreWorktreePreferences(null);
    expect(selectWorktrees(all,{...prefs,filter:"Changed"},"")).toEqual([dirty]);
    expect(selectWorktrees(all,{...prefs,filter:"Missing"},"")).toEqual([locked]);
    expect(selectWorktrees(all,{...prefs,filter:"Locked"},"")).toEqual([locked]);
    expect(selectWorktrees(all,{...prefs,filter:"Detached"},"")).toEqual([detached]);
  });
  it("searches exact identities and lock reasons with deterministic ordering",()=>{
    const a=row({path:"D:/a",branch:"same",lockReason:"Offline drive"}),b=row({path:"D:/b",branch:"same",changedFiles:2});const prefs=restoreWorktreePreferences(null);
    expect(selectWorktrees([b,a],prefs,"")).toEqual([a,b]);expect(selectWorktrees([a,b],prefs,"offline")).toEqual([a]);
    expect(selectWorktrees([a,b],prefs,"aaaa")).toHaveLength(2);expect(selectWorktrees([a,b],{...prefs,sort:"changes"},"")).toEqual([b,a]);
  });
  it("restores bounded preferences and isolates repositories while respecting Windows path identity",()=>{
    expect(restoreWorktreePreferences({filter:"wrong",sort:null})).toEqual({filter:"All",sort:"branch"});
    expect(worktreePreferencesKey("D:\\Repos\\One")).toBe(worktreePreferencesKey("d:/repos/one"));
    expect(worktreePreferencesKey("/Repos/One")).not.toBe(worktreePreferencesKey("/repos/one"));
    expect(worktreePreferencesKey("D:/repos/one")).not.toBe(worktreePreferencesKey("D:/repos/two"));
  });
});
