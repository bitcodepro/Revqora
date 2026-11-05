import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";

/** Real Pull, not mocked IPC: verify protection, inspection, and explicit retry. */
export async function ignoredPullSmoke({ page, work, returnRoot, shot }) {
  const remote = path.join(work, "ignored-pull-remote"), root = path.join(work, "ignored-pull-local");
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const open = async (root) => {
    await page.evaluate(root => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: [root] }), root);
    await page.waitForFunction(root => document.querySelector(".repo-current")?.title === root && !!document.querySelector(".history-mode"), root);
  };
  fs.mkdirSync(remote);
  git(remote, "init", "-q", "-b", "main");
  git(remote, "config", "user.name", "Ignored Pull Fixture"); git(remote, "config", "user.email", "fixture@example.com");
  fs.writeFileSync(path.join(remote, ".gitignore"), "personal.local\n");
  git(remote, "add", "."); git(remote, "commit", "-qm", "base");
  git(remote, "clone", "-q", remote, root);
  // Pull runs in the application process, outside this helper's -c overrides.
  // Persist the fixture policy before the application checks out incoming files.
  git(root, "config", "core.autocrlf", "false");
  if (git(root, "config", "--local", "--get", "core.autocrlf") !== "false") throw Error("Ignored Pull fixture did not persist its line-ending policy");
  fs.writeFileSync(path.join(remote, "personal.local"), "versioned defaults\n");
  git(remote, "add", "-f", "personal.local"); git(remote, "commit", "-qm", "publish defaults");
  const target = git(remote, "rev-parse", "HEAD"), before = git(root, "rev-parse", "HEAD"), index = fs.readFileSync(path.join(root, ".git", "index"));
  fs.writeFileSync(path.join(root, "personal.local"), "irreplaceable local settings\n");
  try {
    await open(root);
    await page.getByRole("button", { name: "Pull", exact: true }).click();
    const dialog = page.locator(".modal").filter({ hasText: "Pull stopped to protect local files" });
    await dialog.waitFor();
    const text = (await dialog.innerText()).replace(/\\/g, "/");
    if (!await dialog.getByText("Incoming path", { exact: true }).count() || !text.includes(path.join(root, "personal.local").replace(/\\/g, "/"))) throw Error("Pull recovery omitted the conflicting path");
    if (git(root, "rev-parse", "HEAD") !== before || !fs.readFileSync(path.join(root, ".git", "index")).equals(index)) throw Error("Blocked Pull changed HEAD or index");
    if (fs.readFileSync(path.join(root, "personal.local"), "utf8") !== "irreplaceable local settings\n") throw Error("Blocked Pull overwrote ignored data");
    await shot?.("pull-ignored-recovery");
    await dialog.getByRole("button", { name: "Inspect ignored files…", exact: true }).click();
    const ignored = page.locator(".modal").filter({ hasText: "Ignored files & folders" });
    await ignored.locator(".file-row").filter({ hasText: "personal.local" }).waitFor();
    await ignored.getByRole("button", { name: "Close", exact: true }).click();
    const backup = path.join(work, "personal.local.backup");
    fs.renameSync(path.join(root, "personal.local"), backup);
    await dialog.getByRole("button", { name: "Retry Pull", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    // Poll the actual ref without accepting a toast as evidence of completion.
    const deadline = Date.now() + 60000;
    while (git(root, "rev-parse", "HEAD") !== target && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (git(root, "rev-parse", "HEAD") !== target) throw Error("Explicit Retry Pull did not update HEAD");
    if (fs.readFileSync(backup, "utf8") !== "irreplaceable local settings\n" || fs.readFileSync(path.join(root, "personal.local"), "utf8") !== "versioned defaults\n") throw Error("Retry did not preserve the backup and install incoming content");
  } finally {
    await open(returnRoot);
    await page.getByRole("button", { name: "Close ignored-pull-local", exact: true }).click();
  }
}
