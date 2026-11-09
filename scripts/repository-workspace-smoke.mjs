import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfile, launch } from "./ui-driver.mjs";
import { repositorySessionSmoke } from "./repository-session-smoke.mjs";
import { ignoredPullSmoke } from "./ignored-pull-smoke.mjs";
import { commitDraftSmoke } from "./commit-draft-smoke.mjs";
import { namePathCopySmoke } from "./name-path-copy-smoke.mjs";
import { fileEditingSmoke } from "./file-editing-smoke.mjs";
import { branchHistorySmoke } from "./branch-history-smoke.mjs";

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
  const closeActiveTab = async (root) => {
    await page.keyboard.press("Control+w");
    await page.waitForFunction((root) => {
      const key = (path) => path.replaceAll("\\", "/").toLowerCase();
      const { openTabs } = JSON.parse(localStorage.getItem("revqora.settings")).state;
      return !openTabs.some((path) => key(path) === key(root));
    }, root);
  };
  const holdRepositoryOpen = async (folder) => {
    await page.evaluate((folder) => {
      const original = window.fetch;
      const key = (value) => value.replaceAll("\\", "/").toLowerCase();
      let resolve, released = false;
      const gate = {
        held: false,
        release() { released = true; resolve?.(); },
        restore() { window.fetch = original; gate.release(); delete window.__workspaceOpenGate; },
      };
      window.__workspaceOpenGate = gate;
      window.fetch = async function(input, init) {
        const url = typeof input === "string" ? input : input?.url ?? String(input);
        const response = await Reflect.apply(original, window, [input, init]);
        if (!released && /\/repo_open$/.test(url) && key(JSON.parse(init.body).path) === key(folder)) {
          await new Promise(unblock => { resolve = unblock; gate.held = true; });
        }
        return response;
      };
    }, folder);
    return {
      wait: () => page.waitForFunction(() => window.__workspaceOpenGate?.held),
      release: () => page.evaluate(() => window.__workspaceOpenGate.release()),
      restore: () => page.evaluate(() => window.__workspaceOpenGate.restore()),
    };
  };
  const save = async (name, choose = async () => {}) => {
    await library("Workspaces");
    await page.getByRole("button", { name: "New workspace…", exact: true }).click();
    const editor = page.locator(".modal").last();
    await editor.getByLabel("Workspace name", { exact: true }).fill(name);
    await choose(editor);
    await editor.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.waitForSelector(`.library-row:has-text('${name} · Active')`);
    await done();
  };
  const edit = async (workspace, repository, included, group) => {
    await library("Workspaces");
    const row = page.locator(".library-row", { has: page.getByText(workspace, { exact: true }) });
    await row.getByRole("button", { name: "Edit repositories…", exact: true }).click();
    const editor = page.locator(".modal").last();
    if (group) await editor.getByLabel("Filter repositories by group").selectOption({ label: group });
    await editor.getByLabel("Find repository", { exact: true }).fill(repository);
    await editor.getByRole("checkbox", { name: new RegExp(repository) }).setChecked(included);
    await editor.getByRole("button", { name: "Save changes", exact: true }).click();
    await done();
  };
  await check("repository favorites and groups retain closed bookmarks and collapse state", async () => {
    // Exercise the opt-out through Settings: these bookmark/workspace scenarios
    // intentionally restore only open tabs. The 40-repository fixture below
    // separately enables and verifies opening the entire saved library.
    await page.getByTitle("Settings", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Open all saved repositories", exact: true }).uncheck();
    await page.locator(".modal").last().getByRole("button", { name: "Done", exact: true }).click();
    // Start this suite with its own repository set, leaving all working trees intact.
    const repositoriesToggle = page.getByRole("button", { name: "Toggle repositories panel", exact: true });
    if (await repositoriesToggle.getAttribute("aria-expanded") === "false") await repositoriesToggle.click();
    while (await page.locator(".repository-close").count()) await page.locator(".repository-close").first().click();
    await open(root);
    await namePathCopySmoke({page,root});
    await fileEditingSmoke({page,work,returnRoot:root,shot});
    await ignoredPullSmoke({ page, work, returnRoot: root, shot });
    await commitDraftSmoke({ page, work, returnRoot: root, shot });
    await branchHistorySmoke({ page, work, returnRoot: root });
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
    await repositorySessionSmoke({ page, work, shot, template: second });
  });
  await check("saved workspaces restore repository sets, views and panel layout without switching Git branches", async () => {
    const toolsFile = path.join(second, "file.txt");
    fs.appendFileSync(toolsFile, "\nlocal workspace changes\n");
    const toolsContents = fs.readFileSync(toolsFile, "utf8");
    await open(second);
    await page.locator(".history-mode").getByRole("button", { name: "Columns", exact: true }).click();
    const branches = page.getByRole("button", { name: "Branches", exact: true });
    if (await branches.getAttribute("aria-expanded") === "true") await branches.click();
    const closeRoot = page.getByRole("button", { name: "Close stage8-workspace", exact: true });
    if (await closeRoot.count()) await closeRoot.click();
    const workspaceSubdir = path.join(root, "workspace-subdir");
    fs.mkdirSync(workspaceSubdir);
    const sidebar = page.locator(".repository-sidebar");
    const createGate = await holdRepositoryOpen(workspaceSubdir);
    try {
      await open(workspaceSubdir); await createGate.wait();
      await save("Stage8 focused", async (editor) => {
        const alias = editor.getByRole("checkbox", { name: /workspace-subdir/ });
        if (!await alias.isChecked()) throw new Error("The opening repository was not preselected");
        if (!await editor.getByRole("button", { name: "Create workspace", exact: true }).isDisabled()) throw new Error("Workspace creation could save before the root was resolved");
        await editor.getByRole("checkbox", { name: /stage8-tools/ }).uncheck();
        await createGate.release();
        await alias.waitFor({ state: "detached" });
        const canonical = editor.getByRole("checkbox", { name: /^stage8-workspace\b/ });
        if (!await canonical.isChecked()) throw new Error("Workspace creation lost the selected repository after root resolution");
        await waitActive("stage8-workspace");
        await closeActiveTab(root);
        if (!await canonical.isChecked()) throw new Error("Closing the resolved tab cleared the workspace selection");
        await open(root);
        await page.locator('.repository-item[data-repository-state="open"]', { hasText: "stage8-workspace" }).waitFor();
        if (!await canonical.isChecked()) throw new Error("Reopening the tab cleared the workspace selection");
        await closeActiveTab(root);
        await editor.getByText("1 selected", { exact: true }).waitFor();
      });
    } finally { await createGate.restore(); }
    const excluded = sidebar.locator(".repository-item", { hasText: "stage8-tools" });
    await excluded.waitFor({ state: "detached" });
    await waitActive("stage8-workspace");
    const picker = page.getByLabel("Workspace", { exact: true });
    const focusedId = await picker.inputValue();
    if (!focusedId) throw new Error("Create workspace did not activate the new workspace");
    await sidebar.getByRole("button", { name: "All repositories", exact: true }).click();
    const overview = page.locator(".repository-overview");
    const repositoryRows = overview.locator(".repository-name");
    await overview.getByText(/^Stage8 focused · 1 open/).waitFor();
    await repositoryRows.getByText("stage8-workspace", { exact: true }).waitFor();
    if (await repositoryRows.count() !== 1) throw new Error("The new workspace overview did not match its selected repositories");
    const overviewSearch = overview.getByRole("textbox", { name: "Find repository in overview", exact: true });
    await overviewSearch.fill("stage8-tools");
    await overview.getByText("No matching repositories", { exact: true }).waitFor();
    const allGate = await holdRepositoryOpen(second);
    try {
      await picker.selectOption({ label: "All Workspaces" });
      await allGate.wait();
      await overview.getByText(/^All Workspaces · /).waitFor();
      if (await overviewSearch.inputValue() !== "") throw new Error("All Workspaces kept the search from the previous workspace");
      await repositoryRows.getByText("stage8-workspace", { exact: true }).waitFor();
      await repositoryRows.getByText("stage8-tools", { exact: true }).waitFor();
      if (await sidebar.locator('.repository-item[data-repository-state="closed"]').count()) throw new Error("All Workspaces briefly left library repositories closed");
    } finally { await allGate.restore(); }
    await sidebar.locator('.repository-item[data-repository-state="open"]', { hasText: "stage8-tools" }).waitFor();
    await repositoryRows.getByText("stage8-workspace", { exact: true }).click();
    await waitActive("stage8-workspace");
    const sidebarSearch = sidebar.getByRole("textbox", { name: "Find repository", exact: true });
    await sidebarSearch.fill("stage8-tools");
    await picker.selectOption(focusedId);
    await sidebar.getByText("stage8-workspace", { exact: true }).waitFor();
    if (await sidebarSearch.inputValue() !== "") throw new Error("The previous repository search hid the workspace's repositories");
    await picker.selectOption({ label: "All Workspaces" });
    await open(second); await page.locator(".history-mode").getByRole("button", { name: "Graph", exact: true }).click();
    if (await branches.getAttribute("aria-expanded") === "false") await branches.click();
    await save("Stage8 all", async (editor) => {
      await editor.getByRole("button", { name: "Clear shown", exact: true }).click();
      await editor.getByRole("checkbox", { name: /stage8-workspace/ }).check();
      await editor.getByRole("checkbox", { name: /stage8-tools/ }).check();
    });
    const ids = await page.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem("revqora.repositories")).state.workspaces.map((w) => [w.name, w.id])));
    await page.getByLabel("Workspace", { exact: true }).selectOption(ids["Stage8 focused"]); await waitActive("stage8-workspace");
    const switchGate = await holdRepositoryOpen(second);
    try {
      await page.getByLabel("Workspace", { exact: true }).selectOption(ids["Stage8 all"]);
      await switchGate.wait();
      const visible = await page.locator(".repository-sidebar .repository-label").allTextContents();
      if (visible.length !== 1 || visible[0] !== "stage8-workspace") throw new Error(`Repository list changed before the workspace finished opening: ${visible.join(", ")}`);
    } finally { await switchGate.restore(); }
    await waitActive("stage8-tools");
    if (await page.locator(".history-mode button.on").innerText() !== "Graph") throw new Error("workspace did not restore history mode");
    await page.getByLabel("Workspace", { exact: true }).selectOption(ids["Stage8 focused"]); await waitActive("stage8-workspace");
    if (await page.locator(".repository-close").count() !== 1 || await page.locator(".history-mode button.on").innerText() !== "Columns") throw new Error("workspace did not restore repository set");
    await excluded.waitFor({ state: "detached" });
    if (await branches.getAttribute("aria-expanded") !== "false") throw new Error("workspace did not restore panel visibility");
    await edit("Stage8 all", "stage8-tools", false);
    if (await page.getByLabel("Workspace", { exact: true }).inputValue() !== ids["Stage8 focused"]) throw new Error("editing another workspace switched the current session");
    const toolsSubdir = path.join(second, "tools-subdir");
    fs.mkdirSync(toolsSubdir);
    const editGate = await holdRepositoryOpen(toolsSubdir);
    try {
      await open(toolsSubdir); await editGate.wait();
      await library("Workspaces");
      await page.locator(".library-row", { has: page.getByText("Stage8 all", { exact: true }) }).getByRole("button", { name: "Edit repositories…", exact: true }).click();
      const editor = page.locator(".modal").last();
      await editor.getByLabel("Filter repositories by group").selectOption({ label: "Ungrouped" });
      const alias = editor.getByRole("checkbox", { name: /tools-subdir/ });
      await alias.check();
      const saveChanges = editor.getByRole("button", { name: "Save changes", exact: true });
      if (!await saveChanges.isDisabled()) throw new Error("Workspace edits could save before the root was resolved");
      await editGate.release();
      await alias.waitFor({ state: "detached" });
      const canonical = editor.getByRole("checkbox", { name: /stage8-tools/ });
      if (!await canonical.isChecked()) throw new Error("Workspace edits lost the selected repository after root resolution");
      await waitActive("stage8-tools");
      await closeActiveTab(second);
      if (!await canonical.isChecked()) throw new Error("Closing the resolved tab cleared the workspace edit");
      await editor.getByText("2 selected", { exact: true }).waitFor();
      await saveChanges.click();
      await done();
    } finally { await editGate.restore(); }
    const editedRoots = await page.evaluate(id => JSON.parse(localStorage.getItem("revqora.repositories")).state.workspaces.find(w => w.id === id).roots, ids["Stage8 all"]);
    if (!editedRoots.some(repo => repo.replaceAll("\\", "/").endsWith("/stage8-tools"))) throw new Error("The edited workspace did not save the canonical root");
    await edit("Stage8 all", "stage8-tools", false);
    await edit("Stage8 focused · Active", "stage8-tools", true, "Ungrouped");
    await page.getByRole("button", { name: "Close stage8-tools", exact: true }).waitFor();
    await page.evaluate(() => {
      const original = window.fetch, removed = [];
      window.__workspaceWatchProbe = { removed, restore: () => { window.fetch = original; delete window.__workspaceWatchProbe; } };
      window.fetch = async function(input, init) {
        const url = typeof input === "string" ? input : input?.url ?? String(input);
        const response = await Reflect.apply(original, window, [input, init]);
        if (/\/unwatch_repo$/.test(url) && response.ok) removed.push(JSON.parse(init.body).repo);
        return response;
      };
    });
    try {
      await edit("Stage8 focused · Active", "stage8-tools", false);
      await excluded.waitFor({ state: "detached" });
      await page.waitForFunction(() => window.__workspaceWatchProbe.removed.some((root) => root.replaceAll("\\", "/").endsWith("/stage8-tools")));
    } finally { await page.evaluate(() => window.__workspaceWatchProbe.restore()); }
    await library("Repositories");
    await page.locator(".library-row", { has: page.getByText("stage8-tools", { exact: true }) }).getByRole("button", { name: "Open", exact: true }).waitFor();
    await done();
    const savedSets = await page.evaluate(() => JSON.parse(localStorage.getItem("revqora.repositories")).state.workspaces.map((w) => [w.name, w.roots.length]));
    if (savedSets.some(([name, count]) => name.startsWith("Stage8 ") && count !== 1)) throw new Error("workspace membership edits were not saved");
    if (fs.readFileSync(toolsFile, "utf8") !== toolsContents) throw new Error("removing the repository changed its working file");
    if (git(root, "branch", "--show-current") !== "main" || git(second, "branch", "--show-current") !== "main") throw new Error("workspace checked out a branch");
    // Settings and membership are persisted separately. A stale session entry
    // must not reopen an excluded repository.
    await page.evaluate((excludedRoot) => {
      const settings = JSON.parse(localStorage.getItem("revqora.settings"));
      settings.state.openTabs.push(excludedRoot);
      settings.state.activeTab = excludedRoot;
      localStorage.setItem("revqora.settings", JSON.stringify(settings));
    }, second);
    await page.reload(); await waitActive("stage8-workspace");
    await excluded.waitFor({ state: "detached" });
    await shot("76-saved-workspace");
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
