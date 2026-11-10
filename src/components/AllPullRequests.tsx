import { useEffect, useMemo, useRef, useState } from "react";
import { GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename } from "../lib/format";
import { authorScope, loadAuthorPreferences, matchesPrAuthor } from "../lib/prAuthors";
import { appendPullRequests, searchPullRequests } from "../lib/prCenter";
import { visitPrPages, viewerAuthor } from "../lib/prTracking";
import { uniqueRoots, useLibrary } from "../lib/repositoryLibrary";
import { useRepos } from "../lib/store";
import type { ForgeInfo, PrState, PullRequest } from "../lib/types";

type Group = {
  forge: ForgeInfo | null;
  items: PullRequest[];
  notice: string;
  loading: boolean;
};

export function AllPullRequests({ open }: { open: (root: string, forge: ForgeInfo, number: number) => Promise<void> }) {
  const known = useLibrary(s => s.knownRoots);
  const opened = useRepos(s => s.order);
  const roots = useMemo(() => uniqueRoots([...opened, ...known]), [opened, known]);
  const [state, setState] = useState<PrState>("open");
  const [mine, setMine] = useState(true);
  const [query, setQuery] = useState("");
  const [generation, setGeneration] = useState(0);
  const [groups, setGroups] = useState<Record<string, Group>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [pending, setPending] = useState(false);
  const [finished, setFinished] = useState(false);
  const scans = useRef(Promise.resolve());

  useEffect(() => {
    let current = true;
    let index = 0;
    const refresh = () => setGeneration(n => n + 1);
    window.addEventListener("revqora:forge-accounts", refresh);
    setGroups({});
    setLimits({});
    setFinished(false);
    function update(root: string, change: (old: Group) => Group) {
      if (!current) return;
      setGroups(previous => ({ ...previous, [root]: change(previous[root] ?? { forge: null, items: [], notice: "", loading: true }) }));
    }
    async function worker() {
      while (current && index < roots.length) {
        const root = roots[index++];
        let hasIdentity = true;
        try {
          if (!await api.forgeKind(root) || !current) continue;
          update(root, old => old);
          await visitPrPages(cursor => api.prPage(root, state, cursor), () => current && hasIdentity, page => {
            const author = mine ? viewerAuthor(page.viewer) ?? loadAuthorPreferences(root, authorScope(page.forge, page.viewer), page.forge).mine : null;
            hasIdentity = !mine || !!author;
            update(root, old => ({
              ...old,
              forge: page.forge,
              items: hasIdentity ? appendPullRequests(old.items, page.items.filter(p => matchesPrAuthor(p, author))) : [],
              notice: hasIdentity ? "" : "Set My PR author in this repository to include its pull requests.",
            }));
          }, null, Infinity);
        } catch (error) {
          update(root, old => ({ ...old, notice: errorMessage(error) }));
        } finally {
          if (current) setGroups(previous => previous[root] ? { ...previous, [root]: { ...previous[root], loading: false } } : previous);
        }
      }
    }
    scans.current = scans.current.then(async () => {
      if (!current) return;
      await Promise.all(Array.from({ length: Math.min(3, roots.length) }, worker));
      if (current) setFinished(true);
    });
    return () => { current = false; window.removeEventListener("revqora:forge-accounts", refresh); };
  }, [roots, state, mine, generation]);

  const openRequest = async (root: string, forge: ForgeInfo, number: number) => {
    setPending(true);
    try { await open(root, forge, number); }
    finally { setPending(false); }
  };
  const shown = roots.flatMap(root => {
    const group = groups[root];
    const items = group ? searchPullRequests(group.items, query) : [];
    return group && (items.length || group.loading || group.notice) ? [{ root, group, items }] : [];
  });
  return <section className="all-pull-requests" aria-label="Pull requests across repositories">
    <header className="pr-scope-bar">
      <select className="select" aria-label="Request status across repositories" value={state} onChange={e => setState(e.target.value as PrState)}>
        {(["open", "closed", "merged", "all"] as const).map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
      </select>
      <select className="select" aria-label="Authors across repositories" value={mine ? "mine" : "all"} onChange={e => setMine(e.target.value === "mine")}>
        <option value="mine">My pull requests</option><option value="all">All authors</option>
      </select>
      <input className="input" aria-label="Search pull requests across repositories" placeholder="Search PRs…" value={query} onChange={e => setQuery(e.target.value)} />
      <button type="button" className="icon-btn" title="Refresh all pull requests" aria-label="Refresh all pull requests" onClick={() => setGeneration(n => n + 1)}><RefreshCw size={15}/></button>
    </header>
    <div className="all-pr-groups">
      {shown.map(({ root, group, items }) => {
        const limit = limits[root] ?? 25;
        const forge = group.forge;
        return <section className="all-pr-group" key={root} aria-label={basename(root)} aria-busy={group.loading}>
          <header title={root}><b>{basename(root)}</b>{forge&&<span className="faint">{forge.project}</span>}<span className="pill">{items.length}</span>{group.loading&&<Loader2 className="spin" size={14}/>}</header>
          {group.notice&&<p className="faint">{group.notice}</p>}
          {forge&&items.slice(0, limit).map(p => <button key={p.number} type="button" className="all-pr-row" disabled={pending} onClick={() => void openRequest(root, forge, p.number)}>
            <GitPullRequest size={15}/><span className="mono faint">#{p.number}</span><b>{p.title}</b><span className={`pill pr-state-${p.state}`}>{p.state}</span><span className="faint">{p.author}</span>
          </button>)}
          {items.length > limit&&<button type="button" className="btn sm" onClick={() => setLimits(old => ({ ...old, [root]: limit + 25 }))}>Show more</button>}
        </section>;
      })}
      {!finished?<p className="loading-status" role="status"><Loader2 className="spin" size={16}/>Looking for pull requests…</p>:!shown.length&&<p className="faint">No matching pull requests.</p>}
    </div>
  </section>;
}
