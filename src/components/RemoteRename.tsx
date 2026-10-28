import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { showDialog, toast } from "../lib/ui";
import { useRepos } from "../lib/store";
import type { RemoteRenamePlan, RemoteRenameResult } from "../lib/types";
import { Modal } from "./Modal";

export function renameRemoteBranch(root: string, tracking: string) {
  return showDialog<void>((close) => <RemoteRename root={root} tracking={tracking} close={close} />);
}

function RemoteRename({ root, tracking, close }: { root: string; tracking: string; close: () => void }) {
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<RemoteRenamePlan | null>(null);
  const [result, setResult] = useState<RemoteRenameResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const review = async () => {
    setBusy(true); setPlan(null); setAck(false);
    try { setPlan(await api.remoteRenamePlan(root, tracking.startsWith("refs/") ? tracking : `refs/remotes/${tracking}`, name.trim())); } catch (e) { toast.error(e, "Could not prepare remote rename"); } finally { setBusy(false); }
  };
  const rename = async () => {
    if (!plan || !ack) return;
    setBusy(true);
    try { setResult(await api.remoteBranchRename(root, plan)); await useRepos.getState().refresh(root); }
    catch (e) { toast.error(e, "Remote rename needs review"); setPlan(null); setAck(false); }
    finally { setBusy(false); }
  };
  return <Modal title="Rename remote branch" wide onClose={busy ? () => {} : close} footer={<>
    <button className="btn" disabled={busy} onClick={close}>Close</button>
    {!result && <button className="btn primary" disabled={busy || !name.trim() || (!!plan && !ack)} onClick={() => void (plan ? rename() : review())}>
      {busy && <Loader2 size={14} className="spin" />} {plan ? "Rename on server" : "Review rename"}
    </button>}
  </>}>
    {!result ? <>
      <label className="vstack">New server branch name<input className="input" aria-label="New remote branch name" disabled={busy || !!plan} value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/new-name" /></label>
      {plan ? <>
        <div className="hstack selectable"><b>{plan.target.label}</b><ArrowRight size={16} /><b>{plan.target.remote}/{name.trim()}</b></div>
        <div className="muted selectable">Server commit: {plan.serverOid}</div>
        <div className="callout warn">This creates the new server branch and deletes the old one in one atomic push. The server must allow both actions. Local branch names stay the same.</div>
        <label className="hstack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Rename this server branch and preserve its reviewed commit in Undo Center</label>
        <button className="btn sm" disabled={busy} onClick={() => { setPlan(null); setAck(false); }}>Change name / refresh review</button>
      </> : <p className="muted">Review reads the actual push server. Existing destination branches are refused; a changed source SHA requires a fresh review.</p>}
    </> : <>
      <div className="callout">The server branch was renamed. Recovery checkpoint: <span className="selectable">{result.checkpoint.id}</span></div>
      {result.warnings.map((w) => <div className="callout warn" key={w}>{w}</div>)}
      {result.trackingRef && result.localBranches.map((branch) => <div className="hstack" key={branch}><span style={{ flex: 1 }}>{branch} still tracks the old name</span><button className="btn sm" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await api.branchSetUpstream(root, branch, result.trackingRef!); await useRepos.getState().refresh(root); setResult((r) => r && ({ ...r, localBranches: r.localBranches.filter((b) => b !== branch) })); toast.success("Upstream updated"); }
        catch (e) { toast.error(e); } finally { setBusy(false); }
      }}>Use renamed upstream</button></div>)}
    </>}
  </Modal>;
}
