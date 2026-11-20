import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderGit2, FolderOpen, FolderSearch, Loader2, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename } from "../lib/format";
import { planFolderGroups, repositoryKey, useLibrary } from "../lib/repositoryLibrary";
import { folderGroupTree } from "../lib/folderGroupTree";
import { rescanSelection, rescanSummary } from "../lib/folderRescan";
import { visibleTree } from "../lib/libraryTree";
import { useRepos } from "../lib/store";
import type { RepositoryFolderScan, RepositoryFolderScanProgress } from "../lib/types";
import { showDialog, useUi, toast } from "../lib/ui";
import { Modal } from "./Modal";

/** `folder`: scan it right away (a folder opened as a repository that holds repositories). */
export function repositoryFolderImportDialog(folder?: string) {
  return showDialog<void>((close) => <RepositoryFolderImport close={close} initialFolder={folder} />);
}

/** Live counts of a running scan: how many folders were read, how many repositories were found
 *  and which folder is being read, so a long scan visibly moves. */
function FolderScanProgress({ scanId, stopping }: { scanId: number | null; stopping: boolean }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [progress, setProgress] = useState<RepositoryFolderScanProgress | null>(null);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((performance.now() - started) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (scanId === null) return;
    let active = true;
    const poll = () => void api.repoFolderScanProgress(scanId).then(next => { if (active && next) setProgress(next); }, () => undefined);
    poll();
    const timer = window.setInterval(poll, 250);
    return () => { active = false; window.clearInterval(timer); };
  }, [scanId]);
  return <div className="loading-status repository-import-progress" role="status">
    <Loader2 className="spin" size={16} aria-hidden="true" />
    <div className="repository-import-progress-text">
      <div>
        <span className="repository-import-label">{stopping ? "Stopping the scan…" : "Looking for Git repositories…"}</span>
        {progress && <span className="batch-note repository-import-counts" aria-hidden="true">{scanCounts(progress)}</span>}
        {elapsedSeconds > 0 && <span className="batch-note repository-import-elapsed" aria-hidden="true">{elapsedSeconds}s elapsed</span>}
      </div>
      {progress?.current && <div className="repository-import-current mono" title={progress.current} aria-hidden="true"><bdi>{progress.current}</bdi></div>}
    </div>
  </div>;
}

export function scanCounts(progress: Pick<RepositoryFolderScanProgress, "folders" | "repositories">): string {
  const folders = `${progress.folders.toLocaleString("en-US")} ${progress.folders === 1 ? "folder" : "folders"} checked`;
  const found = `${progress.repositories.toLocaleString("en-US")} ${progress.repositories === 1 ? "repository" : "repositories"} found`;
  return `${folders} · ${found}`;
}

function cancelFolderScan(request: Promise<number> | null) {
  void request?.then(api.repoCancelFolderScan).catch(() => undefined);
}

function RepositoryFolderImport({ close, initialFolder }: { close: () => void; initialFolder?: string }) {
  const groups = useLibrary(s => s.groups);
  const [path, setPath] = useState(initialFolder ?? "");
  const [scanning, setScanning] = useState(false);
  const [stopped, setStopped] = useState(false);
  // Stop was pressed: the scan still runs until the backend has ended it, and no other scan
  // starts before that.
  const [stopping, setStopping] = useState(false);
  const stopRequested = useRef<Promise<number> | null>(null);
  const [includeGenerated, setIncludeGenerated] = useState(false);
  const pendingScan = useRef<Promise<number> | null>(null);
  const [scanId, setScanId] = useState<number | null>(null);
  useEffect(() => () => {
    cancelFolderScan(pendingScan.current);
    pendingScan.current = null;
  }, []);
  // Opened for a folder that is not a repository itself: look inside it at once.
  useEffect(() => { if (initialFolder) void scanFolder(initialFolder); }, []);
  const [scan, setScan] = useState<RepositoryFolderScan | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [createGroups, setCreateGroups] = useState(true);
  const [error, setError] = useState("");
  const [rescanNote, setRescanNote] = useState("");
  const repositories = scan?.repositories ?? [];
  const allRoots = repositories.map(repo => repo.root);
  const relativePaths = new Map(repositories.map(repo => [repo.root, repo.relativePath]));
  const folders = createGroups ? folderGroupTree(repositories, selected) : [];
  const plans = planFolderGroups(groups, folders);
  const preview = createGroups
    ? folderGroupTree(repositories, new Set(allRoots)).map(({folder, parentFolder, roots}) => ({
      id: repositoryKey(folder), parentId: parentFolder ? repositoryKey(parentFolder) : null,
      name: basename(folder) || "Imported group", roots,
    }))
    : [{ id: "", parentId: null, name: "Open directly", roots: allRoots }];
  const subtreeRoots = new Map(preview.map(entry => [entry.id, [...entry.roots]]));
  for (const entry of [...preview].reverse()) {
    if (entry.parentId) {
      const parent = subtreeRoots.get(entry.parentId)!;
      for (const root of subtreeRoots.get(entry.id)!) parent.push(root);
    }
  }
  const selectedCount = selected.size;
  const newCount = plans.filter((plan) => !plan.existing).length;
  const updatedCount = plans.length - newCount;

  function select(roots: string[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const root of roots) {
        if (checked) next.add(root);
        else next.delete(root);
      }
      return next;
    });
  }

  function stopScan() {
    const request = pendingScan.current;
    if (!request || stopRequested.current === request) return;
    stopRequested.current = request;
    cancelFolderScan(request);
    setStopping(true);
  }

  /** `rescan`: the folder again after changes on disk. The current list and selection stay
   *  until the new result arrives (a stopped or failed rescan keeps them); then repositories the
   *  user unchecked stay unchecked, new ones are checked, and a note says what changed. */
  async function scanFolder(folder: string, rescan = false) {
    if (!folder.trim() || pendingScan.current) return;
    const known = rescan && scan ? new Set(scan.repositories.map(repo => repo.root)) : null;
    setRescanNote("");
    const request = api.repoPrepareFolderScan();
    pendingScan.current = request;
    setPath(folder);
    setScanning(true);
    setStopped(false);
    setError("");
    if (!known) {
      setScan(null);
      setSelected(new Set());
    }
    try {
      const current = () => pendingScan.current === request && stopRequested.current !== request;
      const id = await request;
      if (!current()) return;
      setScanId(id);
      const result = await api.repoScanFolder(id, folder, includeGenerated);
      if (!current()) return;
      setScan(result);
      const roots = result.repositories.map(repo => repo.root);
      if (known) {
        // The selection as it is now: the list stayed usable during the rescan.
        setSelected(current => rescanSelection(roots, { known, selected: current }));
        setRescanNote(rescanSummary(roots, known));
      } else setSelected(new Set(roots));
    } catch (cause) {
      if (pendingScan.current === request && stopRequested.current !== request) setError(errorMessage(cause));
    } finally {
      if (pendingScan.current === request) {
        pendingScan.current = null;
        setScanning(false);
        if (stopRequested.current === request) {
          stopRequested.current = null;
          setStopping(false);
          setStopped(true);
        }
      }
    }
  }

  async function browse() {
    try {
      const folder = await open({ directory: true, title: "Choose a folder to import" });
      if (typeof folder === "string") await scanFolder(folder);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function submit() {
    if (scanning) return;
    if (!scan) {
      void scanFolder(path);
      return;
    }
    if (!selectedCount) return;
    try {
      const roots = allRoots.filter(root => selected.has(root));
      useLibrary.getState().importGroups(roots, folders);
      useLibrary.getState().selectGroup(null);
      const repos = useRepos.getState();
      const opening = repos.openMany(roots, repos.active ?? roots[0]);
      useUi.setState({ repositoryOverview: true });
      void opening.then(results => {
        for (const result of results) if (result.status === "rejected") toast.error(result.reason, "Could not open repository");
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const rescanButton = <button type="button" className="btn sm" disabled={scanning} title="Scan the folder again to find repositories added or removed since"
    onClick={() => void scanFolder(path, true)}><RefreshCw size={13} /> Rescan</button>;

  return <Modal title="Import repositories from a folder" icon={<FolderSearch size={20} />} wide
    subtitle="Find Git repositories, review what to include, and open them together."
    onClose={close} onSubmit={submit}
    footer={<>
      <button type="button" className="btn" onClick={close}>Cancel</button>
      {scanning ? <button type="button" className="btn" disabled={stopping} onClick={event => { event.preventDefault(); stopScan(); }}>{stopping ? "Stopping…" : "Stop scan"}</button>
        : scan ? <button type="submit" className="btn primary" disabled={!selectedCount}>Import {selectedCount} {selectedCount === 1 ? "repository" : "repositories"}</button>
        : <button type="submit" className="btn primary" disabled={!path.trim()}>Scan folder</button>}
    </>}>
    <div className="field">
      <label htmlFor="repository-import-path">Parent folder</label>
      <div className="workspace-editor-filters">
        <input id="repository-import-path" className="input" placeholder="Enter a folder path" value={path} disabled={scanning}
          onChange={(event) => { setPath(event.target.value); setScan(null); setSelected(new Set()); setError(""); setStopped(false); setRescanNote(""); }} />
        <button type="button" className="btn" disabled={scanning} onClick={() => void browse()}><FolderOpen size={15} /> Browse…</button>
      </div>
    </div>
    <label className="repository-import-option">
      <input type="checkbox" checked={includeGenerated} disabled={scanning} onChange={(event) => {
        setIncludeGenerated(event.target.checked);
        setScan(null);
        setSelected(new Set());
        setStopped(false);
        setError("");
      }} /> Include ignored, build, dependency and cache folders
    </label>
    {scanning && <FolderScanProgress key={scanId ?? "preparing"} scanId={scanId} stopping={stopping} />}
    {stopped && <p className="batch-note" role="status">{scan ? "Rescan stopped. The previous list is kept." : "Scan stopped."}</p>}
    {error && <p className="red workspace-editor-error" role="alert">{error}</p>}
    {scan && <>
      {rescanNote && <p className="batch-note" role="status">{rescanNote}</p>}
      {scan.excluded > 0 && <p className="batch-note" role="status">Skipped {scan.excluded.toLocaleString("en-US")} ignored, build, dependency or cache {scan.excluded === 1 ? "folder" : "folders"}.</p>}
      {scan.skipped > 0 && <p className="batch-note" role="status">Skipped {scan.skipped} linked, inaccessible, or invalid entries.</p>}
      {!scan.repositories.length ? <div className="cg-empty">No Git working copies found in this folder. {rescanButton}</div> : <>
        <label className="repository-import-option">
          <input type="checkbox" checked={createGroups} onChange={(event) => setCreateGroups(event.target.checked)} /> Recreate the folder tree in Explorer
        </label>
        <div className="workspace-editor-selection">
          <span className="batch-note">{selectedCount} of {scan.repositories.length} selected</span>
          <span className="workspace-editor-filters">
            {rescanButton}
            <button type="button" className="btn sm" onClick={() => select(scan.repositories.map((repo) => repo.root), selectedCount !== scan.repositories.length)}>
              {selectedCount === scan.repositories.length ? "Clear all" : "Select all"}
            </button>
          </span>
        </div>
        <div className="library-list workspace-editor-list">
          {visibleTree(preview, () => true, () => false, false).map(({entry, depth}) => {
            const plan = plans.find(item => repositoryKey(item.folder) === entry.id);
            const title = entry.id ? `Group · ${plan?.name ?? entry.name}` : entry.name;
            const subtree = subtreeRoots.get(entry.id)!;
            const included = subtree.filter(root => selected.has(root)).length;
            return <section key={entry.id} className="repository-import-group" style={{ marginInlineStart: Math.min(depth, 8) * 12 }}>
              <label className="repository-import-heading">
                <input type="checkbox" checked={included === subtree.length}
                  ref={(input) => { if (input) input.indeterminate = included > 0 && included < subtree.length; }}
                  onChange={(event) => select(subtree, event.target.checked)} />
                <b>{title}</b>
                {plan?.existing && <span className="pill">Existing</span>}
                <span className="faint">{included === subtree.length ? subtree.length : `${included}/${subtree.length}`}</span>
              </label>
              {entry.roots.map((root) => <label className="library-row" key={root}>
                <input type="checkbox" checked={selected.has(root)} onChange={(event) => select([root], event.target.checked)} />
                <FolderGit2 size={15} />
                <div className="grow-text"><b>{basename(root)}</b><span className="batch-note library-path" title={root}>{relativePaths.get(root) || "."}</span></div>
              </label>)}
            </section>;
          })}
        </div>
        <p className="batch-note">Opens the selected repositories.
          {newCount > 0 && ` Creates ${newCount} ${newCount === 1 ? "group" : "groups"}.`}
          {updatedCount > 0 && ` Adds selected repositories to ${updatedCount} existing ${updatedCount === 1 ? "group" : "groups"}.`}
        </p>
      </>}
    </>}
  </Modal>;
}
