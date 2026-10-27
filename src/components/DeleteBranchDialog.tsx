import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { api, errorMessage, isGitError, newOpId } from "../lib/api";
import { deletionTargetKey, type RemoteBranchTarget } from "../lib/branchDeletion";
import type { RemoteDeletionReview } from "../lib/types";
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
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [review, setReview] = useState<RemoteDeletionReview | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const target = review?.target ?? targets.find((t) => deletionTargetKey(t) === selected);
  const blocked = busy || remoteChanged || (forceRequired && !force) || (!!review && !reviewConfirmed) || (includeRemote && !target);
  const resetForce = () => { setForceRequired(false); setForce(false); setError(null); };
  const close = () => {
    if (busy) return;
    if (localDone) toast.warning(`Local branch ${name} deleted`, `Remote deletion of ${target?.label ?? ""} was not confirmed.`);
    onClose();
  };
  const submit = async () => {
    if (blocked) return;
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
        await api.branchDeleteRemote(root, target, force || (!!review && reviewConfirmed), id);
      }
      toast.success(includeRemote ? `Deleted ${name} and ${target!.label}` : `Deleted local branch ${name}`);
      onClose();
    } catch (e) {
      if (isGitError(e) && e.kind === "not-merged") setForceRequired(true);
      else {
        if (isGitError(e) && e.kind === "remote-changed") { setRemoteChanged(true); setReviewConfirmed(false); }
        setError((deletedLocal ? `Local branch deleted. Remote deletion failed: ` : "") + errorMessage(e));
      }
    } finally {
      endBusy(id);
      setBusy(false);
      await useRepos.getState().refresh(root, ALL);
    }
  };
  const refreshRemote = async () => {
    if (busy || !target) return;
    setBusy(true);
    setReviewConfirmed(false);
    const id = newOpId();
    startBusy(id, `Refreshing ${target.label}`);
    try {
      const next = await api.branchDeleteRefresh(root, target, id);
      setReview(next);
      setRemoteChanged(false);
      setForceRequired(false);
      setForce(false);
      setError(null);
    } catch (e) { setError(errorMessage(e)); }
    finally { endBusy(id); setBusy(false); await useRepos.getState().refresh(root, ALL); }
  };
  return (
    <Modal title={`Delete branch ${name}?`} subtitle={basename(root)} icon={<Trash2 size={18} />} tone="danger" onClose={close} onSubmit={() => void submit()}
      footer={<>
        <button type="button" className="btn" disabled={busy} onClick={close}>{localDone ? "Close" : "Cancel"}</button>
        <button type="submit" className="btn danger primary delete-branch-confirm" disabled={blocked}>
          {busy && <Loader2 size={14} className="spin" />}
          {localDone ? review ? "Delete reviewed remote branch" : "Retry remote deletion" : `${force ? "Force delete" : "Delete"} ${includeRemote ? "local & remote" : "local branch"}`}
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
      {includeRemote && <div className="callout warn" style={{ display: "block" }}>This also deletes <b>{target?.label}</b> from the server for everyone. Reviewed tip: <code>{target?.oid.slice(0, 12)}</code>.</div>}
      {forceRequired && <div className="callout warn" style={{ display: "block" }}>
        {localDone ? "The remote tip is not fully merged into the current checkout. The remote branch has not been deleted." : includeRemote ? "Branch history is not fully merged into the current checkout. Neither branch has been deleted." : "This local branch is not fully merged. It has not been deleted."}
        <label className="delete-branch-option"><input className="force-delete-branch" type="checkbox" checked={force} disabled={busy} onChange={(e) => setForce(e.target.checked)} /> {localDone ? "Delete the reviewed remote tip despite unmerged commits" : includeRemote ? "Force delete both branches despite unmerged commits" : "Force delete the unmerged local branch"}</label>
      </div>}
      {error && <div className="callout warn delete-branch-error">{error}</div>}
      {remoteChanged && <button type="button" className="btn refresh-remote-deletion" disabled={busy} onClick={() => void refreshRemote()}>Refresh remote state for review</button>}
      {review && !remoteChanged && <div className="callout warn remote-deletion-review" style={{ display: "block" }}>
        <div>Server tip: <code>{review.previousOid.slice(0, 12)}</code> → <code>{review.target.oid.slice(0, 12)}</code></div>
        <div>{review.newCommits} new commits · {review.removedCommits} previous commits absent · {review.unmergedCommits} commits outside the current checkout</div>
        <ul style={{ margin: "8px 0", paddingLeft: 18, overflowWrap: "anywhere" }}>{review.commits.map((commit) => <li key={commit}>{commit}</li>)}</ul>
        <label className="delete-branch-option"><input className="confirm-reviewed-remote" type="checkbox" checked={reviewConfirmed} disabled={busy} onChange={(e) => setReviewConfirmed(e.target.checked)} /> Delete this reviewed remote tip{review.unmergedCommits > 0 ? " despite its unmerged commits" : ""}</label>
      </div>}
    </Modal>
  );
}
