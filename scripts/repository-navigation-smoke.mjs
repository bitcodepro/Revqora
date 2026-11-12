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
  const explorer = page.getByRole("complementary", { name: "Explorer", exact: true });
  const explorerToggle = nav.getByRole("button", { name: "Toggle Explorer panel", exact: true });
  const repoToggle = nav.getByRole("button", { name: "Toggle repositories panel", exact: true });
  if (!await explorer.isVisible()) await explorerToggle.click();
  const flat = page.locator(".repository-slot > .repository-sidebar");
  const group = name => explorer.getByRole("treeitem", { name, exact: true }).and(explorer.locator("[data-tree-group]"));
  const folder = name => group(name).locator(".repository-select");
  const treeRepo = name => explorer.getByRole("treeitem", { name, exact: true }).and(explorer.locator(".explorer-repository"));
  const repo = name => flat.locator(".repository-select").filter({ has: page.getByText(name, { exact: true }) });
  const library = () => page.evaluate(() => JSON.parse(localStorage.getItem("revqora.repositories")).state);
  const dragPoint = async (locator, fraction) => {
    const { x, y, reachable, hit } = await locator.evaluate((element, fraction) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height * fraction;
      const hit = element.ownerDocument.elementFromPoint(x, y);
      return { x, y, reachable: element.contains(hit), hit: hit?.outerHTML.split(">")[0].slice(0, 160) ?? "outside viewport" };
    }, fraction);
    assert(reachable, `Cannot reach ${locator} at (${x}, ${y}); pointer hits ${hit}`);
    return { x, y };
  };
  const drag = async (source, destination, fraction = 0.5, marker = "workspace-drop-active") => {
    await destination.scrollIntoViewIfNeeded();
    await source.scrollIntoViewIfNeeded();
    const start = await dragPoint(source, 0.5);
    const end = await dragPoint(destination, fraction);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    try {
      await page.mouse.move(end.x, end.y, {steps: 9});
      await destination.and(page.locator(`.${marker}`)).waitFor();
    } finally { await page.mouse.up(); }
  };

  const tooltip = page.getByRole("tooltip");
  const hideExplorer = explorer.getByRole("button", { name: "Hide Explorer", exact: true });
  for (let i = 0; i < 2; i++) {
    await hideExplorer.hover();
    assert.equal(await tooltip.innerText(), "Hide Explorer");
    await explorer.getByRole("textbox", { name: "Find in Explorer", exact: true }).hover();
    await tooltip.waitFor({ state: "detached" });
  }
  assert.equal(await explorer.getByRole("button", { name: "Manage library…", exact: true }).count(), 0);
  await page.locator(".topbar").click({ button: "right", position: { x: 3, y: 3 } });
  await page.locator(".ctx-menu").getByText("Import folder…", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import repositories from a folder", exact: true });
  await dialog.getByLabel("Parent folder").fill(parent);
  await dialog.getByRole("button", { name: "Scan folder", exact: true }).click();
  await dialog.getByText("Group · plugins", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Import 4 repositories", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const imported = (await library()).groups;
  const id = name => imported.find(item => item.name === name)?.id;
  assert.equal(imported.find(item => item.id === id("product")).parentId, id("navigation-projects"));
  assert.equal(imported.find(item => item.id === id("plugins")).parentId, id("worker"));
  assert.equal(await treeRepo("extension").getAttribute("aria-level"), "6");
  const folderIcon = () => folder("product").locator("svg").getAttribute("class");
  const expandedIcon = await folderIcon();
  await group("product").getByRole("button", { name: "Collapse product", exact: true }).click();
  assert.notEqual(await folderIcon(), expandedIcon);
  await treeRepo("extension").waitFor({ state: "detached" });
  const search = explorer.getByRole("textbox", { name: "Find in Explorer" });
  await search.fill("extension");
  await group("plugins").waitFor();
  await treeRepo("extension").waitFor();
  await search.clear();
  await treeRepo("extension").waitFor({ state: "detached" });
  await group("product").getByRole("button", { name: "Expand product", exact: true }).click();
  assert.equal(await folderIcon(), expandedIcon);

  await drag(folder("plugins"), explorer.locator("[data-explorer-root-drop]"));
  assert.equal((await library()).groups.find(item => item.id === id("plugins")).parentId, null);
  await drag(folder("plugins"), group("navigation-projects"), 0.08, "library-drop-before");
  const ordered = (await library()).groups.map(item => item.id);
  assert(ordered.indexOf(id("plugins")) < ordered.indexOf(id("navigation-projects")));
  await drag(folder("plugins"), group("worker"));
  assert.equal((await library()).groups.find(item => item.id === id("plugins")).parentId, id("worker"));

  if (await repoToggle.getAttribute("aria-expanded") === "false") await repoToggle.click();
  await folder("product").click();
  for (const name of ["api", "worker", "extension"]) await repo(name).waitFor();
  assert.equal(await repo("platform").count(), 0);
  assert.equal(await flat.locator(".repository-group").count(), 0);
  assert.equal(await flat.getByRole("button", { name: "All repositories", exact: true }).count(), 0);
  await explorer.getByRole("textbox", { name: "Find in Explorer" }).hover();
  const activeFolder = group("product");
  assert.equal(await folder("product").getAttribute("aria-current"), "true");
  assert.notEqual(await activeFolder.evaluate(row => getComputedStyle(row).backgroundColor), "rgba(0, 0, 0, 0)");
  assert.equal(await explorer.getByRole("treeitem", { name: "Default group", exact: true }).count(), 0);
  await shot?.("explorer-and-flat-repositories");

  const focusedRow = explorer.locator(".explorer-focused");
  const selectedNames = async () => (await explorer.locator('[aria-selected="true"]').evaluateAll(rows =>
    rows.map(row => row.getAttribute("aria-label")))).sort();
  await page.keyboard.press("ArrowDown");
  assert.equal(await focusedRow.getAttribute("aria-label"), "components");
  await page.keyboard.press("ArrowUp");
  assert.equal(await focusedRow.getAttribute("aria-label"), "product");
  const api = treeRepo("api").locator(".repository-select");
  await api.click();
  await search.hover();
  assert.equal(await focusedRow.getAttribute("aria-label"), "api");
  assert.notEqual(await treeRepo("api").evaluate(row => getComputedStyle(row).backgroundColor), "rgba(0, 0, 0, 0)");
  assert.equal(await folder("product").getAttribute("aria-current"), "true");
  await page.keyboard.press("Control+a");
  assert.deepEqual(await selectedNames(), ["api", "components"]);
  await page.keyboard.press("Control+a");
  assert.equal(await focusedRow.getAttribute("aria-label"), "product");
  assert.deepEqual(await selectedNames(), ["infra", "product"]);
  await page.keyboard.press("Control+a");
  assert.equal(await focusedRow.getAttribute("aria-label"), "navigation-projects");
  assert.deepEqual(await selectedNames(), ["navigation-projects"]);
  await folder("components").click();
  await api.click({ modifiers: ["Shift"] });
  assert.deepEqual(await selectedNames(), ["api", "components"]);
  await treeRepo("worker").locator(".repository-select").click({ modifiers: ["Shift"] });
  assert.deepEqual(await selectedNames(), ["worker"]);
  await page.keyboard.press("Escape");
  assert.deepEqual(await selectedNames(), []);
  await folder("product").click();

  const flatRows = flat.locator(".repository-select");
  await flatRows.first().click();
  await flatRows.last().click({ modifiers: ["Shift"] });
  assert.equal(await flat.locator(".repository-item.batch-selected").count(), 3);
  await page.keyboard.press("Escape");
  assert.equal(await flat.locator(".repository-item.batch-selected").count(), 0);
  const activeRow = flat.locator(".repository-item.active");
  assert.equal(await activeRow.evaluate(row => getComputedStyle(row).backgroundColor), "rgba(0, 0, 0, 0)");
  await flatRows.first().click({ modifiers: ["Control"] });
  await flat.locator(".repository-list").evaluate(list => list.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  assert.equal(await flat.locator(".repository-item.batch-selected").count(), 0);
  await flatRows.last().click({ modifiers: ["Shift"] });
  assert(await flat.locator(".repository-item.batch-selected").count() > 0);
  await flatRows.first().click();
  assert.equal(await flat.locator(".repository-item.batch-selected").count(), 0);

  await folder("product").press("F2");
  const renameGroup = page.getByRole("dialog", { name: "Rename group", exact: true });
  await renameGroup.getByRole("button", { name: "Cancel", exact: true }).click();
  await treeRepo("api").locator(".repository-select").press("F2");
  const renameRepo = page.getByRole("dialog", { name: "Rename repository", exact: true });
  await renameRepo.getByRole("button", { name: "Cancel", exact: true }).click();

  const menu = label => page.locator(".ctx-menu").getByText(label, { exact: true });
  const choose = async (row, label) => { await row.click({ button: "right" }); await menu(label).click(); };
  const create = async name => {
    const editor = page.getByRole("dialog", { name: "New group", exact: true });
    await editor.getByRole("textbox", { name: "Group name", exact: true }).fill(name);
    await editor.getByRole("button", { name: "Create group", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await group(name).waitFor();
  };
  await choose(explorer.locator(".repository-overview-link"), "Create group");
  await create("Context root");
  assert.equal((await library()).groups.find(item => item.name === "Context root").parentId, null);
  await choose(folder("worker"), "Create group");
  await create("Context sibling");
  assert.equal((await library()).groups.find(item => item.name === "Context sibling").parentId, id("components"));
  await choose(folder("worker"), "Create subgroup");
  await create("Context child");
  assert.equal((await library()).groups.find(item => item.name === "Context child").parentId, id("worker"));
  await folder("product").click();
  await drag(repo("extension"), group("Context child"));
  assert((await library()).groups.find(item => item.name === "Context child").roots.some(root => path.basename(root) === "extension"));
  await page.keyboard.press("Control+z");
  await page.getByText("Explorer move undone", { exact: true }).waitFor();
  assert((await library()).groups.find(item => item.id === id("plugins")).roots.some(root => path.basename(root) === "extension"));
  await drag(treeRepo("extension").locator(".repository-select"), group("Context child"));
  assert((await library()).groups.find(item => item.name === "Context child").roots.some(root => path.basename(root) === "extension"));
  await folder("Context child").click();
  await repo("extension").waitFor();
  await folder("Context child").press("Delete");
  const deleting = page.getByRole("dialog", { name: "Delete group?", exact: true });
  await deleting.getByRole("button", { name: "Delete group", exact: true }).click();
  await group("Context child").waitFor({ state: "detached" });
  assert.equal((await library()).activeGroupId, null);
  const extension = treeRepo("extension");
  assert.equal(await extension.getAttribute("aria-level"), "1");
  const root = (await library()).knownRoots.find(root => path.basename(root) === "extension");
  assert(fs.existsSync(path.join(root, ".git")));

  await treeRepo("api").locator(".repository-select").click({ modifiers: ["Control"] });
  await treeRepo("worker").locator(".repository-select").click({ modifiers: ["Control"] });
  await choose(treeRepo("worker").locator(".repository-select"), "Create group");
  await create("Selected repositories");
  const selectedGroup = async () => (await library()).groups.find(item => item.name === "Selected repositories");
  assert.deepEqual((await selectedGroup()).roots.map(root => path.basename(root)), ["api", "worker"]);
  await drag(treeRepo("worker").locator(".repository-select"), treeRepo("api"), 0.08, "library-drop-before");
  assert.deepEqual((await selectedGroup()).roots.map(root => path.basename(root)), ["worker", "api"]);
  const worker = treeRepo("worker").locator(".repository-select");
  const destination = page.locator(".ctx-item").getByText("Context root", { exact: true });
  await openSubmenu(page, () => worker.click({ button: "right" }), menu("Add to group"), destination);
  await destination.click();
  const placements = (await library()).groups.filter(item => item.roots.some(root => path.basename(root) === "worker"));
  assert.equal(placements.length, 2);
  await hideExplorer.click();

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
