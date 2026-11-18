import { describe, expect, it } from "vitest";
import { changeLabel, lastRestoreLines, orderSavedFiles, restoreReport } from "./recoveryRestore";
import type { RecoveryRestoreOutcome, RecoverySavedFile } from "./types";

const outcome = (patch: Partial<RecoveryRestoreOutcome>): RecoveryRestoreOutcome => ({
  restored: [], changedSince: [], keptBoth: [], unchanged: [], failed: null, notAttempted: [], checkpoint: null, checkpointError: null, ...patch,
});
const file = (path: string, state: RecoverySavedFile["state"], savedKind: RecoverySavedFile["savedKind"] = "file"): RecoverySavedFile =>
  ({ path, state, savedKind, restorable: savedKind === "file" && state !== "same", current: { kind: "file", len: 1, sha256: null, target: null } });

describe("restore results", () => {
  it("reports a clean restore as a success", () => {
    const report = restoreReport(outcome({ restored: ["a.txt", "b.env"], checkpoint: "cp-1" }), 2);
    expect(report).toEqual({ title: "Restored 2 files", lines: ["Restored: a.txt, b.env"], warning: false });
  });

  it("names the copies written beside files changed after the operation", () => {
    const report = restoreReport(outcome({ restored: ["a.txt"], changedSince: ["b.txt"], keptBoth: [{ path: "b.txt", copy: "b.txt.recovered" }] }), 2);
    expect(report.warning).toBe(true);
    expect(report.title).toBe("Restored 1 of 2 files");
    expect(report.lines).toContain("Kept as they are, with the saved copy written beside: b.txt → b.txt.recovered");
  });

  it("explains why nothing was replaced when the current versions could not be saved", () => {
    const report = restoreReport(outcome({ keptBoth: [{ path: "a", copy: "a.recovered" }], checkpointError: "Nested repositories cannot be captured" }), 1);
    expect(report.warning).toBe(true);
    expect(report.lines.join("\n")).toMatch(/could not be saved first \(Nested repositories cannot be captured\), so no file was replaced/);
  });

  it("lists the failed file and the ones never attempted", () => {
    const report = restoreReport(outcome({ restored: ["a"], failed: ["b", "Access is denied"], notAttempted: ["c"] }), 3);
    expect(report.lines).toEqual(["Restored: a", "Failed: b (Access is denied)", "Not attempted: c"]);
  });

  it("marks files of a restore the app did not finish for a manual check", () => {
    const lines = lastRestoreLines({ startedAt: 1, finished: false, planned: ["a", "b"], restored: ["a"], keptBoth: [], unchanged: [], failed: [], notFinished: ["b"], checkpoint: null });
    expect(lines).toEqual(["Restored: a", "The app stopped before finishing: b need a manual check."]);
  });
});

describe("saved files", () => {
  it("lists files needing attention first", () => {
    const ordered = orderSavedFiles([file("z", "same"), file("b", "operation"), file("a", "operation"), file("y", "later"), file("x", "unknown")]);
    expect(ordered.map((f) => f.path)).toEqual(["x", "y", "a", "b", "z"]);
  });

  it("describes paths that did not exist before the operation", () => {
    expect(changeLabel(file("new.txt", "same", "missing"))).toBe("Did not exist; still absent");
    expect(changeLabel(file("new.txt", "unknown", "missing"))).toBe("Did not exist before; created since");
    expect(changeLabel(file("a", "later"))).toBe("Changed after the operation");
  });
});
