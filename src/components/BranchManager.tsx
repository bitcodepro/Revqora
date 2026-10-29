import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, RefreshCw, ShieldCheck, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import * as A from "../lib/actions";
import { useRepos } from "../lib/store";
import { closeOverlay, copyText, openOverlay, toast } from "../lib/ui";
import { branchFilters, branchWorktrees, isProtected, loadBranchPreferences, preferencesKey, restoreBranchPreferences, selectBranches, type BranchPreferences } from "../lib/branchManager";
import type { BranchManagerSnapshot } from "../lib/types";
import { relativeTime, shortOid } from "../lib/format";
import { jumpToCommit } from "./GraphView";
import { renameRemoteBranch } from "./RemoteRename";

const ROW = 56;
export function BranchManager({ root }: { root: string }) {
  const [prefs, setPrefs] = useState(() => loadBranchPreferences(root));
  const [snapshot, setSnapshot] = useState<BranchManagerSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [distance, setDistance] = useState<{ ahead: number; behind: number } | null>(null);
  const [distanceError, setDistanceError] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState("");
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const viewport = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const refs = useRepos(s => s.tabs[root]?.refs);
  const pending = useRepos(s => (s.tabs[root]?.pendingMutations ?? 0) > 0);
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    setLoading(true); setError("");
    try {
      const data = await api.branchManagerSnapshot(root, prefsRef.current.base);
      if (id !== generation.current) return;
      setSnapshot(data);
    } catch (e) { if (id === generation.current) setError(errorMessage(e)); }
    finally { if (id === generation.current) setLoading(false); }
  }, [root]);
  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => void refresh(), 120);
    return () => { clearTimeout(timer); generation.current++; };
  }, [refresh, prefs.base, refs]);
  useEffect(() => {
    try { localStorage.setItem(preferencesKey(root), JSON.stringify(prefs)); } catch { toast.warning("Branch preferences could not be saved"); }
  }, [root, prefs]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const resize = new ResizeObserver(() => setHeight(node.clientHeight));
    resize.observe(node); setHeight(node.clientHeight);
    return () => resize.disconnect();
  }, []);
  const update = (patch: Partial<BranchPreferences>) => setPrefs(p => restoreBranchPreferences({ ...p, ...patch }));
  const rows = useMemo(() => selectBranches(snapshot?.branches ?? [], prefs, query, snapshot?.worktrees ?? []), [snapshot, prefs, query]);
  useEffect(() => {
    setSelected(old => rows.some(b => b.fullRef === old) ? old : rows[0]?.fullRef ?? null);
    if (viewport.current) viewport.current.scrollTop = 0;
    setScroll(0);
  }, [rows]);
  const branch = rows.find(b => b.fullRef === selected);
  const base = snapshot?.baseOid;
  const tip = branch?.oid;
  useEffect(() => {
    let alive = true; setDistance(null); setDistanceError("");
    if (base && tip && !loading && !error) api.branchManagerCompare(root, base, tip).then(
      data => { if (alive) setDistance(data); }, e => { if (alive) setDistanceError(errorMessage(e)); },
    );
    return () => { alive = false; };
  }, [root, base, tip, loading, error]);
  const worktrees = branch ? branchWorktrees(branch, snapshot?.worktrees ?? []) : [];
  const protectedBranch = branch ? isProtected(branch, prefs.protections) : false;
  const ready = !!branch && !loading && !error && !pending;
  const destructive = ready && !protectedBranch && branch.mappingKnown;
  const action = async (run: () => unknown) => {
    try { await run(); } catch (e) { toast.error(e); }
    await refresh();
  };
  const start = Math.max(0, Math.floor(scroll / ROW) - 5);
  const end = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 5);
  const choose = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    setSelected(rows[i]?.fullRef ?? null);
    const node = viewport.current;
    if (node && i * ROW < node.scrollTop) node.scrollTop = i * ROW;
    else if (node && (i + 1) * ROW > node.scrollTop + node.clientHeight) node.scrollTop = (i + 1) * ROW - node.clientHeight;
  };
  return <section className="conflict-overlay branch-manager" aria-label="Branch manager">
    <header className="cf-head"><GitBranch size={18} /><b>Branch manager</b><span className="muted">{snapshot?.branches.length ?? 0} branches</span><div className="spacer" />
      <button className="btn" disabled={loading || pending} onClick={() => action(() => A.createBranch(root, null, "HEAD"))}>New branch</button>
      <button className="btn" disabled={loading || pending} onClick={() => action(() => A.fetchAll(root))}>Fetch</button>
      <button className="icon-btn" aria-label="Refresh branches" disabled={loading || pending} onClick={() => void refresh()}><RefreshCw size={16} className={loading ? "spin" : ""} /></button>
      <button className="icon-btn" aria-label="Close branch manager" onClick={closeOverlay}><X size={18} /></button>
    </header>
    <div className="bm-toolbar">
      <input className="input" aria-label="Search branches" placeholder="Search branch, author, commit or SHA…" value={query} onChange={e => setQuery(e.target.value)} />
      <label>Compare to <select className="input" aria-label="Branch comparison base" value={snapshot?.baseRef ?? ""} disabled={loading} onChange={e => update({ base: e.target.value })}>
        {!snapshot?.baseRef && <option value="">No commits</option>}{snapshot?.branches.map(b => <option key={b.fullRef} value={b.fullRef}>{b.name}{b.local ? " (local)" : " (remote)"}</option>)}
      </select></label>
      <select className="input" aria-label="Branch scope" value={prefs.scope} onChange={e => update({ scope: e.target.value as BranchPreferences["scope"] })}><option value="all">Local + remote</option><option value="local">Local</option><option value="remote">Remote</option></select>
      <select className="input" aria-label="Sort branches" value={prefs.sort} onChange={e => update({ sort: e.target.value as BranchPreferences["sort"] })}><option value="recent">Latest commit</option><option value="name">Branch name</option><option value="divergence">Upstream distance</option></select>
      <button className="btn" aria-expanded={rulesOpen} onClick={() => { setRules(prefs.protections.join("\n")); setRulesOpen(v => !v); }}><ShieldCheck size={14} />Protection rules</button>
    </div>
    {rulesOpen && <div className="bm-rules"><label>Protect rename and deletion in this manager. One branch name or wildcard (*, ?) per line. These are local UI rules.<textarea className="input mono" aria-label="Branch protection rules" rows={3} value={rules} onChange={e => setRules(e.target.value)} /></label><button className="btn primary" onClick={() => { update({ protections: rules.split(/\r?\n/) }); setRulesOpen(false); }}>Save rules</button></div>}
    <nav className="bm-filters" aria-label="Branch filters">{branchFilters.map(f => <button className={`btn ${prefs.filter === f ? "active" : ""}`} aria-pressed={prefs.filter === f} key={f} onClick={() => update({ filter: f })}>{f}</button>)}
      <label>Stale after <input className="input" type="number" min={1} max={3650} aria-label="Stale branch days" value={prefs.staleDays} onChange={e => update({ staleDays: Number(e.target.value) })} /> days</label>
    </nav>
    {error && <div className="bm-error" role="alert">{error} <button className="btn" onClick={() => void refresh()}>Retry</button></div>}
    <div className="bm-body" aria-busy={loading}>
      <div className="bm-list">
        <div className="bm-row bm-columns"><span>Branch</span><span>Upstream</span><span>Last commit</span><span>Message</span></div>
        <div className="bm-viewport" ref={viewport} role="listbox" aria-label="Branches" tabIndex={0} aria-activedescendant={branch ? `bm-row-${rows.indexOf(branch)}` : undefined} onScroll={e => setScroll(e.currentTarget.scrollTop)} onKeyDown={e => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); choose(e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : rows.findIndex(b => b.fullRef === selected) + (e.key === "ArrowDown" ? 1 : -1)); }
          if (e.key === "Enter" && branch && ready) { closeOverlay(); jumpToCommit(root, branch.oid); }
        }}>
          <div style={{ height: start * ROW }} />
          {rows.slice(start, end).map((b, i) => <div className={`bm-row ${b.fullRef === selected ? "selected" : ""}`} id={`bm-row-${start + i}`} key={b.fullRef} role="option" aria-selected={b.fullRef === selected} data-branch-ref={b.fullRef} onClick={() => setSelected(b.fullRef)}>
            <div title={b.fullRef}><b>{b.name}</b><small>{b.local ? "Local" : "Remote"}{b.current ? " · HEAD" : ""}{branchWorktrees(b, snapshot?.worktrees ?? []).length ? " · Worktree" : ""}{isProtected(b, prefs.protections) ? " · Protected" : ""}</small></div>
            <div title={b.upstream ?? "No upstream"}><span>{b.upstream?.replace(/^refs\/(remotes|heads)\//, "") ?? "—"}</span><small>{b.gone ? "Upstream missing" : b.upstream ? `↑${b.ahead} ↓${b.behind}` : "No upstream"}</small></div>
            <div title={b.time > 0 ? new Date(b.time * 1000).toLocaleString() : ""}><span>{b.author || "—"}</span><small>{b.time > 0 ? relativeTime(b.time) : "Unknown date"}</small></div>
            <div title={b.subject}><span>{b.subject}</span><small className="mono">{shortOid(b.oid)}</small></div>
          </div>)}
          <div style={{ height: Math.max(0, rows.length - end) * ROW }} />
          {!rows.length && <p className="bm-empty">{loading ? "Loading branches…" : "No branches match these filters."}</p>}
        </div>
      </div>
      <aside className="bm-detail" aria-label="Selected branch">{branch ? <>
        <h3 title={branch.fullRef}>{branch.name}</h3><div className="muted bm-wrap">{branch.fullRef}</div>
        <button className="btn mono" onClick={() => copyText(branch.oid)} title="Copy commit ID">{shortOid(branch.oid)}</button>
        <p className="bm-wrap">{branch.subject}</p><div className="muted">{branch.author}</div>
        <h4>Compared to {snapshot?.baseRef?.replace(/^refs\/(heads|remotes)\//, "")}</h4>
        <small className="mono muted">{base ? shortOid(base) : "No base commit"}</small>
        <p>{loading ? "Refreshing…" : error ? "Refresh required" : distanceError || (distance ? `${distance.ahead} ahead · ${distance.behind} behind` : "Comparing…")}</p>
        <p>{branch.merged === true ? "Tip is reachable from the base." : branch.merged === false ? "Tip is not reachable from the base." : "Reachability unavailable."}</p>
        {!!worktrees.length && <><h4>Worktrees</h4>{worktrees.map(w => <p className="bm-wrap" key={w.path}>{w.path}{w.isCurrent ? " · Current" : ""}{w.locked ? " · Locked" : ""}{w.prunable ? " · Prunable" : ""}</p>)}</>}
        {protectedBranch && <p className="bm-notice">Protected by your local rules. Edit rules to allow rename or deletion here.</p>}
        {!branch.mappingKnown && <p className="bm-notice">Remote mapping is missing or ambiguous. Review fetch refspecs before rename or deletion.</p>}
        <div className="bm-actions">
          <button className="btn" disabled={!ready} onClick={() => { closeOverlay(); jumpToCommit(root, branch.oid); }}>Show in history</button>
          <button className="btn" disabled={!ready || !base} onClick={() => base && openOverlay({ kind: "compare", root, from: base, to: branch.oid, direct: true })}>Compare files</button>
          <button className="btn" disabled={!ready || branch.current || !!worktrees.length} onClick={() => action(() => A.checkout(root, branch.name, branch.local ? "local" : "remote"))}>Checkout</button>
          {branch.local && <button className="btn" disabled={!ready} onClick={() => action(() => A.setUpstream(root, branch.name))}>Set upstream…</button>}
          <button className="btn" disabled={!destructive || !!worktrees.length} onClick={() => action(() => branch.local ? A.renameBranch(root, branch.name) : renameRemoteBranch(root, branch.name))}>Rename…</button>
          <button className="btn danger" disabled={!destructive || branch.current || !!worktrees.length} onClick={() => action(() => branch.local ? A.deleteBranch(root, branch.name) : A.deleteRemoteBranch(root, branch.name))}>Review deletion…</button>
        </div>
      </> : <p>Select a branch to inspect its history and worktrees.</p>}</aside>
    </div>
    <footer className="bm-footer">{rows.length} shown · Stale uses the tip commit date. Counts use cached remote refs; Fetch updates them. Merged uses original commit ancestry and does not detect squash integration. Deletion has a separate safety review.</footer>
  </section>;
}
