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
  } finally {
    await restore();
    await openRepository(page, returnRoot);
    await page.getByRole("button", { name: "Close commit-drafts", exact: true }).click();
  }
}
