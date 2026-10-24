import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Modal } from "./Modal";
import { showDialog, toast } from "../lib/ui";
import { api } from "../lib/api";
import type { FileDiff, FileHistoryEntry } from "../lib/types";
import { absoluteTime, relativeTime } from "../lib/format";
import { DiffView } from "./DiffView";
import { jumpToCommit } from "./GraphView";

export function fileHistoryDialog(root: string, path: string) {
  return showDialog<void>((close) => <FileHistoryBody root={root} path={path} close={close} />);
}

function FileHistoryBody({ root, path, close }: { root: string; path: string; close: () => void }) {
  const [items, setItems] = useState<FileHistoryEntry[] | null>(null);
  const [sel, setSel] = useState<FileHistoryEntry | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  useEffect(() => {
    api.fileHistory(root, path).then(
      (r) => {
        setItems(r);
        setSel(r[0] ?? null);
      },
      (e) => toast.error(e),
    );
  }, [root, path]);
  useEffect(() => {
    if (!sel) return;
    setDiff(null);
    api.commitDetails(root, sel.oid).then((d) => api.revDiff(root, d.diffBase, d.oid, sel.path).then(setDiff), () => {});
  }, [root, sel]);
  return (
    <Modal title="File history" subtitle={path} icon={<History size={18} />} wide onClose={() => close()} footer={<button type="button" className="btn" onClick={() => close()}>Close</button>}>
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 10, height: "60vh", margin: "0 -8px" }}>
        <div style={{ overflow: "auto", borderRight: "1px solid var(--border)" }}>
          {!items && <div className="loading-center">Loading…</div>}
          {items?.length === 0 && <div className="empty">No history</div>}
          {items?.map((it) => (
            <div key={it.oid} className={`file-row ${sel?.oid === it.oid ? "selected" : ""}`} style={{ height: "auto", padding: "6px 8px", flexDirection: "column", alignItems: "stretch", gap: 2 }} onClick={() => setSel(it)} onDoubleClick={() => { close(); jumpToCommit(root, it.oid); }}>
              <span className="ellipsis" style={{ color: "var(--text)", fontWeight: 500 }}>{it.subject}</span>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }} title={absoluteTime(it.time)}>
                {it.oid.slice(0, 7)} · {it.author} · {relativeTime(it.time)}
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", minHeight: 0, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <DiffView diff={diff} loading={!!sel && !diff} mode="readonly" path={sel?.path ?? path} />
        </div>
      </div>
    </Modal>
  );
}
