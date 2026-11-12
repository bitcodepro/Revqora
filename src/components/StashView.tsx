import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, RotateCcw, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useRepos } from "../lib/store";
import { closeOverlay, contextMenu, toast } from "../lib/ui";
import { fileCopyMenu } from "./NamePathMenu";
import { stashApply, stashDrop } from "../lib/actions";
import type { ChangedFile, FileDiff, StashContents } from "../lib/types";
import { relativeTime } from "../lib/format";
import { PathLabel, StatusIcon } from "./bits";
import { DiffView, useDiffOpts } from "./DiffView";

export function StashView({ root, index, oid }: { root: string; index: number; oid: string }) {
  const [c, setC] = useState<StashContents | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<{ path: string; untracked: boolean } | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const diffOpts = useDiffOpts();
  const tab = useRepos(s => s.tabs[root]);
  const info = tab?.refs?.stashes.find((s) => s.oid === oid);
  const diffContext = tab?.status?.diffContextToken;

  useEffect(() => {
    let alive = true;
    setC(null); setErr(null); setSel(null); setDiff(null);
    api.stashContents(root, oid).then(
      (r) => {
        if (!alive) return;
        setC(r);
        const first = r.files[0] ? { path: r.files[0].path, untracked: false } : r.untracked[0] ? { path: r.untracked[0].path, untracked: true } : null;
        setSel(first);
      },
      (e) => alive && setErr(errorMessage(e)),
    );
    return () => { alive = false; };
  }, [root, oid, diffContext]);

  useEffect(() => {
    if (!c || !sel) return setDiff(null);
    let alive = true;
    setDiff(null);
    const from = sel.untracked ? null : c.base;
    const to = sel.untracked ? c.untrackedCommit! : c.oid;
    api.revDiff(root, from, to, sel.path, diffOpts).then((d) => alive && setDiff(d), (e) => alive && toast.error(e));
    return () => {
      alive = false;
    };
  }, [root, c, sel, diffOpts, diffContext]);

  const restore = async (path: string, untracked: boolean) => {
    try {
      if (!c || c.oid !== oid) return;
      await api.stashRestoreFile(root, c.oid, path, untracked);
      toast.success(`Restored ${path} from the stash`, "A backup of the previous file is in portable recovery storage.");
    } catch (e) {
      toast.error(e);
    }
    useRepos.getState().refresh(root, { status: true, layers: true });
  };

  const row = (f: ChangedFile, untracked: boolean) => (
    <div key={(untracked ? "u:" : "") + f.path} className={`file-row ${sel?.path === f.path && sel.untracked === untracked ? "selected" : ""}`} onClick={() => setSel({ path: f.path, untracked })} onContextMenu={e => contextMenu(e, fileCopyMenu(f.path))}>
      <StatusIcon code={untracked ? "?" : f.status} />
      <PathLabel path={f.path} />
      <div className="row-actions">
        <button className="icon-btn sm" title="Restore this file into the working tree" onClick={(e) => (e.stopPropagation(), restore(f.path, untracked))}>
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="conflict-overlay">
      <div className="cf-head">
        <Archive size={18} style={{ color: "var(--accent)" }} />
        <div className="cf-title">
          <span className="p">{info?.message ?? `stash@{${index}}`}</span>
          <span className="s">
            {info ? `stash@{${info.index}}` : `Snapshot ${oid.slice(0, 12)}`}
            {info ? ` · ${relativeTime(info.time)}` : ""}
          </span>
        </div>
        <div className="spacer" />
        <button className="btn" disabled={!info || !c} onClick={() => { if (info) { closeOverlay(); void stashApply(root, info.index, false, oid); } }}>
          <ArchiveRestore size={14} /> Apply
        </button>
        <button className="btn" disabled={!info || !c} onClick={() => { if (info) { closeOverlay(); void stashApply(root, info.index, true, oid); } }}>
          Pop
        </button>
        <button className="btn" disabled={!info || !c} onClick={() => { if (info) { closeOverlay(); void stashDrop(root, info.index, oid); } }}>
          <Trash2 size={14} /> Drop
        </button>
        <button className="btn" onClick={closeOverlay}>
          <X size={14} /> Close
        </button>
      </div>
      {err && <div className="empty">{err}</div>}
      {!err && !c && (
        <div className="loading-center">
          <span className="loader" />
        </div>
      )}
      {c && (
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "340px minmax(0,1fr)", minHeight: 0 }}>
          <div className="changes-left">
            <div className="file-list">
              <div className="file-list-head">Changed files ({c.files.length})</div>
              {c.files.map((f) => row(f, false))}
              {c.untracked.length > 0 && <div className="file-list-head">Untracked files ({c.untracked.length})</div>}
              {c.untracked.map((f) => row(f, true))}
            </div>
          </div>
          <DiffView
            diff={diff}
            loading={!!sel && !diff}
            mode="readonly"
            path={sel?.path ?? ""}
            root={root}
            images={sel ? { old: sel.untracked ? null : { rev: `${c.base}:${sel.path}` }, new: { rev: `${sel.untracked ? c.untrackedCommit : c.oid}:${sel.path}` } } : undefined}
            actions={
              sel && (
                <button className="btn sm" onClick={() => restore(sel.path, sel.untracked)}>
                  <RotateCcw size={12} /> Restore file
                </button>
              )
            }
          />
        </div>
      )}
    </div>
  );
}
