import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { FolderGit2, FolderOpen, Lock, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { basename, shortOid } from "../lib/format";
import { useRepos } from "../lib/store";
import { closeOverlay, copyText, showDialog, toast, useUi } from "../lib/ui";
import { repositoryKey } from "../lib/repositoryLibrary";
import { loadWorktreePreferences, restoreWorktreePreferences, selectWorktrees, worktreeFilters, worktreePreferencesKey, worktreeRemovalBlock, type WorktreePreferences } from "../lib/worktreeManager";
import type { WorktreeCreationReview, WorktreeManagerSnapshot, WorktreePruneResult, WorktreePruneReview, WorktreeRemoval, WorktreeRemovalReview, WorktreeCreateRequest } from "../lib/types";
import { Modal } from "./Modal";
import { recoveryDialog } from "./RecoveryCenter";

const size=(n:number)=>n<1048576?`${(n/1024).toFixed(1)} KiB`:`${(n/1048576).toFixed(1)} MiB`;
async function openWorktree(path:string){try{await useRepos.getState().open(path);closeOverlay();}catch(e){toast.error(e,"Could not open worktree");}}
export const worktreeCreateDialog=(root:string)=>showDialog<void>(close=><CreateWorktree root={root} close={()=>close()} />);
export const worktreeRemoveDialog=(root:string,path:string)=>showDialog<void>(close=><RemoveWorktree root={root} path={path} close={()=>close()} />);
export const worktreePruneDialog=(root:string)=>showDialog<void>(close=><PruneWorktrees root={root} close={()=>close()} />);
export const worktreeLockDialog=(root:string,path:string,lock:boolean)=>showDialog<void>(close=><LockWorktree root={root} path={path} lock={lock} close={()=>close()} />);

function CreateWorktree({root,close}:{root:string;close:()=>void}){
  const [branches,setBranches]=useState<string[]>([]),[occupied,setOccupied]=useState<string[]>([]);
  const [mode,setMode]=useState<WorktreeCreateRequest["mode"]>("existing"),[branch,setBranch]=useState(""),[newBranch,setNewBranch]=useState("");
  const [start,setStart]=useState("HEAD"),[path,setPath]=useState(""),[loading,setLoading]=useState(false),[initialLoading,setInitialLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [review,setReview]=useState<WorktreeCreationReview|null>(null),[openCreated,setOpenCreated]=useState(false);
  const generation=useRef(0),active=useRef(false),customPath=useRef(false);
  useEffect(()=>{let alive=true;Promise.all([api.refs(root),api.worktreeManagerSnapshot(root)]).then(([refs,data])=>{
    if(!alive)return;const taken=data.worktrees.flatMap(w=>w.branch?[w.branch]:[]),names=refs.local.map(b=>b.name);
    setBranches(names);setOccupied(taken);const available=names.find(n=>!taken.includes(n));setBranch(available??"");if(!available)setMode("new");
  },e=>{if(alive)setError(errorMessage(e));}).finally(()=>{if(alive)setInitialLoading(false);});return()=>{alive=false;generation.current++;};},[root]);
  const invalidate=()=>{generation.current++;setReview(null);setLoading(false);setError("");};
  useEffect(()=>{if(customPath.current)return;const name=mode==="new"?newBranch:mode==="detached"?"detached":branch;
    const parent=root.replace(/[\\/][^\\/]+$/,"");setPath(name?`${parent}/${basename(root)}-${name.replace(/[\\/]/g,"-")}`:"");
  },[root,mode,branch,newBranch]);
  const request:WorktreeCreateRequest={path,mode,branch:mode==="new"?newBranch:branch,start};
  const valid=!!path&&(mode==="detached"?!!start:mode==="new"?!!newBranch&&!!start:!!branch&&!occupied.includes(branch));
  const prepare=async()=>{if(active.current||initialLoading||!valid)return;const id=++generation.current;setLoading(true);setReview(null);setError("");
    try{const p=await api.worktreeCreationReview(root,request);if(id===generation.current)setReview(p);}catch(e){if(id===generation.current)setError(errorMessage(e));}
    finally{if(id===generation.current)setLoading(false);}
  };
  const submit=async()=>{if(active.current||!review||loading)return;active.current=true;setBusy(true);setError("");const prepared=review;setReview(null);
    try{const result=await api.worktreeAdd(root,prepared);await useRepos.getState().refresh(root);
      if(result.warning)toast.warning("Worktree created; review its actual HEAD",result.warning);
      else useUi.getState().toast({kind:"success",title:"Worktree created",detail:result.path,action:{label:"Open worktree",run:()=>void openWorktree(result.path)}});
      close();if(openCreated)await openWorktree(result.path);
    }catch(e){setError(errorMessage(e));await useRepos.getState().refresh(root);}finally{active.current=false;setBusy(false);}
  };
  const dismiss=()=>{if(!active.current)close();};
  return <Modal title="New worktree" subtitle="A separate working folder. Local edits in the original folder stay there." icon={<FolderGit2 size={18}/>} wide onClose={dismiss} onSubmit={()=>void (review?submit():prepare())} footer={<>
    <button type="button" className="btn" disabled={busy} onClick={dismiss}>Cancel</button>
    {review?<button className="btn primary" type="submit" disabled={busy||loading||initialLoading}>Create worktree</button>:<button className="btn primary" type="submit" disabled={busy||loading||initialLoading||!valid}>Review creation</button>}
  </>}>
    <fieldset className="wm-form" disabled={busy||initialLoading}>
      <div className="seg">{([["existing","Existing branch"],["new","New branch"],["detached","Detached HEAD"]] as const).map(([value,label])=><button type="button" key={value} className={mode===value?"on":""} onClick={()=>{invalidate();setMode(value);}}>{label}</button>)}</div>
      {mode==="existing"?<label className="field">Branch<select className="select" aria-label="Worktree branch" value={branch} onChange={e=>{invalidate();setBranch(e.target.value);}}><option value="">Choose a local branch</option>{branches.map(b=><option key={b} value={b} disabled={occupied.includes(b)}>{b}{occupied.includes(b)?" · in use":""}</option>)}</select></label>:<>
        {mode==="new"&&<label className="field">New branch name<input className="input mono" aria-label="New worktree branch" value={newBranch} onChange={e=>{invalidate();setNewBranch(e.target.value);}}/></label>}
        <label className="field">Start from<input className="input mono" aria-label="Worktree start commit" value={start} onChange={e=>{invalidate();setStart(e.target.value);}}/></label>
      </>}
      <label className="field">New folder<div className="hstack"><input className="input mono" aria-label="Worktree folder" value={path} onChange={e=>{customPath.current=true;invalidate();setPath(e.target.value);}}/>
        <button type="button" className="btn" aria-label="Choose worktree parent folder" onClick={async()=>{const d=await openFolder({directory:true,title:"Parent folder for the new worktree"});if(typeof d==="string"){customPath.current=true;invalidate();setPath(`${d}/${basename(path)||"worktree"}`);}}}><FolderOpen size={15}/></button></div></label>
      <label className="check"><input type="checkbox" checked={openCreated} onChange={e=>setOpenCreated(e.target.checked)}/>Open the new worktree after creation</label>
    </fieldset>
    {(loading||initialLoading)&&<p className="muted" role="status">Loading worktree information…</p>}
    {review&&<div className="wm-review" data-worktree-review="create"><b>Reviewed destination</b><code>{review.path}</code><span>Start commit</span><code>{review.startOid}</code><p>{mode==="existing"?"The selected local branch will be checked out here.":mode==="new"?"A new branch will start at this exact commit.":"HEAD will be detached at this exact commit."} The original working folder and its index are kept.</p></div>}
    {error&&<p className="wm-error" role="alert">{error}</p>}
  </Modal>;
}

function RemoveWorktree({root,path,close}:{root:string;path:string;close:()=>void}){
  const [review,setReview]=useState<WorktreeRemovalReview|null>(null),[result,setResult]=useState<WorktreeRemoval|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[ack,setAck]=useState(false),[error,setError]=useState("");
  const generation=useRef(0),active=useRef(false);
  const load=useCallback(async()=>{const id=++generation.current;setLoading(true);setReview(null);setAck(false);setError("");
    try{const r=await api.worktreeRemovalReview(root,path);if(id===generation.current)setReview(r);}catch(e){if(id===generation.current)setError(errorMessage(e));}
    finally{if(id===generation.current)setLoading(false);}
  },[root,path]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  const submit=async()=>{if(active.current||!review||review.requiresForce&&!ack)return;active.current=true;setBusy(true);setError("");const prepared=review;setReview(null);setAck(false);
    try{const r=await api.worktreeRemove(root,prepared.proof,prepared.requiresForce&&ack);setResult(r);
      if(r.removed===true){for(const p of useRepos.getState().order)if(repositoryKey(p)===repositoryKey(r.path))useRepos.getState().close(p);}
    }catch(e){setError(errorMessage(e));}finally{active.current=false;setBusy(false);await useRepos.getState().refresh(root);}
  };
  const dismiss=()=>{if(!active.current)close();};
  return <Modal title={result?"Worktree removal result":"Review worktree removal"} icon={<Trash2 size={18}/>} tone="danger" wide onClose={dismiss} onSubmit={()=>void submit()} footer={<>
    <button type="button" className="btn" disabled={busy} onClick={dismiss}>{result?"Close":"Cancel"}</button>
    {!result&&<button type="button" className="btn" disabled={busy||loading} onClick={()=>void load()}>Refresh removal review</button>}
    {!result&&<button type="submit" className="btn danger" disabled={busy||loading||!review||review.requiresForce&&!ack}>Remove worktree</button>}
  </>}>
    <code className="wm-path">{path}</code>
    {loading&&<p role="status">Checking files, registration and recovery size…</p>}
    {busy&&<p role="status">Saving recovery checkpoint and removing the reviewed worktree…</p>}
    {review&&<div className="wm-review" data-worktree-review="remove"><b>{review.target.branch??"Detached HEAD"}</b><code>{review.target.head??"No commits"}</code>
      <p>{review.target.changedFiles??0} changed files · {review.target.ignored??0} ignored paths/folders</p>
      <p>A complete snapshot of {review.files} paths ({size(review.bytes)}) and the index will be saved before removing this folder. The branch and commits stay in Git. Recovery creates a separate working folder.</p>
      {review.requiresForce&&!review.target.changedFiles&&!review.target.ignored&&<p>Assume-unchanged/skip-worktree flags can hide working changes. The complete snapshot includes their content and absence as well as the index flags.</p>}
      {review.requiresForce&&<label className="wm-consent"><input type="checkbox" aria-label="Confirm removal of worktree local and ignored changes" checked={ack} onChange={e=>setAck(e.target.checked)}/>I reviewed the local/ignored changes and want to remove this folder after saving its recovery checkpoint.</label>}
    </div>}
    {result&&<div className="wm-review" data-worktree-removed={String(result.removed)}><b>{result.removed===true?"Worktree removed":result.removed===false?"Git kept the worktree registration":"The result needs inspection"}</b>
      <p>Recovery checkpoint {result.checkpoint.id} is saved.</p><button className="btn" type="button" onClick={()=>void recoveryDialog(root,result.checkpoint.id)}>Open recovery checkpoint</button>
      {result.warning&&<p className="wm-error" role="alert">{result.warning} Refresh the manager before another action.</p>}
    </div>}
    {error&&<p className="wm-error" role="alert">{error}</p>}
    {!result&&<p className="muted">Removal requires a complete checkpoint (up to 100 MiB / 20,000 paths). Nested repositories, submodules, directory links and active Git operations must be handled first.</p>}
  </Modal>;
}

function LockWorktree({root,path,lock,close}:{root:string;path:string;lock:boolean;close:()=>void}){
  const [snapshot,setSnapshot]=useState<WorktreeManagerSnapshot|null>(null),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");const active=useRef(false),generation=useRef(0);
  const load=useCallback(async()=>{const id=++generation.current;setSnapshot(null);setError("");try{const data=await api.worktreeManagerSnapshot(root);if(id===generation.current)setSnapshot(data);}catch(e){if(id===generation.current)setError(errorMessage(e));}},[root]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  const target=snapshot?.worktrees.find(w=>repositoryKey(w.path)===repositoryKey(path));
  const valid=!!target&&!target.isMain&&!target.bare&&target.locked!==lock;
  const submit=async()=>{if(active.current||!snapshot||!valid)return;const prepared=snapshot;setSnapshot(null);active.current=true;setBusy(true);setError("");
    try{await api.worktreeLock(root,path,lock,reason,prepared);close();}catch(e){setError(errorMessage(e));}finally{active.current=false;setBusy(false);await useRepos.getState().refresh(root);}
  };
  return <Modal title={lock?"Lock worktree":"Unlock worktree"} icon={<Lock size={18}/>} onClose={()=>{if(!active.current)close();}} onSubmit={()=>void submit()} footer={<>
    <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button><button type="button" className="btn" disabled={busy} onClick={()=>void load()}>Refresh worktree review</button>
    <button className="btn primary" type="submit" disabled={busy||!valid}>{lock?"Lock worktree":"Unlock worktree"}</button>
  </>}>
    <code className="wm-path">{path}</code>
    {lock?<label className="field">Reason (optional)<input className="input" aria-label="Worktree lock reason" maxLength={250} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>:<><p>{target?.lockReason||"No lock reason was recorded."}</p><p>Unlocking allows later removal or cleanup of a missing registration. Its files are kept by this action.</p></>}
    {target?.isMain&&<p className="wm-error">The main worktree cannot be locked.</p>}
    {target&&target.locked===lock&&<p className="muted">The worktree already has the requested lock state.</p>}
    {error&&<p className="wm-error" role="alert">{error}</p>}
  </Modal>;
}

function PruneWorktrees({root,close}:{root:string;close:()=>void}){
  const [review,setReview]=useState<WorktreePruneReview|null>(null),[result,setResult]=useState<WorktreePruneResult|null>(null),[excluded,setExcluded]=useState<Set<string>>(new Set());
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");const active=useRef(false),generation=useRef(0);
  const load=useCallback(async()=>{const id=++generation.current;setLoading(true);setReview(null);setError("");try{const r=await api.worktreePruneReview(root);if(id===generation.current)setReview(r);}catch(e){if(id===generation.current)setError(errorMessage(e));}finally{if(id===generation.current)setLoading(false);}},[root]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  const selected=review?.entries.filter(w=>!excluded.has(w.path))??[];
  const submit=async()=>{if(active.current||!review||!selected.length)return;const prepared={...review,entries:selected};active.current=true;setBusy(true);setReview(null);setError("");
    try{setResult(await api.worktreePrune(root,prepared));}catch(e){setError(errorMessage(e));}finally{active.current=false;setBusy(false);await useRepos.getState().refresh(root);}
  };
  return <Modal title={result?"Missing worktree cleanup result":"Review missing worktrees"} icon={<FolderGit2 size={18}/>} wide onClose={()=>{if(!active.current)close();}} onSubmit={()=>void submit()} footer={<>
    <button type="button" className="btn" disabled={busy} onClick={close}>{result?"Close":"Cancel"}</button>
    {!result&&<button type="button" className="btn" disabled={busy||loading} onClick={()=>void load()}>Refresh missing entries</button>}
    {!result&&<button type="submit" className="btn danger" disabled={busy||loading||!selected.length}>Remove {selected.length} missing entries</button>}
  </>}>
    {!result&&<p>Only the selected missing registrations will be removed. Branches stay; their saved HEADs remain recoverable. Disconnected drives can appear missing: keep or lock any entry you still need.</p>}
    {loading&&<p role="status">Checking missing registrations…</p>}{busy&&<p role="status">Saving recovery and removing reviewed registrations…</p>}
    {review&&<div data-worktree-review="prune">{!review.entries.length&&<p>No eligible missing worktrees. Locked entries are kept.</p>}{review.entries.map(w=><label className="wm-missing" key={w.path}><input type="checkbox" aria-label={`Remove missing ${w.path}`} checked={!excluded.has(w.path)} onChange={e=>setExcluded(old=>{const next=new Set(old);if(e.target.checked)next.delete(w.path);else next.add(w.path);return next;})}/><span><code>{w.path}</code><small>{w.head?shortOid(w.head):"No recorded commit"}</small></span></label>)}{!!review.remaining&&<p>{review.remaining} additional entries are outside this review (50 per operation).</p>}</div>}
    {result&&<div className="wm-review" data-worktree-pruned={result.removed.length}><b>{result.removed.length} registrations removed</b><p>{result.kept.length} kept / not attempted · {result.unknown.length} need inspection</p>
      {result.removed.map(p=><code key={p}>{p}</code>)}{result.warning&&<p className="wm-error" role="alert">{result.warning} The sequence stopped; it was not retried.</p>}
      <button type="button" className="btn" onClick={()=>void recoveryDialog(root,result.checkpoint.id)}>Open recovery checkpoint</button>
    </div>}
    {error&&<p className="wm-error" role="alert">{error}</p>}
  </Modal>;
}

const ROW=76;
export function WorktreeManager({root}:{root:string}){
  const [snapshot,setSnapshot]=useState<WorktreeManagerSnapshot|null>(null),[prefs,setPrefs]=useState(()=>loadWorktreePreferences(root)),[query,setQuery]=useState("");
  const [selected,setSelected]=useState<string|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(""),[scroll,setScroll]=useState(0),[height,setHeight]=useState(500);
  const generation=useRef(0),inflight=useRef<number|null>(null),reviewing=useRef(false),viewport=useRef<HTMLDivElement>(null);
  const pending=useRepos(s=>(s.tabs[root]?.pendingMutations??0)>0);
  const refresh=useCallback(async()=>{if(inflight.current!==null||reviewing.current)return;const id=++generation.current;inflight.current=id;setLoading(true);setError("");
    try{const data=await api.worktreeManagerSnapshot(root);if(id===generation.current)setSnapshot(data);}catch(e){if(id===generation.current)setError(errorMessage(e));}finally{if(inflight.current===id)inflight.current=null;if(id===generation.current)setLoading(false);}
  },[root]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>{if(document.visibilityState==="visible")void refresh();},10000);const update=()=>void refresh();window.addEventListener("revqora:worktree",update);window.addEventListener("revqora:refs",update);window.addEventListener("focus",update);
    return()=>{clearInterval(timer);generation.current++;window.removeEventListener("revqora:worktree",update);window.removeEventListener("revqora:refs",update);window.removeEventListener("focus",update);};
  },[refresh]);
  useEffect(()=>{try{localStorage.setItem(worktreePreferencesKey(root),JSON.stringify(prefs));}catch{toast.warning("Worktree preferences could not be saved");}},[root,prefs]);
  useEffect(()=>{const p=viewport.current;if(!p)return;const observer=new ResizeObserver(()=>setHeight(p.clientHeight));observer.observe(p);return()=>observer.disconnect();},[]);
  const rows=useMemo(()=>selectWorktrees(snapshot?.worktrees??[],prefs,query),[snapshot,prefs,query]);
  useEffect(()=>{setSelected(old=>rows.some(w=>w.path===old)?old:rows[0]?.path??null);},[rows]);
  useEffect(()=>{setScroll(0);if(viewport.current)viewport.current.scrollTop=0;},[prefs.filter,prefs.sort,query]);
  const update=(patch:Partial<WorktreePreferences>)=>setPrefs(p=>restoreWorktreePreferences({...p,...patch}));
  const target=rows.find(w=>w.path===selected),ready=!!target&&!loading&&!pending&&!error,block=target?worktreeRemovalBlock(target):null;
  const action=async(run:()=>Promise<void>)=>{reviewing.current=true;generation.current++;try{await run();}catch(e){toast.error(e);}finally{reviewing.current=false;inflight.current=null;await refresh();}};
  const choose=(i:number)=>{const index=Math.max(0,Math.min(rows.length-1,i));setSelected(rows[index]?.path??null);const p=viewport.current;if(p&&index*ROW<p.scrollTop)p.scrollTop=index*ROW;else if(p&&(index+1)*ROW>p.scrollTop+p.clientHeight)p.scrollTop=(index+1)*ROW-p.clientHeight;};
  const first=Math.max(0,Math.floor(scroll/ROW)-4),last=Math.min(rows.length,Math.ceil((scroll+height)/ROW)+4);
  return <section className="conflict-overlay worktree-manager" aria-label="Worktree manager">
    <header className="cf-head"><FolderGit2 size={18}/><b>Worktree manager</b><span className="muted">{snapshot?.worktrees.length??0} working folders</span><div className="spacer"/>
      <button className="btn" disabled={loading||pending} onClick={()=>void action(()=>worktreeCreateDialog(root))}><Plus size={14}/>New worktree</button>
      <button className="btn" disabled={loading||pending||!!error} onClick={()=>void action(()=>worktreePruneDialog(root))}>Review missing entries</button>
      <button className="icon-btn" aria-label="Refresh worktrees" disabled={loading||pending} onClick={()=>void refresh()}><RefreshCw size={16} className={loading?"spin":""}/></button>
      <button className="icon-btn" aria-label="Close worktree manager" onClick={closeOverlay}><X size={18}/></button>
    </header>
    <div className="wm-toolbar"><input className="input" aria-label="Search worktrees" placeholder="Find a branch, folder, commit or lock reason…" value={query} onChange={e=>setQuery(e.target.value)}/>
      <label>Sort<select className="select" aria-label="Worktree sort" value={prefs.sort} onChange={e=>update({sort:e.target.value as WorktreePreferences["sort"]})}><option value="branch">Branch</option><option value="path">Folder</option><option value="changes">Changes</option></select></label>
      <div className="seg">{worktreeFilters.map(f=><button key={f} className={f===prefs.filter?"on":""} onClick={()=>update({filter:f})}>{f}</button>)}</div>
    </div>
    {error&&<p className="wm-error" role="alert">{error}</p>}
    <div className="wm-body" aria-busy={loading}>
      <div className="wm-viewport" ref={viewport} role="listbox" aria-label="Worktrees" tabIndex={0} onScroll={e=>setScroll(e.currentTarget.scrollTop)} onKeyDown={e=>{if(!["ArrowDown","ArrowUp","Home","End"].includes(e.key))return;e.preventDefault();const i=rows.findIndex(w=>w.path===selected);choose(e.key==="Home"?0:e.key==="End"?rows.length-1:i+(e.key==="ArrowDown"?1:-1));}}>
        <div style={{height:first*ROW}}/>{rows.slice(first,last).map(w=><div role="option" aria-selected={w.path===selected} key={w.path} data-worktree-path={w.path} className={`wm-row ${w.path===selected?"selected":""}`} onClick={()=>setSelected(w.path)}>
          <div><b>{w.branch??(w.bare?"Bare repository":w.detached?"Detached HEAD":"No commits")}</b><small>{[w.isMain&&"Main",w.isCurrent&&"Current",w.locked&&"Locked",!w.exists&&"Missing",w.error&&"Unavailable"].filter(Boolean).join(" · ")||shortOid(w.head??"")}</small></div>
          <div title={w.path}><span className="mono">{w.path}</span><small>{w.operation&&w.operation!=="none"?w.operation:w.lockReason||w.pruneReason||""}</small></div>
          <div><span>{!w.exists?"Missing":w.error?"Unknown":`${w.changedFiles??0} changes`}</span><small>{w.ignored?`${w.ignored} ignored paths`:w.ahead||w.behind?`↑${w.ahead??0} ↓${w.behind??0}`:""}</small></div>
        </div>)}<div style={{height:Math.max(0,rows.length-last)*ROW}}/>{!rows.length&&<p className="wm-empty">{loading?"Loading worktrees…":"No worktrees match these filters."}</p>}
      </div>
      <aside className="wm-detail" aria-label="Selected worktree">{target?<>
        <h3>{target.branch??(target.detached?"Detached HEAD":"Main repository")}</h3><code className="wm-path">{target.path}</code>
        <button className="btn" onClick={()=>copyText(target.path)}>Copy path</button><p className="mono">{target.head?shortOid(target.head):"No commits"}</p>
        <p>{target.isMain?"Main worktree. ":"Linked worktree. "}{target.isCurrent?"Currently open. ":""}{target.locked?`Locked: ${target.lockReason||"no reason recorded"}`:""}</p>
        <p>{target.changedFiles??"Unknown"} changed files · {target.staged??"?"} staged · {target.untracked??"?"} untracked</p>
        <p>{target.ignored??"Unknown"} ignored paths/folders · ↑{target.ahead??0} ↓{target.behind??0}</p>
        {target.operation&&target.operation!=="none"&&<p>Operation: {target.operation}</p>}{target.error&&<p className="wm-error">{target.error}</p>}
        {target.pruneReason&&<p>{target.pruneReason}</p>}{block&&<p className="wm-note">{block}</p>}
        <div className="wm-actions"><button className="btn primary" disabled={!ready||!target.exists||target.bare||!!target.error||target.isCurrent} onClick={()=>void openWorktree(target.path)}>Open worktree</button>
          <button className="btn" disabled={!ready||target.isMain||target.bare} onClick={()=>void action(()=>worktreeLockDialog(root,target.path,!target.locked))}>{target.locked?"Unlock…":"Lock…"}</button>
          <button className="btn danger" disabled={!ready||!!block} onClick={()=>void action(()=>worktreeRemoveDialog(root,target.path))}>Review removal…</button></div>
      </>:<p>Select a working folder.</p>}</aside>
    </div>
    <footer className="wm-footer">{rows.length} shown · Separate working folders share branches and commits, but keep their own files and staging. External changes refresh every 10 seconds, on focus or with Refresh.</footer>
  </section>;
}
