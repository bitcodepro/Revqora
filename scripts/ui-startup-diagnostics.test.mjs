import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {startupTrace,retainStartupFailure,startupLoggingArguments} from "./ui-startup-diagnostics.mjs";

test("startup evidence is bounded to this process and fixed diagnostic fields",()=>{
 const root=fs.mkdtempSync(path.join(process.env.REVQORA_TEST_TMP||os.tmpdir(),"startup-evidence-"));
 try{
  const events=[{pid:1,stage:"previous-process",elapsedMs:0},{pid:2,stage:"webview-build-start",elapsedMs:12,token:"never retain"},{pid:2,stage:"not a fixed stage",elapsedMs:13}];
  fs.writeFileSync(path.join(root,"revqora-startup.jsonl"),"malformed\n"+events.map(e=>JSON.stringify(e)).join("\n")+"\n{partial");
  assert.deepEqual(startupTrace(root,2),[{pid:2,stage:"webview-build-start",elapsedMs:12}]);
  const out=path.join(root,"artifacts"),r=retainStartupFailure({profile:root,pid:2,port:12345,state:"still running",windowState:"probe failed",stderr:"",out});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out,"startup-failure-2.json"),"utf8")),r);
  assert.doesNotMatch(JSON.stringify(r),/never retain|previous-process/);
  fs.writeFileSync(path.join(root,"revqora-startup.jsonl"),Array.from({length:10000},(_,i)=>JSON.stringify({pid:2,stage:"setup-ready",elapsedMs:i})).join("\n"));
  const tail=startupTrace(root,2);assert.equal(tail.length,20);assert.equal(tail.at(-1).elapsedMs,9999);
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(process.env.REVQORA_TEST_TMP||os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});

test("missing startup trace and failed artifact writes preserve the primary diagnosis",()=>{
 assert.deepEqual(startupTrace(undefined,1),[]);
 const root=fs.mkdtempSync(path.join(process.env.REVQORA_TEST_TMP||os.tmpdir(),"startup-write-"));
 try{
  const out=path.join(root,"not-a-directory");fs.writeFileSync(out,"keep");
  const result=retainStartupFailure({profile:root,pid:1,port:1,state:"original failure",windowState:"",stderr:"",out});
  assert.equal(result.state,"original failure");assert.ok(result.persistenceError);
  assert.equal(fs.readFileSync(out,"utf8"),"keep");
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(process.env.REVQORA_TEST_TMP||os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});

test("transport browser diagnostics retain only a bounded tail and require explicit opt-in",()=>{
 const base=path.resolve(process.env.REVQORA_TEST_TMP||os.tmpdir()),root=fs.mkdtempSync(path.join(base,"startup-browser-"));
 try{
  fs.writeFileSync(path.join(root,"revqora-webview.log"),"old browser output\n"+"x".repeat(100000)+"\ninitialization failed");
  const options={profile:root,pid:1,port:1,state:"still running",windowState:"",stderr:"",out:null};
  assert.equal("browserLog" in retainStartupFailure(options),false);
  const captured=retainStartupFailure({...options,captureBrowserLog:true});
  assert.equal(Buffer.byteLength(captured.browserLog),16384);assert.ok(captured.browserLog.endsWith("initialization failed"));assert.doesNotMatch(captured.browserLog,/old browser output/);
  fs.unlinkSync(path.join(root,"revqora-webview.log"));assert.equal(retainStartupFailure({...options,captureBrowserLog:true}).browserLog,"");
 }finally{assert.equal(path.dirname(path.resolve(root)),base);fs.rmSync(root,{recursive:true,force:true});}
});

test("initial browser logging rejects restored profiles and preserves existing transport arguments",()=>{
 const base=path.resolve(process.env.REVQORA_TEST_TMP||os.tmpdir()),root=fs.mkdtempSync(path.join(base,"startup-empty-"));
 try{
  const existing="--remote-debugging-port=12345";
  assert.equal(startupLoggingArguments(root,true,existing),`${existing} --enable-logging --log-file="${path.join(root,"revqora-webview.log")}"`);
  fs.writeFileSync(path.join(root,"restored-state"),"keep");
  assert.throws(()=>startupLoggingArguments(root,true,existing),/new empty test profile/);
  assert.throws(()=>startupLoggingArguments(undefined,true,existing),/new empty test profile/);
  assert.equal(startupLoggingArguments(root,false,existing),existing);
  assert.equal(fs.readFileSync(path.join(root,"restored-state"),"utf8"),"keep");
 }finally{assert.equal(path.dirname(path.resolve(root)),base);fs.rmSync(root,{recursive:true,force:true});}
});
