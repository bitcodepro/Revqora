import { RebaseResultBody, rebaseResultDialog, studioRefName } from "./RebaseResult";
import "../styles/rebaseStudio.css";
import { autosquash } from "../lib/autosquash";
import { confirmDialog } from "./dialogs";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, ListOrdered, Loader2, Play, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useRepos } from "../lib/store";
import { closeOverlay, toast, useUi } from "../lib/ui";
import { handleOutcome } from "../lib/actions";
import type { PlanCommit, RebaseAction, RebaseItem, StudioReview, StudioReport } from "../lib/types";
import { relativeTime, shortOid } from "../lib/format";

interface Row extends PlanCommit {
  action: RebaseAction;
  message: string;
}

const ACTIONS: { v: RebaseAction; label: string; hint: string }[] = [
  { v: "pick", label: "Pick", hint: "Keep the commit" },
  { v: "reword", label: "Reword", hint: "Keep it with a new message" },
  { v: "edit", label: "Edit", hint: "Stop here to change files" },
  { v: "squash", label: "Squash", hint: "Meld into the commit above, combining messages" },
  { v: "fixup", label: "Fixup", hint: "Meld into the commit above, dropping this message" },
  { v: "drop", label: "Drop", hint: "Remove the commit" },
];

const fullMessage = (c: PlanCommit) => (c.body ? `${c.subject}\n\n${c.body}` : c.subject);

export function RebaseView({ root, oldest }: { root: string; oldest: string }) {
  const [expectedState, setExpectedState] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [orig, setOrig] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [autosquashWarnings, setAutosquashWarnings] = useState<string[]>([]);
  const [review, setReview] = useState<StudioReview | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [publishedAck, setPublishedAck] = useState(false);
  const [dirtyAck, setDirtyAck] = useState(false);
  const [result, setResult] = useState<StudioReport | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const reviewVersion = useRef(0);
  const invalidate = () => { reviewVersion.current++; setReview(null); setPublishedAck(false); setDirtyAck(false); };
  const editRows: typeof setRows = (next) => { invalidate(); setRows(next); };

  useEffect(() => {
    let alive = true;
    reviewVersion.current++; setReview(null); setPublishedAck(false); setDirtyAck(false);
    setRows(null); setErr(null); setExpectedState(null); setResult(null); setAutosquashWarnings([]);
    void api.rebasePlan(root, oldest).then((p) => {
      if (!alive) return;
      setExpectedState(p.stateToken ?? null);
      setOrig(p.commits.map((c) => c.oid));
      setRows(p.commits.map((c) => ({ ...c, action: "pick", message: fullMessage(c) })));
    }, (e) => { if (alive) setErr(errorMessage(e)); });
    return () => { alive = false; reviewVersion.current++; };
  }, [root, oldest, loadVersion]);

  // For each head row, the combined message of the commits squashed into it.
  const groups = useMemo(() => {
    const m = new Map<number, { squashed: Row[]; hasSquash: boolean }>();
    if (!rows) return m;
    let head = -1;
    rows.forEach((r, i) => {
      if (r.action === "drop") return;
      if (r.action === "squash" || r.action === "fixup") {
        if (head >= 0) {
          const g = m.get(head)!;
          g.squashed.push(r);
          if (r.action === "squash") g.hasSquash = true;
        }
      } else {
        head = i;
        m.set(i, { squashed: [], hasSquash: false });
      }
    });
    return m;
  }, [rows]);

  const firstKept = rows?.findIndex((r) => r.action !== "drop") ?? -1;
  const invalid = rows && (firstKept < 0 || rows[firstKept].action === "squash" || rows[firstKept].action === "fixup");
  const resulting = rows ? rows.filter((r) => r.action === "pick" || r.action === "reword" || r.action === "edit").length : 0;
  const changed = rows?.some((r, i) => r.action !== "pick" || r.oid !== orig[i]) ?? false;

  const setAction = (i: number, action: RebaseAction) =>
    editRows((rs) => {
      if (!rs) return rs;
      const next = rs.map((r, k) => (k === i ? { ...r, action } : r));
      // Prefill a combined message on the head when squashing into it.
      if (action === "squash") {
        for (let h = i - 1; h >= 0; h--) {
          const a = next[h].action;
          if (a === "pick" || a === "reword" || a === "edit") {
            const sq = next[i];
            if (!next[h].message.includes(sq.subject)) next[h] = { ...next[h], message: `${next[h].message}\n\n${fullMessage(sq)}` };
            break;
          }
          if (a !== "squash" && a !== "fixup" && a !== "drop") break;
        }
      }
      return next;
    });

  const move = (from: number, to: number) =>
    editRows((rs) => {
      if (!rs || to < 0 || to >= rs.length || from === to) return rs;
      const next = [...rs];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });

  const items = (): RebaseItem[] => (rows ?? []).map((r, i) => ({ oid: r.oid, action: r.action, message: r.action === "reword" || groups.get(i)?.hasSquash ? r.message : null }));
  const prepareReview = async () => {
    if (!rows || invalid) return;
    const version = ++reviewVersion.current; setReviewBusy(true); setErr(null); setReview(null); setPublishedAck(false); setDirtyAck(false);
    try {
      const next = await api.rebaseStudioReview(root, oldest, items());
      if (version === reviewVersion.current) setReview(next);
    } catch (e) { if (version === reviewVersion.current) setErr(errorMessage(e)); }
    finally { if (version === reviewVersion.current) setReviewBusy(false); }
  };
  const start = async () => {
    if (!rows || invalid || !review || review.blockers.length || (review.publishedCommits > 0 && !publishedAck) || (review.dirtyFiles > 0 && !dirtyAck)) return;
    setBusy(true);
    try {
      const out = await api.rebaseStudioStart(root, oldest, items(), review, publishedAck, dirtyAck);
      if (out.report.phase === "paused") {
        closeOverlay(); handleOutcome(root, out.outcome, "Interactive rebase");
        useUi.getState().toast({ kind: "info", title: "Rebase Studio checkpoint saved", detail: out.report.beforeCheckpoint.id, action: { label: "Open Studio report", run: () => { void rebaseResultDialog(root, out.report.id); } } }, 20000);
      } else setResult(out.report);
    } catch (e) {
      toast.error(e, "Rebase needs review"); setErr(errorMessage(e)); invalidate();
    } finally {
      setBusy(false); void useRepos.getState().refresh(root);
    }
  };
  if (result) return <div className="conflict-overlay"><div className="cf-head" style={{ flexWrap: "wrap", height: "auto", minHeight: 56 }}><ListOrdered size={18} /><b>Rebase Studio result</b><div className="spacer" /><button className="btn" onClick={closeOverlay}>Close</button></div><div style={{ flex: 1, overflow: "auto", padding: 18 }}><RebaseResultBody root={root} initial={result} /></div></div>;

  return (
    <div className="conflict-overlay">
      <div className="cf-head studio-head" style={{ flexWrap: "wrap", height: "auto", minHeight: 56 }}>
        <ListOrdered size={18} style={{ color: "var(--accent)" }} />
        <div className="cf-title">
          <span className="p">Rebase Studio</span>
          <span className="s">Edit · Review · Run · Compare</span>
        </div>
        <div className="spacer" />
        {rows && (
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            {rows.length} commits → {resulting}
          </span>
        )}
        <button className="btn" disabled={!rows || busy || reviewBusy} onClick={async () => {
          if (!rows) return;
          if (changed && !await confirmDialog({ title: "Rebuild autosquash plan?", message: "Current manual actions and messages in this plan will be replaced. No Git history changes until you start rebase.", confirm: "Rebuild plan" })) return;
          const commits = orig.map((oid) => rows.find((r) => r.oid === oid)!);
          const result = autosquash(commits);
          editRows(result.rows); setAutosquashWarnings(result.warnings);
          if (!result.matched) toast.info("No matching fixup!/squash! commits", "Choose a range that includes both the original commits and their fixups.");
        }}>Autosquash fixups</button>
        <button className="btn" disabled={busy || reviewBusy} onClick={async () => {
          if (changed && !await confirmDialog({ title: "Reload the rebase plan?", message: "Current plan edits will be replaced by the current repository state.", confirm: "Reload plan" })) return;
          setLoadVersion((v) => v + 1);
        }}>Reload plan</button>
        <button className="btn studio-review-plan" disabled={!rows || !expectedState || !changed || !!invalid || busy || reviewBusy} onClick={() => void prepareReview()}>{reviewBusy && <Loader2 size={14} className="spin" />} Review plan</button>
        <button className="btn" disabled={busy} onClick={closeOverlay}>
          <X size={14} /> Cancel
        </button>
        <button className="btn primary" onClick={start} disabled={!review || !changed || !!invalid || busy || reviewBusy || !!review.blockers.length || (review.publishedCommits > 0 && !publishedAck) || (review.dirtyFiles > 0 && !dirtyAck)}>
          {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Start rebase
        </button>
      </div>
      {err && <div className="empty">{err}</div>}
      {!err && !rows && (
        <div className="loading-center">
          <span className="loader" />
        </div>
      )}
      {rows && (
        <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>
          {review && <section className="studio-review vstack" aria-label="Reviewed rebase plan" data-review-head={review.head}>
            <div className="studio-summary"><ListOrdered size={18} /><div><b>Review before rewriting history</b><div className="muted">{review.branchRef ? studioRefName(review.branchRef) : "Detached HEAD"} · {shortOid(review.head)} · {review.plan.commits.length} original commits</div></div></div>
            {review.blockers.map((b) => <div key={b} className="callout danger">{b}</div>)}
            <div className="callout">The current branch will use the edited history. Other reviewed branches and tags are planned to remain on their original history. A recovery checkpoint of files and staging will be saved before Git starts.</div>
            <div className="studio-grid"><div className="studio-card"><b>References containing this history</b><div className="studio-ref-list">{review.references.map((r) => <div className="studio-ref" key={r.name} data-reference={r.name}><span title={r.name}>{studioRefName(r.name)}<small className="muted"> · {r.remote ? "cached remote" : r.kind}</small></span><code title={r.oid}>{shortOid(r.oid)} · {r.rewritten ? "rewrite" : "keep"}</code></div>)}</div>{review.refsTruncated && <small>Only the first 500 references are displayed; publication analysis included all matching references.</small>}</div>
            <div className="studio-card"><b>Related worktrees</b>{review.worktrees.map((w) => <div key={w.path} style={{ marginTop: 8, overflowWrap: "anywhere" }}>{w.branch ?? "Detached HEAD"} · {w.current ? "current workspace" : w.locked ? "locked" : "keeps its branch"}<div className="muted">{w.path}</div></div>)}</div></div>
            <div className={review.publishedCommits ? "callout warn" : "callout"}>{review.publishedCommits} selected commits are reachable from cached fetch references. {review.publishedCommits ? "Rewriting published commits may require force-with-lease when pushing this branch. Check server protection and coordinate with collaborators." : "A lack of cached publication evidence does not prove that commits are unpublished."}<div className="muted">Based on local cached refs; fetch before planning for current server information. {review.upstream ? `Upstream: ${review.upstream}.` : "No upstream is configured."}</div></div>
            {review.publishedCommits > 0 && <label className="hstack"><input className="studio-ack-published" type="checkbox" checked={publishedAck} onChange={(e) => setPublishedAck(e.target.checked)} /> I understand the implications of rewriting published history.</label>}
            {review.dirtyFiles > 0 && <><div className="callout warn">{review.dirtyFiles} working changes, including {review.stagedFiles} staged files. Git autostash reapplies tracked changes after rebase; staging may become unstaged and conflicts may remain. Untracked files stay in place. The original files and index will be saved in Undo Center.</div><label className="hstack"><input className="studio-ack-dirty" type="checkbox" checked={dirtyAck} onChange={(e) => setDirtyAck(e.target.checked)} /> I understand how autostash affects my working changes.</label></>}
          </section>}
          {autosquashWarnings.map((warning) => <div className="callout warn" key={warning} style={{ marginBottom: 8 }}>{warning}</div>)}
          {invalid && (
            <div className="callout danger" style={{ marginBottom: 10 }}>
              Keep at least one commit. The first kept commit must be Pick, Reword or Edit.
            </div>
          )}
          <p className="muted">Commits run from top (oldest) to bottom. Drag or use the arrow buttons to reorder.</p>
          <div className="vstack" style={{ gap: 6 }}>
            {rows.map((r, i) => {
              const meld = r.action === "squash" || r.action === "fixup";
              const g = groups.get(i);
              const showMessage = r.action === "reword" || (g?.hasSquash ?? false);
              return (
                <div
                  key={r.oid}
                  className={`rebase-row studio-editor-row ${r.action} ${drag === i ? "dragging" : ""} ${over === i && drag !== i ? "over" : ""}`}
                  style={{ marginLeft: meld ? 34 : 0 }}
                  draggable={!busy && !reviewBusy}
                  onDragStart={(e) => {
                    setDrag(i);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(i);
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (drag !== null) move(drag, i);
                    setDrag(null);
                    setOver(null);
                  }}
                >
                  <div className="hstack" style={{ gap: 8 }}>
                    <GripVertical size={15} className="faint" style={{ cursor: "grab", flex: "none" }} />
                    <span className="mono faint" style={{ width: 66, flex: "none" }}>
                      {shortOid(r.oid, 7)}
                    </span>
                    <span className="ellipsis" style={{ flex: 1, fontWeight: 500, textDecoration: r.action === "drop" ? "line-through" : undefined, opacity: r.action === "drop" ? 0.5 : 1 }}>
                      {r.subject}
                    </span>
                    <span className="faint" style={{ fontSize: "var(--fs-xs)", flex: "none" }}>
                      {r.author} · {relativeTime(r.time)}
                    </span>
                    <div className="seg" style={{ flex: "none" }}>
                      {ACTIONS.map((a) => (
                        <button key={a.v} disabled={busy || reviewBusy} className={r.action === a.v ? "on" : ""} title={a.hint} onClick={() => setAction(i, a.v)}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                    <button className="icon-btn sm" disabled={i === 0 || busy || reviewBusy} onClick={() => move(i, i - 1)} title="Move up (older)">
                      <ArrowUp size={13} />
                    </button>
                    <button className="icon-btn sm" disabled={i === rows.length - 1 || busy || reviewBusy} onClick={() => move(i, i + 1)} title="Move down (newer)">
                      <ArrowDown size={13} />
                    </button>
                  </div>
                  {showMessage && (
                    <textarea
                      className="textarea mono"
                      rows={Math.min(8, Math.max(2, r.message.split("\n").length))}
                      style={{ marginTop: 8 }}
                      disabled={busy || reviewBusy}
                      value={r.message}
                      onChange={(e) => editRows((rs) => rs && rs.map((x, k) => (k === i ? { ...x, message: e.target.value } : x)))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
