// End-to-end UI smoke test against the built app (WebView2 + CDP).
//   node scripts/ui-smoke.mjs [--exe path] [--out dir] [--keep]
// Builds a demo repository, drives the real UI through the main workflows and
// verifies the resulting git state with the git CLI. Screenshots go to --out.
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfile, launch } from "./ui-driver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const exe = arg("--exe", path.join(projectRoot, "src-tauri/target/release/revqora.exe"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "revqora-smoke-"));
const out = arg("--out", path.join(work, "shots"));
fs.mkdirSync(out, { recursive: true });

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
execFileSync(bash, [path.join(here, "make-demo-repo.sh").replace(/\\/g, "/"), path.join(work, "env").replace(/\\/g, "/")], { stdio: "ignore" });
const repo = path.join(work, "env", "demo");
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();

let step = 0;
const results = [];
const { page, close } = await launch({ exe, args: [repo], profile: createProfile("revqora-smoke-profile-"), port: 0 });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

async function check(name, fn) {
  step++;
  try {
    await fn();
    results.push(`ok   ${step}. ${name}`);
  } catch (e) {
    results.push(`FAIL ${step}. ${name}: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(out, `fail-${step}.png`) }).catch(() => {});
    throw e;
  }
}
const shot = (n) => page.screenshot({ path: path.join(out, `${n}.png`) });
const until = async (fn, msg, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await page.waitForTimeout(120);
  }
  throw new Error(msg);
};

let failed = false;
try {
  await check("first-run guide can be skipped", async () => {
    await page.waitForSelector(".modal:has-text('Welcome to Revqora')", { timeout: 20000 });
    await page.click(".modal button:has-text('Skip')");
    await page.waitForSelector(".modal", { state: "detached" });
  });

  await check("history graph renders all commits", async () => {
    await page.waitForSelector(".grow:not(.wip) .g-subject .text", { timeout: 20000 });
    await page.waitForTimeout(1200);
    const n = await page.locator(".grow").count();
    if (n !== 14) throw new Error(`expected 14 rows (13 commits + changes), got ${n}`);
    await shot("01-history");
  });

  await check("the installed git is detected and shown in the status bar", async () => {
    const text = await page.locator(".statusbar").innerText();
    if (!/git \d+\.\d+/.test(text)) throw new Error(`status bar shows: ${text}`);
  });

  await check("commit details show files and diff", async () => {
    await page.locator(".grow", { hasText: "Document usage" }).click();
    await page.waitForSelector(".details .file-row");
    await page.waitForSelector(".diff .dl.add");
    await shot("02-details");
  });

  await check("search filters commits", async () => {
    await page.fill(".search-box input", "greeting");
    await until(async () => (await page.locator(".grow.match").count()) >= 2, "no search matches");
    await page.fill(".search-box input", "");
  });

  await check("stage a single line from the diff", async () => {
    await page.click(".view-tab:has-text('Changes')");
    await page.locator(".changes .file-row", { hasText: "app.ts" }).first().click();
    await page.waitForSelector(".diff-head .path:has-text('app.ts')");
    await page.waitForSelector(".changes .diff .dl.add");
    await page.waitForTimeout(400);
    await page.locator(".changes .diff .dl.add .ln").nth(1).click(); // first added line
    await page.waitForSelector(".sel-bar", { timeout: 4000 }).catch(() => {
      throw new Error("selection bar did not appear after clicking a line number");
    });
    await page.locator(".sel-bar button:has-text('Stage lines')").click();
    await until(() => git("diff", "--cached", "--numstat").includes("src/app.ts"), "line was not staged");
    const staged = git("diff", "--cached", "src/app.ts");
    if (staged.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length !== 1) throw new Error("expected exactly one staged added line:\n" + staged);
    await shot("03-line-staged");
  });

  await check("seal a stage layer and stage more on top", async () => {
    await page.click("button[title^='Seal what is staged']");
    await page.waitForSelector(".layer:not(.open-layer)");
    await page.locator(".file-row", { hasText: "config.json" }).first().hover();
    await page.locator(".file-row", { hasText: "config.json" }).first().locator("button[title='Stage']").click();
    await until(async () => (await page.locator(".open-layer .file-row", { hasText: "config.json" }).count()) === 1, "config.json not in open layer");
    await shot("04-layers");
  });

  await check("unstage the first layer only", async () => {
    await page.locator(".layer:not(.open-layer) button[title='Unstage layer']").click();
    await until(() => !git("diff", "--cached", "--name-only").includes("src/app.ts"), "app.ts still staged");
    if (!git("diff", "--cached", "--name-only").includes("src/config.json")) throw new Error("config.json should stay staged");
  });

  await check("commit staged changes", async () => {
    await page.fill(".commit-box input", "Change port");
    await page.click(".commit-box .split-btn .btn:first-child");
    await until(() => git("log", "-1", "--format=%s") === "Change port", "commit not created");
  });

  await check("interactive rebase rewords a local commit", async () => {
    await page.click(".view-tab:has-text('History')");
    await page.locator(".grow", { hasText: "Bump version to 0.3.0" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Edit history" }).hover();
    await page.locator(".ctx-item", { hasText: "Interactive rebase from here" }).click();
    await page.waitForSelector(".rebase-row");
    const row = page.locator(".rebase-row", { hasText: "Change port" });
    await row.locator("button:has-text('Reword')").click();
    await row.locator("textarea").fill("Change the default port");
    await page.click(".cf-head button:has-text('Start rebase')");
    await until(() => git("log", "-1", "--format=%s") === "Change the default port", "rebase did not reword the commit");
    await page.waitForSelector(".conflict-overlay", { state: "detached" });
  });

  await check("image files show a picture diff", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    fs.writeFileSync(path.join(repo, "logo.png"), png);
    await page.click(".view-tab:has-text('Changes')");
    await page.locator(".changes .file-row", { hasText: "logo.png" }).first().click();
    await page.waitForSelector(".diff img[alt='After']");
    await shot("09-image-diff");
  });

  await check("stash remaining changes from the toolbar", async () => {
    await page.click(".toolbar button[title='Stash changes']");
    await page.click(".modal button:has-text('Stash')");
    await until(() => git("status", "--porcelain") === "", "working tree not clean after stash");
    await until(async () => (await page.locator(".sidebar .sb-item", { hasText: "Change the default port" }).count()) === 1, "stash not listed in the sidebar");
  });

  await check("merge with conflict stops before committing", async () => {
    const before = git("rev-parse", "HEAD");
    await page.click(".view-tab:has-text('History')");
    await page.locator(".sb-item", { hasText: "greeting" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Merge hotfix/greeting into main" }).click();
    await page.click(".modal button:has-text('Start merge')");
    await page.waitForSelector(".op-banner");
    if (git("rev-parse", "HEAD") !== before) throw new Error("HEAD moved before confirmation");
    await shot("05-merge-conflict");
  });

  await check("resolve conflict in the merge editor", async () => {
    await page.click(".op-banner button:has-text('Resolve')");
    await page.waitForSelector(".conflict-overlay .cf-actions");
    await page.waitForTimeout(500);
    await shot("06-conflict-editor");
    await page.locator(".cf-actions button.theirs").first().dispatchEvent("mousedown");
    await until(async () => (await page.locator(".cf-head .pill.green, .cf-result .pill.green").count()) > 0, "conflict not resolved in editor");
    await page.click(".cf-head button:has-text('Save & mark resolved')");
    await page.waitForSelector(".conflict-overlay", { state: "detached" });
  });

  await check("confirm merge creates the merge commit", async () => {
    await page.click(".op-banner button:has-text('Confirm merge')");
    await page.click(".modal button:has-text('Create merge commit')");
    await until(() => git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length === 3, "merge commit missing");
    if (!fs.readFileSync(path.join(repo, "src/app.ts"), "utf8").includes("welcome back")) throw new Error("theirs side not applied");
    await page.waitForSelector(".op-banner", { state: "detached" });
  });

  await check("abort a second merge restores the branch", async () => {
    git("switch", "-q", "-c", "temp-conflict", "HEAD~1");
    fs.writeFileSync(path.join(repo, "src/app.ts"), "conflicting\n");
    git("commit", "-qam", "conflicting change");
    git("switch", "-q", "main");
    const before = git("rev-parse", "HEAD");
    await page.locator(".view-tab:has-text('History')").click();
    await page.click("button[title='Refresh (F5)']");
    await until(async () => {
      const currentMain = await page.locator(".sidebar .sb-item.current", { has: page.locator(".label", { hasText: /^main$/ }) }).count();
      const head = await page.locator(".grow:has(.head-ring) .g-hash").innerText().catch(() => "");
      return currentMain === 1 && head === before.slice(0, 7);
    }, "UI did not refresh to main after CLI branch changes");
    await page.locator(".sidebar .sb-item:not(.current)", { has: page.locator(".label", { hasText: /^temp-conflict$/ }) }).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Merge temp-conflict into main" }).click();
    await page.click(".modal button:has-text('Start merge')");
    await page.waitForSelector(".op-banner");
    await page.click(".op-banner button:has-text('Abort')");
    await page.click(".modal button:has-text('Abort merge')");
    await page.waitForSelector(".op-banner", { state: "detached" });
    if (git("rev-parse", "HEAD") !== before) throw new Error("HEAD changed after abort");
    if (git("status", "--porcelain").includes("UU")) throw new Error("conflict left behind");
  });

  await check("compare two branches", async () => {
    await page.click(".view-tab:has-text('History')");
    await page.locator(".sb-item", { has: page.locator(".label", { hasText: /^ui$/ }) }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Compare with main" }).click();
    await page.waitForSelector(".conflict-overlay .file-row");
    const n = await page.locator(".conflict-overlay .file-row").count();
    if (n < 1) throw new Error("no files in comparison");
    await shot("10-compare");
    await page.click(".cf-head button:has-text('Close')");
    await page.waitForSelector(".conflict-overlay", { state: "detached" });
  });

  await check("blame a file from commit details", async () => {
    if (!(await page.locator(".view-tab.on:has-text('History')").count())) throw new Error("History view was left unexpectedly");
    await page.locator(".grow", { hasText: "Document usage" }).first().click();
    await page.locator(".details .file-row", { hasText: "README.md" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Blame at this commit" }).click();
    await page.waitForSelector(".blame-row");
    const authors = await page.locator(".blame-gutter .sum").allInnerTexts();
    if (!authors.some((a) => a.includes("Document usage"))) throw new Error("blame does not show the commit: " + authors.join(" | "));
    await shot("11-blame");
    await page.click(".cf-head button:has-text('Close')");
  });

  await check("credentials are asked in Revqora's own dialog", async () => {
    let seenAuth = null;
    const server = http.createServer((req, res) => {
      if (!req.headers.authorization) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="revqora-test"' });
        return res.end();
      }
      seenAuth = Buffer.from(req.headers.authorization.replace(/^Basic /, ""), "base64").toString();
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    git("config", "credential.helper", "");
    git("remote", "add", "authsrv", `http://127.0.0.1:${port}/repo.git`);
    try {
      await page.click(".toolbar button[title='Fetch all remotes']");
      await page.waitForSelector(".modal:has-text('Sign in') input", { timeout: 20000 });
      await page.fill(".modal input", "alice");
      await page.click(".modal button:has-text('Continue')");
      await page.waitForSelector(".modal:has-text('Password') input[type='password']", { timeout: 20000 });
      await shot("12-askpass");
      await page.fill(".modal input", "s3cret");
      await page.click(".modal button:has-text('Continue')");
      await until(async () => seenAuth !== null, "server never received credentials", 20000);
      if (seenAuth !== "alice:s3cret") throw new Error(`server received ${seenAuth}`);
    } finally {
      server.close();
      git("remote", "remove", "authsrv");
    }
  });

  await check("bisect starts, shows its banner and finishes", async () => {
    await page.waitForTimeout(800);
    await page.click(".view-tab:has-text('History')");
    await page.locator(".grow", { hasText: "Initial project structure" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Bisect" }).hover();
    await page.locator(".ctx-item", { hasText: "Start: this commit is good" }).click();
    await page.click(".modal button:has-text('Start bisect')");
    await page.waitForSelector(".op-banner:has-text('Bisect')");
    await shot("13-bisect");
    await page.click(".op-banner button:has-text('Good')");
    await page.waitForTimeout(500);
    await page.click(".op-banner button:has-text('Finish bisect')");
    await page.waitForSelector(".op-banner", { state: "detached" });
    if (fs.existsSync(path.join(repo, ".git", "BISECT_LOG"))) throw new Error("bisect still active");
  });

  await check("diff search finds text and keyboard shortcut switches views", async () => {
    await page.click(".view-tab:has-text('History')");
    await page.locator(".grow", { hasText: "Document usage" }).first().click();
    await page.waitForSelector(".details .diff .dl.add");
    await page.click(".details .diff button[title^='Find in diff']");
    await page.fill(".diff-find input", "usage");
    await page.waitForSelector(".details .dl.search-cur");
    await page.keyboard.press("Escape");
    await page.locator(".graph-scroll").focus();
    await page.keyboard.press("Control+2");
    await page.waitForSelector(".view-tab.on:has-text('Changes')");
    await page.keyboard.press("Control+1");
    await page.waitForSelector(".view-tab.on:has-text('History')");
  });

  await check("stash contents open in the stash viewer", async () => {
    await page.locator(".sidebar .sb-item", { hasText: "Change the default port" }).first().click();
    await page.waitForSelector(".conflict-overlay .file-row");
    await page.waitForSelector(".conflict-overlay .diff .dl");
    await shot("14-stash-viewer");
    await page.click(".cf-head button:has-text('Close')");
    await page.waitForSelector(".conflict-overlay", { state: "detached" });
  });

  await check("browse files and grep a revision", async () => {
    await page.keyboard.press("Control+k");
    await page.fill(".palette input", "Browse files");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".conflict-overlay .sb-item");
    await page.fill(".conflict-overlay .search-box input", "greet");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".conflict-overlay .file-row:has-text('src/app.ts')");
    await page.locator(".conflict-overlay .file-row", { hasText: "src/app.ts" }).first().click();
    await page.waitForSelector(".conflict-overlay .cm-content");
    await shot("15-tree-browser");
    await page.click(".cf-head button:has-text('Close')");
    await page.waitForSelector(".conflict-overlay", { state: "detached" });
  });

  await check("compare a commit with the working tree", async () => {
    fs.appendFileSync(path.join(repo, "README.md"), "local edit\n");
    await page.locator(".grow", { hasText: "Document usage" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Compare with working tree" }).click();
    await page.waitForSelector(".conflict-overlay .file-row:has-text('README.md')");
    await page.click(".cf-head button:has-text('Close')");
    git("checkout", "--", "README.md");
  });

  await check("restore a deleted branch from repository tools", async () => {
    git("branch", "-D", "temp-conflict");
    await page.click(".toolbar button[title='Repository tools']");
    await page.click(".modal button:has-text('Recently deleted branches')");
    const row = page.locator(".modal .reflog-row", { hasText: "temp-conflict" });
    await row.waitFor();
    await row.locator("button:has-text('Restore')").click();
    await until(() => git("branch", "--list", "temp-conflict") !== "", "branch not restored");
    await page.click(".modal button:has-text('Close')");
  });

  await check("create a worktree from the command palette", async () => {
    await page.keyboard.press("Control+k");
    await page.fill(".palette input", "New worktree");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".modal:has-text('New worktree')");
    await page.click(".modal button:has-text('Create worktree')");
    await until(() => git("worktree", "list").split("\n").length === 2, "worktree not created");
    await page.waitForSelector(".modal", { state: "detached" });
  });

  await check("overlapping stage layers are resolved in the merge editor", async () => {
    await page.click(".view-tab:has-text('Changes')");
    fs.writeFileSync(path.join(repo, "src/config.json"), '{\n  "port": 7000,\n  "debug": true\n}\n');
    git("add", "src/config.json");
    await page.click("button[title='Refresh (F5)']");
    await page.click("button[title^='Seal what is staged']");
    await page.waitForSelector(".layer:not(.open-layer)");
    fs.writeFileSync(path.join(repo, "src/config.json"), '{\n  "port": 7001,\n  "debug": true\n}\n');
    git("add", "src/config.json");
    await page.click("button[title='Refresh (F5)']");
    await page.waitForSelector(".open-layer .file-row:has-text('config.json')");
    await page.click(".open-layer button[title='Seal into a layer']");
    await until(async () => (await page.locator(".layer:not(.open-layer)").count()) === 2, "second layer not sealed");
    await page.locator(".layer:not(.open-layer)").first().locator("button[title='Unstage layer']").click();
    await page.click(".modal button:has-text('Resolve')");
    await page.waitForSelector(".cf-actions button.theirs");
    await shot("16-layer-conflict");
    await page.locator(".cf-actions button.theirs").first().dispatchEvent("mousedown");
    await page.click(".cf-head button:has-text('Use this result')");
    await until(() => git("show", ":src/config.json").includes("7001"), "resolution not staged");
    git("reset", "-q", "--hard");
    git("update-ref", "-d", "refs/worktree/revqora/layers");
    await page.click("button[title='Refresh (F5)']");
  });

  await check("dark theme renders", async () => {
    if (await page.locator(".commit-box input").inputValue().catch(() => "")) throw new Error("commit message from the aborted merge was left behind");
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await page.click(".view-tab:has-text('History')");
    await page.locator(".grow", { hasText: "Merge branch 'hotfix/greeting'" }).first().click();
    await page.waitForTimeout(600);
    await shot("07-history-dark");
    await page.click(".view-tab:has-text('Changes')");
    await page.waitForTimeout(500);
    await shot("08-changes-dark");
  });

  if (errors.length) throw new Error("console errors: " + errors.join(" | "));
} catch (e) {
  failed = true;
  if (!results.some((r) => r.startsWith("FAIL"))) results.push("FAIL " + e.message);
} finally {
  await close();
  console.log(results.join("\n"));
  console.log(`screenshots: ${out}`);
  if (errors.length) console.log("console errors:\n" + errors.join("\n"));
  if (!process.argv.includes("--keep") && !failed) {
    // The app may still be shutting down and holding the folder; cleanup is best effort.
    try {
      fs.rmSync(path.join(work, "env"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      /* left in the temp folder */
    }
  }
  process.exit(failed ? 1 : 0);
}
