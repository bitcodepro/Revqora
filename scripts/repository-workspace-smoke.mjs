import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfile, launch } from "./ui-driver.mjs";

export async function repositoryWorkspaceSmoke({ page, check, shot, work }) {
  const root = path.join(work, "stage8-workspace"), second = path.join(work, "stage8-tools"), bare = path.join(work, "stage8.git"), peer = path.join(work, "stage8-peer");
  // Checkpointing and server verification can exceed the generic UI timeout.
  // Assert the terminal result and exact server SHA after the operation finishes.
  const syncTimeout = 180000;
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  const init = (dir) => { fs.mkdirSync(dir); git(dir, "init", "-q", "-b", "main"); git(dir, "config", "user.name", "Workspace Tester"); git(dir, "config", "user.email", "workspace@example.com"); git(dir, "config", "commit.gpgsign", "false"); git(dir, "config", "core.autocrlf", "false"); };
  const commit = (dir, text) => { fs.writeFileSync(path.join(dir, "file.txt"), text); git(dir, "add", "."); git(dir, "commit", "-qm", text); return git(dir, "rev-parse", "HEAD"); };
  init(root); init(second); commit(root, "workspace base"); commit(second, "tools base");
  git(root, "clone", "--bare", ".", bare); git(root, "remote", "add", "origin", bare); git(root, "fetch", "origin"); git(root, "branch", "--set-upstream-to=origin/main"); git(root, "clone", bare, peer); git(peer, "config", "user.name", "Peer"); git(peer, "config", "user.email", "peer@example.com"); git(peer, "config", "commit.gpgsign", "false");
  // Saved workspaces may deliberately hide the repository panel (focus mode).
  // Observe the always-visible active repository instead of a hidden list row.
  const waitActive = (name) => page.locator(".topbar .repo-current > b").filter({ hasText: name }).waitFor();
  const open = async (dir) => { await page.evaluate((root) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: [root] }), dir); await waitActive(path.basename(dir)); };
  const library = async (tab) => { await page.getByRole("button", { name: "Repository library and workspaces", exact: true }).click(); await page.locator(".library-tabs").getByRole("button", { name: tab, exact: true }).click(); };
  const done = () => page.locator(".modal").last().getByRole("button", { name: "Done", exact: true }).click();
  const save = async (name) => { await library("Workspaces"); await page.getByRole("button", { name: "Save current as…", exact: true }).click(); await page.locator(".modal").last().locator("input").fill(name); await page.locator(".modal").last().getByRole("button", { name: "OK", exact: true }).click(); await page.waitForSelector(`.library-row:has-text('${name} · Active')`); await done(); };
  await check("repository favorites and groups retain closed bookmarks and collapse state", async () => {
    // Start this suite with its own repository set, leaving all working trees intact.
    const repositoriesToggle = page.getByRole("button", { name: "Toggle repositories panel", exact: true });
    if (await repositoriesToggle.getAttribute("aria-expanded") === "false") await repositoriesToggle.click();
    while (await page.locator(".repository-close").count()) await page.locator(".repository-close").first().click();
    await open(root);
    await page.getByRole("button", { name: "Favorite stage8-workspace", exact: true }).click();
    await library("Groups"); await page.getByRole("button", { name: "New group", exact: true }).click(); await page.locator(".modal").last().locator("input").fill("Stage 8 projects"); await page.locator(".modal").last().getByRole("button", { name: "OK", exact: true }).click();
    await page.locator(".library-tabs").getByRole("button", { name: "Repositories", exact: true }).click();
    const group = await page.getByLabel("Group for stage8-workspace", { exact: true }).locator("option", { hasText: "Stage 8 projects" }).getAttribute("value");
    await page.getByLabel("Group for stage8-workspace", { exact: true }).selectOption(group); await done();
    await page.getByRole("button", { name: "Close stage8-workspace", exact: true }).click();
    // The library remains available even with no open repositories.
    await library("Repositories"); await page.locator(".library-row", { hasText: "stage8-workspace" }).getByRole("button", { name: "Open", exact: true }).click(); await waitActive("stage8-workspace");
    const header = page.locator(".repository-group", { hasText: "Stage 8 projects" }); await header.click(); if (await header.getAttribute("aria-expanded") !== "false") throw new Error("group did not collapse");
    await page.reload(); await page.waitForSelector(".repository-group:has-text('Stage 8 projects')[aria-expanded='false']"); await header.click();
    await waitActive("stage8-workspace");
    if (await page.getByRole("button", { name: "Unfavorite stage8-workspace", exact: true }).count() !== 1) throw new Error("favorite duplicated or was lost"); await shot("75-repository-library");
  });
  await check("saved workspaces restore repository sets, views and panel layout without switching Git branches", async () => {
    await page.locator(".history-mode").getByRole("button", { name: "Columns", exact: true }).click();
    const branches = page.getByRole("button", { name: "Branches", exact: true });
    if (await branches.getAttribute("aria-expanded") === "true") await branches.click();
    await save("Stage8 focused");
    await page.getByLabel("Workspace", { exact: true }).selectOption("");
    await open(second); await page.locator(".history-mode").getByRole("button", { name: "Graph", exact: true }).click();
    if (await branches.getAttribute("aria-expanded") === "false") await branches.click();
    await save("Stage8 all");
    const ids = await page.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem("revqora.repositories")).state.workspaces.map((w) => [w.name, w.id])));
    await page.getByLabel("Workspace", { exact: true }).selectOption(ids["Stage8 focused"]); await waitActive("stage8-workspace");
    await page.getByLabel("Workspace", { exact: true }).selectOption(ids["Stage8 all"]); await waitActive("stage8-tools");
    if (await page.locator(".history-mode button.on").innerText() !== "Graph") throw new Error("workspace did not restore history mode");
    await page.getByLabel("Workspace", { exact: true }).selectOption(ids["Stage8 focused"]); await waitActive("stage8-workspace");
    if (await page.locator(".repository-close").count() !== 1 || await page.locator(".history-mode button.on").innerText() !== "Columns") throw new Error("workspace did not restore repository set");
    if (await branches.getAttribute("aria-expanded") !== "false") throw new Error("workspace did not restore panel visibility");
    if (git(root, "branch", "--show-current") !== "main" || git(second, "branch", "--show-current") !== "main") throw new Error("workspace checked out a branch");
    await page.reload(); await waitActive("stage8-workspace"); await shot("76-saved-workspace");
    if (await branches.getAttribute("aria-expanded") !== "false") throw new Error("restart lost workspace panel visibility");
  });
  await check("Sync reviews exact incoming revisions and requires opt-in before publishing outgoing commits", async () => {
    const incoming = commit(peer, "workspace incoming"); git(peer, "push", "origin", "main");
    await page.locator(".toolbar").getByRole("button", { name: "Sync", exact: true }).click(); await page.waitForSelector(".modal:has-text('Review Sync')");
    if (!await page.getByRole("checkbox", { name: "Receive 1", exact: true }).isChecked()) throw new Error("incoming revision not selected");
    await shot("77-sync-review"); await page.getByRole("button", { name: "Sync selected (1)", exact: true }).click(); await page.waitForSelector(".modal:has-text('Sync results')", { timeout: syncTimeout });
    if (git(root, "rev-parse", "HEAD") !== incoming || !(await page.locator(".modal").innerText()).includes("Incoming commits received")) throw new Error("incoming Sync failed"); await done();
    const outgoing = commit(root, "workspace outgoing"); await page.getByRole("button", { name: "Refresh (F5)", exact: true }).click();
    await page.locator(".toolbar").getByRole("button", { name: "Sync", exact: true }).click(); await page.waitForSelector(".modal:has-text('Review Sync')");
    if (await page.getByRole("checkbox", { name: "Send 1", exact: true }).isChecked() || !await page.getByRole("button", { name: "Sync selected (0)", exact: true }).isDisabled()) throw new Error("outgoing publication was implicit");
    if (git(bare, "rev-parse", "main") !== incoming) throw new Error("preview pushed commits");
    await page.getByRole("checkbox", { name: "Send 1", exact: true }).check(); await page.getByRole("button", { name: "Sync selected (1)", exact: true }).click(); await page.waitForSelector(".modal:has-text('Sync results')", { timeout: syncTimeout });
    if (git(bare, "rev-parse", "main") !== outgoing || !(await page.locator(".modal").innerText()).includes("Outgoing commits sent")) throw new Error("outgoing Sync failed"); await shot("78-sync-results"); await done();
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work = createProfile("r8-"); const out = process.env.REVQORA_SMOKE_OUT || path.join(work, "shots"); fs.mkdirSync(out, { recursive: true });
  const { page, close } = await launch({ exe: process.argv[2] || path.resolve("release/Revqora/revqora.exe"), profile: path.join(work, "profile"), port: 0 }); page.setDefaultTimeout(90000);
  try { await page.waitForSelector(".modal:has-text('Welcome to Revqora')"); await page.locator(".modal").getByRole("button", { name: "Skip", exact: true }).click(); await repositoryWorkspaceSmoke({ page, work, check: async (name, fn) => { await fn(); console.log(`PASS ${name}`); }, shot: (name) => page.screenshot({ path: path.join(out, `${name}.png`) }) }); }
  catch (e) { await page.screenshot({ path: path.join(out, "failure.png") }); throw e; }
  finally { await close(); }
}
