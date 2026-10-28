import { useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useRepos } from "../lib/store";
import { api, errorMessage } from "../lib/api";
import type { StudioReport, StudioComparison } from "../lib/types";
import { closeOverlay, openOverlay, showDialog, toast } from "../lib/ui";
import { shortOid } from "../lib/format";
import { recoveryDialog } from "./RecoveryCenter";
import { Modal } from "./Modal";
import { CommitMessageDialog } from "./CommitMessage";
import "../styles/rebaseStudio.css";

export const studioRefName = (name: string) => name.replace(/^refs\/(heads|tags|remotes)\//, "");
export function rebaseResultDialog(root: string, id?: string) {
  return showDialog<void>((close) => <SavedResult root={root} id={id} close={close} />);
}
function SavedResult({ root, id, close }: { root: string; id?: string; close: () => void }) {
  const [report, setReport] = useState<StudioReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true; setLoaded(false); setError(null);
    void api.rebaseStudioReport(root).then((r) => {
      if (!alive) return;
      if (id && r?.id !== id) { setError("A newer Studio session replaced this report. Older checkpoints remain in Undo Center."); setReport(null); }
      else setReport(r);
      setLoaded(true);
    }, (e) => { if (alive) { setError(errorMessage(e)); setLoaded(true); } });
    return () => { alive = false; };
  }, [root, id, version]);
  return <Modal title="Rebase Studio result" wide onClose={close} footer={<><button className="btn" onClick={() => setVersion((v) => v + 1)}><RefreshCw size={14} /> Refresh</button><button className="btn" onClick={close}>Close</button></>}>
    {!loaded ? <div className="loading-center"><Loader2 className="spin" /></div> : error ? <div className="callout danger">{error}</div> : report ? <RebaseResultBody root={root} initial={report} dismiss={close} /> : <div className="empty">No Rebase Studio session is saved for this worktree.</div>}
  </Modal>;
}
const phase = (p: string) => ({ completed: "History rewritten", aborted: "Rebase aborted", paused: "Rebase paused", captured: "Current HEAD associated by you", failed: "Git reported a failure", unconfirmed: "Result needs confirmation", preparing: "Preparing rebase" }[p] ?? p);
export function RebaseResultBody({ root, initial, dismiss = closeOverlay }: { root: string; initial: StudioReport; dismiss?: () => void }) {
  const [report, setReport] = useState(initial);
  const [comparison, setComparison] = useState<StudioComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  useEffect(() => { setReport(initial); setAck(false); }, [initial]);
  useEffect(() => {
    let alive = true; setComparison(null); setError(null);
    if (report.afterHead) void api.rebaseStudioComparison(root, report.id).then((c) => { if (alive) setComparison(c); }, (e) => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; };
  }, [root, report.id, report.afterHead, report.updatedAt]);
  const checkpoint = (id: string) => { dismiss(); void recoveryDialog(root, id); };
  return <div className="studio-result vstack" data-session-id={report.id} data-phase={report.phase}>
    <div className="studio-summary"><ShieldCheck size={19} /><div><b>{phase(report.phase)}</b><div className="muted">{report.review.branchRef ? studioRefName(report.review.branchRef) : "Detached HEAD"} · {new Date(report.updatedAt).toLocaleString()}</div></div></div>
    <div className="studio-grid"><div className="studio-card"><small>Before</small><code className="selectable">{report.review.head}</code></div><div className="studio-card"><small>Recorded result</small><code className="selectable">{report.afterHead ?? "Not recorded yet"}</code></div></div>
    {report.warning && <div className="callout warn">{report.warning}</div>}
    {report.error && <div className="callout warn">Git: {report.error}</div>}
    {report.phase === "paused" && <div className="callout">Finish, skip or abort the current Git operation using its operation banner. This checkpoint and report remain available after restarting Revqora.</div>}
    {report.phase === "unconfirmed" && <div className="callout warn">The session could not be matched to an active rebase. It may have finished through another Git client or after an interrupted app session. Its original checkpoint is preserved.</div>}
    {report.candidateHead && <div className="studio-card vstack"><span>Current candidate: <code>{report.candidateHead}</code></span><label className="hstack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Associate this HEAD with the saved session. External completion was not automatically verified.</label><button className="btn" disabled={!ack || busy} onClick={async () => {
      setBusy(true); try { setReport(await api.rebaseStudioCapture(root, report.id, report.candidateHead!)); setAck(false); } catch (e) { toast.error(e, "Refresh the result review"); } finally { setBusy(false); }
    }}>Save reviewed current result</button></div>}
    <div className="studio-actions"><button className="btn studio-before-checkpoint" onClick={() => checkpoint(report.beforeCheckpoint.id)}>Open original checkpoint</button>{report.afterCheckpoint && <button className="btn" onClick={() => checkpoint(report.afterCheckpoint!.id)}>Open saved result</button>}{report.afterHead && <button className="btn studio-file-compare" disabled={busy} onClick={async () => { setBusy(true); try { await useRepos.getState().open(root); dismiss(); openOverlay({ kind: "compare", root, from: report.review.head, to: report.afterHead!, direct: true }); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Compare file snapshots</button>}</div>
    <p className="muted">Restore a workspace into a separate worktree to preserve your current work. Older checkpoints remain in Undo Center when a new rebase report replaces this one.</p>
    {report.afterHead && !comparison && !error && <div className="muted"><Loader2 size={14} className="spin" /> Comparing saved commit snapshots…</div>}
    {error && <div className="callout warn">Commit comparison unavailable: {error}. You can still open the saved checkpoints.</div>}
    {comparison && <>
      <div className={comparison.sameTree ? "callout studio-same-tree" : "callout warn studio-tree-changed"}>{comparison.sameTree ? "Committed file contents are unchanged." : "Committed file contents changed. Inspect the direct file comparison before pushing."}</div>
      <div className="studio-grid">{[["Before", comparison.before], ["After", comparison.after]].map(([title, commits]) => <div className="studio-card" key={String(title)}><b>{String(title)}</b><div className="studio-commit-list">{(commits as StudioComparison["before"]).map((c) => <div className="studio-commit" key={c.oid}><code title={c.oid}>{shortOid(c.oid)}</code><button className="studio-message" title="Read full commit message" onClick={() => { void showDialog<void>((close) => <CommitMessageDialog subject={c.subject} body={c.body} oid={c.oid} author={c.author} onClose={close} />); }}>{c.subject}</button></div>)}</div></div>)}</div>
      {comparison.note && <div className="callout warn">{comparison.note}</div>}
      {comparison.rangeDiff !== null && <details className="studio-card" open><summary>Git range-diff · patch matching is heuristic</summary><pre className="studio-range-diff selectable">{comparison.rangeDiff || "No patch-series differences."}</pre>{comparison.truncated && <p className="muted">Output was truncated. Compare file snapshots for the actual content changes.</p>}</details>}
    </>}
    {!!report.refChanges.length && <details className="studio-card"><summary>Recorded reference comparison</summary>{report.refChanges.map((r) => <div className="studio-ref" key={r.name}><span title={r.name}>{studioRefName(r.name)}</span><code>{shortOid(r.before)} → {r.after ? shortOid(r.after) : "removed"}{r.symbolicBefore !== r.symbolicAfter ? " · symbolic target changed" : ""}</code></div>)}</details>}
  </div>;
}
