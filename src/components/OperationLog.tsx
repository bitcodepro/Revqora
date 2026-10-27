import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Clock3, Copy, Download, Loader2, RefreshCw, ScrollText, Search, Trash2, TriangleAlert } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename, shortOid } from "../lib/format";
import type { OperationLogDetail, OperationLogEntry, OperationLogFilter, OperationLogHealth, OperationLogStatus, OperationLogStep } from "../lib/types";
import { copyText, showDialog, toast } from "../lib/ui";
import { confirmDialog } from "./dialogs";
import { Modal } from "./Modal";
import "../styles/operationLog.css";

const STATUS: Record<OperationLogStatus, string> = {
  queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed",
  attention: "Needs attention", interrupted: "Outcome unknown",
};
const active = (entry: OperationLogEntry) => entry.status === "queued" || entry.status === "running";
const label = (command: string) => command.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const duration = (ms: number | null) => ms === null ? "—" : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`;
const date = (ms: number) => new Date(ms).toLocaleString();

export function operationLogDialog(root: string | null = null) {
  return showDialog<void>((close) => <OperationLog root={root} close={close} />);
}

export function OperationLogButton({ root }: { root?: string | null }) {
  const [health, setHealth] = useState<OperationLogHealth | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => { void api.operationLogHealth().then((h) => { if (alive) setHealth(h); }, () => {}); };
    load();
    const subscription = listen("operation-log-changed", load);
    return () => { alive = false; void subscription.then((unlisten) => unlisten()); };
  }, []);
  const warning = !!health && (!health.available || !!health.warning);
  return <button type="button" className={`icon-btn operation-log-open ${warning ? "log-warning" : ""}`} title={warning ? `Operation log needs attention: ${health?.warning ?? "unavailable"}` : "Operation log"} aria-label="Operation log" onClick={() => void operationLogDialog(root ?? null)}><ScrollText size={16} />{warning && <span className="log-warning-dot" />}</button>;
}

function OperationLog({ root, close }: { root: string | null; close: () => void }) {
  const [scope, setScope] = useState(root ? "repository" : "all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<OperationLogStatus | "">("");
  const [days, setDays] = useState("0");
  const [entries, setEntries] = useState<OperationLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OperationLogDetail | null>(null);
  const [health, setHealth] = useState<OperationLogHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [older, setOlder] = useState(false);
  const [changed, setChanged] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const readingOlder = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 200); return () => clearTimeout(timer); }, [search]);
  const filter = useMemo<OperationLogFilter>(() => ({ repo: scope === "repository" ? root : null, status: status || null, search: query, since: days === "0" ? null : Date.now() - Number(days) * 86400000 }), [scope, root, status, query, days]);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    readingOlder.current = false;
    setLoading(true);
    const h = await api.operationLogHealth().catch(() => null);
    if (!alive.current || current !== generation.current) return;
    setHealth(h);
    try {
      const page = await api.operationLogList(filter);
      if (!alive.current || current !== generation.current) return;
      setEntries(page.entries); setTotal(page.total); setNext(page.next);
      setSelected((id) => id && page.entries.some((entry) => entry.id === id) ? id : page.entries[0]?.id ?? null);
      setError(null); setChanged(false); setOlder(false); setRevision((v) => v + 1);
    } catch (e) { if (alive.current && current === generation.current) setError(errorMessage(e)); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  }, [filter]);
  useEffect(() => { setSelected(null); setEntries([]); setTotal(0); setNext(null); void reload(); }, [reload]);
  const running = entries.some(active);
  useEffect(() => {
    const changed = () => { if (!alive.current) return; if (readingOlder.current) setChanged(true); else void reload(); };
    const subscription = listen("operation-log-changed", changed);
    const timer = running && !older ? setInterval(changed, 1500) : null;
    return () => { if (timer) clearInterval(timer); void subscription.then((unlisten) => unlisten()); };
  }, [reload, older, running]);
  useEffect(() => {
    let cancelled = false;
    setDetail((previous) => previous?.entry.id === selected ? previous : null); setDetailError(null);
    if (selected) void api.operationLogDetail(selected).then((d) => { if (!cancelled) setDetail(d); }, (e) => { if (!cancelled) setDetailError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, [selected, revision]);

  const more = async () => {
    if (!next || loading) return;
    const current = ++generation.current;
    readingOlder.current = true;
    setLoading(true); setOlder(true);
    try {
      const page = await api.operationLogList({ ...filter, before: next });
      if (!alive.current || current !== generation.current) return;
      setEntries((items) => [...items, ...page.entries.filter((entry) => !items.some((e) => e.id === entry.id))]);
      setNext(page.next); setTotal(page.total); setError(null);
    } catch (e) { if (alive.current && current === generation.current) setError(errorMessage(e)); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  };
  const task = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast.error(e); } finally { if (alive.current) { setBusy(false); void reload(); } } };
  const exportLog = async () => {
    const destination = await save({ title: "Export operation log", defaultPath: `Revqora-operations-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (destination) await task(async () => { const count = await api.operationLogExport(filter, destination); toast.success(`Exported ${count} operation${count === 1 ? "" : "s"}`); });
  };
  const clearHistory = async () => {
    if (!await confirmDialog({ title: "Clear completed operation history?", message: "Permanently removes completed diagnostic entries matching these filters. Running and queued entries remain.", confirm: "Clear completed entries", danger: true })) return;
    await task(async () => { const count = await api.operationLogClear(filter); toast.success(`Cleared ${count} completed entries`); });
  };

  return <Modal title="Operation log" subtitle="Local history of Git actions" wide icon={<ScrollText size={18} />} onClose={() => { if (!busy) close(); }} footer={<>
    <span className="faint log-retention">{health?.retentionDays ?? 30} days · {health?.maxEntries ?? 2000} completed entries · bounded diagnostic output</span>
    <button type="button" className="btn" disabled={busy} onClick={close}>Close</button>
  </>}>
    <div className="operation-log">
      <div className="log-toolbar">
        <label className="log-search"><Search size={14} /><input aria-label="Search operation log" placeholder="Search actions, repositories, error kinds…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <select className="input log-scope" aria-label="Operation log scope" value={scope} onChange={(e) => setScope(e.target.value)}>{root && <option value="repository">{basename(root)} + worktrees</option>}<option value="all">All repositories</option></select>
        <select className="input log-status-filter" aria-label="Operation status" value={status} onChange={(e) => setStatus(e.target.value as OperationLogStatus | "")}><option value="">All results</option>{Object.entries(STATUS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select>
        <select className="input log-date-filter" aria-label="Operation log period" value={days} onChange={(e) => setDays(e.target.value)}><option value="0">All dates</option><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
        <button type="button" className={`icon-btn ${changed ? "active" : ""}`} title={changed ? "New activity — refresh" : "Refresh operation log"} disabled={loading || busy} onClick={() => void reload()}><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
        <button type="button" className="btn sm log-export" disabled={busy || !total || !health?.available} onClick={() => void exportLog()}><Download size={13} /> Export…</button>
        <button type="button" className="icon-btn log-clear" title="Clear completed entries matching filters" disabled={busy || !entries.some((e) => !active(e))} onClick={() => void clearHistory()}><Trash2 size={14} /></button>
      </div>
      {health && (!health.available || health.warning) && <div className="log-health callout warn"><TriangleAlert size={16} /><span>Journal needs attention. Some actions may be missing or incomplete. {health.warning}</span><button type="button" className="btn sm" disabled={busy} onClick={() => void task(async () => { await api.operationLogRetry(); })}>Retry logging</button></div>}
      {error && <div className="log-error callout warn">{error}</div>}
      <div className="log-body">
        <div className="log-list" aria-label="Recorded operations">
          <div className="log-list-caption">{total} operation{total === 1 ? "" : "s"}{older && <span className="faint"> · live list paused{changed ? " · new activity" : ""}</span>}</div>
          {!entries.length && !loading && <div className="log-empty"><ScrollText size={25} /><b>No operations found</b><span>Git actions performed in Revqora appear here. Adjust the filters to see earlier entries.</span></div>}
          {entries.map((entry) => <button type="button" key={entry.id} className={`log-row ${selected === entry.id ? "selected" : ""}`} aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}>
            <div className="log-row-title"><b>{label(entry.command)}</b><span className={`log-state ${entry.status}`}>{active(entry) && <Loader2 size={11} className="spin" />}{STATUS[entry.status]}</span></div>
            <div className="log-row-meta"><span title={entry.repo}>{basename(entry.repo)}</span><time dateTime={new Date(entry.requestedAt).toISOString()}>{date(entry.requestedAt)}</time></div>
            <div className="log-row-meta"><span>{entry.errorKind ?? entry.outcome ?? ""}</span><span><Clock3 size={10} /> {duration(entry.durationMs ?? (active(entry) ? Date.now() - entry.requestedAt : null))}</span></div>
          </button>)}
          {loading && <div className="log-loading"><Loader2 size={16} className="spin" /> Loading…</div>}
          {next && <button type="button" className="btn log-more" disabled={loading || busy} onClick={() => void more()}>Load older operations</button>}
        </div>
        <section className="log-detail" aria-label="Operation details">
          {detailError ? <div className="log-empty">{detailError}</div> : detail ? <LogDetail key={detail.entry.id} detail={detail} /> : <div className="log-empty">{selected ? <Loader2 size={20} className="spin" /> : "Select an operation to inspect its commands and result."}</div>}
        </section>
      </div>
      <div className="log-privacy">Stored locally. Standard input and content-query output are omitted; recognized credentials are redacted. Review diagnostic output before sharing.</div>
    </div>
  </Modal>;
}

function Head({ value }: { value: string | null }) {
  let head: { branch?: string | null; oid?: string | null } | null = null;
  try { head = value ? JSON.parse(value) : null; } catch { /* Older or incomplete metadata. */ }
  return head ? <span>{head.branch ?? "detached"} · <code title={head.oid ?? ""}>{shortOid(head.oid) || "unborn"}</code></span> : <span className="faint">Not recorded</span>;
}

function LogDetail({ detail: { entry, steps } }: { detail: OperationLogDetail }) {
  return <>
    <div className="log-detail-head"><div><h3>{label(entry.command)}</h3><span className={`log-state ${entry.status}`}>{STATUS[entry.status]}</span></div><button type="button" className="btn sm log-copy" onClick={() => void copyText(JSON.stringify({ entry, steps }, null, 2), "Operation details copied")}><Copy size={13} /> Copy details</button></div>
    <dl className="log-metadata">
      <dt>Repository / worktree</dt><dd>{entry.repo}</dd><dt>Requested</dt><dd>{date(entry.requestedAt)}</dd>
      {entry.startedAt !== null && <><dt>Started</dt><dd>{date(entry.startedAt)}</dd></>}
      {entry.finishedAt !== null && <><dt>Result recorded</dt><dd>{date(entry.finishedAt)}</dd></>}
      <dt>Queue wait</dt><dd>{duration(entry.waitMs ?? (entry.status === "queued" ? Date.now() - entry.requestedAt : null))}</dd><dt>Total duration</dt><dd>{duration(entry.durationMs ?? (active(entry) ? Date.now() - entry.requestedAt : null))}</dd>
      <dt>HEAD before</dt><dd><Head value={entry.beforeHead} /></dd><dt>HEAD after</dt><dd><Head value={entry.afterHead} /></dd>
      {entry.outcome && <><dt>Git workflow</dt><dd>{entry.outcome}</dd></>}
    </dl>
    {entry.error && entry.status !== "interrupted" && <div className="log-result-error"><b>{entry.errorKind}</b><pre>{entry.error}</pre></div>}
    {entry.status === "attention" && <div className="log-notice">This action stopped for conflicts, editing or confirmation. Complete or abort the Git workflow from the repository view.</div>}
    {entry.status === "interrupted" && <div className="log-notice">The app stopped recording this action. Git may have continued after the app closed; its final result is unknown. Refresh the repository before another action.</div>}
    {entry.truncated && <div className="log-notice">Some diagnostics were truncated to keep the journal bounded.</div>}
    <h4 className="log-commands-title">Git commands <span className="faint">({steps.length})</span></h4>
    {!steps.length && <div className="faint">{entry.status === "queued" ? "Waiting for the repository queue." : "No Git command results were recorded."}</div>}
    {steps.map((step) => <CommandStep key={step.sequence} step={step} />)}
  </>;
}

function CommandStep({ step }: { step: OperationLogStep }) {
  const command = `git ${step.args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ")}`;
  return <details className="log-command" open={step.exitCode !== null && step.exitCode !== 0 && !!step.stderr}>
    <summary><code>{command}</code><span>{step.exitCode === null ? "No exit recorded" : `Exit ${step.exitCode}`} · {duration(step.durationMs)}</span></summary>
    <div className="log-command-output"><div className="faint">Started: {date(step.startedAt)}</div><div className="faint">Working directory: {step.cwd}</div>
      {step.stdout && <><b>stdout</b><pre>{step.stdout}</pre></>}{step.stderr && <><b>stderr</b><pre>{step.stderr}</pre></>}
      {step.outputOmitted && <div className="faint">Some output is omitted by the logging policy.</div>}
      {!step.stdout && !step.stderr && !step.outputOmitted && <div className="faint">No output recorded.</div>}
      {step.truncated && <div className="faint">Diagnostics truncated.</div>}
    </div>
  </details>;
}
