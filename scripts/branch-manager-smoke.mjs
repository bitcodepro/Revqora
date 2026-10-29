import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfile, launch, withViewport } from "./ui-driver.mjs";

export async function branchManagerSmoke({ page, check, shot, work }) {
  const root = path.join(work, "stage9-branches"), wt = path.join(work, "stage9-linked");
  fs.mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "Branch Tester"], ["user.email", "branch@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git("config", key, value);
  fs.writeFileSync(path.join(root, "file.txt"), "base\n"); git("add", "."); git("commit", "-qm", "Branch manager base");
  const base = git("rev-parse", "HEAD");
  git("branch", "occupied"); git("worktree", "add", wt, "occupied");
  git("checkout", "-qb", "feature/login"); fs.appendFileSync(path.join(root, "file.txt"), "login\n"); git("commit", "-qam", "Add authentication flow");
  const tip = git("rev-parse", "HEAD"); git("checkout", "main");
  git("remote", "add", "origin", "https://example.invalid/never-contacted.git");
  git("config", "--unset-all", "remote.origin.fetch");
  git("config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/innocent");
  git("update-ref", "refs/remotes/origin/innocent", base);
  const refs = Array.from({ length: 240 }, (_, i) => `create refs/heads/topic/${String(i).padStart(3,"0")} ${base}`).join("\n") + "\n";
  execFileSync("git", ["-C", root, "update-ref", "--stdin"], { input: refs, windowsHide: true });
  const before = fs.readFileSync(path.join(root, ".git/index"));
  const open = async () => { await page.getByRole("button", { name: "Open branch manager", exact: true }).click(); await page.waitForSelector(".bm-body[aria-busy=false]"); };
  const manager = () => page.locator(".branch-manager");
  const row = ref => page.locator(`[data-branch-ref='${ref}']`);
  await page.evaluate(root => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: [root] }), root);
  await page.locator(".topbar .repo-current > b").filter({ hasText: "stage9-branches" }).waitFor();
  await check("branch manager virtualizes inventory, searches messages and compares exact commit IDs", async () => {
    await open();
    if (await page.locator(".bm-viewport [role=option]").count() > 50) throw new Error("Branch list rendered all rows instead of virtualizing");
    await manager().getByRole("button", { name: "Unmerged", exact: true }).click();
    await row("refs/heads/feature/login").waitFor();
    if (await page.locator(".bm-viewport [role=option]").count() !== 1) throw new Error("Unmerged filter ignored physical ancestry");
    await row("refs/heads/feature/login").click();
    await manager().getByText("1 ahead · 0 behind", { exact: true }).waitFor();
    await manager().getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("textbox", { name: "Search branches" }).fill("authentication");
    await row("refs/heads/feature/login").waitFor();
    await manager().getByRole("button", { name: "Compare files", exact: true }).click();
    await page.waitForSelector(".conflict-overlay:not(.branch-manager)");
    const values = await page.locator(".conflict-overlay input.mono").evaluateAll(nodes => nodes.map(n => n.value));
    if (!values.includes(base) || !values.includes(tip)) throw new Error("Comparison did not freeze reviewed commit IDs");
    await page.locator(".conflict-overlay").getByRole("button", { name: "Close", exact: true }).click();
  });
  await check("branch manager protects aliased server main and blocks actions on occupied worktrees", async () => {
    await open();
    await manager().getByRole("button", { name: "Protected", exact: true }).click();
    await row("refs/remotes/origin/innocent").click();
    for (const name of ["Review deletion…", "Rename…"]) if (await manager().getByRole("button", { name, exact: true }).isEnabled()) throw new Error(`Aliased server main allows ${name}`);
    await manager().getByRole("button", { name: "Active", exact: true }).click();
    await row("refs/heads/occupied").click();
    await manager().locator(".bm-detail p").filter({ hasText: "stage9-linked" }).waitFor();
    for (const name of ["Checkout", "Rename…", "Review deletion…"]) if (await manager().getByRole("button", { name, exact: true }).isEnabled()) throw new Error(`Occupied worktree allows ${name}`);
    await shot("77-branch-manager-worktrees");
  });
  await check("branch manager remembers per-repository preferences and refreshes external branch changes", async () => {
    await manager().getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("combobox", { name: "Branch scope" }).selectOption("local");
    await page.getByRole("combobox", { name: "Sort branches" }).selectOption("name");
    await page.getByRole("spinbutton", { name: "Stale branch days" }).fill("30");
    await page.getByRole("button", { name: "Close branch manager", exact: true }).click();
    await page.reload();
    await page.locator(".topbar .repo-current > b").filter({ hasText: "stage9-branches" }).waitFor();
    await open();
    for (const [name, expected] of [["Branch scope","local"],["Sort branches","name"]]) if (await page.getByRole("combobox", {name}).inputValue() !== expected) throw new Error(`${name} was not remembered`);
    if (await page.getByRole("spinbutton", {name:"Stale branch days"}).inputValue() !== "30") throw new Error("Stale days were not remembered");
    await page.getByRole("textbox", { name: "Search branches" }).fill("external/new");
    git("branch", "external/new");
    await row("refs/heads/external/new").waitFor({ timeout: 30000 });
    await shot("78-branch-manager-external");
    await page.getByRole("textbox", { name: "Search branches" }).fill("");
    const list = page.getByRole("listbox", { name: "Branches", exact: true });
    await list.focus(); await page.keyboard.press("End");
    await row("refs/heads/topic/239").waitFor();
    if (await page.locator(".bm-viewport [role=option]").count() > 50) throw new Error("Scrolling disabled virtualization");
    await shot("79-branch-manager-list");
    if (!fs.readFileSync(path.join(root,".git/index")).equals(before)) throw new Error("Read-only manager modified the Git index");
    await page.getByRole("button", { name: "Close branch manager", exact: true }).click();
  });
  await check("a delayed old branch snapshot cannot overwrite newer external Git state", async () => {
    await open();
    await page.evaluate(() => {
      const original = window.fetch;
      const endpoint = window.__TAURI_INTERNALS__.convertFileSrc("branch_manager_snapshot", "ipc");
      const race = window.__branchManagerRace = { original, held:false, release:null, returned:false };
      window.fetch = async function(input, init) {
        const response = await original.call(this,input,init);
        if (String(input) === endpoint && !race.held) {
          race.held = true;
          await new Promise(resolve => { race.release = resolve; });
          race.returned = true;
        }
        return response;
      };
    });
    try {
      await page.getByRole("button", { name:"Refresh branches",exact:true }).click();
      await page.waitForFunction(() => window.__branchManagerRace?.held);
      git("commit","--allow-empty","-qm","External branch update during refresh");
      const newBase = git("rev-parse","HEAD");
      await page.waitForFunction(oid => {
        const shown = document.querySelector(".bm-detail > small.mono")?.textContent;
        return shown && oid.startsWith(shown) && document.querySelector(".bm-body")?.getAttribute("aria-busy") === "false";
      }, newBase);
      await page.evaluate(() => window.__branchManagerRace.release());
      await page.waitForFunction(() => window.__branchManagerRace.returned);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await manager().locator(".bm-detail > small.mono").innerText() !== newBase.slice(0,8)) throw new Error("Old response replaced the refreshed base");
      const beforeResize = await page.evaluate(() => ({ width:innerWidth, height:innerHeight }));
      await withViewport(page, {width:1000,height:720}, async () => {
      const frame = await manager().boundingBox(), detail = await manager().locator(".bm-detail").boundingBox(), list = await manager().locator(".bm-list").boundingBox();
      if (!frame || !detail || !list) throw new Error("Manager layout is missing");
      // Prior workspace scenarios can restore hidden sidebars. Responsiveness
      // follows this workspace's actual width, not the whole browser viewport.
      if (frame.width <= 780 ? detail.y < list.y + list.height - 1 : detail.x < list.x + list.width - 1) throw new Error("Manager layout did not adapt to its available width");
      await shot("80-branch-manager-narrow");
      });
      const afterResize = await page.evaluate(() => ({ width:innerWidth, height:innerHeight, right:document.querySelector(".app").getBoundingClientRect().right }));
      if (afterResize.width !== beforeResize.width || afterResize.height !== beforeResize.height || Math.abs(afterResize.right - beforeResize.width) > 1) throw new Error("Narrow test left unused native window space");
      const native = await page.evaluate(async () => ({
        size: await window.__TAURI_INTERNALS__.invoke("plugin:window|inner_size",{}),
        scale: await window.__TAURI_INTERNALS__.invoke("plugin:window|scale_factor",{}),
      }));
      if (Math.abs(afterResize.width - native.size.width / native.scale) > 1 || Math.abs(afterResize.height - native.size.height / native.scale) > 1) throw new Error("Restored page does not fill the native window");
      await shot("81-branch-manager-restored");
    } finally {
      await page.evaluate(() => { const race = window.__branchManagerRace; race.release?.(); window.fetch = race.original; delete window.__branchManagerRace; });
    }
    await page.getByRole("button", { name: "Close branch manager", exact: true }).click();
  });
}

export async function branchManagerProtectionSmoke({ page, check, shot, work }) {
  const git = (dir,...args) => execFileSync("git",["-C",dir,...args],{encoding:"utf8",windowsHide:true}).trim();
  const invoke = (command,args) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  for (const alias of [false,true]) await check(`manager combined deletion enforces protection for ${alias ? "aliased" : "standard"} upstreams`,async()=>{
    const name=`stage9-protection-${alias ? "alias" : "standard"}`,root=path.join(work,name),server=path.join(work,name+".git");
    fs.mkdirSync(root);git(root,"init","-q","-b","main");
    for(const [key,value] of [["user.name","Protection Tester"],["user.email","protection@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"],["core.hooksPath",".git/hooks"]])git(root,"config",key,value);
    fs.writeFileSync(path.join(root,"file.txt"),"retained by main\n");git(root,"add",".");git(root,"commit","-qm","Protection fixture");git(root,"branch","topic");
    const oid=git(root,"rev-parse","HEAD"),index=fs.readFileSync(path.join(root,".git/index"));
    git(root,"clone","--bare",".",server);git(server,"config","receive.denyDeleteCurrent","ignore");git(root,"remote","add","origin",server);
    if(alias){git(root,"config","remote.origin.fetch","+refs/heads/main:refs/remotes/origin/innocent");git(root,"config","--add","remote.origin.fetch","+refs/heads/topic:refs/remotes/origin/topic");}
    git(root,"fetch","-q","origin");
    const trackTopic=()=>{git(root,"config","branch.topic.remote","origin");git(root,"config","branch.topic.merge","refs/heads/main");};trackTopic();
    await invoke("plugin:event|emit",{event:"open-paths",payload:[root]});
    await page.locator(".topbar .repo-current > b").filter({hasText:name}).waitFor();
    await page.getByRole("button",{name:"Open branch manager",exact:true}).click();await page.waitForSelector(".bm-body[aria-busy=false]");
    const openReview=async()=>{
      await page.getByRole("textbox",{name:"Search branches"}).fill("topic");await page.locator('[data-branch-ref="refs/heads/topic"]').click();
      await page.locator(".branch-manager").getByRole("button",{name:"Review deletion…",exact:true}).click();
      await page.waitForSelector(".branch-review[aria-busy=false][data-review-local-oid]");
    };
    await openReview();
    const checkbox=page.locator(".delete-remote-branch"),submit=page.locator(".delete-branch-confirm");
    if(!await checkbox.isDisabled() || await checkbox.isChecked() || !await submit.isEnabled())throw new Error("Protected upstream did not leave only local deletion available");
    await page.locator(".branch-deletion-protection").filter({hasText:"main is protected"}).waitFor();
    // Exercise the backend independently of the disabled checkbox. The entire
    // combined action must fail before deleting topic, even with force=true.
    const targets=await invoke("branch_delete_targets",{repo:root,name:"topic"});
    const target=targets.find(t=>t.remoteRef==="refs/heads/main");
    const plan=await invoke("branch_delete_plan",{repo:root,name:"topic",base:"refs/heads/main",target,remoteOnly:false});
    const error=await page.evaluate(async({root,plan})=>{
      try{await window.__TAURI_INTERNALS__.invoke("branch_delete_reviewed",{repo:root,review:plan.proof,includeRemote:true,force:true,expectedState:plan.stateToken,protectionRules:["main","master","develop","release/*"]});return null;}catch(e){return e;}
    },{root,plan});
    if(error?.kind!=="protected-branch" || git(root,"rev-parse","topic")!==oid || git(server,"rev-parse","main")!==oid)throw new Error("Combined deletion bypassed backend protection");
    const remote=page.getByRole("combobox",{name:"Remote branch",exact:true});
    await remote.selectOption({label:"origin/topic"});await page.waitForSelector(".branch-review[aria-busy=false][data-review-local-oid]");await checkbox.check();
    await remote.selectOption({label:"origin/main"});await page.waitForSelector(".branch-review[aria-busy=false][data-review-local-oid]");
    if(await submit.isEnabled())throw new Error("Switching the selected target bypassed protection");
    await page.getByRole("button",{name:"Refresh remote state for review",exact:true}).click();await page.waitForSelector(".branch-review[aria-busy=false][data-review-local-oid]");
    await page.waitForSelector(".remote-deletion-review");await page.locator(".confirm-reviewed-remote").check();
    if(await submit.isEnabled())throw new Error("Refreshing or confirming the protected target bypassed protection");
    await checkbox.uncheck();if(!await submit.isEnabled())throw new Error("Local-only deletion became unavailable");
    await shot(`82-protected-combined-${alias ? "alias" : "standard"}`);
    await submit.click();await page.waitForSelector(".modal",{state:"detached",timeout:180000});
    if(git(root,"for-each-ref","--format=%(objectname)","refs/heads/topic") || git(server,"rev-parse","main")!==oid || git(server,"rev-parse","topic")!==oid || !fs.readFileSync(path.join(root,".git/index")).equals(index))throw new Error("Local-only deletion changed protected remote or index");
    // Explicitly editing the rule is the only supported way to allow main.
    git(root,"branch","topic");trackTopic();await page.getByRole("button",{name:"Refresh branches",exact:true}).click();await page.waitForSelector(".bm-body[aria-busy=false]");
    await page.getByRole("button",{name:"Protection rules",exact:true}).click();await page.getByRole("textbox",{name:"Branch protection rules"}).fill("master\ndevelop\nrelease/*");await page.getByRole("button",{name:"Save rules",exact:true}).click();
    await openReview();if(await checkbox.isDisabled())throw new Error("Edited rules did not allow the reviewed target");
    await checkbox.check();await submit.click();await page.waitForSelector(".modal",{state:"detached",timeout:180000});
    if(git(root,"for-each-ref","--format=%(objectname)","refs/heads/topic") || git(server,"for-each-ref","--format=%(objectname)","refs/heads/main") || git(root,"rev-parse","main")!==oid)throw new Error("Explicit rule change did not authorize exactly the selected deletions");
    await page.getByRole("button",{name:"Close branch manager",exact:true}).click();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work = createProfile("branch-manager-");
  if (!process.argv.includes("--exe")) throw new Error("Pass --exe <built application>");
  const exe = process.argv[process.argv.indexOf("--exe") + 1];
  const out = process.env.REVQORA_SMOKE_OUT || path.join(work,"shots"); fs.mkdirSync(out,{recursive:true});
  const app = await launch({ exe, profile:path.join(work,"profile"), port:0 });
  const errors = []; app.page.on("pageerror", e => errors.push(e.message));
  try {
    await app.page.getByRole("button", { name:"Skip", exact:true }).click({ timeout:60000 });
    await app.page.getByTitle("Settings",{exact:true}).click();await app.page.locator(".modal label:has-text('Auto fetch') + .seg").getByRole("button",{name:"Off",exact:true}).click();await app.page.locator(".modal").getByRole("button",{name:"Done",exact:true}).click();
    if (!process.argv.includes("--protection-only")) await branchManagerSmoke({ page:app.page, work, check: async (name,fn) => { await fn(); console.log(`PASS ${name}`); }, shot: name => app.page.screenshot({path:path.join(out,`${name}.png`)}) });
    await branchManagerProtectionSmoke({ page:app.page, work, check: async (name,fn) => { await fn(); console.log(`PASS ${name}`); }, shot: name => app.page.screenshot({path:path.join(out,`${name}.png`)}) });
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (e) {
    await app.page.screenshot({ path:path.join(out,"failure.png") }).catch(() => {});
    throw e;
  } finally { await app.close(); fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:300}); }
}
