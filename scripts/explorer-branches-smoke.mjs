import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function explorerBranchesSmoke({ page, work, shot }) {
  const product = path.join(work, "Product");
  const roots = ["inventory-service", "api-gateway"].map(name => path.join(product, name));
  for (const root of roots) {
    fs.mkdirSync(root, { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
    git("init", "-qb", "main");
    git("config", "user.name", "Alex Developer");
    git("config", "user.email", "alex@example.invalid");
    git("config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(root, "README.md"), "Product service\n");
    git("add", "README.md");
    git("commit", "-qm", "Add service README");
    git("-c", "user.name=Platform Team", "-c", "user.email=team@example.invalid", "branch", "develop");
    git("-c", "user.name=Platform Team", "-c", "user.email=team@example.invalid", "branch", "release/next");
    if (root === roots[0]) {
      git("checkout", "-qb", "feature/reservations");
      fs.appendFileSync(path.join(root, "README.md"), "Reservations API\n");
      git("commit", "-qam", "Document the reservations API");
      git("checkout", "-q", "main");
      git("branch", "feature/stock-alerts");
    } else {
      git("branch", "feature/request-routing");
    }
  }
  const panel = page.getByRole("complementary", { name: "Explorer", exact: true });
  if (!await panel.isVisible()) await page.getByRole("button", { name: "Toggle Explorer panel", exact: true }).click();
  const search = panel.getByRole("textbox", { name: "Find in Explorer", exact: true });
  await search.clear();
  await panel.getByRole("button", { name: "All repositories", exact: true }).click({ button: "right" });
  await page.locator(".ctx-item").filter({ hasText: /^Import folder…$/ }).click();
  const importDialog = page.getByRole("dialog", { name: "Import repositories from a folder" });
  await importDialog.getByRole("textbox", { name: "Parent folder" }).fill(product);
  await importDialog.getByRole("button", { name: "Scan folder", exact: true }).click();
  await importDialog.getByRole("button", { name: "Import 2 repositories", exact: true }).click();
  await importDialog.waitFor({ state: "detached" });
  const repo = name => panel.getByRole("treeitem", { name, exact: true }).and(panel.locator("[data-explorer-repository]"));
  const selectRepo = name => repo(name).locator(".repository-select");
  const branch = name => panel.getByRole("treeitem", { name, exact: true }).and(panel.locator("[data-explorer-branch]"));
  const inventory = repo("inventory-service");
  const gateway = repo("api-gateway");
  await inventory.getByRole("button", { name: "Expand branches in inventory-service" }).click();
  await branch("feature/reservations").waitFor();
  const branchNames = async (row) => {
    const parent = await row.getAttribute("data-explorer-entry");
    return panel.locator("[data-explorer-branch]").evaluateAll((rows, parentId) =>
      rows.filter(row => JSON.parse(row.dataset.explorerEntry)[0] === parentId).map(row => row.getAttribute("aria-label")), parent);
  };
  assert.deepEqual(await branchNames(inventory), ["main", "develop", "feature/reservations", "feature/stock-alerts", "release/next"]);
  await branch("develop").locator(".repository-select").click({ button: "right" });
  const explorerLabels = await page.locator(".ctx-menu .ctx-item > span:nth-child(2)").allTextContents();
  await page.locator(".ctx-item").filter({ hasText: /^Set as primary branch$/ }).click();
  await branch("develop").getByRole("img", { name: "Primary branch", exact: true }).waitFor();
  assert.equal((await branchNames(inventory))[0], "develop");
  await branch("feature/reservations").getByRole("button", { name: "Favorite branch feature/reservations" }).click();
  await branch("feature/reservations").getByRole("button", { name: "Unfavorite branch feature/reservations" }).waitFor();

  const mine = panel.getByRole("button", { name: "My branches", exact: true });
  await mine.click();
  await branch("feature/request-routing").waitFor();
  await branch("release/next").waitFor({ state: "detached" });
  assert.deepEqual(await branchNames(inventory), ["develop", "main", "feature/reservations", "feature/stock-alerts"]);
  const favorites = panel.getByRole("button", { name: "Favorites", exact: true });
  await favorites.click();
  await gateway.waitFor({ state: "detached" });
  assert.deepEqual(await branchNames(inventory), ["feature/reservations"]);
  await favorites.click();
  await mine.click();
  await inventory.getByRole("button", { name: "Collapse branches in inventory-service" }).click();
  await branch("feature/reservations").waitFor({ state: "detached" });
  await search.fill("reservations");
  await branch("feature/reservations").waitFor();
  assert.deepEqual(await branchNames(inventory), ["feature/reservations"]);
  await search.clear();

  // An inactive open repository reflects an external ref change while expanded.
  await selectRepo("api-gateway").click();
  await page.locator(".repo-current").getByText("api-gateway", { exact: true }).waitFor();
  await inventory.getByRole("button", { name: "Expand branches in inventory-service" }).click();
  execFileSync("git", ["-C", roots[0], "branch", "feature/external"], { windowsHide: true });
  await branch("feature/external").waitFor();
  execFileSync("git", ["-C", roots[0], "branch", "-D", "feature/external"], { windowsHide: true, stdio: "ignore" });
  await branch("feature/external").waitFor({ state: "detached" });

  // An Explorer branch cannot start dragging. The parent repository still can.
  const ref = branch("feature/reservations").locator(".repository-select");
  const bounds = await ref.boundingBox();
  assert(bounds);
  await page.mouse.move(bounds.x + 14, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 55, bounds.y + bounds.height / 2, { steps: 3 });
  assert.equal(await page.locator("body.explorer-dragging").count(), 0);
  await page.mouse.up();
  // Browse a closed repository without activating it, then open its branch context.
  await inventory.getByRole("button", { name: "Close inventory-service", exact: true }).click();
  await inventory.getByRole("button", { name: "Close inventory-service", exact: true }).waitFor({ state: "detached" });
  await ref.waitFor();
  await ref.click();
  await page.locator(".repo-current").getByText("inventory-service", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "History scope" }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("select option")].some(option =>
    option.selected && option.textContent.includes("Branch context") && option.textContent.includes("feature/reservations")));
  assert.equal(execFileSync("git", ["-C", roots[0], "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(), "main");

  const navigation = page.getByRole("group", { name: "Repository navigation", exact: true });
  const branchesToggle = navigation.getByRole("button", { name: "Toggle branches panel", exact: true });
  const branches = page.locator(".sidebar");
  if (!await branches.isVisible()) await branchesToggle.click();
  const pinned = branches.locator(".sb-primary-branch [data-branch-ref='refs/heads/develop']");
  await pinned.waitFor();
  const mineSidebar = branches.getByRole("button", { name: "My branches", exact: true });
  if (await mineSidebar.getAttribute("aria-pressed") === "false") await mineSidebar.click();
  await pinned.waitFor();
  await pinned.click({ button: "right" });
  const sidebarLabels = await page.locator(".ctx-menu .ctx-item > span:nth-child(2)").allTextContents();
  assert.deepEqual(sidebarLabels.map(label => label.replace("Clear primary branch", "Set as primary branch")), explorerLabels);
  await page.keyboard.press("Escape");

  await branchesToggle.click();
  await gateway.getByRole("button", { name: "Expand branches in api-gateway" }).click();
  await branch("feature/request-routing").waitFor();
  await ref.click();
  await search.hover();
  await shot?.("explorer-branches");

  const all = panel.getByRole("button", { name: "All repositories", exact: true });
  const repositoryBounds = await selectRepo("inventory-service").boundingBox();
  const targetBounds = await all.boundingBox();
  assert(repositoryBounds && targetBounds);
  await page.mouse.move(repositoryBounds.x + 25, repositoryBounds.y + repositoryBounds.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(targetBounds.x + 45, targetBounds.y + targetBounds.height / 2, { steps: 9 });
    await all.and(panel.locator(".workspace-drop-active")).waitFor();
  } finally {
    await page.mouse.up();
  }
  await inventory.and(panel.locator('[aria-level="1"]')).waitFor();
  await branch("feature/reservations").and(panel.locator('[aria-level="2"]')).waitFor();
  assert.equal((await branchNames(inventory))[0], "develop");
}
