// Real native UI and Git state assertions; each suite owns every repository/profile.
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import fs from "node:fs";
import path from "node:path";
import { fillWorktreeFolder, assertWorktreeFolder } from "./worktree-manager-fixture.mjs";
import {pullUpstreamSmoke} from "./pull-upstream-smoke.mjs";

export async function worktreeManagerSmoke({page,check,shot,work}) {
  await pullUpstreamSmoke({page,check,shot,work});
  const root=path.join(work,"stage11-main"),git=(p,...args)=>execFileSync("git",["-C",p,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
  fs.mkdirSync(root);git(root,"init","-qb","main");
  for(const [k,v] of [["user.name","Worktree Tester"],["user.email","worktree@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"],["core.hooksPath",".git/hooks"]])git(root,"config",k,v);
  for(const f of ["file.txt","hidden.txt","absent.txt"])fs.writeFileSync(path.join(root,f),`base ${f}\n`);
  fs.writeFileSync(path.join(root,".gitignore"),"ignored.txt\n");git(root,"add",".");git(root,"commit","-qm","Worktree base");
  const initialHead=git(root,"rev-parse","HEAD");
  const add=(name,detached=false)=>{const p=path.join(work,name);git(root,"worktree","add",...(detached?["--detach"]:["-b",name]),p,"HEAD");return p;};
  const removeFixture=p=>{const physical=fs.realpathSync.native(p),base=fs.realpathSync.native(work);if(!physical.startsWith(base+path.sep))throw new Error("Unsafe fixture cleanup");fs.rmSync(p,{recursive:true,force:true});};
  const dirty=add("wm-dirty"),locked=add("wm-locked"),detached=add("wm-detached",true);
  fs.writeFileSync(path.join(dirty,"file.txt"),"local changes\n");fs.writeFileSync(path.join(dirty,"ignored.txt"),"ignored local\n");git(root,"worktree","lock","--reason","Offline drive",locked);
  await page.evaluate(p=>window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-paths",payload:[p]}),root);
  await page.locator(".topbar .repo-current > b").filter({hasText:"stage11-main"}).waitFor();
  const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args:{repo:root,...args}});
  const modal=()=>page.locator(".modal").last();
  const fillFolder=async(destination,name)=>{
    const current=await page.locator(".topbar .repo-current").getAttribute("title");
    if(!current)throw Error("Cannot identify repository for the suggested worktree folder");
    const suggested=`${current.replace(/[\\/][^\\/]+$/,"")}/${current.replace(/\\/g,"/").split("/").pop()}-${name.replace(/[\\/]/g,"-")}`;
    await fillWorktreeFolder(page,modal(),suggested,destination);
  };
  const open=async()=>{await page.getByRole("button",{name:"Open worktree manager",exact:true}).click();await page.waitForSelector(".wm-body[aria-busy=false]");};
  const refresh=async()=>{await page.getByRole("button",{name:"Refresh worktrees",exact:true}).click();await page.waitForSelector(".wm-body[aria-busy=false]");};
  const filter=async name=>page.locator(".wm-toolbar .seg").getByRole("button",{name,exact:true}).click();
  const select=async p=>{await filter("All");await page.getByRole("textbox",{name:"Search worktrees",exact:true}).fill(path.basename(p));await page.locator(".wm-row").filter({has:page.getByText(p,{exact:true})}).click();};
  const closeModal=async label=>{await modal().getByRole("button",{name:label,exact:true}).click();};
  const until=async(fn,message,timeout=60000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await page.waitForTimeout(100);}throw new Error(message);};
  const create=async(mode,branch,p)=>{
    await page.locator(".worktree-manager").getByRole("button",{name:"New worktree",exact:true}).click();
    await modal().getByRole("button",{name:mode,exact:true}).click();
    if(mode==="Existing branch")await modal().getByRole("combobox",{name:"Worktree branch",exact:true}).selectOption(branch);
    if(mode==="New branch")await modal().getByRole("textbox",{name:"New worktree branch",exact:true}).fill(branch);
    await fillFolder(p,mode==="Detached HEAD"?"detached":branch);
    await modal().getByRole("button",{name:"Review creation",exact:true}).click();await page.waitForSelector('[data-worktree-review="create"]');
    await modal().getByRole("button",{name:"Create worktree",exact:true}).click();await page.waitForSelector(".modal",{state:"detached",timeout:180000});await page.waitForSelector(".wm-body[aria-busy=false]");
  };

  await check("worktree inventory shows independent dirty, ignored, locked and detached state with keyboard navigation",async()=>{
    await open();await select(dirty);
    await page.evaluate(async()=>{
      const original=window.fetch,url=window.__TAURI_INTERNALS__.convertFileSrc("worktree_manager_snapshot","ipc"),gate={held:false,release:null,observed:0};
      gate.restore=()=>{gate.release?.();window.fetch=original;delete window.__wmRefreshGate;};
      window.__wmRefreshGate=gate;
      window.fetch=async(input,init)=>{const response=await original.call(window,input,init);const target=typeof input==="string"?input:input.url??String(input);if(target===url&&gate.observed++===0){if(!response.ok||response.headers.get("Tauri-Response")!=="ok")throw Error("Native worktree refresh failed before the response gate");await new Promise(resolve=>{gate.release=resolve;gate.held=true;});}return response;};
      window.dispatchEvent(new Event("revqora:worktree"));
    });
    try {
      await page.waitForFunction(()=>window.__wmRefreshGate?.held===true);
      for(const name of ["Open worktree","Lock worktree","Review removal","New worktree"]){if(await page.locator(".worktree-manager").getByRole("button",{name,exact:true}).isDisabled())throw Error(`Background refresh disabled ${name}`);}
      if(await page.locator(".wm-body").evaluate(el=>getComputedStyle(el).opacity)!=="1")throw Error("Background refresh dimmed the existing worktree inventory");
      await page.getByRole("textbox",{name:"Search worktrees",exact:true}).fill("wm-dirty");
      const lock=page.locator(".wm-actions").getByRole("button",{name:"Lock worktree",exact:true});
      if(!await lock.evaluate(el=>el.scrollWidth<=el.clientWidth&&el.scrollHeight<=el.clientHeight))throw Error("Worktree action text is clipped");
      await lock.click();await modal().getByRole("button",{name:"Lock worktree",exact:true}).waitFor();
      await modal().getByRole("textbox",{name:"Worktree lock reason",exact:true}).fill("Keep typed reason during refresh");
      await page.evaluate(()=>window.__wmRefreshGate.release());
      if(await modal().getByRole("textbox",{name:"Worktree lock reason",exact:true}).inputValue()!=="Keep typed reason during refresh")throw Error("Late inventory refresh reset an active review");
      await closeModal("Cancel");await page.waitForSelector(".wm-body[aria-busy=false]");
    }finally{await page.evaluate(()=>window.__wmRefreshGate?.restore());}
    // Use the actual shipped styles for all three existing single-select forms.
    const controls=await page.evaluate(()=>{const host=document.createElement("div");host.innerHTML='<select class="input"><option>Long selected value</option></select><select class="select"><option>Long selected value</option></select><div class="search-box"><select><option>All</option></select></div><span class="spin"></span><span class="loader"></span>';document.body.append(host);host.dataset.controlsProbe="1";return [...host.querySelectorAll("select")].map(el=>{const s=getComputedStyle(el);return{padding:parseFloat(s.paddingRight),arrow:s.backgroundPosition,appearance:s.appearance};});});
    if(controls.some(s=>s.padding<32||s.appearance!=="none"||!s.arrow.includes("px")))throw Error(`Select text/chevron has insufficient space: ${JSON.stringify(controls)}`);
    try{await page.emulateMedia({reducedMotion:"reduce"});const iterations=await page.locator('[data-controls-probe] .spin,[data-controls-probe] .loader').evaluateAll(elements=>elements.map(el=>getComputedStyle(el).animationIterationCount));if(iterations.some(value=>value.split(",").some(n=>n.trim()!=="1")))throw Error("Reduced-motion loading animation still loops indefinitely");}
    finally{await page.emulateMedia({reducedMotion:null});await page.locator('[data-controls-probe]').evaluate(el=>el.remove());}
    await page.getByRole("textbox",{name:"Search worktrees",exact:true}).fill("");await filter("All");if(await page.locator(".wm-row").count()!==4)throw new Error("Worktree inventory omitted a working folder");
    await select(dirty);if(!(await page.locator(".wm-detail").innerText()).includes("1 changed files")||!(await page.locator(".wm-detail").innerText()).includes("1 ignored"))throw new Error("Dirty/ignored state missing");
    await page.getByRole("textbox",{name:"Search worktrees",exact:true}).fill("");await filter("Locked");if(await page.locator(".wm-row").count()!==1||!(await page.locator(".wm-row").innerText()).includes("Offline drive"))throw new Error("Lock reason/filter missing");
    await filter("Detached");if(await page.locator(".wm-row").count()!==1)throw new Error("Detached filter ignored");
    await filter("All");await page.locator(".wm-viewport").focus();await page.keyboard.press("End");if(await page.locator('.wm-row[aria-selected="true"]').count()!==1)throw new Error("Keyboard selection missing");await shot("90-worktree-manager");
  });
  await check("new worktree creation reviews an exact commit, invalidates edited plans and keeps source staging and edits",async()=>{
    fs.writeFileSync(path.join(root,"file.txt"),"source staged\n");git(root,"add","file.txt");fs.writeFileSync(path.join(root,"file.txt"),"source unstaged\r\n");const index=fs.readFileSync(path.join(root,".git/index"));await refresh();
    const p=path.join(work,"wm-created");await page.locator(".worktree-manager").getByRole("button",{name:"New worktree",exact:true}).click();await modal().getByRole("button",{name:"New branch",exact:true}).click();
    await modal().getByRole("textbox",{name:"New worktree branch",exact:true}).fill("created-old");await fillFolder(p,"created-old");
    await modal().getByRole("button",{name:"Review creation",exact:true}).click();await page.waitForSelector('[data-worktree-review="create"]');
    if(!(await page.locator('[data-worktree-review="create"]').innerText()).includes(initialHead))throw new Error("Creation omitted exact start SHA");
    await modal().getByRole("textbox",{name:"New worktree branch",exact:true}).fill("created-topic");if(await modal().getByRole("button",{name:"Create worktree",exact:true}).count())throw new Error("An edited creation reused consent");
    await assertWorktreeFolder(modal(),p);await modal().getByRole("button",{name:"Review creation",exact:true}).click();await page.waitForSelector('[data-worktree-review="create"]');await shot("91-worktree-create-review");
    await modal().getByRole("button",{name:"Create worktree",exact:true}).click();await page.waitForSelector(".modal",{state:"detached",timeout:180000});await page.waitForSelector(".wm-body[aria-busy=false]");
    if(git(p,"branch","--show-current")!=="created-topic"||git(p,"rev-parse","HEAD")!==initialHead||fs.readFileSync(path.join(p,"file.txt"),"utf8")!=="base file.txt\n"||!index.equals(fs.readFileSync(path.join(root,".git/index")))||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="source unstaged\r\n")throw new Error("Creation moved source edits/staging or used the wrong commit");
  });
  await check("existing and detached worktrees open as independent tabs without checking out the original branch",async()=>{
    git(root,"branch","available");await refresh();const p=path.join(work,"wm-existing");await create("Existing branch","available",p);await select(p);
    // Hold the real repo_open response, then navigate while the store is awaiting it.
    await page.evaluate(()=>{const original=window.fetch,base=window.__TAURI_INTERNALS__.convertFileSrc("","ipc");window.__wmOpenFetch=original;window.__wmOpenRelease=null;let held=false;window.fetch=async function(input,init){const response=await original.call(this,input,init);if(String(input)===base+"repo_open"&&!held){held=true;await new Promise(resolve=>{window.__wmOpenRelease=resolve;});}return response;};});
    try{
      await page.locator(".wm-detail").getByRole("button",{name:"Open worktree",exact:true}).click();await page.waitForFunction(()=>typeof window.__wmOpenRelease==="function");
      // Pending tabs now activate immediately. Return while discovery is still
      // held, then create a NEW overlay whose ownership must survive its reply.
      await page.locator(".topbar .repo-current > b").filter({hasText:"wm-existing"}).waitFor();
      await page.evaluate(p=>window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-paths",payload:[p]}),root);
      await page.locator(".topbar .repo-current > b").filter({hasText:"stage11-main"}).waitFor();
      await open();await page.getByRole("button",{name:"Close worktree manager",exact:true}).click();
      await page.getByRole("button",{name:"Open branch manager",exact:true}).click();await page.waitForSelector(".branch-manager");
      await page.evaluate(()=>window.__wmOpenRelease());
      await page.locator('.repository-item[data-repository-state="open"][aria-busy="false"]').filter({hasText:"wm-existing"}).waitFor();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      // A late reply must neither reactivate its worktree nor dismiss the newer overlay.
      await page.locator(".topbar .repo-current > b").filter({hasText:"stage11-main"}).waitFor();
      await page.locator(".branch-manager").waitFor({state:"visible"});
      await page.getByRole("button",{name:"Close branch manager",exact:true}).click();
      await page.evaluate(p=>window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-paths",payload:[p]}),p);
      await page.locator(".topbar .repo-current > b").filter({hasText:"wm-existing"}).waitFor();
    }finally{await page.evaluate(()=>{window.__wmOpenRelease?.();window.fetch=window.__wmOpenFetch;delete window.__wmOpenRelease;delete window.__wmOpenFetch;});}
    await open();await select(root);
    if(!await page.getByRole("button",{name:"Review removal",exact:true}).isDisabled())throw new Error("Main worktree removal enabled from a linked worktree");
    await select(p);if(!await page.getByRole("button",{name:"Review removal",exact:true}).isDisabled())throw new Error("Current linked worktree removal enabled");
    const d=path.join(work,"wm-created-detached");await create("Detached HEAD","",d);if(git(d,"branch","--show-current")||git(d,"rev-parse","HEAD")!==initialHead)throw new Error("Detached creation attached a branch or changed its commit");
    await select(root);await page.locator(".wm-detail").getByRole("button",{name:"Open worktree",exact:true}).click();await page.locator(".topbar .repo-current > b").filter({hasText:"stage11-main"}).waitFor();
    if(git(root,"branch","--show-current")!=="main"||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="source unstaged\r\n")throw new Error("Opening a worktree checked out or reset the original branch");await open();
  });
  await check("worktree lock reasons block removal and require an explicit reviewed unlock",async()=>{
    await select(dirty);await page.locator(".wm-detail").getByRole("button",{name:"Lock worktree",exact:true}).click();await modal().getByRole("textbox",{name:"Worktree lock reason",exact:true}).fill("Keep local work · offline drive");await modal().getByRole("button",{name:"Lock worktree",exact:true}).click();await page.waitForSelector(".modal",{state:"detached"});await page.waitForSelector(".wm-body[aria-busy=false]");
    if(!await page.getByRole("button",{name:"Review removal",exact:true}).isDisabled()||!(await page.locator(".wm-detail").innerText()).includes("Keep local work"))throw new Error("Locked worktree was removable or lost its reason");
    await page.locator(".wm-detail").getByRole("button",{name:"Unlock worktree",exact:true}).click();await modal().getByRole("button",{name:"Unlock worktree",exact:true}).click();await page.waitForSelector(".modal",{state:"detached"});await page.waitForSelector(".wm-body[aria-busy=false]");
    const state=await invoke("worktree_manager_snapshot");if(state.worktrees.find(w=>w.branch==="wm-dirty").locked)throw new Error("Unlock did not update Git registration");
  });
  await check("removal rejects stale ignored data then restores complete files, hidden flags and staging through Undo Center",async()=>{
    const p=add("wm-removal");fs.writeFileSync(path.join(p,"file.txt"),"staged\n");git(p,"add","file.txt");fs.writeFileSync(path.join(p,"file.txt"),"unstaged\r\n");
    fs.writeFileSync(path.join(p,"ignored.txt"),"before\n");git(p,"update-index","--assume-unchanged","hidden.txt");fs.writeFileSync(path.join(p,"hidden.txt"),"hidden data\n");git(p,"update-index","--skip-worktree","absent.txt");fs.unlinkSync(path.join(p,"absent.txt"));fs.writeFileSync(path.join(p,"untracked.bin"),Buffer.from([0,255,13,10]));
    const index=git(p,"ls-files","--stage","-v","-z"),sourceIndex=fs.readFileSync(path.join(root,".git/index"));await refresh();await select(p);await page.getByRole("button",{name:"Review removal",exact:true}).click();await page.waitForSelector('[data-worktree-review="remove"]');
    if(!await modal().getByRole("button",{name:"Remove worktree",exact:true}).isDisabled())throw new Error("Local changes did not require consent");
    await modal().getByRole("checkbox",{name:"Confirm removal of worktree local and ignored changes",exact:true}).check();const before=await invoke("status",{repo:p});fs.writeFileSync(path.join(p,"ignored.txt"),"after!\n");const after=await invoke("status",{repo:p});if(before.stateToken!==after.stateToken)throw new Error("Ignored-only fixture changed the ordinary status token");
    await modal().getByRole("button",{name:"Remove worktree",exact:true}).click();await modal().getByRole("alert").filter({hasText:/changed/}).waitFor();if(!fs.existsSync(p))throw new Error("Stale ignored data was removed");
    await modal().getByRole("button",{name:"Refresh removal review",exact:true}).click();await page.waitForSelector('[data-worktree-review="remove"]');if(await modal().getByRole("checkbox",{name:"Confirm removal of worktree local and ignored changes",exact:true}).isChecked())throw new Error("Removal consent survived refreshed content");
    await modal().getByRole("checkbox",{name:"Confirm removal of worktree local and ignored changes",exact:true}).check();await shot("92-worktree-removal-review");await modal().getByRole("button",{name:"Remove worktree",exact:true}).click();await page.waitForSelector('[data-worktree-removed="true"]',{timeout:180000});
    if(fs.existsSync(p)||git(root,"rev-parse","refs/heads/wm-removal")!==initialHead||!sourceIndex.equals(fs.readFileSync(path.join(root,".git/index"))))throw new Error("Removal changed branch history/source staging or kept the folder");
    await modal().getByRole("button",{name:"Open recovery checkpoint",exact:true}).click();await page.waitForSelector(".recovery-detail[data-checkpoint-id]");const recovered=path.join(work,"wm-recovered");
    await page.getByRole("textbox",{name:"Recovery destination",exact:true}).fill(recovered);await page.getByRole("textbox",{name:"Recovery worktree branch",exact:true}).fill("recovered-wm");await page.getByRole("button",{name:"Recover in new worktree",exact:true}).click();await page.waitForSelector(".recovery-success",{timeout:180000});
    if(fs.readFileSync(path.join(recovered,"file.txt"),"utf8")!=="unstaged\r\n"||git(recovered,"show",":file.txt")!=="staged"||fs.readFileSync(path.join(recovered,"ignored.txt"),"utf8")!=="after!\n"||fs.readFileSync(path.join(recovered,"hidden.txt"),"utf8")!=="hidden data\n"||fs.existsSync(path.join(recovered,"absent.txt"))||git(recovered,"ls-files","--stage","-v","-z")!==index||!fs.readFileSync(path.join(recovered,"untracked.bin")).equals(Buffer.from([0,255,13,10])))throw new Error("Complete worktree recovery lost file bytes, hidden paths or staging");
    await shot("93-worktree-recovery");await closeModal("Close");await closeModal("Close");await page.waitForSelector(".wm-body[aria-busy=false]");
  });
  await check("a replaced worktree marker cannot redirect a reviewed removal to an unrelated repository",async()=>{
    const p=add("wm-identity"),foreign=path.join(work,"wm-foreign");git(root,"clone","-q",root,foreign);const marker=path.join(p,".git"),saved=fs.readFileSync(marker);await refresh();await select(p);await page.getByRole("button",{name:"Review removal",exact:true}).click();await page.waitForSelector('[data-worktree-review="remove"]');
    // Git marks .git hidden on Windows; opening an existing hidden file with w/CREATE_ALWAYS fails EPERM.
    const replaceMarker=data=>{const fd=fs.openSync(marker,"r+");try{fs.ftruncateSync(fd,0);fs.writeFileSync(fd,data);}finally{fs.closeSync(fd);}};
    try{replaceMarker(`gitdir: ${path.join(foreign,".git")}\n`);await modal().getByRole("button",{name:"Remove worktree",exact:true}).click();await modal().getByRole("alert").waitFor();if(!fs.existsSync(p)||git(foreign,"rev-parse","HEAD")!==initialHead)throw new Error("Replaced marker redirected deletion");}
    finally{replaceMarker(saved);}await closeModal("Cancel");await page.waitForSelector(".wm-body[aria-busy=false]");
  });
  await check("an edited pending creation discards its old response and external source changes require a fresh confirmation",async()=>{
    await page.locator(".worktree-manager").getByRole("button",{name:"New worktree",exact:true}).click();await modal().getByRole("button",{name:"New branch",exact:true}).click();await modal().getByRole("textbox",{name:"New worktree branch",exact:true}).fill("wm-stale-old");const p=path.join(work,"wm-stale-new");await fillFolder(p,"wm-stale-old");
    await page.evaluate(()=>{const original=window.fetch,base=window.__TAURI_INTERNALS__.convertFileSrc("","ipc");window.__wmFetch=original;window.__wmDelayed=false;window.__wmRelease=null;window.fetch=async function(input,init){const response=await original.call(this,input,init);if(String(input)===base+"worktree_create_review"&&!window.__wmDelayed){window.__wmDelayed=true;await new Promise(resolve=>{window.__wmRelease=resolve;});}return response;};});
    try{await modal().getByRole("button",{name:"Review creation",exact:true}).click();await page.waitForFunction(()=>typeof window.__wmRelease==="function");await modal().getByRole("textbox",{name:"New worktree branch",exact:true}).fill("wm-stale-final");
      await page.evaluate(async()=>{window.__wmRelease();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      if(await modal().getByRole("button",{name:"Create worktree",exact:true}).count()||!await modal().getByRole("button",{name:"Review creation",exact:true}).isEnabled())throw new Error("Old preview reappeared or left creation permanently loading");
      await assertWorktreeFolder(modal(),p);await modal().getByRole("button",{name:"Review creation",exact:true}).click();await page.waitForSelector('[data-worktree-review="create"]');fs.writeFileSync(path.join(root,"file.txt"),"external edit after creation review\n");await modal().getByRole("button",{name:"Create worktree",exact:true}).click();await modal().getByRole("alert").filter({hasText:/repository changed/}).waitFor();if(fs.existsSync(p)||git(root,"for-each-ref","--format=%(refname)","refs/heads/wm-stale-final"))throw new Error("Stale creation changed Git or made a folder");
    }finally{await page.evaluate(()=>{window.__wmRelease?.();window.fetch=window.__wmFetch;delete window.__wmRelease;delete window.__wmFetch;});}await closeModal("Cancel");await page.waitForSelector(".wm-body[aria-busy=false]");
  });
  await check("missing-entry cleanup retains exclusions, rejects reappeared folders and pins exact detached HEADs",async()=>{
    const a=add("wm-missing-a",true),b=add("wm-missing-b",true);git(b,"commit","--allow-empty","-qm","Unique missing worktree commit");const tip=git(b,"rev-parse","HEAD");removeFixture(a);removeFixture(b);removeFixture(locked);await refresh();
    await page.getByRole("button",{name:"Review missing entries",exact:true}).click();await page.waitForSelector('[data-worktree-review="prune"]');const includeA=modal().getByRole("checkbox",{name:`Remove missing ${a}`,exact:true});await includeA.uncheck();await modal().getByRole("button",{name:"Refresh missing entries",exact:true}).click();await page.waitForSelector('[data-worktree-review="prune"]');if(await includeA.isChecked())throw new Error("An excluded stale registration was reselected");
    if(await modal().getByRole("checkbox",{name:`Remove missing ${locked}`,exact:true}).count())throw new Error("Locked missing entry was offered for pruning");
    fs.mkdirSync(b);fs.writeFileSync(path.join(b,"keep.txt"),"reappeared\n");await modal().getByRole("button",{name:"Remove 1 missing entries",exact:true}).click();await modal().getByRole("alert").waitFor();if(fs.readFileSync(path.join(b,"keep.txt"),"utf8")!=="reappeared\n")throw new Error("Prune removed a reappeared folder");removeFixture(b);
    await modal().getByRole("button",{name:"Refresh missing entries",exact:true}).click();await page.waitForSelector('[data-worktree-review="prune"]');if(await includeA.isChecked())throw new Error("Stale-result refresh forgot the explicit keep decision");await modal().getByRole("button",{name:"Remove 1 missing entries",exact:true}).click();await page.waitForSelector('[data-worktree-pruned="1"]',{timeout:180000});
    const state=await invoke("worktree_manager_snapshot");if(!state.worktrees.some(w=>w.path===a)||state.worktrees.some(w=>w.path===b)||!state.worktrees.some(w=>w.path===locked&&w.locked))throw new Error("Scoped prune removed an excluded/locked registration or kept its selected entry");
    await modal().getByRole("button",{name:"Open recovery checkpoint",exact:true}).click();await page.waitForSelector(".recovery-detail[data-checkpoint-id]");
    const options=page.locator("select[aria-label='Saved recovery reference'] option"),option=await options.evaluateAll((rows,tip)=>rows.find(o=>o.textContent.includes("Worktree HEAD:")&&o.textContent.includes(tip.slice(0,8)))?.value,tip);
    if(option===undefined)throw new Error("Pruned detached HEAD missing from recovery");await page.selectOption("select[aria-label='Saved recovery reference']",option);await page.fill("input[aria-label='Recovered local branch']","wm-pruned-recovered");await page.getByRole("button",{name:"Restore branch",exact:true}).click();await until(()=>git(root,"for-each-ref","--format=%(objectname)","refs/heads/wm-pruned-recovered")===tip,"Pruned HEAD restored the wrong commit");
    await shot("94-worktree-prune-recovery");await closeModal("Close");await closeModal("Close");await page.waitForSelector(".wm-body[aria-busy=false]");
  });
  await check("external registration changes invalidate the whole prune review and manager preferences survive reopening",async()=>{
    const a=add("wm-prune-old",true);removeFixture(a);await refresh();await page.getByRole("button",{name:"Review missing entries",exact:true}).click();await page.waitForSelector('[data-worktree-review="prune"]');
    const newPath=add("wm-prune-added-later",true);removeFixture(newPath);const before=(await invoke("worktree_manager_snapshot")).worktrees.map(w=>w.path).sort();
    const deleteButton=modal().getByRole("button",{name:/^Remove \d+ missing entries$/});await deleteButton.click();await modal().getByRole("alert").waitFor();const after=(await invoke("worktree_manager_snapshot")).worktrees.map(w=>w.path).sort();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error("A stale registry review removed old or new entries");await closeModal("Cancel");await page.waitForSelector(".wm-body[aria-busy=false]");
    await page.getByRole("textbox",{name:"Search worktrees",exact:true}).fill("");await filter("Missing");await page.getByRole("combobox",{name:"Worktree sort",exact:true}).selectOption("path");await page.getByRole("button",{name:"Close worktree manager",exact:true}).click();
    await page.keyboard.press("Control+k");await page.locator(".palette input").fill("Worktree manager");await page.keyboard.press("Enter");await page.waitForSelector(".wm-body[aria-busy=false]");if(await page.getByRole("combobox",{name:"Worktree sort",exact:true}).inputValue()!=="path"||await page.locator(".wm-toolbar .seg button.on").innerText()!=="Missing")throw new Error("Manager preferences were lost");await shot("95-worktree-missing-filter");await page.getByRole("button",{name:"Close worktree manager",exact:true}).click();
  });
}
