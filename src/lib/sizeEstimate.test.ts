import { describe, expect, it } from "vitest";
import { detailsBytes, diffBytes, rowBytes } from "./sizeEstimate";
import type { CommitDetails, FileDiff, GraphRow } from "./types";

describe("size estimates for cached answers", () => {
  it("grow with the text an answer holds and stay near its serialized size", () => {
    const line = (text: string) => ({ kind: "add", oldNo: null, newNo: 1, text });
    const diff = { path: "a.txt", oldPath: null, hunks: [{ header: "@@ -1 +1 @@", lines: Array.from({ length: 500 }, (_, i) => line(`line ${i} ${"x".repeat(80)}`)) }] } as unknown as FileDiff;
    const serialized = 2 * JSON.stringify(diff).length;
    expect(diffBytes(diff)).toBeGreaterThan(serialized * 0.7);
    expect(diffBytes(diff)).toBeLessThan(serialized * 1.5);
    const bigger = { ...diff, hunks: [...diff.hunks, ...diff.hunks] } as FileDiff;
    expect(diffBytes(bigger)).toBeGreaterThan(diffBytes(diff));
    const details = { subject: "s", body: "b".repeat(1000), files: [{ path: "a.txt", oldPath: null }], parents: ["p"] } as unknown as CommitDetails;
    expect(detailsBytes(details)).toBeGreaterThan(2000);
    const row = { subject: "x".repeat(300), refs: [{ name: "main" }], parents: [], segs: [] } as unknown as GraphRow;
    expect(rowBytes(row)).toBeGreaterThan(600);
  });

  it("count missing fields as nothing", () => {
    expect(diffBytes({ path: "x" } as FileDiff)).toBeGreaterThan(0);
    expect(detailsBytes({} as CommitDetails)).toBeGreaterThan(0);
    expect(rowBytes({} as GraphRow)).toBeGreaterThan(0);
  });
});
