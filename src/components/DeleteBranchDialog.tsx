import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { api, errorMessage, isGitError, newOpId } from "../lib/api";
import { deletionTargetKey, remoteDeletionRefspec, type RemoteBranchTarget } from "../lib/branchDeletion";
import { basename } from "../lib/format";
import { ALL, useRepos } from "../lib/store";
import { endBusy, startBusy, toast } from "../lib/ui";
import { Modal } from "./Modal";

export function DeleteBranchDialog({ root, name, targets, expectedState, onClose }: {
  root: string; name: string; targets: RemoteBranchTarget[]; expectedState?: string | null; onClose: () => void;
}) {
  const [includeRemote, setIncludeRemote] = useState(false);
  const [selected, setSelected] = useState(targets[0] ? deletionTargetKey(targets[0]) : "");
  const [forceRequired, setForceRequired] = useState(false);
  const [force, setForce] = useState(false);
  const [localDone, setLocalDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((t) => deletionTargetKey(t) === selected);
  const resetForce = () => { setForceRequired(false); setForce(false); setError(null); };
  const close = () => {
    if (busy) return;
    if (localDone) toast.warning(`Local branch ${name} deleted`, `Remote deletion of ${target?.label ?? ""} was not confirmed.`);
    onClose();
  };
  const submit = async () => {
    if (busy || (forceRequired && !force && !localDone) || (includeRemote && !target)) return;
    setBusy(true);
    setError(null);
    const id = newOpId();
    startBusy(id, `Deleting ${name}`);
    let deletedLocal = localDone;
    try {
      // Do not touch the server if Git refuses an unmerged or checked-out local branch.
      if (!deletedLocal) {
        await api.branchDelete(root, name, force, includeRemote ? target! : null, expectedState);
        deletedLocal = true;
        setLocalDone(true);
      }
      if (includeRemote && target) {
        const retryState = localDone ? (await api.status(root)).stateToken : undefined;
        await api.pushRef(root, target.remote, remoteDeletionRefspec(target), id, retryState);
      }
      toast.success(includeRemote ? `Deleted ${name} and ${target!.label}` : `Deleted local branch ${name}`);
      onClose();
    } catch (e) {
      if (!deletedLocal && isGitError(e) && e.kind === "not-merged") setForceRequired(true);
      else setError((deletedLocal ? `Local branch deleted. Remote deletion failed: ` : "") + errorMessage(e));
    } finally {
      endBusy(id);
      setBusy(false);
      await useRepos.getState().refresh(root, ALL);
    }
  };
  return (
    <Modal title={`Delete branch ${name}?`} subtitle={basename(root)} icon={<Trash2 size={18} />} tone="danger" onClose={close} onSubmit={() => void submit()}
      footer={<>
        <button type="button" className="btn" disabled={busy} onClick={close}>{localDone ? "Close" : "Cancel"}</button>
        <button type="submit" className="btn danger primary delete-branch-confirm" disabled={busy || (forceRequired && !force && !localDone)}>
          {busy && <Loader2 size={14} className="spin" />}
          {localDone ? "Retry remote deletion" : `${force ? "Force delete" : "Delete"} ${includeRemote ? "local & remote" : "local branch"}`}
        </button>
      </>}>
      <p className="muted" style={{ margin: 0 }}>Remove the local branch label. Commits remain available through other branches or the reflog.</p>
      <label className="delete-branch-option">
        <input className="delete-remote-branch" type="checkbox" disabled={busy || localDone || !targets.length} checked={includeRemote} onChange={(e) => { setIncludeRemote(e.target.checked); resetForce(); }} />
        <span>Also delete remote branch{targets.length === 1 ? <b> {targets[0].label}</b> : ""}</span>
      </label>
      {includeRemote && targets.length > 1 && <label className="field">Remote branch
        <select className="input" value={selected} disabled={busy || localDone} onChange={(e) => { setSelected(e.target.value); resetForce(); }}>{targets.map((t) => <option key={deletionTargetKey(t)} value={deletionTargetKey(t)}>{t.label}</option>)}</select>
      </label>}
      {!targets.length && <div className="faint">No single matching remote branch is available. Only the local branch will be deleted.</div>}
      {includeRemote && <div className="callout warn">This also deletes <b>{target?.label}</b> from the server for everyone.</div>}
      {forceRequired && !localDone && <div className="callout warn">
        {includeRemote ? "Branch history is not fully merged into the current checkout. Neither branch has been deleted." : "This local branch is not fully merged. It has not been deleted."}
        <label className="delete-branch-option"><input className="force-delete-branch" type="checkbox" checked={force} disabled={busy} onChange={(e) => setForce(e.target.checked)} /> {includeRemote ? "Force delete both branches despite unmerged commits" : "Force delete the unmerged local branch"}</label>
      </div>}
      {error && <div className="callout warn delete-branch-error">{error}</div>}
    </Modal>
  );
}
