import { useEffect, useState } from "react";
import { Bug, Copy, RefreshCw, Trash2 } from "lucide-react";
import { errorMessage } from "../lib/api";
import { clearErrorLog, readErrorLog, type ErrorLogEntry } from "../lib/errorLog";
import { shortcutTitle } from "../lib/shortcuts";
import { copyText, showDialog } from "../lib/ui";
import { confirmDialog } from "./dialogs";
import { Modal } from "./Modal";
import "../styles/errorLog.css";

export function errorLogDialog() {
  return showDialog<void>(close => <ErrorLog close={close} />);
}

export function ErrorLogButton() {
  return <button type="button" className="icon-btn" aria-label="Error log" title={shortcutTitle("Error log", "error-log")}
    data-shortcut="error-log" onClick={() => void errorLogDialog()}><Bug size={16} /></button>;
}

function formatEntry(entry: ErrorLogEntry) {
  return `[${new Date(entry.timestamp).toISOString()}] ${entry.source} · ${entry.code}${entry.count > 1 ? ` ×${entry.count}` : ""}\n${entry.message}`;
}

function ErrorLog({ close }: { close: () => void }) {
  const [entries, setEntries] = useState<ErrorLogEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void readErrorLog().then(
      result => { if (current) setEntries(result); },
      failure => { if (current) setError(errorMessage(failure)); },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  const clear = async () => {
    if (!await confirmDialog({
      title: "Clear error log?",
      message: "This deletes all recorded application errors. Revqora will continue recording new errors.",
      confirm: "Clear log",
      danger: true,
    })) return;
    setClearing(true);
    try {
      await clearErrorLog();
      setEntries([]);
      setLoading(true);
      setRevision(value => value + 1);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setClearing(false);
    }
  };

  return <Modal title="Error log" subtitle="Application errors from the last 7 days" icon={<Bug size={18} />} wide onClose={close} footer={<>
    <button type="button" className="btn" onClick={() => setRevision(value => value + 1)} disabled={loading || clearing}><RefreshCw size={14} /> Refresh</button>
    <button type="button" className="btn" disabled={loading || clearing || !!error || !entries.length}
      onClick={() => void copyText(entries.map(formatEntry).join("\n\n"), "Error log copied")}><Copy size={14} /> Copy all</button>
    <button type="button" className="btn" disabled={loading || clearing || !entries.length}
      onClick={() => void clear()}><Trash2 size={14} /> {clearing ? "Clearing…" : "Clear log"}</button>
    <button type="button" className="btn" onClick={close}>Close</button>
  </>}>
    <div className="error-log" aria-busy={loading || clearing}>
      {error ? <p role="alert" className="error-text">{error}</p>
        : !entries.length ? <p className="muted">{loading ? "Reading errors…" : "No errors recorded."}</p>
        : entries.map(entry => <article key={entry.id}>
          <header>
            <strong>{entry.source}</strong>
            <time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleString()}</time>
            <span className="muted">{entry.code}{entry.count > 1 ? ` · ×${entry.count}` : ""}</span>
            <button type="button" className="icon-btn sm" aria-label="Copy error" title="Copy error"
              onClick={() => void copyText(formatEntry(entry), "Error copied")}><Copy size={14} /></button>
          </header>
          <pre className="selectable">{entry.message}</pre>
        </article>)}
    </div>
  </Modal>;
}
