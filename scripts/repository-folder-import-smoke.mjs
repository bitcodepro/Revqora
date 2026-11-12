import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";

async function checkFolderScanProgress(page, dialog) {
  await page.evaluate(() => {
    const scanUrl = window.__TAURI_INTERNALS__.convertFileSrc("repo_scan_folder", "ipc");
    const original = window.fetch;
    let release;
    window.fetch = (input, init) => {
      const response = original(input, init);
      if ((input?.url ?? input) !== scanUrl) return response;
      return new Promise(resolve => { release = () => resolve(response); });
    };
    window.__finishFolderScan = () => {
      window.fetch = original;
      release?.();
      delete window.__finishFolderScan;
    };
  });
  const progress = dialog.getByRole("status").filter({ hasText: "Looking for Git repositories" });
  const icon = progress.locator("svg");
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await dialog.getByRole("button", { name: "Scan folder", exact: true }).click();
    const initial = await icon.evaluate(element => {
      const style = getComputedStyle(element);
      return { duration: style.animationDuration, iterations: style.animationIterationCount, transform: style.transform };
    });
    assert.equal(initial.duration, "1s");
    assert.equal(initial.iterations, "infinite");
    await page.waitForFunction(transform => {
      const icon = document.querySelector(".repository-import-progress > svg");
      return icon && getComputedStyle(icon).transform !== transform;
    }, initial.transform);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await icon.waitFor({ state: "hidden" });
    await progress.getByText(/^[1-9]\d*s elapsed$/).waitFor();
    const elapsed = await progress.locator(".batch-note").textContent();
    await page.waitForFunction(previous => {
      const value = document.querySelector(".repository-import-progress .batch-note")?.textContent;
      return value && value !== previous;
    }, elapsed);
  } finally {
    await page.evaluate(() => window.__finishFolderScan?.());
    await page.emulateMedia({ reducedMotion: null });
  }
  await progress.waitFor({ state: "detached" });
}

export async function repositoryFolderImportSmoke({ page, work, shot }) {
  const parent = path.join(work, "folder-import");
  const init = (relative) => {
    const root = path.join(parent, relative);
    fs.mkdirSync(root, { recursive: true });
    execFileSync("git", ["-C", root, "init", "-qb", "main"], { windowsHide: true });
  };
  for (const repo of ["import-direct", "import-direct/children/nested-repo", "import-backend/service-api", "import-backend/service-worker", "import-frontend/web-ui"]) {
    init(repo);
  }
  const serviceApi = path.join(parent, "import-backend", "service-api");
  const gitService = (...args) => execFileSync("git", ["-C", serviceApi, ...args], { windowsHide: true });
  const commitService = (subject) => gitService("-c", "user.name=Revqora Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--allow-empty", "-qm", subject);
  commitService("Service API main");
  gitService("switch", "-qc", "detached-branch-tip");
  commitService("Detached branch target commit");
  gitService("switch", "-q", "main");
  const workingFile = path.join(serviceApi, "local.txt");
  fs.writeFileSync(workingFile, "uncommitted work\n");
  const sidebar = page.locator(".repository-slot > .repository-sidebar");
  const reposToggle = page.getByRole("button", { name: "Toggle repositories panel", exact: true });
  const explorerToggle = page.getByRole("button", { name: "Toggle Explorer panel", exact: true });
  const explorer = page.getByRole("complementary", { name: "Explorer", exact: true });
  if (!await explorer.isVisible()) await explorerToggle.click();
  if (await reposToggle.getAttribute("aria-expanded") === "false") await reposToggle.click();
  const preview = async (count, root = parent, checkProgress = false) => {
    await page.locator(".topbar").click({ button: "right", position: { x: 3, y: 3 } });
    await page.locator(".ctx-menu").getByText("Import folder…", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import repositories from a folder", exact: true });
    await dialog.getByLabel("Parent folder", { exact: true }).fill(root);
    if (checkProgress) await checkFolderScanProgress(page, dialog);
    else await dialog.getByRole("button", { name: "Scan folder", exact: true }).click();
    await dialog.getByText(`${count} of ${count} selected`, { exact: true }).waitFor();
    return dialog;
  };
  const confirm = async (dialog, count) => {
    await dialog.getByRole("button", { name: `Import ${count} ${count === 1 ? "repository" : "repositories"}`, exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    if (await reposToggle.getAttribute("aria-expanded") === "false") await reposToggle.click();
  };
  const overview = page.locator(".repository-overview");
  const repoInOverview = name => overview.getByRole("button", { name, exact: true });
  const group = name => explorer.getByRole("treeitem", { name, exact: true }).and(explorer.locator("[data-tree-group]"));
  const repoButton = name => sidebar.locator(".repository-select").filter({ has: page.getByText(name, { exact: true }) });
  const picker = sidebar.getByRole("combobox", { name: "Repository group", exact: true });
  const pick = name => group(name).locator(".repository-select").click();

  let dialog = await preview(5, parent, true);
  for (const name of ["folder-import", "import-backend", "import-frontend", "children"]) {
    await dialog.getByText(`Group · ${name}`, { exact: true }).waitFor();
  }
  await dialog.getByRole("checkbox", { name: /^service-worker\b/ }).uncheck();
  await shot?.("repository-folder-import-preview");
  await confirm(dialog, 4);
  for (const name of ["import-direct", "nested-repo", "service-api", "web-ui"]) await repoInOverview(name).waitFor();
  assert.equal(await repoInOverview("service-worker").count(), 0);
  const backendId = await group("import-backend").getAttribute("data-tree-group");
  assert(backendId);
  await pick("import-backend");
  assert.equal(await picker.inputValue(), backendId);
  await repoButton("service-api").waitFor();
  assert.equal(await repoButton("web-ui").count(), 0);

  dialog = await preview(5);
  await confirm(dialog, 5);
  await repoInOverview("service-worker").waitFor();
  assert.equal(await group("import-backend").count(), 1);
  assert.equal(await group("import-backend").getAttribute("data-tree-group"), backendId);
  await pick("import-backend");
  await repoButton("service-worker").waitFor();

  init("flat-import/flat-group/flat-repo");
  dialog = await preview(1, path.join(parent, "flat-import"));
  await dialog.getByRole("checkbox", { name: "Recreate the folder tree in Explorer", exact: true }).uncheck();
  await confirm(dialog, 1);
  await repoInOverview("flat-repo").waitFor();
  assert.equal(await group("flat-group").count(), 0);
  assert.equal(await explorer.getByRole("treeitem", { name: "flat-repo", exact: true }).getAttribute("aria-level"), "1");
  assert.equal(fs.readFileSync(workingFile, "utf8"), "uncommitted work\n");

  const search = explorer.getByRole("textbox", { name: "Find in Explorer", exact: true });
  await search.fill("import-backend");
  await group("import-backend").waitFor();
  assert.equal(await group("import-frontend").count(), 0);
  await group("import-backend").getByRole("button", { name: "Favorite group import-backend", exact: true }).click();
  await search.clear();
  const favorites = explorer.getByRole("button", { name: "Favorites", exact: true });
  await favorites.click();
  assert.equal(await group("import-frontend").count(), 0);
  await favorites.click();
  await pick("import-backend");

  await page.locator(".topbar").click({ button: "right", position: { x: 3, y: 3 } });
  await page.locator(".ctx-menu").getByText("Pull requests / Merge requests", { exact: true }).waitFor();
  await page.locator(".ctx-menu").getByText("Settings…", { exact: true }).click();
  const settings = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Settings", exact: true }) });
  const grip = settings.getByRole("button", { name: "Resize window", exact: true });
  await grip.waitFor();
  await grip.press("ArrowRight");
  await page.locator(".modal[style*='--saved-window-width']").waitFor();
  const width = await settings.evaluate(dialog => dialog.style.getPropertyValue("--saved-window-width"));
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
  await page.getByTitle("Settings", { exact: true }).click();
  await settings.waitFor();
  assert.equal(await settings.evaluate(dialog => dialog.style.getPropertyValue("--saved-window-width")), width);
  await grip.press("Home");
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });

  // Observe the real native popup while continuing to use the parent CDP session.
  await page.evaluate(() => {
    const open = window.open;
    window.open = function (...args) {
      const child = open.apply(this, args);
      window.__workspacePanelWindow = child;
      return child;
    };
    window.__restoreWorkspacePanelOpen = () => { window.open = open; delete window.__workspacePanelWindow; delete window.__restoreWorkspacePanelOpen; };
  });
  try {
    const detach = async (title) => {
      await title.click({ button: "right" });
      await page.locator(".ctx-menu").getByText("Detach", { exact: true }).click();
    };
    const attach = async () => {
      await page.evaluate(() => {
        const child = window.__workspacePanelWindow;
        child.document.querySelector(".detached-panel > header").dispatchEvent(new child.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
      });
      await page.waitForFunction(() => window.__workspacePanelWindow?.document.querySelector(".ctx-menu .ctx-item")?.textContent.trim() === "Attach");
      await page.evaluate(() => window.__workspacePanelWindow.document.querySelector(".ctx-menu .ctx-item").click());
      await page.waitForFunction(() => window.__workspacePanelWindow?.closed);
    };
    await detach(explorer.locator("header > b"));
    await page.waitForFunction(() => !!window.__workspacePanelWindow?.document.querySelector(".detached-explorer .explorer-sidebar"));
    await explorer.waitFor({ state: "detached" });
    await attach();
    await explorer.waitFor();

    await repoButton("service-api").click();
    await page.locator(".view-tabs .view-tab").filter({ hasText: "History" }).click();
    await page.locator(".workspace .graph-scroll").waitFor();
    const branchToggle = page.getByRole("button", { name: "Toggle branches panel", exact: true });
    if (await branchToggle.getAttribute("aria-expanded") !== "true") await branchToggle.click();
    await detach(page.locator(".branches-heading > b"));
    const showAll = page.locator(".topbar").getByRole("button", { name: "All repositories", exact: true });
    const targetRef = '[data-branch-ref="refs/heads/detached-branch-tip"]';
    await page.waitForFunction(selector => !!window.__workspacePanelWindow?.document.querySelector(`.detached-branches ${selector}`), targetRef);
    await showAll.click();
    await overview.waitFor();
    await page.locator(".workspace .graph-scroll").waitFor({ state: "detached" });
    await page.evaluate(selector => window.__workspacePanelWindow.document.querySelector(`.detached-branches ${selector}`).click(), targetRef);
    await overview.waitFor({ state: "detached" });
    const history = page.locator(".workspace .graph-scroll");
    await history.waitFor();
    const targetCommit = history.locator(".grow.branch-member").filter({ hasText: "Detached branch target commit" });
    await targetCommit.waitFor();
    const scope = page.getByRole("combobox", { name: "History scope", exact: true });
    assert.equal(await scope.inputValue(), "branch-context");
    assert.equal(await scope.locator("option:checked").textContent(), "Branch context — detached-branch-tip");
    assert.equal(await history.locator(".grow.selected").count(), 0, "A branch click must leave the commit unselected");
    const preview = page.locator(".commit-preview");
    assert.equal(await preview.count(), 0, "A branch click must leave commit details closed");
    await targetCommit.getByText("Detached branch target commit", { exact: true }).click();
    await targetCommit.and(history.locator(".grow.selected")).waitFor();
    await preview.getByText("Detached branch target commit", { exact: true }).waitFor();
    await preview.getByRole("button", { name: "Close", exact: true }).click();

    await showAll.click();
    await overview.waitFor();
    await page.evaluate(() => {
      const child = window.__workspacePanelWindow;
      child.document.querySelector(".detached-branches .branches-heading").dispatchEvent(new child.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
    });
    await page.waitForFunction(() => window.__workspacePanelWindow?.document.querySelector(".ctx-menu .ctx-item")?.textContent.trim() === "Branch manager");
    await page.evaluate(() => window.__workspacePanelWindow.document.querySelector(".ctx-menu .ctx-item").click());
    const manager = page.getByRole("region", { name: "Branch manager", exact: true });
    await manager.waitFor();
    await overview.waitFor({ state: "detached" });
    await manager.getByRole("button", { name: "Close branch manager", exact: true }).click();
    await attach();
    await page.locator(".branches-slot .sidebar").waitFor();

    await detach(page.locator(".view-tabs .view-tab").filter({ hasText: "History" }));
    await page.waitForFunction(() => !!window.__workspacePanelWindow?.document.querySelector(".detached-history .graph-toolbar input"));
    await page.evaluate(() => {
      const child = window.__workspacePanelWindow;
      const toolbar = child.document.querySelector(".detached-history .graph-toolbar");
      toolbar.dispatchEvent(new child.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => {
      const doc = window.__workspacePanelWindow?.document;
      return doc?.activeElement === doc?.querySelector(".detached-history .graph-toolbar input");
    });
    await attach();
    await page.locator(".workspace .graph-toolbar").waitFor();
  } finally {
    await page.evaluate(() => { window.__workspacePanelWindow?.close(); window.__restoreWorkspacePanelOpen(); });
  }
  await explorer.getByRole("button", { name: "Hide Explorer", exact: true }).click();
}
