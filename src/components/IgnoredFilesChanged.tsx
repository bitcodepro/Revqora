import { useState } from "react";
import { AlertTriangle, FolderOpen, GitCompareArrows } from "lucide-react";
import { DiffView } from "./DiffView";
import { joinPath } from "../lib/format";
import type { FileDiff } from "../lib/types";
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

/** Each changed file with where it is now and a comparison with its saved copy. */
function ChangedList({ root, checkpoint, changes }: { root: string; checkpoint: string; changes: IgnoredChange[] }) {
  return <div className="vstack">
    {changes.map((c) => <div key={c.path} className="hstack">
      <span className="selectable grow" style={{ overflowWrap: "anywhere" }}>{c.path}{c.exists ? "" : " (deleted)"}</span>
      {c.exists && <button type="button" className="btn" onClick={() => void api.revealPath(joinPath(root, c.path)).catch((e) => toast.error(e))}><FolderOpen size={14} /> Show</button>}
      <button type="button" className="btn" onClick={() => void compareSavedDialog(root, checkpoint, c.path)}><GitCompareArrows size={14} /> Compare</button>
    </div>)}
  </div>;
}

/** Saved copy (before the operation) against the file now. */
export async function compareSavedDialog(root: string, checkpoint: string, path: string) {
  let diff: FileDiff;
  try {
    diff = await api.recoveryCompareSaved(root, checkpoint, path);
  } catch (e) {
    if ((e as { kind?: string })?.kind === "identical") toast.info("No differences", `${path} matches its saved copy.`);
    else toast.error(e, "Could not compare the saved copy");
    return;
  }
  await showDialog<void>((close) => <CompareModal path={path} diff={diff} root={root} close={close} />);
}

function CompareModal({ path, diff, root, close }: { path: string; diff: FileDiff; root: string; close: () => void }) {
  const [d] = useState(diff);
  return <Modal title={`Saved copy → current: ${path}`} wide onClose={close} footer={<button type="button" className="btn" onClick={close}>Close</button>}>
    <div style={{ height: "60vh", display: "flex" }}><DiffView diff={d} mode="pick" path={path} root={root} /></div>
  </Modal>;
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
      {report.checkpoint ? <ChangedList root={root} checkpoint={report.checkpoint} changes={report.changes} /> : <div className="code-list">{report.paths.join("\n")}</div>}
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
