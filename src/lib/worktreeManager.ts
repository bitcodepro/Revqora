import { repositoryKey } from "./repositoryLibrary";
import type { ManagedWorktree } from "./types";

export const worktreeFilters = ["All", "Changed", "Locked", "Missing", "Detached"] as const;
export interface WorktreePreferences { filter: typeof worktreeFilters[number]; sort: "branch" | "path" | "changes" }
export function restoreWorktreePreferences(value: unknown): WorktreePreferences {
  const v=value&&typeof value==="object"?value as Partial<WorktreePreferences>:{};
  return { filter:worktreeFilters.includes(v.filter!)?v.filter!:"All", sort:v.sort==="path"||v.sort==="changes"?v.sort:"branch" };
}
export const worktreePreferencesKey=(root:string)=>`revqora.worktree-manager.${repositoryKey(root)}`;
export function loadWorktreePreferences(root:string):WorktreePreferences {
  try{return restoreWorktreePreferences(JSON.parse(localStorage.getItem(worktreePreferencesKey(root))??"null"));}catch{return restoreWorktreePreferences(null);}
}
export function selectWorktrees(rows:ManagedWorktree[],prefs:WorktreePreferences,search:string) {
  const query=search.trim().toLocaleLowerCase();
  return rows.filter(w=>(!query||[w.path,w.branch,w.head,w.lockReason,w.pruneReason].some(s=>s?.toLocaleLowerCase().includes(query)))&&
    (prefs.filter==="All"||prefs.filter==="Changed"&&((w.changedFiles??0)>0||(w.ignored??0)>0)||prefs.filter==="Locked"&&w.locked||prefs.filter==="Missing"&&!w.exists||prefs.filter==="Detached"&&w.detached))
    .sort((a,b)=>(prefs.sort==="path"?a.path.localeCompare(b.path):prefs.sort==="changes"?((b.changedFiles??0)+(b.ignored??0))-((a.changedFiles??0)+(a.ignored??0)):(a.branch??"").localeCompare(b.branch??""))||a.path.localeCompare(b.path));
}
export function worktreeRemovalBlock(w:ManagedWorktree):string|null {
  if(w.isMain||w.bare)return "The main worktree is kept.";
  if(w.isCurrent)return "Open another worktree before removing this one.";
  if(w.locked)return "Unlock explicitly before reviewing removal.";
  if(!w.exists)return "Review missing registrations instead.";
  if(w.error)return w.error;
  if(w.operation&&w.operation!=="none")return `Finish or abort ${w.operation} first.`;
  return null;
}
