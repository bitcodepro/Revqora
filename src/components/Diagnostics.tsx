import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, ClipboardCopy, HelpCircle, Loader2, RefreshCw, Stethoscope, XCircle } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { CHECK_CAUSES, CHECK_STATES, checkFacts, connectionLines } from "../lib/diagnostics";
import type { ConnectionCheckItem, ConnectionCheckReport, DiagnosticsInput } from "../lib/types";
import { copyText, showDialog } from "../lib/ui";
import { Modal } from "./Modal";
import "../styles/diagnostics.css";

/** Shows the exact report text before it is copied. */
export function diagnosticsDialog(input: DiagnosticsInput) {
  return showDialog<void>(close => <DiagnosticsPreview input={input} close={close} />);
}

function DiagnosticsPreview({ input, close }: { input: DiagnosticsInput; close: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api.diagnosticsReport(input).then(value => { if (current) setText(value); }, failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [input]);
  return <Modal title="Diagnostics report" subtitle="Review the text before you share it" icon={<ClipboardCopy size={18} />} wide onClose={close} footer={<>
    <button type="button" className="btn" onClick={close}>Close</button>
    <button type="button" className="btn primary" disabled={!text} onClick={() => { if (text) void copyText(text, "Diagnostics report copied"); }}><ClipboardCopy size={14} /> Copy report</button>
  </>}>
    <p className="muted">Tokens, authorization headers, credentials in URLs, private keys and file contents are removed. The report includes the Revqora and Git versions and the platform.</p>
    {error ? <p role="alert" className="error-text">{error}</p>
      : text === null ? <p className="loading-status" role="status"><Loader2 size={14} className="spin" /> Preparing the report…</p>
      : <pre className="selectable diagnostics-preview" aria-label="Diagnostics report text">{text}</pre>}
  </Modal>;
}

const ICONS: Record<ConnectionCheckItem["state"], React.ReactNode> = {
  ok: <CheckCircle2 size={16} />, failed: <XCircle size={16} />, limited: <AlertTriangle size={16} />, "not-verified": <HelpCircle size={16} />, skipped: <CircleDashed size={16} />,
};

/** "Check connection": Git read and push access and each API capability of one remote. */
export function connectionCheckDialog(root: string, remote: string | null = null) {
  return showDialog<void>(close => <ConnectionCheck root={root} initialRemote={remote} close={close} />);
}

function ConnectionCheck({ root, initialRemote, close }: { root: string; initialRemote: string | null; close: () => void }) {
  const [remote, setRemote] = useState(initialRemote);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [report, setReport] = useState<ConnectionCheckReport | null>(null);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState("");
  const run = useRef(0);
  const check = (name: string | null) => {
    const id = ++run.current;
    setRunning(true);
    setError("");
    void api.connectionCheck(root, name).then(
      result => { if (id === run.current) { setReport(result); setRemote(result.remote); } },
      failure => { if (id === run.current) setError(errorMessage(failure)); },
    ).finally(() => { if (id === run.current) setRunning(false); });
  };
  useEffect(() => {
    check(initialRemote);
    void api.forgeConnections(root).then(connections => setRemotes(connections.remotes.map(r => r.name)), () => {});
    return () => { run.current++; };
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  // Results of another remote are cleared at once, so they are never read as this one's.
  const visible = report && report.remote === remote ? report : null;
  return <Modal title="Check connection" subtitle={visible ? `${visible.repository}${visible.provider ? ` · ${visible.provider}` : ""}` : root} icon={<Stethoscope size={18} />} wide onClose={close} footer={<>
    <button type="button" className="btn" onClick={close}>Close</button>
    <button type="button" className="btn" disabled={!visible || running} onClick={() => { if (visible) void diagnosticsDialog({ source: "Check connection", lines: connectionLines(visible) }); }}><ClipboardCopy size={14} /> Copy diagnostics…</button>
    <button type="button" className="btn primary" disabled={running} onClick={() => check(remote)}><RefreshCw size={14} className={running ? "spin" : ""} /> Check again</button>
  </>}>
    <p className="muted">Nothing is pushed, fetched or changed: Git lists the server's branches, a push dry run sends no commits, and the API checks read the profile, the pull request list and the first open pull request's files and checks. No sign-in prompt opens.</p>
    <dl className="connection-facts">
      <dt>Remote</dt><dd>{remotes.length > 1
        ? <select className="select" aria-label="Remote to check" value={remote ?? ""} disabled={running} onChange={e => { setRemote(e.target.value); setReport(null); check(e.target.value); }}>
          {remotes.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        : visible?.remote ?? remote ?? "—"}</dd>
      <dt>URL</dt><dd>{visible?.url ? <code className="selectable">{visible.url}</code> : "—"}</dd>
      <dt>Provider</dt><dd>{visible?.provider ? `${visible.provider}${visible.project ? ` · ${visible.project}` : ""}` : visible ? "Not detected" : "—"}</dd>
      <dt>Credentials</dt><dd>{visible?.credentialSource ?? "—"}</dd>
    </dl>
    {error && <p role="alert" className="error-text">{error}</p>}
    {running && !visible && <p className="loading-status" role="status"><Loader2 size={14} className="spin" /> Checking… (up to 30 s per step)</p>}
    {visible && <ul className="connection-checks" aria-busy={running}>
      {visible.items.map(item => <li key={item.id} data-state={item.state} data-check={item.id}>
        <span className="connection-check-icon" aria-hidden="true">{ICONS[item.state]}</span>
        <div>
          <div className="connection-check-title"><b>{item.label}</b><span className="connection-check-state">{CHECK_STATES[item.state]}</span><span className="faint">{checkFacts(item)}</span></div>
          <p className="selectable">{item.detail}</p>
          {item.cause && <p className="connection-check-cause">Cause: {CHECK_CAUSES[item.cause]}</p>}
          {item.next && <p className="connection-check-next">Next step: {item.next}</p>}
        </div>
      </li>)}
    </ul>}
  </Modal>;
}
