import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, ExternalLink, FolderSearch, Search } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename, relativeTime, shortOid } from "../lib/format";
import { loadGraph, useRepos } from "../lib/store";
import type { CommitSearchHit, SearchMode } from "../lib/types";
import { exclusiveLoads, loadRepositoryMatches, prioritizeRoots, searchHitText, searchRepositories, searchResultsText, WORKSPACE_SEARCH_DEBOUNCE_MS, type RepositorySearchResult } from "../lib/workspaceSearch";
import { contextMenu, copyText, showDialog } from "../lib/ui";
import { Modal } from "./Modal";


/** Text the user selected inside `element`, if any: a click that ends a selection must not open the commit. */
function selectionInside(element: Element) {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return "";
  const { anchorNode, focusNode } = selection;
  return (anchorNode && element.contains(anchorNode)) || (focusNode && element.contains(focusNode)) ? selection.toString() : "";
}

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
  // Repositories whose matches are folded away, leaving only their name.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
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

  const repositoryName = (root: string) => useRepos.getState().tabs[root]?.info?.name ?? basename(root);
  const shown = roots.filter((root) => repositories[root] && (repositories[root].hits.length || repositories[root].error));
  const allCollapsed = shown.length > 0 && shown.every((root) => collapsed.has(root));
  const toggle = (root: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (!next.delete(root)) next.add(root);
    return next;
  });
  const setAll = (fold: boolean) => setCollapsed(fold ? new Set(shown) : new Set());
  const groupText = (rootsToCopy: readonly string[]) => searchResultsText(rootsToCopy.map((root) => ({ name: repositoryName(root), hits: repositories[root].hits, error: repositories[root].error })));

  const open = (root: string, hit: CommitSearchHit) => {
    const state = useRepos.getState();
    const tab = state.tabs[root];
    if (!tab) return;
    close();
    state.activate(root);
    state.patch(root, { view: "history", selected: hit.oid, multi: [], branchFilter: null, viewedBranch: null, historyJump: hit.oid });
    if (tab.branchFilter) void loadGraph(root);
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
    {shown.length > 0 && <div className="workspace-search-tools hstack">
      <button type="button" className="btn sm ghost" onClick={() => setAll(!allCollapsed)}>
        {allCollapsed ? <><ChevronsUpDown size={13} /> Expand all</> : <><ChevronsDownUp size={13} /> Collapse all</>}
      </button>
      <button type="button" className="btn sm ghost" onClick={() => void copyText(groupText(shown), "Search results copied")}><Copy size={13} /> Copy all results</button>
    </div>}
    {shown.map((root) => {
      const result = repositories[root];
      const name = repositoryName(root);
      const folded = collapsed.has(root);
      const count = `${result.hits.length}${result.cursor ? "+" : ""} ${result.hits.length === 1 && !result.cursor ? "match" : "matches"}`;
      return <section className="workspace-search-group" key={root}>
        <div className="workspace-search-group-head hstack" onClick={(event) => { if (!selectionInside(event.currentTarget) && !(event.target as Element).closest("button")) toggle(root); }}>
          <button type="button" className="icon-btn" aria-expanded={!folded} aria-label={`${folded ? "Expand" : "Collapse"} ${name}`} title={folded ? "Show matches" : "Show only the repository name"} onClick={() => toggle(root)}>
            {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <h4 className="selectable" title={root}>{name}</h4>
          <span className="faint selectable">{result.error && !result.hits.length ? "Search failed" : count}</span>
          <button type="button" className="icon-btn" aria-label={`Copy results from ${name}`} title="Copy this repository's matches" onClick={() => void copyText(groupText([root]), "Search results copied")}><Copy size={13} /></button>
        </div>
        {!folded && <>
        {result.error && <p className="batch-note amber selectable" role="alert">{result.error}</p>}
        {result.hits.map((hit) => {
          const matchingHash = (mode === "quick" || mode === "hash") && hit.oid.startsWith(term.toLowerCase());
          const hash = shortOid(hit.oid, matchingHash ? Math.max(8, term.length) : 8);
          return <div role="button" tabIndex={0} className="workspace-search-hit selectable" key={hit.oid}
            onClick={(event) => { if (!selectionInside(event.currentTarget)) open(root, hit); }}
            onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(root, hit); } }}
            onContextMenu={(event) => {
              const selected = selectionInside(event.currentTarget);
              contextMenu(event, [
                { label: "Open commit", icon: <ExternalLink size={14} />, onClick: () => open(root, hit) },
                { separator: true },
                ...(selected ? [{ label: "Copy selected text", icon: <Copy size={14} />, onClick: () => void copyText(selected) }] : []),
                { label: "Copy commit message", icon: <Copy size={14} />, onClick: () => void copyText(hit.subject, "Commit message copied") },
                { label: "Copy hash", icon: <Copy size={14} />, onClick: () => void copyText(hit.oid, "Hash copied") },
                { label: "Copy author", icon: <Copy size={14} />, onClick: () => void copyText(hit.author, "Author copied") },
                ...(hit.refs ? [{ label: "Copy refs", icon: <Copy size={14} />, onClick: () => void copyText(hit.refs, "Refs copied") }] : []),
                { label: "Copy match", icon: <Copy size={14} />, onClick: () => void copyText(searchHitText(hit), "Match copied") },
                { label: "Copy repository name", icon: <Copy size={14} />, onClick: () => void copyText(name, "Repository name copied") },
              ]);
            }}>
            <b>{hit.subject ? highlight(hit.subject, "message") : "(no commit message)"}</b>
            <span className="faint">
              <code title={hit.oid}>{matchingHash ? <><mark>{hash.slice(0, term.length)}</mark>{hash.slice(term.length)}</> : hash}</code>
              {" · "}{highlight(hit.author, "author")}{" · "}{relativeTime(hit.authorTime)}
              {hit.refs && <>{" · "}{highlight(hit.refs, "quick")}</>}
            </span>
          </div>;
        })}
        {result.cursor && !result.error && <p className="batch-note">Showing the newest {result.hits.length} matches.{" "}
          <button type="button" className="btn sm ghost" disabled={loads.current.busy(root)} onClick={() => more(root)}>{loads.current.busy(root) ? "Loading matches…" : "Show more matches"}</button></p>}
        </>}
      </section>;
    })}
  </Modal>;
}
