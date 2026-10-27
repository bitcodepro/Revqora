import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage, isGitError, newOpId } from "../lib/api";
import { deletionTargetKey, type RemoteBranchTarget } from "../lib/branchDeletion";
import type { DeletionPlan, RecoverySummary, RemoteDeletionReview } from "../lib/types";
import { basename, shortOid } from "../lib/format";
import { ALL, useRepos } from "../lib/store";
import { endBusy, startBusy, toast, useUi } from "../lib/ui";
import { Modal } from "./Modal";
import { recoveryDialog } from "./RecoveryCenter";
import "../styles/branchReview.css";

const targetVersion = (t: RemoteBranchTarget | null | undefined) => t ? JSON.stringify([deletionTargetKey(t), t.pushUrl, t.trackingRef, t.oid]) : "";
const integrationText = (value: string) => value === "reachable" ? "Commits reachable from target" : value === "content-integrated" ? "Changes appear integrated (squash/rebase estimate)" : value === "not-integrated" ? "Changes not confirmed as integrated" : "Content integration could not be determined";

export function DeleteBranchDialog({ root, name, targets, expectedState, onClose }: {
  root: string; name: string; targets: RemoteBranchTarget[]; expectedState?: string | null; onClose: () => void;
}) {
  const [includeRemote, setIncludeRemote] = useState(false);
  const [selected, setSelected] = useState(targets[0] ? deletionTargetKey(targets[0]) : "");
  const [base, setBase] = useState<string>();
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [forceRequired, setForceRequired] = useState(false);
  const [force, setForce] = useState(false);
  const [localDone, setLocalDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [review, setReview] = useState<RemoteDeletionReview | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [checkpoint, setCheckpoint] = useState<RecoverySummary | null>(null);
  const version = useRef(0);
  const first = useRef(true);
  const localDoneRef = useRef(false);
  const savedLocalOid = useRef<string | undefined>(undefined);
  const target = review?.target ?? targets.find((t) => deletionTargetKey(t) === selected);
  const ready = !!plan && targetVersion(plan.proof.target) === targetVersion(target)
    && (base === undefined || (base || null) === plan.proof.baseRef);
  const resetForce = () => { setForceRequired(false); setForce(false); setError(null); };

  const loadPlan = useCallback(async (explicit = false) => {
    const v = ++version.current;
    setLoading(true); setPlan(null); setError(null); setForceRequired(false); setForce(false); setReviewConfirmed(false);
    try {
      const next = await api.branchDeletePlan(root, name, base, target ?? null, localDoneRef.current ? savedLocalOid.current : undefined);
      if (v !== version.current) return;
      savedLocalOid.current ??= next.proof.localOid;
      const changedInitially = first.current && !explicit && !!expectedState && next.stateToken !== expectedState;
      first.current = false;
      setPlan(next); setStale(changedInitially);
      if (changedInitially) setError("The repository changed while opening this confirmation. Refresh the review and inspect the new tips before deleting.");
    } catch (e) { if (v === version.current) { setError(errorMessage(e)); setStale(true); } }
    finally { if (v === version.current) setLoading(false); }
  }, [root, name, base, target, expectedState]);
  useEffect(() => { void loadPlan(!first.current); return () => { version.current++; }; }, [loadPlan]);
  const blocked = busy || loading || !ready || stale || (!localDone && !!plan?.worktrees.length)
    || (includeRemote && remoteChanged) || (forceRequired && !force)
    || (includeRemote && !!review && !reviewConfirmed) || (includeRemote && !target);
  const close = () => {
    if (busy) return;
    if (localDone) toast.warning(`Local branch ${name} deleted`, `Remote deletion of ${target?.label ?? ""} was not completed. The recovery checkpoint remains available.`);
    onClose();
  };
  const openCheckpoint = (id: string) => { onClose(); void recoveryDialog(root, id); };
  const submit = async () => {
    if (blocked || !plan) return;
    setBusy(true); setError(null);
    const id = newOpId(); startBusy(id, `Deleting ${name}`);
    let deletedLocal = localDone;
    let saved = checkpoint;
    const warnings: string[] = [];
    try {
      if (!deletedLocal) {
        const result = await api.branchDeleteReviewed(root, plan.proof, includeRemote, force, plan.stateToken);
        saved = result.checkpoint; setCheckpoint(saved);
        if (result.warning) warnings.push(result.warning);
        deletedLocal = true; localDoneRef.current = true; setLocalDone(true);
      }
      if (includeRemote && target) {
        const result = await api.branchDeleteRemoteReviewed(root, plan.proof, force || (!!review && reviewConfirmed), id);
        saved = result.checkpoint; setCheckpoint(saved);
        if (result.warning) warnings.push(result.warning);
      }
      const point = saved;
      useUi.getState().toast({ kind: warnings.length ? "warning" : "success",
        title: includeRemote ? `Deleted ${name} and ${target!.label}` : `Deleted local branch ${name}`,
        detail: [warnings.join("\n"), point ? `Recovery checkpoint ${point.id} saved` : ""].filter(Boolean).join("\n"),
        action: point ? { label: "Open recovery checkpoint", run: () => { void recoveryDialog(root, point.id); } } : undefined,
      }, 20000);
      onClose();
    } catch (e) {
      if (isGitError(e) && e.kind === "not-merged") setForceRequired(true);
      else {
        if (isGitError(e) && e.kind === "remote-changed") { setRemoteChanged(true); setReviewConfirmed(false); }
        if (isGitError(e) && ["stale-selection", "stale-operation"].includes(e.kind)) setStale(true);
        setError((deletedLocal ? "Local branch deleted. Remote deletion failed: " : "") + errorMessage(e));
      }
    } finally {
      endBusy(id); setBusy(false); await useRepos.getState().refresh(root, ALL);
    }
  };
  const refreshRemote = async () => {
    if (busy || !target) return;
    setBusy(true); setReviewConfirmed(false);
    const id = newOpId(); startBusy(id, `Refreshing ${target.label}`);
    try {
      const next = await api.branchDeleteRefresh(root, target, id);
      setReview(next); setRemoteChanged(false); setForceRequired(false); setForce(false); setError(null);
    } catch (e) { setError(errorMessage(e)); }
    finally { endBusy(id); setBusy(false); await useRepos.getState().refresh(root, ALL); }
  };
  const baseLabel = plan?.bases.find((b) => b.reference === plan.proof.baseRef)?.label ?? "no comparison target";
  return (
    <Modal title={`Delete branch ${name}?`} subtitle={basename(root)} icon={<Trash2 size={18} />} tone="danger" wide onClose={close} onSubmit={() => void submit()}
      footer={<>
        <button type="button" className="btn" disabled={busy} onClick={close}>{localDone ? "Close" : "Cancel"}</button>
        <button type="submit" className="btn danger primary delete-branch-confirm" disabled={blocked}>
          {(busy || loading) && <Loader2 size={14} className="spin" />}
          {localDone ? review ? "Delete reviewed remote branch" : "Retry remote deletion" : `${force ? "Force delete" : "Delete"} ${includeRemote ? "local & remote" : "local branch"}`}
        </button>
      </>}>
      <div className="branch-review" aria-busy={loading} data-remote-changed={remoteChanged} data-review-local-oid={ready ? plan?.proof.localOid : undefined}>
        <div className="branch-review-heading">
          <label className="field">Compare against
            <select className="input branch-review-base" aria-label="Comparison branch" value={base ?? plan?.proof.baseRef ?? ""} disabled={busy || loading}
              onChange={(e) => { setBase(e.target.value); resetForce(); setStale(false); }}>
              <option value="">No comparison target (force required)</option>
              {plan?.bases.map((b) => <option key={b.reference} value={b.reference}>{b.label}</option>)}
            </select>
          </label>
          <button type="button" className="btn refresh-branch-review" disabled={busy || loading} onClick={() => void loadPlan(true)}><RefreshCw size={14} /> Refresh review</button>
        </div>
        {loading && <div className="muted"><Loader2 size={14} className="spin" /> Loading branch history and worktrees…</div>}
        {ready && plan && <>
          <div className="branch-review-tips">
            <div><span>Local {localDone ? "(deleted)" : ""}</span><b>{name}</b><code title={plan.proof.localOid}>{shortOid(plan.proof.localOid)}</code>
              <small>{plan.localOnly === null ? "No matching remote history" : `${plan.localOnly} local-only commits`}</small></div>
            <div><span>Cached / explicitly reviewed remote</span><b>{target?.label ?? "No matching remote"}</b><code title={target?.oid}>{target ? shortOid(target.oid) : "—"}</code>
              <small>{plan.remoteOnly === null ? "Local deletion only" : `${plan.remoteOnly} remote-only commits`}</small></div>
          </div>
          <div className="branch-review-integration">
            <b>Compared with {baseLabel}{plan.proof.baseOid && <code title={plan.proof.baseOid}> · {shortOid(plan.proof.baseOid)}</code>}</b>
            <div>{plan.localUnmerged} local commits outside target · {integrationText(plan.localIntegration)}</div>
            {target && <div>{plan.remoteUnmerged} remote commits outside target · {integrationText(plan.remoteIntegration ?? "unknown")}</div>}
            {(plan.localIntegration === "content-integrated" || plan.remoteIntegration === "content-integrated") && <small className="branch-review-estimate">Content integration is an estimate. Original commit SHAs are still outside the target and require explicit force consent.</small>}
          </div>
          {plan.worktrees.length > 0 && !localDone && <div className="callout warn branch-review-worktrees">
            <b>This branch is checked out. Switch its worktree to another branch first.</b>
            {plan.worktrees.map((w) => <div key={w.path}><code>{w.path}</code><span>{w.current ? "Current worktree · " : ""}{w.dirty === null ? "State unavailable" : w.dirty ? `${w.changedFiles} changed files` : "Clean"}{w.operation && w.operation !== "none" ? ` · ${w.operation} in progress` : ""}</span>
              {w.error && <small>{w.error}</small>}<button type="button" className="btn sm" disabled={busy} onClick={() => { onClose(); void useRepos.getState().open(w.path); }}><FolderOpen size={13} /> Open worktree</button></div>)}
          </div>}
          <div className="branch-review-checkpoint"><ShieldCheck size={18} /><div><b>{checkpoint ? `Checkpoint saved: ${checkpoint.id}` : "Recovery checkpoint before deletion"}</b>
            <span>{checkpoint ? "The saved branch tips are available in Undo Center." : "The reviewed local and remote tips are pinned before removal, including a distinct push-server tip. Retention: up to 100 checkpoints / 30 days."}</span>
            <small>Reference checkpoint only. {plan.currentChanges ? `${plan.currentChanges} current working-copy changes stay in their worktree.` : "Working-copy files stay in their worktree."}</small>
            {checkpoint && <button type="button" className="btn sm" disabled={busy} onClick={() => openCheckpoint(checkpoint.id)}>Open recovery checkpoint</button>}</div></div>
        </>}
      </div>
      <label className="delete-branch-option">
        <input className="delete-remote-branch" type="checkbox" disabled={busy || localDone || !targets.length} checked={includeRemote}
          onChange={(e) => { setIncludeRemote(e.target.checked); resetForce(); }} />
        <span>Also delete remote branch{targets.length === 1 ? <b> {targets[0].label}</b> : ""}</span>
      </label>
      {targets.length > 1 && <label className="field">Remote branch
        <select className="input" aria-label="Remote branch" value={selected} disabled={busy || localDone || loading}
          onChange={(e) => { setSelected(e.target.value); setReview(null); setRemoteChanged(false); setReviewConfirmed(false); resetForce(); }}>{targets.map((t) => <option key={deletionTargetKey(t)} value={deletionTargetKey(t)}>{t.label}</option>)}</select>
      </label>}
      {!targets.length && <div className="faint">No single matching remote branch is available. Only the local branch will be deleted.</div>}
      {includeRemote && <div className="callout warn" style={{ display: "block" }}>This also deletes <b>{target?.label}</b> from the server for everyone. Reviewed tip: <code>{target?.oid.slice(0, 12)}</code>. Deletion requires this exact server SHA.</div>}
      {target && !remoteChanged && <button type="button" className="btn refresh-remote-deletion" disabled={busy || loading} onClick={() => void refreshRemote()}>Refresh remote state for review</button>}
      {forceRequired && <div className="callout warn" style={{ display: "block" }}>
        {localDone ? "The reviewed remote history is not fully reachable from the selected target." : "The reviewed history is not fully reachable from the selected target. Neither selected branch has been deleted."}
        <label className="delete-branch-option"><input className="force-delete-branch" type="checkbox" checked={force} disabled={busy || loading} onChange={(e) => setForce(e.target.checked)} /> {localDone ? "Delete the reviewed remote tip despite unmerged commits" : includeRemote ? "Force delete both branches despite unmerged commits" : "Force delete the unmerged local branch"}</label>
      </div>}
      {error && <div className="callout warn delete-branch-error">{error}</div>}
      {remoteChanged && <button type="button" className="btn refresh-remote-deletion" disabled={busy || loading} onClick={() => void refreshRemote()}>Refresh remote state for review</button>}
      {review && !remoteChanged && ready && <div className="callout warn remote-deletion-review" style={{ display: "block" }}>
        <div>Server tip: <code>{review.previousOid.slice(0, 12)}</code> → <code>{review.target.oid.slice(0, 12)}</code></div>
        <div>{review.newCommits} new commits · {review.removedCommits} previous commits absent · {plan?.remoteUnmerged} commits outside {baseLabel}</div>
        <ul style={{ margin: "8px 0", paddingLeft: 18, overflowWrap: "anywhere" }}>{review.commits.map((commit) => <li key={commit}>{commit}</li>)}</ul>
        <label className="delete-branch-option"><input className="confirm-reviewed-remote" type="checkbox" checked={reviewConfirmed} disabled={busy || loading} onChange={(e) => setReviewConfirmed(e.target.checked)} /> Delete this reviewed remote tip{(plan?.remoteUnmerged ?? 0) > 0 ? " despite its unmerged commits" : ""}</label>
      </div>}
    </Modal>
  );
}
