// Real native account UI against loopback API fixtures; no external service receives credentials.
import http from "node:http";
import { openRepository } from "./ui-readiness.mjs";
import fs from "node:fs";
import path from "node:path";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";

export async function forgeAccountsSmoke({page,check,shot,work,profile,restart}){
  const root=path.join(work,"stage12-accounts"),tokens=["account-token-first","account-token-second"],vaultPassword="portable account test password",requests=[];
  fs.mkdirSync(root);const git=(...a)=>execFileSync("git",["-C",root,...a],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim();
  git("init","-qb","main");git("config","user.name","Account Tester");git("config","user.email","accounts@example.invalid");git("config","commit.gpgsign","false");fs.writeFileSync(path.join(root,"file.txt"),"base\n");git("add",".");git("commit","-qm","Account test base");fs.writeFileSync(path.join(root,"file.txt"),"local edit must stay\n");const head=git("rev-parse","HEAD"),index=fs.readFileSync(path.join(root,".git/index"));
  const destination=http.createServer((req,res)=>{requests.push({destination:true,path:req.url});res.writeHead(200,{"content-type":"application/json"});res.end("{}");});await new Promise(resolve=>destination.listen(0,"127.0.0.1",resolve));
  const server=http.createServer((req,res)=>{
    const auth=req.headers.authorization??req.headers["private-token"]??"";requests.push({path:req.url,auth});
    if(req.url.startsWith("/redirect/")){res.writeHead(302,{location:`http://127.0.0.1:${destination.address().port}/user`});res.end();return;}
    if(!tokens.some(t=>auth.includes(t))){res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({message:`Rejected ${auth}`}));return;}
    const second=auth.includes(tokens[1]),login=second?"second-user":"first-user";res.writeHead(200,{"content-type":"application/json"});
    if(req.url==="/api/v3/user")res.end(JSON.stringify({id:second?2:1,login,name:login}));
    else if(req.url.includes("/pulls?"))res.end(JSON.stringify([{number:1,title:`PR by ${login}`,user:{login},head:{ref:"topic",sha:head},base:{ref:"main"},html_url:"https://github.com/example/project/pull/1",created_at:"2026-01-01T00:00:00Z",state:"open",draft:false}]));
    else if(req.url.includes("/check-runs"))res.end(JSON.stringify({check_runs:[]}));
    else if(req.url.endsWith("/status"))res.end(JSON.stringify({statuses:[]}));
    else res.end("{}");
  });await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const url=`http://127.0.0.1:${server.address().port}`;git("remote","add","origin",`${url}/team/repo.git`);
  const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const modal=()=>page.locator(".modal").last();
  const open=async()=>{await page.getByTitle("Accounts and API connections",{exact:true}).click();await page.waitForSelector(".fa-workspace[aria-busy=false]");};
  const ready=()=>page.waitForSelector(".fa-workspace[aria-busy=false]");
  const button=name=>modal().getByRole("button",{name,exact:true});
  const card=login=>modal().locator(".fa-card").filter({has:page.getByText(login,{exact:true})});
  const add=async(token,login,persist=false)=>{
    await button("Add API account").click();await modal().getByRole("textbox",{name:"API server URL",exact:true}).fill(url);await modal().getByLabel("API access token",{exact:true}).fill(token);
    if(persist)await modal().getByRole("checkbox",{name:"Save API token in encrypted vault",exact:true}).check();await button("Verify and save account").click();await card(login).waitFor();await ready();
  };
  const select=async id=>{await modal().getByRole("combobox",{name:"Repository API account",exact:true}).selectOption(id);await button("Use for PR and checks").click();await ready();};
  const account=async login=>(await invoke("forge_accounts_snapshot")).accounts.find(p=>p.login===login);
  const storageFile=path.join(profile,"revqora-data","accounts","accounts.json");
  try{
    await openRepository(page,root);
    await check("API account verification returns metadata and keeps session tokens out of settings and disk",async()=>{
      await open();await add(tokens[0],"first-user");const snapshot=await invoke("forge_accounts_snapshot");if(snapshot.accounts.length!==1||snapshot.accounts[0].status!=="available"||snapshot.accounts[0].storage!=="session")throw Error("Session account not available");
      const local=await page.evaluate(()=>JSON.stringify({...localStorage}));if(local.includes(tokens[0])||JSON.stringify(snapshot).includes(tokens[0])||fs.readFileSync(storageFile,"utf8").includes(tokens[0]))throw Error("Session token leaked into public settings");await shot("100-api-accounts");
    });
    await check("two accounts on one host route PR requests through the explicitly selected API identity",async()=>{
      await add(tokens[1],"second-user");await select((await account("second-user")).id);const r=await invoke("pull_requests",{repo:root});if(r.forge.accountLogin!=="second-user"||r.items[0]?.author!=="second-user")throw Error("Second account was replaced by the host's first token");
      await select((await account("first-user")).id);const first=await invoke("pull_requests",{repo:root});if(first.items[0]?.author!=="first-user")throw Error("Switching API accounts reused a cached host token");await shot("101-api-connection");
    });
    await check("changed remote URLs and stale API-account confirmations are rejected before any server write",async()=>{
      const f=await invoke("forge_info",{repo:root}),count=requests.length;git("remote","set-url","origin",`${url}/other/project.git`);
      let rejected=false;try{await invoke("pull_request_create",{repo:root,title:"Never sent",body:"",head:"topic",base:"main",draft:false,expectedConnection:f.connectionRevision});}catch{rejected=true;}
      if(!rejected||requests.length!==count)throw Error("Changed remote caused a server request");git("remote","set-url","origin",`${url}/team/repo.git`);await button("Refresh API accounts").click();await ready();
      const old=(await invoke("forge_accounts_snapshot")).revision;await invoke("forge_vault_lock");let stale=false;try{await invoke("forge_account_remove",{id:(await account("second-user")).id,expected:old});}catch{stale=true;}if(!stale)throw Error("Old account confirmation was accepted");
      // Reconnect both cleared session tokens explicitly before the remaining scenarios.
      await button("Refresh API accounts").click();await ready();for(const [login,token] of [["first-user",tokens[0]],["second-user",tokens[1]]]){await card(login).getByRole("button",{name:"Reconnect",exact:true}).click();await modal().getByLabel("API access token",{exact:true}).fill(token);await button("Verify and save account").click();await ready();}await select((await account("first-user")).id);
    });
    await check("encrypted portable tokens lock without falling back to another identity and unlock only with the vault password",async()=>{
      await modal().getByLabel("Vault password",{exact:true}).fill(vaultPassword);await modal().getByLabel("Confirm vault password",{exact:true}).fill(vaultPassword);await button("Create vault").click();await ready();
      await card("first-user").getByRole("button",{name:"Reconnect",exact:true}).click();await modal().getByLabel("API access token",{exact:true}).fill(tokens[0]);await modal().getByRole("checkbox",{name:"Save API token in encrypted vault",exact:true}).check();await button("Verify and save account").click();await ready();
      const disk=fs.readFileSync(storageFile,"utf8");if(tokens.some(t=>disk.includes(t))||disk.includes(vaultPassword)||!disk.includes("ciphertext"))throw Error("Portable vault contains plaintext secret material");
      await button("Lock tokens and clear sessions").click();await ready();const count=requests.length;let locked=false;try{await invoke("pull_requests",{repo:root});}catch{locked=true;}if(!locked||requests.length!==count)throw Error("Locked account fell back to Git or another account");
      await modal().getByLabel("Vault password",{exact:true}).fill("incorrect vault password");await button("Unlock vault").click();await modal().getByRole("alert").waitFor();await ready();if((await invoke("forge_accounts_snapshot")).vaultUnlocked)throw Error("Wrong password unlocked tokens");
      await modal().getByLabel("Vault password",{exact:true}).fill(vaultPassword);await button("Unlock vault").click();await ready();if((await invoke("pull_requests",{repo:root})).items[0]?.author!=="first-user")throw Error("Unlock did not restore the selected identity");await shot("102-encrypted-vault");
    });
    await check("reconnect refuses a different user and rejected tokens or redirects never become saved accounts",async()=>{
      await card("first-user").getByRole("button",{name:"Reconnect",exact:true}).click();await modal().getByLabel("API access token",{exact:true}).fill(tokens[1]);await button("Verify and save account").click();await modal().getByRole("alert").filter({hasText:/different account/}).waitFor();await ready();await button("Cancel account").click();
      if((await invoke("pull_requests",{repo:root})).items[0]?.author!=="first-user")throw Error("Failed reconnect replaced the original account");
      await button("Add API account").click();await modal().getByRole("textbox",{name:"API server URL",exact:true}).fill(url);const rejected="rejected-secret-token";await modal().getByLabel("API access token",{exact:true}).fill(rejected);await button("Verify and save account").click();await modal().getByRole("alert").waitFor();await ready();if((await modal().innerText()).includes(rejected))throw Error("Server's echoed token leaked into UI error");
      await modal().getByRole("textbox",{name:"API server URL",exact:true}).fill(`${url}/redirect`);await modal().getByLabel("API access token",{exact:true}).fill(tokens[0]);await button("Verify and save account").click();await modal().getByRole("alert").waitFor();await ready();if(requests.some(r=>r.destination)||(await invoke("forge_accounts_snapshot")).accounts.length!==2)throw Error("Redirect forwarded credentials or saved a false identity");await button("Cancel account").click();
    });
    await check("real app restart retains encrypted metadata and remote selection but restores neither vault keys nor session tokens",async()=>{
      await button("Close").click();page=await restart();page.setDefaultTimeout(60000);await openRepository(page,root);await open();
      const s=await invoke("forge_accounts_snapshot");if(s.vaultUnlocked||s.accounts.find(p=>p.login==="first-user")?.status!=="locked"||s.accounts.find(p=>p.login==="second-user")?.status!=="reconnect")throw Error("Restart restored secret keys or lost encrypted account metadata");
      if((await invoke("forge_connections",{repo:root})).remotes[0]?.accountId!==(await account("first-user")).id)throw Error("Restart lost the explicit account binding");
      await modal().getByLabel("Vault password",{exact:true}).fill(vaultPassword);await button("Unlock vault").click();await ready();if((await invoke("pull_requests",{repo:root})).items[0]?.author!=="first-user")throw Error("Persistent encrypted token could not reconnect after restarting");await shot("103-vault-after-restart");
    });
    await check("removing the selected API account requires a new explicit choice and keeps Git files and staging unchanged",async()=>{
      await card("first-user").getByRole("button",{name:"Remove",exact:true}).click();await modal().getByRole("button",{name:"Remove account",exact:true}).click();await ready();let removed=false;try{await invoke("pull_requests",{repo:root});}catch{removed=true;}if(!removed)throw Error("Removed account silently fell back to another credential");
      await card("second-user").getByRole("button",{name:"Reconnect",exact:true}).click();await modal().getByLabel("API access token",{exact:true}).fill(tokens[1]);await button("Verify and save account").click();await ready();await select((await account("second-user")).id);if((await invoke("pull_requests",{repo:root})).items[0]?.author!=="second-user")throw Error("Explicit replacement account did not take effect");
      if(git("rev-parse","HEAD")!==head||!index.equals(fs.readFileSync(path.join(root,".git/index")))||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="local edit must stay\n")throw Error("Account management changed Git HEAD, files or staging");await shot("104-api-account-reselection");await button("Close").click();
    });
  }finally{server.closeAllConnections();destination.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>destination.close(r))]);}
}
