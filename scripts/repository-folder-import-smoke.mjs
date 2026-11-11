import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";

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
  const sidebar = page.locator(".repository-sidebar:not(.workspace-sidebar)");
  const repositoriesToggle = page.getByRole("button", { name: "Toggle repositories panel", exact: true });
  if (await repositoriesToggle.getAttribute("aria-expanded") === "false") await repositoriesToggle.click();
  const preview = async (count, root = parent) => {
    await page.getByRole("button", { name: /^Import folder…/ }).click();
    const dialog = page.locator(".modal").last();
    await dialog.getByLabel("Parent folder", { exact: true }).fill(root);
    await dialog.getByRole("button", { name: "Scan folder", exact: true }).click();
    await dialog.getByText(`${count} of ${count} selected`, { exact: true }).waitFor();
    return dialog;
  };
  const confirm = async (dialog, count) => {
    await dialog.getByRole("button", { name: `Import ${count} ${count === 1 ? "repository" : "repositories"}`, exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  };
  const overview = page.locator(".repository-overview");
  const repoInOverview = (name) => overview.getByRole("button", { name, exact: true });
  const picker = page.getByLabel("Workspace", { exact: true });
  const workspaceId = (name) => picker.locator("option").getByText(name, { exact: true }).getAttribute("value");

  let dialog = await preview(5);
  await dialog.getByText("Workspace · folder-import", { exact: true }).waitFor();
  await dialog.getByText("Workspace · import-backend", { exact: true }).waitFor();
  await dialog.getByText("Workspace · import-frontend", { exact: true }).waitFor();
  const nested = dialog.locator(".repository-import-group").filter({ hasText: "Workspace · children" });
  await nested.getByText("nested-repo", { exact: true }).waitFor();
  await dialog.getByRole("checkbox", { name: /^service-worker\b/ }).uncheck();
  await shot?.("repository-folder-import-preview");
  await confirm(dialog, 4);
  for (const name of ["import-direct", "nested-repo", "service-api", "web-ui"]) await repoInOverview(name).waitFor();
  assert.equal(await repoInOverview("service-worker").count(), 0);
  const backendId = await workspaceId("import-backend");
  assert(backendId);
  await picker.selectOption(backendId);
  await overview.waitFor({ state: "detached" });
  await sidebar.getByText("service-api", { exact: true }).waitFor();
  assert.equal(await sidebar.getByText("web-ui", { exact: true }).count(), 0);

  dialog = await preview(5);
  await confirm(dialog, 5);
  await repoInOverview("service-worker").waitFor();
  assert.equal(await picker.locator("option").getByText("import-backend", { exact: true }).count(), 1);
  assert.equal(await workspaceId("import-backend"), backendId);
  await picker.selectOption(backendId);
  await overview.waitFor({ state: "detached" });
  await sidebar.getByText("service-worker", { exact: true }).waitFor();
  await sidebar.getByText("service-api", { exact: true }).waitFor();

  init("flat-import/flat-group/flat-repo");
  dialog = await preview(1, path.join(parent, "flat-import"));
  await dialog.getByRole("checkbox", { name: "Recreate the folder tree as Workspaces", exact: true }).uncheck();
  await confirm(dialog, 1);
  await repoInOverview("flat-repo").waitFor();
  assert.equal(await picker.locator("option").getByText("flat-group", { exact: true }).count(), 0);

  await picker.selectOption(backendId);
  await overview.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Repository library and workspaces", exact: true }).click();
  await page.locator(".library-tabs").getByRole("button", { name: "Workspaces", exact: true }).click();
  const source = page.locator(".library-row", { has: page.getByText("import-backend · Active", { exact: true }) });
  const openMove = async () => {
    await source.getByRole("button", { name: "Move repositories…", exact: true }).click();
    const move = page.locator(".modal").filter({ has: page.getByRole("heading", { name: /^Move repositories/ }) });
    await move.getByLabel("Destination workspace", { exact: true }).selectOption({ label: "import-frontend" });
    await move.getByRole("button", { name: "Select all", exact: true }).click();
    return move;
  };
  let move = await openMove();
  await move.getByRole("checkbox", { name: /^service-worker\b/ }).uncheck();
  await shot?.("workspace-move-preview");
  await move.getByRole("button", { name: "Move 1 repository", exact: true }).click();
  await move.waitFor({ state: "detached" });
  await source.getByText(/^1 repository · /).waitFor();
  move = await openMove();
  await move.getByRole("button", { name: "Move 1 repository", exact: true }).click();
  await move.waitFor({ state: "detached" });
  await source.getByText(/^0 repositories · /).waitFor();
  await page.locator(".modal").last().getByRole("button", { name: "Done", exact: true }).click();
  await picker.selectOption({ label: "import-frontend" });
  for (const name of ["service-api", "service-worker", "web-ui"]) await sidebar.getByText(name, { exact: true }).waitFor();
  for (const relative of ["import-backend/service-api", "import-backend/service-worker", "import-frontend/web-ui"]) {
    assert(fs.existsSync(path.join(parent, relative, ".git")), "Moving workspace membership changed the Git folder");
  }
  assert.equal(fs.readFileSync(workingFile, "utf8"), "uncommitted work\n");

  await page.getByRole("button", { name: "Toggle Workspaces panel", exact: true }).click();
  const workspaces = page.getByRole("complementary", { name: "Workspaces", exact: true });
  const destination = workspaces.getByRole("button", { name: /^import-backend\b/ });
  const search = workspaces.getByRole("textbox", { name: "Find workspace" });
  await search.fill("back");
  await destination.waitFor();
  assert.equal(await workspaces.getByRole("button", { name: /^import-frontend\b/ }).count(), 0);
  await workspaces.getByRole("button", { name: "Favorite workspace import-backend", exact: true }).click();
  await search.clear();
  await workspaces.getByRole("button", { name: "Favorites", exact: true }).click();
  assert.equal(await workspaces.getByRole("button", { name: /^import-frontend\b/ }).count(), 0);
  await workspaces.getByRole("button", { name: "Favorites", exact: true }).click();
  const repoButton = name => sidebar.locator(".repository-select").filter({ has: page.getByText(name, { exact: true }) });
  await repoButton("service-api").click({ modifiers: ["Control"] });
  await repoButton("service-worker").click({ modifiers: ["Control"] });
  await sidebar.getByText("2 selected · Drag to a workspace", { exact: true }).waitFor();
  const start = await repoButton("service-api").boundingBox(), end = await destination.boundingBox();
  assert(start && end);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
    await workspaces.locator(".workspace-drop-active").filter({ hasText: "import-backend" }).waitFor();
  } finally { await page.mouse.up(); }
  await page.getByText("2 repositories moved", { exact: true }).waitFor();
  await repoButton("service-api").waitFor({ state: "detached" });
  await page.keyboard.press("Control+z");
  await repoButton("service-api").waitFor();
  await repoButton("service-worker").waitFor();
  await page.getByText("Workspace move undone", { exact: true }).waitFor();

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
    await detach(workspaces.locator("header > b"));
    await page.waitForFunction(() => !!window.__workspacePanelWindow?.document.querySelector(".detached-workspaces .workspace-sidebar"));
    await workspaces.waitFor({ state: "detached" });
    await attach();
    await workspaces.waitFor();

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
    await page.locator(".workspace .graph-scroll .grow.selected").filter({ hasText: "Detached branch target commit" }).waitFor();

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
  await workspaces.getByRole("button", { name: "Hide Workspaces", exact: true }).click();
}
