import type {BranchInfo} from "./types";
import {matchesBranchCreator} from "./branchManager";
import {repositoryKey} from "./repositoryLibrary";
export interface SidebarBranchPreferences{onlyMine:boolean;sort:"recent"|"name"}
export const sidebarBranchesKey=(root:string)=>`revqora:sidebar-branches:${repositoryKey(root)}`;
export function sidebarBranchPreferences(value:unknown):SidebarBranchPreferences{const p=value as Partial<SidebarBranchPreferences>|null;return {onlyMine:p?.onlyMine===true,sort:p?.sort==="name"?"name":"recent"};}
export function selectSidebarBranches(branches:BranchInfo[],prefs:SidebarBranchPreferences,custom:string,email:string|null,query:string){const q=query.trim().toLocaleLowerCase();return branches.filter(b=>(!prefs.onlyMine||matchesBranchCreator(b,custom,email))&&(!q||[b.name,b.upstream??"",b.author,b.authorEmail??"",b.creator?.name??"",b.creator?.email??""].some(s=>s.toLocaleLowerCase().includes(q)))).sort((a,b)=>(prefs.sort==="recent"?b.time-a.time:0)||a.name.localeCompare(b.name));}
/** Every branch in branch folder `folder` ("feature", "origin/feature"), subfolders included:
 *  also the ones search, "Only mine" or the pinned primary branch keep out of the tree. */
export function branchesInFolder(branches: readonly BranchInfo[], folder: string): string[] {
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  return branches.filter((branch) => branch.name.startsWith(prefix)).map((branch) => branch.fullName);
}
