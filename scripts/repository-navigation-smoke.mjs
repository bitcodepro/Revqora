import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openSubmenu } from "./ui-driver.mjs";

export async function repositoryNavigationSmoke({ page, work, shot }) {
  const parent = path.join(work, "navigation-projects");
  for (const relative of ["product/api", "product/components/worker", "product/components/worker/plugins/extension", "infra/platform"]) {
    const root = path.join(parent, relative);
    fs.mkdirSync(root, { recursive: true });
    execFileSync("git", ["-C", root, "init", "-qb", "main"], { windowsHide: true });
  }
  const nav = page.getByRole("group", { name: "Repository navigation", exact: true });
  const wsToggle = nav.getByRole("button", { name: "Toggle Workspaces panel", exact: true });
  const groupToggle = nav.getByRole("button", { name: "Toggle Groups panel", exact: true });
  const repoToggle = nav.getByRole("button", { name: "Toggle repositories panel", exact: true });
  if (await repoToggle.getAttribute("aria-expanded") === "false") await repoToggle.click();
  if (await wsToggle.getAttribute("aria-pressed") === "false") await wsToggle.click();
  if (await groupToggle.getAttribute("aria-expanded") === "false") await groupToggle.click();
  const ws = page.getByRole("complementary", { name: "Workspaces", exact: true });
  await ws.waitFor();
  assert.equal(await ws.getByRole("button", { name: "Manage library…", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Repository library and workspaces", exact: true }).waitFor();
  const groups = page.getByRole("complementary", { name: "Groups", exact: true });
  const repos = page.locator(".repository-slot > .repository-sidebar");
  const workspace = name => ws.locator(".library-tree-row").filter({ has: page.getByText(name, { exact: true }) });
  const group = name => groups.locator(".library-tree-row").filter({ has: page.getByText(name, { exact: true }) });
  const repository = name => repos.locator(".repository-select").filter({ has: page.getByText(name, { exact: true }) });
  const library = () => page.evaluate(() => JSON.parse(localStorage.getItem("revqora.repositories")).state);
  const tooltip = page.getByRole("tooltip");
  const hideWorkspaces = ws.getByRole("button", { name: "Hide Workspaces", exact: true });
  for (let i = 0; i < 2; i++) {
    await hideWorkspaces.hover();
    assert.equal(await tooltip.innerText(), "Hide Workspaces");
    await ws.getByRole("textbox", { name: "Find workspace", exact: true }).hover();
    await tooltip.waitFor({ state: "detached" });
  }

  await page.locator(".topbar").click({button:"right", position:{x:3,y:3}});
  await page.locator(".ctx-menu").getByText("Import folder…", {exact:true}).click();
  const importDialog = page.getByRole("dialog", { name: "Import repositories from a folder", exact: true });
  await importDialog.getByLabel("Parent folder").fill(parent);
  await importDialog.getByRole("button", { name: "Scan folder", exact: true }).click();
  await importDialog.getByText("Workspace · plugins", { exact: true }).waitFor();
  await importDialog.getByRole("button", { name: "Import 4 repositories", exact: true }).click();
  await importDialog.waitFor({ state: "detached" });
  const imported = (await library()).workspaces;
  const id = name => imported.find(item => item.name === name)?.id;
  assert.equal(imported.find(item => item.id === id("product")).parentId, id("navigation-projects"));
  assert.equal(imported.find(item => item.id === id("plugins")).parentId, id("worker"));
  await workspace("product").getByRole("button", { name: "Collapse product", exact: true }).click();
  await workspace("plugins").waitFor({ state: "detached" });
  await workspace("product").getByRole("button", { name: "Expand product", exact: true }).click();
  await workspace("plugins").locator(".library-drag-handle").dragTo(ws.locator(".repository-overview-link"));
  await page.waitForFunction(plugin => JSON.parse(localStorage.getItem("revqora.repositories")).state.workspaces.find(w => w.id === plugin).parentId === null, id("plugins"));
  await workspace("plugins").locator(".library-drag-handle").dragTo(workspace("worker"));
  await page.waitForFunction(([plugin, worker]) => JSON.parse(localStorage.getItem("revqora.repositories")).state.workspaces.find(w => w.id === plugin).parentId === worker, [id("plugins"), id("worker")]);

  await workspace("product").locator(".repository-select").click();
  await page.keyboard.press("F2");
  const renameWorkspace = page.getByRole("dialog", { name: "Rename workspace", exact: true });
  await renameWorkspace.waitFor();
  await renameWorkspace.getByRole("button", { name: "Cancel", exact: true }).click();
  await workspace("product").locator(".repository-select[aria-current=true]").waitFor();
  await ws.getByRole("button", { name: "All Workspaces", exact: true }).click();
  await repository("api").waitFor();
  await repository("api").click();
  await page.keyboard.press("F2");
  const renameRepo = page.getByRole("dialog", { name: "Rename repository", exact: true });
  await renameRepo.waitFor();
  await renameRepo.getByRole("button", { name: "Cancel", exact: true }).click();

  async function createGroup(container, row, name) {
    await row.click({ button: "right" });
    await page.locator(".ctx-menu").getByText("Create group", { exact: true }).click();
    await container.getByRole("textbox", { name: "Group name", exact: true }).fill(name);
    await container.getByRole("button", { name: "Create", exact: true }).click();
    await group(name).waitFor();
  }
  await repository("api").click({ modifiers: ["Control"] });
  await repository("worker").click({ modifiers: ["Control"] });
  await createGroup(repos, repository("api"), "Delivery");
  assert.equal((await library()).groups.find(item => item.name === "Delivery").roots.length, 2);
  await groups.getByRole("button", { name: "All groups", exact: true }).click();
  await createGroup(repos, repository("platform"), "Platform");
  await group("Delivery").locator(".repository-select").click({ modifiers: ["Control"] });
  await group("Platform").locator(".repository-select").click({ modifiers: ["Shift"] });
  await createGroup(groups, group("Delivery").locator(".repository-select"), "Engineering");
  const nested = (await library()).groups;
  const parentId = nested.find(item => item.name === "Engineering").id;
  assert(nested.filter(item => ["Delivery", "Platform"].includes(item.name)).every(item => item.parentId === parentId));
  for (const name of ["api", "worker", "platform"]) await repository(name).waitFor();
  assert.equal(await repository("extension").count(), 0);
  await shot?.("workspace-and-group-trees");
  await repos.getByRole("button", { name: "All repositories", exact: true }).click();
  const overview = page.locator(".repository-overview");
  assert.equal(await overview.getByRole("textbox", { name: "Find repository in overview", exact: true }).inputValue(), "");
  for (const action of ["Sync", "Fetch", "Pull"]) {
    await overview.getByRole("button", { name: action + " filtered", exact: true }).waitFor();
    assert.equal(await overview.getByRole("button", { name: action + " all", exact: true }).count(), 0);
  }
  assert.equal(await overview.getByRole("button", { name: "extension", exact: true }).count(), 0);
  await groups.getByRole("button", { name: "All groups", exact: true }).click();
  await overview.getByRole("button", { name: "Fetch all", exact: true }).waitFor();
  await overview.getByRole("button", { name: "Close repository overview", exact: true }).click();

  const menu = label => page.locator(".ctx-menu .ctx-item").filter({has: page.getByText(label, {exact: true})});
  const choose = async (row, label) => {
    await row.click({button: "right"});
    await menu(label).click();
  };
  const groupRow = name => group(name).locator(".repository-select");
  const workspaceRow = name => workspace(name).locator(".repository-select");
  const member = (state, name, repo) => state.groups.find(item => item.name === name).roots.some(root => path.basename(root) === repo);
  await choose(groupRow("Platform"), "Remove from parent group");
  assert.equal((await library()).groups.find(item => item.name === "Platform").parentId, null);
  const addApi = () => openSubmenu(page, () => repository("api").click({button: "right"}), menu("Add to group"), menu("Platform"));
  await addApi();
  await menu("Platform").click();
  assert(member(await library(), "Delivery", "api") && member(await library(), "Platform", "api"));
  await choose(workspaceRow("product"), "New sub-workspace…");
  const workspaceEditor = page.getByRole("dialog", {name: "New workspace", exact: true});
  const groupFilter = workspaceEditor.getByRole("combobox", {name: "Filter repositories by group", exact: true});
  for (const name of ["Delivery", "Platform"]) {
    await groupFilter.selectOption({label: name});
    await workspaceEditor.getByRole("checkbox", {name: /^api\b/}).waitFor();
  }
  await workspaceEditor.getByRole("button", {name: "Cancel", exact: true}).click();
  await groupRow("Delivery").click();
  await choose(repository("api"), "Remove from group · Delivery");
  assert(!member(await library(), "Delivery", "api") && member(await library(), "Platform", "api"));
  await groups.getByRole("button", { name: "All groups", exact: true }).click();
  await repository("api").click({modifiers: ["Control"]});
  await repository("platform").click({modifiers: ["Control"]});
  await choose(repository("platform"), "Remove from all groups");
  assert(!member(await library(), "Platform", "api") && !member(await library(), "Platform", "platform"));
  await repository("api").press("Escape");

  await workspaceRow("product").click();
  await repository("api").waitFor();
  await choose(groupRow("Engineering"), "Remove from workspace · product");
  await group("Engineering").waitFor({state: "detached"});
  await group("Delivery").waitFor({state: "detached"});
  await repository("api").waitFor();
  await ws.getByRole("button", { name: "All Workspaces", exact: true }).click();
  await group("Engineering").waitFor();
  await workspaceRow("product").click();
  await group("Engineering").waitFor({state: "detached"});
  await page.getByRole("button", {name: "Repository library and workspaces", exact: true}).click();
  const manage = page.getByRole("dialog", {name: "Repository library", exact: true});
  await manage.getByRole("button", {name: "Groups", exact: true}).click();
  await manage.locator(".library-row").filter({has: page.getByText("Engineering", {exact: true})}).getByRole("button", {name: "Restore to workspace", exact: true}).click();
  await manage.getByRole("button", {name: "Done", exact: true}).click();
  await group("Engineering").waitFor();
  await ws.getByRole("button", { name: "All Workspaces", exact: true }).click();
  await groupRow("Engineering").click({modifiers: ["Control"]});
  await groupRow("Platform").click({modifiers: ["Control"]});
  await groupRow("Platform").press("Delete");
  const deleteGroups = page.getByRole("dialog", {name: "Delete 2 groups?", exact: true});
  await deleteGroups.getByRole("button", {name: "Delete 2 groups", exact: true}).click();
  await group("Engineering").waitFor({state: "detached"});
  await group("Platform").waitFor({state: "detached"});
  await group("Delivery").waitFor();
  assert.equal((await library()).groups.find(item => item.name === "Delivery").parentId, null);

  await choose(workspaceRow("worker"), "Remove from parent workspace");
  assert.equal((await library()).workspaces.find(item => item.name === "worker").parentId, null);
  await workspaceRow("worker").click();
  await workspaceRow("worker").press("Delete");
  const deleteWorkspace = page.getByRole("dialog", {name: "Delete saved workspace?", exact: true});
  await deleteWorkspace.getByRole("button", {name: "Delete workspace", exact: true}).click();
  await workspace("worker").waitFor({state: "detached"});
  await ws.getByRole("button", {name: "All Workspaces", exact: true}).and(page.locator('[aria-current="true"]')).waitFor();
  assert.equal((await library()).workspaces.find(item => item.name === "plugins").parentId, null);
  for (const name of ["api", "worker", "platform"]) {
    await repository(name).waitFor();
    assert(fs.existsSync(path.join((await library()).knownRoots.find(root => path.basename(root) === name), ".git")));
  }
  await groups.getByRole("button", { name: "Hide Groups", exact: true }).click();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
  const input = settings.locator('input[type="file"]');
  const review = page.getByRole("dialog", { name: "Review imported shortcuts", exact: true });
  await input.setInputFiles({ name: "keybindings.json", mimeType: "application/json", buffer: Buffer.from('[{"command":"git.fetch","key":"alt+f11"},]') });
  await review.getByRole("button", { name: "Select matches", exact: true }).click();
  await review.getByRole("button", { name: "Apply 1 selected", exact: true }).click();
  await review.waitFor({ state: "detached" });
  assert.equal(await settings.getByRole("button", { name: "Change shortcut for Fetch", exact: true }).innerText(), "Alt+F11");
  await settings.getByTitle("Reset shortcut for Fetch", { exact: true }).click();
  await input.setInputFiles({ name: "Rider.xml", mimeType: "application/xml", buffer: Buffer.from('<keymap><action id="Vcs.Push"><keyboard-shortcut first-keystroke="ctrl alt F12"/></action></keymap>') });
  await review.locator(".shortcut-import-match").getByText("Vcs.Push", { exact: true }).waitFor();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();

  await input.setInputFiles({ name: "shifted.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([
    {command:"workbench.action.openSettings",key:"ctrl+shift+["},
    {command:"workbench.action.showCommands",key:"ctrl+shift+1"},
  ])) });
  await review.getByRole("button", { name: "Select matches", exact: true }).click();
  await review.getByRole("button", { name: "Apply 2 selected", exact: true }).click();
  await review.waitFor({ state: "detached" });
  await settings.getByRole("button", { name: "Done", exact: true }).click();

  const keyboard = await page.context().newCDPSession(page);
  async function pressKey(code, key, windowsVirtualKeyCode, modifiers) {
    const event = { code, key, windowsVirtualKeyCode, modifiers };
    await keyboard.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
    await keyboard.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }
  try {
    await pressKey("Digit1", "!", 49, 10); // Ctrl + Shift.
    await page.waitForFunction(() => document.activeElement?.matches(".palette input"));
    await page.keyboard.press("Escape");
    await page.locator(".palette input").waitFor({ state: "detached" });
    await pressKey("BracketLeft", "{", 219, 10);
    await settings.waitFor();
    await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await settings.getByTitle("Reset shortcut for Command palette", { exact: true }).click();
    await input.setInputFiles({ name: "revqora-shortcuts.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({
      format: "revqora.shortcuts", version: 1, shortcuts: [{ id: "settings", label: "Settings", key: "Ctrl+Ф" }],
    })) });
    await review.getByRole("button", { name: "Select matches", exact: true }).click();
    await review.getByRole("button", { name: "Apply 1 selected", exact: true }).click();
    await review.waitFor({ state: "detached" });
    await settings.getByRole("button", { name: "Done", exact: true }).click();
    await settings.waitFor({ state: "detached" });
    await pressKey("KeyA", "ф", 65, 2); // Ctrl on a Cyrillic layout.
    await settings.waitFor();
  } finally { await keyboard.detach(); }
  await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
  await settings.getByTitle("Reset shortcut for Settings", { exact: true }).click();
  await settings.getByRole("button", { name: "Done", exact: true }).click();
}
