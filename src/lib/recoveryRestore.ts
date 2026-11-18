import type { RecoveryFileChange, RecoveryOperationStatus, RecoveryRestoreOutcome, RecoveryRestoreSummary, RecoverySavedFile } from "./types";

export const OPERATION_STATUS: Record<RecoveryOperationStatus, string> = {
  running: "Running", succeeded: "Succeeded", attention: "Needs attention", failed: "Failed", interrupted: "Interrupted",
};

/** How a saved path compares with the working tree now, in words. */
export function changeLabel(file: Pick<RecoverySavedFile, "savedKind" | "state">): string {
  if (file.savedKind === "missing") return file.state === "same" ? "Did not exist; still absent" : "Did not exist before; created since";
  const labels: Record<RecoveryFileChange, string> = {
    same: "Matches the saved copy",
    operation: "Changed by the operation",
    later: "Changed after the operation",
    unknown: "Differs; needs a manual check",
  };
  return labels[file.state];
}

/** Changed paths first (needing a check, then changed later, then by the operation), then the rest, each by path. */
export function orderSavedFiles(files: RecoverySavedFile[]): RecoverySavedFile[] {
  const rank: Record<RecoveryFileChange, number> = { unknown: 0, later: 1, operation: 2, same: 3 };
  return [...files].sort((a, b) => rank[a.state] - rank[b.state] || a.path.localeCompare(b.path));
}

/** The result of a restore, for a toast or the result panel. */
export function restoreReport(r: RecoveryRestoreOutcome, total: number): { title: string; lines: string[]; warning: boolean } {
  const lines = [
    r.restored.length ? `Restored: ${r.restored.join(", ")}` : "",
    r.keptBoth.length ? `Kept as they are, with the saved copy written beside: ${r.keptBoth.map((k) => `${k.path} → ${k.copy}`).join(", ")}` : "",
    r.unchanged.length ? `Already matched the saved copy: ${r.unchanged.join(", ")}` : "",
    r.checkpointError ? `The current versions could not be saved first (${r.checkpointError}), so no file was replaced.` : "",
    r.failed ? `Failed: ${r.failed[0]} (${r.failed[1]})` : "",
    r.notAttempted.length ? `Not attempted: ${r.notAttempted.join(", ")}` : "",
  ].filter(Boolean);
  const warning = !!r.failed || r.keptBoth.length > 0 || !!r.checkpointError || r.notAttempted.length > 0;
  const done = r.restored.length + r.unchanged.length;
  const title = warning ? `Restored ${r.restored.length} of ${total} file${total === 1 ? "" : "s"}` : `Restored ${done} file${done === 1 ? "" : "s"}`;
  return { title, lines, warning };
}

/** The last restore logged beside a checkpoint, including one the app could not finish. */
export function lastRestoreLines(last: RecoveryRestoreSummary): string[] {
  return [
    last.restored.length ? `Restored: ${last.restored.join(", ")}` : "",
    last.keptBoth.length ? `Saved copy written beside: ${last.keptBoth.map((k) => `${k.path} → ${k.copy}`).join(", ")}` : "",
    last.failed.length ? `Failed: ${last.failed.map(([path, why]) => `${path} (${why})`).join(", ")}` : "",
    !last.finished && last.notFinished.length ? `The app stopped before finishing: ${last.notFinished.join(", ")} need a manual check.` : "",
    !last.finished && !last.notFinished.length ? "The app stopped before recording the end of this restore." : "",
  ].filter(Boolean);
}
