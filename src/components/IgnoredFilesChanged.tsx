import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { recoveryDialog } from "./RecoveryCenter";
import { api } from "../lib/api";
import { showDialog, toast } from "../lib/ui";
import { useRepos } from "../lib/store";

export interface IgnoredReport {
  command: string;
  /** Checkpoint with the previous content; null when the files could not be saved. */
  checkpoint: string | null;
  paths: string[];
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
          ? "Their previous content was saved in a recovery checkpoint before the operation. Restoring puts it back in place; the version Git wrote stays in Git history."
          : "There were too many ignored files to save them before the operation, so their previous content could not be kept."}
      </p>
      <div className="code-list">{report.paths.join("\n")}</div>
    </Modal>
  ));
  if (!report.checkpoint) return;
  if (choice === "recovery") return recoveryDialog(root, report.checkpoint);
  if (choice !== "restore") return;
  try {
    const n = await api.recoveryRestoreFiles(root, report.checkpoint, report.paths);
    toast.success(`Restored ${n} ignored file${n === 1 ? "" : "s"}`);
    void useRepos.getState().refresh(root, { status: true });
  } catch (e) {
    toast.error(e, "Could not restore the ignored files");
  }
}
