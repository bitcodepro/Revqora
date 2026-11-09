import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderGit2, FolderOpen, FolderSearch, Loader2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename } from "../lib/format";
import { planFolderWorkspaces, useLibrary } from "../lib/repositoryLibrary";
import { importFolderRepositories } from "../lib/repositoryWorkspaces";
import type { RepositoryFolderScan } from "../lib/types";
import { showDialog } from "../lib/ui";
import { Modal } from "./Modal";

export function repositoryFolderImportDialog() {
  return showDialog<void>((close) => <RepositoryFolderImport close={close} />);
}

function RepositoryFolderImport({ close }: { close: () => void }) {
  const workspaces = useLibrary((s) => s.workspaces);
  const [path, setPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<RepositoryFolderScan | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [createWorkspaces, setCreateWorkspaces] = useState(true);
  const [error, setError] = useState("");
  const groups = new Map<string | null, string[]>();
  const relativePaths = new Map(scan?.repositories.map((repo) => [repo.root, repo.relativePath]));
  for (const repo of scan?.repositories ?? []) {
    const folder = createWorkspaces ? repo.workspaceFolder : null;
    const roots = groups.get(folder) ?? [];
    roots.push(repo.root);
    groups.set(folder, roots);
  }
  const workspaceGroups = [...groups].flatMap(([folder, roots]) => {
    const included = roots.filter((root) => selected.has(root));
    return folder && included.length ? [{ folder, roots: included }] : [];
  });
  const plans = planFolderWorkspaces(workspaces, workspaceGroups);
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
      importFolderRepositories(scan.repositories.filter((repo) => selected.has(repo.root)).map((repo) => repo.root), workspaceGroups);
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
    {scanning && <div className="repository-import-progress" role="status"><Loader2 className="spin" size={16} /> Looking for Git repositories…</div>}
    {error && <p className="red workspace-editor-error" role="alert">{error}</p>}
    {scan && <>
      {(scan.skipped > 0 || scan.limited) && <p className="batch-note" role="status">
        {scan.limited && "The scan reached its limit. Choose a narrower folder to see more results. "}
        {scan.skipped > 0 && `Skipped ${scan.skipped} linked, inaccessible, or invalid entries.`}
      </p>}
      {!scan.repositories.length ? <div className="cg-empty">No Git working copies found in this folder.</div> : <>
        {scan.repositories.some((repo) => repo.workspaceFolder) && <label className="repository-import-option">
          <input type="checkbox" checked={createWorkspaces} onChange={(event) => setCreateWorkspaces(event.target.checked)} /> Create Workspaces from subfolders
        </label>}
        <div className="workspace-editor-selection">
          <span className="batch-note">{selectedCount} of {scan.repositories.length} selected</span>
          <button type="button" className="btn sm" onClick={() => select(scan.repositories.map((repo) => repo.root), selectedCount !== scan.repositories.length)}>
            {selectedCount === scan.repositories.length ? "Clear all" : "Select all"}
          </button>
        </div>
        <div className="library-list workspace-editor-list">
          {[...groups].sort(([a], [b]) => Number(a !== null) - Number(b !== null)).map(([folder, roots]) => {
            const plan = plans.find((item) => item.folder === folder);
            const title = folder ? `Workspace · ${plan?.name ?? basename(folder)}` : "Open directly";
            const included = roots.filter((root) => selected.has(root)).length;
            return <section key={folder ?? ""} className="repository-import-group">
              <label className="repository-import-heading">
                <input type="checkbox" checked={included === roots.length}
                  ref={(input) => { if (input) input.indeterminate = included > 0 && included < roots.length; }}
                  onChange={(event) => select(roots, event.target.checked)} />
                <b>{title}</b>
                {plan?.existing && <span className="pill">Existing</span>}
                <span className="faint">{included === roots.length ? roots.length : `${included}/${roots.length}`}</span>
              </label>
              {roots.map((root) => <label className="library-row" key={root}>
                <input type="checkbox" checked={selected.has(root)} onChange={(event) => select([root], event.target.checked)} />
                <FolderGit2 size={15} />
                <div className="grow-text"><b>{basename(root)}</b><span className="batch-note library-path" title={root}>{relativePaths.get(root) || "."}</span></div>
              </label>)}
            </section>;
          })}
        </div>
        <p className="batch-note">Opens the repository overview in All Workspaces.
          {newCount > 0 && ` Creates ${newCount} ${newCount === 1 ? "Workspace" : "Workspaces"}.`}
          {updatedCount > 0 && ` Adds selected repositories to ${updatedCount} existing ${updatedCount === 1 ? "Workspace" : "Workspaces"}.`}
        </p>
      </>}
    </>}
  </Modal>;
}
