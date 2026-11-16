import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { openRepository } from "./ui-readiness.mjs";

/** Real Pull, not mocked IPC: verify protection, inspection, and explicit retry. */
export async function ignoredPullSmoke({ page, work, returnRoot, shot }) {
  const remote = path.join(work, "ignored-pull-remote"), root = path.join(work, "ignored-pull-local");
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
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
  // Pull is a toolbar action available from every repository section.
  await openRepository(page, root);
  await page.locator(".tb-btn[data-shortcut='pull']").click();
  const dialog = page.locator(".modal").filter({ hasText: "Local files are in the way" });
  await dialog.waitFor();
  const text = (await dialog.innerText()).replace(/\\/g, "/");
  if (!await dialog.getByText("Incoming path", { exact: true }).count() || !text.includes("personal.local")) throw Error("Pull recovery omitted the conflicting path");
  if (git(root, "rev-parse", "HEAD") !== before || !fs.readFileSync(path.join(root, ".git", "index")).equals(index)) throw Error("Blocked Pull changed HEAD or index");
  if (fs.readFileSync(path.join(root, "personal.local"), "utf8") !== "irreplaceable local settings\n") throw Error("Blocked Pull overwrote ignored data");
  await shot?.("pull-ignored-recovery");
  await dialog.getByRole("button", { name: "Inspect ignored files…", exact: true }).click();
  const ignored = page.locator(".modal").filter({ hasText: "Ignored files & folders" });
  await ignored.locator(".file-row").filter({ hasText: "personal.local" }).waitFor();
  await ignored.getByRole("button", { name: "Close", exact: true }).click();
  const unchanged = (step) => {
    if (git(root, "rev-parse", "HEAD") !== before || !fs.readFileSync(path.join(root, ".git", "index")).equals(index)) throw Error(`${step} changed HEAD or index`);
    if (fs.readFileSync(path.join(root, "personal.local"), "utf8") !== "irreplaceable local settings\n") throw Error(`${step} overwrote ignored data`);
  };
  // Cancel keeps everything as it was.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  unchanged("Cancel");
  // Continuing without a copy needs a second, separate confirmation; declining it changes nothing.
  await page.locator(".tb-btn[data-shortcut='pull']").click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Continue without a copy", exact: true }).click();
  const risk = page.locator(".modal").filter({ hasText: "Continue without a copy?" });
  await risk.waitFor();
  await risk.getByRole("button", { name: "Cancel", exact: true }).click();
  await risk.waitFor({ state: "detached" });
  unchanged("Declined no-copy confirmation");
  await page.locator(".tb-btn[data-shortcut='pull']").click();
  await dialog.waitFor();
  // Save a copy and continue: the copy is made before Git runs and offered afterwards.
  await dialog.getByRole("button", { name: "Save a copy and continue", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  // Poll the actual ref without accepting a toast as evidence of completion.
  const deadline = Date.now() + 60000;
  while (git(root, "rev-parse", "HEAD") !== target && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (git(root, "rev-parse", "HEAD") !== target) throw Error("Pull after saving a copy did not update HEAD");
  if (fs.readFileSync(path.join(root, "personal.local"), "utf8") !== "versioned defaults\n") throw Error("Pull did not install incoming content");
  const changed = page.locator(".modal").filter({ hasText: "Git changed ignored files" });
  await changed.waitFor();
  if (!await changed.getByRole("button", { name: "Restore saved copies", exact: true }).count() || !await changed.getByRole("button", { name: /Compare/ }).count()) throw Error("The saved copy is not offered after Pull");
  await shot?.("pull-ignored-saved-copy");
  await changed.getByRole("button", { name: "Restore saved copies", exact: true }).click();
  await changed.waitFor({ state: "detached" });
  const restored = Date.now() + 30000;
  while (fs.readFileSync(path.join(root, "personal.local"), "utf8") !== "irreplaceable local settings\n" && Date.now() < restored) await new Promise(resolve => setTimeout(resolve, 100));
  if (fs.readFileSync(path.join(root, "personal.local"), "utf8") !== "irreplaceable local settings\n") throw Error("Restoring the saved copy did not bring back the local settings");

  // On failure the suite captures the actual state before shutting down its isolated app.
  await openRepository(page, returnRoot);
  await page.getByRole("button", { name: "Close ignored-pull-local", exact: true }).click();
}
