import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfile, launch, openSubmenu, withViewport } from "./ui-driver.mjs";
import { branchScrollBoundary } from "./branch-scroll-boundary.mjs";

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
  const row = ref => manager().locator(`[data-branch-ref='${ref}']`);
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
    await branchScrollBoundary(page);
    // Exercise native wheel input and a real refreshed snapshot, not just
    // programmatic scrollTop. Both browser anchoring and snapshot resets used
    // to fight scrolling through this virtual list.
    await page.keyboard.press("Home");
    await list.hover(); await page.mouse.wheel(0, 1200);
    await page.waitForFunction(() => document.querySelector(".bm-viewport").scrollTop > 500);
    await list.evaluate(node => new Promise((resolve,reject) => {
      let previous = node.scrollTop, stable = 0; const deadline = performance.now() + 5000;
      const frame = () => { const top = node.scrollTop; stable = top === previous ? stable + 1 : 0; previous = top; if (stable >= 4) resolve(); else if(performance.now() >= deadline) reject(new Error("Wheel scrolling did not settle")); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    }));
    const position = await list.evaluate(node => node.scrollTop);
    if(position <= 500) throw new Error("Wheel scrolling jumped back while virtual rows changed");
    await page.getByRole("button", { name:"Refresh branches",exact:true }).click();
    await page.waitForSelector(".bm-body[aria-busy=false]");
    if (Math.abs(await list.evaluate(node => node.scrollTop) - position) > 1) throw new Error("A snapshot refresh reset the user's scroll position");
    const count = Number((await manager().locator(".cf-head .muted").innerText()).split(" ")[0]);
    git("branch", "external/while-scrolling");
    await manager().locator(".cf-head .muted").filter({hasText:`${count + 1} branches`}).waitFor();
    if (Math.abs(await list.evaluate(node => node.scrollTop) - position) > 1) throw new Error("External Git refresh reset the user's scroll position");
    await list.hover(); await page.mouse.wheel(0, -240);
    await page.waitForFunction(before => document.querySelector(".bm-viewport").scrollTop < before - 100, position);
    await shot("79-branch-manager-list");
    if (!fs.readFileSync(path.join(root,".git/index")).equals(before)) throw new Error("Read-only manager modified the Git index");

    // Creation identities deliberately disagree with the tip authors. A later
    // commit must neither acquire someone else's branch nor hide my own branch.
    const other = git("-c","user.name=Other Author","-c","user.email=other@example.invalid","commit-tree",`${base}^{tree}`,"-p",base,"-m","Other author tip");
    git("update-ref","refs/heads/main",other);
    git("branch","owned/removed",other); git("-c","user.name=Other Author","-c","user.email=other@example.invalid","branch","other/removed",base);
    git("config","--add","remote.origin.fetch","+refs/heads/retired/*:refs/remotes/origin/retired/*");
    for (const [name,upstream] of [["owned/removed","own"],["other/removed","other"]]) {
      git("config",`branch.${name}.remote`,"origin"); git("config",`branch.${name}.merge`,`refs/heads/retired/${upstream}`);
    }
    git("branch","--set-upstream-to=origin/innocent","main");
    git("branch","--set-upstream-to=origin/innocent","feature/login");
    git("update-ref","refs/remotes/origin/innocent",other); // login is now one commit ahead and one behind
    git("branch","origin/innocent",tip); // make the short upstream name ambiguous
    git("config","--add","remote.origin.fetch","+refs/heads/remote-only:refs/remotes/origin/remote-only");
    git("update-ref","refs/remotes/origin/remote-only",base);
    await page.getByRole("button", { name:"Refresh branches",exact:true }).click();
    await page.waitForSelector(".bm-body[aria-busy=false]");
    await manager().getByRole("button",{name:"Remote deleted",exact:true}).click();
    await row("refs/heads/owned/removed").waitFor(); await row("refs/heads/other/removed").waitFor();
    await manager().getByRole("button",{name:"My branches",exact:true}).click();
    await row("refs/heads/other/removed").waitFor({state:"detached"});
    if(await page.locator(".bm-viewport [role=option]").count() !== 1 || !await row("refs/heads/owned/removed").isVisible()) throw new Error("My + Remote deleted did not intersect using configured user.email");
    await manager().getByRole("button",{name:"Select shown (up to 50)",exact:true}).click();
    if(!await page.getByRole("checkbox",{name:"Select refs/heads/owned/removed for cleanup",exact:true}).isChecked()) throw new Error("Filtered branch could not be selected for safety review");
    await manager().getByRole("button",{name:"Clear selection",exact:true}).click();
    await manager().getByRole("button",{name:"Configure branch creator filter",exact:true}).click();
    await page.getByRole("textbox",{name:"Branch creator email or name",exact:true}).fill("Other Author");
    await page.getByRole("button",{name:"Apply filter",exact:true}).click();
    await row("refs/heads/other/removed").waitFor();
    if(await page.locator(".bm-viewport [role=option]").count() !== 1) throw new Error("Custom author filter did not replace the default email");
    await page.getByRole("button", { name: "Close branch manager", exact: true }).click();
    await open();
    await row("refs/heads/other/removed").waitFor();
    await manager().getByRole("button",{name:"Configure branch creator filter",exact:true}).click();
    if(await page.getByRole("textbox",{name:"Branch creator email or name",exact:true}).inputValue() !== "Other Author") throw new Error("Custom author was not remembered per repository");
    await page.getByRole("button",{name:"Use Git email",exact:true}).click();
    await row("refs/heads/owned/removed").waitFor();
    if(git("config","--get","user.email") !== "branch@example.invalid" || git("rev-parse","HEAD") !== other) throw new Error("Author filtering changed Git identity or checked out a branch");
    await shot("79-branch-manager-author");
    await manager().getByRole("button",{name:"My branches",exact:true}).click();
    await manager().getByRole("button",{name:"Remote deleted",exact:true}).click();
    await page.getByRole("button", { name: "Close branch manager", exact: true }).click();

    // Workspaces deliberately remember a collapsed sidebar. Establish this
    // scenario's UI precondition via its real control, not saved-state edits.
    const branches = page.getByRole("button", { name:"Branches",exact:true });
    if(await branches.getAttribute("aria-expanded") === "false") await branches.click();
    await page.locator(".branches-slot:not([hidden])").waitFor();
    const search = page.locator(".sidebar input[placeholder^='Filter branches']");
    await search.waitFor({state:"visible"});
    await search.fill("origin/innocent");
    await page.locator('.sidebar [data-branch-kind="local"][data-branch-name="feature/login"] .branch-connection.paired').waitFor();
    if(await page.locator('.sidebar [data-branch-kind="remote"][data-branch-name="origin/innocent"]').count()) throw new Error("Paired remote still appears separately");
    const login = page.locator('.sidebar [data-branch-kind="local"][data-branch-name="feature/login"]');
    if(!await login.locator(".ab.up").isVisible()) throw new Error("Pairing hid outgoing commit counts");
    if(!await login.locator(".ab.down").isVisible()) throw new Error("Pairing hid incoming commit counts");
    const expectPreview = async (oid,subject) => page.waitForFunction(({oid,subject}) =>
      document.querySelector(".commit-preview .commit-subject")?.textContent === subject &&
      [...document.querySelectorAll('.commit-preview .hash-chip[title="Copy full hash"], .commit-preview .hash-chip[title="Copy commit hash"]')].some(node=>node.textContent.includes(oid.slice(0,8))),{oid,subject});
    await login.click();
    await expectPreview(tip,"Add authentication flow");
    // The distinct tips must remain directly navigable after removing the
    // duplicate remote row. Verify rendered history, not only a menu label.
    if(other === tip) throw new Error("Upstream navigation fixture requires distinct tips");
    const upstreamMenu = page.locator(".ctx-item").filter({has:page.getByText("Upstream: origin/innocent",{exact:true})});
    const upstreamActions = page.locator(".ctx-menu").filter({has:page.getByText("Show tip in history",{exact:true})});
    const tipAction = upstreamActions.locator(".ctx-item").filter({has:page.getByText("Show tip in history",{exact:true})});
    await openSubmenu(page,()=>login.click({button:"right"}),upstreamMenu,tipAction);
    await tipAction.click();
    await expectPreview(other,"Other author tip");
    const filterAction = upstreamActions.locator(".ctx-item").filter({has:page.getByText("Show only this branch in graph",{exact:true})});
    await openSubmenu(page,()=>login.click({button:"right"}),upstreamMenu,filterAction);
    await filterAction.click();
    const remoteFilter=page.locator('[data-branch-filter="refs/remotes/origin/innocent"]');
    await remoteFilter.waitFor();
    await page.waitForFunction(() => {
      const rows=[...document.querySelectorAll(".grow")].map(node=>node.textContent);
      return rows.some(text=>text.includes("Other author tip")) && !rows.some(text=>text.includes("Add authentication flow"));
    });
    const clearFilter=page.getByRole("button",{name:"Clear branch filter",exact:true});
    const panelBounds=await page.locator(".graph-panel").boundingBox(), clearBounds=await clearFilter.boundingBox();
    if(!panelBounds||!clearBounds||clearBounds.x<panelBounds.x||clearBounds.x+clearBounds.width>panelBounds.x+panelBounds.width+1)throw new Error("Branch filter reset overflowed its commit column");
    await clearFilter.click();
    await remoteFilter.waitFor({state:"detached"});
    await login.click({button:"right"});
    await page.locator(".ctx-menu").filter({has:page.getByText("Upstream: origin/innocent",{exact:true})}).locator(".ctx-item").filter({has:page.getByText("Show only this branch in graph",{exact:true})}).click();
    const localFilter=page.locator('[data-branch-filter="refs/heads/feature/login"]');
    await localFilter.waitFor();
    const localTip = page.locator(".grow:not(.incoming)").getByText("Add authentication flow", { exact: true });
    const upstreamTip = page.locator(".grow").getByText("Other author tip", { exact: true });
    const incomingTip = page.locator(".grow.incoming").getByText("Other author tip", { exact: true });
    const incomingToggle = page.getByRole("button", { name: "Show incoming commits", exact: true });
    await localTip.waitFor();
    await incomingTip.waitFor();
    await incomingToggle.click();
    await upstreamTip.waitFor({ state: "detached" });
    await localTip.waitFor();
    await incomingToggle.click();
    await incomingTip.waitFor();
    await clearFilter.click();
    await localFilter.waitFor({state:"detached"});
    await search.fill("owned/removed");
    await page.locator('.sidebar [data-branch-name="owned/removed"] .branch-connection.gone').waitFor();
    await search.fill("occupied");
    await page.locator('.sidebar [data-branch-name="occupied"] .branch-connection.local').waitFor();
    await search.fill("remote-only");
    await page.locator('.sidebar [data-branch-kind="remote"][data-branch-name="origin/remote-only"]').waitFor();
    await shot("79-branches-remote-only");
    await search.fill("");
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
      const beforeResize = await page.evaluate(async () => ({ width:innerWidth, height:innerHeight, dpr:devicePixelRatio, native:await window.__TAURI_INTERNALS__.invoke("plugin:window|inner_size",{}) }));
      await withViewport(page, {width:1000,height:720}, async () => {
      const frame = await manager().boundingBox(), detail = await manager().locator(".bm-detail").boundingBox(), list = await manager().locator(".bm-list").boundingBox();
      if (!frame || !detail || !list) throw new Error("Manager layout is missing");
      // Prior workspace scenarios can restore hidden sidebars. Responsiveness
      // follows this workspace's actual width, not the whole browser viewport.
      if (frame.width <= 780 ? detail.y < list.y + list.height - 1 : detail.x < list.x + list.width - 1) throw new Error("Manager layout did not adapt to its available width");
      await shot("80-branch-manager-narrow");
      });
      const afterResize = await page.evaluate(() => ({ width:innerWidth, height:innerHeight, dpr:devicePixelRatio, right:document.querySelector(".app").getBoundingClientRect().right }));
      if (afterResize.width !== beforeResize.width || afterResize.height !== beforeResize.height || Math.abs(afterResize.dpr - beforeResize.dpr) > .001 || Math.abs(afterResize.right - beforeResize.width) > 1) throw new Error(`Narrow test did not restore its native viewport: ${JSON.stringify({before:beforeResize,after:afterResize})}`);
      // WebView's forced scale/zoom can differ from the window monitor's DPI.
      // Preserve both measured coordinate systems rather than dividing CSS
      // dimensions by Tauri's unrelated monitor scale.
      const native = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|inner_size",{}));
      if (Math.abs(native.width - beforeResize.native.width) > 1 || Math.abs(native.height - beforeResize.native.height) > 1) throw new Error(`Native bounds changed during viewport emulation: ${JSON.stringify({before:beforeResize,after:afterResize,native})}`);
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
      const manager=page.locator(".branch-manager");
      await manager.getByRole("textbox",{name:"Search branches"}).fill("topic");await manager.locator('[data-branch-ref="refs/heads/topic"]').click();
      await manager.getByRole("button",{name:"Review deletion…",exact:true}).click();
      await page.waitForSelector(".branch-review[aria-busy=false][data-review-local-oid]");
    };
    await openReview();
    const checkpointOption=page.getByRole("checkbox",{name:"Create recovery checkpoint",exact:true});
    if(!await checkpointOption.isChecked())throw new Error("Deletion recovery must default to enabled");
    await checkpointOption.uncheck();
    const checkpointsBefore=(await invoke("recovery_list",{repo:root})).checkpoints.map(x=>x.id).sort();
    const checkbox=page.locator(".delete-remote-branch"),submit=page.locator(".delete-branch-confirm");
    if(!await checkbox.isDisabled() || await checkbox.isChecked() || !await submit.isEnabled())throw new Error("Protected upstream did not leave only local deletion available");
    await page.locator(".branch-deletion-protection").filter({hasText:"main is protected"}).waitFor();
    // Exercise the backend independently of the disabled checkbox. The entire
    // combined action must fail before deleting topic, even with force=true.
    const targets=await invoke("branch_delete_targets",{repo:root,name:"topic"});
    const target=targets.find(t=>t.remoteRef==="refs/heads/main");
    const plan=await invoke("branch_delete_plan",{repo:root,name:"topic",base:"refs/heads/main",target,remoteOnly:false});
    const error=await page.evaluate(async({root,plan})=>{
      try{await window.__TAURI_INTERNALS__.invoke("branch_delete_reviewed",{repo:root,review:plan.proof,includeRemote:true,force:true,expectedState:plan.stateToken,protectionRules:["main","master","develop","release/*"],createCheckpoint:false});return null;}catch(e){return e;}
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
    if(JSON.stringify((await invoke("recovery_list",{repo:root})).checkpoints.map(x=>x.id).sort())!==JSON.stringify(checkpointsBefore))throw new Error("Local deletion ignored disabled checkpoint option");
    const deletedNotice=page.locator(".toast").filter({hasText:"Deleted local branch topic"});
    await deletedNotice.getByText("Deleted without a recovery checkpoint",{exact:true}).waitFor();
    if(await deletedNotice.getByRole("button",{name:"Open recovery checkpoint",exact:true}).count())throw new Error("Deletion offered a checkpoint that was never created");
    if(git(root,"for-each-ref","--format=%(objectname)","refs/heads/topic") || git(server,"rev-parse","main")!==oid || git(server,"rev-parse","topic")!==oid || !fs.readFileSync(path.join(root,".git/index")).equals(index))throw new Error("Local-only deletion changed protected remote or index");
    // Explicitly editing the rule is the only supported way to allow main.
    git(root,"branch","topic");trackTopic();await page.getByRole("button",{name:"Refresh branches",exact:true}).click();await page.waitForSelector(".bm-body[aria-busy=false]");
    await page.getByRole("button",{name:"Protection rules",exact:true}).click();await page.getByRole("textbox",{name:"Branch protection rules"}).fill("master\ndevelop\nrelease/*");await page.getByRole("button",{name:"Save rules",exact:true}).click();
    await openReview();if(await checkbox.isDisabled())throw new Error("Edited rules did not allow the reviewed target");
    if(!await checkpointOption.isChecked())throw new Error("Disabling checkpoints leaked into the next deletion dialog");
    await checkpointOption.uncheck();
    await checkbox.check();await submit.click();await page.waitForSelector(".modal",{state:"detached",timeout:180000});
    if(JSON.stringify((await invoke("recovery_list",{repo:root})).checkpoints.map(x=>x.id).sort())!==JSON.stringify(checkpointsBefore))throw new Error("Combined deletion ignored disabled checkpoint option");
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
    await app.page.getByTitle("Settings",{exact:true}).click();await app.page.getByRole("combobox",{name:"Git auto-fetch",exact:true}).selectOption("0");await app.page.locator(".modal").getByRole("button",{name:"Done",exact:true}).click();
    if (!process.argv.includes("--protection-only")) await branchManagerSmoke({ page:app.page, work, check: async (name,fn) => { await fn(); console.log(`PASS ${name}`); }, shot: name => app.page.screenshot({path:path.join(out,`${name}.png`)}) });
    await branchManagerProtectionSmoke({ page:app.page, work, check: async (name,fn) => { await fn(); console.log(`PASS ${name}`); }, shot: name => app.page.screenshot({path:path.join(out,`${name}.png`)}) });
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (e) {
    await app.page.screenshot({ path:path.join(out,"failure.png") }).catch(() => {});
    throw e;
  } finally { await app.close(); fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:300}); }
}
