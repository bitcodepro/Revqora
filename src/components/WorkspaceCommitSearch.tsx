import { useEffect, useRef, useState } from "react";
import { FolderSearch, Search } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename, relativeTime, shortOid } from "../lib/format";
import { loadGraph, useRepos } from "../lib/store";
import type { CommitSearchHit, SearchMode } from "../lib/types";
import { exclusiveLoads, loadRepositoryMatches, prioritizeRoots, searchRepositories, WORKSPACE_SEARCH_DEBOUNCE_MS, type RepositorySearchResult } from "../lib/workspaceSearch";
import { showDialog } from "../lib/ui";
import { Modal } from "./Modal";


export function workspaceCommitSearch(query: string, mode: SearchMode) {
  return showDialog<void>((close) => <WorkspaceCommitSearch initialQuery={query} initialMode={mode} close={close} />);
}

function WorkspaceCommitSearch({ initialQuery, initialMode, close }: { initialQuery: string; initialMode: SearchMode; close: () => void }) {
  const roots = useRepos((state) => state.order);
  // Each search (and each "Show more") belongs to one generation; older ones stop publishing.
  const generation = useRef(0);
  // Repositories loading in the current search; "Show more" waits for them.
  const [, setLoadsVersion] = useState(0);
  const loads = useRef(exclusiveLoads());
  const [query, setQuery] = useState(initialQuery);
  const [mode, setMode] = useState(initialMode);
  const [results, setResults] = useState<{ key: string; repositories: Record<string, RepositorySearchResult> }>({ key: "", repositories: {} });
  const term = query.trim();
  const pattern = term ? new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "iu") : null;
  const highlight = (value: string, field: SearchMode) => {
    if (!pattern || (mode !== "quick" && mode !== field)) return value;
    return value.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part);
  };
  const key = JSON.stringify([roots, term, mode]);
  const repositories = results.key === key ? results.repositories : {};
  const completed = Object.keys(repositories).length;
  const matches = roots.some((root) => repositories[root]?.hits.length);
  const errors = roots.some((root) => repositories[root]?.error);

  const fetchPage = (root: string, cursor: string | null) =>
    api.repositoryCommitSearch(root, term, mode, cursor).catch((error: unknown) => { throw new Error(errorMessage(error)); });
  const publishFor = (searchKey: string) => (root: string, result: RepositorySearchResult) =>
    setResults((previous) => previous.key === searchKey ? { key: searchKey, repositories: { ...previous.repositories, [root]: result } } : previous);

  useEffect(() => {
    const current = ++generation.current;
    if (!term || !roots.length) return;
    const isCurrent = () => generation.current === current;
    setResults({ key, repositories: {} });
    const searchLoads = exclusiveLoads(() => { if (loads.current === searchLoads) setLoadsVersion((v) => v + 1); });
    loads.current = searchLoads;
    // Obsolete searches are not awaited: they stop before their next request and never publish.
    const timer = setTimeout(() => {
      void searchRepositories(prioritizeRoots(roots, useRepos.getState().active), fetchPage, isCurrent, publishFor(key), undefined, searchLoads);
    }, WORKSPACE_SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); if (generation.current === current) generation.current++; };
  }, [roots, term, mode, key]);

  const more = (root: string) => {
    const result = repositories[root];
    if (!result?.cursor || loads.current.busy(root)) return;
    const current = generation.current;
    void loads.current.run(root, () => loadRepositoryMatches(root, result, fetchPage, () => generation.current === current, publishFor(key)));
  };

  const open = (root: string, hit: CommitSearchHit) => {
    const state = useRepos.getState();
    const tab = state.tabs[root];
    if (!tab) return;
    close();
    state.activate(root);
    state.patch(root, { view: "history", selected: hit.oid, multi: [], branchFilter: null, branchContext: null, viewedBranch: null, historyJump: hit.oid });
    if (tab.branchFilter || tab.branchContext) void loadGraph(root);
  };

  return <Modal title="Search all repositories" subtitle="Search commits across the open repositories in this workspace." icon={<FolderSearch size={18} />} wide expandForResults={matches || errors}
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
        {result.hits.map((hit) => {
          const matchingHash = (mode === "quick" || mode === "hash") && hit.oid.startsWith(term.toLowerCase());
          const hash = shortOid(hit.oid, matchingHash ? Math.max(8, term.length) : 8);
          return <button type="button" className="workspace-search-hit" key={hit.oid} onClick={() => open(root, hit)}>
            <b>{hit.subject ? highlight(hit.subject, "message") : "(no commit message)"}</b>
            <span className="faint">
              <code title={hit.oid}>{matchingHash ? <><mark>{hash.slice(0, term.length)}</mark>{hash.slice(term.length)}</> : hash}</code>
              {" · "}{highlight(hit.author, "author")}{" · "}{relativeTime(hit.authorTime)}
              {hit.refs && <>{" · "}{highlight(hit.refs, "quick")}</>}
            </span>
          </button>;
        })}
        {result.cursor && !result.error && <p className="batch-note">Showing the newest {result.hits.length} matches.{" "}
          <button type="button" className="btn sm ghost" disabled={loads.current.busy(root)} onClick={() => more(root)}>{loads.current.busy(root) ? "Loading matches…" : "Show more matches"}</button></p>}
      </section>;
    })}
  </Modal>;
}
