import fs from "node:fs";

// Real watcher -> status -> renderer proof. All files belong to the smoke fixture;
// no artificial task history, status responses or watcher events are installed.
export async function liveDiffSmoke({page,root,file,noise}) {
  await page.locator(".view-tab").filter({hasText:/Changes/}).click();
  await page.locator(".changes .file-row").filter({hasText:"watcher-user-probe.txt"}).click();
  await page.waitForSelector(".changes .diff .dl.add");
  const initial=await page.evaluate(({root,path})=>window.__TAURI_INTERNALS__.invoke("status",{repo:root}).then(s=>({state:s.stateToken,file:s.files.find(f=>f.path===path).diffToken})),{root,path:"watcher-user-probe.txt"});
  await page.evaluate(()=>{
    const original=window.fetch,base=window.__TAURI_INTERNALS__.convertFileSrc("","ipc");let release;
    const gate=new Promise(resolve=>{release=resolve;});
    const state=window.__liveDiff={statuses:[],reads:0,held:false,hold:false,release,line:document.querySelector(".changes .diff .dl"),original,loaders:0};
    state.observer=new MutationObserver(()=>{if(document.querySelector(".changes .diff .loading-center"))state.loaders++;});
    state.observer.observe(document.querySelector(".changes .diff"),{childList:true,subtree:true});
    window.fetch=async function(input,init){
      const response=await original.call(this,input,init);
      if(String(input)===`${base}status`){const s=await response.clone().json();if(s.files)state.statuses.push(s);}
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
    if(await page.getByRole("button",{name:"Stage hunk",exact:true}).count())throw Error("Stale line actions remained available during revalidation");
    await page.evaluate(()=>window.__liveDiff.release());
    await page.locator(".changes .diff .dl.add").filter({hasText:"Selected file changed for real"}).waitFor();
    await page.getByRole("button",{name:"Stage hunk",exact:true}).first().waitFor();
  } finally {
    await page.evaluate(()=>{const s=window.__liveDiff;s.release();s.observer.disconnect();window.fetch=s.original;delete window.__liveDiff;});
    fs.rmSync(noise,{force:true});
    await page.locator(".view-tab").filter({hasText:/History/}).click();
  }
}
