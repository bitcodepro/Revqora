import { describe, expect, it } from "vitest";
import { submodulePointers } from "./submodulePointer";
import type { FileDiff } from "./types";

const diff = (lines: [string, string][]) => ({ binary: false, hunks: [{ lines: lines.map(([kind, text]) => ({ kind, text, oldNo: null, newNo: null })) }] } as unknown as FileDiff);

describe("submodule pointer", () => {
  it("reads the old and new commit of a gitlink change", () => {
    expect(submodulePointers(diff([["-", "Subproject commit " + "a".repeat(40)], ["+", "Subproject commit " + "b".repeat(40) + "-dirty"]])))
      .toEqual({ from: "a".repeat(40), to: "b".repeat(40) });
    expect(submodulePointers(diff([["+", "Subproject commit " + "c".repeat(40)]]))).toEqual({ from: null, to: "c".repeat(40) });
  });
  it("ignores ordinary text", () => {
    expect(submodulePointers(diff([["+", "Subproject commit is a phrase"], [" ", "x"]]))).toBeNull();
    expect(submodulePointers(null)).toBeNull();
  });
});
