import { futureStagesSmoke } from "./future-stages-smoke.mjs";
import {workflowSmoke} from "./workflow-smoke.mjs";
import {forgeAccountsSmoke} from "./forge-accounts-smoke.mjs";
import {prCenterSmoke} from "./pr-center-smoke.mjs";
import {agentWorkspaceSmoke} from "./agent-workspace-smoke.mjs";
import { worktreeManagerSmoke } from "./worktree-manager-smoke.mjs";
// Independent tail suites use a fresh process/profile/repository set on each CI runner.
import fs from "node:fs";
import path from "node:path";
import { createProfile, launch } from "./ui-driver.mjs";
import { smokeTimings, SMOKE_SUITES, assertSmokeCoverage } from "./ci-timing.mjs";
import { repositoryWorkspaceSmoke } from "./repository-workspace-smoke.mjs";
import { branchManagerSmoke, branchManagerProtectionSmoke } from "./branch-manager-smoke.mjs";
import { branchCleanupSmoke } from "./branch-cleanup-smoke.mjs";

const arg=name=>process.argv[process.argv.indexOf(name)+1];
const suite=process.env.REVQORA_SMOKE_SUITE;
if(!["workspace","cleanup","worktrees"].includes(suite)||!process.argv.includes("--exe"))throw new Error("Set REVQORA_SMOKE_SUITE=workspace|cleanup|worktrees and pass --exe");
const work=createProfile(`revqora-${suite}-`),out=process.env.REVQORA_SMOKE_OUT||path.join(work,"shots");fs.mkdirSync(out,{recursive:true});
const errors=[];let app,step=SMOKE_SUITES[suite].offset,completed=0;
const shot=name=>smokeTimings.measure("activity","screenshots",()=>app.page.screenshot({path:path.join(out,`${name}.png`)}));
const check=async(name,run)=>{
  step++; console.log(`start ${step}. ${name}`);
  try{await smokeTimings.measure("scenario",`${step}. ${name}`,run);completed++;console.log(`ok   ${step}. ${name}`);}
  catch(e){await shot(`fail-${step}`).catch(()=>{});throw e;}
};
try{
  app=await launch({exe:path.resolve(arg("--exe")),profile:path.join(work,"profile"),port:0});
  const page=app.page;page.setDefaultTimeout(60000);
  const watch=p=>{p.setDefaultTimeout(60000);p.on("pageerror",e=>errors.push(String(e)));p.on("console",m=>m.type()==="error"&&errors.push(m.text()));};watch(page);
  const restart=async()=>{await app.close();app=await launch({exe:path.resolve(arg("--exe")),profile:path.join(work,"profile"),port:0});watch(app.page);return app.page;};
  await smokeTimings.measure("stage","fresh profile setup",async()=>{
    await page.getByRole("button",{name:"Skip",exact:true}).click();
    await page.waitForSelector(".modal",{state:"detached"});
    await page.getByTitle("Settings",{exact:true}).click();
    await page.locator(".modal label:has-text('Auto fetch') + .seg").getByRole("button",{name:"Off",exact:true}).click();
    await page.locator(".modal").getByRole("button",{name:"Done",exact:true}).click();
  });
  if(suite==="workspace"){
    await repositoryWorkspaceSmoke({page,check,shot,work});
    await branchManagerSmoke({page,check,shot,work});
    await branchManagerProtectionSmoke({page,check,shot,work});
  }else if(suite==="cleanup") await branchCleanupSmoke({page,check,shot,work});
  else {await worktreeManagerSmoke({page,check,shot,work});await forgeAccountsSmoke({page,check,shot,work,profile:path.join(work,"profile"),restart});await prCenterSmoke({page:app.page,check,shot,work});await agentWorkspaceSmoke({page:app.page,check,shot,work,restart});await workflowSmoke({page:app.page,check,shot,work,restart});await futureStagesSmoke({page:app.page,check,shot,work,restart});}
  assertSmokeCoverage(suite,completed);
  if(errors.length)throw new Error(errors.join(" | "));
}catch(e){console.error(e);process.exitCode=1;await app?.page.screenshot({path:path.join(out,"failure.png")}).catch(()=>{});}
finally{
  await app?.close();smokeTimings.finish();
  if(!process.argv.includes("--keep"))fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}
