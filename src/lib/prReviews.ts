import type { PrThread } from "./types";
import { repositoryKey } from "./repositoryLibrary";
const PREFIX="revqora:review-draft:";
const ATTEMPT_PREFIX="revqora:review-attempt:";
const attemptKey=(key:string)=>ATTEMPT_PREFIX+key.slice(PREFIX.length);
// Separate from draft text: editing/discarding a draft must not forget a possibly published action.
export function reviewAttemptPending(key:string):boolean{try{return localStorage.getItem(attemptKey(key))!==null;}catch{return true;}}
export function setReviewAttemptPending(key:string,pending:boolean){const k=attemptKey(key);if(!pending){localStorage.removeItem(k);return;}if(!localStorage.getItem(k)&&Object.keys(localStorage).filter(k=>k.startsWith(ATTEMPT_PREFIX)).length>=32)throw Error("Check pending review results on the server before sending more actions.");localStorage.setItem(k,JSON.stringify({updated:Date.now()}));}
export function reviewDraftKey(root:string,connection:string,n:number,head:string,kind:string,target:string){return PREFIX+JSON.stringify([repositoryKey(root),connection,n,head,kind,target]);}
export function readReviewDraft(key:string):string{try{const v=JSON.parse(localStorage.getItem(key)??"null");return typeof v?.body==="string"?v.body:"";}catch{return "";}}
export function writeReviewDraft(key:string,body:string){if(!body){localStorage.removeItem(key);return;}if(new TextEncoder().encode(body).length>65536)throw Error("Draft exceeds 64 KiB; copy your text before closing.");if(!localStorage.getItem(key)&&Object.keys(localStorage).filter(k=>k.startsWith(PREFIX)).length>=32)throw Error("Local draft storage has 32 drafts. Copy this draft before closing.");localStorage.setItem(key,JSON.stringify({body,updated:Date.now()}));}
export function previousReviewDrafts(key:string):{key:string;head:string;body:string}[]{try{const current=JSON.parse(key.slice(PREFIX.length));return Object.keys(localStorage).filter(k=>k.startsWith(PREFIX)&&k!==key).flatMap(k=>{try{const p=JSON.parse(k.slice(PREFIX.length));const body=readReviewDraft(k);return body&&[0,1,2,4,5].every(i=>p[i]===current[i])?[{key:k,head:String(p[3]),body}]:[];}catch{return [];}});}catch{return [];}}
export function mergeReviewThreads(old:PrThread[],page:PrThread[]):PrThread[]{const all=new Map(old.map(t=>[t.id,t]));for(const t of page){const previous=all.get(t.id);const comments=new Map(previous?.comments.map(c=>[c.id,c])??[]);for(const c of t.comments)comments.set(c.id,c);all.set(t.id,{...t,comments:[...comments.values()]});}return [...all.values()];}
export function refreshReviewThread(old:PrThread,fresh:PrThread):PrThread{return fresh.complete?fresh:mergeReviewThreads([old],[fresh])[0];}
