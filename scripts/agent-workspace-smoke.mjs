// Real installed Node as a deterministic offline agent. No AI account/network.
import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { assertAgentWorktreeProtection, assertAgentDraft } from "./agent-workspace-fixture.mjs";
import { openRepository } from "./ui-readiness.mjs";
export async function agentWorkspaceSmoke({page,check,shot,work,restart}) {
 const root=path.join(work,"stage16-agents"),script=path.join(work,"fixture-agent.cjs"),launchTrace=path.join(work,"fixture-launches.jsonl");fs.mkdirSync(root);
 const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true}).trim();
 git("init","-qb","main");for(const[k,v]of[["user.name","Agent Tester"],["user.email","agent@example.invalid"],["commit.gpgsign","false"],["core.quotepath","true"],["core.hooksPath",".git/hooks"]])git("config",k,v);
 fs.writeFileSync(path.join(root,"file.txt"),"original\n");git("add",".");git("commit","-qm","Agent base");fs.writeFileSync(path.join(root,"file.txt"),"Keep uncommitted source\r\n");
 const head=git("rev-parse","HEAD"),index=fs.readFileSync(path.join(root,".git/index"));
 fs.writeFileSync(script,`require('fs').appendFileSync(${JSON.stringify(launchTrace)},JSON.stringify({cwd:process.cwd()})+'\\n');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{console.log('fixture started');console.error('fixture diagnostic');if(prompt.includes('WAIT_FOR_STOP')){setInterval(()=>{},1000);return;}require('fs').writeFileSync('agent.txt',JSON.stringify({prompt,home:process.env.HOME,codex:process.env.CODEX_HOME,temp:process.env.TEMP}));console.log('fixture completed');});`);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args:{repo:root,...args}});
 const modal=()=>page.locator(".modal").last(),button=name=>modal().getByRole("button",{name,exact:true});
 const open=async()=>{await page.getByRole("button",{name:"Agent Workspace",exact:true}).click();await page.waitForSelector('.agent-workspace');await page.getByRole("button",{name:"New task",exact:true}).waitFor();};
 const tasks=()=>invoke("agent_tasks"),until=async(fn,msg)=>{const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await page.waitForTimeout(100);}throw Error(msg);};
 const draft=async(title,prompt)=>{await page.getByRole("button",{name:"New task",exact:true}).click();await modal().getByRole("textbox",{name:"Task title",exact:true}).fill(title);await modal().getByRole("combobox",{name:"Agent provider",exact:true}).selectOption("custom");await modal().getByRole("textbox",{name:"Agent executable",exact:true}).fill(process.execPath);await modal().getByRole("textbox",{name:"Agent arguments",exact:true}).fill(JSON.stringify([script]));await modal().getByRole("textbox",{name:"Agent prompt",exact:true}).fill(prompt);await assertAgentDraft(modal(),{title,executable:process.execPath,args:[script],prompt});await button("Review launch").click();await page.waitForSelector('[data-agent-review]');};
 const launch=async()=>{await modal().getByRole("checkbox",{name:"Allow agent execution",exact:true}).check();await button("Start agent").click();await page.waitForSelector('.modal',{state:"detached"});};
 const unchanged=()=>{if(git("rev-parse","HEAD")!==head||!fs.readFileSync(path.join(root,".git/index")).equals(index)||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="Keep uncommitted source\r\n")throw Error("Agent workflow changed original HEAD/index/files");};
 let successful;
 await openRepository(page,root);
 try {
  await check("agent launch reviews exact paths and requires explicit consent; cancelled review never runs",async()=>{
   await open();await draft("Cancelled task","do not run");if(!await button("Start agent").isDisabled())throw Error("Unconsented launch enabled");await shot("129-agent-launch-review");await button("Edit task").click();if(await page.locator('[data-agent-review]').count())throw Error("Editing retained launch proof");
   await modal().getByRole("textbox",{name:"Agent executable",exact:true}).fill(path.join(work,"missing-agent-executable.exe"));await button("Review launch").click();await modal().getByRole("alert").waitFor();if(await button("Review launch").isDisabled())throw Error("Failed preparation stayed busy");await button("Close").click();if((await tasks()).length)throw Error("Review created a task or process");unchanged();
  });
  await check("real offline CLI gets stdin and portable environment, keeps source changes and persists output",async()=>{
   await draft("Offline editing task","Produce reviewed edits");await launch();await until(async()=>{const t=(await tasks())[0];return t?.phase==="completed";},"Agent did not finish");successful=(await tasks())[0];
   const out=JSON.parse(fs.readFileSync(path.join(successful.path,"agent.txt"),"utf8"));if(!out.prompt.includes("Produce reviewed edits")||!out.prompt.includes("Do not commit")||out.home!==successful.profilePath||out.codex!==path.join(successful.profilePath,"codex")||out.temp!==path.join(successful.profilePath,"temp"))throw Error("Wrong stdin/profile environment");
   if(!successful.stdout.includes("fixture completed"))throw Error("Agent stdout is missing the completion marker");
   if(!successful.stderr.includes("fixture diagnostic"))throw Error("Agent stderr is missing the diagnostic marker");
   if(git("rev-parse",successful.branch)!==head)throw Error("Agent branch changed unexpectedly");
   assertAgentWorktreeProtection(git,successful,head);
   await until(async()=>await page.locator('.agent-phase').innerText()==="completed","UI did not show completion");await shot("130-agent-workspace");unchanged();
  });
  await check("a stale reviewed agent launch fails before creating its worktree or executing code",async()=>{
   await draft("Stale task","must not run");fs.writeFileSync(path.join(root,"external.txt"),"External IDE edit\n");await launch();await until(async()=>(await tasks()).find(t=>t.title==="Stale task")?.phase==="failed","Stale launch not rejected");const t=(await tasks()).find(t=>t.title==="Stale task");if(fs.existsSync(t.path)||!t.error?.includes("changed"))throw Error("Stale task created a worktree");fs.unlinkSync(path.join(root,"external.txt"));unchanged();
  });
  await check("stop remains responsive while the repository queue is held; task changes are retained",async()=>{
   await draft("Cancellable task","WAIT_FOR_STOP");await launch();await until(async()=>(await tasks()).find(t=>t.title==="Cancellable task")?.stdout.includes("fixture started"),"Agent did not start");await page.getByRole("button",{name:"Stop process tree",exact:true}).click();await until(async()=>(await tasks()).find(t=>t.title==="Cancellable task")?.phase==="cancelled","Stop did not finish");unchanged();
  });
  await check("task history and logs survive closing the workspace and app restart without replaying jobs",async()=>{
   const before=fs.readFileSync(launchTrace,"utf8");if(before.trim().split("\n").length!==2)throw Error("Expected exactly successful and cancellable fixture launches");
   await page.getByRole("button",{name:"Close Agent Workspace",exact:true}).click();page=await restart();await openRepository(page,root);await open();await until(async()=>(await tasks()).length===3,"History missing after restart");const t=(await tasks()).find(t=>t.id===successful.id);if(t?.phase!=="completed"||!t.stdout.includes("fixture completed")||t.prompt!=="Produce reviewed edits")throw Error("Restart lost task record/log");
   if(fs.readFileSync(launchTrace,"utf8")!==before)throw Error("App restart replayed an agent process");
   await invoke("agent_forget",{id:t.id});if(!fs.existsSync(path.join(t.path,"agent.txt")))throw Error("Forgetting history removed files");unchanged();
  });
 } finally {
  // Only these fixture worktrees may be removed. Never clean an app/user directory.
  const known=await tasks().catch(()=>[]);if(successful&&!known.some(t=>t.id===successful.id))known.push(successful);
  for(const t of known){if(!/^[0-9a-f]{32}$/.test(t.id)||path.basename(t.path)!==t.id||t.repository!==root)throw Error("Unowned agent cleanup target");if(["running","queued","stopping"].includes(t.phase)){await invoke("agent_stop",{id:t.id});await until(async()=>(await tasks()).find(x=>x.id===t.id)?.phase==="cancelled","Cleanup could not stop fixture");}if(fs.existsSync(t.path)){git("worktree","unlock",t.path);git("worktree","remove","--force",t.path);}}
 }
}
