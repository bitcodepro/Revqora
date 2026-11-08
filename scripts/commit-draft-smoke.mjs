import fs from "node:fs";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { openRepository } from "./ui-readiness.mjs";

// Delay a real native response, never replace Tauri's read-only invoke bridge.
// Probe the fetch transport first so an unsupported gate fails immediately.
export async function installCommitDraftGate(command) {
  const target = window, bridge = target.__TAURI_INTERNALS__, original = target.fetch;
  if (target.__commitDraftGate) throw Error("Commit draft gate already installed");
  const url = bridge.convertFileSrc(command, "ipc"), probe = bridge.convertFileSrc("plugin:app|version", "ipc");
  const gate = { calls: 0, held: false, released: false, probes: 0, probeResponses: 0, error: null, release: null, restore: null };
  const intercepted = function (input, init) {
    const request = typeof input === "string" ? input : input?.url ?? String(input);
    if (request === probe) {
      gate.probes++;
      return Reflect.apply(original, target, [input, init]).then(response => {
        if (response.ok && response.headers.get("Tauri-Response") === "ok") gate.probeResponses++;
        return response;
      });
    }
    if (request === url && ++gate.calls === 1) {
      return Reflect.apply(original, target, [input, init]).then(response => {
        if (!response.ok || response.headers.get("Tauri-Response") !== "ok") {
          gate.error = `Native ${command} returned HTTP ${response.status}`;
          return response;
        }
        return new Promise(resolve => {
          gate.held = true;
          gate.release = () => { gate.released = true; resolve(response); };
        });
      }, error => { gate.error = String(error); throw error; });
    }
    return Reflect.apply(original, target, [input, init]);
  };
  if (!Reflect.set(target, "fetch", intercepted) || target.fetch !== intercepted) throw Error("Cannot install commit draft response gate");
  gate.restore = () => {
    gate.release?.();
    if (target.fetch !== intercepted || !Reflect.set(target, "fetch", original)) throw Error("Cannot restore commit draft response gate");
    delete target.__commitDraftGate;
  };
  target.__commitDraftGate = gate;
  let timer;
  try {
    await Promise.race([bridge.invoke("plugin:app|version"), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Commit draft IPC probe timed out")), 5000); })]);
    if (gate.probes !== 1 || gate.probeResponses !== 1) throw Error("Native IPC did not use the commit draft response gate");
  } catch (error) { gate.restore(); throw error; }
  finally { clearTimeout(timer); }
}

export async function commitDraftSmoke({ page, work, returnRoot, shot }) {
  const root = path.join(work, "commit-drafts"); fs.mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "Draft Fixture"], ["user.email", "fixture@example.com"], ["core.autocrlf", "false"], ["core.hooksPath", ".git/hooks"]]) git("config", key, value);
  const put = text => fs.writeFileSync(path.join(root, "file.txt"), text);
  const commit = message => { git("add", "."); git("commit", "-qm", message); };
  put("base\n"); commit("Original message for Amend");
  const summary = () => page.locator(".commit-box .summary-wrap input"), body = () => page.locator(".commit-box textarea");
  const amend = () => page.locator(".commit-box").getByRole("checkbox", { name: "Amend", exact: true });
  const held = async () => {
    await page.waitForFunction(() => window.__commitDraftGate?.held || window.__commitDraftGate?.error, null, { timeout: 15000 });
    const error = await page.evaluate(() => window.__commitDraftGate.error);
    if (error) throw Error(error);
  };
  const release = () => page.evaluate(async () => { window.__commitDraftGate.release(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  const restore = () => page.evaluate(() => window.__commitDraftGate?.restore());
  try {
    await openRepository(page, root);
    await page.locator(".view-tab").filter({ hasText: "Changes" }).click();
    await summary().waitFor();
    for (const toggleOff of [true, false]) {
      await summary().fill(""); await body().fill("");
      await page.evaluate(installCommitDraftGate, "last_message");
      await amend().check(); await held();
      if (toggleOff) { await amend().uncheck(); await summary().fill("Newly typed summary"); }
      await body().fill("Newly typed description");
      await release();
      if (await summary().inputValue() !== (toggleOff ? "Newly typed summary" : "") || await body().inputValue() !== "Newly typed description") throw Error("Late Amend response overwrote the current draft");
      await restore(); await amend().uncheck();
    }
    console.log("Verified delayed Amend responses preserve edits after toggle-off and while Amend remains enabled");
    await summary().fill(""); await body().fill("");
    git("switch", "-qc", "incoming"); put("theirs\n"); commit("Incoming conflict"); const incoming = git("rev-parse", "HEAD");
    git("switch", "-q", "main"); put("ours\n"); commit("Local conflict"); const head = git("rev-parse", "HEAD");
    try { git("cherry-pick", incoming); } catch { /* The fixture requires a real conflict. */ }
    if (!git("status", "--porcelain").includes("UU")) throw Error("Cherry-pick fixture did not conflict");
    const next = page.locator(".commit-box").getByRole("button", { name: "Continue cherry-pick", exact: true });
    await next.waitFor();
    await page.waitForFunction(() => document.querySelector(".commit-box .split-btn button")?.disabled === true);
    await summary().fill("Edited continuation summary"); await body().fill("Edited continuation body");
    await page.evaluate(installCommitDraftGate, "op_continue");
    await summary().press("Control+Enter"); await summary().press("Control+Enter");
    if (await page.evaluate(() => window.__commitDraftGate.calls) !== 0) throw Error("An unresolved conflict submitted Continue");
    put("resolved\n"); git("add", "file.txt");
    const hook = path.join(root, ".git", "hooks", "commit-msg"), hookRuns = path.join(root, ".git", "draft-hook-runs");
    fs.writeFileSync(hook, '#!/bin/sh\nprintf "called\\n" >> "$(git rev-parse --git-dir)/draft-hook-runs"\nexit 1\n'); fs.chmodSync(hook, 0o755);
    await page.waitForFunction(() => document.querySelector(".commit-box .split-btn button")?.disabled === false);
    // Two events in one turn exercise the synchronous ownership guard before
    // React can commit disabled=true, followed by keyboard attempts while busy.
    await next.evaluate(button => { button.click(); button.click(); });
    await held(); await summary().press("Control+Enter"); await summary().press("Control+Enter");
    const hookLog = fs.readFileSync(hookRuns, "utf8").trim().split(/\r?\n/);
    if (await page.evaluate(() => window.__commitDraftGate.calls) !== 1 || hookLog.length !== 1 || hookLog[0] !== "called") throw Error("Repeated Continue enqueued another operation");
    await release();
    await page.waitForFunction(() => document.querySelector(".commit-box .split-btn button")?.disabled === false);
    if (await summary().inputValue() !== "Edited continuation summary" || await body().inputValue() !== "Edited continuation body" || git("rev-parse", "HEAD") !== head) throw Error("Failed Continue lost the draft or changed HEAD");
    await shot?.("commit-draft-after-hook-failure");
    await restore(); fs.unlinkSync(hook);
    await next.click();
    await page.waitForFunction(() => document.querySelector(".commit-box .summary-wrap input")?.value === "");
    if (git("log", "-1", "--format=%B") !== "Edited continuation summary\n\nEdited continuation body" || git("rev-parse", "HEAD^") !== head || await body().inputValue() !== "") throw Error("Successful Continue did not commit the preserved message and reset its draft");
    console.log("Verified conflict/busy gating, one Continue on repeated input, hook failure draft retention and successful retry");

    await page.getByTitle("Settings", { exact: true }).click();
    const settings = page.locator(".modal").last();
    const limit = settings.getByRole("spinbutton", { name: "Commit file warning" });
    const previousLimit = await limit.inputValue();
    await limit.fill("1");
    await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await settings.getByRole("textbox", { name: "Find shortcut" }).fill("Commit from the message fields");
    const rebind = settings.getByRole("button", { name: "Change shortcut for Commit from the message fields" });
    await rebind.click();
    await rebind.press("Control+o");
    await settings.getByRole("alert").filter({ hasText: "already assigned to Open repository" }).waitFor();
    await rebind.press("Escape");
    await rebind.click();
    await rebind.press("Control+Alt+m");
    await rebind.getByText("Ctrl+Alt+M", { exact: true }).waitFor();
    await settings.getByRole("button", { name: "Done", exact: true }).click();

    const base = git("rev-parse", "HEAD");
    const big = "large fixture.bin";
    fs.writeFileSync(path.join(root, big), Buffer.alloc(2 * 1024 * 1024, 7));
    put("selected edit\n"); git("add", "--", big, "file.txt");
    const primary = page.locator(".commit-box .split-btn > button").first();
    await primary.getByText("Commit 2 files", { exact: true }).waitFor();
    await summary().fill("Commit just the selected file");
    await summary().press("Control+Alt+m");
    const warning = page.locator(".modal").filter({ hasText: "Large file in this commit" });
    await warning.getByText(big, { exact: true }).waitFor();
    await warning.getByText("2.0 MB", { exact: true }).waitFor();
    if (!(await warning.innerText()).includes("1 MB warning threshold")) throw Error("The large-file dialog did not show the configured threshold");
    await warning.getByRole("button", { name: "Back to staged files" }).click();
    if (git("rev-parse", "HEAD") !== base || !git("diff", "--cached", "--name-only").includes(big)) throw Error("Returning from the large-file warning changed HEAD or unstaged the file");
    await page.locator(`.changes .file-row[title="${big}"]`).dblclick();
    await primary.getByText("Commit 1 file", { exact: true }).waitFor();
    await page.evaluate(installCommitDraftGate, "commit");
    await summary().press("Control+Alt+m");
    await held();
    await page.locator(".statusbar .busy-item").getByText("Running Git commit", { exact: true }).waitFor();
    if (await primary.getAttribute("aria-busy") !== "true") throw Error("The commit button did not show its active state");
    await restore();
    await page.waitForFunction(() => document.querySelector(".commit-box .summary-wrap input")?.value === "");
    if (git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD") !== "file.txt" || !fs.existsSync(path.join(root, big))) throw Error("The commit did not contain exactly the staged file");

    await page.locator(`.changes .file-row[title="${big}"]`).dblclick();
    await primary.getByText("Commit 1 file", { exact: true }).waitFor();
    await summary().fill("Confirm the large file");
    await summary().press("Control+Alt+m");
    await warning.getByRole("button", { name: "Commit anyway" }).click();
    await page.waitForFunction(() => document.querySelector(".commit-box .summary-wrap input")?.value === "");
    if (git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD") !== big) throw Error("Confirming the warning did not commit the reviewed file");

    await page.getByTitle("Settings", { exact: true }).click();
    await limit.fill(previousLimit);
    await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await settings.getByTitle("Reset shortcut for Commit from the message fields", { exact: true }).click();
    await settings.getByRole("button", { name: "Done", exact: true }).click();
    console.log("Verified shortcut rebinding, large-file cancellation and confirmation, and committing only staged files with progress");
  } finally {
    await restore();
    await openRepository(page, returnRoot);
    await page.getByRole("button", { name: "Close commit-drafts", exact: true }).click();
  }
}
