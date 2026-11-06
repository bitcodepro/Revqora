import type {GraphRow} from "./types";
interface Snapshot{version:number;rows:Map<number,GraphRow>;top:number;bytes:number}
// Bounded first-paint snapshots, not mutation preconditions. Backend generation
// checks still govern every fresh row read. Never retain an entire huge graph.
const snapshots=new Map<string,Snapshot>();
export function cachedGraphRows(root:string,version:number){const s=snapshots.get(root);if(!s||s.version!==version)return null;snapshots.delete(root);snapshots.set(root,s);return {rows:new Map(s.rows),top:s.top};}
export function rememberGraphRows(root:string,version:number,rows:Map<number,GraphRow>){const kept=new Map<number,GraphRow>();let bytes=0;for(const [i,row]of [...rows].reverse()){const size=JSON.stringify(row).length*2;if(size>256*1024)continue;if(bytes+size>512*1024||kept.size>=500)break;kept.set(i,row);bytes+=size;}const old=snapshots.get(root);snapshots.delete(root);snapshots.set(root,{version,rows:kept,bytes,top:old?.version===version?old.top:0});while(snapshots.size>64||[...snapshots.values()].reduce((n,s)=>n+s.bytes,0)>16*1024*1024)snapshots.delete(snapshots.keys().next().value!);}
export function rememberGraphPosition(root:string,version:number,top:number){const s=snapshots.get(root);if(s?.version===version&&Number.isFinite(top))s.top=Math.max(0,top);}
export function forgetGraphRows(root:string){snapshots.delete(root);}
