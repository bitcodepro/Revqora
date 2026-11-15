import { useEffect, useState } from "react";
import { EyeOff } from "lucide-react";
import { Modal } from "./Modal";
import { showDialog, toast } from "../lib/ui";
import { api, errorMessage } from "../lib/api";
import { useRepos } from "../lib/store";
import { previewTail } from "../lib/ignoreRules";
import type { IgnoreKind, IgnorePreview, IgnoreScope } from "../lib/types";

/** Reviews one ignore rule before it is written: target file, the exact line, tracked files it
 *  will not affect until they are untracked, and whether the path is already ignored. */
export function ignoreDialog(root: string, path: string, kind: IgnoreKind): Promise<void> {
  return showDialog<void>((close) => <IgnoreRule root={root} path={path} kind={kind} close={() => close()} />);
}

function IgnoreRule({ root, path, kind, close }: { root: string; path: string; kind: IgnoreKind; close: () => void }) {
  const [scope, setScope] = useState<IgnoreScope>("shared");
  const [preview, setPreview] = useState<IgnorePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [untrack, setUntrack] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    api.ignorePreview(root, path, kind, scope).then((p) => { if (alive) setPreview(p); }, (e) => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; };
  }, [root, path, kind, scope]);
  const apply = async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const result = await api.ignoreApply(root, path, kind, scope, preview.token, untrack && preview.trackedCount > 0);
      close();
      const untracked = result.untracked ? ` ${result.untracked} tracked ${result.untracked === 1 ? "file was" : "files were"} removed from Git and kept on disk; commit to share that.` : "";
      if (result.ignored) toast.success(`Added ${result.pattern} to ${result.file}`, untracked.trim() || undefined);
      else toast.warning(`Added ${result.pattern} to ${result.file}`, `A later rule in the ignore files still includes ${path}.${untracked}`);
      void useRepos.getState().refresh(root, { status: true });
    } catch (e) {
      setError(errorMessage(e));
      // The ignore file or the matched files changed after the preview: show the current state.
      const stale = (e as { kind?: string })?.kind;
      if (stale === "ignore-file-changed" || stale === "ignore-preview-stale") api.ignorePreview(root, path, kind, scope).then(setPreview, () => {});
    } finally {
      setBusy(false);
    }
  };
  const tail = preview ? previewTail(preview.before, preview.after) : null;
  return (
    <Modal title="Ignore files" subtitle={path} icon={<EyeOff size={18} />} onClose={close} onSubmit={() => void apply()} sizeKey="Ignore files"
      footer={<><button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!preview || busy} aria-busy={busy}>Add rule</button></>}>
      <div className="field">
        <span className="faint">Write the rule to</span>
        <div className="seg" role="radiogroup" aria-label="Ignore file">
          <button type="button" role="radio" aria-checked={scope === "shared"} className={scope === "shared" ? "on" : ""} onClick={() => setScope("shared")}>.gitignore (shared with the project)</button>
          <button type="button" role="radio" aria-checked={scope === "local"} className={scope === "local" ? "on" : ""} onClick={() => setScope("local")}>Only this clone (info/exclude)</button>
        </div>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      {!preview && !error && <div className="loading-center"><span className="loader" aria-label="Loading preview" /></div>}
      {preview && tail && (
        <>
          <div className="code-list ignore-preview" aria-label={`Preview of ${preview.file}`}>
            {tail.kept.length === 0 && <div className="faint">{preview.file} is empty or does not exist yet; it will be created.</div>}
            {tail.kept.map((line, i) => <div key={i}>{line || " "}</div>)}
            {tail.added.map((line, i) => <div key={`a${i}`} className="added">+ {line}</div>)}
          </div>
          {preview.alreadyIgnored && <div className="faint" role="status">{path} is already ignored by an existing rule.</div>}
          {preview.trackedCount > 0 && (
            <div className="field" role="group" aria-label="Tracked files">
              <div>Git already tracks {preview.trackedCount === 1 ? "1 file" : `${preview.trackedCount} files`} this rule matches. Ignore rules do not apply to tracked files.</div>
              <div className="code-list" style={{ maxHeight: 140 }}>{preview.tracked.join("\n")}{preview.trackedCount > preview.tracked.length ? `\n… and ${preview.trackedCount - preview.tracked.length} more` : ""}</div>
              <label className="check"><input type="checkbox" checked={untrack} onChange={(e) => setUntrack(e.target.checked)} /> Stop tracking them (they stay on disk; the removal is staged for your next commit)</label>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
