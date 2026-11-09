import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { openRepository } from "./ui-readiness.mjs";

export async function branchHistorySmoke({ page, work, returnRoot }) {
  const root = path.join(work, "branch-history");
  const other = path.join(work, "branch-history-other");
  const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
  const put = (repo, file, text) => fs.writeFileSync(path.join(repo, file), `${text}\n`);
  for (const repo of [root, other]) {
    fs.mkdirSync(repo);
    git(repo, "init", "-qb", "main");
    for (const [key, value] of [["user.name", "History Fixture"], ["user.email", "fixture@example.test"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) git(repo, "config", key, value);
    put(repo, "file.txt", "base");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", `Shared searchable ${path.basename(repo)}`);
  }
  const base = git(root, "rev-parse", "HEAD");
  const records = Array.from({ length: 100 }, (_, i) => {
    const message = `History line ${i}\n`;
    return `commit refs/heads/main\ncommitter History Fixture <fixture@example.test> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}${i ? "" : `from ${base}\n`}\n`;
  });
  execFileSync("git", ["-C", root, "fast-import", "--quiet"], { input: records.join("") });
  git(root, "switch", "-qc", "target");
  put(root, "file.txt", "destination");
  git(root, "commit", "-qam", "Destination change");
  git(root, "switch", "-q", "main");

  const active = (name) => page.locator(".topbar .repo-current > b").getByText(name, { exact: true }).waitFor();
  const branch = (name) => page.locator(`.sidebar [data-branch-kind="local"][data-branch-name="${name}"]`).dblclick();
  const waitBranch = async (name) => {
    await page.locator(`.sidebar [data-branch-kind="local"][data-branch-name="${name}"].current`).waitFor();
    await page.locator(".busy-item").filter({ hasText: /Switching branch|Stashing and switching|Moving changes/ }).waitFor({ state: "detached" });
  };
  await openRepository(page, other);
  await openRepository(page, root);
  await page.locator(".view-tab").filter({ hasText: "History" }).click();
  await page.locator(".history-mode").getByRole("button", { name: "Graph", exact: true }).click();
  const graph = page.locator(".graph-scroll");
  const line = graph.locator(".lane-hit").first();
  const point = await line.evaluate((path) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM());
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  const pinned = await graph.getAttribute("data-pinned-lane");
  assert(pinned !== null, "Clicking the line must pin its identity");
  await page.getByRole("button", { name: "Search all repositories", exact: true }).hover();
  await graph.evaluate((el) => { el.scrollTop = 1400; });
  await graph.locator(".grow").getByText(/History line [45]\d/).first().waitFor();
  assert.equal(await graph.getAttribute("data-pinned-lane"), pinned);
  assert(await graph.locator(".lane-line.hl").count(), "Newly visible segments must still be highlighted");
  await page.getByRole("button", { name: "Clear line highlight", exact: true }).click();
  assert.equal(await graph.getAttribute("data-pinned-lane"), null);

  await page.getByRole("button", { name: "Search all repositories", exact: true }).click();
  const search = page.getByRole("dialog").filter({ hasText: "Search all repositories" });
  await search.getByRole("textbox", { name: "Search commits across repositories" }).fill("shared searchable");
  for (const name of ["branch-history", "branch-history-other"]) await search.getByRole("heading", { name, exact: true }).waitFor();
  await search.getByRole("button", { name: /Shared searchable branch-history-other/ }).click();
  await active("branch-history-other");
  await page.locator(".commit-preview").getByText("Shared searchable branch-history-other", { exact: true }).waitFor();

  await openRepository(page, root);
  await active("branch-history");
  const toggle = page.getByTitle("Toggle branches panel", { exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
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
  console.log("Verified pinned graph lines, grouped cross-repository search, stash/restore and move conflicts in the destination branch");
}
