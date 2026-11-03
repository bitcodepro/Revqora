import type { PrThread } from "./types";
import { repositoryKey } from "./repositoryLibrary";
const PREFIX="revqora:review-draft:";
const ATTEMPT_PREFIX="revqora:review-attempt:";
function attemptKeys(key:string):{key:string;legacy:string[]} {
  const oldKey=ATTEMPT_PREFIX+key.slice(PREFIX.length);
  let scope:unknown[],identity:string[];
  try {
    scope=JSON.parse(key.slice(PREFIX.length));identity=JSON.parse(String(scope[1]));
    if(!Array.isArray(identity)||identity.length!==2||typeof identity[0]!=="string")return {key:oldKey,legacy:[]};
    const server=JSON.parse(identity[0]);
    if(!Array.isArray(server)||server.length!==3||!['github','gitlab','azure','bitbucket','bitbucket-server'].includes(server[0]))return {key:oldKey,legacy:[]};
  } catch { return {key:oldKey,legacy:[]}; }
  const stable=ATTEMPT_PREFIX+JSON.stringify(["v2",identity[0],scope[2],scope[4],scope[5]]);
  // Storage failures propagate to the caller's fail-closed handling. They must
  // not fall back to an old key that happens to have no pending marker.
  const legacy=Object.keys(localStorage).filter(k=>{
      if(!k.startsWith(ATTEMPT_PREFIX))return false;
      try{const p=JSON.parse(k.slice(ATTEMPT_PREFIX.length));return p.length===6&&[0,2,4,5].every(i=>p[i]===scope[i]);}catch{return false;}
    });
  return {key:stable,legacy};
}
// Separate from draft text: editing/discarding a draft must not forget a possibly published action.
export function reviewAttemptPending(key:string):boolean{try{const scope=attemptKeys(key);return localStorage.getItem(scope.key)!==null||scope.legacy.length>0;}catch{return true;}}
export function setReviewAttemptPending(key:string,pending:boolean){const scope=attemptKeys(key),k=scope.key;if(!pending){for(const old of scope.legacy)localStorage.removeItem(old);localStorage.removeItem(k);return;}if(!localStorage.getItem(k)&&!scope.legacy.length&&Object.keys(localStorage).filter(k=>k.startsWith(ATTEMPT_PREFIX)).length>=32)throw Error("Check pending review results on the server before sending more actions.");localStorage.setItem(k,JSON.stringify({updated:Date.now()}));for(const old of scope.legacy)localStorage.removeItem(old);}
export function reviewDraftKey(root:string,connection:string,n:number,head:string,kind:string,target:string){return PREFIX+JSON.stringify([repositoryKey(root),connection,n,head,kind,target]);}
export function readReviewDraft(key:string):string{try{const v=JSON.parse(localStorage.getItem(key)??"null");return typeof v?.body==="string"?v.body:"";}catch{return "";}}
export function writeReviewDraft(key:string,body:string){if(!body){localStorage.removeItem(key);return;}if(new TextEncoder().encode(body).length>65536)throw Error("Draft exceeds 64 KiB; copy your text before closing.");if(!localStorage.getItem(key)&&Object.keys(localStorage).filter(k=>k.startsWith(PREFIX)).length>=32)throw Error("Local draft storage has 32 drafts. Copy this draft before closing.");localStorage.setItem(key,JSON.stringify({body,updated:Date.now()}));}
export type LegacyDraftScope={connection:string;actor:string};
function legacyDraftIdentity(current:unknown[],legacy?:LegacyDraftScope):string|null {
  if(!legacy?.connection||!legacy.actor)return null;
  try {
    const identity=JSON.parse(String(current[1])),server=JSON.parse(identity[0]);
    if(identity.length!==2||identity[1]!==legacy.actor||!Array.isArray(server)||server.length!==3||!['github','gitlab','azure','bitbucket','bitbucket-server'].includes(server[0]))return null;
    // The live capabilities/merge plan verifies this exact connection proof and
    // actor. Never guess an old destination by matching an actor ID suffix.
    return `${legacy.connection}:${legacy.actor}`;
  }catch{return null;}
}
export function previousReviewDrafts(key:string,legacy?:LegacyDraftScope):{key:string;head:string;body:string}[]{try{const current=JSON.parse(key.slice(PREFIX.length)),oldIdentity=legacyDraftIdentity(current,legacy);return Object.keys(localStorage).filter(k=>k.startsWith(PREFIX)&&k!==key).flatMap(k=>{try{const p=JSON.parse(k.slice(PREFIX.length));const body=readReviewDraft(k);return p.length===6&&body&&[0,2,4,5].every(i=>p[i]===current[i])&&(p[1]===current[1]||oldIdentity!==null&&p[1]===oldIdentity)?[{key:k,head:String(p[3]),body}]:[];}catch{return [];}});}catch{return [];}}
export function restoreReviewDraft(key:string,source:string,legacy?:LegacyDraftScope):string {
  const draft=previousReviewDrafts(key,legacy).find(d=>d.key===source);
  if(!draft)throw Error("This saved draft does not belong to the current account, repository and review target.");
  if(new TextEncoder().encode(draft.body).length>65536)throw Error("Draft exceeds 64 KiB; copy your text before closing.");
  const scope=JSON.parse(key.slice(PREFIX.length)),old=JSON.parse(source.slice(PREFIX.length));
  const migrating=old[1]===legacyDraftIdentity(scope,legacy);
  if(migrating){
    // A replacement is allowed at the 32-draft limit. Persist the destination
    // before retiring the old key; a failed write must retain the original.
    localStorage.setItem(key,JSON.stringify({body:draft.body,updated:Date.now()}));
    localStorage.removeItem(source);
  }else writeReviewDraft(key,draft.body);
  // Pending publication markers are independent and must never be cleared here.
  return draft.body;
}
export function mergeReviewThreads(old:PrThread[],page:PrThread[]):PrThread[]{const all=new Map(old.map(t=>[t.id,t]));for(const t of page){const previous=all.get(t.id);const comments=new Map(previous?.comments.map(c=>[c.id,c])??[]);for(const c of t.comments)comments.set(c.id,c);all.set(t.id,{...t,comments:[...comments.values()]});}return [...all.values()];}
export function refreshReviewThread(old:PrThread,fresh:PrThread):PrThread{return fresh.complete?fresh:mergeReviewThreads([old],[fresh])[0];}
