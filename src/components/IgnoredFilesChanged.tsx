import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { recoveryDialog } from "./RecoveryCenter";
import { confirmDialog } from "./dialogs";
import { api } from "../lib/api";
import { showDialog, toast } from "../lib/ui";
import { useRepos } from "../lib/store";

export interface IgnoredChange {
  path: string;
  exists: boolean;
  sha256: string | null;
  len: number;
}

export interface IgnoredReport {
  command: string;
  /** Checkpoint with the previous content; null when the user accepted running without one. */
  checkpoint: string | null;
  paths: string[];
  changes: IgnoredChange[];
}

export interface RestoreOutcome {
  restored: string[];
  changedSince: string[];
  failed: [string, string] | null;
  notAttempted: string[];
}

/** Before an operation: ignored files could not be saved. The user accepts exactly this list. */
export function confirmUnprotectedDialog(_root: string, message: string, paths: string[]): Promise<boolean> {
  return confirmDialog({
    title: "Ignored files cannot be saved",
    danger: true,
    confirm: "Run without a copy",
    message: `${message} Continue only if you do not need these files, or move them out of the repository first.`,
    details: paths,
  });
}

/** Shown after an operation in which Git overwrote or deleted ignored files. */
export async function ignoredFilesChangedDialog(root: string, report: IgnoredReport) {
  const action = report.command.replace(/_/g, " ");
  const choice = await showDialog<"restore" | "recovery" | "keep">((close) => (
    <Modal
      title="Git changed ignored files"
      subtitle={`During ${action}, Git overwrote or deleted ${report.paths.length === 1 ? "an ignored file" : `${report.paths.length} ignored files`}.`}
      icon={<AlertTriangle size={18} />}
      tone="warn"
      onClose={() => close("keep")}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close("keep")}>
            Keep Git's version
          </button>
          {report.checkpoint && (
            <>
              <button type="button" className="btn" onClick={() => close("recovery")}>
                Open Recovery
              </button>
              <button type="button" className="btn primary" onClick={() => close("restore")}>
                Restore saved copies
              </button>
            </>
          )}
        </>
      }
    >
      <p className="muted">
        {report.checkpoint
          ? "Their previous content and permissions were saved in a recovery checkpoint before the operation; it stays available in Recovery. Restoring replaces the version Git wrote. A file you changed after the operation is left as it is."
          : "You chose to run this operation without saving them, so their previous content cannot be restored."}
      </p>
      <div className="code-list">{report.paths.join("\n")}</div>
    </Modal>
  ));
  if (!report.checkpoint) return;
  if (choice === "recovery") return recoveryDialog(root, report.checkpoint);
  if (choice !== "restore") return;
  try {
    const r = await api.recoveryRestoreFiles(root, report.checkpoint, report.changes);
    const lines = [
      r.restored.length ? `Restored: ${r.restored.join(", ")}` : "",
      r.changedSince.length ? `Left as they are (changed after the operation): ${r.changedSince.join(", ")}` : "",
      r.failed ? `Failed: ${r.failed[0]} (${r.failed[1]})` : "",
      r.notAttempted.length ? `Not attempted: ${r.notAttempted.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    if (r.failed || r.changedSince.length) toast.warning(`Restored ${r.restored.length} of ${report.changes.length} ignored files`, lines);
    else toast.success(`Restored ${r.restored.length} ignored file${r.restored.length === 1 ? "" : "s"}`);
    void useRepos.getState().refresh(root, { status: true });
  } catch (e) {
    toast.error(e, "Could not restore the ignored files");
  }
}
