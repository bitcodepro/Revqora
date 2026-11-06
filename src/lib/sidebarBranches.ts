import type {BranchInfo} from "./types";
import {matchesBranchAuthor} from "./branchManager";
import {repositoryKey} from "./repositoryLibrary";
export interface SidebarBranchPreferences{onlyMine:boolean;sort:"recent"|"name"}
export const sidebarBranchesKey=(root:string)=>`revqora:sidebar-branches:${repositoryKey(root)}`;
export function sidebarBranchPreferences(value:unknown):SidebarBranchPreferences{const p=value as Partial<SidebarBranchPreferences>|null;return {onlyMine:p?.onlyMine===true,sort:p?.sort==="name"?"name":"recent"};}
export function selectSidebarBranches(branches:BranchInfo[],prefs:SidebarBranchPreferences,custom:string,email:string|null,query:string){const q=query.trim().toLocaleLowerCase();return branches.filter(b=>(!prefs.onlyMine||matchesBranchAuthor({author:b.author,authorEmail:b.authorEmail??""},custom,email))&&(!q||[b.name,b.upstream??"",b.author,b.authorEmail??""].some(s=>s.toLocaleLowerCase().includes(q)))).sort((a,b)=>(prefs.sort==="recent"?b.time-a.time:0)||a.name.localeCompare(b.name));}
