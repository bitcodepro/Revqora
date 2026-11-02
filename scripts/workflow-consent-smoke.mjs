// Real renderer/Git workflow proofs. The gate delays a read response, never a
// command or mutation, so cancellation has a deterministic dispatch boundary.
import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { installWorkflowReviewGate } from "./ipc-response-gate.mjs";

export async function workflowConsentSmoke({page,check,shot,root}) {
 const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true}).trim();
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args:{repo:root,...args}});
 const until=async(fn,message)=>{const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await page.waitForTimeout(100);}throw Error(message);};
 const modal=()=>page.locator(".modal").last(),button=name=>modal().getByRole("button",{name,exact:true});
 const step=(kind,value="")=>({kind,label:"",value,extra:"",body:"",timeoutSeconds:15,when:"always",onFalse:"stop"});
 const recipe=async(name,steps)=>{const c=await invoke("workflow_catalog"),saved=await invoke("workflow_save",{definition:{id:"",name,steps},expectedRevision:c.revision});const d=saved.definitions.find(d=>d.name===name);return invoke("workflow_begin",{definitionId:d.id,expectedRevision:saved.revision,parameters:{branch:"unused",base:"main"}});};
 const history=()=>page.getByRole("navigation",{name:"Workflow runs",exact:true});
 const selected=async id=>{await page.locator(`[data-workflow-id="${id}"][data-workflow-phase]`).waitFor();};
 const selectRun=async run=>{await page.getByRole("button",{name:"Refresh workflows",exact:true}).click();await history().getByRole("button").filter({hasText:run.name}).click();await selected(run.id);};
 if(git("status","--porcelain"))throw Error("Conditional PR-agent fixture must start clean");
 const head=git("rev-parse","HEAD"),index=fs.readFileSync(path.join(root,".git/index"));
 const unchanged=()=>{if(git("rev-parse","HEAD")!==head||!fs.readFileSync(path.join(root,".git/index")).equals(index))throw Error("Consent-only review changed HEAD or the index");};
 await page.getByRole("button",{name:"Workflow Builder",exact:true}).click();
 let skipped;
 await check("a false PR-agent condition renders and records a skip without an agent plan",async()=>{
  const run=await recipe("Agent condition skips",[{...step("prAgent","1"),when:"dirty",onFalse:"skip"}]);skipped={id:run.id,name:run.definition.name};await selectRun(skipped);
  await page.getByRole("button",{name:"Review next step",exact:true}).click();await page.locator("[data-workflow-review]").waitFor();
  if(await page.locator('[aria-label="Agent feedback prompt"]').count()||await modal().getByRole("checkbox",{name:"Allow workflow step",exact:true}).count())throw Error("Skipped agent requested a launch plan or execution consent");
  await button("Record skipped step").click();await page.locator(".modal").waitFor({state:"detached"});
  await until(async()=>(await invoke("workflow_run",{id:run.id})).phase==="completed","False agent condition was not skipped");
  const result=await invoke("workflow_run",{id:run.id});if(result.cursor!==1||result.results[0].phase!=="skipped"||(await invoke("agent_tasks")).length)throw Error("Skipped PR-agent executed or lost its result");
  unchanged();await shot("153-agent-false-skip");
 });
 await check("a false PR-agent condition renders and stops without an agent plan",async()=>{
  const run=await recipe("Agent condition stops",[{...step("prAgent","1"),when:"dirty",onFalse:"stop"}]);await selectRun({id:run.id,name:run.definition.name});
  await page.getByRole("button",{name:"Review next step",exact:true}).click();await page.locator("[data-workflow-review]").waitFor();
  if(await page.locator('[aria-label="Agent feedback prompt"]').count()||await modal().getByRole("checkbox",{name:"Allow workflow step",exact:true}).count())throw Error("False agent condition requested launch consent");
  await button("Stop workflow").click();await page.locator(".modal").waitFor({state:"detached"});
  await until(async()=>(await invoke("workflow_run",{id:run.id})).phase==="failed","False agent condition did not stop");
  const result=await invoke("workflow_run",{id:run.id});if(result.cursor!==0||result.results[0].phase!=="failed"||!result.error?.includes("condition was false")||(await invoke("agent_tasks")).length)throw Error("Stopped PR-agent executed or lost its condition error");
  unchanged();await shot("154-agent-false-stop");
 });
 const cancelledReview=async away=>{
  const marker=away?"cancelled-away-command.txt":"cancelled-same-command.txt";
  const run=await recipe(away?"Cancel after switching back":"Cancel same selected run",[step("command",`echo forbidden > ${marker}`)]);
  const row={id:run.id,name:run.definition.name};await selectRun(row);
  const installation=await page.evaluate(installWorkflowReviewGate,run.id);
  try {
   if(!installation.installed||installation.probes!==1||installation.probeResponses!==1)throw Error("Workflow response gate did not install and pass its native probe");
   await page.getByRole("checkbox",{name:"Automatic workflow validation",exact:true}).check();
   await page.waitForFunction(()=>{
    const gate=window.__workflowReviewGate;
    if(!gate?.installed)throw Error("Workflow response gate disappeared before review");
    return gate.held||!!gate.error;
   });
   const preparation=await page.evaluate(()=>({held:window.__workflowReviewGate.held,error:window.__workflowReviewGate.error}));
   if(preparation.error||!preparation.held)throw Error(preparation.error||"The native review response was not held");
   if(away){await history().getByRole("button").filter({hasText:skipped.name}).click();await selected(skipped.id);}
   await history().getByRole("button").filter({hasText:row.name}).click();await selected(run.id);
   if(await page.getByRole("checkbox",{name:"Automatic workflow validation",exact:true}).isChecked())throw Error("History selection did not disable automatic validation");
   await page.evaluate(()=>window.__workflowReviewGate.release());
   // Observe either an incorrect dispatch or the actual end of the pending UI
   // action. No arbitrary delay can accidentally make a cancellation test pass.
   await until(async()=>await page.evaluate(()=>window.__workflowReviewGate.executions>0)||await page.getByRole("button",{name:"Review next step",exact:true}).isEnabled(),"Deferred review did not settle after cancellation");
   const calls=await page.evaluate(()=>({reviews:window.__workflowReviewGate.reviews,executions:window.__workflowReviewGate.executions}));
   const current=await invoke("workflow_run",{id:run.id});
   if(calls.reviews!==1||calls.executions!==0||current.phase!=="ready"||current.cursor!==0||current.results[0].phase!=="pending"||fs.existsSync(path.join(root,marker)))throw Error("Cancelled automatic review dispatched a command: "+JSON.stringify(calls));
   unchanged();await shot(away?"156-auto-cancel-away-back":"155-auto-cancel-same-run");
  } catch(error) {
   const diagnostic=await page.evaluate(()=>{
    const gate=window.__workflowReviewGate;
    return gate?{installed:gate.installed,phase:gate.phase,held:gate.held,probes:gate.probes,probeResponses:gate.probeResponses,reviews:gate.reviews,executions:gate.executions,error:gate.error}:null;
   });
   throw Error(`${error.message}; workflow response gate: ${JSON.stringify(diagnostic)}`);
  } finally {
   await page.evaluate(()=>window.__workflowReviewGate?.restore());
  }
  await page.getByRole("button",{name:"Stop workflow",exact:true}).click();
  await until(async()=>(await invoke("workflow_run",{id:run.id})).phase==="cancelled","Unexecuted workflow did not stop");
 };
 await check("selecting the current run revokes a pending automatic review before command dispatch",()=>cancelledReview(false));
 await check("switching away and back cannot restore a revoked automatic review",()=>cancelledReview(true));
 await page.getByRole("button",{name:"Close Workflow Builder",exact:true}).click();
}
