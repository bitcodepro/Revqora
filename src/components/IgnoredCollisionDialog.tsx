import { FolderOpen } from "lucide-react";
import { api } from "../lib/api";
import { joinPath } from "../lib/format";
import { showDialog, toast } from "../lib/ui";
import type { GitError } from "../lib/types";
import { Modal } from "./Modal";
import { repositoryFiles } from "./RepositoryFiles";

/** No automatic deletion: ignored files can contain irreplaceable local data. */
export function ignoredCollisionDialog(root: string, error: GitError) {
  const [incoming, local] = error.details;
  return showDialog<boolean>((close) => <Modal title="Pull stopped to protect local files" tone="warn" onClose={() => close(false)} footer={<>
    <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
    <button type="button" className="btn primary" onClick={() => close(true)}>Retry Pull</button>
  </>}>
    <p>A local file or folder overlaps an incoming change. Ignored files can contain personal settings or build data. Revqora has kept your local data.</p>
    <p><strong>Local path</strong><br /><span className="selectable" style={{ overflowWrap: "anywhere" }}>{joinPath(root, local ?? incoming ?? "")}</span></p>
    <p><strong>Incoming path</strong><br /><span className="selectable" style={{ overflowWrap: "anywhere" }}>{incoming}</span></p>
    <ol><li>Open the location and inspect the conflicting data.</li><li>Move it outside the repository to keep a copy. Compare or restore any needed content after pulling.</li><li>Choose Retry Pull. The application will check the repository again before updating it.</li></ol>
    <div className="hstack">
      <button type="button" className="btn" onClick={() => void api.revealPath(joinPath(root, local ?? incoming ?? "")).catch((e) => toast.error(e))}><FolderOpen size={14} /> Show local path</button>
      <button type="button" className="btn" onClick={() => void repositoryFiles(root, "ignored")}>Inspect ignored files…</button>
    </div>
    <p className="muted">Changing .gitignore does not preserve or remove the conflicting data.</p>
  </Modal>);
}
