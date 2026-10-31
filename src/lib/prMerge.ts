import type { PrMergePlan } from "./types";
import {reviewDraftKey} from "./prReviews";
// Merge requests can finish asynchronously: keep a pending result across source updates.
export const mergeDraftKey=(root:string,connection:string,actor:string,n:number)=>reviewDraftKey(root,`${connection}:${actor}`,n,"request","merge","request");
export function canMerge(plan:PrMergePlan|null,method:string){return !!plan&&!plan.merged&&!plan.blockers.length&&plan.methods.some(m=>m.id===method);}
export const needsCleanupForce=(local:boolean,remote:boolean,p:{localUnmerged:number;remoteUnmerged:number|null;proof:{baseOid:string|null}})=>!p.proof.baseOid||local&&p.localUnmerged>0||remote&&(p.remoteUnmerged??0)>0;
