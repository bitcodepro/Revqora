import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";
import {launch} from "./ui-driver.mjs";
import {repositoryIsActive} from "./ui-readiness.mjs";
import {createSshGitFixture} from "./ssh-git-fixture.mjs";

export async function gitConnectionsSmoke({exe,work,check,out}){
  await check("real SSH clone/fetch/pull/push supports encrypted keys, agent/config and passwords without exposing API tokens or accepting changed hosts",async()=>{
    const home=path.join(work,"git-connections"),seed=path.join(home,"seed"),bare=path.join(home,"remote.git"),parent=path.join(home,"clones"),root=path.join(parent,"ssh-repo"),profile=path.join(home,"profile");fs.mkdirSync(seed,{recursive:true});fs.mkdirSync(parent);
    const tools=process.platform==="win32"?"C:/Program Files/Git/usr/bin":"/usr/bin",tool=name=>path.join(tools,name+(process.platform==="win32"?".exe":""));
    for(const name of ["ssh","ssh-keygen","ssh-agent","ssh-add"])assert(fs.existsSync(tool(name)),`SSH test requires ${name}`);
    const key=path.join(home,"key ' space % ü"),agentKey=path.join(home,"agent-key"),passphrase="fixture key passphrase",password="fixture SSH password";
    for(const [file,pass]of [[key,passphrase],[agentKey,""]])execFileSync(tool("ssh-keygen"),["-q","-t","ed25519","-N",pass,"-f",file],{windowsHide:true});
    const git=(cwd,...args)=>execFileSync("git",["-C",cwd,...args],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim();
    git(seed,"init","-qb","main");for(const [k,v]of [["user.name","SSH Tester"],["user.email","ssh@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"]])git(seed,"config",k,v);
    fs.writeFileSync(path.join(seed,".gitattributes"),"* text eol=lf\n");fs.writeFileSync(path.join(seed,"file.txt"),"initial\n");git(seed,"add",".");git(seed,"commit","-qm","SSH fixture");git(home,"clone","--bare",seed,bare);const initial=git(seed,"rev-parse","HEAD");
    const agent=execFileSync(tool("ssh-agent"),["-s"],{encoding:"utf8",windowsHide:true}),variable=name=>agent.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="))?.slice(name.length+1),sock=variable("SSH_AUTH_SOCK"),pid=variable("SSH_AGENT_PID");assert(sock&&pid);
    execFileSync(tool("ssh-add"),[agentKey],{windowsHide:true,env:{...process.env,SSH_AUTH_SOCK:sock},stdio:"ignore"});
    const fixture=await createSshGitFixture({bare,keys:[{name:"selected",file:key+".pub"},{name:"agent",file:agentKey+".pub"}],password});
    const config=path.join(home,"ssh_config"),known=path.join(profile,"revqora-data","ssh","known_hosts"),quoted=value=>'"'+value.replaceAll("\\","/").replaceAll('"','\\"').replaceAll("%","%%")+'"';
    fs.writeFileSync(config,`Host github-fixture bitbucket-fixture gitlab-fixture azure-fixture\n  HostName 127.0.0.1\n  User git\n  Port ${fixture.port}\n  IdentityFile ${quoted(agentKey)}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${quoted(known)}\n  StrictHostKeyChecking ask\n`);
    const old={SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK,GIT_SSH_COMMAND:process.env.GIT_SSH_COMMAND};let app,page;const roots=[];
    const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
    const dialog=()=>page.locator(".modal").last(),button=name=>dialog().getByRole("button",{name,exact:true});let passphrasePrompts=0,passwordPrompts=0;
    const settled=()=>page.locator(".busy-item").waitFor({state:"detached"});
    const answer=async(done,timeout=60000)=>{const started=Date.now();while(Date.now()-started<timeout){if(await done())return;
      const errors=page.locator(".toast.error");if(await errors.count())throw Error(await errors.last().innerText());
      if(await page.getByRole("heading",{name:"Unknown host",exact:true}).isVisible()){assert((await dialog().innerText()).includes(fixture.fingerprint),"The displayed host key must match the fixture");await button("Trust and connect").click();}
      else if(await page.getByRole("heading",{name:"Unlock SSH key",exact:true}).isVisible()){passphrasePrompts++;await dialog().locator('input[type="password"]').fill(passphrase);await button("Continue").click();}
      else if(await page.getByRole("heading",{name:"SSH authentication",exact:true}).isVisible()){passwordPrompts++;assert.equal(await dialog().getByRole("combobox",{name:"Saved Git account",exact:true}).count(),0);await dialog().locator('input[type="password"]').fill(password);await button("Continue").click();}
      await page.waitForTimeout(80);
    }throw Error("SSH operation did not reach its exact expected result");};
    const request=async(command,args)=>{let done=false,result;const pending=page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(e){return {ok:false,error:{message:e?.message??String(e),stderr:e?.stderr??"",kind:e?.kind??"",code:e?.code??null}};}},{command,args}).then(value=>{result=value;done=true;});await answer(()=>done);await pending;if(!result.ok)throw Object.assign(new Error(result.error.message),result.error);return result.value;};
    const openClone=async()=>{await page.getByTitle("Command palette (Ctrl+N)",{exact:true}).click();await page.waitForFunction(()=>document.activeElement===document.querySelector(".palette input"));await page.locator(".palette input").fill("Clone repository");await page.locator(".palette-item").filter({hasText:"Clone repository…"}).click();};
    try{
      try{process.env.SSH_AUTH_SOCK=sock;process.env.GIT_SSH_COMMAND=`'${tool("ssh").replaceAll("\\","/").replaceAll("'","'\\''")}' -F '${config.replaceAll("\\","/").replaceAll("'","'\\''")}'`;app=await launch({exe,profile,port:0,visible:false});page=app.page;page.setDefaultTimeout(60000);}
      finally{for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
      await page.getByRole("button",{name:"Skip",exact:true}).click();await page.getByTitle("Settings",{exact:true}).click();await page.getByRole("combobox",{name:"Git auto-fetch",exact:true}).selectOption("0");await button("Done").click();
      const accounts=await invoke("forge_accounts_snapshot");await invoke("forge_account_add",{expected:accounts.revision,input:{id:null,kind:"bitbucket",server:"https://bitbucket.org",username:"fixture@example.invalid",token:"api-token-never-for-ssh",authMode:"basic",persist:false,verifyIdentity:false,gitSource:null}});
      await openClone();await page.getByLabel("Repository URL",{exact:true}).fill(`ssh://git@127.0.0.1:${fixture.port}/team/repo.git`);await page.waitForFunction(()=>document.querySelector('[aria-label="Clone folder name"]')?.value==="repo");await page.getByLabel("Clone parent folder",{exact:true}).fill(parent);await page.getByLabel("Clone folder name",{exact:true}).fill("ssh-repo");
      await dialog().getByLabel("SSH authentication",{exact:true}).selectOption("key");await dialog().getByLabel("SSH private key file",{exact:true}).fill(key);await dialog().getByText("OpenSSH program (optional)",{exact:true}).click();await dialog().getByLabel("SSH executable",{exact:true}).fill(tool("ssh"));await button("Clone").click();
      await answer(()=>page.evaluate(repositoryIsActive,{expected:root,windows:process.platform==="win32"}));await settled();roots.push(root);assert.equal(git(root,"rev-parse","HEAD"),initial);assert(passphrasePrompts>0);assert(fixture.auth.some(a=>a.key==="selected"));
      const saved=await invoke("git_connection_snapshot",{repo:root});assert.equal(saved.options.ssh,"key");assert.equal(saved.options.privateKey,key);
      console.log("SSH private-key clone and saved preferences passed");
      fs.writeFileSync(path.join(seed,"file.txt"),"incoming\n");git(seed,"add",".");git(seed,"commit","-qm","Incoming over SSH");git(seed,"push",bare,"main");const incoming=git(seed,"rev-parse","HEAD");
      await page.getByTitle("Fetch all remotes",{exact:true}).click();await answer(()=>git(root,"rev-parse","origin/main")===incoming);await settled();await page.getByTitle("Pull",{exact:true}).click();await answer(()=>git(root,"rev-parse","HEAD")===incoming);await settled();
      for(const [k,v]of [["user.name","SSH Tester"],["user.email","ssh@example.invalid"],["commit.gpgsign","false"]])git(root,"config",k,v);fs.writeFileSync(path.join(root,"file.txt"),"outgoing\n");git(root,"add",".");git(root,"commit","-qm","Outgoing over SSH");const outgoing=git(root,"rev-parse","HEAD");
      // This commit came from the fixture CLI. Wait for the app to observe its
      // HEAD and status before opening a guarded push confirmation.
      await page.getByText("Outgoing over SSH",{exact:true}).first().waitFor();
      await page.waitForFunction(()=>document.querySelector('.topbar button[title="Push"] .count')?.textContent.trim()==="1");
      await page.getByTitle("Push",{exact:true}).click();await page.getByRole("heading",{name:"Push",exact:true}).waitFor();await button("Push").click();await answer(()=>git(bare,"rev-parse","main")===outgoing);await settled();
      console.log("SSH Fetch, Pull and guarded Push passed");
      const setMode=async mode=>{await page.getByTitle("Accounts and API connections",{exact:true}).click();await page.waitForSelector(".fa-workspace[aria-busy=false]");await button("Git connection settings…").click();await page.getByRole("heading",{name:"Git connection settings",exact:true}).waitFor();await dialog().getByLabel("SSH authentication",{exact:true}).selectOption(mode);await page.waitForFunction(mode=>document.querySelector('[aria-label="SSH authentication"]')?.value===mode,mode);await button("Save Git authentication").click();await page.getByText("Git authentication preferences saved",{exact:true}).last().waitFor();await button("Close").click();assert.equal((await invoke("git_connection_snapshot",{repo:root})).options.ssh,mode,"The selected SSH method must be saved before testing transport");};
      await setMode("agent");const beforeAgent=passphrasePrompts;const connections=await invoke("forge_connections",{repo:root}),target=connections.remotes.find(r=>r.name==="origin");await request("git_connection_test",{repo:root,remote:"origin",expectedUrlFingerprint:target.fingerprint});assert.equal(passphrasePrompts,beforeAgent);assert.equal(fixture.auth.at(-1).key,"agent");
      await setMode("password");await request("git_connection_test",{repo:root,remote:"origin",expectedUrlFingerprint:target.fingerprint});assert.equal(fixture.auth.at(-1).method,"keyboard-interactive");fixture.setKeyboard(false);await request("git_connection_test",{repo:root,remote:"origin",expectedUrlFingerprint:target.fingerprint});assert.equal(fixture.auth.at(-1).method,"password");assert(passwordPrompts>=2);
      // Existing SSH config remains supported for provider-specific SCP URL forms.
      for(const [host,repository]of [["github-fixture","owner/repo.git"],["bitbucket-fixture","workspace/repo.git"],["gitlab-fixture","group/repo.git"],["azure-fixture","v3/org/project/repo"]]){
        await openClone();await page.getByLabel("Repository URL",{exact:true}).fill(`git@${host}:${repository}`);await page.waitForFunction(()=>document.querySelector('[aria-label="Clone folder name"]')?.value==="repo");await page.getByLabel("Clone parent folder",{exact:true}).fill(parent);await page.getByLabel("Clone folder name",{exact:true}).fill(host);await button("Clone").click();const destination=path.join(parent,host);await answer(()=>page.evaluate(repositoryIsActive,{expected:destination,windows:process.platform==="win32"}));await settled();roots.push(destination);assert.equal(git(destination,"rev-parse","HEAD"),outgoing);
      }
      const trust=fs.readFileSync(known),authCount=fixture.auth.length;await fixture.rotateHostKey();let failure="";try{await request("git_connection_test",{repo:root,remote:"origin",expectedUrlFingerprint:target.fingerprint});}catch(e){failure=`${e.message}\n${e.stderr??""}`;}assert.match(failure,/host.*changed|host key verification failed/i,"A changed host key must fail with the original SSH diagnostic");assert.equal(fixture.auth.length,authCount);assert(fs.readFileSync(known).equals(trust));
      if(out)await page.screenshot({path:path.join(out,"ssh-git-connections.png")});
    }catch(e){if(out)await page?.screenshot({path:path.join(out,"ssh-git-failure.png")}).catch(()=>{});throw e;}
    finally{if(app){for(const repo of roots)await invoke("unwatch_repo",{repo}).catch(()=>{});await app.close();}await fixture.close();execFileSync(tool("ssh-agent"),["-k"],{env:{...process.env,SSH_AUTH_SOCK:sock,SSH_AGENT_PID:pid},windowsHide:true,stdio:"ignore"});}
  });
}
