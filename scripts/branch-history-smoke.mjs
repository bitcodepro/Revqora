import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { openRepository } from "./ui-readiness.mjs";
import { interceptClipboard } from "./name-path-copy-smoke.mjs";

export async function branchHistorySmoke({ page, work, returnRoot }) {
  const root = path.join(work, "branch-history");
  const other = path.join(work, "branch-history-other");
  const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
  const put = (repo, file, text) => fs.writeFileSync(path.join(repo, file), `${text}\n`);
  for (const repo of [root, other]) {
    fs.mkdirSync(repo);
    git(repo, "init", "-qb", "main");
    for (const [key, value] of [["user.name", "History Fixture"], ["user.email", "fixture@example.test"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"], ["core.hooksPath", ".git/hooks"]]) git(repo, "config", key, value);
    put(repo, "file.txt", "base");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", `Shared searchable ${path.basename(repo)}`);
  }
  const base = git(root, "rev-parse", "HEAD");
  const records = Array.from({ length: 100 }, (_, i) => {
    const message = `History line ${i}\n`;
    return `commit refs/heads/main\ncommitter History Fixture <fixture@example.test> ${1700000000 + 2 * i} +0000\ndata ${Buffer.byteLength(message)}\n${message}${i ? "" : `from ${base}\n`}\n`;
  });
  execFileSync("git", ["-C", root, "fast-import", "--quiet"], { input: records.join("") });
  git(root, "switch", "-qc", "target", base);
  put(root, "file.txt", "destination");
  // Interleave this commit so the pinned line passes through another lane's row.
  const targetDate = "1700000197 +0000";
  execFileSync("git", ["-C", root, "commit", "-qam", "Destination change"], {
    env: { ...process.env, GIT_AUTHOR_DATE: targetDate, GIT_COMMITTER_DATE: targetDate },
  });
  git(root, "switch", "-q", "main");
  git(root, "config", "user.email", "current-user@example.test");
  for (const suffix of ["a", "b"]) {
    git(other, "switch", "-qc", `review-${suffix}`, "main");
    put(other, `picked-${suffix}.txt`, suffix);
    git(other, "add", ".");
    const authorDate = suffix === "a" ? "2024-02-02T12:00:00Z" : "2024-02-01T12:00:00Z";
    const committerDate = suffix === "a" ? "2024-03-01T12:00:00Z" : "2024-03-02T12:00:00Z";
    execFileSync("git", ["-C", other, "commit", "--date", authorDate, "-qm", `Pick review-${suffix}`], {
      env: { ...process.env, GIT_COMMITTER_DATE: committerDate },
    });
  }
  git(other, "switch", "-q", "main");
  for (const suffix of ["c", "d"]) git(other, "branch", `review-${suffix}`);

  const active = (name) => page.locator(".topbar .repo-current > b").getByText(name, { exact: true }).waitFor();
  const branchRow = (name) => page.locator(`.sidebar [data-branch-kind="local"][data-branch-name="${name}"]`);
  const branch = (name) => branchRow(name).dblclick();
  const waitBranch = async (name) => {
    await page.locator(`.sidebar [data-branch-kind="local"][data-branch-name="${name}"].current`).waitFor();
    await page.locator(".busy-item").filter({ hasText: /Switching branch|Stashing and switching|Moving changes/ }).waitFor({ state: "detached" });
  };
  await openRepository(page, other);
  await openRepository(page, root);
  await page.locator(".view-tab").filter({ hasText: "History" }).click();
  await page.locator(".history-mode").getByRole("button", { name: "Graph", exact: true }).click();
  await page.getByRole("combobox", { name: "History scope", exact: true }).selectOption("");
  const toggle = page.getByRole("button", { name: "Toggle branches panel", exact: true });
  const showBranches = async () => { if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click(); };
  await showBranches();
  const graph = page.locator(".graph-scroll");
  // The previous scope can still render while the All branches graph loads.
  const crossing = graph.locator(".grow").filter({ has: page.getByText("Destination change", { exact: true }) });
  await crossing.waitFor();
  const tip = graph.locator(".grow").filter({ has: page.getByText("History line 99", { exact: true }) });
  const line = tip.locator(".lane-hit").last();
  const point = await line.evaluate((path) => {
    // This point on the line also lies within the HEAD marker.
    const point = path.getPointAtLength(path.getTotalLength() * 0.5).matrixTransform(path.getScreenCTM());
    return { x: point.x, y: point.y };
  });
  const preview = page.locator(".commit-preview");
  await page.mouse.click(point.x, point.y);
  assert.equal(await preview.count(), 0, "Clicking the graph must not open the commit preview");
  await page.waitForFunction(() => document.querySelector(".graph-scroll")?.hasAttribute("data-pinned-lane"));
  const pinned = await graph.getAttribute("data-pinned-lane");
  assert.equal(pinned, await line.getAttribute("data-lane"), "Clicking the line must pin its identity");
  const members = graph.locator(".grow.lane-member");
  await members.getByText("History line 99", { exact: true }).waitFor();
  await crossing.locator(".lane-line.hl").first().waitFor({ state: "attached" });
  assert.equal(await members.getByText("Destination change", { exact: true }).count(), 0, "A passing line must not highlight another lane's commit");
  await page.getByRole("button", { name: "Search all repositories", exact: true }).hover();
  const rowHeight = await tip.evaluate(row => row.getBoundingClientRect().height);
  await graph.evaluate((el, height) => { el.scrollTop = 46 * height; }, rowHeight);
  await page.waitForFunction(lane => {
    const viewport = document.querySelector(".graph-scroll");
    if (!viewport || viewport.getAttribute("data-pinned-lane") !== lane) return false;
    const bounds = viewport.getBoundingClientRect();
    return [...viewport.querySelectorAll(".grow.lane-member")].some(row => {
      if (!/^History line [45]\d$/.test(row.querySelector(".g-subject .text")?.textContent ?? "")) return false;
      const rect = row.getBoundingClientRect();
      if (rect.top >= bounds.bottom || rect.bottom <= bounds.top) return false;
      return [...row.querySelectorAll(".lane-line.hl + .lane-hit")].some(segment => segment.getAttribute("data-lane") === lane);
    });
  }, pinned).catch(async error => {
    const state = await graph.evaluate(el => ({
      top: el.scrollTop,
      height: el.clientHeight,
      pin: el.getAttribute("data-pinned-lane"),
      members: el.querySelectorAll(".grow.lane-member").length,
      highlighted: [...el.querySelectorAll(".lane-line.hl + .lane-hit")].map(segment => segment.getAttribute("data-lane")),
    }), undefined, { timeout: 3000 }).catch(() => null);
    throw new Error(`Expected visible segments for lane ${pinned} after scrolling; graph state: ${JSON.stringify(state)}`, { cause: error });
  });
  assert.equal(await graph.getAttribute("data-pinned-lane"), pinned);
  git(root, "commit", "--allow-empty", "-qm", "Advance pinned history line");
  await page.getByTitle("Refresh (F5)", { exact: true }).click();
  await graph.evaluate((el) => { el.scrollTop = 0; });
  const advanced = graph.locator(".grow").filter({ has: page.getByText("Advance pinned history line", { exact: true }) });
  const highlighted = advanced.locator(".lane-line.hl + .lane-hit").first();
  await highlighted.waitFor({ state: "attached" });
  const remapped = await highlighted.getAttribute("data-lane");
  assert.notEqual(remapped, pinned, "Advancing the tip should change the layout ID in this fixture");
  assert.equal(await graph.getAttribute("data-pinned-lane"), remapped);
  await members.getByText("Advance pinned history line", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear line highlight", exact: true }).click();
  assert.equal(await graph.getAttribute("data-pinned-lane"), null);
  assert.equal(await members.count(), 0);
  await advanced.locator(".g-subject .text").click();
  await preview.getByText("Advance pinned history line", { exact: true }).waitFor();
  await preview.getByRole("button", { name: "Close", exact: true }).click();

  const viewedBranch = branchRow("target");
  await branchRow("main").click({button:"right"});
  await page.locator(".ctx-menu").getByText("Set as primary branch", {exact:true}).click();
  const pinnedBranch = page.getByRole("group", {name:"Primary branch",exact:true}).locator('[data-branch-name="main"]');
  const branchSearch = page.getByPlaceholder("Filter branches, tags, stashes");
  const myBranches = page.getByRole("button", {name:"My branches",exact:true});
  if (await myBranches.getAttribute("aria-pressed") !== "true") await myBranches.click();
  assert.equal(await myBranches.getAttribute("aria-pressed"), "true");
  await viewedBranch.waitFor({state:"detached"});
  await pinnedBranch.waitFor();
  await branchSearch.fill("no-matching-branches");
  await pinnedBranch.waitFor();
  assert.equal(await branchRow("main").count(), 1);
  await branchSearch.clear();
  await myBranches.click();
  await page.locator(".sidebar .branches-heading").click({button:"right"});
  await page.locator(".ctx-menu").getByText("Branch manager",{exact:true}).click();
  const manager = page.locator(".branch-manager");
  const primaryInManager = manager.locator('[data-branch-ref="refs/heads/main"]');
  await primaryInManager.waitFor();
  await manager.getByRole("button",{name:"My branches",exact:true}).click();
  await manager.getByRole("textbox",{name:"Search branches",exact:true}).fill("no-matching-branches");
  await primaryInManager.getByText("· Primary",{exact:true}).waitFor();
  assert(await manager.getByRole("button",{name:"Select filtered (up to 50)",exact:true}).isDisabled());
  await manager.getByRole("button",{name:"Close branch manager",exact:true}).click();
  const historyScope = page.getByRole("combobox", {name:"History scope",exact:true});
  for (const mode of ["Graph", "Review", "Columns"]) {
    await page.locator(".history-mode").getByRole("button", { name: mode, exact: true }).click();
    await showBranches();
    // Select a different branch first so a previously rendered highlight cannot satisfy the check.
    await branchRow("main").click();
    await graph.locator(".grow.branch-member").getByText("Advance pinned history line", { exact: true }).waitFor({ state: "attached" });
    await viewedBranch.click();
    await page.locator('.sidebar [data-branch-name="target"].viewed-branch').waitFor();
    await branchRow("main").and(page.locator(".current")).waitFor();
    assert.equal(await historyScope.inputValue(), "branch-context");
    await graph.locator(".grow.branch-member").getByText("Destination change", { exact: true }).waitFor({ state: "attached" });
    await graph.locator(".grow.branch-background").getByText("Advance pinned history line", {exact:true}).waitFor({state:"attached"});
    await graph.locator('.ref[data-branch-mark="base"]').getByText("main", {exact:true}).waitFor({state:"attached"});
    await page.getByText("Primary · main", {exact:true}).waitFor();
    assert.equal(await graph.locator(".grow.branch-member").getByText("History line 98", { exact: true }).count(), 0);
    assert.equal(await preview.count(), 0, `Selecting a branch in ${mode} must leave commit details closed`);
  }
  await page.locator(".history-mode").getByRole("button", { name: "Graph", exact: true }).click();
  await showBranches();
  await historyScope.selectOption("");
  await graph.locator(".grow.branch-member, .grow.branch-background").first().waitFor({state:"detached"});
  assert.equal(await graph.locator("[data-branch-mark]").count(), 0);
  await historyScope.selectOption("refs/heads/target");
  await graph.getByText("Advance pinned history line", {exact:true}).waitFor({state:"detached"});
  await graph.getByText("Destination change", {exact:true}).waitFor({state:"attached"});
  await viewedBranch.click();
  await graph.locator(".grow.branch-member").getByText("Destination change", { exact: true }).click();
  assert.equal(git(root, "branch", "--show-current"), "main");
  await preview.getByText("Destination change", { exact: true }).waitFor();
  await preview.getByRole("button", { name: "Close", exact: true }).click();

  // The currently checked-out branch has the same Compare entry as any other branch.
  await page.locator('.sidebar [data-branch-kind="local"][data-branch-name="main"]').click({ button: "right" });
  await page.locator(".ctx-menu").getByText("Compare branch commits…", { exact: true }).click();
  const comparison = page.getByRole("dialog").filter({ hasText: "Compare branch commits" });
  assert.equal(await comparison.getByLabel("Branch A").inputValue(), "refs/heads/main");
  await comparison.getByLabel("Compare with").selectOption("refs/heads/target");
  await comparison.getByRole("button", { name: "Compare", exact: true }).click();
  const mainOnly = comparison.getByRole("region", { name: "Only in main", exact: true });
  const targetOnly = comparison.getByRole("region", { name: "Only in target", exact: true });
  const destination = targetOnly.locator("article").filter({ hasText: "Destination change" });
  await destination.waitFor();
  assert.equal(await destination.locator("time").getAttribute("datetime"), new Date(Number(git(root, "show", "-s", "--format=%at", "target")) * 1000).toISOString());
  await interceptClipboard(page);
  try {
    await destination.getByRole("button", { name: /^Copy SHA / }).click();
    await page.waitForFunction((oid) => window.__namePathCopies.at(-1) === oid, git(root, "rev-parse", "target"));
  } finally { await page.evaluate(() => window.__restoreNamePathClipboard()); }
  await mainOnly.getByRole("button", { name: "Load more (50 of 101)", exact: true }).click();
  await mainOnly.getByRole("button", { name: "Load more (100 of 101)", exact: true }).click();
  await mainOnly.getByText("History line 0", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await mainOnly.locator("article").count(), 101);
  assert.equal(await targetOnly.locator("article").count(), 1);
  assert.equal(await comparison.getByText(/Shared searchable/).count(), 0);
  await comparison.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(git(root, "branch", "--show-current"), "main");

  const localQuery = page.getByPlaceholder(/^Search commits/);
  await localQuery.fill("History line 99");
  await page.locator(".search-box .count").getByText("1 / 1", { exact: true }).waitFor();
  await page.getByTitle("Show only matching commits", { exact: true }).click();
  assert.equal(await graph.locator(".grow").count(), 1);
  await page.getByRole("button", { name: "Search all repositories", exact: true }).click();
  const search = page.getByRole("dialog").filter({ hasText: "Search all repositories" });
  const searchQuery = search.getByRole("textbox", { name: "Search commits across repositories" });
  const searchMode = search.getByRole("combobox", { name: "What to search across repositories" });
  const hasRoomForQuery = await search.locator(".workspace-search-controls").evaluate(controls => {
    const query = controls.querySelector("input").getBoundingClientRect();
    const mode = controls.querySelector("select").getBoundingClientRect();
    return query.width > mode.width && query.right < mode.left;
  });
  assert(hasRoomForQuery, "The workspace search field must have room for text without overlapping the filter");
  await searchMode.selectOption("message");
  await searchQuery.click();
  await searchQuery.fill("shared searchable");
  for (const name of ["branch-history", "branch-history-other"]) await search.getByRole("heading", { name, exact: true }).waitFor();
  const matchingCommit = search.getByRole("button", { name: /^Shared searchable branch-history / });
  assert.equal(await matchingCommit.locator("mark").textContent(), "Shared searchable");
  await matchingCommit.click();
  const selected = graph.locator(".grow.selected").filter({ has: page.getByText("Shared searchable branch-history", { exact: true }) });
  await selected.waitFor();
  await page.waitForFunction(() => {
    const row = document.querySelector(".graph-scroll .grow.selected");
    const graph = row?.closest(".graph-scroll");
    if (!row || !graph) return false;
    const visible = graph.getBoundingClientRect(), bounds = row.getBoundingClientRect();
    return bounds.top < visible.bottom && bounds.bottom > visible.top;
  });
  assert.equal(await localQuery.inputValue(), "");
  assert(!await page.getByTitle("Show only matching commits", { exact: true }).evaluate((button) => button.classList.contains("active")));

  await page.getByRole("button", { name: "Search all repositories", exact: true }).click();
  await searchMode.selectOption("message");
  await searchQuery.fill("pick review-");
  const orderedHits = search.locator(".workspace-search-group")
    .filter({ has: page.getByRole("heading", { name: "branch-history-other", exact: true }) })
    .locator(".workspace-search-hit > b");
  await orderedHits.nth(1).waitFor();
  assert.deepEqual(await orderedHits.allTextContents(), ["Pick review-a", "Pick review-b"]);
  await search.getByRole("textbox", { name: "Search commits across repositories" }).fill("shared searchable");
  await search.getByRole("button", { name: /Shared searchable branch-history-other/ }).click();
  await active("branch-history-other");
  await page.locator(".commit-preview").getByText("Shared searchable branch-history-other", { exact: true }).waitFor();

  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const sidebar = page.locator(".sidebar");
  const reviewRow = (suffix) => sidebar.locator(`[data-branch-kind="local"][data-branch-name="review-${suffix}"]`);
  await reviewRow("a").click({ button: "right" });
  await page.locator(".ctx-menu").getByText("Compare branch commits…", { exact: true }).click();
  await comparison.getByLabel("Compare with").selectOption("refs/heads/review-b");
  await comparison.getByRole("button", { name: "Compare", exact: true }).click();
  const aColumn = comparison.getByRole("region", { name: "Only in review-a", exact: true });
  const bColumn = comparison.getByRole("region", { name: "Only in review-b", exact: true });
  const dialogFor = (name) => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const applyPick = async (suffix) => {
    const confirm = dialogFor(`Cherry-pick into review-${suffix}?`);
    await confirm.getByText(`Revqora will switch to review-${suffix} and apply this commit locally.`).waitFor();
    await confirm.getByRole("button", { name: "Cherry-pick", exact: true }).click();
    await sidebar.locator(`[data-branch-name="review-${suffix}"].current`).waitFor();
  };
  await aColumn.getByText("Pick review-a", { exact: true }).click({ button: "right" });
  await page.locator(".ctx-menu").getByText("Cherry-pick into review-b…", { exact: true }).click();
  await applyPick("b");
  // The comparison reloads from the updated tip after applying the commit.
  await bColumn.getByText("Pick review-a", { exact: true }).waitFor();
  assert.equal(git(other, "show", "review-b:picked-a.txt"), "a");

  const dragged = bColumn.getByText("Pick review-b", { exact: true });
  await dragged.scrollIntoViewIfNeeded();
  const start = await dragged.boundingBox();
  const end = await aColumn.locator("header").boundingBox();
  assert(start && end);
  await page.mouse.move(start.x + 10, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
  await aColumn.locator("xpath=self::*[@data-cherry-pick-drop]").waitFor();
  await page.mouse.up();
  await applyPick("a");
  await aColumn.getByText("Pick review-b", { exact: true }).waitFor();
  assert.equal(git(other, "show", "review-a:picked-b.txt"), "b");
  await comparison.getByRole("button", { name: "Close", exact: true }).click();

  await reviewRow("b").and(sidebar.locator('[title*="Pick review-a"]')).waitFor();
  await sidebar.getByLabel("Branch list order").selectOption("name");
  await reviewRow("b").click();
  await reviewRow("b").press("Delete");
  const single = dialogFor("Delete branch review-b?");
  await single.getByRole("button", { name: "Cancel", exact: true }).click();
  const toggleSelection = (row) => row.click({ modifiers: ["Control", "Shift"] });
  await toggleSelection(reviewRow("d"));
  await sidebar.getByText("2 selected", { exact: true }).waitFor();
  assert.deepEqual(await sidebar.locator(".branch-selected").evaluateAll(rows => rows.map(row => row.dataset.branchName)), ["review-b", "review-d"]);
  await reviewRow("b").click({ modifiers: ["Shift"] });
  await sidebar.getByText("3 selected", { exact: true }).waitFor();
  await toggleSelection(reviewRow("c"));
  await sidebar.getByText("2 selected", { exact: true }).waitFor();
  await toggleSelection(reviewRow("c"));
  await sidebar.getByText("3 selected", { exact: true }).waitFor();
  assert.equal(git(other, "branch", "--show-current"), "review-a");
  await sidebar.getByRole("button", { name: "Delete…", exact: true }).click();
  const cleanup = dialogFor("Review branch cleanup");
  await cleanup.getByRole("checkbox", { name: "Create recovery checkpoint" }).uncheck();
  await cleanup.getByRole("button", { name: "Delete 3 selected", exact: true }).click();
  await dialogFor("Branch cleanup results").getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(git(other, "branch", "--list", "review-b", "review-c", "review-d"), "");

  await openRepository(page, root);
  await active("branch-history");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await branchRow("main").click();
  await graph.locator(".grow.branch-member").getByText("Advance pinned history line", { exact: true }).click();
  await preview.waitFor();
  await branchRow("target").click({ modifiers: ["Control"] });
  await waitBranch("target");
  await preview.waitFor({ state: "detached" });
  assert.equal(git(root, "branch", "--show-current"), "target");
  await branchRow("main").click({ modifiers: ["Control"] });
  await waitBranch("main");
  assert.equal(await preview.count(), 0);
  put(root, "file.txt", "staged");
  git(root, "add", "file.txt");
  put(root, "file.txt", "working");
  put(root, "untracked.txt", "new");
  const dialog = page.getByRole("dialog").filter({ hasText: "Switch with uncommitted changes" });
  await branch("target");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(git(root, "branch", "--show-current"), "main");
  assert.equal(git(root, "stash", "list"), "");
  await branch("target");
  await dialog.getByRole("button", { name: "Stash and switch", exact: true }).click();
  await waitBranch("target");
  await preview.waitFor({ state: "detached" });
  assert.equal(git(root, "status", "--porcelain"), "");
  await branch("main");
  await waitBranch("main");
  const restore = page.getByRole("button", { name: "Restore stash", exact: true });
  await restore.click();
  await restore.waitFor({ state: "detached" });
  assert.equal(git(root, "show", ":file.txt"), "staged");
  assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "working\n");
  assert.equal(fs.readFileSync(path.join(root, "untracked.txt"), "utf8"), "new\n");

  git(root, "reset", "--hard");
  fs.unlinkSync(path.join(root, "untracked.txt"));
  put(root, "file.txt", "conflicting local change");
  await branch("target");
  await dialog.getByRole("button", { name: "Move changes", exact: true }).click();
  await waitBranch("target");
  await page.locator(".changes").waitFor();
  assert(git(root, "status", "--porcelain").includes("UU file.txt"));
  assert(git(root, "stash", "list").includes("Revqora switch refs/heads/main"));
  await openRepository(page, returnRoot);
  for (const name of ["branch-history", "branch-history-other"]) await page.getByRole("button", { name: `Close ${name}`, exact: true }).click();
  console.log("Verified pinned graph lines, grouped repository search, branch comparison and cherry-pick, branch multiselection and cleanup, stash/restore and move conflicts");
}
