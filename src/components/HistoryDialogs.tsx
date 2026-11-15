import { useEffect, useMemo, useRef, useState } from "react";
import { FolderClock, History } from "lucide-react";
import { Modal } from "./Modal";
import { DiffView } from "./DiffView";
import { jumpToCommit } from "./GraphView";
import { showDialog } from "../lib/ui";
import { api, errorMessage } from "../lib/api";
import { absoluteTime, relativeTime, shortOid } from "../lib/format";
import { rowIn, steppedOid } from "../lib/keyboardFocus";
import type { FileDiff, FolderHistoryEntry, LineHistoryEntry } from "../lib/types";

const PAGE = 200;

/** History of lines `start..end` of `path` at `rev` (null = HEAD). */
export function lineHistoryDialog(root: string, path: string, start: number, end: number, rev: string | null, note?: string) {
  return showDialog<void>((close) => <LineHistory root={root} path={path} start={start} end={end} rev={rev} note={note} close={() => close()} />);
}

/** History of everything under `folder` ("" = the repository). */
export function folderHistoryDialog(root: string, folder: string) {
  return showDialog<void>((close) => <FolderHistory root={root} folder={folder} close={() => close()} />);
}

interface Row { oid: string; author: string; time: number; subject: string }

/** The commit list shared by both dialogs: keyboard navigation stays in its own document. */
function CommitList<T extends Row>({ items, selected, onSelect, onOpen, label, more, onMore }: {
  items: T[] | null; selected: string | null; onSelect: (item: T) => void; onOpen: (item: T) => void; label: string; more: boolean; onMore: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const current = useRef<string | null>(selected);
  current.current = selected;
  const move = (from: string, step: number) => {
    if (!items) return;
    const oid = steppedOid(items, current.current ?? from, step);
    const next = items.find((it) => it.oid === oid);
    if (!next) return;
    current.current = next.oid;
    onSelect(next);
    requestAnimationFrame(() => {
      const row = rowIn(list.current, next.oid);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus({ preventScroll: true });
    });
  };
  return (
    <div ref={list} role="listbox" aria-label={label} style={{ overflow: "auto", borderRight: "1px solid var(--border)" }}>
      {!items && <div className="loading-center"><span className="loader" aria-label="Loading history" /></div>}
      {items?.length === 0 && <div className="empty">No commits changed this.</div>}
      {items?.map((it) => (
        <div key={it.oid} data-oid={it.oid} role="option" aria-selected={selected === it.oid} tabIndex={selected === it.oid ? 0 : -1}
          className={`file-row ${selected === it.oid ? "selected" : ""}`} style={{ height: "auto", padding: "6px 8px", flexDirection: "column", alignItems: "stretch", gap: 2 }}
          onClick={() => onSelect(it)} onDoubleClick={() => onOpen(it)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(it.oid, e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const oid = current.current ?? it.oid;
              onOpen(items.find((x) => x.oid === oid) ?? it);
            }
          }}>
          <span className="ellipsis" style={{ color: "var(--text)", fontWeight: 500 }}>{it.subject}</span>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }} title={absoluteTime(it.time)}>{shortOid(it.oid)} · {it.author} · {relativeTime(it.time)}</span>
        </div>
      ))}
      {items && more && (
        <div className="file-row" style={{ justifyContent: "center", padding: 8 }}>
          <button type="button" className="btn sm" onClick={onMore}>Load older changes ({items.length} shown)</button>
        </div>
      )}
    </div>
  );
}

function useHistory<T>(load: (limit: number) => Promise<T[]>, key: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setItems(null); setLimit(PAGE); }, [key]);
  useEffect(() => {
    let alive = true;
    setError(null);
    load(limit).then((r) => { if (alive) setItems(r); }, (e) => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; };
    // `load` is a new closure each render; `key` and `limit` say when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, limit]);
  return { items, error, more: !!items && items.length >= limit, loadMore: () => setLimit((n) => n + PAGE) };
}

/** Keeps a selection that is still listed, else the newest entry. */
function useSelection<T extends Row>(items: T[] | null) {
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    if (items && !items.some((i) => i.oid === sel)) setSel(items[0]?.oid ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  return [sel, setSel] as const;
}

function LineHistory({ root, path, start, end, rev, note, close }: { root: string; path: string; start: number; end: number; rev: string | null; note?: string; close: () => void }) {
  const { items, error, more, loadMore } = useHistory<LineHistoryEntry>((limit) => api.lineHistory(root, path, start, end, rev, limit), JSON.stringify([root, path, start, end, rev]));
  const [sel, setSel] = useSelection(items);
  const entry = items?.find((i) => i.oid === sel) ?? null;
  const open = (it: Row) => { close(); jumpToCommit(root, it.oid); };
  const lines = start === end ? `line ${start}` : `lines ${start}–${end}`;
  return (
    <Modal title={`History of ${lines}`} subtitle={rev ? `${path} at ${shortOid(rev)}` : path} icon={<History size={18} />} wide onClose={close} sizeKey="Line history"
      footer={<button type="button" className="btn" onClick={close}>Close</button>}>
      {note && <div className="faint" role="note" style={{ marginBottom: 6 }}>{note}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 10, height: "60vh", margin: "0 -8px" }}>
        <CommitList items={items} selected={sel} onSelect={(it) => setSel(it.oid)} onOpen={open} label="Commits that changed these lines" more={more} onMore={loadMore} />
        <div style={{ display: "flex", minHeight: 0, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <DiffView diff={entry?.diff ?? null} loading={!items && !error} error={null} mode="readonly" path={entry?.path ?? path} root={root} sourceOptions={false} />
        </div>
      </div>
    </Modal>
  );
}

function FolderHistory({ root, folder, close }: { root: string; folder: string; close: () => void }) {
  const { items, error, more, loadMore } = useHistory<FolderHistoryEntry>((limit) => api.folderHistory(root, folder, limit), JSON.stringify([root, folder]));
  const [sel, setSel] = useSelection(items);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const entry = useMemo(() => items?.find((i) => i.oid === sel) ?? null, [items, sel]);
  useEffect(() => { setFile(entry?.files[0] ?? null); }, [entry]);
  useEffect(() => {
    if (!entry || !file) { setDiff(null); return; }
    let alive = true;
    setDiff(null);
    setDiffError(null);
    api.commitDetails(root, entry.oid)
      .then((d) => api.revDiff(root, d.diffBase, d.oid, file))
      .then((r) => { if (alive) setDiff(r); }, (e) => { if (alive) setDiffError(errorMessage(e)); });
    return () => { alive = false; };
  }, [root, entry, file]);
  const open = (it: Row) => { close(); jumpToCommit(root, it.oid); };
  const prefix = folder ? folder + "/" : "";
  return (
    <Modal title="Folder history" subtitle={folder ? prefix : "Whole repository"} icon={<FolderClock size={18} />} wide onClose={close} sizeKey="Folder history"
      footer={<button type="button" className="btn" onClick={close}>Close</button>}>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "260px 220px 1fr", gap: 10, height: "60vh", margin: "0 -8px" }}>
        <CommitList items={items} selected={sel} onSelect={(it) => setSel(it.oid)} onOpen={open} label="Commits that changed this folder" more={more} onMore={loadMore} />
        <div role="listbox" aria-label="Files changed in this commit" style={{ overflow: "auto", borderRight: "1px solid var(--border)" }}>
          {entry?.files.map((f) => (
            <div key={f} role="option" aria-selected={file === f} tabIndex={0} className={`file-row ${file === f ? "selected" : ""}`} title={f}
              onClick={() => setFile(f)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFile(f); } }}>
              <span className="ellipsis">{prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", minHeight: 0, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <DiffView diff={diff} loading={!!file && !diff && !diffError} error={diffError} mode="readonly" path={file ?? folder} root={root} />
        </div>
      </div>
    </Modal>
  );
}
