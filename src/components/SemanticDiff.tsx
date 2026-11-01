import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { SemanticComparison } from "../lib/types";
import type { ImageSides } from "./ImageDiff";

export const supportsSemantic = (path:string) => /\.(cs|csx|ts|tsx|mts|cts|json)$/i.test(path);
export function SemanticDiff({root,path,sides,version}:{root:string;path:string;sides:ImageSides;version:object}) {
 const [open,setOpen]=useState(false),[data,setData]=useState<SemanticComparison|null>(null),[error,setError]=useState("");
 const identity=JSON.stringify([root,path,sides]);
 useEffect(()=>{setOpen(false);setData(null);setError("");},[identity]);
 useEffect(()=>{if(!open)return;let current=true;setData(null);setError("");api.semanticDiff(root,path,sides.old,sides.new).then(d=>{if(current)setData(d);},e=>{if(current)setError(errorMessage(e));});return()=>{current=false;};},[open,identity,version]);
 return <section className="semantic-panel" aria-label="Syntax-aware changes"><button type="button" className="btn sm" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{open?"Hide":"Show"} semantic summary</button>{open&&<div className="semantic-content">{error&&<p role="alert" className="warn-text">{error} The text diff remains below.</p>}{!data&&!error&&<p role="status">Parsing both complete file snapshots…</p>}{data&&<><p className="muted">{data.language} · {data.total} structural changes.</p>{data.total===0&&<p>No indexed structural changes. This does not mean that the file or its behavior is unchanged.</p>}<div className="semantic-rows">{data.changes.map(c=><details key={c.key} className={`semantic-change ${c.state}`}><summary><span className="pill">{c.state}</span> <b>{c.new?.name??c.old?.name}</b><small> {c.old?`old L${c.old.line}`:""}{c.new?` → new L${c.new.line}`:""}</small></summary><div className="semantic-sides"><pre>{c.old?.preview??"Added"}</pre><pre>{c.new?.preview??"Removed"}</pre></div></details>)}</div><details><summary>About this summary</summary><p className="muted">{data.notice}</p></details></>}</div>}</section>;
}
