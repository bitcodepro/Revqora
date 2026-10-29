import { useEffect, useState } from "react";
import { Play, Square, Terminal, X } from "lucide-react";
import { api } from "../lib/api";
import { useRepos } from "../lib/store";
import { useSettings } from "../lib/settings";
import { toast, showDialog } from "../lib/ui";
import { refreshValidation, useValidation, validationFresh, validationRunning } from "../lib/validation";
import { confirmDialog } from "./dialogs";
import { Modal } from "./Modal";
import { conflictHasUnsaved, useConflictDrafts } from "../lib/conflictStudio";
import "../styles/conflictStudio.css";
const NO_COMMANDS: string[] = [];

export function validationDialog(root: string) {
  return showDialog<void>((close) => <Modal title="Validate the resolution" wide onClose={() => close()} footer={<button className="btn" onClick={() => close()}>Close</button>}><ConflictValidation root={root} /></Modal>);
}
export function ConflictValidation({ root, dirty: localDirty = false, onClose }: { root: string; dirty?: boolean; onClose?: () => void }) {
  useConflictDrafts((s) => s.version);
  const dirty = localDirty || conflictHasUnsaved(root);
  const saved = useSettings((s) => s.validationCommands[root] ?? NO_COMMANDS);
  const [command, setCommand] = useState(saved[0] ?? "");
  const [timeout, setTimeoutSeconds] = useState(300);
  const [starting, setStarting] = useState(false);
  const report = useValidation((s) => s.reports[root]);
  const token = useRepos((s) => s.tabs[root]?.status?.stateToken);
  const busy = starting || validationRunning(report);
  const fresh = validationFresh(report, token, dirty, root);
  useEffect(() => { void refreshValidation(root).catch(toast.error); }, [root]);
  const run = async () => {
    if (busy || dirty || !command.trim()) return;
    setStarting(true);
    try {
      const state = await api.status(root);
      const ok = await confirmDialog({ title: "Run validation command", message: "Runs in this repository using cmd.exe on Windows or /bin/sh on Unix. Only run commands you trust. A recovery checkpoint of Git-visible files and the index is saved first; ignored build files are excluded.", details: [root, command], confirm: "Run command" });
      if (!ok || !state.stateToken) return;
      const r = await api.validationStart(root, command, state.stateToken, timeout);
      useValidation.getState().set(root, r);
      const commands = useSettings.getState().validationCommands;
      useSettings.getState().set({ validationCommands: { ...commands, [root]: [command, ...(commands[root] ?? []).filter((c) => c !== command)].slice(0, 8) } });
      void refreshValidation(root).catch(toast.error);
    } catch (e) { toast.error(e); } finally { setStarting(false); }
  };
  return <section className="cf-validation" aria-label="Resolution validation">
    <div className="hstack"><Terminal size={15} /><strong>Validate the resolution</strong><span className="muted">Optional · runs only when you choose Run</span><div className="spacer" />{onClose && <button className="icon-btn" title="Hide validation" onClick={onClose}><X size={14} /></button>}</div>
    <div className="cf-validation-command">
      <input className="input mono" aria-label="Validation command" list="validation-commands" value={command} placeholder="npm test, dotnet test, cargo test…" disabled={busy} onChange={(e) => setCommand(e.target.value)} />
      <datalist id="validation-commands">{saved.map((c) => <option key={c} value={c} />)}</datalist>
      <label className="hstack muted">Timeout <input className="input" aria-label="Validation timeout seconds" type="number" min={1} max={1800} value={timeout} disabled={busy} onChange={(e) => setTimeoutSeconds(Number(e.target.value))} /> s</label>
      {validationRunning(report) ? <button className="btn" onClick={() => api.validationCancel(root, report!.id).catch(toast.error)}><Square size={13} /> Cancel check</button> : <button className="btn primary" disabled={busy || dirty || !command.trim() || !Number.isInteger(timeout) || timeout < 1 || timeout > 1800} onClick={run}><Play size={13} /> Run</button>}
    </div>
    {dirty && <div className="muted">Save drafts in all edited conflict files before running: checks read the files on disk.</div>}
    {report && <>
      <div className="cf-validation-status" data-phase={report.phase} data-fresh={fresh}><strong>{validationRunning(report) ? report.phase === "queued" ? "Queued" : "Running…" : fresh ? "Passed · current Git-visible state" : report.phase === "passed" ? "Passed · stale result, run again" : report.phase}</strong><span className="muted">{(report.elapsedMs / 1000).toFixed(1)} s{report.exitCode !== null ? ` · exit ${report.exitCode}` : ""}</span></div>
      <code className="cf-validation-ran">{report.command}</code>
      <div className="muted cf-validation-ran">Working directory: {report.repositoryRoot}</div>
      {report.error && <div className="error">{report.error}</div>}
      <pre className="cf-validation-output" tabIndex={0}>{report.stdout || report.stderr ? `${report.stdout}${report.stderr ? `\n[stderr]\n${report.stderr}` : ""}` : "No output yet."}</pre>
      {report.truncated && <div className="muted">Output truncated to 128 KiB per stream.</div>}
    </>}
  </section>;
}
