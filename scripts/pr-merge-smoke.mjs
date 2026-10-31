// All requests go to the existing loopback forge; no real PRs are merged by tests.
export function createPrMergeFixture({pulls}){
 const state={enabled:false,late:false,queue:false,queued:new Set(),allow:["merge","squash","rebase"],actor:13,failNext:false,writes:[]};
 for(const p of pulls.values()){p.head.repo={id:10,full_name:"team/repo"};p.base.repo={id:10,full_name:"team/repo"};}
 const handle=(req,res,url,entry)=>{
  const send=(v,code=200)=>{res.writeHead(code,{"content-type":"application/json"});res.end(JSON.stringify(v));};
  if(url.pathname==="/api/v3/user"&&state.enabled){send({id:state.actor,login:"pr-tester",name:"PR Tester"});return true;}
  if(url.pathname==="/api/v3/repos/team/repo"){send({id:10,archived:false,permissions:{push:true},default_branch:"main",allow_merge_commit:true,allow_squash_merge:true,allow_rebase_merge:true});return true;}
  if(url.pathname.includes("/rules/branches/")){send(state.queue?[{type:"merge_queue"}]:[{type:"pull_request",parameters:{allowed_merge_methods:state.allow}}]);return true;}
  if(url.pathname.includes("/branches/")){send({protected:false});return true;}
  if(url.pathname.endsWith("/check-runs")){const second=url.searchParams.get("page")==="2";send({check_runs:state.late?(second?[{name:"Late required build",status:"completed",conclusion:"failure"}]:Array.from({length:100},(_,i)=>({name:`Build ${i}`,status:"completed",conclusion:"success"}))):[{name:"Successful build",status:"completed",conclusion:"success",html_url:"https://ci.example.invalid/build/42"}]});return true;}
  const query=entry.body?.query??"",v=entry.body?.variables??{};
  if(url.pathname!=="/api/graphql"||!query.includes("RevqoraMerge")&&!query.includes("RevqoraEnqueue"))return false;
  if(query.startsWith("query")){const p=pulls.get(v.number);send({data:{repository:{pullRequest:{id:`PR${p.number}`,headRefOid:p.head.sha,baseRefOid:p.base.sha,mergeable:"MERGEABLE",mergeStateStatus:state.queue?"BLOCKED":"CLEAN",reviewDecision:"APPROVED",mergeQueueEntry:state.queued.has(p.number)?{id:`Q${p.number}`,state:"QUEUED",position:1}:null,baseRef:{branchProtectionRule:null}}}}});return true;}
  const n=Number(v.id.slice(2)),p=pulls.get(n);if(!p||v.head!==p.head.sha){send({},409);return true;}state.writes.push(entry);
  if(state.failNext){state.failNext=false;send({},500);return true;}
  if(query.includes("enqueuePullRequest")){state.queued.add(n);send({data:{enqueuePullRequest:{mergeQueueEntry:{id:`Q${n}`,state:"QUEUED",position:1}}}});return true;}
  p.state="closed";p.merged_at="2026-10-31T00:00:00Z";p.updated_at=`merged-${state.writes.length}`;send({data:{mergePullRequest:{pullRequest:{merged:true,mergeCommit:{oid:p.base.sha}}}}});return true;
 };
 return {state,handle};
}
export async function prMergeSmoke({page,check,shot,root,pulls,fixture,git,index,head}){
 const {state}=fixture,button=name=>page.locator(".modal").last().getByRole("button",{name,exact:true});
 state.enabled=true;const consent=()=>page.getByRole("checkbox",{name:"I reviewed this source commit, destination, checks and merge method.",exact:true});
 const modalReady=()=>page.waitForSelector('[data-pr-merge-dialog="1"][aria-busy="false"]');
 const open=async n=>{await page.getByRole("textbox",{name:"Search loaded pull requests",exact:true}).fill(`#${n}`);await page.getByRole("button",{name:`Open #${n}`,exact:true}).click();await page.waitForSelector(`[data-pr-detail="${n}"]`);await page.getByRole("button",{name:"Overview",exact:true}).click();await page.waitForSelector('.pr-merge-panel[aria-busy="false"]');};
 const start=async()=>{await page.locator(".pr-detail-actions").getByRole("button",{name:"Merge…",exact:true}).click();await modalReady();};
 const reload=async()=>{await page.getByRole("button",{name:"Reload request",exact:true}).click();await page.waitForSelector('[data-pr-detail]');};
 const sent=async()=>{await page.waitForSelector('[data-pr-merge-dialog]',{state:"detached"});await page.waitForSelector('[data-pr-detail][aria-busy="false"]');};
 const logsDoNotSubmit=async(action)=>{
  // Consent and an enabled action are essential: an ineligible PR would hide the defect.
  if(!await consent().isChecked()||await button(action).isDisabled())throw Error("CI link regression needs an eligible, consented merge confirmation");
  const before=state.writes.length;
  await page.evaluate(()=>{
   const original=window.__TAURI_INTERNALS__.invoke,probe={original,opens:[],mergeCalls:0,submits:0};
   probe.listener=e=>{if(e.target.matches("form.modal"))probe.submits++;};
   document.addEventListener("submit",probe.listener,true);
   window.__revqoraCiLogProbe=probe;
   window.__TAURI_INTERNALS__.invoke=async(command,args,...rest)=>{if(command==="open_path"){probe.opens.push(args.path);return;}if(command==="pr_merge_submit")probe.mergeCalls++;return original(command,args,...rest);};
  });
  try{
   const link=page.locator(".modal .pr-merge-checks").getByRole("button",{name:"Open Successful build",exact:true});
   for(const [i,activate]of [()=>link.click(),()=>link.press("Enter")].entries()){
    await activate();await page.waitForFunction(n=>window.__revqoraCiLogProbe.opens.length===n,i+1);
    const observed=await page.evaluate(()=>{const p=window.__revqoraCiLogProbe;return{opens:p.opens,mergeCalls:p.mergeCalls,submits:p.submits};});
    if(observed.opens.some(u=>u!=="https://ci.example.invalid/build/42")||observed.mergeCalls||observed.submits||state.writes.length!==before)throw Error(`Opening CI logs submitted ${action}: ${JSON.stringify(observed)}`);
    if(await button(action).isDisabled()||!await consent().isChecked())throw Error("Opening logs changed the merge confirmation state");
   }
  }finally{await page.evaluate(()=>{const p=window.__revqoraCiLogProbe;document.removeEventListener("submit",p.listener,true);window.__TAURI_INTERNALS__.invoke=p.original;delete window.__revqoraCiLogProbe;});}
 };
 await check("merge readiness loads later CI pages and keeps a failing build blocked",async()=>{
  state.late=true;await open(41);await page.getByText(/1 reported CI checks are pending/).waitFor();await start();await consent().check();if(!await button("Confirm merge").isDisabled())throw Error("A failing check on page two did not block merge");await button("Close and keep message").click();state.late=false;await page.getByRole("button",{name:"Refresh merge readiness",exact:true}).click();await page.waitForSelector('.pr-merge-panel[aria-busy="false"]');await shot("121-merge-readiness");
 });
 await check("stale merge confirmations retain text and refresh resets consent and unavailable strategies",async()=>{
  await start();await page.getByRole("textbox",{name:"Merge message",exact:true}).fill("Keep this merge message Тест 😀");await consent().check();pulls.get(41).updated_at="external-pr-change";const before=state.writes.length;await button("Confirm merge").click();await page.locator(".modal").getByRole("alert").filter({hasText:/changed/}).waitFor();if(state.writes.length!==before||await page.getByRole("textbox",{name:"Merge message",exact:true}).inputValue()!=="Keep this merge message Тест 😀")throw Error("Stale merge was submitted or message was lost");state.allow=["squash"];await button("Refresh merge review").click();await modalReady();if(await consent().isChecked()||await page.getByRole("combobox",{name:"Merge method",exact:true}).inputValue()!=="squash")throw Error("Refreshed merge kept stale consent or method");await shot("124-merge-review");await button("Close and keep message").click();state.allow=["merge","squash","rebase"];await reload();
 });
 await check("changed API identity cannot merge under the previous identity's confirmation",async()=>{
  await start();await consent().check();const before=state.writes.length;state.actor=14;await button("Confirm merge").click();await page.locator(".modal").getByRole("alert").filter({hasText:/changed/}).waitFor();if(state.writes.length!==before)throw Error("Changed identity published a merge");state.actor=13;await button("Close and keep message").click();
 });
 await check("unknown merge results survive reopening and checking the result never resends",async()=>{
  await start();await consent().check();state.failNext=true;const before=state.writes.length;await button("Confirm merge").click();await page.getByRole("checkbox",{name:"I checked the previous merge result on the server",exact:true}).waitFor();await button("Close and keep message").click();await start();if(!await button("Confirm merge").isDisabled()||state.writes.length!==before+1)throw Error("Reopening allowed an unchecked merge retry");await page.getByRole("checkbox",{name:"I checked the previous merge result on the server",exact:true}).check();await button("Mark merge result as checked without resending").click();if(state.writes.length!==before+1||await consent().isChecked())throw Error("Acknowledgement resent a merge or retained consent");await button("Close and keep message").click();
 });
 await check("required merge queues submit only an enqueue with the reviewed source and never claim merged",async()=>{
  state.queue=true;await open(42);await start();const options=await page.getByRole("combobox",{name:"Merge method",exact:true}).locator("option").allTextContents();if(options.length!==1||!options[0].includes("queue"))throw Error("Direct merge was offered for a queue-only branch");await consent().check();await logsDoNotSubmit("Add to merge queue");await button("Add to merge queue").click();await sent();await page.locator(".pr-merge-panel").getByText(/QUEUED/).waitFor();if(await page.locator(".pr-detail-actions").getByRole("button",{name:"Source cleanup…",exact:true}).count())throw Error("Queued PR enabled cleanup");const write=state.writes.at(-1);if(write.body.variables.head!==pulls.get(42).head.sha||!write.body.query.includes("jump:false"))throw Error("Queue source lease or ordinary priority was lost");state.queue=false;
 });
 await check("explicit squash merging uses the reviewed head and refreshes the merged PR without changing local Git",async()=>{
  await open(43);await start();await page.getByRole("combobox",{name:"Merge method",exact:true}).selectOption("squash");await page.getByRole("textbox",{name:"Merge message",exact:true}).fill("Reviewed squash message 😀");await consent().check();await logsDoNotSubmit("Confirm merge");await button("Confirm merge").click();await sent();await page.locator(".pr-detail-actions").getByRole("button",{name:"Source cleanup…",exact:true}).waitFor();const write=state.writes.at(-1);if(write.body.variables.method!=="SQUASH"||write.body.variables.head!==pulls.get(43).head.sha||write.body.variables.body!=="Reviewed squash message 😀")throw Error("Merge did not preserve its reviewed method, head and message");await shot("122-pr-merged");
 });
 await check("post-merge cleanup keeps destination/default branches and fork source branches",async()=>{
  const p=pulls.get(43);p.head.ref="main";await reload();await page.locator(".pr-detail-actions").getByRole("button",{name:"Source cleanup…",exact:true}).click();await page.locator(".modal").getByRole("alert").filter({hasText:/destination and default branch/}).waitFor();if(!await button("Delete selected source branches").isDisabled())throw Error("Default branch cleanup was enabled");await button("Close").click();p.head.ref="topic";p.head.repo.id=11;await reload();await page.locator(".pr-detail-actions").getByRole("button",{name:"Source cleanup…",exact:true}).click();await page.locator(".modal").getByRole("alert").filter({hasText:/Fork branches are kept/}).waitFor();await button("Close").click();
 });
 await check("local source cleanup requires a separate confirmation, saves recovery and preserves working files",async()=>{
  const name="stage15-cleanup",p=pulls.get(44);git("branch",name,head);p.head.ref=name;p.head.sha=head;p.state="closed";p.merged_at="2026-10-31T00:00:00Z";await open(44);await page.locator(".pr-detail-actions").getByRole("button",{name:"Source cleanup…",exact:true}).click();await page.waitForSelector('[data-pr-cleanup-dialog="1"][aria-busy="false"]');await page.getByRole("checkbox",{name:"Delete local source branch",exact:true}).check();await page.waitForSelector('[data-pr-cleanup-dialog="1"][aria-busy="false"]');await page.getByRole("checkbox",{name:"Delete remote source branch",exact:true}).uncheck();await page.getByText(/Reviewed source/).waitFor();await page.getByRole("checkbox",{name:"Delete exactly these reviewed source branch tips.",exact:true}).check();await button("Delete selected source branches").click();await page.getByText("Cleanup completed",{exact:true}).waitFor();await button("Open recovery checkpoint").waitFor();let exists=true;try{git("show-ref","--verify",`refs/heads/${name}`);}catch{exists=false;}if(exists)throw Error("Local source branch still exists");const fs=await import("node:fs"),path=await import("node:path");if(git("rev-parse","HEAD")!==head||!index.equals(fs.readFileSync(path.join(root,".git/index")))||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="Keep this local work\n")throw Error("PR merging/cleanup changed local HEAD, index or working files");await shot("123-pr-cleanup");await button("Close").click();
 });
}
