import type {FileDiff} from "./types";
const snapshots=new Map<string,{view:string;value:FileDiff;bytes:number}>();
/** Display only. Every restored snapshot must stay read-only until revalidated. */
export function workingDiffSnapshot(root:string,view:string){const s=snapshots.get(root);if(s?.view!==view)return undefined;snapshots.delete(root);snapshots.set(root,s);return s.value;}
export function rememberWorkingDiff(root:string,view:string,value:FileDiff){const bytes=JSON.stringify(value).length*2;if(bytes>512*1024){snapshots.delete(root);return;}snapshots.delete(root);snapshots.set(root,{view,value,bytes});while(snapshots.size>64||[...snapshots.values()].reduce((n,s)=>n+s.bytes,0)>16*1024*1024)snapshots.delete(snapshots.keys().next().value!);}
export function forgetWorkingDiff(root:string){snapshots.delete(root);}
