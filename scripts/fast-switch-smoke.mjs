import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";
import {launch} from "./ui-driver.mjs";

export async function fastSwitchSmoke({exe,work,check,out}){
 await check("cached repositories and branch previews remain visible while fresh IPC responses are held; My branches uses Git email and recent ordering",async()=>{
  const home=path.join(work,"fast-switch"),one=path.join(home,"switch-one"),two=path.join(home,"switch-two");fs.mkdirSync(home,{recursive:true});
  const git=(root,...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true}).trim();
  const commit=(root,body,title,time,other=false)=>{fs.writeFileSync(path.join(root,"file.txt"),body+"\n");git(root,"add",".");execFileSync("git",["-C",root,"-c",`user.name=${other?"Other author":"My author"}`,"-c",`user.email=${other?"other@example.invalid":"me@example.invalid"}`,"commit","-qm",title],{windowsHide:true,env:{...process.env,GIT_AUTHOR_DATE:`${time} +0000`,GIT_COMMITTER_DATE:`${time} +0000`}});};
  for(const root of [one,two]){fs.mkdirSync(root);git(root,"init","-qb","main");git(root,"config","user.name","My author");git(root,"config","user.email","me@example.invalid");git(root,"config","commit.gpgsign","false");git(root,"config","core.autocrlf","false");commit(root,"base-body",root===one?"Switch first base":"Switch second base",1700000000);}
  git(one,"checkout","-qb","feature/mine");commit(one,"feature-body","Switch first feature",1700000200,true);git(one,"checkout","main");git(one,"-c","user.name=Other author","-c","user.email=other@example.invalid","checkout","-qb","other/person");commit(one,"other-body","Switch other feature",1700000300);git(one,"checkout","main");
  let app,page;const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const graphReady=()=>page.waitForFunction(()=>{const el=document.querySelector(".graph-scroll");return el&&el.querySelectorAll(".grow").length>0&&!el.parentElement.querySelector(".spin");});
  const open=async(root)=>{await invoke("plugin:event|emit",{event:"open-paths",payload:[root]});await page.locator(".topbar .repo-current > b").filter({hasText:path.basename(root)}).waitFor();await graphReady();};
  const preview=body=>page.waitForFunction(body=>document.querySelector(".details")?.textContent.includes(body),body);
  try{
   app=await launch({exe,profile:path.join(home,"profile"),port:0,visible:false});page=app.page;page.setDefaultTimeout(60000);await page.getByRole("button",{name:"Skip",exact:true}).click();await open(one);
   // This test holds reads while jumping between commits already in one cached history.
   await page.getByRole("combobox",{name:"History scope",exact:true}).selectOption("");
   await page.locator(".graph-rows").getByText("Switch first feature",{exact:true}).waitFor();
   const branch=name=>page.locator(`.sidebar [data-branch-kind="local"][data-branch-name="${name}"]`);
   await branch("other/person").waitFor();
   assert.equal(await page.getByLabel("Branch list order",{exact:true}).inputValue(),"recent");
   assert.equal(await page.locator('.sidebar [data-branch-kind="local"]').first().getAttribute("data-branch-name"),"other/person");
   await page.locator(".sidebar").getByRole("button",{name:"My branches",exact:true}).click();await branch("other/person").waitFor({state:"detached"});await branch("feature/mine").waitFor();
   assert.equal(await page.locator('.sidebar [data-branch-kind="local"]').first().getAttribute("data-branch-name"),"feature/mine");
   if(out){await page.screenshot({path:path.join(out,"my-branches.png")});await page.locator(".sidebar").screenshot({path:path.join(out,"my-branches-sidebar.png")});}
   const commitRow=title=>page.locator(".graph-rows").getByText(title,{exact:true});
   await commitRow("Switch first base").click();await preview("base-body");await commitRow("Switch first feature").click();await preview("feature-body");
   await open(two);await page.locator(".explorer-sidebar .repository-select").filter({hasText:"switch-one"}).click();await graphReady();await preview("feature-body");await page.locator(".explorer-sidebar .repository-select").filter({hasText:"switch-two"}).click();await graphReady();
   // A repository switch through a different surface leaves the Explorer's
   // navigation anchor in place. Only the active repository gets the fill.
   const explorer = page.getByRole("complementary", { name: "Explorer", exact: true });
   const repoRow = name => explorer.getByRole("treeitem", { name, exact: true });
   const repositories = page.getByRole("button", { name: "Toggle repositories panel", exact: true });
   const wasOpen = await repositories.getAttribute("aria-expanded") === "true";
   if (!wasOpen) await repositories.click();
   const selectRepository = name => page.locator(".repository-flat-list .repository-select").filter({ hasText: name }).click();
   await selectRepository("switch-one");
   await commitRow("Switch first feature").waitFor();
   await repoRow("switch-one").locator(".repository-select[aria-current=true]").waitFor();
   await explorer.getByRole("textbox", { name: "Find in Explorer" }).hover();
   const fill = name => repoRow(name).evaluate(row => getComputedStyle(row).backgroundColor);
   assert.notEqual(await fill("switch-one"), "rgba(0, 0, 0, 0)");
   assert.equal(await fill("switch-two"), "rgba(0, 0, 0, 0)");
   assert.equal(await commitRow("Switch second base").count(), 0);
   await selectRepository("switch-two");
   await commitRow("Switch second base").waitFor();
   if (!wasOpen) await repositories.click();
   const installGate=(commands=["repo_info","status","refs_snapshot","layers_state","repo_extras","graph_rows","graph_find","commit_details","rev_diff","working_diff"], omitSnapshotFor=null, prFixtures=null)=>page.evaluate(async ({commands,omitSnapshotFor,prFixtures})=>{
    const bridge=window.__TAURI_INTERNALS__,original=window.fetch,held=[],counts={},stageResponses=[];let active=true,omittedSnapshots=0;
    const urls=new Map(commands.map(command=>[bridge.convertFileSrc(command,"ipc"),command]));
    const probe=bridge.convertFileSrc("plugin:app|version","ipc");
    const stageUrl=bridge.convertFileSrc("apply_selection","ipc");
    const diffUrl=bridge.convertFileSrc("working_diff","ipc");
    const repoKey=value=>value.replaceAll("\\","/").toLowerCase();
    let probes=0;
    const replacement=async function(input,init){
      const url=typeof input==="string"?input:input.url;
      const command=urls.get(url);
      if(url===probe)probes++;
      if(command)counts[command]=(counts[command]??0)+1;
      if(url===bridge.convertFileSrc("graph_load","ipc"))counts.graph_load=(counts.graph_load??0)+1;
      const omitSnapshot=active&&url===diffUrl&&omitSnapshotFor&&repoKey(JSON.parse(init.body).repo)===repoKey(omitSnapshotFor);
      const payload=command ? JSON.parse(init.body) : null;
      // Fixtures can change while the gate is installed (window.__prFixtures) and differ by request status.
      const fixtures=window.__prFixtures??prFixtures;
      const fixtureFor=repo=>fixtures?.find(entry=>repoKey(entry.root)===repoKey(repo));
      const prPage=command==="pr_page" && fixtureFor(payload.repo);
      const forgeKind=url===bridge.convertFileSrc("forge_kind","ipc") && fixtureFor(JSON.parse(init.body).repo);
      if(forgeKind)return new Response(JSON.stringify("github"),{headers:{"content-type":"application/json","Tauri-Response":"ok"}});
      const response=prPage ? new Response(JSON.stringify(prPage.pages?.[payload.state]??prPage.page),{headers:{"content-type":"application/json","Tauri-Response":"ok"}})
        : await Reflect.apply(original,window,[input,init]);
      if(omitSnapshot&&response.ok){
        const diff=await response.json();
        if(Object.hasOwn(diff,"stageSnapshot"))omittedSnapshots++;
        delete diff.stageSnapshot;
        const headers=new Headers(response.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(diff),{status:response.status,headers});
      }
      if(!active)return response;
      if(url===stageUrl){
        const {repo,path,mode,stageSnapshot}=JSON.parse(init.body);
        stageResponses.push({repo,path,mode,stageSnapshot,ok:response.ok});
      }
      if(command&&response.ok){
        const repo=payload.repo ?? payload.path;
        return new Promise(resolve=>held.push({command,repo,release:()=>resolve(response)}));
      }
      return response;
    };
    if(!Reflect.set(window,"fetch",replacement)||window.fetch!==replacement)throw Error("Could not install native read-response gate");
    window.__fastSwitchGate={held,counts,stageResponses,get omittedSnapshots(){return omittedSnapshots;},restore:()=>{active=false;for(const entry of held)entry.release();window.fetch=original;delete window.__fastSwitchGate;}};
    await bridge.invoke("plugin:app|version");if(probes!==1){window.__fastSwitchGate.restore();throw Error("Native IPC did not pass through fetch gate");}return true;
   },{commands,omitSnapshotFor,prFixtures});assert(await installGate());
   const repositorySwitch=performance.now();
   await page.locator(".explorer-sidebar .repository-select").filter({hasText:"switch-one"}).click();await page.locator(".topbar .repo-current > b").filter({hasText:"switch-one"}).waitFor();
   await page.waitForFunction(()=>window.__fastSwitchGate.held.length>0);
   await page.locator(".graph-rows").getByText("Switch first feature",{exact:true}).waitFor();await preview("feature-body");
   console.log(`Cached repository and diff rendered with native reads held in ${Math.round(performance.now()-repositorySwitch)} ms`);
   assert.equal(await page.locator(".sidebar").getByRole("button",{name:"My branches",exact:true}).getAttribute("aria-pressed"),"true");
   const branchSwitch=performance.now();
   await commitRow("Switch first base").click();await preview("base-body");await commitRow("Switch first feature").click();await preview("feature-body");
   console.log(`Two cached commit previews rendered with native reads held in ${Math.round(performance.now()-branchSwitch)} ms`);
   const counts=await page.evaluate(()=>({...window.__fastSwitchGate.counts}));assert.equal(counts.graph_load??0,0,"Activation rebuilt an unchanged graph");assert.equal(git(one,"branch","--show-current"),"main","Single branch clicks must not check out a branch");
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   // Hold the branch graph itself while the top bar and Explorer switch scope.
   // A cached All branches graph must not appear under the new scope.
   assert(await installGate(["graph_load", "graph_rows"]));
   await branch("feature/mine").click();
   await page.waitForFunction(() => window.__fastSwitchGate.held.some(entry => entry.command === "graph_load"));
   assert.equal(await commitRow("Switch other feature").count(), 0, "Previous scope stayed visible during a branch switch");
   await page.evaluate(() => {
    const held = window.__fastSwitchGate.held.find(entry => entry.command === "graph_load");
    held.release();
   });
   await page.waitForFunction(() => window.__fastSwitchGate.held.some(entry => entry.command === "graph_rows"));
   assert.equal(await commitRow("Switch other feature").count(), 0, "Previous scope reappeared before the new graph rows arrived");
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   await commitRow("Switch first feature").waitFor();
   const indexBytes=root=>fs.readFileSync(path.join(root,".git/index"));
   const workingFile=root=>path.join(root,"file.txt");
   const stageHunk=page.getByRole("button",{name:"Stage hunk",exact:true});
   const cachedDiff=page.locator(".changes .diff[aria-busy='true']");
   const cachedAdded=body=>cachedDiff.locator(".dl.add",{hasText:body});
   const switchToCachedDiff=async(root,body)=>{
    await page.locator(".explorer-sidebar .repository-select").filter({hasText:path.basename(root)}).click();
    await page.waitForFunction(({root,windows})=>{
      const key=value=>windows?value.replaceAll("\\","/").toLowerCase():value;
      return window.__fastSwitchGate.held.some(entry=>entry.command==="working_diff"&&key(entry.repo)===key(root));
    },{root,windows:process.platform==="win32"});
    await cachedAdded(body).waitFor();
    assert.equal(await cachedDiff.getByRole("button",{name:"Stash hunk",exact:true}).count(),0,"Cached diff exposed stash before revalidation");
    assert.equal(await cachedDiff.getByTitle("Discard hunk",{exact:true}).count(),0,"Cached diff exposed discard before revalidation");
   };
   // Cache a real diff with the optional staging capability omitted for the
   // second repository. Large native diffs would also exceed the UI cache limit.
   for(const [root,body] of [[one,"first-working-change"],[two,"second-working-change"]]){
    if(root===two)assert(await installGate([],two));
    fs.appendFileSync(workingFile(root),`${body}\n`);
    await page.locator(".explorer-sidebar .repository-select").filter({hasText:path.basename(root)}).click();
    await page.click(".view-tab:has-text('Changes')");await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator(".changes .diff[aria-busy='false'] .dl.add",{hasText:body}).waitFor();
    await stageHunk.waitFor();
    if(root===two){
     assert(await page.evaluate(()=>window.__fastSwitchGate.omittedSnapshots>0),"The second cached diff must lack a staging snapshot");
     await page.evaluate(()=>window.__fastSwitchGate.restore());
    }
   }
   const firstIndex=indexBytes(one),secondIndex=indexBytes(two),secondContent=fs.readFileSync(workingFile(two),"utf8");
   assert(await installGate(["working_diff"]));
   fs.appendFileSync(workingFile(one),"newer-working-change\n");
   await switchToCachedDiff(one,"first-working-change");
   assert.equal(await cachedAdded("second-working-change").count(),0,"Displayed a cached diff from another repository");
   assert.equal(await cachedAdded("newer-working-change").count(),0,"The new diff was not held");
   assert(indexBytes(one).equals(firstIndex)&&indexBytes(two).equals(secondIndex),"Showing a cached diff changed an index");
   await cachedDiff.getByRole("button",{name:"Stage hunk",exact:true}).click();
   await page.waitForFunction(()=>window.__fastSwitchGate.stageResponses.length>0);
   const [staged]=await page.evaluate(()=>window.__fastSwitchGate.stageResponses);
   assert(staged.ok&&staged.mode==="stage"&&staged.path==="file.txt"&&Number.isInteger(staged.stageSnapshot),"Stage did not apply the displayed snapshot");
   assert.equal(fs.realpathSync(staged.repo),fs.realpathSync(one),"Stage targeted another repository");
   assert.equal(git(one,"show",":file.txt"),"base-body\nfirst-working-change","Index contains a different snapshot from the one displayed");
   assert.equal(fs.readFileSync(workingFile(one),"utf8"),"base-body\nfirst-working-change\nnewer-working-change\n","Stage changed the newer working copy");
   assert(indexBytes(two).equals(secondIndex),"Stage touched the other repository’s index");
   assert.equal(fs.readFileSync(workingFile(two),"utf8"),secondContent);
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   await page.locator(".changes .diff[aria-busy='false'] .dl.add",{hasText:"newer-working-change"}).waitFor();

   assert(await installGate(["working_diff"]));
   await switchToCachedDiff(two,"second-working-change");
   assert.equal(await cachedDiff.getByRole("button",{name:"Stage hunk",exact:true}).count(),0,"Cached diff without a snapshot offered Stage hunk");
   assert(indexBytes(two).equals(secondIndex),"Opening the cached diff changed the other repository’s index");
   await page.evaluate(()=>window.__fastSwitchGate.restore());
   await stageHunk.waitFor();

   // Repository-scoped PR Center must follow Explorer even if the source
   // repository's remote and branch list have already been read.
   git(one, "remote", "add", "origin", "https://example.invalid/team/first.git");
   await repoRow("switch-one").locator(".repository-select").click();
   await page.locator(".sidebar [data-branch-name='feature/mine']").waitFor();
   await page.getByRole("button", { name: "Refresh", exact: true }).click();
   await page.locator(".view-tab").getByText("Pull requests", { exact: true }).click();
   const prCenter = page.getByRole("region", { name: "Pull Request Center", exact: true });
   await prCenter.getByText("Configure an API connection first.", { exact: false }).waitFor();
   await repoRow("switch-two").locator(".repository-select").click();
   await prCenter.getByText("No remote configured", { exact: true }).waitFor();
   assert.equal(await page.locator(".sidebar [data-branch-name='feature/mine']").count(), 0);
   assert.equal(await page.getByLabel("Pull request scope").inputValue(), "repository");

   // Navigate using only Explorer and History, including a late open from a branch.
   if (await repositories.getAttribute("aria-expanded") === "true") await repositories.click();
   await page.locator(".main-head").getByRole("button", { name: "History", exact: true }).click();
   await commitRow("Switch second base").waitFor();
   const first = repoRow("switch-one"), second = repoRow("switch-two");
   const firstButton = first.locator(".repository-select"), secondButton = second.locator(".repository-select");
   await first.getByRole("button", { name: "Expand branches in switch-one" }).click();
   const feature = explorer.getByRole("treeitem", { name: "feature/mine", exact: true }).locator(".repository-select");
   await feature.waitFor();
   assert.equal(await secondButton.getAttribute("aria-current"), "true");
   assert.equal(await commitRow("Switch second base").count(), 1);
   const activeMark = row => row.evaluate(element => getComputedStyle(element, "::before").content);
   assert.equal(await activeMark(first), "none");
   assert.notEqual(await activeMark(second), "none");
   await firstButton.click({ modifiers: ["Control"] });
   assert.equal(await first.getAttribute("aria-selected"), "true");
   assert.equal(await secondButton.getAttribute("aria-current"), "true");
   await page.keyboard.press("Escape");
   assert.equal(await first.getAttribute("aria-selected"), "false");
   await first.getByRole("button", { name: "Close switch-one" }).click();
   await feature.waitFor();
   assert(await installGate(["repo_open"]));
   await feature.click();
   await page.waitForFunction(() => window.__fastSwitchGate.held.some(entry => entry.command === "repo_open"));
   await first.locator(".repository-select[aria-current=true]").waitFor();
   assert.equal(await commitRow("Switch second base").count(), 0, "Previous repository's graph remained visible while reopening");
   await secondButton.click();
   await commitRow("Switch second base").waitFor();
   await page.evaluate(() => window.__fastSwitchGate.restore());
   await first.and(page.locator("[data-repository-state='open']")).waitFor();
   assert.equal(await secondButton.getAttribute("aria-current"), "true");
   assert.equal(await feature.getAttribute("aria-current"), "false");
   assert.equal(await commitRow("Switch first feature").count(), 0);
   await feature.click();
   await commitRow("Switch first feature").waitFor();
   assert.equal(await firstButton.getAttribute("aria-current"), "true");
   assert.equal(await feature.getAttribute("aria-current"), "true");
   assert.equal(await commitRow("Switch second base").count(), 0);
   assert.equal(await page.getByLabel("History scope").inputValue(), "refs/heads/feature/mine");
   assert.equal(git(one, "branch", "--show-current"), "main");

   // Both repositories advertise the same PR number and branches. Distinguish
   // their responses by content, then release the previous response last.
   git(two, "remote", "add", "origin", "https://example.invalid/team/second.git");
   await secondButton.click();
   await page.getByRole("button", { name: "Refresh", exact: true }).click();
   const fixtures = [one, two].map((root, index) => {
    const project = "team/" + path.basename(root);
    const webUrl = "https://example.invalid/" + project;
    return {root, page: {forge: {kind: "github", host: "example.invalid", project, remote: "origin", webUrl, api: webUrl, accountLogin: "test", connectionRevision: "connection-" + index},
      items: [{number: 7, title: "PR from " + path.basename(root), author: "My author", head: "feature/mine", base: "main", state: "open", draft: false, url: webUrl + "/pull/7", created: "2026-01-01T00:00:00Z", headSha: "a".repeat(40)}], nextCursor: null}};
   });
   assert(await installGate(["pr_page"], null, fixtures));
   const pulls = page.locator(".main-head").getByRole("button", { name: "Pull requests", exact: true });
   await pulls.click();
   await page.waitForFunction(() => window.__fastSwitchGate.held.some(entry => entry.repo.endsWith("switch-two")));
   await firstButton.click();
   await page.waitForFunction(() => window.__fastSwitchGate.held.some(entry => entry.repo.endsWith("switch-one")));
   await page.evaluate(() => {
    for (const entry of window.__fastSwitchGate.held) if (entry.repo.endsWith("switch-one")) entry.release();
   });
   await prCenter.getByText("PR from switch-one", { exact: true }).waitFor();
   await page.evaluate(() => window.__fastSwitchGate.restore());
   assert.equal(await firstButton.getAttribute("aria-current"), "true");
   assert.equal(await prCenter.getByText("PR from switch-two", { exact: true }).count(), 0);

   // All repositories: a refresh keeps every row visible while its answers are held, updates each
   // repository as it answers, and never applies answers for an earlier request status.
   const pagesFor = (suffix) => fixtures.map(({root, page: base}) => ({root, pages: Object.fromEntries(["open", "closed"].map(state => [state, {...base,
     items: base.items.map(item => ({...item, state, title: `${state === "open" ? "PR" : "Closed PR"} from ${path.basename(root)}${suffix}`}))}]))}));
   await page.evaluate(value => { window.__prFixtures = value; }, pagesFor(""));
   assert(await installGate(["pr_page"], null, pagesFor("")));
   await page.getByLabel("Pull request scope").selectOption("all");
   const combined = page.getByRole("region", { name: "Pull requests across repositories", exact: true });
   await combined.getByRole("combobox", { name: "Authors across repositories", exact: true }).selectOption("all");
   const releaseAll = () => page.evaluate(() => { for (const entry of window.__fastSwitchGate.held.splice(0)) entry.release(); });
   await page.waitForFunction(() => window.__fastSwitchGate.held.length >= 2);
   await releaseAll();
   const listed = combined.getByRole("listbox", { name: "Pull requests", exact: true }).getByRole("option");
   const row = title => listed.filter({ hasText: title });
   await row("PR from switch-one").waitFor();
   await row("PR from switch-two").waitFor();
   await page.evaluate(value => { window.__prFixtures = value; }, pagesFor(" (refreshed)"));
   await combined.getByRole("button", { name: "Refresh all pull requests", exact: true }).first().click();
   await page.waitForFunction(() => window.__fastSwitchGate.held.length >= 2);
   for (const name of ["switch-one", "switch-two"]) assert.equal(await row(`PR from ${name}`).getAttribute("data-pr-stale"), "true", `${name} stays visible, marked as earlier`);
   await combined.getByRole("status").filter({ hasText: "earlier results stay" }).waitFor();
   await page.evaluate(() => { const held = window.__fastSwitchGate.held; const index = held.findIndex(entry => entry.repo.endsWith("switch-one")); held.splice(index, 1)[0].release(); });
   await row("PR from switch-one (refreshed)").waitFor();
   assert.equal(await row("PR from switch-one (refreshed)").getAttribute("data-pr-stale"), null);
   assert.equal(await row("PR from switch-two").getAttribute("data-pr-stale"), "true", "switch-two has not answered yet");
   await releaseAll();
   await row("PR from switch-two (refreshed)").waitFor();
   await combined.getByRole("status").filter({ hasText: /^Updated / }).waitFor();
   // Another status while the open answers are held: they are dropped, not shown as closed ones.
   await combined.getByRole("button", { name: "Refresh all pull requests", exact: true }).first().click();
   await page.waitForFunction(() => window.__fastSwitchGate.held.length >= 2);
   await combined.getByRole("combobox", { name: "Request status across repositories", exact: true }).selectOption("closed");
   assert.equal(await listed.count(), 0, "another status starts an empty list");
   // The held open answers arrive after the switch; the closed scan starts once they are done.
   await releaseAll();
   await page.waitForFunction(() => window.__fastSwitchGate.held.length >= 2);
   assert.equal(await listed.count(), 0, "answers for the earlier status were applied");
   await releaseAll();
   await row("Closed PR from switch-one (refreshed)").waitFor();
   await row("Closed PR from switch-two (refreshed)").waitFor();
   assert.equal(await listed.count(), 2);
   await page.evaluate(() => { window.__fastSwitchGate.restore(); delete window.__prFixtures; });
   await combined.getByRole("combobox", { name: "Request status across repositories", exact: true }).selectOption("open");
   await page.getByLabel("Pull request scope").selectOption("repository");

   const nested = path.join(one, "stale-nested");
   fs.mkdirSync(nested);
   git(nested, "init", "-qb", "main");
   await invoke("plugin:event|emit", {event: "open-paths", payload: [nested]});
   const nestedRow = repoRow("stale-nested");
   await nestedRow.and(page.locator("[data-repository-state='open']")).waitFor();
   await nestedRow.getByRole("button", { name: "Close stale-nested" }).click();
   fs.renameSync(path.join(nested, ".git"), path.join(nested, "saved-git-metadata"));
   assert.equal(fs.realpathSync(git(nested, "rev-parse", "--show-toplevel")), fs.realpathSync(one));
   await nestedRow.locator(".repository-select").click();
   await page.getByRole("alert").and(page.locator(":not(.toast)")).filter({hasText: "This saved folder is no longer a Git repository"}).waitFor();
   assert.equal(await nestedRow.locator(".repository-select").getAttribute("aria-current"), "true");
   assert.equal(await firstButton.getAttribute("aria-current"), "false");
   assert.equal(await prCenter.count(), 0);
  }catch(error){if(out)await page?.screenshot({path:path.join(out,"fast-switch-failure.png")}).catch(()=>{});throw error;}
  finally{await page?.evaluate(()=>window.__fastSwitchGate?.restore()).catch(()=>{});if(app){for(const repo of [one,two])await invoke("unwatch_repo",{repo}).catch(()=>{});await app.close();}}
 });
}
