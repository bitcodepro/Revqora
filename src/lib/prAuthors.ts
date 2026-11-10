import type {ForgeInfo,PullRequest} from "./types";
import {forgeRepositoryIdentity} from "./prCenter";
export interface PrAuthor {key:string;label:string;login:string}
export const authorOf=(p:PullRequest):PrAuthor=>({key:p.authorId?`id:${p.authorId}`:p.authorLogin?`login:${p.authorLogin.toLowerCase()}`:`name:${p.author}`,label:p.author,login:p.authorLogin??""});
export function mergePrAuthors(before:PrAuthor[],rows:PullRequest[]):PrAuthor[]{const map=new Map(before.map(a=>[a.key,a]));for(const p of rows){const a=authorOf(p);if(a.label)map.set(a.key,a);}return [...map.values()].slice(-1000).sort((a,b)=>a.label.localeCompare(b.label)||a.key.localeCompare(b.key));}
export function samePrAuthor(a:PrAuthor,b:PrAuthor|null){
  if(!b)return false;
  if(a.key===b.key)return true;
  if(a.key.startsWith("id:")&&b.key.startsWith("id:"))return false;
  const login=(author:PrAuthor)=>author.key.startsWith("login:")?author.key.slice(6):author.login.toLowerCase();
  return !!login(a)&&login(a)===login(b);
}
export function matchesPrAuthor(p:PullRequest,a:PrAuthor|null){return !a||samePrAuthor(authorOf(p),a);}
export const authorScope=(f:ForgeInfo,viewer?:{id:string;login:string}|null)=>JSON.stringify([forgeRepositoryIdentity(f),f.accountId?["profile",f.accountId]:viewer?.id?["viewer",viewer.id]:["git",f.accountLogin??"git"]]);
export interface AuthorPreferences{selection:string;mine:PrAuthor|null;chosen:PrAuthor|null}
export const authorSelectionValue=(prefs:AuthorPreferences,mine:PrAuthor|null)=>prefs.selection===mine?.key||
  prefs.chosen?.key===prefs.selection&&samePrAuthor(prefs.chosen,mine)?"mine":prefs.selection;
const valid=(s:unknown):s is string=>typeof s==="string"&&s.length<=512&&!/[\u0000-\u001f\u007f]/.test(s);
export function restoreAuthorPreferences(value:unknown):AuthorPreferences{const v=value as Partial<AuthorPreferences>|null;const author=(a:PrAuthor|null|undefined)=>a&&valid(a.key)&&/^(id|login|name):.+$/.test(a.key)&&valid(a.label)&&valid(a.login)?a:null;return {selection:valid(v?.selection)&&/^(all|mine|(?:id|login|name):.+)$/.test(v.selection)?v.selection:"all",mine:author(v?.mine),chosen:author(v?.chosen)};}
export const authorPreferencesKey=(root:string,scope:string)=>`revqora:pr-authors:${JSON.stringify([root,scope])}`;

function accountAuthorKey(forge:ForgeInfo) {
  return forge.accountId ? `revqora:pr-account-author:${JSON.stringify([forge.kind,forge.api,forge.accountId])}` : null;
}

export function loadAuthorPreferences(root:string,scope:string,forge:ForgeInfo):AuthorPreferences {
  const read=(key:string)=>{
    try{return restoreAuthorPreferences(JSON.parse(localStorage.getItem(key)??"null"));}
    catch{return restoreAuthorPreferences(null);}
  };
  const preferences=read(authorPreferencesKey(root,scope));
  const sharedKey=accountAuthorKey(forge);
  if(!sharedKey)return preferences;
  const mine=read(sharedKey).mine;
  if(!mine&&preferences.mine)rememberAccountAuthor(forge,preferences.mine);
  return {...preferences,mine:mine??preferences.mine};
}

export function rememberAccountAuthor(forge:ForgeInfo,mine:PrAuthor) {
  const key=accountAuthorKey(forge);
  if(!key)return;
  try{localStorage.setItem(key,JSON.stringify({mine}));}catch{/* The per-repository preference is still kept in memory. */}
}
