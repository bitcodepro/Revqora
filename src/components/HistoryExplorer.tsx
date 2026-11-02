import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { CodeHistoryEntry } from "../lib/types";
import { closeOverlay } from "../lib/ui";
import { jumpToCommit } from "./GraphView";
import { fileHistoryDialog } from "./FileHistory";
import { relativeTime } from "../lib/format";

export function HistoryExplorer({root}:{root:string}) {
 const [query,setQuery]=useState(""),[path,setPath]=useState(""),[mode,setMode]=useState<"text"|"symbol">("text");
 const [rows,setRows]=useState<CodeHistoryEntry[]>([]),[next,setNext]=useState<number|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[searched,setSearched]=useState(false);
 const [capped,setCapped]=useState(false);
 const [scanned,setScanned]=useState(0),[unavailable,setUnavailable]=useState(0),[notices,setNotices]=useState<string[]>([]);
 const request=useRef(0),active=useRef(false),alive=useRef(true),parameters=useRef({query:"",path:"",mode:"text" as "text"|"symbol",anchor:null as string|null});
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current++;};},[root]);
 const search=async(offset=0)=>{
  if(active.current)return;active.current=true;setBusy(true);setError("");const id=++request.current;
  if(!offset){parameters.current={query,path,mode,anchor:null};setRows([]);setNext(null);setScanned(0);setUnavailable(0);setNotices([]);setCapped(false);}
  try{
   const p=parameters.current;let result:import("../lib/types").CodeHistoryPage;
   if(p.mode==="symbol"){const body=await api.symbolHistory(root,p.path,p.query,p.anchor,offset);if(!alive.current||id!==request.current)return;parameters.current.anchor=body.anchor;setScanned(n=>(offset?n:0)+body.scanned);setUnavailable(n=>(offset?n:0)+body.unavailable);setNotices(old=>[...new Set([...(offset?old:[]),...body.notices])].slice(0,3));result=body;}else{result=await api.codeHistory(root,p.query,p.path||null,offset);}
   if(!alive.current||id!==request.current)return;
   setRows(old=>offset?[...new Map([...old,...result.items].map(r=>[r.oid,r])).values()]:result.items);setNext(result.nextOffset);setCapped(result.capped);setSearched(true);
  }catch(e){if(alive.current&&id===request.current)setError(errorMessage(e));}
  finally{active.current=false;if(alive.current&&id===request.current)setBusy(false);}
 };
 return <section className="conflict-overlay history-explorer" aria-label="History Explorer">
  <header className="cf-head"><Search size={18}/><b>History Explorer</b><div className="spacer"/><button type="button" className="icon-btn" aria-label="Close History Explorer" onClick={closeOverlay}><X size={18}/></button></header>
  <form className="history-search-form" onSubmit={e=>{e.preventDefault();void search();}}>
   <label>Search mode<select className="input" aria-label="History search mode" disabled={busy} value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="text">Literal changed lines</option><option value="symbol">Symbol body / JSON subtree</option></select></label>
   <label>{mode==="symbol"?"Declaration name or JSON pointer":"Changed code or symbol"}<input className="input" aria-label="Changed code or symbol" placeholder={mode==="symbol"?"refreshToken / Service.Run / /ports":"Literal text in added or deleted lines"} maxLength={256} disabled={busy} value={query} onChange={e=>setQuery(e.target.value)}/></label>
   <label>{mode==="symbol"?"Complete source file path":"File or directory (optional)"}<input className="input" aria-label="History path" disabled={busy} value={path} onChange={e=>setPath(e.target.value)}/></label>
   <button type="submit" className="btn primary" disabled={busy||!query.trim()||mode==="symbol"&&!path.trim()}>{busy?"Searching…":"Search changes"}</button>
  </form>
  <p className="agent-notice">{mode==="symbol"?"Compares complete named declaration bodies or JSON subtrees in C#, TypeScript/TSX and JSON. Scans 25 file revisions per page along HEAD's first-parent history, anchored to an exact commit. Current file path only; use File history for renames. This is syntax comparison, not compiler binding analysis.":"Literal case-sensitive text in added/deleted lines across local branches, remote-tracking refs, tags and HEAD. Merge commits compare with their first parent. Binary contents and external PR descriptions are outside this search."}</p>
  {error&&<p role="alert" className="error-text">{error}</p>}
  {searched&&<p className="agent-notice">Results for <code>{parameters.current.query}</code>{parameters.current.path&&<> in <code>{parameters.current.path}</code></>}{parameters.current.mode==="symbol"&&<> · {scanned} file revisions scanned · anchor <code>{parameters.current.anchor?.slice(0,12)}</code></>}</p>}
  {parameters.current.mode==="symbol"&&<p className="agent-notice">For JSON, use an escaped JSON pointer such as /ports, / for an empty property name, or $ for the whole document.</p>}
  {unavailable>0&&<div className="callout warn" role="status"><b>Partial history: {unavailable} revisions could not be parsed or read.</b>{notices.map(n=><p key={n}>{n}</p>)}<button type="button" className="btn" onClick={()=>{closeOverlay();void fileHistoryDialog(root,parameters.current.path);}}>Inspect ordinary file history</button></div>}
  {capped&&<p className="callout warn" role="status">The history preview limit was reached. Narrow the code query/path or inspect ordinary file history for older changes.</p>}
  <main className="history-results">{rows.map(r=><button type="button" key={r.oid} className="history-result" onClick={()=>{closeOverlay();jumpToCommit(root,r.oid);}}><b>{r.subject}</b><span><code>{r.oid.slice(0,12)}</code> · {r.author} · {relativeTime(r.time)}</span></button>)}
   {searched&&!rows.length&&!busy&&!error&&<p>{parameters.current.mode==="symbol"?"No indexed body changes in the parsed revisions scanned so far.":"No matching code changes in the available history."}</p>}
   {next!==null&&<button type="button" className="btn" disabled={busy} onClick={()=>void search(next)}>{parameters.current.mode==="symbol"?"Scan older file revisions":"Load more changes"}</button>}
  </main>
 </section>;
}
