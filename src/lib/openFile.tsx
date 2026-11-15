import { FileCode2, Play } from "lucide-react";
import { api, isGitError } from "./api";
import { showDialog, toast } from "./ui";
import { Modal } from "../components/Modal";
import { basename } from "./format";

type Choice = "text" | "run" | null;

/**
 * Opens a repository file. Programs and scripts (.exe, .bat, .ps1, .js, ...) would run when
 * opened, so the user chooses: open them as text, or run them.
 */
export async function openRepoFile(fullPath: string): Promise<void> {
  try {
    await api.openPath(fullPath);
    return;
  } catch (e) {
    if (!isGitError(e) || e.kind !== "runnable-file") {
      toast.error(e, "Could not open the file");
      return;
    }
  }
  const name = basename(fullPath);
  const choice = await showDialog<Choice>((close) => (
    <Modal
      title={`Open ${name}?`}
      subtitle="This is a program or script. Opening it normally would run it."
      tone="warn"
      icon={<FileCode2 size={18} />}
      onClose={() => close(null)}
      onSubmit={() => close("text")}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
          <button type="button" className="btn danger" onClick={() => close("run")}><Play size={14} /> Run it</button>
          <button type="submit" className="btn primary"><FileCode2 size={14} /> Open as text</button>
        </>
      }
    >
      <div className="muted">Run it only if you trust where this file came from: a commit or pull request can add any program.</div>
    </Modal>
  ));
  try {
    if (choice === "text") await api.openPathAsText(fullPath);
    else if (choice === "run") await api.runPath(fullPath);
  } catch (e) {
    toast.error(e, "Could not open the file");
  }
}
