import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {Check,ChevronDown,ExternalLink,Loader2,MessageSquare,RefreshCw} from "lucide-react";
import {api,errorMessage,isGitError} from "../lib/api";
import {showDialog,toast} from "../lib/ui";
import {Modal} from "./Modal";
import {confirmDialog} from "./dialogs";
import {shortOid} from "../lib/format";
import {utf8Length,safeWebUrl} from "../lib/prCenter";
import {mergeReviewThreads,readReviewDraft,reviewDraftKey,writeReviewDraft,previousReviewDrafts} from "../lib/prReviews";
import type {ForgeInfo,PrDetail,PrReviewAnchor,PrReviewCapabilities,PrReviewKind,PrThread} from "../lib/types";
type Context={root:string;forge:ForgeInfo;detail:PrDetail};
const names:Record<PrReviewKind,string>={comment:"Comment",reply:"Reply",resolve:"Resolve discussion",reopen:"Reopen discussion",approve:"Approve",request_changes:"Request changes"};
export async function composeReview(context:Context,kind:PrReviewKind,onSent:()=>void,options:{anchor?:PrReviewAnchor;path?:string;thread?:PrThread}={}){
  try{
    const {root,forge,detail}=context,connection=forge.connectionRevision!;
    const [caps,thread]=await Promise.all([api.prReviewCapabilities(root,detail.pull.number,connection,detail.revision),options.thread?api.prReviewThread(root,detail.pull.number,connection,detail.revision,options.thread.id):Promise.resolve(null)]);
    if(thread&&((kind==="reply"&&!thread.canReply)||((kind==="resolve"||kind==="reopen")&&!thread.canResolve))){toast.warning("Discussion action unavailable","The server no longer permits this action. Refresh the discussion.");return;}
    if((kind==="approve"&&!caps.approve)||(kind==="request_changes"&&!caps.requestChanges)||(options.anchor&&!caps.inline)||((kind==="comment"||kind==="reply")&&!caps.comment)){toast.warning("Review action unavailable",caps.reason);return;}
    await showDialog<void>(close=><Composer context={context} kind={kind} caps={caps} anchor={options.anchor??null} path={options.path??null} initialThread={thread} onSent={onSent} close={()=>close()}/>);
  }catch(e){toast.error(e,"Could not prepare review");}
}
export async function chooseReview(context:Context,onSent:()=>void){
  try{const c=await api.prReviewCapabilities(context.root,context.detail.pull.number,context.forge.connectionRevision!,context.detail.revision);
    const kind=await showDialog<PrReviewKind|null>(close=><Modal title={`Review #${context.detail.pull.number}`} subtitle={`${c.actor} · ${shortOid(context.detail.pull.headSha)}`} onClose={()=>close(null)} footer={<button className="btn" onClick={()=>close(null)}>Close</button>}><div className="review-choices">{(["comment","approve","request_changes"] as const).map(k=><button key={k} className="btn" disabled={k==="comment"?!c.comment:k==="approve"?!c.approve:!c.requestChanges} onClick={()=>close(k)}>{names[k]}</button>)}</div><p className="faint review-permissions">{c.reason}</p></Modal>);
    if(kind)await composeReview(context,kind,onSent);
  }catch(e){toast.error(e,"Could not check review permissions");}
}
function Composer({context,kind,caps,anchor,path,initialThread,onSent,close}:{context:Context;kind:PrReviewKind;caps:PrReviewCapabilities;anchor:PrReviewAnchor|null;path:string|null;initialThread:PrThread|null;onSent:()=>void;close:()=>void}){
  const {root,forge}=context,[detail,setDetail]=useState(context.detail),connection=forge.connectionRevision!,vote=kind==="approve"||kind==="request_changes",hasText=(kind==="comment"||kind==="reply")||(vote&&caps.summaryWithVote);
  const key=reviewDraftKey(root,`${connection}:${caps.actorId}`,detail.pull.number,detail.pull.headSha,kind,initialThread?.id??(anchor?`${path}:${anchor.side}:${anchor.line}`:"general"));
  const [body,setBody]=useState(()=>hasText?readReviewDraft(key):""),[thread,setThread]=useState(initialThread),[error,setError]=useState(""),[busy,setBusy]=useState(false),[storageError,setStorageError]=useState(""),[uncertain,setUncertain]=useState(false),[ack,setAck]=useState(false);
  const active=useRef(false),sent=useRef(false),[saved,setSaved]=useState(false);
  useEffect(()=>{if(!hasText||sent.current)return;try{writeReviewDraft(key,body);setStorageError("");setSaved(!!body);}catch(e){setStorageError(errorMessage(e));setSaved(false);}},[key,body,hasText]);
  const dismiss=async()=>{if(active.current)return;if(storageError&&body&&!await confirmDialog({title:"Close unsaved draft?",message:"Local storage could not save this text. Copy it before closing.",confirm:"Close without saved draft",danger:true}))return;close();};
  const discard=async()=>{if(active.current||!await confirmDialog({title:"Discard review draft?",message:"This removes only this local draft. Published comments are kept.",confirm:"Discard draft",danger:true}))return;try{writeReviewDraft(key,"");}catch(e){setStorageError(errorMessage(e));return;}sent.current=true;close();};
  const send=async()=>{
    if(active.current||utf8Length(body)>65536||uncertain&&!ack||((kind==="comment"||kind==="reply"||kind==="request_changes"&&caps.summaryWithVote)&&!body.trim()))return;
    active.current=true;setBusy(true);setError("");
    try{await api.prReviewAct(root,detail.pull.number,connection,detail.revision,{kind,body,expectedActor:caps.actorId,thread:thread?.id??null,threadRevision:thread?.revision??null,anchor});sent.current=true;try{writeReviewDraft(key,"");}catch{}toast.success(`${names[kind]} sent`);close();onSent();}
    catch(e){setError(errorMessage(e));if(isGitError(e)&&e.kind==="forge-write-uncertain"){setUncertain(true);setAck(false);}}
    finally{active.current=false;setBusy(false);}
  };
  const reload=async()=>{if(active.current)return;active.current=true;setBusy(true);try{const d=await api.prDetail(root,detail.pull.number,connection);if(d.pull.headSha!==detail.pull.headSha||d.baseSha!==detail.baseSha||d.pull.base!==detail.pull.base||d.pull.head!==detail.pull.head)throw Error("The reviewed code changed. Keep or copy this draft, reload the PR and review the new diff before sending.");if(thread){const t=await api.prReviewThread(root,d.pull.number,connection,d.revision,thread.id);setThread(t);}setDetail(d);setError("");}catch(e){setError(errorMessage(e));}finally{active.current=false;setBusy(false);}};
  const older=useMemo(()=>hasText?previousReviewDrafts(key):[],[key,hasText]);
  const valid=utf8Length(body)<=65536&&(!(kind==="comment"||kind==="reply"||kind==="request_changes"&&caps.summaryWithVote)||!!body.trim());
  return <Modal title={`${names[kind]} · #${detail.pull.number}`} subtitle={`${forge.project} · ${caps.actor} · source ${shortOid(detail.pull.headSha)}`} wide onClose={()=>void dismiss()} onSubmit={()=>void send()} footer={<><button className="btn" type="button" disabled={busy} onClick={()=>void dismiss()}>{hasText?"Close and keep draft":"Cancel"}</button>{hasText&&body&&<button className="btn danger" type="button" disabled={busy} onClick={()=>void discard()}>Discard draft</button>}<button className="btn primary" type="submit" disabled={busy||!valid||uncertain&&!ack}>{busy&&<Loader2 className="spin" size={14}/>}Send {names[kind].toLowerCase()}</button></>}>
    <div className="review-composer" data-review-composer={kind} aria-busy={busy}>
      {anchor&&<div className="callout">{path} · {anchor.side==="LEFT"?"old":"new"} line {anchor.line}</div>}
      {thread&&<section className="review-context"><b>Discussion context</b>{thread.comments.slice(-3).map(c=><div key={c.id}><small>{c.author}</small><p>{c.body}</p></div>)}</section>}
      {!anchor&&<div><button type="button" className="btn sm" disabled={busy} onClick={()=>void reload()}>Reload review context</button><small className="faint"> Your text is kept; changed code requires a new review.</small></div>}
      {hasText?<label className="field">Review text<textarea className="textarea" aria-label="Review text" rows={10} disabled={busy} value={body} onChange={e=>setBody(e.target.value)}/></label>:<p>{vote?"This sends your vote. This provider publishes written feedback separately; use Comment to post a summary.":`This will ${kind} the discussion on the server.`}</p>}
      {older.length>0&&<details className="review-context"><summary>Saved drafts from previous commits ({older.length})</summary>{older.map(d=><div key={d.key}><b>{shortOid(d.head)}</b><p>{d.body.slice(0,300)}{d.body.length>300?"…":""}</p><button className="btn sm" type="button" disabled={busy} onClick={async()=>{if(!body||await confirmDialog({title:"Replace the current draft?",message:"Use this saved text for the currently reviewed commit. The previous draft is kept.",confirm:"Use saved text"}))setBody(d.body);}}>Use saved text</button></div>)}</details>}
      {hasText&&<small className="faint">{utf8Length(body).toLocaleString()} / 65,536 bytes · {saved?"Draft saved locally":"No saved text"}</small>}
      {storageError&&<div className="callout warn" role="alert">{storageError}</div>}{error&&<div className="callout warn" role="alert">{error}</div>}
      {uncertain&&<div className="callout warn"><p>The action may already be published. Check the server before retrying.</p><button className="btn sm" type="button" onClick={()=>{const u=safeWebUrl(detail.pull.url);if(u)void api.openPath(u);}}><ExternalLink size={13}/>Check on server</button><label className="check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>I checked the result and want to retry</label></div>}
      <small className="faint review-permissions">{caps.reason}</small>
    </div>
  </Modal>;
}

export function PrReviews({root,forge,detail,onSent}:{root:string;forge:ForgeInfo;detail:PrDetail;onSent:()=>void}){
  const [feed,setFeed]=useState("threads"),[filter,setFilter]=useState("all"),[query,setQuery]=useState(""),[items,setItems]=useState<PrThread[]>([]),[cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState<string|null>(null);
  const generation=useRef(0),busy=useRef(false),context={root,forge,detail};
  const load=useCallback(async(next:string|null=null)=>{if(next&&busy.current)return;const id=next?generation.current:++generation.current;busy.current=true;setLoading(true);setError("");if(!next){setItems([]);setCursor(null);setNotice(null);}try{const p=await api.prReviewPage(root,detail.pull.number,forge.connectionRevision!,detail.revision,feed,next);if(id!==generation.current)return;setItems(old=>next?mergeReviewThreads(old,p.items):p.items);setCursor(p.nextCursor);setNotice(p.notice);}catch(e){if(id===generation.current)setError(errorMessage(e));}finally{if(id===generation.current){busy.current=false;setLoading(false);}}},[root,detail.pull.number,detail.revision,forge.connectionRevision,feed]);
  useEffect(()=>{void load();return()=>{generation.current++;busy.current=false;};},[load]);
  const visible=useMemo(()=>items.filter(t=>(filter==="all"||(filter==="unresolved"?t.resolved===false:filter==="resolved"?t.resolved===true:t.outdated))&&`${t.path??""} ${t.comments.map(c=>`${c.author} ${c.body}`).join(" ")}`.toLowerCase().includes(query.toLowerCase())),[items,filter,query]);
  const sent=()=>{onSent();};
  const refreshThread=async(t:PrThread)=>{try{const id=generation.current;const fresh=await api.prReviewThread(root,detail.pull.number,forge.connectionRevision!,detail.revision,t.id);if(id===generation.current)setItems(old=>old.map(x=>x.id===t.id?fresh:x));}catch(e){toast.error(e,"Could not refresh discussion");}};
  return <section className="pr-reviews" aria-label="PR discussions" aria-busy={loading}><header className="review-toolbar"><select className="select" aria-label="Review feed" value={feed} onChange={e=>setFeed(e.target.value)}><option value="threads">Discussions</option>{forge.kind==="github"&&<option value="comments">PR comments</option>}<option value="reviews">{forge.kind==="github"?"Review history":"Review status"}</option></select><select className="select" aria-label="Discussion status" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All loaded</option><option value="unresolved">Unresolved</option><option value="resolved">Resolved</option><option value="outdated">Outdated</option></select><input className="input" aria-label="Search loaded discussions" placeholder="Search loaded discussions…" value={query} onChange={e=>setQuery(e.target.value)}/><button className="icon-btn" aria-label="Refresh discussions" disabled={loading} onClick={()=>void load()}><RefreshCw size={15}/></button><button className="btn sm" onClick={()=>void composeReview(context,"comment",()=>{if(forge.kind==="github")setFeed("comments");sent();})}><MessageSquare size={14}/>New comment</button><button className="btn sm primary" onClick={()=>void chooseReview(context,sent)}><Check size={14}/>Review…</button></header>
    {notice&&<div className="pr-notice" role="status">{notice}</div>}{error&&<div className="callout warn" role="alert">{error}<button className="btn sm" onClick={()=>void load()}>Reload discussions</button></div>}
    <div className="review-thread-list">{visible.map(t=><ThreadCard key={t.id} thread={t} context={context} onSent={sent} refresh={()=>void refreshThread(t)}/>)}{!visible.length&&!loading&&!error&&<div className="pr-empty">No matching discussions in the loaded pages.</div>}{loading&&<div className="pr-empty" role="status"><Loader2 size={18} className="spin"/>Loading discussions…</div>}{cursor&&<button className="btn" disabled={loading} onClick={()=>void load(cursor)}>Load more discussions</button>}</div>
  </section>;
}
function ThreadCard({thread:t,context,onSent,refresh}:{thread:PrThread;context:Context;onSent:()=>void;refresh:()=>void}){
  const [count,setCount]=useState(5),[folded,setFolded]=useState(t.resolved===true);
  useEffect(()=>setFolded(t.resolved===true),[t.resolved]);
  return <article className="review-thread" data-review-thread={t.id}><header><button className="icon-btn sm" title={folded?"Expand discussion":"Collapse discussion"} onClick={()=>setFolded(!folded)}><ChevronDown size={14} style={{transform:folded?"rotate(-90deg)":undefined}}/></button><b className="ellipsis" title={t.path??"General feedback"}>{t.path??"General feedback"}{t.line?` · ${t.side==="LEFT"?"old":"new"} line ${t.line}`:""}</b>{t.resolved!==null&&<span className="pill">{t.resolved?"Resolved":"Unresolved"}</span>}{t.outdated&&<span className="pill">Outdated</span>}<div className="spacer"/>{!t.id.includes(":")&&<button className="icon-btn sm" aria-label={`Refresh discussion ${t.id}`} onClick={refresh}><RefreshCw size={13}/></button>}</header>
    {!folded&&<div className="review-comments">{t.comments.slice(0,count).map(c=><section key={c.id} className="review-comment"><div><b>{c.author||"Unknown author"}</b><span className="pill">{c.state}</span><small title={c.created}>{/^\d{4}-/.test(c.created)?new Date(c.created).toLocaleString():c.created}</small></div><p>{c.body||"No written summary."}</p></section>)}{t.comments.length>count&&<button className="btn sm" onClick={()=>setCount(count+100)}>Show more loaded replies ({t.comments.length-count})</button>}{!t.complete&&<button className="btn sm" onClick={refresh}>Load full discussion</button>}<footer>{t.canReply&&<button className="btn sm" onClick={()=>void composeReview(context,"reply",onSent,{thread:t})}>Reply</button>}{t.canResolve&&t.resolved!==null&&<button className="btn sm" onClick={()=>void composeReview(context,t.resolved?"reopen":"resolve",onSent,{thread:t})}>{t.resolved?"Reopen":"Resolve"}</button>}</footer></div>}
  </article>;
}
