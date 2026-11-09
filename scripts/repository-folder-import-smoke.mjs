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
  for (const repo of ["import-direct", "import-direct/nested-repo", "import-backend/service-api", "import-backend/tools/service-worker", "import-frontend/web-ui"]) {
    init(repo);
  }
  const workingFile = path.join(parent, "import-backend", "service-api", "local.txt");
  fs.writeFileSync(workingFile, "uncommitted work\n");
  const sidebar = page.locator(".repository-sidebar");
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

  let dialog = await preview(4);
  await dialog.getByText("Workspace · import-backend", { exact: true }).waitFor();
  await dialog.getByText("Workspace · import-frontend", { exact: true }).waitFor();
  await dialog.getByText(path.join("import-backend", "tools", "service-worker"), { exact: true }).waitFor();
  assert.equal(await dialog.getByText("nested-repo", { exact: true }).count(), 0);
  await dialog.getByRole("checkbox", { name: /^service-worker\b/ }).uncheck();
  await shot?.("repository-folder-import-preview");
  await confirm(dialog, 3);
  for (const name of ["import-direct", "service-api", "web-ui"]) await repoInOverview(name).waitFor();
  assert.equal(await repoInOverview("service-worker").count(), 0);
  const backendId = await workspaceId("import-backend");
  assert(backendId);
  await picker.selectOption(backendId);
  await overview.waitFor({ state: "detached" });
  await sidebar.getByText("service-api", { exact: true }).waitFor();
  assert.equal(await sidebar.getByText("web-ui", { exact: true }).count(), 0);

  dialog = await preview(4);
  await confirm(dialog, 4);
  await repoInOverview("service-worker").waitFor();
  assert.equal(await picker.locator("option").getByText("import-backend", { exact: true }).count(), 1);
  assert.equal(await workspaceId("import-backend"), backendId);
  await picker.selectOption(backendId);
  await overview.waitFor({ state: "detached" });
  await sidebar.getByText("service-worker", { exact: true }).waitFor();
  await sidebar.getByText("service-api", { exact: true }).waitFor();

  init("flat-import/flat-group/flat-repo");
  dialog = await preview(1, path.join(parent, "flat-import"));
  await dialog.getByRole("checkbox", { name: "Create Workspaces from subfolders", exact: true }).uncheck();
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
  for (const relative of ["import-backend/service-api", "import-backend/tools/service-worker", "import-frontend/web-ui"]) {
    assert(fs.existsSync(path.join(parent, relative, ".git")), "Moving workspace membership changed the Git folder");
  }
  assert.equal(fs.readFileSync(workingFile, "utf8"), "uncommitted work\n");
}
