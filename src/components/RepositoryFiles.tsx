import { useEffect, useState } from "react";
import { ExternalLink, FileText, FolderOpen, RefreshCw, Search } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useRepos } from "../lib/store";
import { showDialog, toast } from "../lib/ui";
import { joinPath } from "../lib/format";
import type { IgnoredFiles, NestedRepositories } from "../lib/types";
import { Modal } from "./Modal";

export function repositoryFiles(root: string, kind: "ignored" | "nested") {
  return showDialog<void>((close) => <RepositoryFiles root={root} kind={kind} close={close} />);
}

function RepositoryFiles({ root, kind, close }: { root: string; kind: "ignored" | "nested"; close: () => void }) {
  const [data, setData] = useState<IgnoredFiles | NestedRepositories | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    const request = kind === "ignored" ? api.ignoredFiles(root) : api.nestedRepositories(root);
    void request.then((value) => { if (alive) setData(value); }, (e) => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; };
  }, [root, kind, version]);
  const filter = query.toLocaleLowerCase();
  return <Modal title={kind === "ignored" ? "Ignored files & folders" : "Nested repositories"} wide onClose={close} footer={<button className="btn" onClick={close}>Close</button>}>
    <div className="hstack">
      <Search size={15} /><input className="input" aria-label="Filter repository files" placeholder="Filter paths…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <button className="btn" disabled={!data && !error} onClick={() => setVersion((v) => v + 1)}><RefreshCw size={14} /> Refresh</button>
    </div>
    <p className="muted">{kind === "ignored" ? "These paths are excluded by Git ignore rules. Wholly ignored folders are grouped; open a folder to inspect its contents." : "Open a child as its own repository. Build folders and symbolic links are skipped; each discovered repository is a separate workspace."}</p>
    {error && <div className="callout danger">{error}</div>}
    {!data && !error && <div className="loading-center"><span className="loader" /></div>}
    {data?.truncated && <div className="callout warn">The scan reached its limit. Open a deeper folder to inspect more paths.</div>}
    {data && <div className="repository-file-results" style={{ maxHeight: "55vh", overflow: "auto" }}>
      {"paths" in data ? data.paths.filter((p) => p.toLocaleLowerCase().includes(filter)).map((p) => <div className="file-row" key={p}>
        {p.endsWith("/") ? <FolderOpen size={14} /> : <FileText size={14} />}<span className="ellipsis selectable" title={p} style={{ flex: 1 }}>{p}</span>
        <button className="btn sm" onClick={() => void api.openPath(joinPath(root, p)).catch((e) => toast.error(e))}><ExternalLink size={12} /> Open</button>
      </div>) : data.repositories.filter((r) => r.relativePath.toLocaleLowerCase().includes(filter)).map((r) => <div className="file-row nested-repository" key={r.path} style={{ height: "auto", minHeight: 48 }}>
        <div style={{ flex: 1, minWidth: 0 }}><div className="ellipsis" title={r.path}>{r.relativePath}</div><small className="muted">{r.kind} · {r.branch ?? "detached HEAD"}</small></div>
        <button className="btn sm" onClick={async () => {
          try { if (r.kind === "bare") await api.openPath(r.path); else { await useRepos.getState().open(r.path); close(); } } catch (e) { toast.error(e); }
        }}><FolderOpen size={13} /> {r.kind === "bare" ? "Open folder" : "Open repository"}</button>
      </div>)}
      {("paths" in data ? data.paths.length : data.repositories.length) === 0 && <div className="empty">{kind === "ignored" ? "No ignored paths" : "No nested repositories found"}</div>}
    </div>}
  </Modal>;
}
