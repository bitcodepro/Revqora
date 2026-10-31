import {createPrReviewFixture,prReviewSmoke} from "./pr-review-smoke.mjs";
// The native UI and Rust HTTP client talk only to this loopback forge.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";

export async function prCenterSmoke({page,check,shot,work}) {
  const root=path.join(work,"stage13-pr-center"),requests=[],token="stage13-public-fixture-token",a="a".repeat(40),b="b".repeat(40);
  fs.mkdirSync(root);const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim();
  git("init","-qb","main");git("config","user.name","PR Tester");git("config","user.email","pr@example.invalid");git("config","commit.gpgsign","false");
  fs.mkdirSync(path.join(root,".github/PULL_REQUEST_TEMPLATE"),{recursive:true});fs.writeFileSync(path.join(root,".github/PULL_REQUEST_TEMPLATE/Feature.md"),"## Template\n\n- [ ] Tests\nТест 😀\n");fs.writeFileSync(path.join(root,"file.txt"),"base\n");git("add",".");git("commit","-qm","PR Center fixture");fs.writeFileSync(path.join(root,"file.txt"),"Keep this local work\n");
  const head=git("rev-parse","HEAD"),index=fs.readFileSync(path.join(root,".git/index"));
  const description="A description with more than ten readable words, several paragraphs and Unicode 😀.\n\n"+"Long review context. ".repeat(300)+"\n<img src='https://must-not-load.invalid/track'>";
  const pulls=new Map(Array.from({length:52},(_,i)=>[i+1,{number:i+1,title:`Request ${i+1}: improve repository workflow`,body:description,user:{login:"fixture-author"},head:{ref:"topic",sha:a},base:{ref:"main",sha:b},state:"open",draft:false,created_at:"2026-01-01T00:00:00Z",updated_at:`initial-${i+1}`,changed_files:4,html_url:"file:///unsafe.exe"}]));
  const patch="diff --git a/src/old.ts b/src/new.ts\nsimilarity index 60%\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-before\n+after\n"+
    "diff --git a/long.txt b/long.txt\nnew file mode 100644\n--- /dev/null\n+++ b/long.txt\n@@ -0,0 +1 @@\n+"+"long-line-".repeat(120)+"\n"+
    "diff --git a/asset.bin b/asset.bin\nBinary files a/asset.bin and b/asset.bin differ\n"+
    "diff --git a/mode.txt b/mode.txt\nold mode 100644\nnew mode 100755\n";
  let hold=null;const reviewFixture=createPrReviewFixture({pulls,a});
  const server=http.createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;const url=new URL(req.url,"http://fixture"),entry={method:req.method,path:req.url,body:body?JSON.parse(body):null};requests.push(entry);
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end("{}");return;}
    const send=data=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(data));};
    if(reviewFixture.handle(req,res,url,entry))return;
    if(url.pathname==="/api/v3/user")return send({id:13,login:"pr-tester",name:"PR Tester"});
    if(url.pathname.includes("check-runs"))return send({check_runs:[]});if(url.pathname.endsWith("/status"))return send({statuses:[]});
    const n=Number(url.pathname.match(/\/pulls\/(\d+)$/)?.[1]);
    if(n){if(hold?.number===n&&req.method==="GET"&&!req.headers.accept?.includes("diff")){const h=hold;hold=null;h.started();await h.promise;}
      const p=pulls.get(n);if(!p){res.writeHead(404);res.end("{}");return;}
      if(req.headers.accept?.includes("diff")){res.writeHead(200,{"content-type":"text/plain"});res.end(patch);return;}
      if(req.method==="PATCH"){Object.assign(p,entry.body,{base:{...p.base,ref:entry.body.base},updated_at:`edited-${requests.length}`});}
      return send(p);
    }
    if(url.pathname.endsWith("/pulls")){
      if(req.method==="POST"){const n=100;const p={...pulls.get(1),...entry.body,number:n,head:{ref:entry.body.head,sha:a},base:{ref:entry.body.base,sha:b},updated_at:"created"};pulls.set(n,p);return send(p);}
      const state=url.searchParams.get("state"),rows=[...pulls.values()].filter(p=>state==="all"||p.state===state),offset=(Number(url.searchParams.get("page")||1)-1)*50;return send(rows.slice(offset,offset+50));
    }
    res.writeHead(404);res.end("{}");
  });await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const url=`http://127.0.0.1:${server.address().port}`;git("remote","add","origin",`${url}/team/repo.git`);
  const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const center=()=>page.getByRole("region",{name:"Pull Request Center",exact:true});
  const button=name=>page.locator(".modal").last().getByRole("button",{name,exact:true});
  const detail=n=>page.waitForSelector(`[data-pr-detail="${n}"]`);
  const openNumber=async n=>{await page.getByRole("textbox",{name:"Search loaded pull requests",exact:true}).fill(`#${n}`);await page.getByRole("button",{name:`Open #${n}`,exact:true}).click();await detail(n);};
  try {
    const snapshot=await invoke("forge_accounts_snapshot");const added=await invoke("forge_account_add",{input:{id:null,kind:"github",server:url,username:"",token,authMode:"token",persist:false},expected:snapshot.revision});const account=added.accounts.find(p=>p.server===url);
    const connections=await invoke("forge_connections",{repo:root});await invoke("forge_connection_select",{repo:root,selection:{remote:"origin",fingerprint:connections.remotes[0].fingerprint,accountId:account.id,allowSshAlias:false},expected:connections.revision});
    await invoke("plugin:event|emit",{event:"open-paths",payload:[root]});await page.locator(".topbar .repo-current > b").filter({hasText:"stage13-pr-center"}).waitFor();await page.getByRole("button",{name:"Pull requests",exact:true}).click();await detail(1);
    await check("PR Center pages, searches and filters server requests and opens a number directly",async()=>{
      await page.locator("[data-pr-loaded='50']").waitFor();await page.getByRole("button",{name:"Load more requests",exact:true}).click();await page.locator("[data-pr-loaded='52']").waitFor();await openNumber(52);
      await page.getByRole("combobox",{name:"Request status",exact:true}).selectOption("merged");await page.getByText(/No matching requests in the loaded pages/).waitFor();await page.getByRole("combobox",{name:"Request status",exact:true}).selectOption("open");await detail(1);await page.getByRole("textbox",{name:"Search loaded pull requests",exact:true}).fill("");await shot("105-pr-center");
    });
    await check("long PR descriptions expand without rendering provider HTML or unsafe browser URLs",async()=>{
      await page.getByRole("button",{name:"Expand description",exact:true}).click();const text=await page.locator(".pr-description-expanded").innerText();if(!text.includes("must-not-load.invalid")||await page.locator(".pr-description-expanded img").count())throw Error("Description was truncated or rendered unsafe HTML");await button("Close").click();
      const d=await invoke("pr_detail",{repo:root,number:1,expectedConnection:(await invoke("forge_info",{repo:root})).connectionRevision});if(!d.pull.url.startsWith(url)||d.pull.url.includes("unsafe"))throw Error("Provider browser URL was trusted");
    });
    await check("create PR uses committed templates with replacement consent and never pushes local Git changes",async()=>{
      await page.getByRole("button",{name:"New",exact:true}).click();await page.getByRole("textbox",{name:"PR title",exact:true}).fill("Created in PR Center");await page.getByLabel("PR source branch",{exact:true}).fill("topic");await page.getByRole("textbox",{name:"PR description",exact:true}).fill("Keep before choosing template");await page.getByRole("combobox",{name:"Pull request template",exact:true}).selectOption(".github/PULL_REQUEST_TEMPLATE/Feature.md");await button("Use template").click();await button("Replace description").waitFor();await page.keyboard.press("Escape");await page.waitForFunction(()=>document.querySelectorAll(".modal").length===1&&document.querySelector("[data-pr-editor=create]"));if(await page.getByRole("textbox",{name:"PR description",exact:true}).inputValue()!=="Keep before choosing template")throw Error("Escape changed the underlying description");await button("Use template").click();await button("Replace description").click();await page.waitForFunction(()=>document.querySelector('[aria-label="PR description"]')?.value.includes("Тест 😀"));
      await button("Create pull request").click();await page.waitForSelector("[data-pr-editor]",{state:"detached"});await detail(100);const write=requests.find(r=>r.method==="POST"&&r.path.includes("/pulls"));if(!write||write.body.draft!==false||!write.body.body.includes("Тест 😀"))throw Error("Template or ordinary PR creation lost");
    });
    await check("edit PR saves title, multiline description and destination without modifying the source",async()=>{
      await page.getByRole("button",{name:"Edit PR",exact:true}).click();if(!await page.getByLabel("PR source branch",{exact:true}).isDisabled())throw Error("Edit source must be immutable");await page.getByRole("textbox",{name:"PR title",exact:true}).fill("Edited PR title");await page.getByRole("textbox",{name:"PR description",exact:true}).fill("Edited description\n"+"Readable long message. ".repeat(100));await page.getByLabel("PR target branch",{exact:true}).fill("develop");await button("Save pull request").click();await page.waitForSelector("[data-pr-editor]",{state:"detached"});await page.getByRole("heading",{name:"Edited PR title",exact:true}).waitFor();if(pulls.get(100).base.ref!=="develop")throw Error("Retarget was not saved");await shot("106-pr-description");
    });
    await check("stale PR edits retain typed text and send no write before an explicit refresh",async()=>{
      await page.getByRole("button",{name:"Edit PR",exact:true}).click();await page.getByRole("textbox",{name:"PR title",exact:true}).fill("Preserved stale draft");pulls.get(100).updated_at="changed-by-reviewer";const before=requests.filter(r=>r.method==="PATCH").length;await button("Save pull request").click();await page.locator(".modal").getByRole("alert").filter({hasText:/pull request changed/i}).waitFor();if(await page.getByRole("textbox",{name:"PR title",exact:true}).inputValue()!=="Preserved stale draft"||requests.filter(r=>r.method==="PATCH").length!==before)throw Error("Stale edit was sent or draft was lost");await button("Cancel").click();await button("Discard edits").click();await page.waitForSelector("[data-pr-editor]",{state:"detached"});await page.getByRole("button",{name:"Reload request",exact:true}).click();await detail(100);
    });
    await check("PR file snapshots show rename, binary, mode changes and long lines in unified and split views",async()=>{
      await page.getByRole("button",{name:"Files (4)",exact:true}).click();await page.locator('[data-pr-file="src/new.ts"]').click();await page.locator(".pr-diff .diff-body").filter({hasText:"after"}).waitFor();await page.locator('[data-pr-file="asset.bin"]').click();await page.locator(".pr-diff .diff-body").filter({hasText:/binary/i}).waitFor();await page.locator('[data-pr-file="mode.txt"]').click();await page.getByText("Only the file mode changed.",{exact:true}).waitFor();await page.locator('[data-pr-file="long.txt"]').click();await page.locator(".pr-diff .diff-body").filter({hasText:"long-line-"}).waitFor();await page.getByTitle("Side by side",{exact:true}).click();await page.getByTitle("Unified",{exact:true}).click();const wrap=page.getByRole("button",{name:"Wrap lines",exact:true});await wrap.click();await wrap.click();if(await page.getByTitle("Show the whole file",{exact:true}).count())throw Error("Local Git options were shown for server-selected context");await shot("107-pr-file-diff");
    });
    await check("late PR metadata cannot replace a newer selected request",async()=>{
      let release,started;const promise=new Promise(r=>release=r),ready=new Promise(r=>started=r);hold={number:2,promise,started};await page.getByRole("textbox",{name:"Search loaded pull requests",exact:true}).fill("#2");await page.getByRole("button",{name:"Open #2",exact:true}).click();await ready;await openNumber(3);release();await page.getByRole("button",{name:"Overview",exact:true}).click();await detail(3);if(await page.locator('[data-pr-detail="2"]').count())throw Error("Late metadata replaced current PR");
    });
    await check("PR panel widths and collapsed state persist and all reads and metadata writes preserve staging",async()=>{
      await page.getByRole("button",{name:"Files (4)",exact:true}).click();await page.locator('[data-pr-file="src/new.ts"]').waitFor();const splitter=page.locator(".pr-files > .splitter-v"),box=await splitter.boundingBox();if(!box)throw Error("File splitter is missing");await page.mouse.move(box.x+box.width/2,box.y+50);await page.mouse.down();await page.mouse.move(box.x+box.width/2+35,box.y+50,{steps:5});await page.mouse.up();
      await page.getByRole("button",{name:"Hide PR files",exact:true}).click();await page.getByRole("button",{name:"Hide pull request list",exact:true}).click();await page.getByRole("button",{name:"History",exact:true}).click();await page.getByRole("button",{name:"Pull requests",exact:true}).click();await page.waitForSelector(".pr-center.pr-list-hidden .pr-files.pr-files-hidden");await page.getByRole("button",{name:"Show pull request list",exact:true}).click();await page.getByRole("button",{name:"Show files",exact:true}).click();await page.waitForFunction(()=>parseFloat(document.querySelector(".pr-files").style.getPropertyValue("--pr-files-width"))>220);
      if(git("rev-parse","HEAD")!==head||!index.equals(fs.readFileSync(path.join(root,".git/index")))||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="Keep this local work\n"||requests.some(r=>/info\/refs|git-receive-pack/.test(r.path)))throw Error("PR Center modified or pushed working files/index/HEAD");await shot("108-pr-panels");
    });
    await prReviewSmoke({page,check,shot,root,invoke,pulls,requests,fixture:reviewFixture,a,git,index,head});
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
