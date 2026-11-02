import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn,execFileSync} from "node:child_process";
import {once} from "node:events";
import {shutdownAndCleanup} from "./ui-cleanup.mjs";

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
