import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { api, errorMessage, newOpId } from "../lib/api";
import type { BranchCleanupMode, BranchCleanupRequest, BranchCleanupReview, BranchCleanupReport } from "../lib/types";
import { basename, shortOid } from "../lib/format";
import { ALL, useRepos } from "../lib/store";
import { endBusy, showDialog, startBusy } from "../lib/ui";
import { recoveryDialog } from "./RecoveryCenter";
import { Modal } from "./Modal";
import { selectedCleanupItems } from "../lib/branchCleanup";

type BranchCleanupOptions = {
  root: string; initial: BranchCleanupRequest[]; bases: { reference: string; name: string }[];
  initialBase: string; rules: string[];
};

export function reviewBranchCleanup(options: BranchCleanupOptions) {
  return showDialog<void>((close) => <BranchCleanup {...options} onClose={() => close()} />);
}

function BranchCleanup({ root, initial, bases, initialBase, rules, onClose }: BranchCleanupOptions & { onClose: () => void }) {
  const [requests, setRequests] = useState(initial);
  const [base, setBase] = useState(initialBase);
  const [compare, setCompare] = useState(false);
  const [analyze, setAnalyze] = useState(false);
  const [review, setReview] = useState<BranchCleanupReview | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [forced, setForced] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<BranchCleanupReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewedInput, setReviewedInput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createCheckpoint, setCreateCheckpoint] = useState(true);
  const [error, setError] = useState("");
  const [consumed, setConsumed] = useState(false);
  const generation = useRef(0);
  const reviewBase = analyze ? base : "";
  const input = JSON.stringify([root, requests, reviewBase, rules, analyze]);
  // A changed selection invalidates the old proof during rendering, before
  // the effect starts the next request and clears its force consents.
  const pending = loading || reviewedInput !== input;
  const load = useCallback(async () => {
    const id = ++generation.current;
    setLoading(true); setReview(null); setForced(new Set()); setError(""); setReport(null); setConsumed(false);
    try {
      const next = await api.branchCleanupReview(root, requests, reviewBase, rules, analyze);
      if (id !== generation.current) return;
      setReview(next);
    } catch (e) { if (id === generation.current) setError(errorMessage(e)); }
    finally { if (id === generation.current) { setReviewedInput(input); setLoading(false); } }
  }, [root, requests, reviewBase, rules, analyze, input]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const close = () => { if (!busy) onClose(); };
  const toggle = (old: Set<string>, reference: string, value: boolean) => { const next = new Set(old); if (value) next.add(reference); else next.delete(reference); return next; };
  const selected = selectedCleanupItems(review, excluded);
  const included = new Set(selected.map(item => item.request.reference));
  const missingConsent = analyze && selected.some(item => item.forceRequired && !forced.has(item.request.reference));
  const batchBlocker = (() => {
    const active = selected;
    const locals = new Set(active.filter(x => x.request.mode !== "remote").map(x => `refs/heads/${x.plan?.proof.name}`));
    const servers = new Set<string>();
    for (const item of active) {
      if (item.plan?.proof.baseRef && locals.has(item.plan.proof.baseRef)) return "Keep the comparison branch or choose another base before cleanup.";
      if (item.request.mode === "remote" && locals.has(`refs/heads/${item.plan?.proof.name}`)) return "A remote-only row keeps a local branch that another row deletes. Use one combined local + remote row instead.";
      const target = item.plan?.proof.target;
      if (item.request.mode !== "local" && target) {
        const key = JSON.stringify([target.pushUrl, target.remoteRef]);
        if (servers.has(key)) return `${target.label} is selected twice. Uncheck a row or change its deletion scope.`;
        servers.add(key);
      }
    }
    return "";
  })();
  const run = async () => {
    if (!review || pending || busy || consumed || !included.size || missingConsent || batchBlocker) return;
    setBusy(true); setConsumed(true); setError("");
    const id = newOpId(); startBusy(id, "Deleting selected branches");
    try {
      // The visible Delete confirmation explicitly permits unchecked history
      // when Analyze was not requested. SHA/worktree/protection checks remain.
      const selections = selected.map(x => ({ proof: x.plan.proof, mode: x.request.mode, force: !analyze || forced.has(x.request.reference) }));
      setReport(await api.branchCleanupExecute(root, selections, rules, review.stateToken, id, createCheckpoint));
    } catch (e) { setError(errorMessage(e)); }
    finally { endBusy(id); setBusy(false); await useRepos.getState().refresh(root, ALL); }
  };
  const results = report?.items;
  const sharedCheckpoints = results?.flatMap(r=>r.checkpoints).filter((cp,i,all)=>all.findIndex(x=>x.id===cp.id)===i&&all.filter(x=>x.id===cp.id).length>1)??[];
  return <Modal title={report ? "Branch cleanup results" : "Review branch cleanup"} subtitle={basename(root)} icon={<Trash2 size={18} />} tone="danger" wide onClose={close} onSubmit={() => void run()}
    footer={<><button type="button" className="btn" disabled={busy} onClick={close}>{consumed ? "Close" : "Cancel"}</button>
      {!consumed && <button type="button" className="btn" disabled={pending || busy} onClick={() => void load()}>Refresh review</button>}
      {!consumed && <button type="submit" className="btn danger primary" disabled={pending || busy || !review || !included.size || missingConsent || !!batchBlocker}>Delete {included.size} selected</button>}</>}>
    <div className="branch-cleanup" aria-busy={pending || busy} data-cleanup-analysis={!pending&&review?(analyze?"complete":"unchecked"):undefined} data-cleanup-base={!pending && review ? reviewBase : undefined}>
      {!consumed && <>
        <label className="check"><input type="checkbox" aria-label="Compare branch history before deletion" checked={compare} disabled={busy} onChange={e => {setCompare(e.target.checked);setAnalyze(false);}}/>Compare branch history before deletion (optional)</label>
        {compare && <div className="bc-analysis"><label className="field">Compare against a surviving local branch
          <select className="input" aria-label="Cleanup comparison base" value={base} disabled={busy} onChange={e => {setBase(e.target.value);setAnalyze(false);}}>
            <option value="">No comparison target (explicit consent required)</option>{bases.map(b => <option key={b.reference} value={b.reference}>{b.name}</option>)}
          </select>
        </label><button type="button" className="btn" disabled={pending||busy||!included.size} onClick={()=>{if(analyze)void load();else setAnalyze(true);}}>Analyze history</button></div>}
        {!analyze && <p className="muted">Merge status is not checked. Delete removes the selected branch references even if they contain unmerged commits. Enable comparison and click Analyze history if you want to inspect differences first.</p>}
        <p className="muted">Choose a deletion scope for each row. Remote means the actual push-server branch, not just its local cache. Cached tips must still match the server at execution.</p>
      </>}
      {pending && <div className="bc-loading" role="status"><Loader2 className="spin" size={16} /><span>{analyze?"Analyzing selected branch histories…":"Checking selected branch references and worktree protection…"}</span></div>}
      {!consumed && <label className="bc-consent"><input type="checkbox" aria-label="Create recovery checkpoint" checked={createCheckpoint} disabled={busy} onChange={e => setCreateCheckpoint(e.target.checked)} />Create recovery checkpoint</label>}
      {!consumed && requests.map((request, i) => {
        const item = review?.items[i]; const p = item?.plan;
        return <article className="bc-item" key={request.reference} data-cleanup-ref={request.reference}>
          <div className="bc-item-head"><label><input type="checkbox" aria-label={`Include ${request.reference}`} checked={included.has(request.reference)} disabled={pending || busy || !p || !!item?.error} onChange={e => setExcluded(s => toggle(s, request.reference, !e.target.checked))} /><b>{request.reference.replace(/^refs\/(heads|remotes)\//, "")}</b></label>
            <select className="input" aria-label={`Deletion scope for ${request.reference}`} value={request.mode} disabled={pending || busy || request.reference.startsWith("refs/remotes/")} onChange={e => {setAnalyze(false);setRequests(all => all.map((r, n) => n === i ? { ...r, mode: e.target.value as BranchCleanupMode } : r));}}>
              <option value="local">Local only</option><option value="remote">Remote only (keep local)</option><option value="both">Local + remote</option>
            </select>
          </div>
          {item?.error && <p className="bc-error" role="alert">{item.error}</p>}
          {p && <>
            <div className="bc-tips">{request.mode !== "remote" && <span>Local <code title={p.proof.localOid}>{shortOid(p.proof.localOid)}</code>{p.analysisPerformed && <> · {p.localUnmerged} commits outside base</>}</span>}
              {request.mode !== "local" && <span>{p.proof.target?.label} <code title={p.proof.target?.oid}>{shortOid(p.proof.target?.oid ?? "")}</code>{p.analysisPerformed && <> · {p.remoteUnmerged} commits outside base</>}</span>}
            </div>
            {p.proof.target && p.analysisPerformed && <small>↑{p.localOnly ?? "—"} local-only · ↓{p.remoteOnly ?? "—"} remote-only commits</small>}
            {!!p.currentChanges && <p className="muted">{p.currentChanges} working-copy changes stay in their worktree.</p>}
            {!!p.worktrees.length && <p className="muted">Local worktrees kept: {p.worktrees.map(w => `${w.path}${w.dirty ? " (modified)" : ""}`).join(", ")}</p>}
            {p.analysisPerformed && item?.forceRequired && <label className="bc-consent"><input type="checkbox" aria-label={`Allow unmerged deletion for ${request.reference}`} checked={forced.has(request.reference)} disabled={pending || busy || !included.has(request.reference)} onChange={e => setForced(s => toggle(s, request.reference, e.target.checked))} />Delete these exact tips despite commits outside the base. Squash/rebase integration does not guarantee original history is retained.</label>}
          </>}
        </article>;
      })}
      {!consumed && <div className="callout warn">Each actual local and remote branch is checked against protection rules before any deletion. {createCheckpoint ? "Selected tips are saved in Undo Center before deletion. Saving a checkpoint can take time; turn it off above if you do not need recovery." : "No recovery checkpoints will be created for this batch."} This is a sequence of operations: a server rejection can leave a local branch already deleted. Remaining rows stop on failure.</div>}
      {!consumed && batchBlocker && <p className="bc-error" role="alert">{batchBlocker}</p>}
      {!consumed && missingConsent && <p className="muted" role="status">Confirm unmerged deletion for the selected rows, exclude them, or turn comparison off to delete without checking merge status.</p>}
      {busy && <div className="bc-loading"><Loader2 size={16} className="spin" /><span>Deleting the selected branches…</span></div>}
      {report?.preflightFailed && <p className="callout warn" role="alert">Preflight failed. Nothing was deleted. Close this result and prepare a new review.</p>}
      {results && <>
        {!createCheckpoint && <p className="muted">Recovery checkpoints were disabled for this batch.</p>}
        <p className="bc-summary">{results.filter(x => x.status === "deleted").length} completed · {results.filter(x => x.status === "partial").length} partial · {results.filter(x => x.status === "failed").length} failed · {results.filter(x => x.status === "skipped").length} skipped</p>
        {sharedCheckpoints.map(cp=><button key={cp.id} type="button" className="btn" onClick={()=>{onClose();void recoveryDialog(root,cp.id);}}>Open batch recovery checkpoint {cp.id}</button>)}
        {results.map((r, i) => <article className="bc-item" key={i} data-cleanup-status={r.status}><b>{r.name} · {r.status}</b>
          <p>Local: {r.localDeleted ? "deleted" : "kept"} · Remote: {r.remoteDeleted ? "deleted" : "kept"}</p>{r.message && <p className="bc-error">{r.message}</p>}
          {r.checkpoints.filter(cp=>!sharedCheckpoints.some(s=>s.id===cp.id)).map(cp => <button key={cp.id} type="button" className="btn" onClick={() => { onClose(); void recoveryDialog(root, cp.id); }}>Open recovery checkpoint {cp.id}</button>)}
        </article>)}
      </>}
      {error && <p className="bc-error" role="alert">{error}{consumed && " Close and prepare a fresh review before retrying."}</p>}
    </div>
  </Modal>;
}
