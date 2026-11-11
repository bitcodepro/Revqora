import { describe, expect, it } from "vitest";
import { diffPage } from "./mcpDiff";
import type { FileDiff } from "./types";

function patch(text: string[], hash = "same"): FileDiff {
  return { path: "fixture.txt", oldPath: null, binary: false, isNew: true, isDeleted: false,
    oldMode: null, newMode: "100644", similarity: null, empty: false, hash, additions: text.length, deletions: 0, truncated: false,
    hunks: [{ header: "@@ -0,0 +1,1000 @@", oldStart: 0, newStart: 1, oldLines: 0, newLines: text.length,
      lines: text.map((line, index) => ({ kind: "+", oldNo: null, newNo: index + 1, text: line })) }] };
}

describe("MCP diff pages", () => {
  it("binds offsets to the contents while accepting a fresh stage snapshot", () => {
    const diff = patch(["one", "two", "three"]);
    const first = diffPage({ ...diff, stageSnapshot: 1 }, { limit: 1 });
    const second = diffPage({ ...diff, stageSnapshot: 2 }, { offset: first.nextOffset!, diffVersion: first.diffVersion });
    expect(second.hunks[0].lines.map(line => line.text)).toEqual(["two", "three"]);
    expect(() => diffPage(patch(["new", "two", "three"], "changed"), { offset: 1, diffVersion: first.diffVersion }))
      .toThrow(expect.objectContaining({ code: "diff_changed" }));
    expect(() => diffPage(diff, { offset: 1 })).toThrow(expect.objectContaining({ code: "diff_version_required" }));
  });

  it("enforces the response budget without gaps and reads more than 160 short lines", () => {
    expect(diffPage(patch(Array.from({ length: 500 }, () => "short")), { limit: 500 }).hunks[0].lines).toHaveLength(500);
    const diff = patch(Array.from({ length: 1000 }, () => "é".repeat(400)));
    let offset = 0;
    do {
      const page = diffPage(diff, { limit: 1000, offset, diffVersion: diff.hash });
      const lines = page.hunks.flatMap(hunk => hunk.lines);
      expect(lines[0].lineIndex).toBe(offset);
      expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(120_000);
      offset += lines.length;
      expect(page.nextOffset).toBe(offset < 1000 ? offset : null);
    } while (offset < 1000);
  });

  it("returns the complete long line across chunks without splitting a surrogate pair", () => {
    const text = "x".repeat(599) + "🙂" + "y".repeat(20_000);
    const diff = patch([text]);
    const first = diffPage(diff, {}).hunks[0].lines[0];
    expect(first.nextTextOffset).toBe(599);
    let chunk = first, joined = first.text;
    while (chunk.nextTextOffset !== null) {
      chunk = diffPage(diff, { offset: 0, lineOffset: chunk.nextTextOffset, diffVersion: diff.hash }).hunks[0].lines[0];
      joined += chunk.text;
    }
    expect(joined).toBe(text);
  });
});
