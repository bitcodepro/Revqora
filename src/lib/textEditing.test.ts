import { describe, expect, it } from "vitest";
import { editorDocument, tabsToSpaces } from "./textEditing";
describe("working text edits", () => {
  it("keeps encoding markers, line endings and final newline decisions", () => {
    for (const text of ["\uFEFF\tline\r\n\tother\r\n", "line\nother", "line\rother\r", "", "\uFEFFno newline"]) {
      const parsed = editorDocument(text);
      expect(parsed.bom + parsed.doc).toBe(text);
    }
    expect(() => editorDocument("one\r\ntwo\n")).toThrow(/mixes line endings/);
  });
  it("expands two tabs to four spaces without touching strings or line endings by default", () => {
    const text = '\uFEFF\t\tvalue = "keep\tthis";\r\n \tx\r\n';
    expect(tabsToSpaces(text, 2)).toBe('\uFEFF    value = "keep\tthis";\r\n  x\r\n');
    expect(tabsToSpaces("\t\tvalue", 4)).toBe("        value");
    expect(tabsToSpaces("one\ttwo\n\tend", 4, true)).toBe("one two\n    end");
    expect(() => tabsToSpaces("x", 0)).toThrow();
  });
});
