import { useEffect, useId, useRef, useState } from "react";
import { Download, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import type { GitSelection } from "../lib/types";
import { scheduleDialogFocus } from "../lib/dialogFocus";
import { useFocusTrap } from "../lib/useFocusTrap";

const DOWNLOAD = "https://git-scm.com/downloads";

/** Full-window notice when no usable git is installed, with a re-check after installing. */
export function GitMissing() {
  const [sel, setSel] = useState<GitSelection | null>(null);
  const [checking, setChecking] = useState(false);
  const [dismissedOld, setDismissedOld] = useState(false);
  useEffect(() => {
    api.gitSelection().then(setSel, () => {});
  }, []);
  const recheck = async () => {
    setChecking(true);
    try {
      setSel(await api.gitConfigure());
    } finally {
      setChecking(false);
    }
  };
  const missing = sel?.source === "none";
  const shown = !!sel && (missing || (sel.tooOld && !dismissedOld));
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The notice covers the whole window: keyboard focus starts in it and Tab stays in it.
  useFocusTrap(dialog, shown);
  useEffect(() => (shown ? scheduleDialogFocus(() => dialog.current) : undefined), [shown]);
  if (!sel || !shown) return null;
  return (
    <div className="modal-backdrop" style={{ zIndex: 1000 }}>
      <div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} style={{ width: "min(520px, 100%)" }}>
        <div className="modal-head">
          <div className="mi warn">
            <TriangleAlert size={18} />
          </div>
          <div>
            <h3 id={titleId}>{missing ? "Git is not installed" : `Git ${sel.version} is too old`}</h3>
            <div className="sub">{missing ? "Revqora works with the Git installed on your computer." : `Revqora needs Git ${sel.minVersion} or newer.`}</div>
          </div>
        </div>
        <div className="modal-body">
          <div className="muted">
            {missing
              ? "Install Git (the default options are fine), then press Check again — no restart needed."
              : "Update Git to the latest version, then press Check again. Some features may not work until then."}
          </div>
          {!missing && <div className="mono faint" style={{ fontSize: "var(--fs-xs)" }}>{sel.path}</div>}
        </div>
        <div className="modal-foot">
          {!missing && (
            <button className="btn ghost" onClick={() => setDismissedOld(true)}>
              Continue anyway
            </button>
          )}
          <button className="btn" onClick={() => api.openPath(DOWNLOAD)}>
            <Download size={14} /> Download Git
          </button>
          <button className="btn primary" onClick={recheck} disabled={checking}>
            {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Check again
          </button>
        </div>
      </div>
    </div>
  );
}
