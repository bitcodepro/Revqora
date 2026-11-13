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
  const waitActive = (name) => page.locator(".topbar .repo-current > b").filter({ hasText: name }).waitFor();
  const open = async (dir) => { await page.evaluate((root) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: [root] }), dir); await waitActive(path.basename(dir)); };
  const library = async (tab) => { await page.getByRole("button", { name: "Repository library", exact: true }).click(); await page.locator(".library-tabs").getByRole("button", { name: tab, exact: true }).click(); };
  const done = () => page.locator(".modal").last().getByRole("button", { name: "Done", exact: true }).click();
  const explorer = page.getByRole("complementary", { name: "Explorer", exact: true });
  const explorerToggle = page.getByRole("button", { name: "Toggle Explorer panel", exact: true });
  const sidebar = page.locator(".repository-slot > .repository-sidebar");
  const group = name => explorer.getByRole("treeitem", { name, exact: true }).and(explorer.locator("[data-tree-group]"));
  const chooseGroup = name => group(name).locator(".repository-select").click();
  const showExplorer = async () => { if (!await explorer.isVisible()) await explorerToggle.click(); };
  const hideExplorer = () => explorer.getByRole("button", { name: "Hide Explorer", exact: true }).click();
  await check("repository favorites and groups retain closed bookmarks and collapse state", async () => {
    // Exercise the opt-out through Settings: these bookmark scenarios
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
    await library("Groups");
    await page.getByLabel("Saved groups", { exact: true }).click({button:"right",position:{x:3,y:3}});
    await page.locator(".ctx-menu").getByText("Create group", { exact: true }).click();
    const groupEditor = page.getByRole("dialog", { name: "New group", exact: true });
    await groupEditor.getByRole("textbox", { name: "Group name", exact: true }).fill("Stage 8 projects");
    await groupEditor.getByRole("button", { name: "Create group", exact: true }).click();
    await page.locator(".library-tabs").getByRole("button", { name: "Repositories", exact: true }).click();
    const groupId = await page.getByLabel("Group for stage8-workspace", { exact: true }).locator("option", { hasText: "Stage 8 projects" }).getAttribute("value");
    await page.getByLabel("Group for stage8-workspace", { exact: true }).selectOption(groupId); await done();
    await page.getByRole("button", { name: "Close stage8-workspace", exact: true }).click();
    // The library remains available even with no open repositories.
    await library("Repositories"); await page.locator(".library-row", { hasText: "stage8-workspace" }).getByRole("button", { name: "Open", exact: true }).click(); await waitActive("stage8-workspace");
    await showExplorer();
    await group("Stage 8 projects").getByRole("button", { name: "Collapse Stage 8 projects", exact: true }).click();
    await page.reload();
    await group("Stage 8 projects").getByRole("button", { name: "Expand Stage 8 projects", exact: true }).click();
    await explorer.getByRole("treeitem", { name: "stage8-workspace", exact: true }).waitFor();
    await waitActive("stage8-workspace");
    if (await explorer.getByRole("button", { name: "Unfavorite stage8-workspace", exact: true }).count() !== 1) throw new Error("Favorite duplicated or was lost");
    await shot("75-repository-library");
    await hideExplorer();
    await repositorySessionSmoke({ page, work, shot, template: second });
  });
  await check("saved workspaces migrate into Explorer and group selection keeps repository tabs and views", async () => {
    const toolsFile = path.join(second, "file.txt");
    fs.appendFileSync(toolsFile, "\nlocal repository changes\n");
    const toolsContents = fs.readFileSync(toolsFile);
    await open(second);
    await page.locator(".history-mode").getByRole("button", { name: "Columns", exact: true }).click();
    await page.evaluate(({ root, second }) => {
      const key = "revqora.repositories";
      const legacy = JSON.parse(localStorage.getItem(key));
      legacy.version = 1;
      delete legacy.state.activeGroupId;
      legacy.state.workspaces = [
        { id: "legacy-projects", name: "Legacy projects", roots: [root] },
        { id: "legacy-tools", parentId: "legacy-projects", name: "Legacy tools", roots: [second] },
      ];
      legacy.state.favoriteWorkspaceIds = ["legacy-tools"];
      legacy.state.activeWorkspaceId = "legacy-tools";
      localStorage.setItem(key, JSON.stringify(legacy));
    }, { root, second });
    await page.reload();
    await waitActive("stage8-tools");
    await showExplorer();
    await group("Legacy tools").locator(".repository-select[aria-current=true]").waitFor();
    await group("Legacy tools").getByRole("button", { name: "Unfavorite group Legacy tools", exact: true }).waitFor();
    const flatRows = sidebar.locator(".repository-label");
    await flatRows.getByText("stage8-tools", { exact: true }).waitFor();
    if (await flatRows.count() !== 1) throw new Error("The migrated child group should only show its own repository");
    const savedTabs = () => page.evaluate(() => JSON.parse(localStorage.getItem("revqora.settings")).state.openTabs);
    const before = await savedTabs();
    await chooseGroup("Legacy projects");
    await flatRows.getByText("stage8-workspace", { exact: true }).waitFor();
    if (await flatRows.count() !== 2) throw new Error("The parent group's flat list omitted a descendant or duplicated a repository");
    await chooseGroup("Legacy tools");
    await chooseGroup("Legacy projects");
    await chooseGroup("Legacy tools");
    if (JSON.stringify(await savedTabs()) !== JSON.stringify(before)) throw new Error("Filtering groups changed the open repository session");
    if (await page.locator(".history-mode button.on").innerText() !== "Columns") throw new Error("Filtering groups changed the history layout");
    if (!fs.readFileSync(toolsFile).equals(toolsContents) || git(second, "branch", "--show-current") !== "main") {
      throw new Error("Filtering groups changed repository files or branch");
    }
    await shot("76-explorer-migration");
    await explorer.getByRole("button", { name: "All repositories", exact: true }).click();
    await hideExplorer();
    await open(root);
  });
  await check("Sync reviews exact incoming revisions and requires opt-in before publishing outgoing commits", async () => {
    const localTip = git(root, "rev-parse", "HEAD");
    for (let i = 1; i < 12; i++) git(peer, "commit", "--allow-empty", "-qm", `workspace fetched ${i}`);
    const fetchedTip = commit(peer, "workspace fetched tip");
    git(peer, "push", "origin", "main");
    await page.locator(".view-tab").getByText("History", { exact: true }).click();
    const layouts = page.locator(".history-mode");
    const originalLayout = (await layouts.locator("button.on").innerText()).trim();
    const historyScope = page.getByRole("combobox", { name: "History scope", exact: true });
    if (await historyScope.inputValue() !== "HEAD") throw new Error("History did not default to the current branch");
    await page.locator(".toolbar").getByTitle("Fetch all remotes", { exact: true }).click();
    const pendingPull = page.getByText("12 incoming · Pull to apply", { exact: true });
    await pendingPull.waitFor();
    if (git(root, "rev-parse", "HEAD") !== localTip || git(root, "rev-parse", "origin/main") !== fetchedTip) {
      throw new Error("Fetch must update the remote-tracking ref while leaving HEAD unchanged");
    }
    const rows = page.locator(".graph-rows");
    const fetchedRow = rows.getByText("workspace fetched tip", { exact: true });
    const incomingRows = rows.locator(".grow.incoming");
    const incomingToggle = page.getByRole("button", { name: "Show incoming commits", exact: true });
    for (const layout of ["Graph", "Review", "Columns"]) {
      await layouts.getByRole("button", { name: layout, exact: true }).click();
      await rows.getByText("workspace base", { exact: true }).waitFor();
      await incomingRows.getByText("workspace fetched tip", { exact: true }).waitFor();
    }
    await fetchedRow.click();
    const preview = page.locator(".commit-preview");
    await preview.locator(".diff .dl").first().waitFor();
    await preview.getByRole("button", { name: "Close", exact: true }).click();
    await incomingToggle.click();
    await fetchedRow.waitFor({ state: "detached" });
    await layouts.getByRole("button", { name: "Graph", exact: true }).click();
    await rows.getByText("workspace base", { exact: true }).waitFor();
    if (await fetchedRow.count() || await incomingToggle.getAttribute("aria-pressed") !== "false") {
      throw new Error("Hiding incoming commits did not carry across layouts");
    }
    await pendingPull.waitFor();
    await historyScope.selectOption("refs/remotes/origin/main");
    await fetchedRow.waitFor();
    await historyScope.selectOption("HEAD");
    await fetchedRow.waitFor({ state: "detached" });
    await incomingToggle.click();
    await incomingRows.getByText("workspace fetched tip", { exact: true }).waitFor();
    await page.locator(".toolbar").getByTitle("Pull", { exact: true }).click();
    await incomingRows.first().waitFor({ state: "detached", timeout: syncTimeout });
    await fetchedRow.waitFor();
    await pendingPull.waitFor({ state: "detached" });
    if (git(root, "rev-parse", "HEAD") !== fetchedTip) throw new Error("Pull did not update the local branch");
    await layouts.getByRole("button", { name: originalLayout, exact: true }).click();

    const incoming = commit(peer, "workspace incoming"); git(peer, "push", "origin", "main");
    await page.locator(".toolbar").getByRole("button", { name: "Sync", exact: true }).click(); await page.waitForSelector(".modal:has-text('Review Sync')");
    if (!await page.getByRole("checkbox", { name: "Receive 1", exact: true }).isChecked()) throw new Error("incoming revision not selected");
    await shot("77-sync-review"); await page.getByRole("button", { name: "Sync selected (1)", exact: true }).click(); await page.waitForSelector(".modal:has-text('Sync results')", { timeout: syncTimeout });
    if (git(root, "rev-parse", "HEAD") !== incoming || !(await page.locator(".modal").innerText()).includes("Incoming commits received")) throw new Error("incoming Sync failed"); await done();
    const outgoing = commit(root, "workspace outgoing"); await page.getByRole("button", { name: "Refresh", exact: true }).click();
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
