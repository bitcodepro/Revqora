import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { getTab, useRepos } from "../lib/store";
import { closeOverlay, toast } from "../lib/ui";
import { stashApply, stashDrop } from "../lib/actions";
import type { ChangedFile, FileDiff, StashContents } from "../lib/types";
import { relativeTime } from "../lib/format";
import { PathLabel, StatusIcon } from "./bits";
import { DiffView, useDiffOpts } from "./DiffView";

export function StashView({ root, index }: { root: string; index: number }) {
  const [c, setC] = useState<StashContents | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<{ path: string; untracked: boolean } | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const diffOpts = useDiffOpts();
  const info = getTab(root)?.refs?.stashes.find((s) => s.index === index);

  useEffect(() => {
    api.stashContents(root, index).then(
      (r) => {
        setC(r);
        const first = r.files[0] ? { path: r.files[0].path, untracked: false } : r.untracked[0] ? { path: r.untracked[0].path, untracked: true } : null;
        setSel(first);
      },
      (e) => setErr(errorMessage(e)),
    );
  }, [root, index]);

  useEffect(() => {
    if (!c || !sel) return setDiff(null);
    let alive = true;
    const from = sel.untracked ? null : c.base;
    const to = sel.untracked ? c.untrackedCommit! : c.oid;
    api.revDiff(root, from, to, sel.path, diffOpts).then((d) => alive && setDiff(d), (e) => toast.error(e));
    return () => {
      alive = false;
    };
  }, [root, c, sel, diffOpts]);

  const restore = async (path: string, untracked: boolean) => {
    try {
      await api.stashRestoreFile(root, index, path, untracked);
      toast.success(`Restored ${path} from the stash`, "A backup of the previous file is in .git/revqora/trash.");
    } catch (e) {
      toast.error(e);
    }
    useRepos.getState().refresh(root, { status: true, layers: true });
  };

  const row = (f: ChangedFile, untracked: boolean) => (
    <div key={(untracked ? "u:" : "") + f.path} className={`file-row ${sel?.path === f.path && sel.untracked === untracked ? "selected" : ""}`} onClick={() => setSel({ path: f.path, untracked })}>
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
            stash@{`{${index}}`}
            {info ? ` · ${relativeTime(info.time)}` : ""}
          </span>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => (closeOverlay(), stashApply(root, index, false))}>
          <ArchiveRestore size={14} /> Apply
        </button>
        <button className="btn" onClick={() => (closeOverlay(), stashApply(root, index, true))}>
          Pop
        </button>
        <button className="btn" onClick={() => (closeOverlay(), stashDrop(root, index))}>
          <Trash2 size={14} /> Drop
        </button>
        <button className="btn" onClick={closeOverlay}>
          <X size={14} /> Close
        </button>
      </div>
      {err && <div className="empty">{err}</div>}
      {!err && !c && (
        <div className="loading-center">
          <Loader2 className="spin" />
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
