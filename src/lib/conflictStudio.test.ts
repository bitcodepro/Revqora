import { describe, expect, it } from "vitest";
import { conflictInitialText, conflictOutput, sameConflictVersions } from "./conflictStudio";
import { validationFresh } from "./validation";
import type { ConflictInfo, ValidationReport } from "./types";
import { parseConflicts, resolveAll } from "./conflicts";
const side = { exists: true, binary: false, text: "base\n", oid: "a" };
const info: ConflictInfo = { path: "f.txt", code: "UU", base: side, ours: side, theirs: side, merged: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n", conflictCount: 1, working: "manual edit\n<<<<<<< ours\npart\n=======\nother\n>>>>>>> theirs\n", workingHasMarkers: true, oursLabel: "main", theirsLabel: "feature", eolCrlf: false };
describe("Conflict Studio buffers", () => {
  it("keeps partially edited working content even when markers remain", () => expect(conflictInitialText(info)).toBe(info.working));
  it("does not replace a marker-free result matching ours with a generated merge", () => expect(conflictInitialText({ ...info, working: side.text, workingHasMarkers: false })).toBe(side.text));
  it("uses the generated merge only when no working file exists", () => expect(conflictInitialText({ ...info, working: null })).toBe(info.merged));
  it("advances a retained draft's guard only when every file version still matches", () => {
    expect(sameConflictVersions({ ...info, stateToken: "old" }, { ...info, stateToken: "after-saving-another-file" })).toBe(true);
    expect(sameConflictVersions(info, { ...info, working: "external edit" })).toBe(false);
    expect(sameConflictVersions(info, { ...info, ours: { ...side, oid: "new-side" } })).toBe(false);
  });
  it("normalizes editor offsets but preserves CRLF when writing the result", () => {
    const crlf = { ...info, working: "manual\r\n", eolCrlf: true };
    expect(conflictInitialText(crlf)).toBe("manual\n"); expect(conflictOutput("resolved\nnext\n", crlf)).toBe("resolved\r\nnext\r\n");
    expect(conflictOutput("resolved\n", { ...crlf, working: "manual\n" })).toBe("resolved\n");
  });
  it("counts and resolves Git's custom conflict-marker-size without losing partial edits", () => {
    const working = "manual\n<<<<<<<<<< ours\nours\n|||||||||| base\nbase\n==========\ntheirs\n>>>>>>>>>> theirs\n";
    expect(parseConflicts(working)).toHaveLength(1);
    expect(resolveAll(working, "theirs")).toBe("manual\ntheirs\n");
  });
});
describe("validation freshness", () => {
  const report: ValidationReport = { id: "1", repositoryRoot: "/repo", command: "npm test", phase: "passed", stdout: "", stderr: "", truncated: false, exitCode: 0, elapsedMs: 1, beforeState: "same", afterState: "same", error: null };
  it("accepts only a passing unchanged disk state without unsaved editor changes", () => {
    expect(validationFresh(report, "same")).toBe(true);
    expect(validationFresh(report, "same", true)).toBe(false);
    expect(validationFresh(report, "external-change")).toBe(false);
    expect(validationFresh({ ...report, beforeState: "other" }, "same")).toBe(false);
    expect(validationFresh({ ...report, phase: "failed" }, "same")).toBe(false);
    expect(validationFresh(report, null)).toBe(false);
    expect(validationFresh(report, "same", false, "/linked-worktree")).toBe(false);
  });
});
