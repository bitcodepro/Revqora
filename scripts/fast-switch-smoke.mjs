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
   // This test holds reads while jumping between commits already in one cached history.
   await page.getByRole("combobox",{name:"History scope",exact:true}).selectOption("");
   await page.locator(".graph-rows").getByText("Switch first feature",{exact:true}).waitFor();
   const branch=name=>page.locator(`.sidebar [data-branch-kind="local"][data-branch-name="${name}"]`);
   await branch("other/person").waitFor();
   assert.equal(await page.getByLabel("Branch list order",{exact:true}).inputValue(),"recent");
   assert.equal(await page.locator('.sidebar [data-branch-kind="local"]').first().getAttribute("data-branch-name"),"other/person");
   await page.getByRole("button",{name:"My branches",exact:true}).click();await branch("other/person").waitFor({state:"detached"});await branch("feature/mine").waitFor();
   assert.equal(await page.locator('.sidebar [data-branch-kind="local"]').first().getAttribute("data-branch-name"),"feature/mine");
   if(out){await page.screenshot({path:path.join(out,"my-branches.png")});await page.locator(".sidebar").screenshot({path:path.join(out,"my-branches-sidebar.png")});}
   const commitRow=title=>page.locator(".graph-rows").getByText(title,{exact:true});
   await commitRow("Switch first base").click();await preview("base-body");await commitRow("Switch first feature").click();await preview("feature-body");
   await open(two);await page.locator(".explorer-sidebar .repository-select").filter({hasText:"switch-one"}).click();await graphReady();await preview("feature-body");await page.locator(".explorer-sidebar .repository-select").filter({hasText:"switch-two"}).click();await graphReady();
   const installGate=(commands=["repo_info","status","refs_snapshot","layers_state","repo_extras","graph_rows","graph_find","commit_details","rev_diff","working_diff"], omitSnapshotFor=null)=>page.evaluate(async ({commands,omitSnapshotFor})=>{
    const bridge=window.__TAURI_INTERNALS__,original=window.fetch,held=[],counts={},stageResponses=[];let active=true,omittedSnapshots=0;
    const urls=new Map(commands.map(command=>[bridge.convertFileSrc(command,"ipc"),command]));
    const probe=bridge.convertFileSrc("plugin:app|version","ipc");
    const stageUrl=bridge.convertFileSrc("apply_selection","ipc");
    const diffUrl=bridge.convertFileSrc("working_diff","ipc");
    const repoKey=value=>value.replaceAll("\\","/").toLowerCase();
    let probes=0;
    const replacement=async function(input,init){
      const url=typeof input==="string"?input:input.url;
      const command=urls.get(url);
      if(url===probe)probes++;
      if(command)counts[command]=(counts[command]??0)+1;
      if(url===bridge.convertFileSrc("graph_load","ipc"))counts.graph_load=(counts.graph_load??0)+1;
      const omitSnapshot=active&&url===diffUrl&&omitSnapshotFor&&repoKey(JSON.parse(init.body).repo)===repoKey(omitSnapshotFor);
      const response=await Reflect.apply(original,window,[input,init]);
      if(omitSnapshot&&response.ok){
        const diff=await response.json();
        if(Object.hasOwn(diff,"stageSnapshot"))omittedSnapshots++;
        delete diff.stageSnapshot;
        const headers=new Headers(response.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(diff),{status:response.status,headers});
      }
      if(!active)return response;
      if(url===stageUrl){
        const {repo,path,mode,stageSnapshot}=JSON.parse(init.body);
        stageResponses.push({repo,path,mode,stageSnapshot,ok:response.ok});
      }
      if(command&&response.ok){
        const {repo}=JSON.parse(init.body);
        return new Promise(resolve=>held.push({command,repo,release:()=>resolve(response)}));
      }
      return response;
    };
    if(!Reflect.set(window,"fetch",replacement)||window.fetch!==replacement)throw Error("Could not install native read-response gate");
    window.__fastSwitchGate={held,counts,stageResponses,get omittedSnapshots(){return omittedSnapshots;},restore:()=>{active=false;for(const entry of held)entry.release();window.fetch=original;delete window.__fastSwitchGate;}};
    await bridge.invoke("plugin:app|version");if(probes!==1){window.__fastSwitchGate.restore();throw Error("Native IPC did not pass through fetch gate");}return true;
   },{commands,omitSnapshotFor});assert(await installGate());
   const repositorySwitch=performance.now();
   await page.locator(".explorer-sidebar .repository-select").filter({hasText:"switch-one"}).click();await page.locator(".topbar .repo-current > b").filter({hasText:"switch-one"}).waitFor();
   await page.waitForFunction(()=>window.__fastSwitchGate.held.length>0);
   await page.locator(".graph-rows").getByText("Switch first feature",{exact:true}).waitFor();await preview("feature-body");
   console.log(`Cached repository and diff rendered with native reads held in ${Math.round(performance.now()-repositorySwitch)} ms`);
   assert.equal(await page.getByRole("button",{name:"My branches",exact:true}).getAttribute("aria-pressed"),"true");
   const branchSwitch=performance.now();
   await commitRow("Switch first base").click();await preview("base-body");await commitRow("Switch first feature").click();await preview("feature-body");
   console.log(`Two cached commit previews rendered with native reads held in ${Math.round(performance.now()-branchSwitch)} ms`);
   const counts=await page.evaluate(()=>({...window.__fastSwitchGate.counts}));assert.equal(counts.graph_load??0,0,"Activation rebuilt an unchanged graph");assert.equal(git(one,"branch","--show-current"),"main","Single branch clicks must not check out a branch");
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   const indexBytes=root=>fs.readFileSync(path.join(root,".git/index"));
   const workingFile=root=>path.join(root,"file.txt");
   const stageHunk=page.getByRole("button",{name:"Stage hunk",exact:true});
   const cachedDiff=page.locator(".changes .diff[aria-busy='true']");
   const cachedAdded=body=>cachedDiff.locator(".dl.add",{hasText:body});
   const switchToCachedDiff=async(root,body)=>{
    await page.locator(".explorer-sidebar .repository-select").filter({hasText:path.basename(root)}).click();
    await page.waitForFunction(({root,windows})=>{
      const key=value=>windows?value.replaceAll("\\","/").toLowerCase():value;
      return window.__fastSwitchGate.held.some(entry=>entry.command==="working_diff"&&key(entry.repo)===key(root));
    },{root,windows:process.platform==="win32"});
    await cachedAdded(body).waitFor();
    assert.equal(await cachedDiff.getByRole("button",{name:"Stash hunk",exact:true}).count(),0,"Cached diff exposed stash before revalidation");
    assert.equal(await cachedDiff.getByTitle("Discard hunk",{exact:true}).count(),0,"Cached diff exposed discard before revalidation");
   };
   // Cache a real diff with the optional staging capability omitted for the
   // second repository. Large native diffs would also exceed the UI cache limit.
   for(const [root,body] of [[one,"first-working-change"],[two,"second-working-change"]]){
    if(root===two)assert(await installGate([],two));
    fs.appendFileSync(workingFile(root),`${body}\n`);
    await page.locator(".explorer-sidebar .repository-select").filter({hasText:path.basename(root)}).click();
    await page.click(".view-tab:has-text('Changes')");await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator(".changes .diff[aria-busy='false'] .dl.add",{hasText:body}).waitFor();
    await stageHunk.waitFor();
    if(root===two){
     assert(await page.evaluate(()=>window.__fastSwitchGate.omittedSnapshots>0),"The second cached diff must lack a staging snapshot");
     await page.evaluate(()=>window.__fastSwitchGate.restore());
    }
   }
   const firstIndex=indexBytes(one),secondIndex=indexBytes(two),secondContent=fs.readFileSync(workingFile(two),"utf8");
   assert(await installGate(["working_diff"]));
   fs.appendFileSync(workingFile(one),"newer-working-change\n");
   await switchToCachedDiff(one,"first-working-change");
   assert.equal(await cachedAdded("second-working-change").count(),0,"Displayed a cached diff from another repository");
   assert.equal(await cachedAdded("newer-working-change").count(),0,"The new diff was not held");
   assert(indexBytes(one).equals(firstIndex)&&indexBytes(two).equals(secondIndex),"Showing a cached diff changed an index");
   await cachedDiff.getByRole("button",{name:"Stage hunk",exact:true}).click();
   await page.waitForFunction(()=>window.__fastSwitchGate.stageResponses.length>0);
   const [staged]=await page.evaluate(()=>window.__fastSwitchGate.stageResponses);
   assert(staged.ok&&staged.mode==="stage"&&staged.path==="file.txt"&&Number.isInteger(staged.stageSnapshot),"Stage did not apply the displayed snapshot");
   assert.equal(fs.realpathSync(staged.repo),fs.realpathSync(one),"Stage targeted another repository");
   assert.equal(git(one,"show",":file.txt"),"base-body\nfirst-working-change","Index contains a different snapshot from the one displayed");
   assert.equal(fs.readFileSync(workingFile(one),"utf8"),"base-body\nfirst-working-change\nnewer-working-change\n","Stage changed the newer working copy");
   assert(indexBytes(two).equals(secondIndex),"Stage touched the other repository’s index");
   assert.equal(fs.readFileSync(workingFile(two),"utf8"),secondContent);
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   await page.locator(".changes .diff[aria-busy='false'] .dl.add",{hasText:"newer-working-change"}).waitFor();

   assert(await installGate(["working_diff"]));
   await switchToCachedDiff(two,"second-working-change");
   assert.equal(await cachedDiff.getByRole("button",{name:"Stage hunk",exact:true}).count(),0,"Cached diff without a snapshot offered Stage hunk");
   assert(indexBytes(two).equals(secondIndex),"Opening the cached diff changed the other repository’s index");
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   await stageHunk.waitFor();
  }catch(error){if(out)await page?.screenshot({path:path.join(out,"fast-switch-failure.png")}).catch(()=>{});throw error;}
  finally{await page?.evaluate(()=>window.__fastSwitchGate?.restore()).catch(()=>{});if(app){for(const repo of [one,two])await invoke("unwatch_repo",{repo}).catch(()=>{});await app.close();}}
 });
}
