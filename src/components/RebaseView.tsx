import { autosquash } from "../lib/autosquash";
import { confirmDialog } from "./dialogs";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, ListOrdered, Loader2, Play, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useRepos } from "../lib/store";
import { closeOverlay, toast } from "../lib/ui";
import { handleOutcome } from "../lib/actions";
import type { PlanCommit, RebaseAction } from "../lib/types";
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
  const [base, setBase] = useState<string | null>(null);
  const [orig, setOrig] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [autosquashWarnings, setAutosquashWarnings] = useState<string[]>([]);

  useEffect(() => {
    api.rebasePlan(root, oldest).then(
      (p) => {
        setExpectedState(p.stateToken ?? null);
        setBase(p.base);
        setOrig(p.commits.map((c) => c.oid));
        setRows(p.commits.map((c) => ({ ...c, action: "pick", message: fullMessage(c) })));
      },
      (e) => setErr(errorMessage(e)),
    );
  }, [root, oldest]);

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
  const invalid = rows && firstKept >= 0 && (rows[firstKept].action === "squash" || rows[firstKept].action === "fixup");
  const resulting = rows ? rows.filter((r) => r.action === "pick" || r.action === "reword" || r.action === "edit").length : 0;
  const changed = rows?.some((r, i) => r.action !== "pick" || r.oid !== orig[i]) ?? false;

  const setAction = (i: number, action: RebaseAction) =>
    setRows((rs) => {
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
    setRows((rs) => {
      if (!rs || to < 0 || to >= rs.length || from === to) return rs;
      const next = [...rs];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });

  const start = async () => {
    if (!rows || invalid) return;
    setBusy(true);
    try {
      const items = rows.map((r, i) => {
        const g = groups.get(i);
        const needsMessage = r.action === "reword" || (g?.hasSquash ?? false);
        return { oid: r.oid, action: r.action, message: needsMessage ? r.message : null };
      });
      const out = await api.interactiveRebase(root, base, items, expectedState);
      closeOverlay();
      if (out.status === "done") toast.success("History rewritten");
      else handleOutcome(root, out, "Interactive rebase");
    } catch (e) {
      toast.error(e, "Rebase failed");
    } finally {
      setBusy(false);
      useRepos.getState().refresh(root);
    }
  };

  return (
    <div className="conflict-overlay">
      <div className="cf-head">
        <ListOrdered size={18} style={{ color: "var(--accent)" }} />
        <div className="cf-title">
          <span className="p">Interactive rebase</span>
          <span className="s">Drag to reorder · top is the oldest commit and is applied first</span>
        </div>
        <div className="spacer" />
        {rows && (
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            {rows.length} commits → {resulting}
          </span>
        )}
        <button className="btn" disabled={!rows || busy} onClick={async () => {
          if (!rows) return;
          if (changed && !await confirmDialog({ title: "Rebuild autosquash plan?", message: "Current manual actions and messages in this plan will be replaced. No Git history changes until you start rebase.", confirm: "Rebuild plan" })) return;
          const commits = orig.map((oid) => rows.find((r) => r.oid === oid)!);
          const result = autosquash(commits);
          setRows(result.rows); setAutosquashWarnings(result.warnings);
          if (!result.matched) toast.info("No matching fixup!/squash! commits", "Choose a range that includes both the original commits and their fixups.");
        }}>Autosquash fixups</button>
        <button className="btn" onClick={closeOverlay}>
          <X size={14} /> Cancel
        </button>
        <button className="btn primary" onClick={start} disabled={!rows || !expectedState || !changed || !!invalid || busy}>
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
          {autosquashWarnings.map((warning) => <div className="callout warn" key={warning} style={{ marginBottom: 8 }}>{warning}</div>)}
          {invalid && (
            <div className="callout danger" style={{ marginBottom: 10 }}>
              The first kept commit cannot be squashed — there is nothing above it to squash into.
            </div>
          )}
          <div className="vstack" style={{ gap: 6 }}>
            {rows.map((r, i) => {
              const meld = r.action === "squash" || r.action === "fixup";
              const g = groups.get(i);
              const showMessage = r.action === "reword" || (g?.hasSquash ?? false);
              return (
                <div
                  key={r.oid}
                  className={`rebase-row ${r.action} ${drag === i ? "dragging" : ""} ${over === i && drag !== i ? "over" : ""}`}
                  style={{ marginLeft: meld ? 34 : 0 }}
                  draggable
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
                        <button key={a.v} className={r.action === a.v ? "on" : ""} title={a.hint} onClick={() => setAction(i, a.v)}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                    <button className="icon-btn sm" disabled={i === 0} onClick={() => move(i, i - 1)} title="Move up (older)">
                      <ArrowUp size={13} />
                    </button>
                    <button className="icon-btn sm" disabled={i === rows.length - 1} onClick={() => move(i, i + 1)} title="Move down (newer)">
                      <ArrowDown size={13} />
                    </button>
                  </div>
                  {showMessage && (
                    <textarea
                      className="textarea mono"
                      rows={Math.min(8, Math.max(2, r.message.split("\n").length))}
                      style={{ marginTop: 8 }}
                      value={r.message}
                      onChange={(e) => setRows((rs) => rs && rs.map((x, k) => (k === i ? { ...x, message: e.target.value } : x)))}
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
