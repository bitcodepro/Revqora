import { describe, expect, it } from "vitest";
import { measureDiffLine } from "./diffMetrics";

const mono = (text: string) => text.length * 10;

describe("diff line width with CSS tab stops", () => {
  it("advances to stops from the current position, including consecutive and trailing tabs", () => {
    for (const [text, width] of [
      ["", 0], ["abc", 30], ["\t", 40], ["a\t", 40], ["abc\t", 40],
      ["abcd\t", 80], ["\t\t", 80], ["a\tb\t", 80],
    ] as const) expect(measureDiffLine(text, mono)).toBe(width);
    expect(measureDiffLine("abc\t".repeat(120) + "END", mono)).toBe(4830);
  });
  it("uses measured glyph widths and the CSS minimum tab advance", () => {
    expect(measureDiffLine("wide\tEND", (s) => s === "wide" ? 20 : mono(s))).toBe(70);
    expect(measureDiffLine("near\t", (s) => s === "near" ? 35.1 : mono(s))).toBe(80);
    expect(measureDiffLine("half\t", (s) => s === "half" ? 35 : mono(s))).toBe(40);
  });
});
