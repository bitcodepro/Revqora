import { describe, expect, it } from "vitest";
import { rescanSelection, rescanSummary } from "./folderRescan";

describe("folder import rescan", () => {
  const before = { known: new Set(["a", "b", "c"]), selected: new Set(["a", "c"]) };

  it("selects new repositories and keeps the user's choices for known ones", () => {
    expect([...rescanSelection(["a", "b", "d"], before)].sort()).toEqual(["a", "d"]);
  });

  it("says what changed", () => {
    expect(rescanSummary(["a", "b", "c", "d", "e"], before.known)).toBe("Rescanned: found 2 repositories more.");
    expect(rescanSummary(["a", "b"], before.known)).toBe("Rescanned: 1 repository no longer found.");
    expect(rescanSummary(["a", "b", "d"], before.known)).toBe("Rescanned: found 1 repository more · 1 repository no longer found.");
    expect(rescanSummary(["c", "b", "a"], before.known)).toBe("Rescanned: no changes.");
  });
});
