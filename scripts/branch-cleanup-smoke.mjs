import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfile, launch } from "./ui-driver.mjs";

export async function branchCleanupSmoke({ page, check, shot, work }) {
  // Each process/profile restart can have its own timer. These fixtures mutate
  // server refs deliberately; timer fetching must not race their frozen reviews.
  // The separate stale-local scenario below tests an explicit Fetch invalidation.
  const timerBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem("revqora.settings")).state.autoFetchMinutes);
  await page.getByTitle("Settings",{exact:true}).click();
  await page.locator(".modal label:has-text('Auto fetch') + .seg").getByRole("button",{name:"Off",exact:true}).click();
  await page.locator(".modal").getByRole("button",{name:"Done",exact:true}).click();
  if(await page.evaluate(()=>JSON.parse(localStorage.getItem("revqora.settings")).state.autoFetchMinutes)!==0)throw new Error("Cleanup fixtures require timer auto-fetch to be off");
  console.log(`Cleanup fixture auto-fetch minutes: ${timerBefore} -> 0`);
  const git=(root,...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true}).trim();
  const fixture=async suffix=>{
    const name=`stage10-${suffix}`,root=path.join(work,name),server=path.join(work,`${name}.git`);
    fs.mkdirSync(root);git(root,"init","-qb","main");
    for(const [k,v] of [["user.name","Cleanup Tester"],["user.email","cleanup@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"],["core.hooksPath",".git/hooks"]])git(root,"config",k,v);
    fs.writeFileSync(path.join(root,"file.txt"),"retained\n");git(root,"add",".");git(root,"commit","-qm","Cleanup base");
    for(const b of ["bulk-clean-a","bulk-clean-b","bulk-clean-c"])git(root,"branch",b);
    git(root,"clone","--bare",".",server);git(server,"config","receive.denyDeleteCurrent","ignore");git(root,"remote","add","origin",server);git(root,"fetch","-q","origin");
    const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
    await invoke("plugin:event|emit",{event:"open-paths",payload:[root]});
    await page.locator(".topbar .repo-current > b").filter({hasText:name}).waitFor();
    await page.getByRole("button",{name:"Open branch manager",exact:true}).click();await page.waitForSelector(".bm-body[aria-busy=false]");
    await page.getByRole("combobox",{name:"Branch scope",exact:true}).selectOption("local");
    return {root,server,invoke,tip:git(root,"rev-parse","main")};
  };
  const search=value=>page.getByRole("textbox",{name:"Search branches",exact:true}).fill(value);
  const select=ref=>page.getByRole("checkbox",{name:`Select ${ref} for cleanup`,exact:true}).check();
  const openReview=async()=>{
    await page.getByRole("button",{name:"Review cleanup…",exact:true}).click();
    await page.waitForSelector(".branch-cleanup[aria-busy=false]",{timeout:180000});
  };
  const scope=async(ref,mode)=>{
    await page.getByRole("combobox",{name:`Deletion scope for ${ref}`,exact:true}).selectOption(mode);
    await page.waitForSelector(".branch-cleanup[aria-busy=false]",{timeout:180000});
  };
  const run=async(count,{expectStale=false}={})=>{
    await page.getByRole("button",{name:`Delete ${count} selected`,exact:true}).click();
    await page.waitForFunction(()=>{
      const root=document.querySelector(".branch-cleanup");
      return root?.getAttribute("aria-busy")==="false" && (document.querySelector(".modal-head h3")?.textContent==="Branch cleanup results" || !!root.querySelector(':scope > .bc-error[role="alert"]'));
    },null,{timeout:180000});
    const error=page.locator('.branch-cleanup > .bc-error[role="alert"]');
    if(expectStale){
      if(!await error.count() || !(await error.innerText()).includes("The repository changed since this action was prepared"))throw new Error("Expected the outer stale-operation rejection");
      if(await page.getByRole("heading",{name:"Branch cleanup results",exact:true}).count() || await page.locator("[data-cleanup-status]").count())throw new Error("Outer rejection incorrectly rendered a batch report");
      if(await page.getByRole("button",{name:/^Delete \d+ selected$/}).count())throw new Error("Stale confirmation remained reusable");
      return;
    }
    if(await error.count())throw new Error(`Cleanup failed before producing a report: ${await error.innerText()}`);
    await page.getByRole("heading",{name:"Branch cleanup results",exact:true}).waitFor();
  };
  const close=async()=>{
    await page.locator(".modal").getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("button",{name:"Close branch manager",exact:true}).click();
  };
  const exists=(root,name)=>!!git(root,"for-each-ref","--format=%(objectname)",`refs/heads/${name}`);
  await check("excluded cleanup branches stay excluded after scope, base and review refresh changes",async()=>{
    const {root,server,tip}=await fixture("exclusions");
    git(root,"branch","keep-base");
    git(root,"checkout","-qb","bulk-risk");fs.writeFileSync(path.join(root,"new.txt"),"unique\n");git(root,"add",".");git(root,"commit","-qm","Unmerged history for consent reset");git(root,"checkout","main");
    await page.getByRole("button",{name:"Refresh branches",exact:true}).click();await page.waitForSelector(".bm-body[aria-busy=false]");
    for(const name of ["bulk-clean-a","bulk-clean-b","bulk-risk"]){await search(name);await select(`refs/heads/${name}`);}
    await openReview();
    const a=page.getByRole("checkbox",{name:"Include refs/heads/bulk-clean-a",exact:true});
    const consent=page.getByRole("checkbox",{name:"Allow unmerged deletion for refs/heads/bulk-risk",exact:true});
    await a.uncheck();await consent.check();
    const assertKept=async()=>{
      if(await a.isChecked())throw new Error("Explicitly excluded A was re-included");
      if(await consent.isChecked())throw new Error("Force consent survived a fresh review");
      if(!await page.getByRole("button",{name:"Delete 2 selected",exact:true}).isDisabled())throw new Error("Fresh unmerged review skipped renewed consent");
    };
    await scope("refs/heads/bulk-clean-b","both");await assertKept();await consent.check();
    const comparison=page.getByRole("combobox",{name:"Cleanup comparison base",exact:true});if(await comparison.inputValue()==="refs/heads/keep-base")throw new Error("Consent-reset scenario requires an actual base change");await comparison.selectOption("refs/heads/keep-base");await page.waitForSelector('.branch-cleanup[aria-busy=false][data-cleanup-base="refs/heads/keep-base"]',{timeout:180000});await assertKept();await consent.check();
    await page.getByRole("button",{name:"Refresh review",exact:true}).click();await page.waitForSelector(".branch-cleanup[aria-busy=false]",{timeout:180000});await assertKept();
    await page.getByRole("checkbox",{name:"Include refs/heads/bulk-risk",exact:true}).uncheck();
    await shot("88-bulk-cleanup-exclusions");await run(1);
    if(!exists(root,"bulk-clean-a")||!exists(server,"bulk-clean-a")||git(root,"rev-parse","bulk-clean-a")!==tip||!exists(root,"bulk-risk")||exists(root,"bulk-clean-b")||exists(server,"bulk-clean-b"))throw new Error("Cleanup deleted an explicitly kept branch or retained the selected destination");
    await close();
  });
  await check("bulk cleanup selects a filter, keeps hidden selections and deletes reviewed mixed scopes with recovery",async()=>{
    const {root,server,tip}=await fixture("mixed");
    fs.writeFileSync(path.join(root,"file.txt"),"manual changes kept\n");const index=fs.readFileSync(path.join(root,".git/index"));
    await search("bulk-clean");await page.getByRole("button",{name:"Select shown (up to 50)",exact:true}).click();
    await search("bulk-clean-a");await page.locator(".bm-bulk").getByText("3 selected · 2 hidden by filter",{exact:true}).waitFor();
    await openReview();await scope("refs/heads/bulk-clean-b","both");await scope("refs/heads/bulk-clean-c","remote");
    await shot("83-bulk-cleanup-review");await run(3);
    if(await page.locator('[data-cleanup-status="deleted"]').count()!==3)throw new Error("Mixed cleanup did not complete three rows");
    if(exists(root,"bulk-clean-a")||exists(root,"bulk-clean-b")||!exists(root,"bulk-clean-c")||!exists(server,"bulk-clean-a")||exists(server,"bulk-clean-b")||exists(server,"bulk-clean-c"))throw new Error("Cleanup removed the wrong local/server refs");
    if(!fs.readFileSync(path.join(root,".git/index")).equals(index)||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="manual changes kept\n")throw new Error("Cleanup modified manual work");
    const recovery=page.locator('[data-cleanup-status="deleted"]').first().getByRole("button",{name:/Open recovery checkpoint/});
    if(await recovery.count()!==1)throw new Error("Successful deletion lost its checkpoint link");
    await shot("84-bulk-cleanup-result");await recovery.click();await page.getByRole("heading",{name:/Undo Center/}).waitFor();
    // The saved exact tip remains reachable from the hidden recovery pins.
    const refs=git(root,"for-each-ref","--format=%(refname)","refs/revqora/recovery");
    if(!refs)throw new Error("Cleanup did not retain recovery pins");
    if(git(root,"rev-parse","main")!==tip)throw new Error("Cleanup changed main");
    await page.locator(".modal").getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("button",{name:"Close branch manager",exact:true}).click();
  });
  await check("bulk review excludes protected actual remote targets and requires per-row unmerged consent",async()=>{
    const {root}=await fixture("consent");
    git(root,"config","branch.bulk-clean-b.remote","origin");git(root,"config","branch.bulk-clean-b.merge","refs/heads/main");
    git(root,"config","remote.origin.fetch","+refs/heads/main:refs/remotes/origin/innocent");git(root,"fetch","-q","origin");
    git(root,"checkout","-qb","bulk-risk");fs.writeFileSync(path.join(root,"new.txt"),"unique\n");git(root,"add",".");git(root,"commit","-qm","Unique history");git(root,"checkout","main");
    await page.getByRole("button",{name:"Refresh branches",exact:true}).click();await page.waitForSelector(".bm-body[aria-busy=false]");
    await search("bulk-clean-b");await select("refs/heads/bulk-clean-b");await search("bulk-risk");await select("refs/heads/bulk-risk");await openReview();
    await scope("refs/heads/bulk-clean-b","both");
    const protectedRow=page.locator('[data-cleanup-ref="refs/heads/bulk-clean-b"]');
    await protectedRow.getByRole("alert").filter({hasText:"main is protected"}).waitFor();
    if(!await protectedRow.getByRole("checkbox",{name:"Include refs/heads/bulk-clean-b",exact:true}).isDisabled())throw new Error("Protected upstream allowed selection");
    if(!await page.getByRole("button",{name:"Delete 1 selected",exact:true}).isDisabled())throw new Error("Unmerged deletion skipped explicit consent");
    await page.getByRole("checkbox",{name:"Allow unmerged deletion for refs/heads/bulk-risk",exact:true}).check();
    if(!await page.getByRole("button",{name:"Delete 1 selected",exact:true}).isEnabled())throw new Error("Per-row consent did not enable eligible cleanup");
    await shot("85-bulk-cleanup-protection");await run(1);
    if(exists(root,"bulk-risk")||!exists(root,"bulk-clean-b")||!exists(root,"main"))throw new Error("Risk consent changed another row");
    await close();
  });
  await check("a server tip changed after bulk review prevents every selected deletion",async()=>{
    const {root,server,invoke}=await fixture("stale");
    await search("bulk-clean-a");await select("refs/heads/bulk-clean-a");await search("bulk-clean-b");await select("refs/heads/bulk-clean-b");await openReview();await scope("refs/heads/bulk-clean-b","both");
    const before=await invoke("status",{repo:root});
    const trackingBefore=git(root,"rev-parse","refs/remotes/origin/bulk-clean-b");
    const indexBefore=fs.readFileSync(path.join(root,".git/index"));
    const aBefore=git(root,"rev-parse","refs/heads/bulk-clean-a");
    const bBefore=git(root,"rev-parse","refs/heads/bulk-clean-b");
    const previous=git(server,"rev-parse","refs/heads/bulk-clean-b");
    // A URL push from root can also update its tracking cache. Simulate another
    // actor directly on the bare server so only the SERVER SHA changes.
    const next=git(server,"-c","user.name=Peer","-c","user.email=peer@example.invalid","-c","commit.gpgsign=false","commit-tree",git(server,"rev-parse",`${previous}^{tree}`),"-p",previous,"-m","Server changed after review");
    git(server,"update-ref","refs/heads/bulk-clean-b",next,previous);
    if((await invoke("status",{repo:root})).stateToken!==before.stateToken)throw new Error("Server-only fixture changed the local repository state");
    await run(2);await page.getByRole("alert").filter({hasText:"Preflight failed"}).waitFor();
    if(git(root,"rev-parse","refs/heads/bulk-clean-a")!==aBefore || git(root,"rev-parse","refs/heads/bulk-clean-b")!==bBefore || git(root,"rev-parse","refs/remotes/origin/bulk-clean-b")!==trackingBefore || git(server,"rev-parse","refs/heads/bulk-clean-a")!==aBefore || git(server,"rev-parse","refs/heads/bulk-clean-b")!==next || !fs.readFileSync(path.join(root,".git/index")).equals(indexBefore))throw new Error("Failed preflight changed the reviewed local state or server tips");
    await shot("86-bulk-cleanup-stale");await close();
  });
  await check("a fetched tracking update rejects the whole stale confirmation before batch preflight",async()=>{
    const {root,server,invoke}=await fixture("stale-local");
    await search("bulk-clean-a");await select("refs/heads/bulk-clean-a");await search("bulk-clean-b");await select("refs/heads/bulk-clean-b");await openReview();await scope("refs/heads/bulk-clean-b","both");
    const before=await invoke("status",{repo:root});
    const aBefore=git(root,"rev-parse","refs/heads/bulk-clean-a"),bBefore=git(root,"rev-parse","refs/heads/bulk-clean-b");
    const indexBefore=fs.readFileSync(path.join(root,".git/index"));
    const next=git(server,"-c","user.name=Peer","-c","user.email=peer@example.invalid","-c","commit.gpgsign=false","commit-tree",git(server,"rev-parse",`${bBefore}^{tree}`),"-p",bBefore,"-m","Peer update before fetch");
    git(server,"update-ref","refs/heads/bulk-clean-b",next,bBefore);
    if((await invoke("status",{repo:root})).stateToken!==before.stateToken)throw new Error("Server-only update invalidated the local confirmation");
    git(root,"fetch","-q","origin");
    if(git(root,"rev-parse","refs/remotes/origin/bulk-clean-b")!==next || (await invoke("status",{repo:root})).stateToken===before.stateToken)throw new Error("Fetch did not invalidate the reviewed tracking ref/state token");
    await run(2,{expectStale:true});
    if(git(root,"rev-parse","refs/heads/bulk-clean-a")!==aBefore || git(root,"rev-parse","refs/heads/bulk-clean-b")!==bBefore || git(root,"rev-parse","refs/remotes/origin/bulk-clean-b")!==next || git(server,"rev-parse","refs/heads/bulk-clean-a")!==aBefore || git(server,"rev-parse","refs/heads/bulk-clean-b")!==next || !fs.readFileSync(path.join(root,".git/index")).equals(indexBefore))throw new Error("Outer stale-operation rejection changed local/server refs or staging");
    await shot("89-bulk-cleanup-stale-local");await close();
  });
  await check("bulk server rejection reports partial local removal, saved checkpoints and skipped remaining rows",async()=>{
    const {root,server}=await fixture("partial");
    const hook=path.join(server,"hooks/pre-receive");fs.writeFileSync(hook,"#!/bin/sh\nexit 1\n");if(process.platform!=="win32")fs.chmodSync(hook,0o755);
    await search("bulk-clean-a");await select("refs/heads/bulk-clean-a");await search("bulk-clean-b");await select("refs/heads/bulk-clean-b");await openReview();await scope("refs/heads/bulk-clean-a","both");await run(2);
    if(await page.locator('[data-cleanup-status="partial"]').count()!==1||await page.locator('[data-cleanup-status="skipped"]').count()!==1)throw new Error("Partial cleanup result is inaccurate");
    if(exists(root,"bulk-clean-a")||!exists(server,"bulk-clean-a")||!exists(root,"bulk-clean-b"))throw new Error("Server rejection did not stop the batch");
    if(!await page.locator('[data-cleanup-status="partial"]').getByRole("button",{name:/Open recovery checkpoint/}).count())throw new Error("Partial deletion lost recovery checkpoint");
    await shot("87-bulk-cleanup-partial");await close();
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const work=createProfile("branch-cleanup-");const exe=process.argv[process.argv.indexOf("--exe")+1];if(!process.argv.includes("--exe"))throw new Error("Pass --exe <built application>");
  const out=process.env.REVQORA_SMOKE_OUT||path.join(work,"shots");fs.mkdirSync(out,{recursive:true});
  const app=await launch({exe,profile:path.join(work,"profile"),port:0});const errors=[];app.page.on("pageerror",e=>errors.push(e.message));
  try{
    await app.page.getByRole("button",{name:"Skip",exact:true}).click({timeout:60000});
    await app.page.getByTitle("Settings",{exact:true}).click();await app.page.locator(".modal label:has-text('Auto fetch') + .seg").getByRole("button",{name:"Off",exact:true}).click();await app.page.locator(".modal").getByRole("button",{name:"Done",exact:true}).click();
    await branchCleanupSmoke({page:app.page,work,check:async(name,fn)=>{await fn();console.log(`PASS ${name}`);},shot:name=>app.page.screenshot({path:path.join(out,`${name}.png`)})});
    if(errors.length)throw new Error(errors.join("\n"));
  }catch(e){await app.page.screenshot({path:path.join(out,"failure.png")}).catch(()=>{});throw e;}
  finally{await app.close();fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
}
