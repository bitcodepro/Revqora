import {PrMergePanel,mergeDialog,cleanupDialog} from "./PrMerge";
import {PrReviews,composeReview,chooseReview} from "./PrReviews";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useFileListNavigation } from "../lib/useFileListNavigation";
import { Bell, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Download, ExternalLink, FileDiff, GitPullRequest, GitPullRequestCreate, List, Loader2, Maximize2, MinusCircle, Pencil, RefreshCw, XCircle } from "lucide-react";
import { forgeAccountsDialog } from "./ForgeAccounts";
import { api, errorMessage, isGitError } from "../lib/api";
import { getTab, type RepoTab } from "../lib/store";
import { showDialog, toast, copyText, openOverlay, contextMenu } from "../lib/ui";
import { useAllPullRequests } from "../lib/useAllPullRequests";
import { repositoryKey, useLibrary } from "../lib/repositoryLibrary";
import * as A from "../lib/actions";
import type { Check, ForgeInfo, PullRequest, PrDetail, PrEditResult, PrFile, PrFileView, PrState, PrTemplates } from "../lib/types";
import { basename, relativeTime, shortOid } from "../lib/format";
import { appendPullRequests, forgeRepositoryIdentity, loadPrPreferences, prPreferencesKey, pullRequestNumber, restorePrPreferences, safeWebUrl, searchPullRequests, utf8Length, prWriteAttemptKey, prWriteAttemptPending, setPrWriteAttemptPending, type PrPreferences } from "../lib/prCenter";
import { Modal } from "./Modal";
import { Splitter } from "./Overlays";
import { DiffView } from "./DiffView";
import { confirmDialog } from "./dialogs";
import { virtualRange } from "../lib/virtualRange";
import {authorSelectionValue,authorScope,authorPreferencesKey,loadAuthorPreferences,mergePrAuthors,matchesPrAuthor,rememberAccountAuthor,restoreAuthorPreferences,samePrAuthor,type PrAuthor,type AuthorPreferences} from "../lib/prAuthors";
import { useSettings } from "../lib/settings";
import { onPrRefresh } from "../lib/prRefresh";
import { copyUrlMenu } from "./NamePathMenu";
import { EMPTY_PR_WATCH, PR_PAGE_REFRESHED, nextPrListRead, updatePrWatch, viewerAuthor, type PrPageRefresh } from "../lib/prTracking";

const FORGE_NAMES: Record<string, string> = { github: "GitHub", azure: "Azure DevOps", gitlab: "GitLab", bitbucket: "Bitbucket Cloud", "bitbucket-server": "Bitbucket Server" };
const prUrlMenu = (p: PullRequest) => [copyUrlMenu(() => p.url, "The provider did not supply a web address for this pull request.")];
const browser = (url: string) => { const safe = safeWebUrl(url); if (safe) void api.openPath(safe); };

export function CheckIcon({ state, size = 14 }: { state: Check["state"]; size?: number }) {
  switch (state) {
    case "success": return <CheckCircle2 size={size} style={{ color: "var(--green)" }} />;
    case "failure": return <XCircle size={size} style={{ color: "var(--red)" }} />;
    case "pending": return <CircleDashed size={size} className="spin" style={{ color: "var(--amber)" }} />;
    default: return <MinusCircle size={size} style={{ color: "var(--text-faint)" }} />;
  }
}
export function ChecksList({ checks }: { checks: Check[] }) {
  if (!checks.length) return <div className="faint">No CI checks reported for this commit.</div>;
  return <div className="vstack" style={{ gap: 4 }}>{checks.map((c, i) => <div key={i} className="hstack" style={{ gap: 8 }}><CheckIcon state={c.state} /><span className="ellipsis" style={{ flex: 1 }}>{c.name}</span>{safeWebUrl(c.url) && <button className="icon-btn sm" title="Open" onClick={() => browser(c.url!)}><ExternalLink size={12} /></button>}</div>)}</div>;
}
export function summarizeChecks(checks: Check[]): Check["state"] | null { return !checks.length ? null : checks.some(c => c.state === "failure") ? "failure" : checks.some(c => c.state === "pending") ? "pending" : "success"; }

const PR_STATES = ["open", "closed", "merged", "all"] as const;

function RequestStatus({ label, value, change }: { label: string; value: PrState; change: (value: PrState) => void }) {
  return <select className="select" aria-label={label} value={value} onChange={e => change(e.target.value as PrState)}>
    {PR_STATES.map(state => <option key={state} value={state}>{state[0].toUpperCase() + state.slice(1)}</option>)}
  </select>;
}

function usePrPreferences(key: string) {
  const [prefs, setPrefs] = useState(() => loadPrPreferences(key));
  const save = useCallback((patch: Partial<PrPreferences>) => setPrefs(p => restorePrPreferences({ ...p, ...patch })), []);
  useEffect(() => {
    try { localStorage.setItem(prPreferencesKey(key), JSON.stringify(prefs)); }
    catch { toast.warning("PR Center preferences could not be saved"); }
  }, [key, prefs]);
  return [prefs, save] as const;
}

function PrCenterLayout({ label, prefs, save, title, subtitle, count, list, actions, children }: {
  label: string; prefs: PrPreferences; save: (patch: Partial<PrPreferences>) => void;
  title: string; subtitle: string; count: number; list: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  const [listWidth, setListWidth] = useState(prefs.listWidth);
  return <section className={`pr-center ${prefs.listOpen ? "" : "pr-list-hidden"}`} aria-label={label} style={{ "--pr-list-width": `${listWidth}px` } as CSSProperties}>
    {prefs.listOpen && <aside className="pr-list-panel" aria-label="Pull request list">
      <div className="pr-list-heading"><GitPullRequest size={17} /><b>Pull requests</b><span className="pill" data-pr-loaded={count}>{count}</span><div className="spacer" /><button className="icon-btn" title="Hide pull request list" aria-label="Hide pull request list" onClick={() => save({ listOpen: false })}><ChevronLeft size={16} /></button></div>
      {list}
    </aside>}
    {prefs.listOpen && <Splitter dir="v" style={{ left: "clamp(200px, var(--pr-list-width), 35%)" }} onDrag={d => setListWidth(w => Math.max(200, Math.min(520, w + d)))} onEnd={() => save({ listWidth })} />}
    <main className="pr-content">
      <header className="pr-center-head">
        <button className="icon-btn" title={prefs.listOpen ? "Hide pull request list" : "Show pull request list"} aria-label={prefs.listOpen ? "Collapse pull request list" : "Show pull request list"} onClick={() => save({ listOpen: !prefs.listOpen })}><List size={16} /></button>
        <div className="pr-connection"><b className="ellipsis" title={title}>{title}</b><small title={subtitle}>{subtitle}</small></div>
        {actions}
      </header>
      {children}
    </main>
  </section>;
}

function togglePrWatch(root: string, scope: string, number: number) {
  updatePrWatch(root, scope, old => {
    const selected = { ...old.selected };
    if (selected[number]) delete selected[number];
    else selected[number] = Date.now();
    return { ...old, selected };
  });
}

export function PullRequestsView({ tab, remotesKey }: { tab: RepoTab; remotesKey: string }) {
  const all = useSettings(s => s.prAllRepositories);
  const watching = useSettings(s => !!s.prWatchMineSince);
  const loadingRemotes = !tab.refs && !tab.loaded;
  return <div className="pr-center-shell">
    <header className="pr-scope-bar">
      <select className="select" aria-label="Pull request scope" value={all ? "all" : "repository"} onChange={e => useSettings.getState().set({ prAllRepositories: e.target.value === "all" })}>
        <option value="repository">This repository</option><option value="all">All repositories</option>
      </select>
      <button type="button" className="btn sm" aria-label="Watch my PRs" aria-pressed={watching} title="Watch your open pull requests across the repository library" onClick={() => useSettings.setState(s => ({ prWatchMineSince: s.prWatchMineSince ? null : Date.now() }))}><Bell size={14}/>My PRs</button>
    </header>
    {all?<CombinedPullRequests root={tab.root}/>:!loadingRemotes&&tab.refs?.remotes.length!==0
      ?<ConnectedPullRequests key={JSON.stringify([tab.root, remotesKey])} root={tab.root}/>
      :<section className="pr-center pr-list-hidden" aria-label="Pull Request Center">
    <main className="pr-content">
      <header className="pr-center-head"><b>PR Center</b></header>
      {loadingRemotes ? <div className="pr-empty" role="status"><Loader2 size={22} className="spin" />Loading repository remotes…</div> :
        <div className="pr-empty">
          <GitPullRequest size={24} />
          <b>No remote configured</b>
          <p className="pr-local-description">Pull requests are hosted by Git services. Add the URL of a hosted repository to view or create pull requests here.</p>
          <button type="button" className="btn primary" onClick={() => void A.addRemote(tab.root)}>Add remote…</button>
        </div>}
    </main>
  </section>}
  </div>;
}

const rememberedPrSelection = new Map<string, number>();

function ConnectedPullRequests({ root }: { root: string }) {
  const [prefs, savePreferences] = usePrPreferences(root);
  const [forge, setForge] = useState<ForgeInfo | null>(null), [items, setItems] = useState<PullRequest[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [query, setQuery] = useState(""), [selected, setSelected] = useState<number | null>(null), [epoch, setEpoch] = useState(0);
  const generation = useRef(0), busy = useRef(false), preferred = useRef<number | null>(null);
  const [authors,setAuthors]=useState<{scope:string;known:PrAuthor[];viewer:PrAuthor|null;prefs:AuthorPreferences}>({scope:"",known:[],viewer:null,prefs:restoreAuthorPreferences(null)});
  const mine=authors.viewer??authors.prefs.mine;
  const watch = useSettings(s => s.prWatches[root]?.[authors.scope] ?? EMPTY_PR_WATCH);
  const watchMine = useSettings(s => !!s.prWatchMineSince);
  const firstPage = useRef<PullRequest[]>([]);
  const latestListRead = useRef(0);
  const authorSelection=authorSelectionValue(authors.prefs,mine);
  const selectedAuthor=authorSelection==="mine"?mine:authorSelection==="all"?null:authors.known.find(a=>a.key===authorSelection)??authors.prefs.chosen;
  const otherAuthors=authors.known.filter(author=>!samePrAuthor(author,mine));
  useEffect(()=>{if(!authors.scope)return;try{localStorage.setItem(authorPreferencesKey(root,authors.scope),JSON.stringify(authors.prefs));}catch{toast.warning("PR author filter could not be saved");}},[root,authors.scope,authors.prefs]);
  const clearAuthorSelection = () => {
    preferred.current = null;
    setSelected(null);
  };
  const setMyAuthor=async(selectMine:boolean)=>{
    if(!forge)return;
    const scope=authors.scope;
    const chosen=await showDialog<PrAuthor|null>(close=><MyPrAuthor authors={authors.known} initial={mine} close={close} bitbucket={forge.kind==="bitbucket"}/>);
    if(!chosen)return;
    rememberAccountAuthor(forge,chosen);
    setAuthors(a=>a.scope===scope?{...a,prefs:{...a.prefs,mine:chosen,selection:selectMine?"mine":a.prefs.selection}}:a);
    clearAuthorSelection();
  };
  const chooseAuthor=(key:string)=>{
    if(key==="mine"&&!mine){void setMyAuthor(true);return;}
    setAuthors(a=>({...a,prefs:{...a.prefs,selection:key,chosen:a.known.find(x=>x.key===key)??a.prefs.chosen}}));
    clearAuthorSelection();
  };
  const load = useCallback(async (next: string | null = null) => {
    if (next && busy.current) return;
    latestListRead.current = nextPrListRead();
    const id = next ? generation.current : ++generation.current;
    busy.current = true; setLoading(true); setError("");
    if (!next) { setItems([]); setCursor(null); setForge(null); setSelected(null); setEpoch(e => e + 1); }
    try {
      const page = await api.prPage(root, prefs.state, next);
      if (id !== generation.current) return;
      if (!next) firstPage.current = page.items;
      setForge(page.forge); setItems(old => next ? appendPullRequests(old, page.items) : page.items); setCursor(page.nextCursor);
      const scope=authorScope(page.forge,page.viewer);
      const saved=loadAuthorPreferences(root,scope,page.forge);
      setAuthors(old=>({scope,known:mergePrAuthors(old.scope===scope?old.known:[],page.items),viewer:viewerAuthor(page.viewer),prefs:old.scope===scope?old.prefs:saved}));
      if (!next) setSelected(preferred.current);
    } catch (e) { if (id === generation.current) setError(errorMessage(e)); }
    finally { if (id === generation.current) { busy.current = false; setLoading(false); } }
  }, [root, prefs.state]);
  useEffect(() => { void load(); const changed = () => { preferred.current = null; void load(); }; window.addEventListener("revqora:forge-accounts", changed); return () => { generation.current++; busy.current = false; window.removeEventListener("revqora:forge-accounts", changed); }; }, [load]);
  useEffect(() => {
    const update = (event: Event) => {
      const { root: refreshed, page, readId } = (event as CustomEvent<PrPageRefresh>).detail;
      if (root !== refreshed || prefs.state !== "open" || readId <= latestListRead.current || busy.current || !forge?.connectionRevision ||
          forge.connectionRevision !== page.forge.connectionRevision || authors.scope !== authorScope(page.forge, page.viewer)) return;
      latestListRead.current = readId;
      const previous = firstPage.current;
      if (JSON.stringify(previous) === JSON.stringify(page.items)) return;
      firstPage.current = page.items;
      const oldFirst = new Set(previous.map(row => row.number));
      const newFirst = new Set(page.items.map(row => row.number));
      const sameOrder = previous.length === page.items.length && previous.every((row, i) => row.number === page.items[i].number);
      setItems(old => {
        const rows = [...page.items, ...(page.nextCursor ? old.filter(row => !oldFirst.has(row.number) && !newFirst.has(row.number)) : [])];
        if (selected && !rows.some(row => row.number === selected)) {
          const index = old.findIndex(row => row.number === selected);
          if (index >= 0) rows.splice(index, 0, old[index]);
        }
        return rows;
      });
      if (!sameOrder || !page.nextCursor) setCursor(page.nextCursor);
      setAuthors(old => ({ ...old, known: mergePrAuthors(old.known, page.items) }));
    };
    window.addEventListener(PR_PAGE_REFRESHED, update);
    return () => window.removeEventListener(PR_PAGE_REFRESHED, update);
  }, [root, prefs.state, forge?.connectionRevision, authors.scope, selected]);
  const authored = useMemo(() => items.filter(p=>(authorSelection!=="mine"||!!mine)&&matchesPrAuthor(p,selectedAuthor)), [items,selectedAuthor,authorSelection,mine]);
  const visible = useMemo(()=>searchPullRequests(authored,query),[authored,query]);
  const selectionKey = forge ? JSON.stringify([root, forge.api, forge.project, forge.remote, forge.accountId, prefs.state]) : "";
  const selectRequest = (number: number) => {
    if (selectionKey) {
      rememberedPrSelection.set(selectionKey, number);
      const oldest = rememberedPrSelection.keys().next().value;
      if (rememberedPrSelection.size > 128 && oldest !== undefined) rememberedPrSelection.delete(oldest);
    }
    setSelected(number);
  };
  useEffect(() => {
    if (loading || selected !== null || !authored.length) return;
    const remembered = rememberedPrSelection.get(selectionKey);
    setSelected(authored.find(item => item.number === remembered)?.number ?? authored[0].number);
  }, [authored, selected, loading, selectionKey]);
  const direct = pullRequestNumber(query);
  const authorScan=useRef({key:"",pages:0});
  useEffect(()=>{const key=`${authors.scope}:${authors.prefs.selection}:${prefs.state}`;if(authorScan.current.key!==key)authorScan.current={key,pages:0};if(selectedAuthor&&!visible.length&&cursor&&!loading&&!error&&authorScan.current.pages<4){authorScan.current.pages++;void load(cursor);}},[authors.scope,authors.prefs.selection,prefs.state,selectedAuthor,visible.length,cursor,loading,error,load]);
  const refresh = useCallback(() => { preferred.current = selected ?? preferred.current; return load(); }, [selected, load]);
  useEffect(() => onPrRefresh(root, refresh), [root, refresh]);
  const created = async () => { const p = await createPullRequest(root, forge); if (p) { preferred.current = p.number; if (prefs.state !== "open") savePreferences({ state: "open" }); else void load(); } };
  const updated = useCallback((p: PullRequest) => {
    latestListRead.current = nextPrListRead();
    setItems(old => old.map(row => row.number === p.number ? p : row));
  }, []);
  return <PrCenterLayout label="Pull Request Center" prefs={prefs} save={savePreferences}
    title={forge ? `PR Center · ${forge.project}` : "PR Center"}
    subtitle={forge ? `${FORGE_NAMES[forge.kind]} · ${forge.remote} · ${forge.accountLogin ?? "Git credentials"}` : "Choose an API account and remote to browse requests"}
    count={items.length} actions={<><button className="btn sm" onClick={() => void forgeAccountsDialog(root)}>Accounts…</button>{!prefs.listOpen && <><button className="icon-btn" aria-label="Refresh pull requests" disabled={loading} onClick={refresh}><RefreshCw size={15} /></button><button className="btn sm primary" disabled={!forge?.connectionRevision || loading} onClick={() => void created()}>New PR</button></>}</>}
    list={<>
      <div className="pr-list-tools"><RequestStatus label="Request status" value={prefs.state} change={state => { preferred.current = null; savePreferences({ state }); }} /><button className="icon-btn" title="Refresh pull requests" aria-label="Refresh pull requests" disabled={loading} onClick={refresh}><RefreshCw size={15} className={loading ? "spin" : ""} /></button><button className="btn sm primary" disabled={!forge?.connectionRevision || loading} onClick={() => void created()}><GitPullRequestCreate size={14} />New</button></div>
      <div className="pr-search"><input className="input" aria-label="Search loaded pull requests" placeholder="Search PRs or enter #…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && direct && forge) selectRequest(direct); }} /></div>
      <div className="pr-author-filter"><select className="select" aria-label="Pull request author" title="Authors found in loaded pages. Load more requests to include older PRs." value={authorSelection} disabled={!forge} onChange={e=>chooseAuthor(e.target.value)}><option value="mine">My pull requests{mine?` — ${mine.login||mine.label}`:"…"}</option><option value="all">All authors</option>{otherAuthors.map(a=><option key={a.key} value={a.key}>{a.label}{a.login&&a.login!==a.label?` · ${a.login}`:""}</option>)}{authors.prefs.chosen&&!samePrAuthor(authors.prefs.chosen,mine)&&!otherAuthors.some(a=>a.key===authors.prefs.chosen!.key)&&<option value={authors.prefs.chosen.key}>{authors.prefs.chosen.label}</option>}</select>{forge&&!authors.viewer&&<button type="button" className="icon-btn" aria-label="Set my PR author" title="Set my PR author without profile permissions" onClick={()=>void setMyAuthor(false)}><Pencil size={14}/></button>}</div>
      {direct && forge && <button className="btn sm pr-direct" onClick={() => selectRequest(direct)}>Open #{direct}</button>}
      {error && <div className="callout warn" role="alert">{error}<button type="button" className="btn sm" onClick={()=>void forgeAccountsDialog(root)}>Connection settings…</button><button type="button" className="btn sm" onClick={refresh}>Try again</button></div>}
      <RequestRows rows={visible.map(pull => ({ id: pull.number, pull, watched: !!watch.selected[pull.number] }))} selected={selected} select={selectRequest} resetKey={`${query}:${prefs.state}:${authors.prefs.selection}`} />
      {!visible.length && !loading && !error && <p className="pr-list-empty">No matching requests in the loaded pages.{cursor ? " Load more or open a request by number." : ""}</p>}
      <footer className="pr-list-footer">{loading ? <span className="loading-status" role="status"><Loader2 size={13} className="spin" /> Loading requests…</span> : cursor ? <button className="btn sm" onClick={() => void load(cursor)}>Load more requests</button> : <span className="faint">{items.length} loaded</span>}</footer>
    </>}>
      {!prefs.listOpen && error && <div className="callout warn" role="alert">{error}<button type="button" className="btn sm" onClick={()=>void forgeAccountsDialog(root)}>Connection settings…</button></div>}
      {forge?.connectionRevision && selected ? <RequestDetail key={`${forge.connectionRevision}:${selected}:${epoch}`} root={root} forge={forge} number={selected} prefs={prefs} savePreferences={savePreferences} updated={updated} reloadConnection={refresh} watched={!!watch.selected[selected]} watchOwn={watchMine && !!mine} mine={mine} toggleWatch={() => togglePrWatch(root, authors.scope, selected)} /> : <div className="pr-empty">{loading ? <><Loader2 size={22} className="spin" />Loading pull requests…</> : error ? "Configure the API connection or refresh to continue." : "Select a pull request or open one by number."}</div>}
  </PrCenterLayout>;
}

function MyPrAuthor({authors,initial,close,bitbucket}:{authors:PrAuthor[];initial?:PrAuthor|null;close:(author:PrAuthor|null)=>void;bitbucket:boolean}){
  const [key,setKey]=useState(initial?.key??""),[login,setLogin]=useState(initial?.login??"");const found=authors.find(a=>a.key===key);const typed=login.trim();const valid=!!found||!!typed&&typed.length<=256&&!/[\u0000-\u001f\u007f]/.test(typed);
  return <Modal title="Your PR author" onClose={()=>close(null)} onSubmit={()=>{if(valid)close(found??{key:`login:${typed.toLowerCase()}`,label:typed,login:typed});}} footer={<><button type="button" className="btn" onClick={()=>close(null)}>Cancel</button><button type="submit" className="btn primary" disabled={!valid}>Use as my author</button></>}><p>Profile access is optional. Choose yourself from the discovered authors or enter your hosting username once.</p><label className="field">Found authors<select className="select" aria-label="My PR author" value={key} onChange={e=>setKey(e.target.value)}><option value="">Enter a username instead…</option>{authors.map(a=><option key={a.key} value={a.key}>{a.label}{a.login?` · ${a.login}`:""}</option>)}</select></label><label className="field">{bitbucket?"Bitbucket nickname (not Atlassian email)":"Hosting username"}<input className="input" aria-label="My PR username" disabled={!!found} value={login} onChange={e=>setLogin(e.target.value)}/></label></Modal>;
}

const ALL_PR_PREFERENCES = "@all-repositories";

function CombinedPullRequests({ root }: { root: string }) {
  const [prefs, savePreferences] = usePrPreferences(ALL_PR_PREFERENCES);
  const [mine, setMine] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { groups, finished, refresh, update } = useAllPullRequests(prefs.state, mine);
  const names = useLibrary(s => s.repositoryNames);
  const watches = useSettings(s => s.prWatches);
  const watchMine = useSettings(s => !!s.prWatchMineSince);

  const rows = useMemo(() => Object.entries(groups).flatMap(([root, { forge, scope, author, items }]) => {
    if (!forge) return [];
    const key = repositoryKey(root);
    const repository = { root, name: names[key] ?? basename(root), project: forge.project };
    const identity = forgeRepositoryIdentity(forge);
    return searchPullRequests(items, query).map(pull => ({
      id: JSON.stringify([key, identity, pull.number]), pull, repository, forge, scope, author,
      created: Date.parse(pull.created) || 0,
    }));
  }).sort((a, b) => b.created - a.created || a.id.localeCompare(b.id)), [groups, names, query]);
  const selected = rows.find(row => row.id === selectedId) ?? (!query.trim() && (selectedId === null || finished) ? rows[0] : undefined);
  const selectedRoot = selected?.repository.root;
  const selectedConnection = selected?.forge.connectionRevision;
  const updated = useCallback((pull: PullRequest) => {
    if (selectedRoot && selectedConnection) update(selectedRoot, selectedConnection, pull);
  }, [selectedRoot, selectedConnection, update]);
  useEffect(() => onPrRefresh(root, refresh), [root, refresh]);
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const issues = Object.entries(groups).filter(([, group]) => group.notice);
  const forge = selected?.forge ?? groups[root]?.forge;
  const actionRoot = selectedRoot ?? root;
  const refreshButton = <button type="button" className="icon-btn" title="Refresh all pull requests" aria-label="Refresh all pull requests" disabled={!finished} onClick={refresh}><RefreshCw size={15} className={finished ? "" : "spin"} /></button>;
  const createButton = (compact: boolean) => <button type="button" className="btn sm primary" disabled={!forge?.connectionRevision} title={forge ? `New pull request in ${forge.project}` : undefined} onClick={async () => {
    if (await createPullRequest(actionRoot, forge ?? null)) {
      savePreferences({ state: "open" });
      void refresh();
    }
  }}><GitPullRequestCreate size={14} />{compact ? "New" : "New PR"}</button>;

  return <PrCenterLayout label="Pull requests across repositories" prefs={prefs} save={savePreferences}
    title={selected ? `PR Center · ${selected.repository.project}` : "PR Center"}
    subtitle={selected ? `${FORGE_NAMES[selected.forge.kind]} · ${selected.forge.remote} · ${selected.forge.accountLogin ?? "Git credentials"}` : "All repositories"}
    count={rows.length}
    actions={<><button className="btn sm" onClick={() => void forgeAccountsDialog(actionRoot)}>Accounts…</button>{!prefs.listOpen && <>{refreshButton}{createButton(false)}</>}</>}
    list={<>
      <div className="pr-list-tools">
        <RequestStatus label="Request status across repositories" value={prefs.state} change={state => { setSelectedId(null); savePreferences({ state }); }} />
        {refreshButton}{createButton(true)}
      </div>
      <div className="pr-search"><input className="input" aria-label="Search pull requests across repositories" placeholder="Search PRs…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && rows[0]) setSelectedId(rows[0].id); }} /></div>
      <div className="pr-author-filter"><select className="select" aria-label="Authors across repositories" value={mine ? "mine" : "all"} onChange={e => { setMine(e.target.value === "mine"); setSelectedId(null); }}>
        <option value="mine">My pull requests</option><option value="all">All authors</option>
      </select></div>
      {issues.length > 0 && <details className="pr-scan-issues">
        <summary>{issues.length} {issues.length === 1 ? "repository needs" : "repositories need"} attention</summary>
        <ul>{issues.map(([path, group]) => <li key={path}><b>{names[repositoryKey(path)] ?? basename(path)}</b> {group.notice}</li>)}</ul>
      </details>}
      <RequestRows rows={rows.map(row => ({ ...row, watched: !!watches[row.repository.root]?.[row.scope]?.selected[row.pull.number] }))}
        selected={selected?.id ?? null} select={setSelectedId} resetKey={JSON.stringify([query, prefs.state, mine])} showRepository />
      {!finished && <div className="pr-list-empty loading-status" role="status"><Loader2 size={14} className="spin" />Looking for pull requests…</div>}
    </>}
  >
    {selected && selectedConnection ? <RequestDetail key={JSON.stringify([selected.id, selectedConnection])}
      root={selected.repository.root} forge={selected.forge} number={selected.pull.number} prefs={prefs} savePreferences={savePreferences}
      updated={updated} reloadConnection={refresh} watched={!!watches[selected.repository.root]?.[selected.scope]?.selected[selected.pull.number]}
      watchOwn={watchMine} mine={selected.author} toggleWatch={() => togglePrWatch(selected.repository.root, selected.scope, selected.pull.number)} />
      : <div className="pr-empty">{finished && !rows.length ? "No matching pull requests." : "Select a pull request."}</div>}
  </PrCenterLayout>;
}

type RequestListRow<Key> = {
  id: Key;
  pull: PullRequest;
  watched?: boolean;
  repository?: { root: string; name: string; project: string };
};

function RequestRows<Key extends string | number>({ rows, selected, select, resetKey, showRepository }: {
  rows: RequestListRow<Key>[]; selected: Key | null; select: (id: Key) => void; resetKey: string; showRepository?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null), [top, setTop] = useState(0), [height, setHeight] = useState(500);
  const fontSize = useSettings(s => s.uiFontSize);
  const rowHeight = Math.ceil((showRepository ? 126 : 102) + Math.max(0, fontSize - 13) * (showRepository ? 7 : 6));
  useEffect(() => { const el = ref.current; if (!el) return; const observer = new ResizeObserver(() => setHeight(el.clientHeight)); observer.observe(el); return () => observer.disconnect(); }, []);
  useEffect(() => { if (ref.current) ref.current.scrollTop = 0; setTop(0); }, [resetKey]);
  const { start: first, end: last } = virtualRange(rows.length, rowHeight, height, top);
  const move = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || !rows.length) return;
    e.preventDefault();
    const old = rows.findIndex(row => row.id === selected);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, old + (e.key === "ArrowDown" ? 1 : -1)));
    select(rows[next].id);
    if (ref.current) ref.current.scrollTop = Math.max(0, next * rowHeight - height / 2);
  };
  return <div className="pr-request-rows" ref={ref} style={{ "--pr-row-height": `${rowHeight}px` } as CSSProperties} role="listbox" aria-label="Pull requests" tabIndex={0} onKeyDown={move} onScroll={e => setTop(e.currentTarget.scrollTop)}>
    <div style={{ height: first * rowHeight }} />
    {rows.slice(first, last).map(({ id, pull: p, repository, watched }) => <button type="button" role="option" aria-selected={selected === id} data-pr-number={p.number} key={id}
      className={`pr-request-row ${selected === id ? "selected" : ""}`} onClick={() => select(id)} onContextMenu={e => contextMenu(e, prUrlMenu(p))}>
      <span className="pr-row-title"><span className="mono faint">#{p.number}</span><b title={p.title}>{p.title}</b></span>
      {repository && <span className="pr-row-repository ellipsis" title={`${repository.project}\n${repository.root}`}>{repository.name}</span>}
      <span className="pr-row-meta">{watched && <span title="Watched PR" aria-label="Watched PR"><Bell size={12} /></span>}<span className={`pill pr-state-${p.state}`}>{p.draft && p.state === "open" ? "Draft" : p.state}</span><span className="ellipsis">{p.author}</span><span className="faint">{relativeTime(Date.parse(p.created) / 1000)}</span></span>
      <small className="ellipsis" title={`${p.head} → ${p.base}`}>{p.head} → {p.base}</small>
    </button>)}
    <div style={{ height: Math.max(0, rows.length - last) * rowHeight }} />
  </div>;
}

const REVIEW_STATES = [
  { state: "approved", label: "Approved", tone: "green" },
  { state: "changes_requested", label: "Changes requested", tone: "amber" },
] as const;

function BitbucketReviewSummary({ detail }: { detail: PrDetail }) {
  const decisions = detail.reviewDecisions;
  if (!decisions?.length) {
    return detail.pull.state === "open" ? <span className="pill">{decisions ? "Awaiting review" : "Review status unavailable"}</span> : null;
  }
  return <span className="pr-review-summary" aria-label="Review decisions">{REVIEW_STATES.map(({ state, label, tone }) => {
    const reviewers = decisions.filter((decision) => decision.state === state).map((decision) => decision.reviewer);
    return reviewers.length > 0 && <span key={state} className={`pill ${tone}`} title={reviewers.join(", ")}>{label} · {reviewers.length}</span>;
  })}</span>;
}

function BitbucketOverview({ root, connection, detail }: { root: string; connection: string; detail: PrDetail }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function loadChecks() {
    setLoading(true);
    setError("");
    try { setChecks(await api.prChecks(root, detail.pull.number, connection, detail.revision)); }
    catch (cause) { setChecks(null); setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }
  return <>
    {detail.reviewDecisions && detail.reviewDecisions.length > 0 && <section className="pr-merge-panel" aria-label="Reviewers">
      <header><b>Reviewers</b></header>
      <div className="pr-merge-checks">{detail.reviewDecisions.map(({ reviewer, state }, index) => {
        const decision = REVIEW_STATES.find((item) => item.state === state);
        return <div key={index}><span className={`pill ${decision?.tone ?? ""}`}>{decision?.label}</span><span>{reviewer}</span></div>;
      })}</div>
    </section>}
    <section className="pr-merge-panel" aria-label="Bitbucket CI checks">
      <header><b>CI checks</b><div className="spacer" />
        {detail.pull.headSha && <button type="button" className="btn sm" disabled={loading} onClick={() => void loadChecks()}>{checks ? "Refresh checks" : "Load checks"}</button>}
      </header>
      {loading && <p className="loading-status" role="status"><Loader2 size={14} className="spin" />Loading CI checks…</p>}
      {error && <div className="callout warn" role="alert">{error}</div>}
      {checks && <ChecksList checks={checks} />}
      {detail.pull.state === "open" && <p className="faint">Use Merge on Bitbucket to review the latest commit and apply the server’s merge rules.</p>}
    </section>
  </>;
}

function PrDescription({ detail, height, save }: { detail: PrDetail; height: number | null; save: (height: number | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(height);
  return <>
    <div className="hstack">
      <b>Description</b><div className="spacer"/>
      {draft !== null && <button type="button" className="btn sm" onClick={() => { setDraft(null); save(null); }}>Reset height</button>}
      <button type="button" className="btn sm" onClick={() => void showDialog<void>(close => <Modal sizeKey="PR description" title={`#${detail.pull.number} · ${detail.pull.title}`} wide onClose={() => close()} footer={<button type="button" className="btn" onClick={() => close()}>Close</button>}><div className="pr-description-expanded">{detail.body || "No description."}</div></Modal>)}><Maximize2 size={13}/>Expand description</button>
    </div>
    <div className="pr-description-frame">
      <div ref={ref} className="pr-description" style={{ height: draft ?? undefined }}>{detail.body || <span className="faint">No description.</span>}</div>
      <Splitter dir="h" label="Resize PR description" onDrag={delta => {
        const el = ref.current;
        if (!el) return;
        const max = Math.min(1600, (el.ownerDocument.defaultView?.innerHeight ?? 900) * 0.7);
        setDraft(value => Math.max(72, Math.min(max, (value ?? el.offsetHeight) + delta)));
      }} onEnd={() => save(draft)}/>
    </div>
  </>;
}

function RequestDetail({ root, forge, number, prefs, savePreferences, updated, reloadConnection, watched, watchOwn, mine, toggleWatch }: { watched: boolean; watchOwn: boolean; mine: PrAuthor | null; toggleWatch: () => void; root: string; forge: ForgeInfo; number: number; prefs: PrPreferences; savePreferences: (p: Partial<PrPreferences>) => void; updated: (p: PullRequest) => void; reloadConnection: () => Promise<void> }) {
  const connection = forge.connectionRevision!;
  const [detail, setDetail] = useState<PrDetail | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);

  const [refreshing,setRefreshing]=useState(false), [reviewEpoch,setReviewEpoch]=useState(0);
  const generation = useRef(0), editing = useRef(false);
  const load = useCallback(async (quiet = false) => { const id = ++generation.current; setRefreshing(quiet); if(!quiet) { setLoading(true); setDetail(null); } setError(""); try { const d = await api.prDetail(root, number, connection); if (id === generation.current) { setDetail(d); updated(d.pull); if(quiet) setReviewEpoch(e=>e+1); } } catch (e) { if (id === generation.current) { setError(errorMessage(e)); if(quiet) toast.warning("Sent, but PR refresh failed",errorMessage(e)); } } finally { if (id === generation.current) {setLoading(false);setRefreshing(false);} } }, [root, number, connection, updated]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const edit = async () => { if (!detail || editing.current) return; editing.current = true; const current = generation.current; try { const result = await showDialog<PrEditResult | null>(close => <RequestEditor root={root} forge={forge} initial={detail} close={close} />); if (result && generation.current === current) { setDetail(result.detail); updated(result.detail.pull); } } finally { editing.current = false; } };
  if (loading) return <div className="pr-empty" role="status"><Loader2 size={22} className="spin" />Loading #{number}…</div>;
  if (!detail) return <div className="pr-empty"><div className="callout warn" role="alert">{error || "Pull request unavailable."}</div><button className="btn" onClick={() => void load()}>Reload request</button></div>;
  const p = detail.pull;
  const bitbucket = forge.kind === "bitbucket";
  const coveredByMine = watchOwn && !!mine && matchesPrAuthor(p, mine);
  return <div className="pr-detail" inert={refreshing} aria-busy={refreshing} data-pr-detail={p.number} data-pr-revision={detail.revision}>
    <header className="pr-detail-heading">
      <div className="pr-title-line" onContextMenu={e => contextMenu(e, prUrlMenu(p))}><span className="mono faint">#{p.number}</span><span className={`pill pr-state-${p.state}`}>{detail.declined ? "Declined" : p.draft && p.state === "open" ? "Draft" : p.state}</span><h2 title={p.title}>{p.title}</h2><button type="button" className="btn sm pr-watch-toggle" aria-label="Watch PR" aria-pressed={watched} title={watched ? "Stop watching this PR individually" : coveredByMine ? "Already watched by My PRs. Watch this PR independently as well." : "Watch this PR for reviews and comments"} onClick={toggleWatch}><Bell size={15} /></button></div>
      <div className="pr-branch-line"><span className="ref local">{p.head}</span><span className="faint">→</span><span className="ref">{p.base}</span><span className="faint">by {p.author}</span>{bitbucket && <BitbucketReviewSummary detail={detail} />}</div>
      <div className="pr-detail-actions"><div className="seg"><button className={prefs.section === "overview" ? "on" : ""} onClick={() => savePreferences({ section: "overview" })}>Overview</button><button className={prefs.section === "files" ? "on" : ""} onClick={() => savePreferences({ section: "files" })}><FileDiff size={13} />Files{detail.fileCount !== null ? ` (${detail.fileCount})` : ""}</button><button className={prefs.section === "discussions" ? "on" : ""} onClick={()=>savePreferences({section:"discussions"})}>Discussions</button></div><div className="spacer" /><button type="button" className="btn sm" onClick={()=>openOverlay({kind:"workflows",root,pull:{number:p.number,head:p.head,base:p.base,remote:forge.remote}})}>PR workflow…</button><button className="btn sm" onClick={() => void chooseReview({root,forge,detail},()=>void load(true))}>Review…</button>{p.state === "open" ? (bitbucket ? <button type="button" className="btn sm" onClick={() => browser(p.url)}><ExternalLink size={13} />Merge on Bitbucket</button> : <button className="btn sm primary" onClick={()=>void mergeDialog({root,forge,detail,updated:()=>void load(true)})}>Merge…</button>):p.state==="merged"?<button className="btn sm" onClick={()=>void cleanupDialog({root,forge,detail,updated:()=>void load(true)})}>Source cleanup…</button>:null}<button className="btn sm" onClick={() => void edit()}><Pencil size={13} />Edit PR</button><button className="btn sm" disabled={!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(p.headSha)} onClick={() => void A.act(root, () => api.pullRequestCheckout(root, p.number, connection, p.headSha), { success: b => `Checked out ${b}`, busy: `Fetching #${p.number}` })}><Download size={13} />Check out</button><button className="icon-btn" title="Open pull request in browser" aria-label="Open pull request in browser" onClick={() => browser(p.url)}><ExternalLink size={15} /></button><button className="icon-btn" title="Reload request" aria-label="Reload request" onClick={() => void load()}><RefreshCw size={15} /></button></div>
      <small className="pr-snapshot mono" title={`Target ${detail.baseSha} · source ${p.headSha}`}>Source {shortOid(p.headSha) || "unavailable"} · target {shortOid(detail.baseSha)} · refresh to load newer changes</small>
    </header>
    {prefs.section === "discussions" ? <PrReviews root={root} forge={forge} detail={detail} refreshToken={reviewEpoch} onReloadRequest={reloadConnection} onSent={()=>void load(true)}/> : prefs.section === "files" ? <RequestFiles root={root} forge={forge} detail={detail} prefs={prefs} savePreferences={savePreferences} onSent={()=>void load(true)}/> : <div className="pr-overview"><PrDescription detail={detail} height={prefs.descriptionHeight} save={descriptionHeight => savePreferences({ descriptionHeight })}/>{bitbucket ? <BitbucketOverview key={`${connection}:${detail.revision}`} root={root} connection={connection} detail={detail} /> : <PrMergePanel root={root} forge={forge} detail={detail} refreshToken={reviewEpoch} updated={()=>void load(true)}/>}</div>}
  </div>;
}

function RequestFiles({ root, forge, detail, prefs, savePreferences, onSent }: { root: string; forge: ForgeInfo; detail: PrDetail; prefs: PrPreferences; savePreferences: (p: Partial<PrPreferences>) => void; onSent:()=>void }) {
  const fileNavigation = useFileListNavigation();
  const [files, setFiles] = useState<PrFile[]>([]), [next, setNext] = useState<number | null>(null), [selected, setSelected] = useState<string | null>(null), [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState<string | null>(null), [view, setView] = useState<PrFileView | null>(null), [fileError, setFileError] = useState(""), [fileLoading, setFileLoading] = useState(false), [width, setWidth] = useState(prefs.filesWidth);
  const remembered = useRef<string | null>(null);
  const pages = useRef(0), requests = useRef(0), busy = useRef(false), connection = forge.connectionRevision!, n = detail.pull.number;
  const load = useCallback(async (offset = 0) => { if (offset && busy.current) return; const id = offset ? pages.current : ++pages.current; busy.current = true; setLoading(true); setError(""); if (!offset) { setFiles([]); setSelected(null); setNext(null); setView(null); } try { const p = await api.prFiles(root, n, connection, detail.revision, offset); if (id !== pages.current) return; setFiles(old => offset ? [...new Map([...old, ...p.items].map(f => [f.id, f])).values()] : p.items); setNotice(p.notice); setNext(p.nextOffset); if (!offset) setSelected(p.items.find(f=>f.path===remembered.current)?.id ?? p.items[0]?.id ?? null); } catch (e) { if (id === pages.current) setError(errorMessage(e)); } finally { if (id === pages.current) { busy.current = false; setLoading(false); } } }, [root, n, connection, detail.revision]);
  useEffect(() => { void load(); return () => { pages.current++; requests.current++; busy.current = false; }; }, [load]);
  useEffect(() => { const id = ++requests.current; setView(null); setFileError(""); if (!selected) { setFileLoading(false); return; } setFileLoading(true); api.prFile(root, n, connection, detail.revision, selected).then(v => { if (id === requests.current) setView(v); }, e => { if (id === requests.current) setFileError(errorMessage(e)); }).finally(() => { if (id === requests.current) setFileLoading(false); }); return () => { requests.current++; }; }, [root, n, connection, detail.revision, selected]);
  const visible = files.filter(f => `${f.path} ${f.oldPath ?? ""}`.toLowerCase().includes(query.toLowerCase())), file = files.find(f => f.id === selected);
  return <section className={`pr-files ${prefs.filesOpen ? "" : "pr-files-hidden"}`} aria-label="Pull request files" style={{ "--pr-files-width": `${width}px` } as CSSProperties}>
    {prefs.filesOpen && <aside className="pr-file-panel"><div className="pr-list-heading"><b>{files.length} files loaded</b><div className="spacer" /><button className="icon-btn" aria-label="Hide PR files" title="Hide PR files" onClick={() => savePreferences({ filesOpen: false })}><ChevronLeft size={15} /></button></div><input className="input pr-file-search" aria-label="Search loaded PR files" placeholder="Find a changed file…" value={query} onChange={e => setQuery(e.target.value)} /><div className="pr-file-rows" {...fileNavigation} aria-label="PR changed files">{visible.map(f => <button className={`pr-file-row ${f.id === selected ? "selected" : ""}`} key={f.id} data-file-nav="" data-pr-file={f.path} onClick={() => { remembered.current=f.path;setSelected(f.id); }}><span className={`file-status status-${f.status}`}>{f.status}</span><span className="pr-file-name" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>{f.path}{f.oldPath && <small>from {f.oldPath}</small>}</span>{f.binary ? <small>binary</small> : f.additions !== null && <small className="pr-stats"><span>+{f.additions}</span><span>−{f.deletions}</span></small>}</button>)}{loading && <p className="loading-status" role="status"><Loader2 size={14} className="spin" /> Loading files…</p>}{!loading && !visible.length && !error && <p className="faint">No matching files.</p>}</div>{next !== null && <button className="btn sm" disabled={loading} onClick={() => void load(next)}>Load more files</button>}<button className="btn sm" disabled={loading} onClick={() => void load()}>Reload PR files</button></aside>}
    {prefs.filesOpen && <Splitter dir="v" style={{ left: "clamp(160px, var(--pr-files-width), 35%)" }} onDrag={d => setWidth(w => Math.max(160, Math.min(480, w + d)))} onEnd={() => savePreferences({ filesWidth: width })} />}
    <div className="pr-diff">{notice && <div className="pr-notice" role="status"><b>Preview limitation</b>{notice}</div>}{error && <div className="callout warn" role="alert">{error}{forge.kind === "bitbucket" && <button type="button" className="btn sm" onClick={() => browser(detail.pull.url)}><ExternalLink size={13} />Open in Bitbucket</button>}</div>}{view?.notice && view.notice !== notice && <div className="callout warn" role="alert">{view.notice}</div>}<DiffView key={selected ?? "empty"} path={file?.path ?? ""} diff={view?.diff ?? null} loading={fileLoading || loading && !files.length} error={fileError || null} mode="readonly" sourceOptions={false} onComment={file && view?.diff && !view.diff.binary ? (side,line)=>void composeReview({root,forge,detail},"comment",onSent,{anchor:{fileId:file.id,side,line},path:file.path}) : undefined} emptyText={view?.notice ? "A complete text diff is unavailable for this file." : "Select a changed file to review its diff."} badge={<span className="pill">PR snapshot</span>} actions={<button className="btn sm" onClick={() => savePreferences({ filesOpen: !prefs.filesOpen })}><FileDiff size={13} />{prefs.filesOpen ? "Hide files" : "Show files"}</button>} /></div>
  </section>;
}

export async function createPullRequest(root: string, forge: ForgeInfo | null, seed?: {head:string;base:string}): Promise<PullRequest | null> {
  try {
    const f = forge ?? await api.forgeInfo(root); if (!f?.connectionRevision) { toast.warning("Configure an API connection first"); return null; }
    const message = await api.lastMessage(root).catch(() => ""), tab = getTab(root);
    return showDialog<PullRequest | null>(close => <RequestEditor root={root} forge={f} seed={{ base:seed?.base, head: seed?.head ?? tab?.info?.head.branch ?? "", title: message.split("\n")[0] ?? "", body: message.split("\n").slice(1).join("\n").trim() }} close={close} />);
  } catch (e) { toast.error(e, "Could not prepare a pull request"); return null; }
}

type EditorProps = { root: string; forge: ForgeInfo } & ({ initial: PrDetail; seed?: never; close: (v: PrEditResult | null) => void } | { initial?: never; seed: { head: string; title: string; body: string; base?:string }; close: (v: PullRequest | null) => void });
function RequestEditor(props: EditorProps) {
  const { root, forge, initial, seed } = props, connection = forge.connectionRevision!;
  const branches = getTab(root)?.refs?.remote.filter(b => b.remote === forge.remote).map(b => b.name.slice(forge.remote.length + 1)) ?? [];
  const defaultBase = initial?.pull.base ?? seed?.base ?? ["main", "master", "develop"].find(b => branches.includes(b) && b !== seed?.head) ?? branches.find(b => b !== seed?.head) ?? "main";
  const [snapshot, setSnapshot] = useState(initial ?? null), [title, setTitle] = useState(initial?.pull.title ?? seed?.title ?? ""), [body, setBody] = useState(initial?.body ?? seed?.body ?? ""), [base, setBase] = useState(defaultBase), [head, setHead] = useState(seed?.head ?? initial?.pull.head ?? "");
  const attemptKey = prWriteAttemptKey(forge, initial?.pull.number ?? null);
  const [draft, setDraft] = useState(false), [templates, setTemplates] = useState<PrTemplates>({ items: [], notice: null }), [template, setTemplate] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [uncertain, setUncertain] = useState(() => prWriteAttemptPending(attemptKey, root)), [checked, setChecked] = useState(false);
  const active = useRef(false), saved = useRef<PrEditResult | null>(null), listId = useId();
  const byteLength = utf8Length(body), valid = !!title.trim() && Array.from(title).length <= 256 && byteLength <= 65536 && !!base.trim() && !!head.trim();
  const dirty = title !== (snapshot?.pull.title ?? seed?.title ?? "") || body !== (snapshot?.body ?? seed?.body ?? "") || base !== (snapshot?.pull.base ?? defaultBase) || !initial && (head !== seed?.head || draft);
  useEffect(() => { let alive = true; api.prTemplates(root, connection).then(t => { if (alive) setTemplates(t); }, e => { if (alive) setTemplates({ items: [], notice: errorMessage(e) }); }); return () => { alive = false; }; }, [root, connection]);
  const finish = (r: PrEditResult | PullRequest | null) => { if (props.initial) props.close(r as PrEditResult | null); else props.close(r as PullRequest | null); };
  const dismiss = async () => { if (active.current) return; if (dirty && !await confirmDialog({ title: "Discard unsaved PR edits?", message: "The title, description and branch edits in this window will be discarded.", confirm: "Discard edits", danger: true })) return; finish(saved.current); };
  const applyTemplate = async () => { const t = templates.items.find(t => t.path === template); if (!t || active.current) return; if (body && !await confirmDialog({ title: "Replace the description?", message: "The selected template will replace the current description. Copy the current text first if you want to keep it.", confirm: "Replace description" })) return; setBody(t.body); };
  const reload = async () => { if (!snapshot || active.current) return; if (dirty && !await confirmDialog({ title: "Reload the server version?", message: "This replaces your current edits with the latest title, description and target branch from the server.", confirm: "Reload server version" })) return; active.current = true; setBusy(true); try { const d = await api.prDetail(root, snapshot.pull.number, connection); setSnapshot(d); setTitle(d.pull.title); setBody(d.body); setBase(d.pull.base); setHead(d.pull.head); setError(""); setNotice(""); setChecked(false); } catch (e) { setError(errorMessage(e)); } finally { active.current = false; setBusy(false); } };
  const markChecked = () => { if (active.current || !checked) return; try { setPrWriteAttemptPending(attemptKey, false, root); setUncertain(false); setChecked(false); setError(""); } catch (e) { setError(errorMessage(e)); } };
  const submit = async () => {
    if (active.current || !valid) return;
    const wasPending = prWriteAttemptPending(attemptKey, root);
    if ((uncertain || wasPending) && !checked) { setUncertain(true); return; }
    active.current = true; setBusy(true); setError(""); setNotice("");
    // Save before IPC; a lost response or remounted editor must require an
    // explicit server-result check, including when local storage is unavailable.
    try { setPrWriteAttemptPending(attemptKey, true, root); } catch (e) { setError(errorMessage(e)); active.current = false; setBusy(false); return; }
    const clearAttempt = () => { try { setPrWriteAttemptPending(attemptKey, false, root); setUncertain(false); setChecked(false); } catch (e) { toast.warning("Saved, but the local PR result marker could not be cleared", errorMessage(e)); setUncertain(true); setChecked(false); } };
    try {
      if (snapshot) { const r = await api.prEdit(root, snapshot.pull.number, connection, snapshot.revision, { title: title.trim(), body, base: base.trim() }); clearAttempt(); saved.current = r; setSnapshot(r.detail); if (r.notice) { setNotice(r.notice); return; } toast.success(`Updated #${r.detail.pull.number}`); finish(r); }
      else { const p = await api.prCreate(root, title.trim(), body, head.trim(), base.trim(), draft, connection); clearAttempt(); toast.success(`Opened #${p.number}`, p.url); finish(p); }
    } catch (e) { setError(errorMessage(e)); let pending = wasPending || !isGitError(e) || e.kind === "forge-write-uncertain"; if (!pending) { try { setPrWriteAttemptPending(attemptKey, false, root); } catch { pending = true; } } setUncertain(pending); setChecked(false); }
    finally { active.current = false; setBusy(false); }
  };
  return <Modal title={initial ? `Edit #${initial.pull.number}` : "New pull request"} subtitle={`${forge.host}/${forge.project} · ${forge.accountLogin ?? "Git credentials"}`} icon={initial ? <Pencil size={18} /> : <GitPullRequestCreate size={18} />} wide onClose={() => void dismiss()} onSubmit={() => void submit()} footer={<><button type="button" className="btn" disabled={busy} onClick={() => void dismiss()}>Cancel</button><button type="submit" className="btn primary" disabled={busy || !valid || uncertain && !checked}>{busy && <Loader2 size={14} className="spin" />}{initial ? "Save pull request" : "Create pull request"}</button></>}>
    <fieldset className="pr-editor" disabled={busy} data-pr-editor={initial ? "edit" : "create"}>
      <label className="field">Title<input className="input" aria-label="PR title" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <div className="pr-editor-branches"><label className="field">Source branch<input className="input mono" aria-label="PR source branch" list={listId} disabled={!!initial} value={head} onChange={e => setHead(e.target.value)} /></label><ChevronRight size={16} /><label className="field">Target branch<input className="input mono" aria-label="PR target branch" list={listId} disabled={!!snapshot && snapshot.pull.state !== "open"} value={base} onChange={e => setBase(e.target.value)} /></label><datalist id={listId}>{branches.map(b => <option value={b} key={b} />)}</datalist></div>
      {!initial && <small className="faint">Use a source branch already published on this server.{forge.kind === "github" ? " A fork can use owner:branch." : ""} Publish local commits with Push before creating the request.</small>}
      <div className="pr-template-row"><select className="select" aria-label="Pull request template" value={template} onChange={e => setTemplate(e.target.value)}><option value="">Templates from the current commit…</option>{templates.items.map(t => <option key={t.path} value={t.path}>{t.path}</option>)}</select><button className="btn sm" type="button" disabled={!template} onClick={() => void applyTemplate()}>Use template</button></div>{templates.notice && <small className="pr-notice">{templates.notice}</small>}
      <label className="field">Description<textarea className="textarea" aria-label="PR description" rows={12} value={body} onChange={e => setBody(e.target.value)} /></label><div className="hstack"><small className={byteLength > 65536 ? "wm-error" : "faint"}>{byteLength.toLocaleString()} / 65,536 bytes · {Array.from(title).length} / 256 title characters</small><div className="spacer" /><button className="btn sm" type="button" onClick={() => void copyText(body, "Description copied")}>Copy description</button></div>
      {!initial && <label className="check"><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} />Open as draft</label>}
      {error && <div className="callout warn" role="alert">{error}</div>}{notice && <div className="callout warn" role="alert">{notice} Server target: {snapshot?.pull.base}.</div>}
      {initial && <button className="btn sm" type="button" onClick={() => void reload()}>Reload server version</button>}
      {uncertain && <div className="pr-notice"><p>A previous request may already have been saved. Check its result before sending again.</p><button className="btn sm" type="button" onClick={() => browser(snapshot?.pull.url ?? forge.webUrl)}>Check on server</button><label className="check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />I checked the server result</label><button className="btn sm" type="button" disabled={!checked} onClick={markChecked}>Mark PR result as checked without resending</button></div>}
    </fieldset>
  </Modal>;
}
