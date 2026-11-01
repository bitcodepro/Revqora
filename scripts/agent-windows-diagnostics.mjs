// Fixed diagnostic matrix, not a retry loop. Every failure remains a failure.
// Only offline Rust fixtures execute; no real CLI agent, prompt or token is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

if (process.platform !== "win32") throw Error("Run this diagnostic matrix on Windows");
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),index=process.argv.indexOf("--out");
if(index<0||!process.argv[index+1])throw Error("Pass an explicit --out log directory");
const out=path.resolve(process.argv[index+1]),temp=process.env.REVQORA_TEST_TMP;
if(!temp||!path.isAbsolute(temp)||["TEMP","TMP","TMPDIR"].some(k=>path.resolve(process.env[k]??"")!==path.resolve(temp)))throw Error("Set REVQORA_TEST_TMP, TEMP, TMP and TMPDIR to the same task-owned directory");
fs.mkdirSync(temp,{recursive:true});fs.mkdirSync(out,{recursive:true});
const cargo=process.env.CARGO||path.join(os.homedir(),".cargo","bin","cargo.exe");
const binaries={};
for(const [config,features]of [["normal",[]],["ui-automation",["--features","ui-automation"]]]){
  console.log(`BUILD ${config} (sequential; no test executable is running)`);
  const build=spawnSync(cargo,["test","--manifest-path",path.join(root,"src-tauri/Cargo.toml"),"--lib","--no-run","--message-format=json",...features],{cwd:root,encoding:"utf8",windowsHide:true,maxBuffer:64*1024*1024});
  fs.writeFileSync(path.join(out,`build-${config}.stderr.log`),build.stderr??String(build.error??""));
  fs.writeFileSync(path.join(out,`build-${config}.jsonl`),build.stdout??"");
  if(build.error||build.status!==0)throw Error(`Cannot build ${config}; see diagnostic build logs`);
  const artifacts=build.stdout.split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)).filter(a=>a.reason==="compiler-artifact"&&a.target?.name==="revqora_lib"&&a.profile?.test&&a.executable);
  const executable=artifacts.at(-1)?.executable;if(!executable)throw Error(`No test executable for ${config}`);
  binaries[config]={path:executable,sha256:crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex")};
}
const version=program=>spawnSync(program,["--version"],{encoding:"utf8",windowsHide:true}).stdout?.trim()??null;
const versions={rust:version("rustc"),git:version("git")};
const results=[],single="git::agents::tests::explicit_worktree_destination_is_reviewed_and_nested_locations_are_rejected",parallel="git::agents::tests::explicit_worktree_destinations_parallel_keep_diagnostic_failures";
const summary=()=>fs.writeFileSync(path.join(out,"summary.json"),JSON.stringify({platform:process.platform,release:os.release(),arch:os.arch(),tempRoot:temp,versions,binaries,plannedCases:20,automaticRetries:0,results},null,2));
function run(config,test,label,cases){
  console.log(`RUN ${label}: ${config}, ${cases} fixture(s)`);const started=Date.now(),file=path.join(out,label+".log"),fd=fs.openSync(file,"w");
  return new Promise(resolve=>{
    const child=spawn(binaries[config].path,["--exact",test,"--nocapture","--test-threads=1"],{cwd:root,windowsHide:true,stdio:["ignore",fd,fd]});
    let spawnError=null;child.once("error",e=>{spawnError={message:e.message,code:e.code};});
    child.once("close",(exitCode,signal)=>{fs.closeSync(fd);const log=fs.readFileSync(file,"utf8"),testExecuted=/^running 1 test\r?$/m.test(log)&&log.includes(`test ${test} ...`);const passed=exitCode===0&&!spawnError&&testExecuted;const result={label,config,test,cases,exitCode,signal,spawnError,testExecuted,passed,elapsedMs:Date.now()-started,log:file};results.push(result);summary();console.log(`${passed?"PASS":"FAIL"} ${label}: ${exitCode}`);resolve(result);});
  });
}
// Two isolated cases; two four-way cases; two overlapping configurations; then
// both four-way cases together. Distinct, predeclared workloads, never reruns.
await run("normal",single,"normal-sequential",1);
await run("ui-automation",single,"automation-sequential",1);
await run("normal",parallel,"normal-four-way",4);
await run("ui-automation",parallel,"automation-four-way",4);
await Promise.all([run("normal",single,"cross-normal-single",1),run("ui-automation",single,"cross-automation-single",1)]);
await Promise.all([run("normal",parallel,"cross-normal-four-way",4),run("ui-automation",parallel,"cross-automation-four-way",4)]);
summary();
if(results.some(r=>!r.passed))process.exitCode=1;
console.log("A passing matrix does not establish the cause of an earlier failure; inspect operation/OS-error context on any failure.");
