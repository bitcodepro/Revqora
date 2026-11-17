import {PrMergePanel,mergeDialog,cleanupDialog,useMergePlan} from "./PrMerge";
import {PrReviews,composeReview} from "./PrReviews";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useFileListNavigation } from "../lib/useFileListNavigation";
import { AlertTriangle, Bell, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, Download, ExternalLink, FileDiff, GitMerge, GitPullRequest, GitPullRequestCreate, List, Loader2, Maximize2, MessageSquare, MoreHorizontal, Pencil, RefreshCw, ThumbsDown, ThumbsUp, Trash2, Workflow, XCircle } from "lucide-react";
import { forgeAccountsDialog } from "./ForgeAccounts";
import { api, errorMessage, isGitError } from "../lib/api";
import { forgetPrReads } from "../lib/prCache";
import { getTab, type RepoTab } from "../lib/store";
import { showDialog, toast, copyText, openOverlay, contextMenu, type MenuItem } from "../lib/ui";
import { useAllPullRequests } from "../lib/useAllPullRequests";
import { repositoryKey, useLibrary } from "../lib/repositoryLibrary";
import * as A from "../lib/actions";
import type { Check, ForgeInfo, PullRequest, PrDetail, PrEditResult, PrFile, PrFileView, PrMergePlan, PrPage, PrReviewCapabilities, PrReviewKind, PrState, PrTemplates } from "../lib/types";
import { basename, relativeTime } from "../lib/format";
import { appendPullRequests, forgeRepositoryIdentity, loadPrPreferences, prPreferencesKey, pullRequestNumber, restorePrPreferences, safeWebUrl, searchPullRequests, utf8Length, prWriteAttemptKey, prWriteAttemptPending, setPrWriteAttemptPending, type PrPreferences } from "../lib/prCenter";
import { Modal } from "./Modal";
import { Splitter } from "./Overlays";
import { fileCopyMenu } from "./NamePathMenu";
import { DiffView } from "./DiffView";
import { CheckIcon } from "./PrChecks";
import { confirmDialog } from "./dialogs";
import { holdListFocus, virtualRange } from "../lib/virtualRange";
import {authorSelectionValue,authorScope,authorPreferencesKey,loadAuthorPreferences,mergePrAuthors,matchesPrAuthor,rememberAccountAuthor,restoreAuthorPreferences,samePrAuthor,type PrAuthor,type AuthorPreferences} from "../lib/prAuthors";
import { useSettings } from "../lib/settings";
import { onPrRefresh } from "../lib/prRefresh";
import { copyUrlMenu } from "./NamePathMenu";
import { EMPTY_PR_WATCH, PR_PAGE_REFRESHED, nextPrListRead, updatePrWatch, viewerAuthor, type PrPageRefresh } from "../lib/prTracking";

const FORGE_NAMES: Record<string, string> = { github: "GitHub", azure: "Azure DevOps", gitlab: "GitLab", bitbucket: "Bitbucket Cloud", "bitbucket-server": "Bitbucket Server" };
const prUrlMenu = (p: PullRequest) => [copyUrlMenu(() => p.url, "The provider did not supply a web address for this pull request.")];
const browser = (url: string) => { const safe = safeWebUrl(url); if (safe) void api.openPath(safe); };

export function ChecksList({ checks }: { checks: Check[] }) {
  if (!checks.length) return <div className="faint">No CI checks reported for this commit.</div>;
  return <div className="vstack" style={{ gap: 4 }}>{checks.map((c, i) => <div key={i} className="hstack" style={{ gap: 8 }}><CheckIcon state={c.state} /><span className="ellipsis" style={{ flex: 1 }}>{c.name}</span>{safeWebUrl(c.url) && <button aria-label="Open" className="icon-btn sm" title="Open" onClick={() => browser(c.url!)}><ExternalLink size={12} /></button>}</div>)}</div>;
}

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
      <button type="button" className="btn sm" aria-label="My PR alerts" aria-pressed={watching} title={watching ? "On: you get notified about reviews and comments on your open pull requests in every repository of the library. Click to turn off." : "Off: click to get notified about reviews and comments on your open pull requests in every repository of the library."} onClick={() => useSettings.setState(s => ({ prWatchMineSince: s.prWatchMineSince ? null : Date.now() }))}><Bell size={14}/>My PR alerts{watching ? ": on" : ""}</button>
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
const selectionKeyOf = (root: string, forge: ForgeInfo, state: PrState) => JSON.stringify([root, forge.api, forge.project, forge.remote, forge.accountId, state]);
// The first page of each list seen in this session, shown at once when the list opens again.
const lastFirstPages = new Map<string, PrPage>();
function rememberFirstPage(root: string, state: PrState, page: PrPage) {
  const key = JSON.stringify([root, state]);
  lastFirstPages.delete(key);
  lastFirstPages.set(key, page);
  const oldest = lastFirstPages.keys().next().value;
  if (lastFirstPages.size > 40 && oldest !== undefined) lastFirstPages.delete(oldest);
}

const ConnectedPullRequests = memo(function ConnectedPullRequests({ root }: { root: string }) {
  const [prefs, savePreferences] = usePrPreferences(root);
  const [forge, setForge] = useState<ForgeInfo | null>(null), [items, setItems] = useState<PullRequest[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [query, setQuery] = useState(""), [selected, setSelected] = useState<number | null>(null), [epoch, setEpoch] = useState(0);
  const generation = useRef(0), busy = useRef(false), preferred = useRef<number | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
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
  const applyAuthors = useCallback((page: PrPage) => {
    const scope=authorScope(page.forge,page.viewer);
    const saved=loadAuthorPreferences(root,scope,page.forge);
    setAuthors(old=>({scope,known:mergePrAuthors(old.scope===scope?old.known:[],page.items),viewer:viewerAuthor(page.viewer),prefs:old.scope===scope?old.prefs:saved}));
  }, [root]);
  /** `keep`: a refresh keeps the rows and the open PR on screen until the new page arrives. */
  const load = useCallback(async (next: string | null = null, keep = false) => {
    if (next && busy.current) return;
    latestListRead.current = nextPrListRead();
    const id = next ? generation.current : ++generation.current;
    busy.current = true; setLoading(true); setError("");
    const shown = !next && !keep ? lastFirstPages.get(JSON.stringify([root, prefs.state])) : undefined;
    if (!next && !keep) {
      setCursor(null); setEpoch(e => e + 1);
      if (shown) {
        // Show the rows from the last visit at once; the request below replaces them.
        setForge(shown.forge); setItems(shown.items); applyAuthors(shown);
        setSelected(preferred.current ?? rememberedPrSelection.get(selectionKeyOf(root, shown.forge, prefs.state)) ?? null);
      } else { setItems([]); setForge(null); setSelected(null); }
    }
    try {
      const page = await api.prPage(root, prefs.state, next);
      if (id !== generation.current) return;
      if (!next) { firstPage.current = page.items; rememberFirstPage(root, prefs.state, page); }
      setForge(old => old && JSON.stringify(old) === JSON.stringify(page.forge) ? old : page.forge);
      setItems(old => next ? appendPullRequests(old, page.items) : page.items); setCursor(page.nextCursor);
      applyAuthors(page);
      if (!next && !keep && !shown) setSelected(preferred.current);
      if (keep) setDetailRefresh(n => n + 1);
    } catch (e) { if (id === generation.current) setError(errorMessage(e)); }
    finally { if (id === generation.current) { busy.current = false; setLoading(false); } }
  }, [root, prefs.state, applyAuthors]);
  useEffect(() => { void load(); const changed = () => { preferred.current = null; lastFirstPages.clear(); forgetPrReads(); void load(); }; window.addEventListener("revqora:forge-accounts", changed); return () => { generation.current++; busy.current = false; window.removeEventListener("revqora:forge-accounts", changed); }; }, [load]);
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
  const selectionKey = forge ? selectionKeyOf(root, forge, prefs.state) : "";
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
  const refresh = useCallback(() => { forgetPrReads(); preferred.current = selected ?? preferred.current; return load(null, true); }, [selected, load]);
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
      <RequestRows root={root} rows={visible.map(pull => ({ id: pull.number, pull, watched: !!watch.selected[pull.number] }))} selected={selected} select={selectRequest} resetKey={`${query}:${prefs.state}:${authors.prefs.selection}`} />
      {!visible.length && !loading && !error && <p className="pr-list-empty">No matching requests in the loaded pages.{cursor ? " Load more or open a request by number." : ""}</p>}
      <footer className="pr-list-footer">{loading ? <span className="loading-status" role="status"><Loader2 size={13} className="spin" /> Loading requests…</span> : cursor ? <button className="btn sm" onClick={() => void load(cursor)}>Load more requests</button> : <span className="faint">{items.length} loaded</span>}</footer>
    </>}>
      {!prefs.listOpen && error && <div className="callout warn" role="alert">{error}<button type="button" className="btn sm" onClick={()=>void forgeAccountsDialog(root)}>Connection settings…</button></div>}
      {forge?.connectionRevision && selected ? <RequestDetail key={`${forge.connectionRevision}:${selected}:${epoch}`} root={root} forge={forge} number={selected} refreshToken={detailRefresh} listPull={items.find(p => p.number === selected)} prefs={prefs} savePreferences={savePreferences} updated={updated} reloadConnection={refresh} watched={!!watch.selected[selected]} watchOwn={watchMine && !!mine} mine={mine} toggleWatch={() => togglePrWatch(root, authors.scope, selected)} /> : <div className="pr-empty">{loading ? <><Loader2 size={22} className="spin" />Loading pull requests…</> : error ? "Configure the API connection or refresh to continue." : "Select a pull request or open one by number."}</div>}
  </PrCenterLayout>;
});

function MyPrAuthor({authors,initial,close,bitbucket}:{authors:PrAuthor[];initial?:PrAuthor|null;close:(author:PrAuthor|null)=>void;bitbucket:boolean}){
  const [key,setKey]=useState(initial?.key??""),[login,setLogin]=useState(initial?.login??"");const found=authors.find(a=>a.key===key);const typed=login.trim();const valid=!!found||!!typed&&typed.length<=256&&!/[\u0000-\u001f\u007f]/.test(typed);
  return <Modal title="Your PR author" onClose={()=>close(null)} onSubmit={()=>{if(valid)close(found??{key:`login:${typed.toLowerCase()}`,label:typed,login:typed});}} footer={<><button type="button" className="btn" onClick={()=>close(null)}>Cancel</button><button type="submit" className="btn primary" disabled={!valid}>Use as my author</button></>}><p>Profile access is optional. Choose yourself from the discovered authors or enter your hosting username once.</p><label className="field">Found authors<select className="select" aria-label="My PR author" value={key} onChange={e=>setKey(e.target.value)}><option value="">Enter a username instead…</option>{authors.map(a=><option key={a.key} value={a.key}>{a.label}{a.login?` · ${a.login}`:""}</option>)}</select></label><label className="field">{bitbucket?"Bitbucket nickname (not Atlassian email)":"Hosting username"}<input className="input" aria-label="My PR username" disabled={!!found} value={login} onChange={e=>setLogin(e.target.value)}/></label></Modal>;
}

const ALL_PR_PREFERENCES = "@all-repositories";

const CombinedPullRequests = memo(function CombinedPullRequests({ root }: { root: string }) {
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
      root={selected.repository.root} forge={selected.forge} number={selected.pull.number} listPull={selected.pull} prefs={prefs} savePreferences={savePreferences}
      updated={updated} reloadConnection={refresh} watched={!!watches[selected.repository.root]?.[selected.scope]?.selected[selected.pull.number]}
      watchOwn={watchMine} mine={selected.author} toggleWatch={() => togglePrWatch(selected.repository.root, selected.scope, selected.pull.number)} />
      : <div className="pr-empty">{finished && !rows.length ? "No matching pull requests." : "Select a pull request."}</div>}
  </PrCenterLayout>;
});

type RequestListRow<Key> = {
  id: Key;
  pull: PullRequest;
  watched?: boolean;
  repository?: { root: string; name: string; project: string };
};

function RequestRows<Key extends string | number>({ root, rows, selected, select, resetKey, showRepository }: {
  root?: string; rows: RequestListRow<Key>[]; selected: Key | null; select: (id: Key) => void; resetKey: string; showRepository?: boolean;
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
    if (!ref.current) return;
    // A clicked row holds focus; it is unmounted when the list scrolls away from it.
    holdListFocus(ref.current, ref.current.ownerDocument.activeElement);
    ref.current.scrollTop = Math.max(0, next * rowHeight - height / 2);
  };
  return <div className="pr-request-rows" ref={ref} style={{ "--pr-row-height": `${rowHeight}px` } as CSSProperties} role="listbox" aria-label="Pull requests" tabIndex={0} onKeyDown={move} onScroll={e => setTop(e.currentTarget.scrollTop)}>
    <div style={{ height: first * rowHeight }} />
    {rows.slice(first, last).map(({ id, pull: p, repository, watched }) => <button type="button" role="option" aria-selected={selected === id} data-pr-number={p.number} key={id}
      className={`pr-request-row ${selected === id ? "selected" : ""}`} onClick={() => select(id)} onContextMenu={e => contextMenu(e, prUrlMenu(p))}>
      <span className="pr-row-title"><span className="mono faint">#{p.number}</span><b title={p.title}>{p.title}</b></span>
      {repository && <span className="pr-row-repository ellipsis" title={`${repository.project}\n${repository.root}`}>{repository.name}</span>}
      <span className="pr-row-meta">{watched && <span title="Watched PR" aria-label="Watched PR"><Bell size={12} /></span>}<span className={`pill pr-state-${p.state}`}>{prStateLabel(p)}</span><span className="ellipsis">{p.author}</span><RowSignals root={repository?.root ?? root} pull={p} /><span className="faint">{relativeTime(Date.parse(p.created) / 1000)}</span></span>
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

function BitbucketOverview({ detail, status }: { detail: PrDetail; status: PrStatus }) {
  return <>
    {detail.reviewDecisions && detail.reviewDecisions.length > 0 && <section className="pr-merge-panel" aria-label="Reviewers">
      <header><b>Reviewers</b></header>
      <div className="pr-merge-checks">{detail.reviewDecisions.map(({ reviewer, state }, index) => {
        const decision = REVIEW_STATES.find((item) => item.state === state);
        return <div key={index}><span className={`pill ${decision?.tone ?? ""}`}>{decision?.label}</span><span>{reviewer}</span></div>;
      })}</div>
    </section>}
    <section className="pr-merge-panel" aria-label="Bitbucket CI checks">
      <header><b>CI checks</b><div className="spacer" />{status.loadChecks && !status.checks && !status.loading && <button type="button" className="btn sm" onClick={status.loadChecks}>Load checks</button>}</header>
      {status.loading && !status.checks && <p className="loading-status" role="status"><Loader2 size={14} className="spin" />Loading CI checks…</p>}
      {status.error && <div className="callout warn" role="alert">{status.error}</div>}
      {status.checks && <ChecksList checks={status.checks} />}
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

type ThreadCount = { total: number; unresolved: number; more: boolean };
type PrStatus = { plan: PrMergePlan | null; checks: Check[] | null; error: string; loading: boolean; threads: ThreadCount | null; loadChecks?: () => void };

/** Checks (merge plan, or Bitbucket statuses) and discussion counts for the status strip and Overview. */
function usePrStatus(root: string, forge: ForgeInfo, detail: PrDetail, refreshToken: number, overview: boolean): PrStatus {
  const bitbucket = forge.kind === "bitbucket";
  const merge = useMergePlan(root, forge, detail, refreshToken, !bitbucket, overview && detail.pull.state === "open");
  const [checks, setChecks] = useState<Check[] | null>(null), [checksError, setChecksError] = useState(""), [checksLoading, setChecksLoading] = useState(false);
  const [threads, setThreads] = useState<ThreadCount | null>(null), [wanted, setWanted] = useState(false);
  const connection = forge.connectionRevision!, n = detail.pull.number;
  // Bitbucket CI statuses need repository read access that PR-only tokens lack, so they load on request.
  useEffect(() => {
    if (!bitbucket) return;
    let current = true;
    setChecks(null); setChecksError("");
    if (!wanted || !detail.pull.headSha) return;
    setChecksLoading(true);
    api.prChecks(root, n, connection, detail.revision)
      .then(r => { if (current) setChecks(r.checks); }, e => { if (current) setChecksError(errorMessage(e)); })
      .finally(() => { if (current) setChecksLoading(false); });
    return () => { current = false; };
  }, [bitbucket, wanted, root, n, connection, detail.revision, detail.pull.headSha, refreshToken]);
  useEffect(() => {
    let current = true;
    setThreads(null);
    // One page is enough for the counters; Discussions loads the rest.
    api.prReviewPage(root, n, connection, detail.revision, "threads", null).then(page => {
      if (current) setThreads({ total: page.items.length, unresolved: page.items.filter(t => t.resolved === false).length, more: !!page.nextCursor });
    }, () => undefined);
    return () => { current = false; };
  }, [root, n, connection, detail.revision, refreshToken]);
  return bitbucket
    ? { plan: null, checks, error: checksError, loading: checksLoading, threads, loadChecks: detail.pull.headSha ? () => setWanted(true) : undefined }
    : { plan: merge.plan, checks: merge.plan?.checks ?? null, error: merge.error, loading: merge.loading, threads };
}

type CheckSummary = { total: number; failed: number; pending: number };
export function summarizeChecks(checks: Check[]): CheckSummary {
  return {
    total: checks.length,
    failed: checks.filter(c => c.state === "failure" || c.state === "cancelled").length,
    pending: checks.filter(c => c.state === "pending").length,
  };
}

// The list API reports no CI state. Remember what opened PRs showed, per head commit.
const seenChecks = new Map<string, CheckSummary>();
const seenListeners = new Set<() => void>();
let seenVersion = 0;
const seenKey = (root: string, p: PullRequest) => JSON.stringify([root, p.number, p.headSha]);
function rememberChecks(root: string, p: PullRequest, summary: CheckSummary) {
  const key = seenKey(root, p), old = seenChecks.get(key);
  if (old && old.total === summary.total && old.failed === summary.failed && old.pending === summary.pending) return;
  seenChecks.set(key, summary);
  const oldest = seenChecks.keys().next().value;
  if (seenChecks.size > 500 && oldest !== undefined) seenChecks.delete(oldest);
  seenVersion++;
  seenListeners.forEach(listener => listener());
}
function useSeenChecks() {
  return useSyncExternalStore(listener => { seenListeners.add(listener); return () => { seenListeners.delete(listener); }; }, () => seenVersion);
}

function ChecksSignal({ summary, compact }: { summary: CheckSummary; compact?: boolean }) {
  const { total, failed, pending } = summary;
  if (!total) return compact ? null : <span className="pr-signal"><CircleDashed size={14} />No checks</span>;
  if (failed) return <span className="pr-signal danger" title={`${failed} of ${total} CI checks failed`}><XCircle size={13} />{compact ? failed : `${failed} of ${total} checks failed`}</span>;
  if (pending) return <span className="pr-signal warn" title={`${pending} of ${total} CI checks are still running`}><Loader2 size={13} />{compact ? `${total - pending}/${total}` : `${pending} of ${total} checks running`}</span>;
  return <span className="pr-signal ok" title={`All ${total} CI checks passed`}><CheckCircle2 size={13} />{compact ? `${total}/${total}` : `Checks ${total}/${total} passed`}</span>;
}

/** Row icons: CI state of PRs opened in this session, and what the provider lists for free. */
function RowSignals({ root, pull }: { root?: string; pull: PullRequest }) {
  useSeenChecks();
  const checks = root ? seenChecks.get(seenKey(root, pull)) : undefined;
  const s = pull.signals;
  if (!checks && !s) return null;
  return <span className="pr-row-signals">
    {checks && <ChecksSignal summary={checks} compact />}
    {s?.conflicts && <span className="pr-signal danger" title="Has merge conflicts"><GitMerge size={13} />Conflicts</span>}
    {!!s?.changesRequested && <span className="pr-signal warn" title={`${s.changesRequested} reviewer${s.changesRequested === 1 ? "" : "s"} requested changes`}><ThumbsDown size={13} />{s.changesRequested}</span>}
    {!!s?.approvals && <span className="pr-signal ok" title={`${s.approvals} approval${s.approvals === 1 ? "" : "s"}`}><ThumbsUp size={13} />{s.approvals}</span>}
    {!!s?.comments && <span className="pr-signal" title={`${s.comments} comment${s.comments === 1 ? "" : "s"}`}><MessageSquare size={13} />{s.comments}</span>}
  </span>;
}

export function prStateLabel(p: PullRequest, declined = false) {
  if (declined) return "Declined";
  if (p.draft && p.state === "open") return "Draft";
  return p.state ? p.state[0].toUpperCase() + p.state.slice(1) : "Unknown";
}

function StatusStrip({ detail, status, bitbucket, show, action }: { detail: PrDetail; status: PrStatus; bitbucket: boolean; show: (section: PrPreferences["section"]) => void; action: ReactNode }) {
  const p = detail.pull, open = p.state === "open", plan = status.plan, signals = p.signals;
  const approvals = bitbucket ? detail.reviewDecisions?.filter(d => d.state === "approved").length : signals?.approvals;
  const changes = bitbucket ? detail.reviewDecisions?.filter(d => d.state === "changes_requested").length : signals?.changesRequested;
  const checks = status.checks ? summarizeChecks(status.checks) : null;
  const threads = status.threads;
  return <div className="pr-status-strip" role="group" aria-label="Pull request status">
    {!checks && !status.loading && !status.error && status.loadChecks
      ? <button type="button" className="pr-status-item" title="Ask Bitbucket for the CI checks of the source commit" onClick={status.loadChecks}><span className="pr-signal"><CircleDashed size={14} />Load CI checks</span></button>
      : <button type="button" className="pr-status-item" title="Show CI checks in Overview" onClick={() => show("overview")}>
        {checks ? <ChecksSignal summary={checks} /> : status.loading ? <span className="pr-signal"><Loader2 size={14} className="spin" />Checking…</span> : <span className="pr-signal" title={status.error || undefined}><CircleDashed size={14} />Checks unavailable</span>}
      </button>}
    {!!approvals && <span className="pr-status-item"><span className="pr-signal ok"><ThumbsUp size={14} />{approvals} approval{approvals === 1 ? "" : "s"}</span></span>}
    {!!changes && <span className="pr-status-item"><span className="pr-signal warn"><ThumbsDown size={14} />Changes requested</span></span>}
    {signals?.conflicts && open && <span className="pr-status-item"><span className="pr-signal danger"><GitMerge size={14} />Merge conflicts</span></span>}
    {open && plan && (plan.blockers.length
      ? <button type="button" className="pr-status-item" title={plan.blockers.join("\n")} onClick={() => show("overview")}><span className="pr-signal warn"><AlertTriangle size={14} />{plan.blockers.length} merge blocker{plan.blockers.length === 1 ? "" : "s"}</span></button>
      : <span className="pr-status-item"><span className="pr-signal ok"><GitMerge size={14} />No merge blockers</span></span>)}
    {threads && threads.total > 0 && <button type="button" className="pr-status-item" title="Show discussions" onClick={() => show("discussions")}>
      <span className={`pr-signal ${threads.unresolved ? "warn" : ""}`}><MessageSquare size={14} />{threads.unresolved ? `${threads.unresolved}${threads.more ? "+" : ""} unresolved` : `${threads.total}${threads.more ? "+" : ""} discussion${threads.total === 1 ? "" : "s"}`}</span>
    </button>}
    <div className="spacer" />
    {action}
  </div>;
}

function menuAt(button: HTMLElement, items: MenuItem[]) {
  const r = button.getBoundingClientRect();
  contextMenu({ clientX: r.left, clientY: r.bottom + 4, currentTarget: button, preventDefault() {} }, items);
}

function RequestDetail({ root, forge, number, prefs, savePreferences, updated, reloadConnection, watched, watchOwn, mine, toggleWatch, refreshToken = 0, listPull }: { watched: boolean; watchOwn: boolean; mine: PrAuthor | null; toggleWatch: () => void; root: string; forge: ForgeInfo; number: number; prefs: PrPreferences; savePreferences: (p: Partial<PrPreferences>) => void; updated: (p: PullRequest) => void; reloadConnection: () => Promise<void>; refreshToken?: number; listPull?: PullRequest }) {
  const connection = forge.connectionRevision!;
  const [detail, setDetail] = useState<PrDetail | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [refreshing,setRefreshing]=useState(false), [reviewEpoch,setReviewEpoch]=useState(0);
  const generation = useRef(0), editing = useRef(false);
  const load = useCallback(async (quiet = false) => { const id = ++generation.current; setRefreshing(quiet); if(!quiet) { setLoading(true); setDetail(null); } setError(""); try { const d = await api.prDetail(root, number, connection); if (id === generation.current) { setDetail(d); updated(d.pull); if(quiet) setReviewEpoch(e=>e+1); } } catch (e) { if (id === generation.current) { setError(errorMessage(e)); if(quiet) toast.warning("The pull request could not be refreshed",errorMessage(e)); } } finally { if (id === generation.current) {setLoading(false);setRefreshing(false);} } }, [root, number, connection, updated]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  // A list refresh reloads the open PR quietly, keeping it on screen.
  const refreshed = useRef(refreshToken);
  useEffect(() => { if (refreshed.current !== refreshToken) { refreshed.current = refreshToken; void load(true); } }, [refreshToken, load]);
  // A background list poll saw a new push or state: do not keep showing the old detail.
  const listHead = listPull?.headSha, listState = listPull?.state;
  useEffect(() => {
    // Some list APIs return shortened commit IDs, so compare by prefix.
    if (detail && listHead && (!detail.pull.headSha.startsWith(listHead) || listState !== detail.pull.state)) void load(true);
  }, [listHead, listState]);
  const edit = async () => { if (!detail || editing.current) return; editing.current = true; const current = generation.current; try { const result = await showDialog<PrEditResult | null>(close => <RequestEditor root={root} forge={forge} initial={detail} close={close} />); if (result && generation.current === current) { setDetail(result.detail); updated(result.detail.pull); } } finally { editing.current = false; } };
  if (loading) return <div className="pr-empty" role="status"><Loader2 size={22} className="spin" />Loading #{number}…</div>;
  if (!detail) return <div className="pr-empty"><div className="callout warn" role="alert">{error || "Pull request unavailable."}</div><button className="btn" onClick={() => void load()}>Reload request</button></div>;
  return <LoadedRequest root={root} forge={forge} detail={detail} prefs={prefs} savePreferences={savePreferences} reloadConnection={reloadConnection}
    watched={watched} watchOwn={watchOwn} mine={mine} toggleWatch={toggleWatch} refreshing={refreshing} reviewEpoch={reviewEpoch} edit={edit} reload={quiet => { if (!quiet) forgetPrReads(); void load(quiet); }} />;
}

function LoadedRequest({ root, forge, detail, prefs, savePreferences, reloadConnection, watched, watchOwn, mine, toggleWatch, refreshing, reviewEpoch, edit, reload }: {
  root: string; forge: ForgeInfo; detail: PrDetail; prefs: PrPreferences; savePreferences: (p: Partial<PrPreferences>) => void; reloadConnection: () => Promise<void>;
  watched: boolean; watchOwn: boolean; mine: PrAuthor | null; toggleWatch: () => void; refreshing: boolean; reviewEpoch: number;
  edit: () => Promise<void>; reload: (quiet: boolean) => void;
}) {
  const connection = forge.connectionRevision!;
  const p = detail.pull;
  const bitbucket = forge.kind === "bitbucket";
  const status = usePrStatus(root, forge, detail, reviewEpoch, prefs.section === "overview");
  const [reviewBusy, setReviewBusy] = useState(false);
  useEffect(() => { if (status.checks) rememberChecks(root, p, summarizeChecks(status.checks)); }, [root, p, status.checks]);
  const coveredByMine = watchOwn && !!mine && matchesPrAuthor(p, mine);
  const sent = () => reload(true);
  const context = { root, forge, detail };
  const review = async (button: HTMLElement) => {
    if (reviewBusy) return;
    setReviewBusy(true);
    let caps: PrReviewCapabilities;
    try { caps = await api.prReviewCapabilities(root, p.number, connection, detail.revision); }
    catch (e) { toast.error(e, "Could not check review permissions"); return; }
    finally { setReviewBusy(false); }
    const item = (kind: PrReviewKind, label: string, allowed: boolean, icon: ReactNode): MenuItem => ({ label, icon, disabled: !allowed, onClick: () => void composeReview(context, kind, sent) });
    menuAt(button, [
      item("comment", "Comment", caps.comment, <MessageSquare size={14} />),
      item("approve", "Approve", caps.approve, <ThumbsUp size={14} />),
      item("request_changes", "Request changes", caps.requestChanges, <ThumbsDown size={14} />),
      ...(caps.reason ? [{ separator: true }, { label: caps.reason, disabled: true }] : []),
    ]);
  };
  const more = (button: HTMLElement) => menuAt(button, [
    { label: "Edit PR", icon: <Pencil size={14} />, onClick: () => void edit() },
    { label: "PR workflow…", icon: <Workflow size={14} />, onClick: () => openOverlay({ kind: "workflows", root, pull: { number: p.number, head: p.head, base: p.base, remote: forge.remote } }) },
    { separator: true },
    { label: "Open in browser", icon: <ExternalLink size={14} />, onClick: () => browser(p.url) },
    ...prUrlMenu(p),
    { separator: true },
    { label: watched ? "Stop watching this PR" : "Watch this PR", icon: <Bell size={14} />, checked: watched, hint: !watched && coveredByMine ? "Already in My PR alerts" : undefined, onClick: toggleWatch },
  ]);
  const action = p.state === "open"
    ? bitbucket
      ? <button type="button" className="btn sm primary" onClick={() => browser(p.url)}><ExternalLink size={13} />Merge on Bitbucket</button>
      : <button type="button" className="btn sm primary" onClick={() => void mergeDialog({ root, forge, detail, updated: sent })}><GitMerge size={13} />Merge…</button>
    : p.state === "merged"
      ? <button type="button" className="btn sm" title="Review deleting the merged source branch locally and on the server" onClick={() => void cleanupDialog({ root, forge, detail, updated: sent })}><Trash2 size={13} />Delete source branch…</button>
      : null;
  const show = (section: PrPreferences["section"]) => savePreferences({ section });
  const threads = status.threads;
  return <div className="pr-detail" inert={refreshing} aria-busy={refreshing} data-pr-detail={p.number} data-pr-revision={detail.revision}>
    <header className="pr-detail-heading">
      <div className="pr-title-line" onContextMenu={e => contextMenu(e, prUrlMenu(p))}><span className="mono faint">#{p.number}</span><span className={`pill pr-state-${p.state}`}>{prStateLabel(p, detail.declined)}</span><h2 title={p.title}>{p.title}</h2>{watched && <span className="pr-watched" aria-label="Watched PR" title="You watch this PR for reviews and comments. Change it in the ⋯ menu."><Bell size={14} /></span>}</div>
      <div className="pr-branch-line" title={`Source ${p.headSha || "unavailable"}\nTarget ${detail.baseSha}\nRefresh to load newer changes.`}><span className="ref local">{p.head}</span><span className="faint">→</span><span className="ref">{p.base}</span><span className="faint">by {p.author}</span>{bitbucket && <BitbucketReviewSummary detail={detail} />}</div>
      <StatusStrip detail={detail} status={status} bitbucket={bitbucket} show={show} action={action} />
      <div className="pr-detail-actions">
        <div className="seg">
          <button className={prefs.section === "overview" ? "on" : ""} onClick={() => show("overview")}>Overview</button>
          <button className={prefs.section === "files" ? "on" : ""} onClick={() => show("files")}><FileDiff size={13} />Files{detail.fileCount !== null ? ` (${detail.fileCount})` : ""}</button>
          <button className={prefs.section === "discussions" ? "on" : ""} onClick={() => show("discussions")}>Discussions{threads && threads.total > 0 && <span className="pr-tab-count" aria-hidden="true">{threads.total}{threads.more ? "+" : ""}</span>}</button>
        </div>
        <div className="spacer" />
        <button type="button" className="btn sm" aria-haspopup="menu" disabled={reviewBusy} title="Comment, approve or request changes" onClick={e => void review(e.currentTarget)}>{reviewBusy ? <Loader2 size={13} className="spin" /> : <MessageSquare size={13} />}Review<ChevronDown size={13} /></button>
        <button className="btn sm" title="Fetch this PR's source commit and switch to it locally" disabled={!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(p.headSha)} onClick={() => void A.act(root, () => api.pullRequestCheckout(root, p.number, connection, p.headSha), { success: b => `Checked out ${b}`, busy: `Fetching #${p.number}` })}><Download size={13} />Check out</button>
        <button type="button" className="icon-btn" aria-label="More pull request actions" title="Edit, PR workflow, open in browser, copy link, watch" aria-haspopup="menu" onClick={e => more(e.currentTarget)}><MoreHorizontal size={16} /></button>
        <button className="icon-btn" title="Refresh this PR: details, checks, files and discussions" aria-label="Reload request" onClick={() => { forgetPrReads(); reload(true); }}><RefreshCw size={15} className={refreshing ? "spin" : ""} /></button>
      </div>
    </header>
    {prefs.section === "discussions" ? <PrReviews root={root} forge={forge} detail={detail} refreshToken={reviewEpoch} onReloadRequest={reloadConnection} onSent={sent}/> : prefs.section === "files" ? <RequestFiles root={root} forge={forge} detail={detail} prefs={prefs} savePreferences={savePreferences} onSent={sent} refreshToken={reviewEpoch}/> : <div className="pr-overview"><PrDescription detail={detail} height={prefs.descriptionHeight} save={descriptionHeight => savePreferences({ descriptionHeight })}/>{bitbucket ? <BitbucketOverview detail={detail} status={status} /> : <PrMergePanel plan={status.plan} error={status.error} loading={status.loading} updated={sent}/>}</div>}
  </div>;
}

function RequestFiles({ root, forge, detail, prefs, savePreferences, onSent, refreshToken = 0 }: { root: string; forge: ForgeInfo; detail: PrDetail; prefs: PrPreferences; savePreferences: (p: Partial<PrPreferences>) => void; onSent:()=>void; refreshToken?: number }) {
  const fileNavigation = useFileListNavigation();
  const [files, setFiles] = useState<PrFile[]>([]), [next, setNext] = useState<number | null>(null), [selected, setSelected] = useState<string | null>(null), [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState<string | null>(null), [view, setView] = useState<PrFileView | null>(null), [fileError, setFileError] = useState(""), [fileLoading, setFileLoading] = useState(false), [width, setWidth] = useState(prefs.filesWidth);
  const remembered = useRef<string | null>(null);
  const pages = useRef(0), requests = useRef(0), busy = useRef(false), connection = forge.connectionRevision!, n = detail.pull.number;
  const load = useCallback(async (offset = 0) => { if (offset && busy.current) return; const id = offset ? pages.current : ++pages.current; busy.current = true; setLoading(true); setError(""); if (!offset) { setFiles([]); setSelected(null); setNext(null); setView(null); } try { const p = await api.prFiles(root, n, connection, detail.revision, offset); if (id !== pages.current) return; setFiles(old => offset ? [...new Map([...old, ...p.items].map(f => [f.id, f])).values()] : p.items); setNotice(p.notice); setNext(p.nextOffset); if (!offset) setSelected(p.items.find(f=>f.path===remembered.current)?.id ?? p.items[0]?.id ?? null); } catch (e) { if (id === pages.current) setError(errorMessage(e)); } finally { if (id === pages.current) { busy.current = false; setLoading(false); } } }, [root, n, connection, detail.revision]);
  useEffect(() => { void load(); return () => { pages.current++; requests.current++; busy.current = false; }; }, [load]);
  // A reload of the PR (⟳) retries a file list or file that failed. Loaded files of the same
  // revision stay on screen: they cannot have changed.
  const [retry, setRetry] = useState(0), refreshed = useRef(refreshToken);
  useEffect(() => {
    if (refreshed.current === refreshToken) return;
    refreshed.current = refreshToken;
    if (error) void load();
    else if (fileError) setRetry(r => r + 1);
  }, [refreshToken]);
  useEffect(() => { const id = ++requests.current; setView(null); setFileError(""); if (!selected) { setFileLoading(false); return; } setFileLoading(true); api.prFile(root, n, connection, detail.revision, selected).then(v => { if (id === requests.current) setView(v); }, e => { if (id === requests.current) setFileError(errorMessage(e)); }).finally(() => { if (id === requests.current) setFileLoading(false); }); return () => { requests.current++; }; }, [root, n, connection, detail.revision, selected, retry]);
  const visible = files.filter(f => `${f.path} ${f.oldPath ?? ""}`.toLowerCase().includes(query.toLowerCase())), file = files.find(f => f.id === selected);
  return <section className={`pr-files ${prefs.filesOpen ? "" : "pr-files-hidden"}`} aria-label="Pull request files" style={{ "--pr-files-width": `${width}px` } as CSSProperties}>
    {prefs.filesOpen && <aside className="pr-file-panel"><div className="pr-list-heading"><b>{files.length} files loaded</b><div className="spacer" /><button className="icon-btn" aria-label="Hide PR files" title="Hide PR files" onClick={() => savePreferences({ filesOpen: false })}><ChevronLeft size={15} /></button></div><input className="input pr-file-search" aria-label="Search loaded PR files" placeholder="Find a changed file…" value={query} onChange={e => setQuery(e.target.value)} /><div className="pr-file-rows" {...fileNavigation} aria-label="PR changed files">{visible.map(f => <button className={`pr-file-row ${f.id === selected ? "selected" : ""}`} key={f.id} data-file-nav="" data-pr-file={f.path} onContextMenu={e => contextMenu(e, fileCopyMenu(f.path))} onClick={() => { remembered.current=f.path;setSelected(f.id); }}><span className={`file-status status-${f.status}`}>{f.status}</span><span className="pr-file-name" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>{f.path}{f.oldPath && <small>from {f.oldPath}</small>}</span>{f.binary ? <small>binary</small> : f.additions !== null && <small className="pr-stats"><span>+{f.additions}</span><span>−{f.deletions}</span></small>}</button>)}{loading && <p className="loading-status" role="status"><Loader2 size={14} className="spin" /> Loading files…</p>}{!loading && !visible.length && !error && <p className="faint">No matching files.</p>}</div>{next !== null && <button className="btn sm" disabled={loading} onClick={() => void load(next)}>Load more files</button>}</aside>}
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
