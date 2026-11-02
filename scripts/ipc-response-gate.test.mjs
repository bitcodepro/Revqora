import test from "node:test";
import assert from "node:assert/strict";
import { installWorkflowReviewGate } from "./ipc-response-gate.mjs";

function fixture({readonlyFetch=false,bypassFetch=false,reviewError=false}={}) {
 const previous=Object.getOwnPropertyDescriptor(globalThis,"window"),replies=[];
 const url=command=>`http://ipc.localhost/${encodeURIComponent(command)}`;
 const original=async input=>{
  const command=decodeURIComponent(String(input).split("/").at(-1));
  const response=Response.json(command==="plugin:app|version"?"0.0.0-test":{runId:"target",native:true},{headers:{"Tauri-Response":reviewError&&command==="workflow_review"?"error":"ok"}});
  replies.push({command,response});return response;
 };
 const target={__TAURI_INTERNALS__:{convertFileSrc:url}};
 Object.defineProperty(target,"fetch",{value:original,writable:!readonlyFetch,configurable:true});
 const invoke=bypassFetch?async()=>"0.0.0-test":async(command,args={})=>(await target.fetch(url(command),{method:"POST",body:JSON.stringify(args)})).json();
 Object.defineProperty(target.__TAURI_INTERNALS__,"invoke",{value:invoke});
 Object.defineProperty(globalThis,"window",{value:target,writable:true,configurable:true});
 return {target,original,invoke,url,replies,close(){target.__workflowReviewGate?.restore();if(previous)Object.defineProperty(globalThis,"window",previous);else delete globalThis.window;}};
}

test("fetch gate works with a read-only Tauri invoke and returns the actual native response",{timeout:5000},async()=>{
 const f=fixture();
 try{
  assert.equal(Object.getOwnPropertyDescriptor(f.target.__TAURI_INTERNALS__,"invoke").writable,false);
  assert.deepEqual(await installWorkflowReviewGate("target"),{installed:true,probes:1,probeResponses:1});
  const gate=f.target.__workflowReviewGate;
  const pending=f.target.fetch(f.url("workflow_review"),{method:"POST",body:'{"id":"target"}'});
  await gate.ready;
  assert.equal(gate.phase,"held");assert.equal(gate.reviews,1);assert.equal(gate.executions,0);
  gate.release();assert.equal(await pending,f.replies.find(r=>r.command==="workflow_review").response);
  await f.target.fetch(f.url("workflow_execute"),{method:"POST",body:'{"review":{"runId":"target"}}'});
  assert.equal(gate.executions,1);
  gate.restore();assert.equal(f.target.fetch,f.original);assert.equal(f.target.__workflowReviewGate,undefined);
  assert.equal(f.target.__TAURI_INTERNALS__.invoke,f.invoke);
 }finally{f.close();}
});
test("a read-only fetch fails during installation instead of waiting for a missing hook",{timeout:5000},async()=>{
 const f=fixture({readonlyFetch:true});
 try{await assert.rejects(installWorkflowReviewGate("target"),/could not replace window.fetch/);assert.equal(f.target.fetch,f.original);assert.equal(f.target.__workflowReviewGate,undefined);}
 finally{f.close();}
});
test("a native transport that bypasses fetch fails its probe and restores the original function",{timeout:5000},async()=>{
 const f=fixture({bypassFetch:true});
 try{await assert.rejects(installWorkflowReviewGate("target"),/did not complete.*fetch probe/);assert.equal(f.target.fetch,f.original);assert.equal(f.target.__workflowReviewGate,undefined);}
 finally{f.close();}
});
test("a native review error is forwarded and reported without pretending its response is held",{timeout:5000},async()=>{
 const f=fixture({reviewError:true});
 try{
  await installWorkflowReviewGate("target");const gate=f.target.__workflowReviewGate;
  const pending=f.target.fetch(f.url("workflow_review"),{method:"POST"});await gate.ready;
  assert.equal(gate.phase,"error");assert.equal(gate.held,false);assert.match(gate.error,/IPC error/);
  assert.equal(await pending,f.replies.find(r=>r.command==="workflow_review").response);
 }finally{f.close();}
});
