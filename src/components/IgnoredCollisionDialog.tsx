import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { api } from "../lib/api";
import { joinPath } from "../lib/format";
import { showDialog, toast } from "../lib/ui";
import { confirmDialog } from "./dialogs";
import { Modal } from "./Modal";
import { repositoryFiles } from "./RepositoryFiles";

/** Incoming/local path pairs from an "ignored-collision" error. */
export function collisionPairs(details: string[]) {
  const pairs: { incoming: string; local: string }[] = [];
  for (let i = 0; i < details.length; i += 2) pairs.push({ incoming: details[i], local: details[i + 1] ?? details[i] });
  return pairs;
}

/**
 * Git may overwrite local ignored or untracked paths. Nothing is removed automatically: the user
 * saves a verified copy and continues, continues at their own risk (confirmed twice), or cancels.
 */
export async function collisionDecisionDialog(root: string, message: string, details: string[]): Promise<"copy" | "risk" | null> {
  const pairs = collisionPairs(details);
  const local = pairs.map((p) => p.local);
  const choice = await showDialog<"copy" | "risk" | null>((close) => <CollisionDialog root={root} message={message} pairs={pairs} close={close} />);
  if (choice !== "risk") return choice;
  const sure = await confirmDialog({
    title: "Continue without a copy?",
    danger: true,
    confirm: "Continue without a copy",
    message: "Git may overwrite or delete these local paths and Revqora will not be able to restore them.",
    details: local,
  });
  return sure ? "risk" : null;
}

function CollisionDialog({ root, message, pairs, close }: { root: string; message: string; pairs: { incoming: string; local: string }[]; close: (v: "copy" | "risk" | null) => void }) {
  const [selected, setSelected] = useState(0);
  const current = pairs[selected];
  return <Modal title="Local files are in the way" tone="warn" wide onClose={() => close(null)} footer={<>
    <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
    <button type="button" className="btn danger" onClick={() => close("risk")}>Continue without a copy</button>
    <button type="button" className="btn primary" onClick={() => close("copy")}>Save a copy and continue</button>
  </>}>
    <p>{message}</p>
    <p className="muted">Save a copy and continue: Revqora copies these paths into a recovery checkpoint outside the working tree and verifies it before Git runs. Afterwards you can compare, open or restore the copy; it is never applied automatically. If the copy cannot be made, nothing runs and you choose again.</p>
    <table className="table">
      <thead><tr><th>Local path</th><th>Incoming path</th></tr></thead>
      <tbody>{pairs.map((p, i) => <tr key={p.local} className={i === selected ? "selected" : ""} onClick={() => setSelected(i)}>
        <td className="selectable" style={{ overflowWrap: "anywhere" }}>{p.local}</td>
        <td className="selectable" style={{ overflowWrap: "anywhere" }}>{p.incoming}</td>
      </tr>)}</tbody>
    </table>
    <div className="hstack">
      <button type="button" className="btn" onClick={() => void api.revealPath(joinPath(root, current.local)).catch((e) => toast.error(e))}><FolderOpen size={14} /> Show local path</button>
      <button type="button" className="btn" onClick={() => void repositoryFiles(root, "ignored")}>Inspect ignored files…</button>
    </div>
    <p className="muted">Changing .gitignore does not preserve or remove the conflicting data.</p>
  </Modal>;
}
