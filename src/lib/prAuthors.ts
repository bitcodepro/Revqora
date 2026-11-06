import type {ForgeInfo,PullRequest} from "./types";
import {forgeRepositoryIdentity} from "./prCenter";
export interface PrAuthor {key:string;label:string;login:string}
export const authorOf=(p:PullRequest):PrAuthor=>({key:p.authorId?`id:${p.authorId}`:p.authorLogin?`login:${p.authorLogin.toLowerCase()}`:`name:${p.author}`,label:p.author,login:p.authorLogin??""});
export function mergePrAuthors(before:PrAuthor[],rows:PullRequest[]):PrAuthor[]{const map=new Map(before.map(a=>[a.key,a]));for(const p of rows){const a=authorOf(p);if(a.label)map.set(a.key,a);}return [...map.values()].slice(-1000).sort((a,b)=>a.label.localeCompare(b.label)||a.key.localeCompare(b.key));}
export function matchesPrAuthor(p:PullRequest,a:PrAuthor|null){if(!a)return true;if(authorOf(p).key===a.key)return true;return a.key.startsWith("login:")&&!!p.authorLogin&&p.authorLogin.toLowerCase()===a.key.slice(6);}
export const authorScope=(f:ForgeInfo,viewer?:{id:string;login:string}|null)=>JSON.stringify([forgeRepositoryIdentity(f),f.accountId?["profile",f.accountId]:viewer?.id?["viewer",viewer.id]:["git",f.accountLogin??"git"]]);
export interface AuthorPreferences{selection:string;mine:PrAuthor|null;chosen:PrAuthor|null}
export const authorSelectionValue=(prefs:AuthorPreferences,mine:PrAuthor|null)=>prefs.selection===mine?.key?"mine":prefs.selection;
const valid=(s:unknown):s is string=>typeof s==="string"&&s.length<=512&&!/[\u0000-\u001f\u007f]/.test(s);
export function restoreAuthorPreferences(value:unknown):AuthorPreferences{const v=value as Partial<AuthorPreferences>|null;const author=(a:PrAuthor|null|undefined)=>a&&valid(a.key)&&/^(id|login|name):.+$/.test(a.key)&&valid(a.label)&&valid(a.login)?a:null;return {selection:valid(v?.selection)&&/^(all|mine|(?:id|login|name):.+)$/.test(v.selection)?v.selection:"all",mine:author(v?.mine),chosen:author(v?.chosen)};}
export const authorPreferencesKey=(root:string,scope:string)=>`revqora:pr-authors:${JSON.stringify([root,scope])}`;
