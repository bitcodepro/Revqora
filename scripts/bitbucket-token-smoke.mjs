// A real authenticated HTTP clone followed by PR access with the approved Git
// credential. Profile access is forbidden by the fixture, not just unrequested.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";
import {launch} from "./ui-driver.mjs";
import {openRepository,repositoryIsActive} from "./ui-readiness.mjs";

export async function bitbucketTokenSmoke({exe,work,check,out}) {
  await check("an authenticated Git clone token connects Bitbucket PRs without re-entry or profile permission and persists only in the encrypted vault",async()=>{
    const home=path.join(work,"bitbucket-token"),seed=path.join(home,"seed"),bare=path.join(home,"remote.git"),parent=path.join(home,"clones"),root=path.join(parent,"repo"),profile=path.join(home,"profile");
    fs.mkdirSync(seed,{recursive:true});fs.mkdirSync(parent);
    const config=path.join(home,"gitconfig");fs.writeFileSync(config,"[credential]\n\thelper =\n\tuseHttpPath = true\n");
    const git=(cwd,...args)=>execFileSync("git",["-C",cwd,...args],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_CONFIG_GLOBAL:config,GIT_CONFIG_NOSYSTEM:"1",GIT_OPTIONAL_LOCKS:"0"}}).trim();
    git(seed,"init","-qb","main");for(const [k,v] of [["user.name","Token Tester"],["user.email","token@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"]])git(seed,"config",k,v);
    fs.writeFileSync(path.join(seed,".gitattributes"),"* text eol=lf\n");fs.writeFileSync(path.join(seed,"file.txt"),"credential fixture\n");git(seed,"add",".");git(seed,"commit","-qm","Token clone fixture");git(home,"clone","--bare",seed,bare);git(bare,"update-server-info");const head=git(seed,"rev-parse","HEAD");
    git(bare,"branch","topic",head);git(bare,"update-server-info");
    const token="scoped-bitbucket-fixture-token",secondToken="other-bitbucket-fixture-token",password="portable bitbucket test vault",user="fixture-user",email="fixture@example.invalid",seen=[];
    const anonymousToken="anonymous-bitbucket-fixture-token";
    let denyPrList=false,denyPrFiles=false;
    const pr={id:7,title:"Scoped Bitbucket PR",description:"Token with repository and PR scopes only",state:"OPEN",author:{display_name:"Fixture Author",nickname:"fixture-author",uuid:"{author}"},source:{branch:{name:"topic"},commit:{hash:head.slice(0,12)}},destination:{branch:{name:"main"},commit:{hash:head.slice(0,12)}},updated_on:"2026-01-01T00:00:00Z",participants:[{user:{display_name:"Alex Reviewer"},approved:true},{user:{display_name:"Sam Reviewer"},state:"changes_requested"}]};
    const server=http.createServer(async(req,res)=>{
      const url=new URL(req.url,"http://fixture"),auth=req.headers.authorization??"";
      let body="";for await(const chunk of req)body+=chunk;
      // Do not retain Authorization headers or prompt values in test artifacts.
      const gitAuth=`Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,apiAuth=`Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
      seen.push({path:url.pathname,method:req.method,authorized:auth===apiAuth||auth===gitAuth,account:auth===`Bearer ${secondToken}`?"second":"first",body});
      const send=(status,value)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value));};
      if(url.pathname.startsWith("/team/repo.git/")){
        if(auth!==gitAuth){res.writeHead(401,{"www-authenticate":'Basic realm="Git fixture"'});res.end();return;}
        const relative=decodeURIComponent(url.pathname.slice("/team/repo.git/".length)),file=path.resolve(bare,relative);
        if(!file.startsWith(bare+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
        res.writeHead(200,{"content-type":"text/plain"});res.end(fs.readFileSync(file));return;
      }
      if(url.pathname==="/2.0/user")return send(403,{error:{message:"Profile permission deliberately unavailable"}});
      if(auth!==apiAuth&&auth!==`Bearer ${secondToken}`&&auth!==`Bearer ${anonymousToken}`)return send(401,{error:{message:"Token rejected"}});
      if((denyPrList&&url.pathname==="/2.0/repositories/team/repo/pullrequests")||(denyPrFiles&&url.pathname.endsWith("/pullrequests/7/diff"))){
        return send(403,{error:{message:"Repository scopes deliberately unavailable"}});
      }
      if(url.pathname===`/2.0/repositories/team/repo/commit/${head.slice(0,12)}`)return send(200,{hash:head});
      if(url.pathname.endsWith("/pullrequests/7/diff")){res.writeHead(302,{location:`/2.0/repositories/team/repo/diff/team/repo:${head.slice(0,12)}%0D${head.slice(0,12)}?from_pullrequest_id=7&topic=true`});res.end();return;}
      if(url.pathname===`/2.0/repositories/team/repo/diff/team/repo:${head}%0D${head}`){res.writeHead(200,{"content-type":"text/plain"});res.end("diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n");return;}
      if(url.pathname===`/2.0/repositories/team/repo/commit/${head}/statuses`)return send(200,{values:[{name:"Build fixture",state:"SUCCESSFUL"}]});
      if(url.pathname==="/2.0/repositories/team/repo/pullrequests")return send(200,{values:[pr]});
      if(url.pathname==="/2.0/repositories/team/other/pullrequests")return send(200,{values:[]});
      if(url.pathname.endsWith("/comments")&&req.method==="POST")return send(201,{id:1,content:{raw:JSON.parse(body).content.raw}});
      if(url.pathname.endsWith("/comments")||url.pathname.endsWith("/diffstat")||url.pathname.endsWith("/statuses"))return send(200,{values:[]});
      if(url.pathname.endsWith("/pullrequests/7"))return send(200,pr);
      return send(404,{error:{message:`Unimplemented fixture path ${url.pathname}`}});
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const url=`http://127.0.0.1:${server.address().port}`;
    let app,page;
    const start=async()=>{
      const old={GIT_CONFIG_GLOBAL:process.env.GIT_CONFIG_GLOBAL,GIT_CONFIG_NOSYSTEM:process.env.GIT_CONFIG_NOSYSTEM};
      try{process.env.GIT_CONFIG_GLOBAL=config;process.env.GIT_CONFIG_NOSYSTEM="1";app=await launch({exe,profile,port:0,visible:false});page=app.page;page.setDefaultTimeout(60000);}
      finally{for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
      if(await page.getByRole("heading",{name:"Welcome to Revqora",exact:true}).isVisible())await page.getByRole("button",{name:"Skip",exact:true}).click();
    };
    const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
    const modal=()=>page.locator(".modal").last(),button=name=>modal().getByRole("button",{name,exact:true});
    try{
      await start();
      await openRepository(page,seed);
      await page.locator(".main-head").getByRole("button",{name:"Pull requests",exact:true}).click();
      const localCenter=page.getByRole("region",{name:"Pull Request Center",exact:true});
      await localCenter.getByText("No remote configured",{exact:true}).waitFor();
      assert.equal(await localCenter.getByRole("alert").count(),0);
      await localCenter.getByRole("button",{name:"Add remote…",exact:true}).click();
      await modal().getByRole("heading",{name:"Add remote",exact:true}).waitFor();
      await button("OK").click();
      await modal().getByRole("heading",{name:"URL for origin",exact:true}).waitFor();
      await modal().getByRole("textbox").fill(`${url}/team/repo.git`);
      await button("OK").click();
      await localCenter.getByRole("alert").filter({hasText:"Configure an API connection first."}).waitFor();
      assert.equal(git(seed,"remote","get-url","origin"),`${url}/team/repo.git`);
      git(seed,"remote","remove","origin");
      await page.locator(".main-head").getByTitle("Refresh (F5)",{exact:true}).click();
      await localCenter.getByText("No remote configured",{exact:true}).waitFor();

      await page.getByTitle("Command palette (Ctrl+K)",{exact:true}).click();await page.waitForFunction(()=>document.activeElement===document.querySelector(".palette input"));await page.locator(".palette input").fill("Clone repository");await page.locator(".palette-item").filter({hasText:"Clone repository…"}).click();
      await page.getByRole("textbox",{name:"Repository URL",exact:true}).fill(`git clone http://${user}@127.0.0.1:${server.address().port}/team/repo.git`);
      await page.waitForFunction(()=>document.querySelector('[aria-label="Clone folder name"]')?.value==="repo");
      await page.getByRole("textbox",{name:"Clone parent folder",exact:true}).fill(parent);await button("Clone").click();
      await page.getByRole("heading",{name:"Password required",exact:true}).waitFor();await modal().locator('input[type="password"]').fill(token);await button("Continue").click();
      await page.waitForFunction(repositoryIsActive,{expected:root,windows:process.platform==="win32"});assert.equal(git(root,"rev-parse","HEAD"),head);
      await page.getByTitle("Accounts and API connections",{exact:true}).click();await page.waitForSelector(".fa-workspace[aria-busy=false]");
      await modal().getByText("origin · Git credentials (automatic)",{exact:true}).waitFor();
      await modal().getByLabel("Vault password",{exact:true}).fill(password);await modal().getByLabel("Confirm vault password",{exact:true}).fill(password);await button("Create vault").click();await page.waitForSelector(".fa-workspace[aria-busy=false]");
      await button("Add API account").click();await modal().getByLabel("API provider",{exact:true}).selectOption("bitbucket");await modal().getByLabel("API server URL",{exact:true}).fill(url);
      assert.equal(await modal().getByLabel("Read Bitbucket profile",{exact:true}).isChecked(),false);
      await modal().getByLabel("Use existing Git token",{exact:true}).check();assert.equal(await modal().getByLabel("API access token",{exact:true}).count(),0);
      await modal().getByLabel("Bitbucket token type",{exact:true}).selectOption("basic");
      assert.equal(await button("Save token connection").isEnabled(),false);
      await modal().getByLabel("Atlassian email",{exact:true}).fill(email);
      await modal().getByLabel("Save API token in encrypted vault",{exact:true}).check();await button("Save token connection").click();await page.waitForSelector(".fa-card");await page.waitForSelector(".fa-workspace[aria-busy=false]");
      const snapshot=await invoke("forge_accounts_snapshot"),account=snapshot.accounts[0];assert.equal(account.identityVerified,false);assert.equal(account.storage,"encrypted");assert.equal(account.authUsername,email);assert(!JSON.stringify(snapshot).includes(token));
      await modal().getByText(`origin · ${email}`,{exact:true}).waitFor();
      assert(!fs.readFileSync(path.join(profile,"revqora-data","accounts","accounts.json"),"utf8").includes(token));
      await modal().locator(".fa-card").getByRole("button",{name:"Test connection",exact:true}).click();await page.waitForSelector(".fa-workspace[aria-busy=false]");assert.equal(await modal().getByRole("alert").count(),0);
      git(root,"remote","add","upstream",`${url}/team/other.git`);
      const added=await invoke("forge_account_add",{expected:(await invoke("forge_accounts_snapshot")).revision,input:{id:null,kind:"bitbucket",server:url,username:"second@example.invalid",token:secondToken,authMode:"bearer",persist:false,verifyIdentity:false,gitSource:null}}),second=added.accounts.find(a=>a.id!==account.id);
      const bind=async(name,id)=>{const c=await invoke("forge_connections",{repo:root}),r=c.remotes.find(r=>r.name===name);await invoke("forge_connection_select",{repo:root,expected:c.revision,selection:{remote:name,fingerprint:r.fingerprint,accountId:id,allowSshAlias:false}});};
      for(const id of [second.id,account.id]){
        await bind("upstream",id);await bind("origin",account.id);await button("Refresh API accounts").click();await page.waitForSelector(".fa-workspace[aria-busy=false]");await modal().getByLabel("API remote",{exact:true}).selectOption("upstream");
        const before=seen.length;await modal().locator(`.fa-card[data-account-id="${id}"]`).getByRole("button",{name:"Test connection",exact:true}).click();await page.waitForSelector(".fa-workspace[aria-busy=false]");assert.equal(await modal().getByRole("alert").count(),0);
        const calls=seen.slice(before).filter(r=>r.path.includes("/pullrequests"));assert.equal(calls.length,1);assert.equal(calls[0].path,"/2.0/repositories/team/other/pullrequests");assert.equal(calls[0].account,id===second.id?"second":"first");assert.equal((await invoke("forge_connections",{repo:root})).activeRemote,"origin");
      }
      await button("Close").click();await page.getByRole("button",{name:"Pull requests",exact:true}).click();await page.getByText("Scoped Bitbucket PR",{exact:true}).first().waitFor();
      denyPrList=true;
      await page.getByRole("button",{name:"Refresh pull requests",exact:true}).click();
      const deniedList=page.locator(".pr-center").getByRole("alert").filter({hasText:"read:pullrequest:bitbucket"});
      await deniedList.waitFor();assert.match(await deniedList.innerText(),/read:repository:bitbucket/);
      denyPrList=false;
      await deniedList.getByRole("button",{name:"Try again",exact:true}).click();
      await page.getByText("Scoped Bitbucket PR",{exact:true}).first().waitFor();
      await page.getByRole("combobox",{name:"Pull request author",exact:true}).selectOption("mine");await page.getByRole("heading",{name:"Your PR author",exact:true}).waitFor();await modal().getByLabel("My PR author",{exact:true}).selectOption("id:{author}");await button("Use as my author").click();await page.locator('[data-pr-detail="7"]').waitFor();
      const detailPanel=page.locator('[data-pr-detail="7"]');
      const prButton=name=>detailPanel.getByRole("button",{name,exact:true});
      await prButton("Overview").click();
      await detailPanel.getByText("Approved · 1",{exact:true}).waitFor();
      await detailPanel.getByText("Changes requested · 1",{exact:true}).waitFor();
      await detailPanel.getByText("Sam Reviewer",{exact:true}).waitFor();
      await prButton("Merge on Bitbucket").waitFor();
      if(out)await page.screenshot({path:path.join(out,"bitbucket-review-overview.png")});
      assert.equal(seen.filter(r=>r.path.endsWith("/statuses")).length,0,"Overview must not request CI checks before the user asks");
      await prButton("Load checks").click();
      await detailPanel.getByText("Build fixture",{exact:true}).waitFor();
      assert.equal(seen.filter(r=>r.path.endsWith("/statuses")).length,1);
      pr.state="DECLINED";
      await prButton("Reload request").click();
      await detailPanel.getByText("Declined",{exact:true}).waitFor();
      assert.equal(await prButton("Merge on Bitbucket").count(),0);
      pr.state="OPEN";
      await prButton("Reload request").click();
      await prButton("Merge on Bitbucket").waitFor();
      denyPrFiles=true;
      await page.getByRole("button",{name:"Files",exact:true}).click();
      await detailPanel.getByRole("alert").filter({hasText:"read:repository:bitbucket"}).waitFor();
      denyPrFiles=false;
      await prButton("Reload PR files").click();
      await page.locator('[data-pr-file="file.txt"]').waitFor();await page.getByText("after",{exact:true}).first().waitFor();
      const result=await invoke("pr_page",{repo:root,state:"open",cursor:null}),connection=result.forge.connectionRevision;
      const detail=await invoke("pr_detail",{repo:root,number:7,expectedConnection:connection});
      const checkout=expectedHead=>page.evaluate(async args=>{
        let timeout;
        try {
          const result=window.__TAURI_INTERNALS__.invoke("pull_request_checkout",args).then(branch=>({branch}),error=>({error:{kind:error.kind,message:error.message}}));
          return await Promise.race([result,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("Bitbucket PR checkout did not return within 30 seconds")),30000);})]);
        } finally { clearTimeout(timeout); }
      },{repo:root,number:7,expectedConnection:connection,expectedHead});
      const rejected=await checkout("f".repeat(40));
      assert.equal(rejected.error?.kind,"stale-operation",JSON.stringify(rejected));
      console.log("Bitbucket short SHA: changed-head checkout rejected before fetch");
      assert.equal(git(root,"branch","--show-current"),"main");
      const {branch:checked,error:checkoutError}=await checkout(detail.pull.headSha);
      assert(checked,JSON.stringify(checkoutError));
      assert(checked.startsWith("pr/7-"));assert.equal(git(root,"rev-parse","HEAD"),head);assert.equal(git(root,"branch","--show-current"),checked);assert.equal(git(root,"status","--porcelain"),"");
      console.log("Bitbucket short SHA: reviewed checkout completed at the exact commit");
      const args={repo:root,number:7,expectedConnection:connection,expectedRevision:detail.revision},caps=await invoke("pr_review_capabilities",args);
      assert(caps.actor.includes("profile not read"));assert(caps.comment);assert(caps.actorId.startsWith("bitbucket-token:"));
      await invoke("pr_review_act",{...args,action:{kind:"comment",body:"PR access reuses the clone token",expectedActor:caps.actorId,thread:null,threadRevision:null,anchor:null}});
      assert.equal(seen.filter(r=>r.method==="POST"&&r.path.endsWith("/comments")&&r.authorized).length,1);assert.equal(seen.filter(r=>r.path==="/2.0/user").length,0);
      assert(!await page.evaluate(secret=>JSON.stringify(localStorage).includes(secret),token));
      if(out)await page.screenshot({path:path.join(out,"bitbucket-token-reuse.png")});
      // Distinct token-only profiles may intentionally have identical public
      // display names. Their manually configured My PR authors must not mix.
      const anonymous=[];
      for(const secret of [anonymousToken,secondToken]){
        const s=await invoke("forge_account_add",{expected:(await invoke("forge_accounts_snapshot")).revision,input:{id:null,kind:"bitbucket",server:url,username:"",token:secret,authMode:"bearer",persist:false,verifyIdentity:false,gitSource:null}});
        const a=s.accounts.find(a=>a.login==="Bitbucket token"&&!anonymous.includes(a.id));anonymous.push(a.id);
      }
      const switchProfile=async(id)=>{await bind("origin",id);await page.getByRole("button",{name:"Refresh pull requests",exact:true}).click();await page.locator('[data-pr-detail="7"]').waitFor();const p=await invoke("pr_page",{repo:root,state:"open",cursor:null});assert.equal(p.forge.accountId,id);assert.equal(p.forge.accountLogin,"Bitbucket token");};
      await switchProfile(anonymous[0]);assert.equal(await page.getByRole("combobox",{name:"Pull request author",exact:true}).inputValue(),"all");
      await page.getByRole("combobox",{name:"Pull request author",exact:true}).selectOption("mine");await modal().getByLabel("My PR author",{exact:true}).selectOption("id:{author}");await button("Use as my author").click();await page.locator('[data-pr-detail="7"]').waitFor();
      await switchProfile(anonymous[1]);assert.equal(await page.getByRole("combobox",{name:"Pull request author",exact:true}).inputValue(),"all");
      await switchProfile(anonymous[0]);assert.equal(await page.getByRole("combobox",{name:"Pull request author",exact:true}).inputValue(),"mine");
      console.log("Bitbucket anonymous profiles: author preferences isolated and restored");
      await bind("origin",account.id);
      await invoke("forge_vault_lock");
      // Reconnection after a real process restart comes only from encrypted state,
      // never an artificial recreation of task/account data or helper cache.
      await app.close();app=null;await start();
      const locked=await invoke("forge_accounts_snapshot");assert.equal(locked.accounts[0].status,"locked");
      await openRepository(page,root);
      const prTab=page.locator(".main-head").getByRole("button",{name:"Pull requests",exact:true});
      await prTab.click();
      const center=page.getByRole("region",{name:"Pull Request Center",exact:true});
      await center.getByRole("alert").filter({hasText:"Unlock the account vault"}).waitFor();
      await prTab.waitFor();
      await center.getByRole("button",{name:"Accounts…",exact:true}).click();
      await modal().getByLabel("Vault password",{exact:true}).fill(password);
      await button("Unlock vault").click();
      await page.locator('.fa-workspace[aria-busy="false"]').waitFor();
      assert.equal((await invoke("forge_accounts_snapshot")).vaultUnlocked,true);
      await button("Close").click();
      await center.locator('[data-pr-detail="7"]').waitFor();
      const restored=await invoke("pr_page",{repo:root,state:"open",cursor:null});assert.equal(restored.items[0].title,pr.title);assert.equal(seen.filter(r=>r.path==="/2.0/user").length,0);
    }catch(error){if(out)await page?.screenshot({path:path.join(out,"bitbucket-token-failure.png")}).catch(()=>{});throw error;}
    finally{if(app){await invoke("unwatch_repo",{repo:root}).catch(()=>{});await app.close();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
}
