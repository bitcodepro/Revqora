// Temporary diagnostic branch only. Same immutable binary, six predeclared
// environment cases, one launch per case. This never substitutes for PR CI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync,execFileSync,execFile} from 'node:child_process';
import {launch} from './ui-driver.mjs';
const base=path.resolve(process.env.REVQORA_TEST_TMP),out=path.resolve(process.env.REVQORA_SMOKE_OUT);
fs.mkdirSync(base,{recursive:true});fs.mkdirSync(out,{recursive:true});
const work=fs.mkdtempSync(path.join(base,'one-case-')),repo=path.join(work,'repo');fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
git('init','-qb','main');for(const[k,v]of [['user.name','Startup Fixture'],['user.email','fixture@example.invalid'],['commit.gpgsign','false'],['core.hooksPath','.git/hooks']])git('config',k,v);
fs.appendFileSync(path.join(repo,'.git/info/exclude'),'\n/.revqora-smoke-profile/\n');
fs.writeFileSync(path.join(repo,'base.txt'),'fixture\n');git('add','.');git('commit','-qm','Fixture');
const exe=path.resolve('lab-app/Revqora/revqora.exe'),profile=process.env.LAB_PROFILE==='inside'?path.join(repo,'.revqora-smoke-profile'):path.join(work,'profile');
const report={source:process.env.LAB_SOURCE_SHA,observer:process.env.GITHUB_SHA,runtime:process.env.LAB_RUNTIME,profile:process.env.LAB_PROFILE,candidate:process.env.LAB_RUNTIME_CANDIDATE,binarySha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),automaticRetries:0,snapshots:[]};
const save=()=>fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report,null,2));
const home=path.join(work,'baseline-home'),temp=path.join(home,'temp');fs.mkdirSync(temp,{recursive:true});
const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'config'),LOCALAPPDATA:path.join(home,'local'),TEMP:temp,TMP:temp,TMPDIR:temp};
fs.mkdirSync(env.APPDATA);fs.mkdirSync(env.LOCALAPPDATA);
report.baselines=[];
for(const[program,args]of [[path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"Write-Output 'baseline-ready'"]],['cmd.exe',['/D','/C','echo baseline-ready']]]) {
 const started=Date.now(),r=spawnSync(program,args,{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:65536});
 report.baselines.push({program:path.basename(program),elapsedMs:Date.now()-started,status:r.status,signal:r.signal,error:r.error?.code,stdout:(r.stdout??'').slice(0,1024),stderr:(r.stderr??'').slice(0,1024)});
}
save();
const observations=[];let app;
const observe=label=>new Promise(resolve=>{
 execFile('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.resolve('scripts/native-startup-lab.ps1'),'-RootPid',String(process.pid),'-HostPath',exe],{windowsHide:true,timeout:5000,maxBuffer:1024*1024},(error,stdout,stderr)=>{
  fs.writeFileSync(path.join(out,`${label}.jsonl`),stdout??'');report.snapshots.push({label,error:error?.code,stderr:(stderr??'').slice(0,1024)});save();resolve();
 });
});
const timers=[5000,15000,25000].map(ms=>setTimeout(()=>observations.push(observe(`at-${ms}`)),ms));
try {
 const started=Date.now();app=await launch({exe,args:[repo],profile,port:0,visible:process.env.CI==='true',initialStartupDiagnostics:true});report.startup={passed:true,elapsedMs:Date.now()-started};save();
 const invoke=(command,args={})=>app.page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args:{repo,...args}});
 const request={title:'Offline PowerShell comparison',provider:'custom',executable:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args:['-NoProfile','-NonInteractive','-Command',"Write-Output 'agent-ready'"],prompt:'Offline fixture; do not change files or Git refs.',base:'HEAD',worktreePath:path.join(work,'agent-copy'),timeoutSeconds:10};
 const plan=await invoke('agent_prepare',{request});const task=await invoke('agent_start',{plan,consent:true});
 await observe('agent-start');let done;const until=Date.now()+30000;
 while(Date.now()<until){done=(await invoke('agent_tasks')).find(t=>t.id===task.id);if(done&&!['queued','running','stopping'].includes(done.phase))break;await new Promise(r=>setTimeout(r,100));}
 report.agent=done?{id:done.id,phase:done.phase,exitCode:done.exitCode,error:done.error,stdout:done.stdout.slice(0,1024),stderr:done.stderr.slice(0,1024)}:{missing:true};
 if(done?.phase!=='completed'||!done.stdout.includes('agent-ready'))throw Error('Native agent comparison did not complete');
 report.sourceStatus=git('status','--porcelain','--untracked-files=normal');if(report.sourceStatus)throw Error('Offline agent comparison changed the source fixture');
}catch(e){report.failure=String(e);process.exitCode=1;}
finally{
 for(const timer of timers)clearTimeout(timer);await Promise.allSettled(observations);
 try{await app?.close();}catch(e){report.shutdownFailure=String(e);process.exitCode=1;}
 save();console.log(JSON.stringify(report,null,2));
 // Preserve this owned profile until the ephemeral runner is discarded; only
 // bounded JSON/process metadata is uploaded, never profile contents or dumps.
}
