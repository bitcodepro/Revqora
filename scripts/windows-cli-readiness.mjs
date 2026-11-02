// Verify the cold external PowerShell/.NET dependency before agent semantics.
// This is one bounded direct launch, not a retry or a change to task timeouts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
if(process.platform!=="win32")throw Error("Windows CLI preparation requires Windows");
const base=path.resolve(process.env.REVQORA_TEST_TMP??"");
if(!process.env.REVQORA_TEST_TMP||!path.isAbsolute(process.env.REVQORA_TEST_TMP)||["TEMP","TMP","TMPDIR"].some(k=>path.resolve(process.env[k]??"")!==base))throw Error("Use one isolated temporary root");
fs.mkdirSync(base,{recursive:true});const home=fs.mkdtempSync(path.join(base,"powershell-ready-"));
const folders=Object.fromEntries(["config","local","temp"].map(name=>{const p=path.join(home,name);fs.mkdirSync(p);return[name,p];}));
const program=path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe");
const started=performance.now();let report;
try{
 const result=spawnSync(program,["-NoProfile","-NonInteractive","-Command","[Console]::Out.WriteLine('revqora-cli-ready'); [Console]::Out.WriteLine($PSVersionTable.PSVersion.ToString())"],{cwd:home,windowsHide:true,encoding:"utf8",timeout:30000,maxBuffer:65536,stdio:["ignore","pipe","pipe"],env:{...process.env,HOME:home,USERPROFILE:home,APPDATA:folders.config,LOCALAPPDATA:folders.local,TEMP:folders.temp,TMP:folders.temp,TMPDIR:folders.temp}});
 report={program:path.basename(program),os:os.release(),elapsedMs:performance.now()-started,status:result.status,signal:result.signal,error:result.error?.code,stdout:(result.stdout??"").slice(0,1024),stderr:(result.stderr??"").slice(0,1024),automaticRetries:0};
 const out=path.resolve("ci-results/windows-cli-readiness.json");fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(result.error||result.status!==0||!/^revqora-cli-ready\r?$/m.test(result.stdout??""))throw Error("Cold PowerShell dependency did not become ready; see ci-results/windows-cli-readiness.json");
}finally{
 if(path.dirname(fs.realpathSync.native(home))!==fs.realpathSync.native(base))throw Error("Unowned CLI preparation directory");
 fs.rmSync(home,{recursive:true,force:true});
}
