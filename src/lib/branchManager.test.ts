import { describe, expect, it } from "vitest";
import { defaults, isProtected, matchesFilter, matchesRule, preferencesKey, restoreBranchPreferences, selectBranches } from "./branchManager";
import type { ManagedBranch, Worktree } from "./types";
const branch = (patch: Partial<ManagedBranch> = {}): ManagedBranch => ({ fullRef: "refs/heads/topic", name: "topic", oid: "a".repeat(40), local: true, current: false, upstream: null, ahead: 0, behind: 0, gone: false, time: 100, author: "Author", authorEmail: "me@example.invalid", subject: "Implement login", merged: false, protectionNames: ["topic"], mappingKnown: true, ...patch });
describe("branch manager decisions", () => {
  it("protects aliases of actual server branches and supports bounded wildcard rules", () => {
    expect(isProtected(branch({ name: "origin/innocent", protectionNames: ["origin/innocent", "main"] }), defaults.protections)).toBe(true);
    expect(matchesRule("release/v1/hotfix", "release/*")).toBe(true);
    expect(matchesRule("main", "mai?")).toBe(true);
    expect(matchesRule("domain", "main")).toBe(false);
    expect(matchesRule("main", "[a-z]*")).toBe(false);
  });
  it("treats physical reachability, upstream divergence, age and occupied worktrees separately", () => {
    const b = branch({ ahead: 1, behind: 2 });
    expect(matchesFilter(b,"Diverged",defaults,[],0)).toBe(true);
    expect(matchesFilter(branch({ ahead: 1 }),"Diverged",defaults,[],0)).toBe(false);
    expect(matchesFilter(branch({ merged: null }),"Unmerged",defaults,[],0)).toBe(false);
    const worktrees = [{ branch: "topic", bare: false, detached: false }] as Worktree[];
    expect(matchesFilter(b,"Active",defaults,worktrees,0)).toBe(true);
    expect(matchesFilter(branch({ local: false }),"Active",defaults,worktrees,0)).toBe(false);
    expect(matchesFilter(b,"Stale",defaults,[],10000000000)).toBe(true);
    expect(matchesFilter(branch({ time: 0 }),"Stale",defaults,[],10000000000)).toBe(false);
  });
  it("searches author, message and SHA and keeps stable ordering on equal dates", () => {
    const a = branch(), b = branch({ name: "a", fullRef: "refs/heads/a" });
    expect(selectBranches([a,b],defaults,"login",[]).map(b => b.name)).toEqual(["a","topic"]);
    expect(selectBranches([a],defaults,"author",[])).toHaveLength(1);
    expect(selectBranches([a],defaults,"aaa",[])).toHaveLength(1);
    expect(selectBranches([a],{...defaults,scope:"remote"},"",[])).toHaveLength(0);
  });
  it("sanitizes persisted preferences while permitting explicit removal of all protection rules", () => {
    expect(restoreBranchPreferences({ scope: "invalid", staleDays: NaN, protections: [null,{},"main",""] })).toEqual({...defaults,protections:["main"]});
    expect(restoreBranchPreferences({ protections: [] }).protections).toEqual([]);
    expect(restoreBranchPreferences(null)).toEqual(defaults);
    expect(restoreBranchPreferences({ base:"--evil", staleDays:999999 }).base).toBeNull();
    expect(restoreBranchPreferences({ staleDays:999999 }).staleDays).toBe(3650);
    expect(preferencesKey("E:\\Repo")).toBe(preferencesKey("e:/repo/"));
  });
  it("intersects My branches with missing remote upstreams using the configured email exactly", () => {
    const gone = branch({ upstream: "refs/remotes/origin/topic", gone: true });
    const branches = [gone, branch({ name: "other", authorEmail: "not-me@example.invalid", upstream: gone.upstream, gone: true }), branch({ name: "local-only" }), branch({ name: "local-tracking", upstream: "refs/heads/deleted", gone: true }), branch({ name: "published", upstream: gone.upstream })];
    const prefs = { ...defaults, onlyMine: true, remoteDeleted: true };
    expect(selectBranches(branches,prefs,"",[],0," ME@EXAMPLE.INVALID ")).toEqual([gone]);
    expect(selectBranches(branches,prefs,"",[],0,null)).toEqual([]);
    expect(selectBranches(branches,{...prefs,onlyMine:false},"",[],0)).toHaveLength(2);
  });
  it("supports persisted custom author names/emails without changing the default Git identity", () => {
    const prefs = restoreBranchPreferences({...defaults,onlyMine:true,authorQuery:"  Alice Example  "});
    const alice = branch({author:"Alice Example",authorEmail:"alice@work.invalid"});
    expect(selectBranches([alice,branch()],prefs,"",[],0,"me@example.invalid")).toEqual([alice]);
    expect(selectBranches([alice],{...prefs,authorQuery:"ALICE@WORK"},"",[],0,null)).toEqual([alice]);
    expect(selectBranches([alice],{...prefs,authorQuery:""},"",[],0,"me@example.invalid")).toEqual([]);
    expect(restoreBranchPreferences({onlyMine:"true",remoteDeleted:1,authorQuery:{}})).toEqual(defaults);
    expect(selectBranches([alice],defaults,"alice@work",[])).toEqual([alice]);
  });
});
