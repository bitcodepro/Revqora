import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderGit2, FolderOpen, FolderSearch, Loader2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename } from "../lib/format";
import { planFolderGroups, repositoryKey, useLibrary } from "../lib/repositoryLibrary";
import { folderGroupTree } from "../lib/folderGroupTree";
import { visibleTree } from "../lib/libraryTree";
import { useRepos } from "../lib/store";
import type { RepositoryFolderScan } from "../lib/types";
import { showDialog, useUi, toast } from "../lib/ui";
import { Modal } from "./Modal";

export function repositoryFolderImportDialog() {
  return showDialog<void>((close) => <RepositoryFolderImport close={close} />);
}

function FolderScanProgress() {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((performance.now() - started) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="loading-status repository-import-progress" role="status">
    <Loader2 className="spin" size={16} aria-hidden="true" />
    Looking for Git repositories…
    {elapsedSeconds > 0 && <span className="batch-note" aria-hidden="true">{elapsedSeconds}s elapsed</span>}
  </div>;
}

function RepositoryFolderImport({ close }: { close: () => void }) {
  const groups = useLibrary(s => s.groups);
  const [path, setPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<RepositoryFolderScan | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [createGroups, setCreateGroups] = useState(true);
  const [error, setError] = useState("");
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

  async function scanFolder(folder: string) {
    if (!folder.trim() || scanning) return;
    setPath(folder);
    setScanning(true);
    setError("");
    setScan(null);
    try {
      const result = await api.repoScanFolder(folder);
      setScan(result);
      setSelected(new Set(result.repositories.map((repo) => repo.root)));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setScanning(false);
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

  return <Modal title="Import repositories from a folder" icon={<FolderSearch size={20} />} wide
    subtitle="Find Git repositories, review what to include, and open them together."
    onClose={close} onSubmit={submit}
    footer={<>
      <button type="button" className="btn" onClick={close}>Cancel</button>
      {scan ? <button type="submit" className="btn primary" disabled={!selectedCount}>Import {selectedCount} {selectedCount === 1 ? "repository" : "repositories"}</button>
        : <button type="submit" className="btn primary" disabled={scanning || !path.trim()}>Scan folder</button>}
    </>}>
    <div className="field">
      <label htmlFor="repository-import-path">Parent folder</label>
      <div className="workspace-editor-filters">
        <input id="repository-import-path" className="input" placeholder="Enter a folder path" value={path} disabled={scanning}
          onChange={(event) => { setPath(event.target.value); setScan(null); setSelected(new Set()); setError(""); }} />
        <button type="button" className="btn" disabled={scanning} onClick={() => void browse()}><FolderOpen size={15} /> Browse…</button>
      </div>
    </div>
    {scanning && <FolderScanProgress />}
    {error && <p className="red workspace-editor-error" role="alert">{error}</p>}
    {scan && <>
      {scan.skipped > 0 && <p className="batch-note" role="status">Skipped {scan.skipped} linked, inaccessible, or invalid entries.</p>}
      {!scan.repositories.length ? <div className="cg-empty">No Git working copies found in this folder.</div> : <>
        <label className="repository-import-option">
          <input type="checkbox" checked={createGroups} onChange={(event) => setCreateGroups(event.target.checked)} /> Recreate the folder tree in Explorer
        </label>
        <div className="workspace-editor-selection">
          <span className="batch-note">{selectedCount} of {scan.repositories.length} selected</span>
          <button type="button" className="btn sm" onClick={() => select(scan.repositories.map((repo) => repo.root), selectedCount !== scan.repositories.length)}>
            {selectedCount === scan.repositories.length ? "Clear all" : "Select all"}
          </button>
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
