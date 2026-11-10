import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloudOff, GitBranch, RefreshCw, Settings2, ShieldCheck, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import * as A from "../lib/actions";
import { useRepos } from "../lib/store";
import { closeOverlay, contextMenu, copyText, openOverlay, showDialog, toast } from "../lib/ui";
import { namePathMenu } from "./NamePathMenu";
import { branchFilters, branchWorktrees, isProtected, isRemoteDeleted, loadBranchPreferences, preferencesKey, restoreBranchPreferences, selectBranches, type BranchPreferences } from "../lib/branchManager";
import { virtualRange } from "../lib/virtualRange";
import { Modal } from "./Modal";
import type { BranchManagerSnapshot } from "../lib/types";
import { relativeTime, shortOid } from "../lib/format";
import { jumpToCommit } from "./GraphView";
import { BranchCleanup } from "./BranchCleanup";
import type { BranchCleanupRequest } from "../lib/types";
import { renameRemoteBranch } from "./RemoteRename";
import { useSettings } from "../lib/settings";
import { useToolDetailSize, useWindowSize, WindowResizeGrip } from "./WindowResize";

export function BranchManager({ root }: { root: string }) {
  const ROW = 56 + Math.ceil(Math.max(0, useSettings(s => s.uiFontSize) - 13) * 3);
  const details = useToolDetailSize("Branch manager details", 780);
  const surface = useRef<HTMLElement>(null);
  const windowSize = useWindowSize("Branch manager");
  const [checked, setChecked] = useState<Record<string, BranchCleanupRequest>>({});
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
  const rows = useMemo(() => selectBranches(snapshot?.branches ?? [], prefs, query, snapshot?.worktrees ?? [], Date.now(), snapshot?.identityEmail ?? null), [snapshot, prefs, query]);
  useEffect(() => {
    setSelected(old => rows.some(b => b.fullRef === old) ? old : rows[0]?.fullRef ?? null);
  }, [rows]);
  // Only an intentional filter/sort change resets navigation. A refreshed
  // snapshot creates a new rows array even when every branch is unchanged.
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
    setScroll(0);
  }, [prefs.scope, prefs.filter, prefs.sort, prefs.staleDays, prefs.onlyMine, prefs.remoteDeleted, prefs.authorQuery, query]);
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
  // Row selection only records intent and its displayed SHA. Background reads
  // must not interrupt a click; cleanup still waits for fresh inventory/proofs.
  const checkBranch = (b: BranchManagerSnapshot["branches"][number], value: boolean) => setChecked(old => {
    const next = { ...old };
    if (value && Object.keys(next).length < 50) next[b.fullRef] = { reference: b.fullRef, oid: b.oid, mode: b.local ? "local" : "remote" };
    else if (!value) delete next[b.fullRef];
    return next;
  });
  const cleanupReview = async () => {
    await showDialog<void>(close => <BranchCleanup root={root} initial={Object.values(checked)} rules={prefs.protections} bases={(snapshot?.branches ?? []).filter(b => b.local).map(b => ({ reference: b.fullRef, name: b.name }))} initialBase={snapshot?.baseRef?.startsWith("refs/heads/") ? snapshot.baseRef : (snapshot?.branches.find(b => b.local && b.current)?.fullRef ?? "")} onClose={() => close()} />);
    setChecked({}); await refresh();
  };
  const { start, end } = virtualRange(rows.length, ROW, height, scroll);
  const editAuthor = async () => {
    const value = await showDialog<string | null>(close => <AuthorFilter initial={prefs.authorQuery} email={snapshot?.identityEmail ?? null} close={close} />);
    if (value !== null) {update({ authorQuery: value, onlyMine: !!value || !!snapshot?.identityEmail });window.dispatchEvent(new CustomEvent("revqora:branch-author",{detail:{root,query:value}}));}
  };
  const choose = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    setSelected(rows[i]?.fullRef ?? null);
    const node = viewport.current;
    if (node && i * ROW < node.scrollTop) node.scrollTop = i * ROW;
    else if (node && (i + 1) * ROW > node.scrollTop + node.clientHeight) node.scrollTop = (i + 1) * ROW - node.clientHeight;
  };
  return <section ref={surface} className="conflict-overlay branch-manager centered-tool-window" style={{ ...windowSize.style, ["--branch-manager-row-height" as string]: `${ROW}px` }} aria-label="Branch manager">
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
      <button className={`btn ${prefs.onlyMine ? "active" : ""}`} aria-pressed={prefs.onlyMine} disabled={!prefs.onlyMine && !prefs.authorQuery && !snapshot?.identityEmail} title={prefs.authorQuery ? `Recorded creator name or email contains: ${prefs.authorQuery}` : snapshot?.identityEmail ? `Recorded creator email equals Git user.email: ${snapshot.identityEmail}` : "Set Git user.email or choose a custom author."} onClick={() => update({ onlyMine: !prefs.onlyMine })}>{prefs.authorQuery ? "By creator" : "My branches"}</button>
      <button className="icon-btn" aria-label="Configure branch creator filter" title="Choose branch creator email or name" onClick={() => void editAuthor()}><Settings2 size={15} /></button>
      <button className={`btn ${prefs.remoteDeleted ? "active" : ""}`} aria-pressed={prefs.remoteDeleted} title="Local branches whose configured remote upstream is missing after Fetch." onClick={() => update({ remoteDeleted: !prefs.remoteDeleted })}><CloudOff size={14} />Remote deleted</button>
      <label>Stale after <input className="input" type="number" min={1} max={3650} aria-label="Stale branch days" value={prefs.staleDays} onChange={e => update({ staleDays: Number(e.target.value) })} /> days</label>
    </nav>
    {prefs.onlyMine && <div className="bm-author-summary">Recorded branch creator {prefs.authorQuery ? <>name or email contains <b>{prefs.authorQuery}</b></> : <>email matches Git <code>user.email</code>: <b>{snapshot?.identityEmail ?? "not configured"}</b></>}. Unknown creators (remote imports, missing or expired creation logs) are excluded. Commit authors do not determine ownership.</div>}
    <div className="bm-bulk">
      <button className="btn" disabled={loading || pending || !rows.length} onClick={() => setChecked(Object.fromEntries(rows.slice(0, 50).map(b => [b.fullRef, { reference: b.fullRef, oid: b.oid, mode: b.local ? "local" : "remote" }])))}>Select shown (up to 50)</button>
      <span>{Object.keys(checked).length} selected · {Object.keys(checked).filter(ref => !rows.some(b => b.fullRef === ref)).length} hidden by filter</span>
      <button className="btn" disabled={!Object.keys(checked).length} onClick={() => setChecked({})}>Clear selection</button>
      <button className="btn danger" disabled={loading || pending || !Object.keys(checked).length || !!error} onClick={() => void cleanupReview()}>Review cleanup…</button>
    </div>
    {error && <div className="bm-error" role="alert">{error} <button className="btn" onClick={() => void refresh()}>Retry</button></div>}
    <div ref={details.body} className={`bm-body tool-details ${details.narrow ? "tool-details-stacked" : ""}`} style={details.style} aria-busy={loading}>
      <div className="bm-list">
        <div className="bm-row bm-columns"><span>Branch</span><span>Upstream</span><span>Last commit</span><span>Message</span></div>
        <div className="bm-viewport" ref={viewport} role="listbox" aria-label="Branches" tabIndex={0} aria-activedescendant={branch ? `bm-row-${rows.indexOf(branch)}` : undefined} onScroll={e => setScroll(e.currentTarget.scrollTop)} onKeyDown={e => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); choose(e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : rows.findIndex(b => b.fullRef === selected) + (e.key === "ArrowDown" ? 1 : -1)); }
          if (e.key === "Enter" && branch && ready) { closeOverlay(); jumpToCommit(root, branch.oid); }
        }}>
          <div className="bm-canvas" style={{ height: rows.length * ROW }}><div className="bm-window" style={{ transform: `translateY(${start * ROW}px)` }}>
          {rows.slice(start, end).map((b, i) => <div className={`bm-row ${b.fullRef === selected ? "selected" : ""}`} id={`bm-row-${start + i}`} key={b.fullRef} role="option" aria-selected={b.fullRef === selected} data-branch-ref={b.fullRef} onClick={() => setSelected(b.fullRef)} onContextMenu={e => contextMenu(e, namePathMenu(b.name, root, b.fullRef))}>
            <div title={b.fullRef} className="bm-name"><input type="checkbox" aria-label={`Select ${b.fullRef} for cleanup`} checked={!!checked[b.fullRef]} disabled={pending || (!checked[b.fullRef] && Object.keys(checked).length >= 50)} onClick={e => e.stopPropagation()} onChange={e => checkBranch(b, e.target.checked)} /><div><b>{b.name}</b><small>{b.local ? "Local" : "Remote"}{b.current ? " · HEAD" : ""}{branchWorktrees(b, snapshot?.worktrees ?? []).length ? " · Worktree" : ""}{isProtected(b, prefs.protections) ? " · Protected" : ""}</small></div></div>
            <div title={b.upstream ?? "No upstream"}><span>{b.upstream?.replace(/^refs\/(remotes|heads)\//, "") ?? "—"}</span><small>{isRemoteDeleted(b) ? <><CloudOff size={11} /> Remote deleted</> : b.gone ? "Local upstream missing" : b.upstream ? `↑${b.ahead} ↓${b.behind}` : "No upstream"}</small></div>
            <div title={`${b.author} <${b.authorEmail}>${b.time > 0 ? ` · ${new Date(b.time * 1000).toLocaleString()}` : ""}`}><span>{b.author || "—"}</span><small>{b.time > 0 ? relativeTime(b.time) : "Unknown date"}</small></div>
            <div title={b.subject}><span>{b.subject}</span><small className="mono">{shortOid(b.oid)}</small></div>
          </div>)}
          </div></div>
          {!rows.length && <p className="bm-empty">{loading ? "Loading branches…" : "No branches match these filters."}</p>}
        </div>
      </div>
      <div className="tool-detail-divider">{details.divider}</div>
      <aside ref={details.detail} className="bm-detail" aria-label="Selected branch">{branch ? <>
        <h3 title={branch.fullRef} onContextMenu={e => contextMenu(e, namePathMenu(branch.name, root, branch.fullRef))}>{branch.name}</h3><div className="muted bm-wrap">{branch.fullRef}</div>
        <button className="btn mono" onClick={() => copyText(branch.oid)} title="Copy commit ID">{shortOid(branch.oid)}</button>
        <p className="bm-wrap">{branch.subject}</p><div className="muted bm-wrap">{branch.author} &lt;{branch.authorEmail}&gt;</div>
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
          <button className="btn danger" disabled={!destructive || branch.current || !!worktrees.length} onClick={() => action(() => branch.local ? A.deleteBranch(root, branch.name, prefs.protections) : A.deleteRemoteBranch(root, branch.name, prefs.protections))}>Review deletion…</button>
        </div>
      </> : <p>Select a branch to inspect its history and worktrees.</p>}</aside>
    </div>
    <footer className="bm-footer">{rows.length} shown · Stale uses the tip commit date. Counts use cached remote refs; Fetch updates them. Merged uses original commit ancestry and does not detect squash integration. Deletion has a separate safety review.</footer>
    <WindowResizeGrip surface={surface} size={windowSize} embedded/>
  </section>;
}

function AuthorFilter({ initial, email, close }: { initial: string; email: string | null; close: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return <Modal title="Branch creator filter" onClose={() => close(null)} onSubmit={() => close(value.trim())} footer={<>
    <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
    <button type="button" className="btn" onClick={() => close("")}>Use Git email</button>
    <button type="submit" className="btn primary">Apply filter</button>
  </>}>
    <label className="field">Creator email or name<input className="input" aria-label="Branch creator email or name" maxLength={256} value={value} placeholder={email ?? "Email or author name"} onChange={e => setValue(e.target.value)} /></label>
    <p className="muted">Leave empty to match the exact email from this repository’s Git configuration: <b>{email ?? "user.email is not configured"}</b>.</p>
    <p className="muted">Custom text matches part of the recorded branch creator’s name or email, ignoring case. It is saved for this repository and does not change your Git identity. Creation logs are local: cloning or checking out another person's remote branch does not make you its creator. Unknown creators are excluded.</p>
  </Modal>;
}
