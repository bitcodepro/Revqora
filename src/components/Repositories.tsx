import { useState } from "react";
import { ArrowDownToLine, Check, CircleAlert, FolderGit2, GitBranch, LayoutGrid, Plus, RefreshCw, Search, X } from "lucide-react";
import { api, errorMessage, newOpId } from "../lib/api";
import * as A from "../lib/actions";
import { basename, relativeTime } from "../lib/format";
import { pullBlockReason, runRepositoryBatch, type BatchResult } from "../lib/repositoryBatch";
import { useSettings } from "../lib/settings";
import { useRepos, type RepoTab } from "../lib/store";
import { endBusy, showDialog, startBusy, toast, useUi } from "../lib/ui";
import { AheadBehind } from "./bits";
import { Modal } from "./Modal";
import { Splitter } from "./Overlays";

let running = false;
let choosingPull = false;

function activate(root: string) {
  useRepos.getState().activate(root);
}

async function runBatch(roots: string[], kind: "fetch" | "pull") {
  if (running || useUi.getState().busy.length || !roots.length) return;
  running = true;
  const id = newOpId();
  startBusy(id, kind === "fetch" ? "Fetching repositories" : "Updating repositories");
  let results: BatchResult[] = [];
  try {
    results = await runRepositoryBatch(roots, kind, {
      read: async (root) => {
        const [info, status] = await Promise.all([api.repoInfo(root), api.status(root)]);
        return { info, status };
      },
      fetch: async (root) => {
        try {
          const out = await api.fetch(root, null, true, id);
          useRepos.getState().patch(root, { lastFetchedAt: Date.now(), fetchError: null });
          return out;
        } catch (e) {
          useRepos.getState().patch(root, { fetchError: errorMessage(e) });
          throw e;
        }
      },
      // This path never rebases, stashes, or creates a merge commit.
      pull: async (root) => {
        const out = await api.pull(root, "ff-only", id);
        if (!["done", "fastForward", "upToDate"].includes(out.status)) throw new Error(out.message || "Pull needs attention");
        useRepos.getState().patch(root, { lastFetchedAt: Date.now(), fetchError: null });
        return out;
      },
      refresh: (root) => useRepos.getState().refresh(root, { info: true, status: true, refs: true, graph: useRepos.getState().active === root }),
      isOpen: (root) => !!useRepos.getState().tabs[root],
      progress: (root, index, total) => useUi.setState((s) => ({
        busy: s.busy.map((b) => b.id === id ? { ...b, label: `${kind === "fetch" ? "Fetching" : "Pulling"} ${basename(root)} (${index}/${total})`, line: "" } : b),
      })),
    });
  } finally {
    endBusy(id);
    running = false;
  }
  const done = results.filter((r) => r.status === "done").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const summary = `${done} ${kind === "fetch" ? "fetched" : "updated"} · ${skipped} skipped · ${failed} failed`;
  if (!failed && !skipped) toast.success(summary);
  else toast.warning(summary, "Open the results to see which repositories need attention.");
  if (kind === "pull" || failed || skipped) {
    await showDialog<void>((close) => (
      <Modal title={kind === "fetch" ? "Fetch results" : "Pull results"} subtitle={summary} onClose={() => close()} footer={<button className="btn primary" onClick={() => close()}>Done</button>}>
        <div className="batch-list">
          {results.map((r) => (
            <div className="batch-row" key={r.root}>
              {r.status === "done" ? <Check size={16} className="green" /> : <CircleAlert size={16} className="amber" />}
              <div className="grow-text"><b>{basename(r.root)}</b><div className="batch-note">{r.message}</div></div>
              <button className="btn sm" onClick={() => { activate(r.root); close(); }}>Open</button>
            </div>
          ))}
        </div>
      </Modal>
    ));
  }
}

export function fetchRepositories() {
  return runBatch(useRepos.getState().order, "fetch");
}

export async function pullRepositories(onlyRoots?: string[]) {
  if (choosingPull || running || useUi.getState().busy.length) return;
  choosingPull = true;
  const roots = onlyRoots ?? useRepos.getState().order;
  try {
    // Refresh the preview as well as rechecking each repository during execution.
    await Promise.allSettled(roots.map((r) => useRepos.getState().refresh(r, { info: true, status: true })));
    const tabs = roots.map((r) => useRepos.getState().tabs[r]).filter((t): t is RepoTab => !!t);
    const selected = await showDialog<string[] | null>((close) => <PullRepositoriesDialog tabs={tabs} close={close} />);
    if (selected?.length) await runBatch(selected, "pull");
  } finally {
    choosingPull = false;
  }
}

function PullRepositoriesDialog({ tabs, close }: { tabs: RepoTab[]; close: (roots: string[] | null) => void }) {
  const [selected, setSelected] = useState(() => new Set(tabs.filter((t) => !t.fetchError && !pullBlockReason(t)).map((t) => t.root)));
  const submit = () => selected.size && close([...selected]);
  return (
    <Modal title="Pull repositories" subtitle={`${selected.size} selected · checked-out branches only`} onClose={() => close(null)} onSubmit={submit}
      footer={<><button type="button" className="btn" onClick={() => close(null)}>Cancel</button><button type="submit" className="btn primary" disabled={!selected.size}>Pull ({selected.size})</button></>}>
      <div className="callout">Fast-forward only. Repositories with local changes, diverged history, failed fetches or an operation in progress need individual attention. Use Fetch all first to check for remote updates.</div>
      <div className="batch-list">
        {tabs.map((t) => {
          const reason = t.fetchError ? "Fetch failed — fetch this repository first" : pullBlockReason(t);
          return (
            <label className="batch-row" key={t.root} title={t.root}>
              <input type="checkbox" disabled={!!reason} checked={selected.has(t.root)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(t.root); else n.delete(t.root); return n; })} />
              <div className="grow-text"><b>{t.info?.name ?? basename(t.root)}</b><div className="batch-note">{reason ?? `${t.status?.branch} · fast-forward`}</div></div>
              <AheadBehind ahead={t.status?.ahead ?? 0} behind={t.status?.behind ?? 0} />
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

function RepoState({ tab }: { tab: RepoTab }) {
  if (!tab.status) return <span className="faint">Loading…</span>;
  if (tab.fetchError) return <span className="pill amber" title={tab.fetchError}>Fetch failed</span>;
  if (tab.info?.state.kind !== "none" || tab.status.conflictCount) return <span className="pill amber">Needs attention</span>;
  if (tab.status.files.length) return <span className="pill amber">{tab.status.files.length} changed</span>;
  if (tab.status.ahead && tab.status.behind) return <span className="pill amber">Diverged</span>;
  return <span className="faint">Clean</span>;
}

function SyncButtons() {
  const busy = useUi((s) => s.busy.length > 0);
  return (
    <div className="repository-sync">
      <button className="btn sm" disabled={busy} onClick={() => void fetchRepositories()}><RefreshCw size={13} /> Fetch all</button>
      <button className="btn sm" disabled={busy} onClick={() => void pullRepositories()}><ArrowDownToLine size={13} /> Pull all</button>
    </div>
  );
}

export function RepositorySidebar() {
  const order = useRepos((s) => s.order);
  const tabs = useRepos((s) => s.tabs);
  const active = useRepos((s) => s.active);
  const overview = useUi((s) => s.repositoryOverview);
  const [query, setQuery] = useState("");
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const width = useSettings((s) => s.repositoriesWidth);
  const set = useSettings((s) => s.set);
  const [w, setW] = useState(width);
  const count = order.filter((r) => (tabs[r]?.status?.behind ?? 0) > 0).length;
  const visible = order.filter((r) => (r + " " + tabs[r]?.info?.name).toLowerCase().includes(query.trim().toLowerCase()) && (!updatesOnly || !!tabs[r]?.status?.behind));
  return (
    <div className="repository-sidebar" style={{ width: w }}>
      <header><FolderGit2 size={15} /><b>Repositories</b><span className="pill">{order.length}</span><div className="spacer" /><button className="icon-btn sm" title="Hide repositories" onClick={() => set({ repositoriesOpen: false })}><X size={13} /></button></header>
      <div className="repository-filter input-wrap"><Search size={13} /><input className="input sm" placeholder="Find repository…" aria-label="Find repository" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <SyncButtons />
      <button className={`repository-overview-link ${overview ? "active" : ""}`} onClick={() => useUi.setState({ repositoryOverview: true })}><LayoutGrid size={14} /> All repositories</button>
      <div className="repository-list" role="list" aria-label="Open repositories">
        {visible.map((r) => {
          const t = tabs[r];
          return (
            <div role="listitem" className={`repository-item ${r === active && !overview ? "active" : ""}`} key={r}>
              <button className="repository-select" onClick={() => activate(r)} title={`${r}\n${t.info?.head.branch ?? "Detached HEAD"}${t.fetchError ? "\n" + t.fetchError : ""}`}>
                <FolderGit2 size={14} />
                <span className="repository-label">{t.info?.name ?? basename(r)}</span>
                <AheadBehind ahead={t.status?.ahead ?? 0} behind={t.status?.behind ?? 0} />
                {!!t.status?.files.length && <span className="repository-dirty" aria-label="Local changes" />}
                {!!t.fetchError && <CircleAlert size={12} className="amber" />}
              </button>
              <button className="repository-close icon-btn sm" title={`Close ${t.info?.name ?? basename(r)}`} aria-label={`Close ${t.info?.name ?? basename(r)}`} onClick={() => useRepos.getState().close(r)}><X size={12} /></button>
            </div>
          );
        })}
        {!visible.length && <div className="cg-empty">No matching repositories</div>}
      </div>
      <button className={`repository-updates ${updatesOnly ? "active" : ""}`} aria-pressed={updatesOnly} onClick={() => setUpdatesOnly(!updatesOnly)}>{count} with incoming commits{updatesOnly ? " · Show all" : ""}</button>
      <button className="btn sm repository-add" onClick={() => A.openRepoDialog()}><Plus size={14} /> Open repositories…</button>
      <Splitter dir="v" style={{ right: -3, left: "auto" }} onDrag={(d) => setW((v) => Math.max(180, Math.min(360, v + d)))} onEnd={() => set({ repositoriesWidth: w })} />
    </div>
  );
}

export function RepositoryOverview() {
  const order = useRepos((s) => s.order);
  const tabs = useRepos((s) => s.tabs);
  const busy = useUi((s) => s.busy.length > 0);
  const [query, setQuery] = useState("");
  const visible = order.filter((r) => (r + " " + tabs[r]?.info?.name).toLowerCase().includes(query.trim().toLowerCase()));
  const incoming = order.filter((r) => !!tabs[r]?.status?.behind).length;
  return (
    <div className="repository-overview">
      <header><div><h2>Repositories</h2><span className="faint">{order.length} open · {incoming} with incoming commits</span></div><div className="spacer" /><SyncButtons /><button className="btn sm" onClick={() => A.openRepoDialog()}><Plus size={14} /> Open</button></header>
      <div className="repository-overview-search input-wrap"><Search size={14} /><input className="input" placeholder="Find repository…" aria-label="Find repository in overview" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="repository-table-scroll">
        <table className="repository-table">
          <thead><tr><th>Repository</th><th>Current branch</th><th>Incoming / outgoing</th><th>Working copy</th><th>Last fetch</th><th /></tr></thead>
          <tbody>
            {visible.map((r) => { const t = tabs[r]; return (
              <tr key={r}>
                <td><button className="repository-name" title={r} onClick={() => activate(r)}><FolderGit2 size={15} />{t.info?.name ?? basename(r)}</button></td>
                <td title={t.info?.head.branch ?? ""}><GitBranch size={12} /> {t.info?.head.branch ?? (t.info?.head.detached ? "Detached HEAD" : "—")}</td>
                <td>{t.status ? <AheadBehind ahead={t.status.ahead} behind={t.status.behind} /> : "…"}</td>
                <td><RepoState tab={t} /></td>
                <td className="faint">{t.lastFetchedAt ? relativeTime(t.lastFetchedAt / 1000) : "Not fetched this session"}</td>
                <td><button className="btn sm" disabled={busy || !!t.fetchError || !!pullBlockReason(t)} onClick={() => void pullRepositories([r])}>Pull</button></td>
              </tr>
            ); })}
          </tbody>
        </table>
        {!visible.length && <div className="cg-empty">No matching repositories</div>}
      </div>
      <div className="repository-overview-note">Counts compare the checked-out branch with its upstream after the latest fetch. Fetch all checks for new commits without changing your working copies.</div>
    </div>
  );
}
