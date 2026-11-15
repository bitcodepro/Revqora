import { describe, expect, it } from "vitest";
import { findLines, scrollToRow, stepMatch } from "./blameFind";

describe("blame find", () => {
  it("matches case-insensitively", () => {
    expect(findLines(["Foo", "bar", "food"], "foo")).toEqual([0, 2]);
    expect(findLines(["a"], "")).toEqual([]);
  });
  it("steps forward and backward with wrapping", () => {
    const m = [2, 5, 9];
    expect(stepMatch(m, -1, false)).toBe(0);
    expect(stepMatch(m, 5, false)).toBe(2);
    expect(stepMatch(m, 9, false)).toBe(0);
    expect(stepMatch(m, 5, true)).toBe(0);
    expect(stepMatch(m, 2, true)).toBe(2);
    expect(stepMatch([], 0, false)).toBe(-1);
  });
  it("scrolls only when the row is outside the viewport", () => {
    expect(scrollToRow(10, 20, 0, 100)).toBe(120);
    expect(scrollToRow(2, 20, 100, 100)).toBe(40);
    expect(scrollToRow(6, 20, 100, 100)).toBe(100);
  });
});
