import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn,execFileSync} from "node:child_process";
import {once} from "node:events";
import {removeFixtureFolder,shutdownAndCleanup,stopAppTree} from "./ui-cleanup.mjs";

test("fixture deletion waits for confirmed shutdown, including async cleanup",async()=>{
 const calls=[];let release;const stopped=new Promise(resolve=>release=resolve);
 const finished=shutdownAndCleanup(async()=>{calls.push("closing");await stopped;calls.push("closed");},[async()=>{await Promise.resolve();calls.push("removed");}]);
 await Promise.resolve();assert.deepEqual(calls,["closing"]);release();await finished;
 assert.deepEqual(calls,["closing","closed","removed"]);
 const error=new Error("host is still alive");
 await assert.rejects(shutdownAndCleanup(async()=>{throw error;},[()=>assert.fail("removed a live fixture")]),e=>e===error);
});

test("cleanup failures remain failures and do not skip other owned fixtures",async()=>{
 const failure=new Error("permission denied"),calls=[];
 await assert.rejects(shutdownAndCleanup(async()=>calls.push("closed"),[()=>{throw failure;},()=>calls.push("other removed")]),e=>e instanceof AggregateError&&e.errors[0]===failure);
 assert.deepEqual(calls,["closed","other removed"]);
});

test("real Git worktree removal follows release of a process holding its directory",async t=>{
 const base=path.resolve(process.env.REVQORA_TEST_TMP||os.tmpdir());fs.mkdirSync(base,{recursive:true});
 const work=fs.mkdtempSync(path.join(base,"cleanup-worktree-")),root=path.join(work,"source"),target=path.join(work,"copy"),inUse=path.join(work,"in-use");let holder;
 const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
 const hold=async cwd=>{holder=spawn(process.execPath,["-e","process.send('ready'); process.on('message',()=>process.exit(0)); setInterval(()=>{},1000)"],{cwd,windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});await once(holder,"message",{signal:AbortSignal.timeout(10000)});};
 const release=async()=>{const exited=once(holder,"exit",{signal:AbortSignal.timeout(10000)});holder.send("exit");await exited;};
 try{
  fs.mkdirSync(root);git("init","-qb","main");
  for(const[k,v]of[["user.name","Cleanup Fixture"],["user.email","fixture@example.invalid"],["commit.gpgsign","false"],["core.hooksPath",".git/hooks"]])git("config",k,v);
  fs.writeFileSync(path.join(root,"base.txt"),"base\n");git("add",".");git("commit","-qm","Base");git("worktree","add","-b","fixture",target);
  if(process.platform==="win32"){
   git("worktree","add","-b","in-use",inUse);await hold(inUse);
   assert.throws(()=>git("worktree","remove","--force",inUse),e=>/Permission denied/i.test(String(e.stderr)),"Windows must reproduce deletion of an in-use worktree");
   // Git may already remove registration on failure. Do not retry a partially
   // destructive remove; use a separate fixture to verify the correct ordering.
   await release();
  }
  await hold(target);
  await shutdownAndCleanup(release,[()=>git("worktree","remove","--force",target)]);
  assert.equal(fs.existsSync(target),false);assert.doesNotMatch(git("worktree","list","--porcelain"),/refs\/heads\/fixture/);
  t.diagnostic(JSON.stringify({platform:process.platform,git:git("--version"),reproducedInUseDirectory:process.platform==="win32"}));
 }finally{
  if(holder&&holder.exitCode===null&&holder.signalCode===null){const exited=once(holder,"exit");holder.kill();await exited;}
  assert.equal(path.dirname(fs.realpathSync.native(work)),fs.realpathSync.native(base));fs.rmSync(work,{recursive:true,force:true});
 }
});

test("a refused fixture removal names the processes still running, and fails only while the folder stays",async()=>{
 const refused=Object.assign(new Error("EPERM, Permission denied"),{code:"EPERM"});let tries=0;const logged=[];
 await removeFixtureFolder("fixture",{remove:()=>{if(++tries<3)throw refused;},list:()=>`git.exe pid=${tries}`,watchMs:1000,pollMs:1,log:line=>logged.push(line)});
 assert.equal(tries,3);
 assert.match(logged[0],/Removing fixture failed \(EPERM\)[\s\S]*git\.exe pid=1/);
 assert.match(logged[1],/Warning: fixture could be removed \d+ s later[\s\S]*git\.exe pid=3/);
 await assert.rejects(removeFixtureFolder("fixture",{remove:()=>{throw refused;},list:()=>"",watchMs:20,pollMs:1,log:()=>{}}),e=>e===refused);
 let removed=false;await removeFixtureFolder("fixture",{remove:()=>{removed=true;},list:()=>assert.fail("listed without a failure")});assert(removed);
});

test("stopping the app also stops what its exited children left running",{skip:process.platform!=="win32"},async()=>{
 // The app starts a child that starts a long-running grandchild, as Git starts its shell.
 const since=new Date(Date.now()-1000);
 const grandchild="setInterval(()=>{},1000)";
 const child=`const {spawn}=require('child_process');const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});console.log(g.pid);setInterval(()=>{},1000)`;
 const app=spawn(process.execPath,["-e",`const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore']});c.stdout.on('data',d=>{process.stdout.write(c.pid+' '+d)});setInterval(()=>{},1000)`],{stdio:["ignore","pipe","ignore"],windowsHide:true});
 const [childPid,grandPid]=await new Promise(resolve=>app.stdout.once("data",d=>resolve(String(d).trim().split(/\s+/).map(Number))));
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 assert(alive(childPid)&&alive(grandPid));
 const exited=once(app,"exit");
 const left=stopAppTree(app.pid,since);
 await exited;
 assert(!alive(childPid)&&!alive(grandPid),`still running: ${[childPid,grandPid].filter(alive)}`);
 assert(Array.isArray(left));
});
