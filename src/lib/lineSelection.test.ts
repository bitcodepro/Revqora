import { describe, expect, it } from "vitest";
import { changeBlocks, lineRange } from "./lineSelection";
import type { DiffHunk } from "./types";

const hunk = (kinds: string): DiffHunk => ({ header: "@@", oldStart: 1, oldLines: 0, newStart: 1, newLines: 0,
  lines: [...kinds].map((kind) => ({ kind: kind === "." ? " " : kind, text: "x", oldNo: null, newNo: null })) } as unknown as DiffHunk);

describe("line selection", () => {
  it("selects changed lines between two points, in either direction and across hunks", () => {
    const hunks = [hunk("-+.+"), hunk(".--")];
    expect(lineRange(hunks, { h: 0, l: 1 }, { h: 1, l: 1 })).toEqual(["0:1", "0:3", "1:1"]);
    expect(lineRange(hunks, { h: 1, l: 1 }, { h: 0, l: 1 })).toEqual(["0:1", "0:3", "1:1"]);
    expect(lineRange(hunks, { h: 0, l: 0 }, { h: 0, l: 0 })).toEqual(["0:0"]);
  });
  it("skips collapsed hunks in between", () => {
    const hunks = [hunk("+"), hunk("+"), hunk("+")];
    expect(lineRange(hunks, { h: 0, l: 0 }, { h: 2, l: 0 }, new Set([1]))).toEqual(["0:0", "2:0"]);
  });
  it("splits a hunk into blocks of changes separated by context", () => {
    expect(changeBlocks(hunk(".-+..+-.+"))).toEqual([{ start: 1, lines: [1, 2] }, { start: 5, lines: [5, 6] }, { start: 8, lines: [8] }]);
  });
});
