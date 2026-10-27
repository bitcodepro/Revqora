import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { ArchiveRestore, FolderOpen, GitBranchPlus, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename, shortOid } from "../lib/format";
import { useRepos } from "../lib/store";
import type { RecoveryCatalog, RecoveryCheckpoint } from "../lib/types";
import { showDialog, toast } from "../lib/ui";
import { confirmDialog, promptDialog } from "./dialogs";
import { Modal } from "./Modal";
import "../styles/recovery.css";

const bytes = (n: number) => n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`;
const date = (n: number) => new Date(n).toLocaleString();

export function recoveryDialog(root: string) {
  return showDialog<void>((close) => <RecoveryCenter root={root} close={close} />);
}

function RecoveryCenter({ root, close }: { root: string; close: () => void }) {
  const [catalog, setCatalog] = useState<RecoveryCatalog | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecoveryCheckpoint | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reference, setReference] = useState("");
  const [branch, setBranch] = useState("");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [destination, setDestination] = useState("");
  const [recovered, setRecovered] = useState<string | null>(null);
  const alive = useRef(true);
  const version = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current++; }; }, []);
  const reload = useCallback(async () => {
    const v = ++version.current; setLoading(true);
    try {
      const next = await api.recoveryList(root);
      if (!alive.current || v !== version.current) return;
      setCatalog(next); setError(null);
      setSelected((id) => id && next.checkpoints.some((cp) => cp.id === id) ? id : next.checkpoints[0]?.id ?? null);
    } catch (e) { if (alive.current && v === version.current) setError(errorMessage(e)); }
    finally { if (alive.current && v === version.current) setLoading(false); }
  }, [root]);
  useEffect(() => {
    void reload(); const subscription = listen("recovery-changed", () => { void reload(); });
    return () => { void subscription.then((off) => off()); };
  }, [reload]);
  useEffect(() => {
    let current = true; setDetail(null); setDetailError(null); setRecovered(null);
    if (selected) void api.recoveryDetail(root, selected).then((cp) => {
      if (!current) return; setDetail(cp); setReference(cp.head ? "" : cp.refs.length ? "0" : "");
      setBranch(`recovered/${cp.id}`); setWorktreeBranch(`recovery/${cp.id}`); setDestination("");
    }, (e) => { if (current) setDetailError(errorMessage(e)); });
    return () => { current = false; };
  }, [root, selected]);
  const entries = useMemo(() => (catalog?.checkpoints ?? []).filter((cp) =>
    (kind === "all" || (kind === "workspace" ? cp.workspace : !cp.workspace)) &&
    `${cp.label} ${cp.command.replaceAll("_", " ")} ${cp.branch ?? ""} ${cp.sourceRoot}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [catalog, kind, query]);
  useEffect(() => { setSelected((id) => entries.some((cp) => cp.id === id) ? id : entries[0]?.id ?? null); }, [entries]);
  const run = async <T,>(action: () => Promise<T>, success: string): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try {
      const result = await action();
      await useRepos.getState().refresh(root);
      await reload(); toast.success(success); return result;
    } catch (e) { if (alive.current) setError(errorMessage(e)); return undefined; }
    finally { if (alive.current) setBusy(false); }
  };
  const create = async () => {
    const label = await promptDialog({ title: "Create recovery checkpoint", label: "Label", initial: "Manual checkpoint", confirm: "Create checkpoint" });
    if (label === null) return;
    const cp = await run(() => api.recoveryCreate(root, label), "Recovery checkpoint saved");
    if (cp) { setQuery(""); setKind("all"); setSelected(cp.id); }
  };
  const remove = async () => {
    if (!detail || !await confirmDialog({ title: "Delete checkpoint?", message: `Permanently remove “${detail.label}” and its saved files? Existing branches and worktrees stay available.`, confirm: "Delete checkpoint", danger: true })) return;
    await run(() => api.recoveryDelete(root, detail.id), "Checkpoint deleted");
  };
  const pickDestination = async () => {
    const parent = await openFolder({ directory: true, multiple: false, title: "Choose the parent folder for recovery" });
    if (typeof parent === "string" && detail) setDestination(`${parent.replace(/[\\/]$/, "")}/recovery-${detail.id}`);
  };
  const restoreWorkspace = async () => {
    if (!detail || !destination.trim() || !worktreeBranch.trim()) return;
    const path = await run(() => api.recoveryRestoreWorkspace(root, detail.id, destination.trim(), worktreeBranch.trim()), "Files and staging recovered into a new worktree");
    if (path) setRecovered(path);
  };
  const savedRef = detail && reference !== "" ? detail.refs[Number(reference)] : null;
  return <Modal title="Undo Center" subtitle={`Local recovery checkpoints · ${basename(root)}`} icon={<ShieldCheck size={22} />} wide onClose={() => { if (!busy) close(); }}
    footer={<><span className="recovery-retention">30 days · 100 checkpoints · 100 MiB each · 1 GiB of saved files</span><button type="button" className="btn" disabled={busy} onClick={close}>Close</button></>}>
    <div className="recovery-center" aria-busy={busy}>
      <div className="recovery-toolbar">
        <label className="recovery-search"><Search size={14} /><input aria-label="Search checkpoints" placeholder="Search actions, branches or labels…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <select className="input" aria-label="Checkpoint type" value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All checkpoints</option><option value="workspace">Files + references</option><option value="refs">References only</option></select>
        <button type="button" className="icon-btn" aria-label="Refresh checkpoints" title="Refresh" disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={15} /></button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void create()}><Plus size={14} /> Create checkpoint</button>
      </div>
      {error && <div className="recovery-error" role="alert">{error}</div>}
      {catalog?.warning && <div className="recovery-notice">{catalog.warning}</div>}
      <div className="recovery-layout">
        <div className="recovery-list" aria-label="Recovery checkpoints">
          <div className="recovery-caption">{entries.length} checkpoint{entries.length === 1 ? "" : "s"}{loading && " · Refreshing…"}</div>
          {entries.map((cp) => <button type="button" key={cp.id} disabled={busy} data-checkpoint-id={cp.id} aria-pressed={selected === cp.id} className={`recovery-row ${selected === cp.id ? "selected" : ""}`} onClick={() => setSelected(cp.id)}>
            <b>{cp.label || cp.command.replaceAll("_", " ")}</b><span>{cp.branch ?? "Detached / unborn"} · {shortOid(cp.head ?? "") || "No commits"}</span>
            <time>{date(cp.createdAt)}</time><span>{cp.workspace ? `${cp.files} paths + references` : "References only"} · {bytes(cp.bytes)}</span>
          </button>)}
          {!entries.length && <div className="recovery-empty"><ShieldCheck size={28} /><p>{query ? "No matching checkpoints" : "Checkpoints appear before destructive actions. You can also create one now."}</p></div>}
        </div>
        <section className="recovery-detail">
          {detailError && <div className="recovery-error">{detailError}</div>}
          {!detail && !detailError && <div className="recovery-empty">{selected ? "Loading checkpoint…" : "Select a checkpoint to inspect recovery options"}</div>}
          {detail && <>
            <div className="recovery-title"><div><h3>{detail.label}</h3><span>{date(detail.createdAt)}</span></div><button type="button" className="icon-btn recovery-delete" aria-label="Delete checkpoint" title="Delete checkpoint" disabled={busy} onClick={() => void remove()}><Trash2 size={16} /></button></div>
            <dl className="recovery-meta"><dt>Source worktree</dt><dd>{detail.sourceRoot}</dd><dt>Saved HEAD</dt><dd>{detail.branch ?? "Detached / unborn"} · {shortOid(detail.head ?? "") || "No commits"}</dd><dt>Coverage</dt><dd>{detail.workspace ? `Files, staging and ${detail.references} references` : `${detail.references} references`}</dd><dt>Size</dt><dd>{bytes(detail.bytes)}</dd></dl>
            {recovered && <div className="recovery-success"><span>Recovered: {recovered}</span><button type="button" className="btn" onClick={() => { void useRepos.getState().open(recovered); close(); }}>Open recovered worktree</button></div>}
            {detail.workspace && <div className="recovery-card">
              <h4><FolderOpen size={16} /> Recover files and staging</h4>
              <p>Creates a new worktree on a new branch. Your current files and branch stay in place.</p>
              <label>New branch<input className="input" aria-label="Recovery worktree branch" value={worktreeBranch} disabled={busy} onChange={(e) => setWorktreeBranch(e.target.value)} /></label>
              <label>New folder (must not exist)<div className="recovery-folder"><input className="input" aria-label="Recovery destination" value={destination} disabled={busy} placeholder="Choose a folder outside existing worktrees" onChange={(e) => setDestination(e.target.value)} /><button type="button" className="btn" disabled={busy} onClick={() => void pickDestination()}>Browse…</button></div></label>
              <button type="button" className="btn primary" disabled={busy || !destination.trim() || !worktreeBranch.trim()} onClick={() => void restoreWorkspace()}><ArchiveRestore size={14} /> Recover in new worktree</button>
              <small>Ignored files: {detail.includesIgnored ? "included" : "excluded"}. Submodule contents, stage layer labels and pending merge/rebase workflows are not restored.</small>
            </div>}
            {(detail.head || detail.refs.length > 0) && <div className="recovery-card">
              <h4><GitBranchPlus size={16} /> Recover a reference</h4>
              <p>Creates a local branch from a saved commit, or adds a saved stash back to the stash list. Remote servers stay unchanged.</p>
              <label>Saved reference<select className="input" aria-label="Saved recovery reference" value={reference} disabled={busy} onChange={(e) => setReference(e.target.value)}>{detail.head && <option value="">HEAD · {shortOid(detail.head)}</option>}{detail.refs.map((ref, i) => <option key={`${ref.name}-${i}`} value={i}>{ref.name} · {shortOid(ref.oid)}</option>)}</select></label>
              <label>New local branch<input className="input" aria-label="Recovered local branch" value={branch} disabled={busy} onChange={(e) => setBranch(e.target.value)} /></label>
              <div className="recovery-actions"><button type="button" className="btn" disabled={busy || !branch.trim()} onClick={() => void run(() => api.recoveryRestoreBranch(root, detail.id, reference === "" ? null : Number(reference), branch.trim()), "Local branch restored")}><GitBranchPlus size={14} /> Restore branch</button>{savedRef?.kind === "stash" && <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.recoveryRestoreStash(root, detail.id, Number(reference)), "Stash restored")}><ArchiveRestore size={14} /> Restore stash</button>}</div>
            </div>}
            {detail.paths.length > 0 && <details className="recovery-paths"><summary>{detail.paths.length} saved paths</summary>{detail.paths.map((item) => <div key={item.path}><span>{item.kind === "missing" ? "Deleted" : item.kind}</span><code>{item.path}</code></div>)}</details>}
          </>}
        </section>
      </div>
      <div className="recovery-storage"><span>Stored in data beside the application. Saved files may contain private project data.</span>{catalog && <button type="button" className="recovery-location" disabled={!catalog.checkpoints.length && !catalog.warning} title={catalog.storagePath} onClick={() => void api.revealPath(catalog.storagePath).catch((e) => toast.error(e))}>Open storage folder</button>}</div>
    </div>
  </Modal>;
}
