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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work = createProfile("branch-manager-");
  if (!process.argv.includes("--exe")) throw new Error("Pass --exe <built application>");
  const exe = process.argv[process.argv.indexOf("--exe") + 1];
  const out = process.env.REVQORA_SMOKE_OUT || path.join(work,"shots"); fs.mkdirSync(out,{recursive:true});
  const app = await launch({ exe, profile:path.join(work,"profile"), port:0 });
  const errors = []; app.page.on("pageerror", e => errors.push(e.message));
  try {
    await app.page.getByRole("button", { name:"Skip", exact:true }).click({ timeout:60000 });
    await branchManagerSmoke({ page:app.page, work, check: async (name,fn) => { await fn(); console.log(`PASS ${name}`); }, shot: name => app.page.screenshot({path:path.join(out,`${name}.png`)}) });
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (e) {
    await app.page.screenshot({ path:path.join(out,"failure.png") }).catch(() => {});
    throw e;
  } finally { await app.close(); fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:300}); }
}
