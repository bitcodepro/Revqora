import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import type { GitSelection } from "../lib/types";

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
  if (!sel) return null;
  const missing = sel.source === "none";
  if (!missing && (!sel.tooOld || dismissedOld)) return null;
  return (
    <div className="modal-backdrop" style={{ zIndex: 1000 }}>
      <div className="modal" style={{ width: "min(520px, 100%)" }}>
        <div className="modal-head">
          <div className="mi warn">
            <TriangleAlert size={18} />
          </div>
          <div>
            <h3>{missing ? "Git is not installed" : `Git ${sel.version} is too old`}</h3>
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
