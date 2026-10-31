import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Download, ExternalLink, FileDiff, GitPullRequest, GitPullRequestCreate, List, Loader2, Maximize2, MinusCircle, Pencil, RefreshCw, Search, XCircle } from "lucide-react";
import { forgeAccountsDialog } from "./ForgeAccounts";
import { api, errorMessage, isGitError } from "../lib/api";
import { getTab, type RepoTab } from "../lib/store";
import { showDialog, toast, copyText } from "../lib/ui";
import * as A from "../lib/actions";
import type { Check, ForgeInfo, PullRequest, PrDetail, PrEditResult, PrFile, PrFileView, PrState, PrTemplates } from "../lib/types";
import { relativeTime, shortOid } from "../lib/format";
import { appendPullRequests, loadPrPreferences, prPreferencesKey, pullRequestNumber, restorePrPreferences, safeWebUrl, searchPullRequests, utf8Length, type PrPreferences } from "../lib/prCenter";
import { Modal } from "./Modal";
import { Splitter } from "./Overlays";
import { DiffView } from "./DiffView";
import { confirmDialog } from "./dialogs";

const FORGE_NAMES: Record<string, string> = { github: "GitHub", azure: "Azure DevOps", gitlab: "GitLab", bitbucket: "Bitbucket Cloud", "bitbucket-server": "Bitbucket Server" };
const browser = (url: string) => { const safe = safeWebUrl(url); if (safe) void api.openPath(safe); };

export function CheckIcon({ state, size = 14 }: { state: Check["state"]; size?: number }) {
  switch (state) {
    case "success": return <CheckCircle2 size={size} style={{ color: "var(--green)" }} />;
    case "failure": return <XCircle size={size} style={{ color: "var(--red)" }} />;
    case "pending": return <CircleDashed size={size} className="spin" style={{ color: "var(--amber)", animationDuration: "2.4s" }} />;
    default: return <MinusCircle size={size} style={{ color: "var(--text-faint)" }} />;
  }
}
export function ChecksList({ checks }: { checks: Check[] }) {
  if (!checks.length) return <div className="faint">No CI checks reported for this commit.</div>;
  return <div className="vstack" style={{ gap: 4 }}>{checks.map((c, i) => <div key={i} className="hstack" style={{ gap: 8 }}><CheckIcon state={c.state} /><span className="ellipsis" style={{ flex: 1 }}>{c.name}</span>{safeWebUrl(c.url) && <button className="icon-btn sm" title="Open" onClick={() => browser(c.url!)}><ExternalLink size={12} /></button>}</div>)}</div>;
}
export function summarizeChecks(checks: Check[]): Check["state"] | null { return !checks.length ? null : checks.some(c => c.state === "failure") ? "failure" : checks.some(c => c.state === "pending") ? "pending" : "success"; }

export function PullRequestsView({ tab }: { tab: RepoTab }) {
  const root = tab.root;
  const [prefs, setPrefs] = useState(() => loadPrPreferences(root)), [listWidth, setListWidth] = useState(prefs.listWidth);
  const [forge, setForge] = useState<ForgeInfo | null>(null), [items, setItems] = useState<PullRequest[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [query, setQuery] = useState(""), [selected, setSelected] = useState<number | null>(null), [epoch, setEpoch] = useState(0);
  const generation = useRef(0), busy = useRef(false), preferred = useRef<number | null>(null);
  const savePreferences = (patch: Partial<PrPreferences>) => setPrefs(p => restorePrPreferences({ ...p, ...patch }));
  useEffect(() => { try { localStorage.setItem(prPreferencesKey(root), JSON.stringify(prefs)); } catch { toast.warning("PR Center preferences could not be saved"); } }, [root, prefs]);
  const load = useCallback(async (next: string | null = null) => {
    if (next && busy.current) return;
    const id = next ? generation.current : ++generation.current;
    busy.current = true; setLoading(true); setError("");
    if (!next) { setItems([]); setCursor(null); setForge(null); setSelected(null); setEpoch(e => e + 1); }
    try {
      const page = await api.prPage(root, prefs.state, next);
      if (id !== generation.current) return;
      setForge(page.forge); setItems(old => next ? appendPullRequests(old, page.items) : page.items); setCursor(page.nextCursor);
      if (!next) setSelected(preferred.current ?? page.items[0]?.number ?? null);
    } catch (e) { if (id === generation.current) setError(errorMessage(e)); }
    finally { if (id === generation.current) { busy.current = false; setLoading(false); } }
  }, [root, prefs.state]);
  useEffect(() => { void load(); const changed = () => { preferred.current = null; void load(); }; window.addEventListener("revqora:forge-accounts", changed); return () => { generation.current++; busy.current = false; window.removeEventListener("revqora:forge-accounts", changed); }; }, [load]);
  const visible = useMemo(() => searchPullRequests(items, query), [items, query]);
  const direct = pullRequestNumber(query);
  const refresh = () => { preferred.current = selected; void load(); };
  const created = async () => { const p = await createPullRequest(root, forge); if (p) { preferred.current = p.number; if (prefs.state !== "open") savePreferences({ state: "open" }); else void load(); } };
  const updated = (p: PullRequest) => setItems(old => old.map(row => row.number === p.number ? p : row));
  return <section className={`pr-center ${!prefs.listOpen ? "pr-list-hidden" : ""}`} aria-label="Pull Request Center" style={{ "--pr-list-width": `${listWidth}px` } as CSSProperties}>
    {prefs.listOpen && <aside className="pr-list-panel" aria-label="Pull request list">
      <div className="pr-list-heading"><GitPullRequest size={17} /><b>Pull requests</b><span className="pill" data-pr-loaded={items.length}>{items.length}</span><div className="spacer" /><button className="icon-btn" title="Hide pull request list" aria-label="Hide pull request list" onClick={() => savePreferences({ listOpen: false })}><ChevronLeft size={16} /></button></div>
      <div className="pr-list-tools"><select className="select" aria-label="Request status" value={prefs.state} onChange={e => { preferred.current = null; savePreferences({ state: e.target.value as PrState }); }}>{(["open", "closed", "merged", "all"] as const).map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select><button className="icon-btn" title="Refresh pull requests" aria-label="Refresh pull requests" disabled={loading} onClick={refresh}><RefreshCw size={15} className={loading ? "spin" : ""} /></button><button className="btn sm primary" disabled={!forge?.connectionRevision || loading} onClick={() => void created()}><GitPullRequestCreate size={14} />New</button></div>
      <div className="pr-search"><Search size={14} /><input className="input" aria-label="Search loaded pull requests" placeholder="Search loaded PRs or open #…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && direct && forge) setSelected(direct); }} /></div>
      {direct && forge && <button className="btn sm pr-direct" onClick={() => setSelected(direct)}>Open #{direct}</button>}
      {error && <div className="callout warn" role="alert">{error}<button className="btn sm" onClick={refresh}>Try again</button></div>}
      <RequestRows rows={visible} selected={selected} select={setSelected} resetKey={`${query}:${prefs.state}`} />
      {!visible.length && !loading && !error && <p className="pr-list-empty">No matching requests in the loaded pages.{cursor ? " Load more or open a request by number." : ""}</p>}
      <footer className="pr-list-footer">{loading ? <span role="status"><Loader2 size={13} className="spin" /> Loading requests…</span> : cursor ? <button className="btn sm" onClick={() => void load(cursor)}>Load more requests</button> : <span className="faint">{items.length} loaded</span>}</footer>
    </aside>}
    {prefs.listOpen && <Splitter dir="v" style={{ left: "clamp(200px, var(--pr-list-width), 35%)" }} onDrag={d => setListWidth(w => Math.max(200, Math.min(520, w + d)))} onEnd={() => savePreferences({ listWidth })} />}
    <main className="pr-content">
      <header className="pr-center-head"><button className="icon-btn" title={prefs.listOpen ? "Hide pull request list" : "Show pull request list"} aria-label={prefs.listOpen ? "Collapse pull request list" : "Show pull request list"} onClick={() => savePreferences({ listOpen: !prefs.listOpen })}><List size={16} /></button><div className="pr-connection"><b className="ellipsis" title={forge?.project}>PR Center{forge ? ` · ${forge.project}` : ""}</b><small>{forge ? `${FORGE_NAMES[forge.kind]} · ${forge.remote} · ${forge.accountLogin ?? "Git credentials"}` : "Choose an API account and remote to browse requests"}</small></div><div className="spacer" /><button className="btn sm" onClick={() => void forgeAccountsDialog(root)}>Accounts…</button>{!prefs.listOpen && <><button className="icon-btn" aria-label="Refresh pull requests" disabled={loading} onClick={refresh}><RefreshCw size={15} /></button><button className="btn sm primary" disabled={!forge?.connectionRevision || loading} onClick={() => void created()}>New PR</button></>}</header>
      {!prefs.listOpen && error && <div className="callout warn" role="alert">{error}</div>}
      {forge?.connectionRevision && selected ? <RequestDetail key={`${forge.connectionRevision}:${selected}:${epoch}`} root={root} forge={forge} number={selected} prefs={prefs} savePreferences={savePreferences} updated={updated} /> : <div className="pr-empty">{loading ? <><Loader2 size={22} className="spin" />Loading pull requests…</> : error ? "Configure the API connection or refresh to continue." : "Select a pull request or open one by number."}</div>}
    </main>
  </section>;
}

function RequestRows({ rows, selected, select, resetKey }: { rows: PullRequest[]; selected: number | null; select: (n: number) => void; resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null), [top, setTop] = useState(0), [height, setHeight] = useState(500), rowHeight = 82;
  useEffect(() => { const el = ref.current; if (!el) return; const observer = new ResizeObserver(() => setHeight(el.clientHeight)); observer.observe(el); return () => observer.disconnect(); }, []);
  useEffect(() => { if (ref.current) ref.current.scrollTop = 0; setTop(0); }, [resetKey]);
  const first = Math.max(0, Math.floor(top / rowHeight) - 5), last = Math.min(rows.length, Math.ceil((top + height) / rowHeight) + 5);
  const move = (e: React.KeyboardEvent) => { if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || !rows.length) return; e.preventDefault(); const old = rows.findIndex(p => p.number === selected), i = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, old + (e.key === "ArrowDown" ? 1 : -1))); select(rows[i].number); if (ref.current) ref.current.scrollTop = Math.max(0, i * rowHeight - height / 2); };
  return <div className="pr-request-rows" ref={ref} role="listbox" aria-label="Pull requests" tabIndex={0} onKeyDown={move} onScroll={e => setTop(e.currentTarget.scrollTop)}><div style={{ height: first * rowHeight }} />{rows.slice(first, last).map(p => <button role="option" aria-selected={selected === p.number} data-pr-number={p.number} key={p.number} className={`pr-request-row ${selected === p.number ? "selected" : ""}`} onClick={() => select(p.number)}><span className="pr-row-title"><span className="mono faint">#{p.number}</span><b title={p.title}>{p.title}</b></span><span className="pr-row-meta"><span className={`pill pr-state-${p.state}`}>{p.draft && p.state === "open" ? "Draft" : p.state}</span><span className="ellipsis">{p.author}</span><span className="faint">{relativeTime(Date.parse(p.created) / 1000)}</span></span><small className="ellipsis" title={`${p.head} → ${p.base}`}>{p.head} → {p.base}</small></button>)}<div style={{ height: Math.max(0, rows.length - last) * rowHeight }} /></div>;
}

function RequestDetail({ root, forge, number, prefs, savePreferences, updated }: { root: string; forge: ForgeInfo; number: number; prefs: PrPreferences; savePreferences: (p: Partial<PrPreferences>) => void; updated: (p: PullRequest) => void }) {
  const connection = forge.connectionRevision!;
  const [detail, setDetail] = useState<PrDetail | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState<Check[] | null>(null), [checksError, setChecksError] = useState("");
  const generation = useRef(0), editing = useRef(false);
  const load = useCallback(async () => { const id = ++generation.current; setLoading(true); setError(""); setDetail(null); try { const d = await api.prDetail(root, number, connection); if (id === generation.current) setDetail(d); } catch (e) { if (id === generation.current) setError(errorMessage(e)); } finally { if (id === generation.current) setLoading(false); } }, [root, number, connection]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => { let alive = true; setChecks(null); setChecksError(""); if (detail?.pull.headSha && prefs.section === "overview") api.prChecks(root, number, connection, detail.revision).then(c => { if (alive) setChecks(c); }, e => { if (alive) setChecksError(errorMessage(e)); }); return () => { alive = false; }; }, [root, number, connection, detail?.revision, prefs.section]);
  const edit = async () => { if (!detail || editing.current) return; editing.current = true; const current = generation.current; try { const result = await showDialog<PrEditResult | null>(close => <RequestEditor root={root} forge={forge} initial={detail} close={close} />); if (result && generation.current === current) { setDetail(result.detail); updated(result.detail.pull); } } finally { editing.current = false; } };
  if (loading) return <div className="pr-empty" role="status"><Loader2 size={22} className="spin" />Loading #{number}…</div>;
  if (!detail) return <div className="pr-empty"><div className="callout warn" role="alert">{error || "Pull request unavailable."}</div><button className="btn" onClick={() => void load()}>Reload request</button></div>;
  const p = detail.pull;
  return <div className="pr-detail" data-pr-detail={p.number} data-pr-revision={detail.revision}>
    <header className="pr-detail-heading"><div className="pr-title-line"><span className="mono faint">#{p.number}</span><span className={`pill pr-state-${p.state}`}>{p.draft && p.state === "open" ? "Draft" : p.state}</span><h2 title={p.title}>{p.title}</h2></div><div className="pr-branch-line"><span className="ref local">{p.head}</span><span className="faint">→</span><span className="ref">{p.base}</span><span className="faint">by {p.author}</span></div><div className="pr-detail-actions"><div className="seg"><button className={prefs.section === "overview" ? "on" : ""} onClick={() => savePreferences({ section: "overview" })}>Overview</button><button className={prefs.section === "files" ? "on" : ""} onClick={() => savePreferences({ section: "files" })}><FileDiff size={13} />Files{detail.fileCount !== null ? ` (${detail.fileCount})` : ""}</button></div><div className="spacer" /><button className="btn sm" onClick={() => void edit()}><Pencil size={13} />Edit PR</button><button className="btn sm" disabled={!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(p.headSha)} onClick={() => void A.act(root, () => api.pullRequestCheckout(root, p.number, connection, p.headSha), { success: b => `Checked out ${b}`, busy: `Fetching #${p.number}` })}><Download size={13} />Check out</button><button className="icon-btn" title="Open pull request in browser" aria-label="Open pull request in browser" onClick={() => browser(p.url)}><ExternalLink size={15} /></button><button className="icon-btn" title="Reload request" aria-label="Reload request" onClick={() => void load()}><RefreshCw size={15} /></button></div><small className="pr-snapshot mono" title={`Target ${detail.baseSha} · source ${p.headSha}`}>Source {shortOid(p.headSha)} · target {shortOid(detail.baseSha)} · refresh to load newer changes</small></header>
    {prefs.section === "files" ? <RequestFiles key={detail.revision} root={root} forge={forge} detail={detail} prefs={prefs} savePreferences={savePreferences} /> : <div className="pr-overview"><div className="hstack"><b>Description</b><div className="spacer" /><button className="btn sm" onClick={() => void showDialog<void>(close => <Modal title={`#${p.number} · ${p.title}`} wide onClose={() => close()} footer={<button className="btn" onClick={() => close()}>Close</button>}><div className="pr-description-expanded">{detail.body || "No description."}</div></Modal>)}><Maximize2 size={13} />Expand description</button></div><div className="pr-description">{detail.body || <span className="faint">No description.</span>}</div><section className="pr-checks"><b>Checks for {shortOid(p.headSha)}</b>{checksError ? <div className="callout warn" role="alert">{checksError}</div> : checks === null ? <Loader2 size={16} className="spin" /> : <ChecksList checks={checks} />}</section></div>}
  </div>;
}

function RequestFiles({ root, forge, detail, prefs, savePreferences }: { root: string; forge: ForgeInfo; detail: PrDetail; prefs: PrPreferences; savePreferences: (p: Partial<PrPreferences>) => void }) {
  const [files, setFiles] = useState<PrFile[]>([]), [next, setNext] = useState<number | null>(null), [selected, setSelected] = useState<string | null>(null), [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState<string | null>(null), [view, setView] = useState<PrFileView | null>(null), [fileError, setFileError] = useState(""), [fileLoading, setFileLoading] = useState(false), [width, setWidth] = useState(prefs.filesWidth);
  const pages = useRef(0), requests = useRef(0), busy = useRef(false), connection = forge.connectionRevision!, n = detail.pull.number;
  const load = useCallback(async (offset = 0) => { if (offset && busy.current) return; const id = offset ? pages.current : ++pages.current; busy.current = true; setLoading(true); setError(""); if (!offset) { setFiles([]); setSelected(null); setNext(null); setView(null); } try { const p = await api.prFiles(root, n, connection, detail.revision, offset); if (id !== pages.current) return; setFiles(old => offset ? [...new Map([...old, ...p.items].map(f => [f.id, f])).values()] : p.items); setNotice(p.notice); setNext(p.nextOffset); if (!offset) setSelected(p.items[0]?.id ?? null); } catch (e) { if (id === pages.current) setError(errorMessage(e)); } finally { if (id === pages.current) { busy.current = false; setLoading(false); } } }, [root, n, connection, detail.revision]);
  useEffect(() => { void load(); return () => { pages.current++; requests.current++; busy.current = false; }; }, [load]);
  useEffect(() => { const id = ++requests.current; setView(null); setFileError(""); if (!selected) { setFileLoading(false); return; } setFileLoading(true); api.prFile(root, n, connection, detail.revision, selected).then(v => { if (id === requests.current) setView(v); }, e => { if (id === requests.current) setFileError(errorMessage(e)); }).finally(() => { if (id === requests.current) setFileLoading(false); }); return () => { requests.current++; }; }, [root, n, connection, detail.revision, selected]);
  const visible = files.filter(f => `${f.path} ${f.oldPath ?? ""}`.toLowerCase().includes(query.toLowerCase())), file = files.find(f => f.id === selected);
  return <section className={`pr-files ${prefs.filesOpen ? "" : "pr-files-hidden"}`} aria-label="Pull request files" style={{ "--pr-files-width": `${width}px` } as CSSProperties}>
    {prefs.filesOpen && <aside className="pr-file-panel"><div className="pr-list-heading"><b>{files.length} files loaded</b><div className="spacer" /><button className="icon-btn" aria-label="Hide PR files" title="Hide PR files" onClick={() => savePreferences({ filesOpen: false })}><ChevronLeft size={15} /></button></div><input className="input pr-file-search" aria-label="Search loaded PR files" placeholder="Find a changed file…" value={query} onChange={e => setQuery(e.target.value)} /><div className="pr-file-rows">{visible.map(f => <button className={`pr-file-row ${f.id === selected ? "selected" : ""}`} key={f.id} data-pr-file={f.path} onClick={() => setSelected(f.id)}><span className={`file-status status-${f.status}`}>{f.status}</span><span className="pr-file-name" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>{f.path}{f.oldPath && <small>from {f.oldPath}</small>}</span>{f.binary ? <small>binary</small> : f.additions !== null && <small className="pr-stats"><span>+{f.additions}</span><span>−{f.deletions}</span></small>}</button>)}{loading && <p role="status"><Loader2 size={14} className="spin" /> Loading files…</p>}{!loading && !visible.length && !error && <p className="faint">No matching files.</p>}</div>{next !== null && <button className="btn sm" disabled={loading} onClick={() => void load(next)}>Load more files</button>}<button className="btn sm" disabled={loading} onClick={() => void load()}>Reload PR files</button></aside>}
    {prefs.filesOpen && <Splitter dir="v" style={{ left: "clamp(160px, var(--pr-files-width), 35%)" }} onDrag={d => setWidth(w => Math.max(160, Math.min(480, w + d)))} onEnd={() => savePreferences({ filesWidth: width })} />}
    <div className="pr-diff">{notice && <div className="pr-notice" role="status">{notice}</div>}{error && <div className="callout warn" role="alert">{error}</div>}{view?.notice && <div className="callout warn" role="alert">{view.notice}</div>}<DiffView key={selected ?? "empty"} path={file?.path ?? ""} diff={view?.diff ?? null} loading={fileLoading || loading && !files.length} error={fileError || null} mode="readonly" sourceOptions={false} emptyText={view?.notice ? "A complete text diff is unavailable for this file." : "Select a changed file to review its diff."} badge={<span className="pill">PR snapshot</span>} actions={<button className="btn sm" onClick={() => savePreferences({ filesOpen: !prefs.filesOpen })}><FileDiff size={13} />{prefs.filesOpen ? "Hide files" : "Show files"}</button>} /></div>
  </section>;
}

export async function createPullRequest(root: string, forge: ForgeInfo | null): Promise<PullRequest | null> {
  try {
    const f = forge ?? await api.forgeInfo(root); if (!f?.connectionRevision) { toast.warning("Configure an API connection first"); return null; }
    const message = await api.lastMessage(root).catch(() => ""), tab = getTab(root);
    return showDialog<PullRequest | null>(close => <RequestEditor root={root} forge={f} seed={{ head: tab?.info?.head.branch ?? "", title: message.split("\n")[0] ?? "", body: message.split("\n").slice(1).join("\n").trim() }} close={close} />);
  } catch (e) { toast.error(e, "Could not prepare a pull request"); return null; }
}

type EditorProps = { root: string; forge: ForgeInfo } & ({ initial: PrDetail; seed?: never; close: (v: PrEditResult | null) => void } | { initial?: never; seed: { head: string; title: string; body: string }; close: (v: PullRequest | null) => void });
function RequestEditor(props: EditorProps) {
  const { root, forge, initial, seed } = props, connection = forge.connectionRevision!;
  const branches = getTab(root)?.refs?.remote.filter(b => b.remote === forge.remote).map(b => b.name.slice(forge.remote.length + 1)) ?? [];
  const defaultBase = initial?.pull.base ?? ["main", "master", "develop"].find(b => branches.includes(b) && b !== seed?.head) ?? branches.find(b => b !== seed?.head) ?? "main";
  const [snapshot, setSnapshot] = useState(initial ?? null), [title, setTitle] = useState(initial?.pull.title ?? seed?.title ?? ""), [body, setBody] = useState(initial?.body ?? seed?.body ?? ""), [base, setBase] = useState(defaultBase), [head, setHead] = useState(seed?.head ?? initial?.pull.head ?? "");
  const [draft, setDraft] = useState(false), [templates, setTemplates] = useState<PrTemplates>({ items: [], notice: null }), [template, setTemplate] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [uncertain, setUncertain] = useState(false), [checked, setChecked] = useState(false);
  const active = useRef(false), saved = useRef<PrEditResult | null>(null), listId = useId();
  const byteLength = utf8Length(body), valid = !!title.trim() && Array.from(title).length <= 256 && byteLength <= 65536 && !!base.trim() && !!head.trim();
  const dirty = title !== (snapshot?.pull.title ?? seed?.title ?? "") || body !== (snapshot?.body ?? seed?.body ?? "") || base !== (snapshot?.pull.base ?? defaultBase) || !initial && (head !== seed?.head || draft);
  useEffect(() => { let alive = true; api.prTemplates(root, connection).then(t => { if (alive) setTemplates(t); }, e => { if (alive) setTemplates({ items: [], notice: errorMessage(e) }); }); return () => { alive = false; }; }, [root, connection]);
  const finish = (r: PrEditResult | PullRequest | null) => { if (props.initial) props.close(r as PrEditResult | null); else props.close(r as PullRequest | null); };
  const dismiss = async () => { if (active.current) return; if (dirty && !await confirmDialog({ title: "Discard unsaved PR edits?", message: "The title, description and branch edits in this window will be discarded.", confirm: "Discard edits", danger: true })) return; finish(saved.current); };
  const applyTemplate = async () => { const t = templates.items.find(t => t.path === template); if (!t || active.current) return; if (body && !await confirmDialog({ title: "Replace the description?", message: "The selected template will replace the current description. Copy the current text first if you want to keep it.", confirm: "Replace description" })) return; setBody(t.body); };
  const reload = async () => { if (!snapshot || active.current) return; if (dirty && !await confirmDialog({ title: "Reload the server version?", message: "This replaces your current edits with the latest title, description and target branch from the server.", confirm: "Reload server version" })) return; active.current = true; setBusy(true); try { const d = await api.prDetail(root, snapshot.pull.number, connection); setSnapshot(d); setTitle(d.pull.title); setBody(d.body); setBase(d.pull.base); setHead(d.pull.head); setError(""); setNotice(""); setUncertain(false); } catch (e) { setError(errorMessage(e)); } finally { active.current = false; setBusy(false); } };
  const submit = async () => {
    if (active.current || !valid || uncertain && !checked) return; active.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (snapshot) { const r = await api.prEdit(root, snapshot.pull.number, connection, snapshot.revision, { title: title.trim(), body, base: base.trim() }); saved.current = r; setSnapshot(r.detail); if (r.notice) { setNotice(r.notice); return; } toast.success(`Updated #${r.detail.pull.number}`); finish(r); }
      else { const p = await api.prCreate(root, title.trim(), body, head.trim(), base.trim(), draft, connection); toast.success(`Opened #${p.number}`, p.url); finish(p); }
    } catch (e) { setError(errorMessage(e)); if (isGitError(e) && e.kind === "forge-write-uncertain") { setUncertain(true); setChecked(false); } }
    finally { active.current = false; setBusy(false); }
  };
  return <Modal title={initial ? `Edit #${initial.pull.number}` : "New pull request"} subtitle={`${forge.host}/${forge.project} · ${forge.accountLogin ?? "Git credentials"}`} icon={initial ? <Pencil size={18} /> : <GitPullRequestCreate size={18} />} wide onClose={() => void dismiss()} onSubmit={() => void submit()} footer={<><button type="button" className="btn" disabled={busy} onClick={() => void dismiss()}>Cancel</button><button type="submit" className="btn primary" disabled={busy || !valid || uncertain && !checked}>{busy && <Loader2 size={14} className="spin" />}{initial ? "Save pull request" : "Create pull request"}</button></>}>
    <fieldset className="pr-editor" disabled={busy} data-pr-editor={initial ? "edit" : "create"}>
      <label className="field">Title<input className="input" aria-label="PR title" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <div className="pr-editor-branches"><label className="field">Source branch<input className="input mono" aria-label="PR source branch" list={listId} disabled={!!initial} value={head} onChange={e => setHead(e.target.value)} /></label><ChevronRight size={16} /><label className="field">Target branch<input className="input mono" aria-label="PR target branch" list={listId} disabled={!!snapshot && snapshot.pull.state !== "open"} value={base} onChange={e => setBase(e.target.value)} /></label><datalist id={listId}>{branches.map(b => <option value={b} key={b} />)}</datalist></div>
      {!initial && <small className="faint">Use a source branch already published on this server.{forge.kind === "github" ? " A fork can use owner:branch." : ""} Publish local commits with Push before creating the request.</small>}
      <div className="pr-template-row"><select className="select" aria-label="Pull request template" value={template} onChange={e => setTemplate(e.target.value)}><option value="">Templates from the current commit…</option>{templates.items.map(t => <option key={t.path} value={t.path}>{t.path}</option>)}</select><button className="btn sm" type="button" disabled={!template} onClick={() => void applyTemplate()}>Use template</button></div>{templates.notice && <small className="pr-notice">{templates.notice}</small>}
      <label className="field">Description<textarea className="textarea" aria-label="PR description" rows={12} value={body} onChange={e => setBody(e.target.value)} /></label><div className="hstack"><small className={byteLength > 65536 ? "wm-error" : "faint"}>{byteLength.toLocaleString()} / 65,536 bytes · {Array.from(title).length} / 256 title characters</small><div className="spacer" /><button className="btn sm" type="button" onClick={() => void copyText(body, "Description copied")}>Copy description</button></div>
      {!initial && <label className="check"><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} />Open as draft</label>}
      {error && <div className="callout warn" role="alert">{error}</div>}{notice && <div className="callout warn" role="alert">{notice} Server target: {snapshot?.pull.base}.</div>}
      {initial && <button className="btn sm" type="button" onClick={() => void reload()}>Reload server version</button>}
      {uncertain && <div className="pr-notice"><button className="btn sm" type="button" onClick={() => browser(snapshot?.pull.url ?? forge.webUrl)}>Check on server</button><label className="check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />I checked the server result and want to retry</label></div>}
    </fieldset>
  </Modal>;
}
