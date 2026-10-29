import { describe, expect, it } from "vitest";
import { defaults, isProtected, matchesFilter, matchesRule, preferencesKey, restoreBranchPreferences, selectBranches } from "./branchManager";
import type { ManagedBranch, Worktree } from "./types";
const branch = (patch: Partial<ManagedBranch> = {}): ManagedBranch => ({ fullRef: "refs/heads/topic", name: "topic", oid: "a".repeat(40), local: true, current: false, upstream: null, ahead: 0, behind: 0, gone: false, time: 100, author: "Author", subject: "Implement login", merged: false, protectionNames: ["topic"], mappingKnown: true, ...patch });
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
});
