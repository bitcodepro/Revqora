import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfile, launch } from "./ui-driver.mjs";

export async function conflictStudioSmoke({ page, check, shot, work }) {
  const root = path.join(work, "stage7-conflicts"); fs.mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args: { repo: root, ...args } });
  const result = () => page.locator(".cf-result .cm-content");
  const waitText = async (text) => { await page.waitForFunction((text) => document.querySelector(".cf-result .cm-content")?.textContent.includes(text), text); };
  const open = async () => { await page.locator(".op-banner").getByRole("button", { name: /^Resolve/ }).click(); await page.waitForSelector(".cf-result .cm-content"); };
  const run = async (command) => {
    await page.getByLabel("Validation command", { exact: true }).fill(command);
    await page.locator(".cf-validation").getByRole("button", { name: "Run", exact: true }).click();
    await page.locator(".modal").last().getByRole("button", { name: "Run command", exact: true }).click();
  };
  let head;
  await check("Conflict Studio preserves partial edits and shows a toggleable read-only Base", async () => {
    git("init", "-q", "-b", "main"); git("config", "user.name", "Conflict Tester"); git("config", "user.email", "conflict@example.com"); git("config", "commit.gpgsign", "false"); git("config", "core.autocrlf", "false"); git("config", "core.hooksPath", ".git/hooks");
    const lines = (side) => ["header", `${side} one`, ...Array.from({ length: 24 }, (_, n) => `context ${n}`), `${side} two`, "end", ""].join("\r\n");
    for (const f of ["one.txt", "two.txt"]) fs.writeFileSync(path.join(root, f), lines("base"));
    git("add", "."); git("commit", "-qm", "Conflict base"); git("branch", "incoming");
    for (const f of ["one.txt", "two.txt"]) fs.writeFileSync(path.join(root, f), lines("ours")); git("commit", "-qam", "Ours"); head = git("rev-parse", "HEAD");
    git("checkout", "-q", "incoming"); for (const f of ["one.txt", "two.txt"]) fs.writeFileSync(path.join(root, f), lines("theirs")); git("commit", "-qam", "Theirs"); git("checkout", "-q", "main");
    try { git("merge", "--no-commit", "incoming"); } catch {}
    if (!git("status", "--porcelain").includes("UU")) throw new Error("Fixture did not conflict");
    fs.writeFileSync(path.join(root, "one.txt"), "partial manual edit\r\n" + fs.readFileSync(path.join(root, "one.txt"), "utf8"));
    await page.evaluate((root) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: [root] }), root);
    await page.waitForSelector(".repository-item.active .repository-label:has-text('stage7-conflicts')"); await open(); await waitText("partial manual edit");
    const base = page.locator(".cf-base .cm-content"); await base.waitFor();
    if (await base.getAttribute("contenteditable") !== "false" || !(await base.innerText()).includes("base one")) throw new Error("Base is missing or editable");
    await page.getByRole("checkbox", { name: "Base", exact: true }).uncheck(); await base.waitFor({ state: "detached" });
    await page.getByRole("checkbox", { name: "Base", exact: true }).check(); await base.waitFor(); await shot("67-conflict-studio-base");
  });
  await check("conflict file navigation and close retain drafts; Save draft preserves CRLF without resolving", async () => {
    await result().click(); await page.keyboard.press("Control+Home"); await page.keyboard.insertText("session draft\n"); await waitText("session draft");
    await page.getByLabel("Conflict file", { exact: true }).selectOption("two.txt"); await page.waitForSelector(".cf-title .p:has-text('two.txt')");
    await page.getByLabel("Conflict file", { exact: true }).selectOption("one.txt"); await waitText("session draft");
    await page.locator(".cf-head").getByRole("button", { name: "Close", exact: true }).click(); await open(); await waitText("session draft");
    await page.locator(".cf-head").getByRole("button", { name: "Save draft", exact: true }).click();
    await page.waitForSelector(".toast:has-text('Saved draft: one.txt')");
    const bytes = fs.readFileSync(path.join(root, "one.txt"), "utf8");
    if (!bytes.includes("session draft\r\n") || /(?<!\r)\n/.test(bytes) || !git("status", "--porcelain").includes("UU one.txt")) throw new Error("Draft lost CRLF or resolved the conflict");
    await page.locator(".cf-head").getByRole("button", { name: "Validate", exact: true }).click();
    await shot("68-conflict-studio-draft");
  });
  await check("explicit resolution validation passes, then becomes stale after external changes", async () => {
    await run("echo checked"); await page.waitForSelector(".cf-validation-status[data-phase='passed'][data-fresh='true']");
    fs.appendFileSync(path.join(root, "two.txt"), "external edit\r\n");
    await page.waitForSelector(".cf-validation-status[data-phase='passed'][data-fresh='false']");
    await shot("69-conflict-studio-stale-check");
  });
  await check("validation displays nonzero exit and cancels a running command", async () => {
    await run("exit 7"); await page.waitForSelector(".cf-validation-status[data-phase='failed']");
    if (!(await page.locator(".cf-validation-status").innerText()).includes("exit 7")) throw new Error("Exit status hidden");
    await run('node -e "setTimeout(()=>{},15000)"'); await page.locator(".cf-validation").getByRole("button", { name: "Cancel check", exact: true }).click();
    await page.waitForSelector(".cf-validation-status[data-phase='cancelled']"); await shot("70-conflict-studio-check-cancelled");
  });
  await check("stale conflict drafts require reviewing current versions and resolution never commits automatically", async () => {
    await page.locator(".cf-head").getByRole("button", { name: "Close", exact: true }).click();
    fs.appendFileSync(path.join(root, "one.txt"), "external first-file edit\r\n"); await open();
    await page.waitForSelector(".cf-head .pill:has-text('File changed on disk')"); await waitText("session draft");
    await page.locator(".cf-head").getByRole("button", { name: "Review current versions", exact: true }).click();
    await page.locator(".modal").last().getByRole("button", { name: "Keep draft", exact: true }).click(); await waitText("session draft");
    await page.locator(".cf-head").getByRole("button", { name: "All theirs", exact: true }).click(); await page.waitForSelector(".cf-result .pill.green");
    await page.locator(".cf-head").getByRole("button", { name: "Save & mark resolved", exact: true }).click();
    await page.waitForSelector(".cf-title .p:has-text('two.txt')");
    await page.locator(".cf-head").getByRole("button", { name: "All theirs", exact: true }).click(); await page.waitForSelector(".cf-result .pill.green");
    await page.locator(".cf-head").getByRole("button", { name: "Save & mark resolved", exact: true }).click(); await page.waitForSelector(".conflict-overlay", { state: "detached" });
    if (git("rev-parse", "HEAD") !== head || git("ls-files", "-u") !== "") throw new Error("Resolution committed automatically or left conflicts");
    await page.locator(".op-banner").getByRole("button", { name: "Confirm merge", exact: true }).click();
    await page.waitForSelector(".modal:has-text('Continue without a current passing check?')"); await page.locator(".modal").last().getByRole("button", { name: "Cancel", exact: true }).click();
    const catalog = await invoke("recovery_list"); if (!catalog.checkpoints.some((c) => c.command === "conflict_save" && c.workspace)) throw new Error("Resolution did not preserve a checkpoint");
    await shot("71-conflict-studio-ready");
  });
  const toolsValidation = async () => {
    await page.click(".toolbar button[title='Repository tools']");
    await page.locator(".modal").last().getByRole("button", { name: "Validate / conflict drafts", exact: true }).click();
    await page.waitForSelector(".cf-validation");
  };
  const discardRetained = async (file) => {
    await page.locator(`[data-retained-draft='${file}']`).getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.locator(".modal").last().getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.locator(`[data-retained-draft='${file}']`).waitFor({ state: "detached" });
  };
  await check("Take ours and Mark resolved outside the editor retain recoverable drafts without blocking Run, including after abort", async () => {
    git("merge", "--abort"); try { git("merge", "--no-commit", "incoming"); } catch {}
    await page.click("button[title='Refresh (F5)']");
    for (const [file, action, notice] of [["one.txt", "Take ours (current branch)", "Resolved with ours"], ["two.txt", "Mark as resolved", "Marked resolved"]]) {
      await open(); await page.getByLabel("Conflict file", { exact: true }).selectOption(file);
      await page.waitForSelector(`.cf-title .p:has-text('${file}')`); await result().click(); await page.keyboard.press("Control+Home");
      await page.keyboard.insertText(`retained ${file}\n`); await waitText(`retained ${file}`);
      await page.locator(".cf-head").getByRole("button", { name: "Close", exact: true }).click();
      await page.click(".view-tab:has-text('Changes')");
      await page.locator(".changes .file-row:has(.pill.red)").filter({ hasText: file }).click({ button: "right" });
      await page.locator(".ctx-item").filter({ hasText: action }).click();
      await page.waitForSelector(`.toast:has-text('${notice}')`);
      if (git("ls-files", "-u", "--", file) !== "") throw new Error(`${file} was not resolved outside the editor`);
    }
    await page.locator(".op-banner").getByRole("button", { name: /^(Validate|Check result|Checks passed)$/ }).click();
    await page.waitForSelector("[data-retained-draft='one.txt']"); await page.waitForSelector("[data-retained-draft='two.txt']");
    await page.getByLabel("Validation command", { exact: true }).fill("echo recovered");
    if (await page.locator(".cf-validation").getByRole("button", { name: "Run", exact: true }).isDisabled()) throw new Error("resolved drafts still block Run");
    await page.locator("[data-retained-draft='one.txt']").getByRole("button", { name: "View / copy", exact: true }).click();
    if (!(await page.getByLabel("Retained conflict draft").inputValue()).includes("retained one.txt")) throw new Error("manual draft was discarded");
    await page.locator(".modal").last().getByRole("button", { name: "Close", exact: true }).click();
    await discardRetained("one.txt");
    await page.locator(".modal").last().getByRole("button", { name: "Close", exact: true }).click();
    git("merge", "--abort"); await page.click("button[title='Refresh (F5)']"); await page.waitForSelector(".op-banner", { state: "detached" });
    await toolsValidation(); await page.locator("[data-retained-draft='two.txt']").getByRole("button", { name: "View / copy", exact: true }).click();
    if (!(await page.getByLabel("Retained conflict draft").inputValue()).includes("retained two.txt")) throw new Error("abort lost the retained draft");
    await page.locator(".modal").last().getByRole("button", { name: "Close", exact: true }).click();
    await shot("72-conflict-orphaned-drafts"); await discardRetained("two.txt");
    await page.locator(".modal").last().getByRole("button", { name: "Close", exact: true }).click();
  });
  await check("external resolution while the editor is open does not leave its unsaved result blocking validation", async () => {
    try { git("merge", "--no-commit", "incoming"); } catch {}
    await page.click("button[title='Refresh (F5)']"); await open(); await page.getByLabel("Conflict file", { exact: true }).selectOption("one.txt");
    await result().click(); await page.keyboard.press("Control+Home"); await page.keyboard.insertText("external recovery draft\n"); await waitText("external recovery draft");
    git("checkout", "--ours", "--", "one.txt"); git("add", "one.txt");
    await page.locator(".cf-head").getByRole("button", { name: "Validate", exact: true }).click();
    await page.waitForSelector("[data-retained-draft='one.txt']"); await page.getByLabel("Validation command", { exact: true }).fill("echo external");
    if (await page.locator(".cf-validation").getByRole("button", { name: "Run", exact: true }).isDisabled()) throw new Error("open editor still blocks a resolved file");
    await shot("73-conflict-resolved-while-open");
    await page.locator(".cf-head").getByRole("button", { name: "Close", exact: true }).click();
    git("merge", "--abort"); await page.click("button[title='Refresh (F5)']"); await page.waitForSelector(".op-banner", { state: "detached" }); await toolsValidation();
  });
  await check("a second validation completes while the first check's terminal sidebar refresh is deferred", async () => {
    await page.evaluate(() => {
      const original = window.fetch;
      const endpoint = (command) => window.__TAURI_INTERNALS__.convertFileSrc(command, "ipc");
      const normalized = (value) => value?.replaceAll("\\", "/");
      const race = window.__validationReviewRace = { armed: false, held: false, original, release: null, repositoryRoot: null };
      // Tauri's invoke property is immutable. Delay its fetch transport just as
      // the other native IPC-generation regressions in ui-smoke do.
      window.fetch = async function(input, init) {
        const response = await original.call(this, input, init);
        if (String(input) === endpoint("validation_report")) {
          const value = await response.clone().json();
          if (value?.command === "echo review-first" && value.phase === "passed") { race.armed = true; race.repositoryRoot = value.repositoryRoot; }
        }
        if (String(input) === endpoint("repo_extras") && race.armed && !race.held) {
          const args = JSON.parse(init?.body || "{}");
          if (normalized(args.repo) === normalized(race.repositoryRoot)) { race.held = true; await new Promise((resolve) => { race.release = resolve; }); }
        }
        return response;
      };
    });
    try {
      await run("echo review-first"); await page.waitForSelector(".cf-validation-status[data-phase='passed']");
      await page.waitForFunction(() => window.__validationReviewRace?.release !== null && window.__validationReviewRace?.held);
      await run("echo review-second");
      await page.waitForFunction(() => document.querySelector(".cf-validation-ran")?.textContent.includes("echo review-second"));
      await page.waitForSelector(".cf-validation-status[data-phase='passed']", { timeout: 30000 });
      if (!(await page.locator(".cf-validation-ran").first().innerText()).includes("echo review-second")) throw new Error("old report replaced the second check");
      await shot("74-validation-restart-during-refresh");
    } finally {
      await page.evaluate(() => { const race = window.__validationReviewRace; race.release?.(); window.fetch = race.original; delete window.__validationReviewRace; });
    }
    await page.locator(".modal").last().getByRole("button", { name: "Close", exact: true }).click();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work = createProfile("revqora-conflict-");
  const out = process.env.REVQORA_SMOKE_OUT || path.join(work, "shots"); fs.mkdirSync(out, { recursive: true });
  const exe = process.argv[2] || path.resolve("release/Revqora/revqora.exe");
  const { page, close } = await launch({ exe, args: [], profile: path.join(work, "profile"), port: 0 });
  page.setDefaultTimeout(60000);
  try {
    await page.waitForSelector(".modal:has-text('Welcome to Revqora')"); await page.locator(".modal").getByRole("button", { name: "Skip", exact: true }).click();
    await conflictStudioSmoke({ page, work, check: async (name, fn) => { await fn(); console.log(`PASS ${name}`); }, shot: (name) => page.screenshot({ path: path.join(out, `${name}.png`) }) });
  } catch (e) { await page.screenshot({ path: path.join(out, "failure.png") }); throw e; }
  finally { await close(); }
}
