import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Modal } from "./Modal";
import { showDialog } from "../lib/ui";
import { api, errorMessage } from "../lib/api";
import type { FileDiff, FileHistoryEntry } from "../lib/types";
import { absoluteTime, relativeTime } from "../lib/format";
import { DiffView } from "./DiffView";
import { jumpToCommit } from "./GraphView";
import type { ImageSides } from "./ImageDiff";

const PAGE = 500;

export function fileHistoryDialog(root: string, path: string) {
  return showDialog<void>((close) => <FileHistoryBody root={root} path={path} close={close} />);
}

function FileHistoryBody({ root, path, close }: { root: string; path: string; close: () => void }) {
  const [items, setItems] = useState<FileHistoryEntry[] | null>(null);
  const [sel, setSel] = useState<FileHistoryEntry | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [sides, setSides] = useState<ImageSides>();
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setItems(null); setSel(null); setDiff(null); setError(null); setLimit(PAGE); }, [root, path]);
  useEffect(() => {
    let alive = true;
    setListError(null);
    api.fileHistory(root, path, limit).then(
      (r) => {
        if (!alive) return;
        setItems(r);
        setSel((current) => current && r.some((it) => it.oid === current.oid) ? current : r[0] ?? null);
        setLoadingMore(false);
      },
      (e) => { if (alive) { setListError(errorMessage(e)); setLoadingMore(false); } },
    );
    return () => { alive = false; };
  }, [root, path, limit, attempt]);
  const moveSelection = (step: number) => {
    if (!items?.length) return;
    const at = items.findIndex((it) => it.oid === sel?.oid);
    const next = items[Math.min(items.length - 1, Math.max(0, at + step))];
    setSel(next);
    document.getElementById(`file-history-${next.oid}`)?.scrollIntoView({ block: "nearest" });
  };
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    setDiff(null);
    setSides(undefined);
    setError(null);
    api.commitDetails(root, sel.oid).then(async d => {
      const diff = await api.revDiff(root, d.diffBase, d.oid, sel.path);
      if (!alive) return;
      setSides({old:d.diffBase ? {rev:`${d.diffBase}:${diff.oldPath ?? sel.path}`} : null, new:{rev:`${d.oid}:${sel.path}`}});
      setDiff(diff);
    }).catch(e => alive && setError(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [root, sel]);
  return (
    <Modal title="File history" subtitle={path} icon={<History size={18} />} wide onClose={() => close()} footer={<button type="button" className="btn" onClick={() => close()}>Close</button>}>
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 10, height: "60vh", margin: "0 -8px" }}>
        <div className="file-history-list" role="listbox" aria-label="File history" style={{ overflow: "auto", borderRight: "1px solid var(--border)" }}>
          {listError && (
            <div className="empty" role="alert">
              <div>File history could not be loaded.</div>
              <div className="mono faint" style={{ whiteSpace: "pre-wrap" }}>{listError}</div>
              <button type="button" className="btn sm" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
            </div>
          )}
          {!items && !listError && <div className="loading-center"><span className="loader" aria-label="Loading file history" /></div>}
          {items?.length === 0 && <div className="empty">No history</div>}
          {items?.map((it) => (
            <div key={it.oid} id={`file-history-${it.oid}`} role="option" aria-selected={sel?.oid === it.oid} tabIndex={sel?.oid === it.oid ? 0 : -1}
              className={`file-row ${sel?.oid === it.oid ? "selected" : ""}`} style={{ height: "auto", padding: "6px 8px", flexDirection: "column", alignItems: "stretch", gap: 2 }}
              onClick={() => setSel(it)} onDoubleClick={() => { close(); jumpToCommit(root, it.oid); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSelection(e.key === "ArrowDown" ? 1 : -1); requestAnimationFrame(() => (document.querySelector<HTMLElement>(".file-history-list [aria-selected=true]"))?.focus()); }
                else if (e.key === "Enter") { e.preventDefault(); close(); jumpToCommit(root, it.oid); }
              }}>
              <span className="ellipsis" style={{ color: "var(--text)", fontWeight: 500 }}>{it.subject}</span>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }} title={absoluteTime(it.time)}>
                {it.oid.slice(0, 7)} · {it.author} · {relativeTime(it.time)}
              </span>
            </div>
          ))}
          {items && items.length >= limit && (
            <div className="file-row" style={{ justifyContent: "center", padding: 8 }}>
              <button type="button" className="btn sm" disabled={loadingMore} onClick={() => { setLoadingMore(true); setLimit((n) => n + PAGE); }}>
                {loadingMore ? "Loading…" : `Load older changes (${items.length} shown)`}
              </button>
            </div>
          )}
        </div>
        <div style={{ display: "flex", minHeight: 0, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <DiffView diff={diff} loading={!!sel && !diff && !error} error={error} mode="readonly" path={sel?.path ?? path} root={root} images={sides} />
        </div>
      </div>
    </Modal>
  );
}
