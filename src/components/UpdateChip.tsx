import { useEffect, useRef, useState } from "react";
import { ArrowUp, Download, ExternalLink, Loader2, RotateCw, Sparkles, TriangleAlert, X } from "lucide-react";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import { useUpdate, visibleUpdate } from "../lib/update";

function since(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (Number.isNaN(days)) return "";
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Release notes as plain readable text (GitHub markdown without the markup noise). */
function plainNotes(md: string): string {
  return md
    .replace(/\r/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

/** Status-bar chip shown when a newer release exists, with a small card to install it. */
export function UpdateChip() {
  const { info, phase, progress, error, install, restart } = useUpdate();
  const skipped = useSettings((s) => s.skippedUpdate);
  const set = useSettings((s) => s.set);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const update = visibleUpdate(info, skipped);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!update) return null;
  const working = phase === "downloading" || phase === "installing";
  const pct = Math.round(progress * 100);

  let chip;
  if (phase === "ready") {
    chip = (
      <>
        <RotateCw size={12} /> Restart to update
      </>
    );
  } else if (working) {
    chip = (
      <>
        <span className="update-ring" style={{ ["--p" as string]: `${pct}%` }} />
        {phase === "installing" ? "Installing…" : `Updating ${pct}%`}
      </>
    );
  } else {
    chip = (
      <>
        <span className="update-arrow">
          <ArrowUp size={11} strokeWidth={2.6} />
        </span>
        Update {update.latest}
      </>
    );
  }

  return (
    <div className="update-wrap" ref={ref}>
      <button
        type="button"
        className={`update-chip${phase === "ready" ? " ready" : ""}${phase === "error" ? " failed" : ""}`}
        onClick={() => (phase === "ready" ? restart() : setOpen((o) => !o))}
        title={phase === "ready" ? `Restart Revqora to finish updating to ${update.latest}` : `Revqora ${update.latest} is available`}
      >
        {chip}
      </button>
      {open && (
        <div className="update-card" role="dialog" aria-label="Update available">
          <div className="update-head">
            <div className="update-badge">
              <Sparkles size={16} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="update-title">Revqora {update.latest} is available</div>
              <div className="faint">
                You have {update.current}
                {update.publishedAt && ` · released ${since(update.publishedAt)}`}
                {update.asset && ` · ${megabytes(update.asset.size)}`}
              </div>
            </div>
            <button type="button" className="btn icon ghost sm" onClick={() => setOpen(false)} aria-label="Close">
              <X size={14} />
            </button>
          </div>
          {update.notes && <div className="update-notes">{plainNotes(update.notes)}</div>}
          {working && (
            <div className="update-progress">
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
          {phase === "error" && error && (
            <div className="update-error">
              <TriangleAlert size={13} /> {error}
            </div>
          )}
          {!update.canInstall && update.reason && <div className="faint update-reason">{update.reason}</div>}
          <div className="update-foot">
            <button
              type="button"
              className="btn ghost sm"
              disabled={working}
              onClick={() => {
                set({ skippedUpdate: update.latest });
                setOpen(false);
              }}
            >
              Skip this version
            </button>
            <div className="spacer" />
            <button type="button" className="btn sm" onClick={() => api.openPath(update.htmlUrl)}>
              <ExternalLink size={13} /> What's new
            </button>
            {phase === "ready" ? (
              <button type="button" className="btn primary sm" onClick={() => restart()}>
                <RotateCw size={13} /> Restart now
              </button>
            ) : update.canInstall ? (
              <button type="button" className="btn primary sm" disabled={working} onClick={() => install()}>
                {working ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {phase === "error" ? "Try again" : "Update now"}
              </button>
            ) : (
              <button type="button" className="btn primary sm" onClick={() => api.openPath(update.htmlUrl)}>
                <Download size={13} /> Download
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
