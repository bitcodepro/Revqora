import fs from "node:fs";
import path from "node:path";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";

export async function pullUpstreamSmoke({page,check,shot,work}) {
  await check("Pull reconciles a server-deleted branch and continues on its actual default without losing local work",async()=>{
    const remote=path.join(work,"pull-upstream-server"),root=path.join(work,"pull-upstream-client");
    const git=(p,...args)=>execFileSync("git",["-C",p,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
    fs.mkdirSync(remote);git(remote,"init","-qb","main");
    for(const [key,value]of [["user.name","Pull fixture"],["user.email","pull@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"],["core.hooksPath",".git/hooks"]])git(remote,"config",key,value);
    fs.writeFileSync(path.join(remote,"file.txt"),"base\n");git(remote,"add",".");git(remote,"commit","-qm","base");
    git(remote,"clone","-q",remote,root);git(root,"config","user.name","Pull fixture");git(root,"config","user.email","pull@example.invalid");git(root,"config","commit.gpgsign","false");git(root,"config","core.autocrlf","false");git(root,"config","core.hooksPath",".git/hooks");
    git(root,"checkout","-qb","feature/completed");fs.writeFileSync(path.join(root,"feature.txt"),"feature\n");git(root,"add",".");git(root,"commit","-qm","feature");git(root,"push","-qu","origin","feature/completed");
    git(remote,"merge","--squash","feature/completed");git(remote,"commit","-qm","squash feature");git(remote,"branch","-D","feature/completed");
    const merged=git(remote,"rev-parse","HEAD"),before=git(root,"rev-parse","HEAD"),index=fs.readFileSync(path.join(root,".git/index"));
    fs.writeFileSync(path.join(root,"file.txt"),"uncommitted user work\n");
    await page.evaluate(p=>window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-paths",payload:[p]}),root);
    await page.locator(".topbar .repo-current > b").filter({hasText:"pull-upstream-client"}).waitFor();
    // Trace this owned fixture only. Retain operation results and transient toast
    // titles so a failed continuation cannot turn into an unexplained 60s wait.
    await page.evaluate(async repo=>{
      const target=window,original=target.fetch,bridge=target.__TAURI_INTERNALS__;
      const commands=new Map(["status","refs","checkout","pull"].map(command=>[bridge.convertFileSrc(command,"ipc"),command]));
      const trace={calls:[],toasts:[],clicks:[],restore:null};target.__pullUpstreamTrace=trace;
      const intercepted=async function(input,init){
        const url=typeof input==="string"?input:input?.url,command=commands.get(url);
        if(!command)return Reflect.apply(original,target,[input,init]);
        const call={command,phase:"pending"};trace.calls.push(call);
        try{
          const response=await Reflect.apply(original,target,[input,init]);
          const value=await response.clone().json();
          call.phase=response.headers.get("Tauri-Response")==="ok"?"done":"error";
          call.result=call.phase==="error"?{kind:value.kind,message:value.message,code:value.code,stderr:value.stderr}:
            command==="status"?{branch:value.branch,oid:value.oid}:
            command==="refs"?{local:value.local.map(b=>({name:b.name,upstream:b.upstream})),remote:value.remote.map(b=>b.name)}:value;
          return response;
        }catch(error){call.phase="transport-error";call.result=String(error);throw error;}
      };
      if(!Reflect.set(target,"fetch",intercepted)||target.fetch!==intercepted)throw Error("Pull trace could not install the IPC observer");
      const observer=new MutationObserver(()=>{for(const title of document.querySelectorAll(".toast .tt"))if(!trace.toasts.includes(title.textContent))trace.toasts.push(title.textContent);});
      observer.observe(document.body,{childList:true,subtree:true});
      const clicked=event=>{const button=event.target.closest?.(".toast button");if(button)trace.clicks.push({label:button.textContent,trusted:event.isTrusted});};
      document.addEventListener("click",clicked,true);
      trace.restore=()=>{observer.disconnect();document.removeEventListener("click",clicked,true);target.fetch=original;delete target.__pullUpstreamTrace;};
      await bridge.invoke("status",{repo});
      if(!trace.calls.some(c=>c.command==="status"&&c.phase==="done"))throw Error("Pull trace did not observe real native IPC");
    },root);
    try{
    await page.locator('.topbar button[title="Pull"]').click();
    await page.getByText("Upstream unavailable; repository refreshed",{exact:true}).waitFor();
    if(git(root,"rev-parse","HEAD")!==before||git(root,"branch","--show-current")!=="feature/completed"||!index.equals(fs.readFileSync(path.join(root,".git/index")))||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="uncommitted user work\n")throw Error("Deleted-upstream reconciliation changed local branch, staging or working files");
    if(git(root,"rev-parse","origin/main")!==merged||git(root,"for-each-ref","--format=%(refname)","refs/remotes/origin/feature/completed"))throw Error("Pull did not refresh main and prune its deleted remote branch");
    await page.getByRole("button",{name:"Continue on main",exact:true}).click();
    await page.waitForFunction(()=>window.__pullUpstreamTrace.calls.some(c=>c.command==="checkout"&&c.phase!=="pending")||window.__pullUpstreamTrace.toasts.some(t=>/changed|failed|Local changes|Choose an upstream/.test(t)));
    const continuation=await page.evaluate(()=>window.__pullUpstreamTrace.calls.find(c=>c.command==="checkout"&&c.phase!=="pending"));
    if(continuation?.phase!=="done")throw Error("Continue did not successfully check out main");
    await page.getByText("Pulled",{exact:true}).waitFor();
    if(git(root,"rev-parse","HEAD")!==merged||git(root,"branch","--show-current")!=="main"||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="uncommitted user work\n"||git(root,"rev-parse","feature/completed")!==before)throw Error("Continuing on the default branch lost local work/history or did not pull main");
    await shot("pull-deleted-upstream-reconciled");
    }catch(error){
      const trace=await page.evaluate(()=>window.__pullUpstreamTrace);
      console.error("Deleted-upstream fixture diagnostics:",JSON.stringify({trace,branch:git(root,"branch","--show-current"),head:git(root,"rev-parse","HEAD"),expectedHead:merged,expectedBranch:"main",status:git(root,"status","--porcelain=v2"),indexPreserved:index.equals(fs.readFileSync(path.join(root,".git/index")))}));
      throw error;
    }finally{await page.evaluate(()=>window.__pullUpstreamTrace.restore());}
  });
}
