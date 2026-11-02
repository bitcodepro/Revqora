import fs from "node:fs";
import path from "node:path";

export function startupTrace(profile,pid) {
  if(!profile)return [];
  let fd;
  try {
    fd=fs.openSync(path.join(profile,"revqora-startup.jsonl"),"r");
    const size=fs.fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,65536));
    fs.readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));
    return buffer.toString("utf8").split(/\r?\n/).flatMap(line=>{
      try { const e=JSON.parse(line);return e.pid===pid&&/^[a-z-]{1,48}$/.test(e.stage)&&Number.isFinite(e.elapsedMs)&&e.elapsedMs>=0?[{pid:e.pid,stage:e.stage,elapsedMs:e.elapsedMs}]:[]; }
      catch {return [];}
    }).slice(-20);
  } catch {return [];}
  finally {if(fd!==undefined)fs.closeSync(fd);}
}

function browserStartupLog(profile) {
  if(!profile)return "";
  let fd;
  try{
    fd=fs.openSync(path.join(profile,"revqora-webview.log"),"r");
    const size=fs.fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,16384));
    fs.readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));
    return buffer.toString("utf8");
  }catch{return "";}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}

export function retainStartupFailure({profile,pid,port,state,windowState,stderr,captureBrowserLog=false,out=process.env.REVQORA_SMOKE_OUT}) {
  const evidence={pid,port,state,startup:startupTrace(profile,pid),windowState,stderr};
  // Only the fresh transport-only profile enables browser logging. Repository
  // scenarios do not capture browser logs that could contain service requests.
  if(captureBrowserLog)evidence.browserLog=browserStartupLog(profile);
  if(out) {
    try {
      fs.mkdirSync(out,{recursive:true});
      fs.writeFileSync(path.join(out,`startup-failure-${pid}.json`),JSON.stringify(evidence,null,2));
    } catch(e) {evidence.persistenceError=e.code??e.name;}
  }
  return evidence;
}
