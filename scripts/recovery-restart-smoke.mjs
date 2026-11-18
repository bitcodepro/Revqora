import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { launch } from "./ui-driver.mjs";

/**
 * Recovery after a restart, in the real app: Pull saves a checkpoint and the app is killed while
 * Git waits for a slow server. After the restart the Operation log shows the action with an
 * unknown outcome and opens its checkpoint, which explains what is known, compares a file edited
 * after the restart and restores it without overwriting the newer edit.
 */
export async function recoveryRestartSmoke({ exe, work, check, out }) {
  await check("an action interrupted by an app crash is found after the restart, linked to its checkpoint, and restores without overwriting later edits", async () => {
    const home = path.join(work, "recovery-restart"), remote = path.join(home, "server"), root = path.join(home, "restart-local");
    fs.mkdirSync(home, { recursive: true });
    const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", windowsHide: true }).trim();
    fs.mkdirSync(remote);
    git(remote, "init", "-q", "-b", "main");
    git(remote, "config", "user.name", "Restart Fixture"); git(remote, "config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(remote, ".gitignore"), "*.env\n");
    fs.writeFileSync(path.join(remote, "readme.txt"), "base\n");
    git(remote, "add", "."); git(remote, "commit", "-qm", "base");
    git(home, "clone", "-q", remote, root);
    git(root, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(remote, "readme.txt"), "incoming\n");
    git(remote, "commit", "-qam", "incoming change");
    fs.writeFileSync(path.join(root, "local.env"), "SECRET=mine\n");
    const head = git(root, "rev-parse", "HEAD");
    // The server answers only after a long pause, so Pull is still running when the app dies.
    git(root, "config", "remote.origin.uploadpack", "sleep 120; git-upload-pack");

    const profile = path.join(home, "profile");
    let app = await launch({ exe, profile, port: 0, visible: false });
    try {
      let page = app.page; page.setDefaultTimeout(60000);
      const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
      const skip = page.getByRole("button", { name: "Skip", exact: true });
      await skip.click();
      await invoke("plugin:event|emit", { event: "open-paths", payload: [root] });
      await page.locator(".topbar .repo-current > b").filter({ hasText: "restart-local" }).waitFor();
      await page.locator(".tb-btn[data-shortcut='pull']").click();
      // Pull saved its checkpoint and is waiting for the server.
      let running;
      for (const deadline = Date.now() + 60000; !running && Date.now() < deadline;) {
        const pageOfLog = await invoke("operation_log_list", { filter: { repo: root } });
        running = pageOfLog.entries.find((entry) => entry.command === "pull" && entry.status === "running" && entry.checkpoints.length);
        if (!running) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(running, "Pull should be running with a checkpoint");
      const [checkpoint] = running.checkpoints;
      // The app dies (the whole process tree, Git included).
      await app.close(); app = null;
      assert.equal(git(root, "rev-parse", "HEAD"), head, "the interrupted Pull changed nothing");

      app = await launch({ exe, profile, port: 0, visible: false });
      page = app.page; page.setDefaultTimeout(60000);
      // WebView storage is written to disk with a delay, so a crash this soon after the first
      // start can bring the Welcome dialog back. The operation journal does not depend on it.
      await page.getByRole("button", { name: "Skip", exact: true }).click({ timeout: 5000 }).catch(() => {});
      await page.evaluate((root) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: [root] }), root);
      await page.locator(".topbar .repo-current > b").filter({ hasText: "restart-local" }).waitFor();
      await page.getByRole("button", { name: "Operation log", exact: true }).first().click();
      const log = page.locator(".modal").filter({ has: page.getByRole("heading", { name: "Operation log" }) });
      await log.getByRole("combobox", { name: "Operation log scope" }).selectOption("all");
      const row = log.locator(".log-row").filter({ hasText: "Pull" }).filter({ hasText: "Outcome unknown" }).first();
      await row.click();
      const detail = log.locator(".log-detail");
      await detail.getByText("Its recovery checkpoint shows which saved files differ now").waitFor();
      if (out) await page.screenshot({ path: path.join(out, "restart-operation-log.png") });
      await detail.getByRole("button", { name: /Open checkpoint/ }).click();

      const center = page.locator(".modal").filter({ has: page.getByRole("heading", { name: "Undo Center" }) });
      await center.locator(`.recovery-detail[data-checkpoint-id='${checkpoint}']`).waitFor();
      const operation = center.locator(".recovery-operation[data-operation-status='interrupted']");
      await operation.getByText("The app stopped before this action finished").waitFor();
      assert.equal(await operation.getByRole("button", { name: "Show in Operation log" }).count(), 1);
      await center.locator(`.recovery-row[data-checkpoint-id='${checkpoint}'] .recovery-status.interrupted`).waitFor();
      const saved = center.locator(".recovery-file[data-path='local.env']");
      assert.equal(await saved.getAttribute("data-state"), "same", "Git never touched the ignored file");

      // The user edits the file after the restart: it now differs, and what Pull did is unknown.
      fs.writeFileSync(path.join(root, "local.env"), "SECRET=edited after the restart\n");
      await center.getByRole("button", { name: "Refresh checkpoints" }).click();
      await center.locator(".recovery-file[data-path='local.env'][data-state='unknown']").waitFor();
      await center.getByRole("checkbox", { name: "Restore local.env" }).check();
      if (out) await page.screenshot({ path: path.join(out, "restart-undo-center.png") });
      await center.getByRole("button", { name: /^Restore selected/ }).click();
      const result = center.locator(".recovery-restore-result");
      await result.getByText("local.env → local.env.recovered", { exact: false }).waitFor();
      assert.equal(fs.readFileSync(path.join(root, "local.env"), "utf8"), "SECRET=edited after the restart\n", "the newer edit is never replaced");
      assert.equal(fs.readFileSync(path.join(root, "local.env.recovered"), "utf8"), "SECRET=mine\n", "the saved copy is written beside it");
      // The restore is logged beside the checkpoint and listed with it after a refresh.
      await center.getByRole("button", { name: "Refresh checkpoints" }).click();
      await center.locator(`.recovery-row[data-checkpoint-id='${checkpoint}']`).click();
      if (out) await page.screenshot({ path: path.join(out, "restart-restored.png") });
    } finally {
      await app?.close();
    }
  });
}
