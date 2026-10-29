import { useState } from "react";
import { ArrowDownUp, CircleAlert } from "lucide-react";
import { api, errorMessage, newOpId } from "../lib/api";
import { basename, shortOid } from "../lib/format";
import { useRepos } from "../lib/store";
import type { SyncPlan } from "../lib/types";
import { endBusy, showDialog, startBusy, toast, useUi } from "../lib/ui";
import { Modal } from "./Modal";
import { recoveryDialog } from "./RecoveryCenter";

interface ReviewRow { root: string; plan?: SyncPlan; error?: string }
interface Choice { root: string; plan: SyncPlan; receive: boolean; send: boolean }
let reviewing = false;
export async function syncRepositories(roots: string[]) {
  if (reviewing || useUi.getState().busy.length || !roots.length) return;
  reviewing = true;
  const rows: ReviewRow[] = [], busy = newOpId();
  startBusy(busy, "Preparing Sync review");
  try {
    for (const root of new Set(roots)) {
      if (!useRepos.getState().tabs[root]) { rows.push({ root, error: "Repository is closed" }); continue; }
      try { rows.push({ root, plan: await api.syncPrepare(root) }); }
      catch (e) { rows.push({ root, error: errorMessage(e) }); }
    }
  } finally { endBusy(busy); }
  try {
    const choices = await showDialog<Choice[] | null>((close) => <SyncReview rows={rows} close={close} />);
    if (!choices?.length) return;
    startBusy(busy, "Synchronizing reviewed branches");
    const results: { root: string; message: string; warning: boolean; checkpoint?: string }[] = [];
    try {
      for (const choice of choices) {
        if (!useRepos.getState().tabs[choice.root]) { results.push({ root: choice.root, message: "Skipped: repository was closed", warning: true }); continue; }
        try {
          const out = await api.syncExecute(choice.root, choice.plan, choice.receive, choice.send);
          results.push({ root: choice.root, message: [out.received ? "Incoming commits received" : null, out.sent ? "Outgoing commits sent" : null, ...out.warnings].filter(Boolean).join(" · "), warning: out.warnings.length > 0 || (!out.received && !out.sent), checkpoint: out.checkpoint.id });
        } catch (e) { results.push({ root: choice.root, message: errorMessage(e), warning: true }); }
        await useRepos.getState().refresh(choice.root).catch(() => {});
      }
    } finally { endBusy(busy); }
    await showDialog<void>((close) => <Modal title="Sync results" subtitle={`${results.filter((r) => !r.warning).length} completed · ${results.filter((r) => r.warning).length} need attention · ${rows.length - choices.length} skipped`} wide onClose={close} footer={<button type="button" className="btn primary" onClick={() => close()}>Done</button>}>
      <div className="batch-list">{results.map((r) => <div className="batch-row" key={r.root}>{r.warning && <CircleAlert size={16} className="amber" />}<div className="grow-text"><b>{basename(r.root)}</b><div className="batch-note">{r.message}</div>{r.checkpoint && <div className="batch-note">Recovery checkpoint: {r.checkpoint}</div>}</div>{r.checkpoint && <button type="button" className="btn sm" onClick={() => void recoveryDialog(r.root)}>Undo Center</button>}</div>)}</div>
    </Modal>);
  } catch (e) { toast.error("Sync failed", errorMessage(e)); }
  finally { reviewing = false; }
}
function SyncReview({ rows, close }: { rows: ReviewRow[]; close: (choices: Choice[] | null) => void }) {
  const [selected, setSelected] = useState<Record<string, { receive: boolean; send: boolean }>>(() => Object.fromEntries(rows.map((r) => [r.root, { receive: !!r.plan?.behind, send: false }])));
  const choices = rows.flatMap((r): Choice[] => r.plan && (selected[r.root].receive || selected[r.root].send) ? [{ root: r.root, plan: r.plan, ...selected[r.root] }] : []);
  return <Modal title="Review Sync" wide subtitle="Checked-out upstream branches · incoming and outgoing actions are explicit" onClose={() => close(null)} onSubmit={() => choices.length && close(choices)} footer={<><button type="button" className="btn" onClick={() => close(null)}>Cancel</button><button type="submit" className="btn primary" disabled={!choices.length}>Sync selected ({choices.length})</button></>}>
    <div className="callout">Incoming commits are fast-forwarded to the exact reviewed revision. Select Send to publish outgoing commits. Local changes, diverged branches and ambiguous upstreams require individual attention. A recovery checkpoint is saved before each action.</div>
    <div className="batch-list">{rows.map((r) => <div className="sync-review-row" key={r.root} data-root={r.root}><div><b>{basename(r.root)}</b><div className="batch-note library-path" title={r.root}>{r.root}</div>{r.plan && <div className="batch-note">{r.plan.branch} → {r.plan.target.label} · {r.plan.behind} incoming / {r.plan.ahead} outgoing<br />Local {shortOid(r.plan.localOid)} · Server {shortOid(r.plan.serverOid)}<br />{r.plan.target.remoteRef}</div>}{r.error && <div className="batch-note amber">Skipped: {r.error}</div>}</div>
      {r.plan && <div className="sync-directions">{r.plan.behind > 0 && <label><input type="checkbox" checked={selected[r.root].receive} onChange={(e) => setSelected((s) => ({ ...s, [r.root]: { ...s[r.root], receive: e.target.checked } }))} /> Receive {r.plan.behind}</label>}{r.plan.ahead > 0 && <label><input type="checkbox" checked={selected[r.root].send} onChange={(e) => setSelected((s) => ({ ...s, [r.root]: { ...s[r.root], send: e.target.checked } }))} /> Send {r.plan.ahead}</label>}{!r.plan.ahead && !r.plan.behind && <span className="faint">Up to date</span>}</div>}
    </div>)}</div>
  </Modal>;
}
export function SyncButton({ roots, label = "Sync" }: { roots: string[]; label?: string }) {
  const busy = useUi((s) => s.busy.length > 0);
  return <button type="button" className="btn sm" disabled={busy || !roots.length} onClick={() => void syncRepositories(roots)}><ArrowDownUp size={13} /> {label}</button>;
}
