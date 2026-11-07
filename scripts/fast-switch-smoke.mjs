import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";
import {launch} from "./ui-driver.mjs";

export async function fastSwitchSmoke({exe,work,check,out}){
 await check("cached repositories and branch previews remain visible while fresh IPC responses are held; My branches uses Git email and recent ordering",async()=>{
  const home=path.join(work,"fast-switch"),one=path.join(home,"switch-one"),two=path.join(home,"switch-two");fs.mkdirSync(home,{recursive:true});
  const git=(root,...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true}).trim();
  const commit=(root,body,title,time,other=false)=>{fs.writeFileSync(path.join(root,"file.txt"),body+"\n");git(root,"add",".");execFileSync("git",["-C",root,"-c",`user.name=${other?"Other author":"My author"}`,"-c",`user.email=${other?"other@example.invalid":"me@example.invalid"}`,"commit","-qm",title],{windowsHide:true,env:{...process.env,GIT_AUTHOR_DATE:`${time} +0000`,GIT_COMMITTER_DATE:`${time} +0000`}});};
  for(const root of [one,two]){fs.mkdirSync(root);git(root,"init","-qb","main");git(root,"config","user.name","My author");git(root,"config","user.email","me@example.invalid");git(root,"config","commit.gpgsign","false");git(root,"config","core.autocrlf","false");commit(root,"base-body",root===one?"Switch first base":"Switch second base",1700000000);}
  git(one,"checkout","-qb","feature/mine");commit(one,"feature-body","Switch first feature",1700000200,true);git(one,"checkout","main");git(one,"-c","user.name=Other author","-c","user.email=other@example.invalid","checkout","-qb","other/person");commit(one,"other-body","Switch other feature",1700000300);git(one,"checkout","main");
  let app,page;const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const graphReady=()=>page.waitForFunction(()=>{const el=document.querySelector(".graph-scroll");return el&&el.querySelectorAll(".grow").length>0&&!el.parentElement.querySelector(".spin");});
  const open=async(root)=>{await invoke("plugin:event|emit",{event:"open-paths",payload:[root]});await page.locator(".topbar .repo-current > b").filter({hasText:path.basename(root)}).waitFor();await graphReady();};
  const preview=body=>page.waitForFunction(body=>document.querySelector(".details")?.textContent.includes(body),body);
  try{
   app=await launch({exe,profile:path.join(home,"profile"),port:0,visible:false});page=app.page;page.setDefaultTimeout(60000);await page.getByRole("button",{name:"Skip",exact:true}).click();await open(one);
   const branch=name=>page.locator(`.sidebar [data-branch-kind="local"][data-branch-name="${name}"]`);
   await branch("other/person").waitFor();
   assert.equal(await page.getByLabel("Branch list order",{exact:true}).inputValue(),"recent");
   assert.equal(await page.locator('.sidebar [data-branch-kind="local"]').first().getAttribute("data-branch-name"),"other/person");
   await page.getByRole("button",{name:"My branches",exact:true}).click();await branch("other/person").waitFor({state:"detached"});await branch("feature/mine").waitFor();
   assert.equal(await page.locator('.sidebar [data-branch-kind="local"]').first().getAttribute("data-branch-name"),"feature/mine");
   if(out){await page.screenshot({path:path.join(out,"my-branches.png")});await page.locator(".sidebar").screenshot({path:path.join(out,"my-branches-sidebar.png")});}
   await branch("main").click();await preview("base-body");await branch("feature/mine").click();await preview("feature-body");
   await open(two);await page.locator(".repository-select").filter({hasText:"switch-one"}).click();await graphReady();await preview("feature-body");await page.locator(".repository-select").filter({hasText:"switch-two"}).click();await graphReady();
   const installGate=()=>page.evaluate(async()=>{
    const bridge=window.__TAURI_INTERNALS__,original=window.fetch,held=[],counts={};let active=true;
    const commands=["repo_info","status","refs","layers_state","repo_extras","graph_rows","graph_find","commit_details","rev_diff","working_diff"];
    const urls=new Map(commands.map(c=>[bridge.convertFileSrc(c,"ipc"),c]));const probe=bridge.convertFileSrc("plugin:app|version","ipc");let probes=0;
    const replacement=function(input,init){const url=typeof input==="string"?input:input.url;if(url===probe)probes++;if(urls.has(url))counts[urls.get(url)]=(counts[urls.get(url)]??0)+1;if(url===bridge.convertFileSrc("graph_load","ipc"))counts.graph_load=(counts.graph_load??0)+1;return Reflect.apply(original,window,[input,init]).then(response=>active&&urls.has(url)&&response.ok?new Promise(resolve=>held.push(()=>resolve(response))):response);};
    if(!Reflect.set(window,"fetch",replacement)||window.fetch!==replacement)throw Error("Could not install native read-response gate");
    window.__fastSwitchGate={held,counts,restore:()=>{active=false;for(const release of held)release();window.fetch=original;delete window.__fastSwitchGate;}};
    await bridge.invoke("plugin:app|version");if(probes!==1){window.__fastSwitchGate.restore();throw Error("Native IPC did not pass through fetch gate");}return true;
   });assert(await installGate());
   const repositorySwitch=performance.now();
   await page.locator(".repository-select").filter({hasText:"switch-one"}).click();await page.locator(".topbar .repo-current > b").filter({hasText:"switch-one"}).waitFor();
   await page.waitForFunction(()=>window.__fastSwitchGate.held.length>0);
   await page.locator(".graph-rows").getByText("Switch first feature",{exact:true}).waitFor();await preview("feature-body");
   console.log(`Cached repository and diff rendered with native reads held in ${Math.round(performance.now()-repositorySwitch)} ms`);
   assert.equal(await page.getByRole("button",{name:"My branches",exact:true}).getAttribute("aria-pressed"),"true");
   const branchSwitch=performance.now();
   await branch("main").click();await preview("base-body");await branch("feature/mine").click();await preview("feature-body");
   console.log(`Two cached branch previews rendered with native reads held in ${Math.round(performance.now()-branchSwitch)} ms`);
   const counts=await page.evaluate(()=>({...window.__fastSwitchGate.counts}));assert.equal(counts.graph_load??0,0,"Activation rebuilt an unchanged graph");assert.equal(git(one,"branch","--show-current"),"main","Single branch clicks must not check out a branch");
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   // Restored working diffs are readable immediately but cannot stage/discard
   // stale hunks while their fresh native response is held.
   for(const [root,body] of [[one,"first-working-change"],[two,"second-working-change"]]){
    fs.appendFileSync(path.join(root,"file.txt"),`${body}\n`);
    await page.locator(".repository-select").filter({hasText:path.basename(root)}).click();
    await page.click(".view-tab:has-text('Changes')");await page.click("button[title='Refresh (F5)']");
    await page.locator(".changes .diff .dl.add",{hasText:body}).waitFor();
    await page.getByRole("button",{name:"Stage hunk",exact:true}).waitFor();
   }
   const index=fs.readFileSync(path.join(one,".git/index"));
   assert(await installGate());
   await page.locator(".repository-select").filter({hasText:"switch-one"}).click();
   await page.waitForFunction(()=>window.__fastSwitchGate.counts.working_diff>0&&window.__fastSwitchGate.held.length>0);
   await page.locator(".changes .diff .dl.add",{hasText:"first-working-change"}).waitFor();
   assert.equal(await page.getByRole("button",{name:"Stage hunk",exact:true}).count(),0,"Cached working diff exposed stale staging actions");
   assert.equal(await page.getByRole("button",{name:"Stash hunk",exact:true}).count(),0,"Cached working diff exposed stale stash actions");
   assert(fs.readFileSync(path.join(one,".git/index")).equals(index),"Cached preview changed the index");
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   await page.getByRole("button",{name:"Stage hunk",exact:true}).waitFor();
  }catch(error){if(out)await page?.screenshot({path:path.join(out,"fast-switch-failure.png")}).catch(()=>{});throw error;}
  finally{await page?.evaluate(()=>window.__fastSwitchGate?.restore()).catch(()=>{});if(app){for(const repo of [one,two])await invoke("unwatch_repo",{repo}).catch(()=>{});await app.close();}}
 });
}
