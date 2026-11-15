import { describe, expect, it } from "vitest";
import { movedLines } from "./movedLines";
import type { DiffHunk } from "./types";

const hunk = (lines: [string, string][]): DiffHunk => ({ header: "@@", oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: lines.map(([kind, text]) => ({ kind, text, oldNo: null, newNo: null })) } as unknown as DiffHunk);

describe("moved lines", () => {
  it("marks a block removed in one place and added in another", () => {
    const hunks = [hunk([["-", "function helper() {"], ["-", "  return compute(x);"], [" ", "}"]]), hunk([["+", "function helper() {"], ["+", "  return compute(x);"]])];
    expect([...movedLines(hunks)].sort()).toEqual(["0:0", "0:1", "1:0", "1:1"]);
  });
  it("ignores short lines and in-place whitespace edits", () => {
    const hunks = [hunk([["-", "}"], ["+", "}"], ["-", "  const value = 1;"], ["+", "const value = 1;"]])];
    expect(movedLines(hunks).size).toBe(0);
  });
  it("ignores real edits", () => {
    expect(movedLines([hunk([["-", "const value = 1;"], ["+", "const value = 2;"]])]).size).toBe(0);
  });
});
