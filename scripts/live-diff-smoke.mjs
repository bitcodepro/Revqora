import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";

// Real watcher -> status -> renderer proof. All files belong to the smoke fixture;
// no artificial task history, status responses or watcher events are installed.
export async function liveDiffSmoke({page,root,file,noise}) {
  await page.locator(".view-tab").filter({hasText:/Changes/}).click();
  await page.locator(".changes .file-row").filter({hasText:"watcher-user-probe.txt"}).click();
  await page.waitForSelector(".changes .diff .dl.add");
  await page.locator(".changes .diff[aria-busy='false']").waitFor();
  const initial=await page.evaluate(({root,path})=>window.__TAURI_INTERNALS__.invoke("status",{repo:root}).then(s=>({state:s.stateToken,file:s.files.find(f=>f.path===path).diffToken})),{root,path:"watcher-user-probe.txt"});
  await page.evaluate(()=>{
    const original=window.fetch,base=window.__TAURI_INTERNALS__.convertFileSrc("","ipc");let release;
    const gate=new Promise(resolve=>{release=resolve;});
    const state=window.__liveDiff={statuses:[],reads:0,held:false,hold:false,release,line:document.querySelector(".changes .diff .dl"),original,loaders:0};
    state.observer=new MutationObserver(()=>{if(document.querySelector(".changes .diff .loading-center"))state.loaders++;});
    state.observer.observe(document.querySelector(".changes .diff"),{childList:true,subtree:true});
    window.fetch=async function(input,init){
      const response=await original.call(this,input,init);
      if(String(input)===`${base}status`){const s=await response.clone().json();if(s.files&&s.stateVersion>=(state.statuses.at(-1)?.stateVersion??0))state.statuses.push(s);}
      if(String(input)===`${base}working_diff`){state.reads++;if(state.hold&&!state.held){state.held=true;await gate;}}
      return response;
    };
  });
  const frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  try {
    let previous=initial.state;
    for(const text of ["1111","2222","3333"]){
      fs.writeFileSync(noise,text);
      await page.waitForFunction(({previous})=>{const s=window.__liveDiff.statuses.at(-1);return s&&s.stateToken!==previous&&s.files.some(f=>f.path==="watcher.sqlite-wal");},{previous});
      await frame();
      const observed=await page.evaluate(()=>{const s=window.__liveDiff;const latest=s.statuses.at(-1);return{state:latest.stateToken,file:latest.files.find(f=>f.path==="watcher-user-probe.txt").diffToken,reads:s.reads,loaders:s.loaders,lineKept:s.line===document.querySelector(".changes .diff .dl")&&s.line.isConnected};});
      if(observed.file!==initial.file||observed.reads||observed.loaders||!observed.lineKept)throw Error("Unrelated WAL write reloaded or hid the selected diff: "+JSON.stringify(observed));
      previous=observed.state;
    }
    await page.evaluate(()=>{window.__liveDiff.hold=true;});
    fs.appendFileSync(file,"Selected file changed for real\n");
    await page.waitForFunction(()=>window.__liveDiff.held);
    await frame();
    if(!await page.locator(".changes .diff .dl.add").count()||await page.locator(".changes .diff .loading-center").count())throw Error("Revalidation replaced readable content with a loader");
    if(await page.getByRole("button",{name:"Stash hunk",exact:true}).count()||await page.getByTitle("Discard hunk",{exact:true}).count())throw Error("Actions that change the working file remained available during revalidation");
    await page.getByRole("button",{name:"Stage hunk",exact:true}).first().click();
    await page.evaluate(()=>window.__liveDiff.release());
    await page.waitForFunction(()=>window.__liveDiff.statuses.at(-1)?.files.some(f=>f.path==="watcher-user-probe.txt"&&!f.untracked&&f.index==="A"));
    const staged=execFileSync("git",["-C",root,"show",":watcher-user-probe.txt"],{encoding:"utf8",windowsHide:true}).trim();
    if(staged!=="User changes must still be watched"||!fs.readFileSync(file,"utf8").includes("Selected file changed for real"))throw Error("Stage hunk did not preserve the visible snapshot and the newer working file");
    await page.locator(".changes .diff .dl.add").filter({hasText:"Selected file changed for real"}).waitFor();
    await page.getByRole("button",{name:"Stage hunk",exact:true}).first().waitFor();
  } finally {
    await page.evaluate(()=>{const s=window.__liveDiff;s.release();s.observer.disconnect();window.fetch=s.original;delete window.__liveDiff;});
    execFileSync("git",["-C",root,"rm","--cached","-f","--ignore-unmatch","--","watcher-user-probe.txt"],{windowsHide:true});
    fs.rmSync(noise,{force:true});
    await page.locator(".view-tab").filter({hasText:/History/}).click();
  }
}

export async function sealedLayerAttributesSmoke({page,root}) {
  await layerAttributesSmoke({page,root,attributesName:".gitattributes"});
  const config=path.join(root,".git/config"),previous=fs.readFileSync(config);
  const context=await page.locator(".changes").getAttribute("data-diff-context");
  try {
    execFileSync("git",["-C",root,"config","core.attributesFile","review-policy.attrs"],{windowsHide:true});
    await layerAttributesSmoke({page,root,attributesName:"review-policy.attrs"});
  } finally {
    fs.writeFileSync(config,previous);
    await page.locator(`.changes[data-diff-context="${context}"] .diff[aria-busy="false"]`).waitFor();
  }
}

async function layerAttributesSmoke({page,root,attributesName}) {
  const attrs=path.join(root,attributesName),noise=path.join(root,"layer-watcher.sqlite-wal");
  const previous=fs.existsSync(attrs)?fs.readFileSync(attrs):null;
  const index=fs.readFileSync(path.join(root,".git/index"));
  const invoke=(command)=>page.evaluate(({command,root})=>window.__TAURI_INTERNALS__.invoke(command,{repo:root}),{command,root});
  const before=(await invoke("layers_state")).layers.map(l=>[l.fromTree,l.toTree]);
  const context=(await invoke("status")).diffContextToken;
  await page.locator(".layer:not(.open-layer) .file-row").first().click();
  await page.locator(".layer:not(.open-layer) .file-row.selected").first().waitFor();
  await page.waitForSelector(".changes .diff .dl");
  await page.locator(`.changes[data-diff-context="${context}"] .diff[aria-busy="false"]`).waitFor();
  let monitored=false,restored=false;
  try {
    fs.writeFileSync(attrs,Buffer.concat([previous??Buffer.alloc(0),Buffer.from("\n*.ts -diff\n")]));
    await page.locator(".changes .diff").getByRole("heading",{name:"Binary file",exact:true}).waitFor();
    await page.waitForFunction(context=>document.querySelector(".changes")?.dataset.diffContext!==context,context);
    if(previous)fs.writeFileSync(attrs,previous);else fs.rmSync(attrs);
    restored=true;
    await page.waitForSelector(".changes .diff .dl");
    await page.locator(`.changes[data-diff-context="${context}"] .diff[aria-busy="false"]`).waitFor();
    await page.evaluate(()=>{
      const original=window.fetch,base=window.__TAURI_INTERNALS__.convertFileSrc("","ipc");
      const state=window.__layerNoise={original,reads:0,observed:false,present:null,version:0,line:document.querySelector(".changes .diff .dl")};
      window.fetch=async function(input,init){
        const response=await original.call(this,input,init);
        if(String(input)===`${base}rev_diff`)state.reads++;
        if(String(input)===`${base}status`){const s=await response.clone().json();if(s.files&&s.stateVersion>=state.version){state.version=s.stateVersion;state.present=s.files.some(f=>f.path==="layer-watcher.sqlite-wal");if(state.present)state.observed=true;}}
        return response;
      };
    });monitored=true;
    fs.writeFileSync(noise,"unrelated layer noise\n");
    await page.waitForFunction(()=>window.__layerNoise.observed);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const result=await page.evaluate(()=>({reads:window.__layerNoise.reads,retained:window.__layerNoise.line===document.querySelector(".changes .diff .dl")&&window.__layerNoise.line.isConnected}));
    if(result.reads||!result.retained)throw Error("Unrelated WAL invalidated a mounted sealed layer: "+JSON.stringify(result));
    const after=(await invoke("layers_state")).layers.map(l=>[l.fromTree,l.toTree]);
    if(JSON.stringify(before)!==JSON.stringify(after)||!index.equals(fs.readFileSync(path.join(root,".git/index"))))throw Error("Layer interpretation check changed trees or staging");
  } finally {
    if(!restored){if(previous)fs.writeFileSync(attrs,previous);else fs.rmSync(attrs,{force:true});}
    fs.rmSync(noise,{force:true});
    if(monitored){
      try {
        if(await page.evaluate(()=>window.__layerNoise.observed)){
          await page.waitForFunction(()=>window.__layerNoise.present===false);
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        }
      } finally {await page.evaluate(()=>{window.fetch=window.__layerNoise.original;delete window.__layerNoise;});}
    }
  }
}

export async function submoduleHeadSmoke({page,work,returnName}) {
  const root=path.join(work,"env","submodule-preview"),module=path.join(root,"module");
  fs.mkdirSync(module,{recursive:true});
  const git=(cwd,...args)=>execFileSync("git",["-C",cwd,...args],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim();
  for(const cwd of [root,module])for(const args of [["init","-q","-b","main"],["config","user.name","Tester"],["config","user.email","tester@example.com"],["config","commit.gpgsign","false"],["config","core.autocrlf","false"],["config","core.hooksPath",".git/hooks"],["config","diff.submodule","short"]])git(cwd,...args);
  const commits=[];
  for(const value of ["A","B","C"]){fs.writeFileSync(path.join(module,"file.txt"),value);git(module,"add","file.txt");git(module,"commit","-qm",value);commits.push(git(module,"rev-parse","HEAD"));}
  git(module,"checkout","-q",commits[0]);
  fs.writeFileSync(path.join(root,".gitmodules"),'[submodule "module"]\n\tpath = module\n\turl = unused\n');
  git(root,"add",".gitmodules","module");git(root,"commit","-qm","Parent records A");git(root,"submodule","absorbgitdirs","module");
  git(module,"checkout","-q",commits[1]);
  const index=fs.readFileSync(path.join(root,".git/index")),head=git(root,"rev-parse","HEAD"),raw=git(root,"status","--porcelain=v2");
  await page.evaluate(root=>window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-paths",payload:[root]}),root);
  await page.locator(".repository-item.active .repository-label").filter({hasText:/^submodule-preview$/}).waitFor();
  try {
    await page.locator(".view-tab").filter({hasText:/Changes/}).click();
    await page.locator(".changes .file-row").filter({hasText:/module/}).first().click();
    await page.locator(".changes .diff .dl.add").filter({hasText:commits[1]}).waitFor();
    git(module,"checkout","-q",commits[2]);
    await page.locator(".changes .diff .dl.add").filter({hasText:commits[2]}).waitFor();
    if(await page.locator(".changes .diff .dl.add").filter({hasText:commits[1]}).count())throw Error("Submodule B remained after switching to C");
    if(raw!==git(root,"status","--porcelain=v2")||head!==git(root,"rev-parse","HEAD")||!index.equals(fs.readFileSync(path.join(root,".git/index"))))throw Error("Submodule preview changed the parent Git state");
    git(root,"config","diff.submodule","diff");
    fs.writeFileSync(path.join(module,"file.txt"),"INLINE_ONE\n");
    await page.locator(".changes .diff .dl.add").filter({hasText:"INLINE_ONE"}).waitFor();
    const context=await page.evaluate(root=>window.__TAURI_INTERNALS__.invoke("status",{repo:root}).then(s=>s.diffContextToken),root);
    await page.locator(`.changes[data-diff-context="${context}"] .diff[aria-busy="false"]`).waitFor();
    const inlineRaw=git(root,"status","--porcelain=v2");
    fs.writeFileSync(path.join(module,"file.txt"),"INLINE_TWO\n");
    await page.locator(".changes .diff .dl.add").filter({hasText:"INLINE_TWO"}).waitFor();
    if(inlineRaw!==git(root,"status","--porcelain=v2")||!index.equals(fs.readFileSync(path.join(root,".git/index"))))throw Error("Inline preview modified the parent index or expected dirty flags");
  } finally {
    await page.locator(".repository-item.active .repository-close").click();
    await page.locator(".repository-item.active .repository-label").filter({hasText:returnName}).waitFor();
  }
  // Fixture removal belongs to the existing host-exit cleanup, not a live watcher.
}
