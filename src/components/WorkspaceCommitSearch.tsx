import { useEffect, useState } from "react";
import { FolderSearch, Search } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename, relativeTime, shortOid } from "../lib/format";
import { loadGraph, useRepos } from "../lib/store";
import type { CommitSearchHit, SearchMode } from "../lib/types";
import { showDialog } from "../lib/ui";
import { Modal } from "./Modal";

const VISIBLE_LIMIT = 30;
const PARALLEL_SEARCHES = 2;
let pendingSearch: Promise<void> = Promise.resolve();

export function workspaceCommitSearch(query: string, mode: SearchMode) {
  return showDialog<void>((close) => <WorkspaceCommitSearch initialQuery={query} initialMode={mode} close={close} />);
}

interface SearchResult {
  hits: CommitSearchHit[];
  error?: string;
}

function WorkspaceCommitSearch({ initialQuery, initialMode, close }: { initialQuery: string; initialMode: SearchMode; close: () => void }) {
  const roots = useRepos((state) => state.order);
  const [query, setQuery] = useState(initialQuery);
  const [mode, setMode] = useState(initialMode);
  const [results, setResults] = useState<{ key: string; repositories: Record<string, SearchResult> }>({ key: "", repositories: {} });
  const term = query.trim();
  const key = JSON.stringify([roots, term, mode]);
  const repositories = results.key === key ? results.repositories : {};
  const completed = Object.keys(repositories).length;
  const matches = roots.some((root) => repositories[root]?.hits.length);
  const errors = roots.some((root) => repositories[root]?.error);

  useEffect(() => {
    if (!term || !roots.length) return;
    let current = true;
    setResults({ key, repositories: {} });
    const timer = setTimeout(() => {
      pendingSearch = pendingSearch.then(async () => {
        let next = 0;
        const search = async () => {
          while (current && next < roots.length) {
            const root = roots[next++];
            const result = await api.repositoryCommitSearch(root, term, mode).then(
              (hits): SearchResult => ({ hits }),
              (error): SearchResult => ({ hits: [], error: errorMessage(error) }),
            );
            if (current) setResults((previous) => ({ key, repositories: { ...(previous.key === key ? previous.repositories : {}), [root]: result } }));
          }
        };
        await Promise.all(Array.from({ length: PARALLEL_SEARCHES }, search));
      });
    }, 320);
    return () => { current = false; clearTimeout(timer); };
  }, [roots, term, mode, key]);

  const open = (root: string, hit: CommitSearchHit) => {
    const state = useRepos.getState();
    const tab = state.tabs[root];
    if (!tab) return;
    close();
    state.patch(root, { view: "history", selected: hit.oid, multi: [], branchFilter: null, historyJump: hit.oid });
    state.activate(root);
    if (tab.branchFilter && tab.graph) void loadGraph(root);
  };

  return <Modal title="Search all repositories" subtitle="Search commits across the open repositories in this workspace." icon={<FolderSearch size={18} />} wide
    onClose={close} footer={<button type="button" className="btn" onClick={close}>Close</button>}>
    <div className="workspace-search-controls hstack">
      <label className="input-wrap"><Search size={14} /><input className="input" aria-label="Search commits across repositories" placeholder="Message, author, hash or branch…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <select className="input" aria-label="What to search across repositories" value={mode} onChange={(event) => setMode(event.target.value as SearchMode)}>
        <option value="quick">All</option><option value="message">Message</option><option value="author">Author</option>
        <option value="hash">Hash</option><option value="content">Code (pickaxe)</option><option value="path">File path</option>
      </select>
    </div>
    <p className="batch-note" role="status">{!term ? "Enter a search term." : completed < roots.length ? `Searching ${completed} of ${roots.length} repositories…` : !matches && !errors ? "No matching commits." : `Searched ${completed} ${completed === 1 ? "repository" : "repositories"}.`}</p>
    {roots.map((root) => {
      const result = repositories[root];
      if (!result || (!result.hits.length && !result.error)) return null;
      return <section className="workspace-search-group" key={root}>
        <h4 title={root}>{useRepos.getState().tabs[root]?.info?.name ?? basename(root)}</h4>
        {result.error && <p className="batch-note amber" role="alert">{result.error}</p>}
        {result.hits.slice(0, VISIBLE_LIMIT).map((hit) => <button type="button" className="workspace-search-hit" key={hit.oid} onClick={() => open(root, hit)}>
          <b>{hit.subject || "(no commit message)"}</b>
          <span className="faint"><code>{shortOid(hit.oid)}</code> · {hit.author} · {relativeTime(hit.authorTime)}{hit.refs && ` · ${hit.refs}`}</span>
        </button>)}
        {result.hits.length > VISIBLE_LIMIT && <p className="batch-note">Showing the first {VISIBLE_LIMIT} matches. Refine your search to narrow the results.</p>}
      </section>;
    })}
  </Modal>;
}
