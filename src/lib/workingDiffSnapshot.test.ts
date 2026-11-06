import {describe,it,expect} from "vitest";
import {workingDiffSnapshot,rememberWorkingDiff,forgetWorkingDiff} from "./workingDiffSnapshot";
import type {FileDiff} from "./types";
describe("cached local diff first paint",()=>{
  it("never substitutes another repository, side, path or options",()=>{const diff={path:"one",hunks:[]} as unknown as FileDiff;rememberWorkingDiff("repo","unstaged:one:unified",diff);expect(workingDiffSnapshot("repo","unstaged:one:unified")).toBe(diff);for(const view of ["staged:one:unified","unstaged:two:unified","unstaged:one:split"])expect(workingDiffSnapshot("repo",view)).toBeUndefined();expect(workingDiffSnapshot("other","unstaged:one:unified")).toBeUndefined();forgetWorkingDiff("repo");expect(workingDiffSnapshot("repo","unstaged:one:unified")).toBeUndefined();});
  it("does not retain oversized file contents",()=>{rememberWorkingDiff("huge","one",{path:"x".repeat(300000)} as FileDiff);expect(workingDiffSnapshot("huge","one")).toBeUndefined();});
});
