// End-to-end UI smoke test against the built app (WebView2 + CDP).
//   node scripts/ui-smoke.mjs [--exe path] [--out dir] [--keep] [--visible]
// Builds a demo repository, drives the real UI through the main workflows and
// verifies the resulting git state with the git CLI. Screenshots go to --out.
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./ui-driver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const exe = arg("--exe", path.join(projectRoot, "src-tauri/target/release/revqora.exe"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "revqora-smoke-"));
const out = arg("--out", process.env.REVQORA_SMOKE_OUT || path.join(work, "shots"));
fs.mkdirSync(out, { recursive: true });

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
execFileSync(bash, [path.join(here, "make-demo-repo.sh").replace(/\\/g, "/"), path.join(work, "env").replace(/\\/g, "/")], { stdio: "ignore" });
const repo = path.join(work, "env", "demo");
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
git("config", "core.hooksPath", path.join(repo, ".git", "hooks"));

// A fake release feed with a much newer version, so the update chip can be exercised offline.
const feed = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ tag_name: "v99.0.0", body: ["## Highlights", "- Faster graph", "- **New** update chip"].join("\n"), html_url: "https://github.com/bitcodepro/Revqora/releases/tag/v99.0.0", published_at: new Date().toISOString(), assets: [] }));
});
await new Promise((r) => feed.listen(0, "127.0.0.1", r));
process.env.REVQORA_UPDATE_FEED = `http://127.0.0.1:${feed.address().port}/`;

let step = 0;
const results = [];
// Exercise the portable-profile-inside-repo case without adding runtime files
// to staging/checkpoints. The production watcher must ignore this exact folder.
const smokeProfile = path.join(repo, ".revqora-smoke-profile");
fs.mkdirSync(smokeProfile);
fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n/.revqora-smoke-profile/\n");
let { page, close, child } = await launch({ exe, args: [repo], profile: smokeProfile, port: 0 });
const errors = [];
const attachPage = () => {
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
};
attachPage();

async function check(name, fn) {
  step++;
  try {
    await fn();
    results.push(`ok   ${step}. ${name}`);
  } catch (e) {
    results.push(`FAIL ${step}. ${name}: ${e.message.split("\n")[0]}`);
    console.log(e.stack ?? String(e));
    await page.screenshot({ path: path.join(out, `fail-${step}.png`) }).catch(() => {});
    throw e;
  }
}
const shot = (n) => page.screenshot({ path: path.join(out, `${n}.png`) });
const until = async (fn, msg, ms = 8000) => {
  const t = Date.now();
  let lastError = null;
  while (Date.now() - t < ms) {
    // A git command polled while the app rewrites refs (rebase, merge) can fail for a moment:
    // treat that as "not yet" and retry.
    try {
      if (await fn()) return;
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    await page.waitForTimeout(120);
  }
  throw new Error(lastError ? `${msg} (last error: ${lastError.message})` : msg);
};

let failed = false;
try {
  await check("first-run guide can be skipped", async () => {
    await page.waitForSelector(".modal:has-text('Welcome to Revqora')", { timeout: 20000 });
    await page.click(".modal button:has-text('Skip')");
    await page.waitForSelector(".modal", { state: "detached" });
  });

  await check("a newer release shows the update chip, which can be skipped", async () => {
    const chip = page.locator(".update-chip");
    await chip.waitFor({ timeout: 20000 });
    if (!/Update 99\.0\.0/.test(await chip.innerText())) throw new Error(`chip shows: ${await chip.innerText()}`);
    await chip.click();
    const card = page.locator(".update-card");
    await card.waitFor();
    const text = await card.innerText();
    if (!text.includes("Revqora 99.0.0 is available") || !text.includes("Faster graph")) throw new Error(`card shows: ${text}`);
    // Development builds are not release packages: only the download link is offered.
    await card.locator("button:has-text('Download')").waitFor();
    await shot("17-update");
    await card.locator("button:has-text('Skip this version')").click();
    await chip.waitFor({ state: "detached" });
  });

  await check("portable profile writes do not trigger repository refresh storms", async () => {
    const listener = await page.evaluate(async () => {
      window.__profileSignals = [];
      return window.__TAURI_INTERNALS__.invoke("plugin:event|listen", { event: "repo-changed", target: { kind: "Any" }, handler: window.__TAURI_INTERNALS__.transformCallback((e) => window.__profileSignals.push(e.payload)) });
    });
    const userFile = path.join(repo, "watcher-user-probe.txt");
    try {
      for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(smokeProfile, "watcher-profile-probe.tmp"), String(i)); await page.waitForTimeout(200); }
      await page.waitForTimeout(700); // More than the watcher's 350ms debounce.
      // Initial background ref checks may legitimately report Git metadata.
      if (await page.evaluate(() => window.__profileSignals.some((e) => e.worktree))) throw new Error("portable profile writes caused a repository refresh");
      fs.writeFileSync(userFile, "User changes must still be watched\n");
      await page.waitForFunction(() => window.__profileSignals.some((e) => e.worktree), null, { timeout: 10000 });
    } finally {
      await page.evaluate(async (eventId) => { window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener("repo-changed", eventId); await window.__TAURI_INTERNALS__.invoke("plugin:event|unlisten", { event: "repo-changed", eventId }); }, listener);
      fs.rmSync(userFile, { force: true });
    }
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
    // The panel can be hidden again with its "Hide" tab and with Esc.
    await page.click(".details-hide");
    await page.waitForSelector(".details", { state: "detached" });
    await page.locator(".grow", { hasText: "Document usage" }).click();
    await page.waitForSelector(".details .file-row");
    await page.locator(".graph-scroll").press("Escape");
    await page.waitForSelector(".details", { state: "detached" });
    await page.locator(".grow", { hasText: "Document usage" }).click();
    await page.waitForSelector(".details .file-row");
  });

  await check("commit previews reuse files and diffs while signature verification stays optional", async () => {
    await page.evaluate(() => {
      const original = window.fetch;
      const base = window.__TAURI_INTERNALS__.convertFileSrc("", "ipc");
      window.__previewFetch = original; window.__previewReads = []; window.__signatureRelease = null;
      window.fetch = async function(input, init) {
        const command = String(input).startsWith(base) ? String(input).slice(base.length) : "";
        if (["commit_details", "rev_diff", "commit_signature"].includes(command)) window.__previewReads.push(command);
        const response = await original.call(this, input, init);
        if (command === "commit_signature") await new Promise((resolve) => { window.__signatureRelease = resolve; });
        return response;
      };
    });
    try {
      const select = async (subject) => { await page.locator(".grow:not(.wip)", { hasText: subject }).click(); await page.waitForSelector(`.commit-subject:has-text('${subject}')`); await page.waitForSelector(".details .diff .dl"); };
      await select("Enable debug mode");
      await select("Document usage");
      await select("Enable debug mode");
      const before = await page.evaluate(() => [...window.__previewReads]);
      if (before.filter((c) => c === "commit_details").length !== 1 || before.filter((c) => c === "rev_diff").length !== 1 || before.includes("commit_signature")) throw new Error(`preview did unnecessary Git work: ${before}`);
      await page.click(".commit-signature-check");
      await page.waitForFunction(() => typeof window.__signatureRelease === "function");
      if (!(await page.locator(".details .file-row").count()) || !(await page.locator(".details .diff .dl").count())) throw new Error("signature verification hid loaded files or diff");
      await select("Document usage");
      await page.evaluate(() => window.__signatureRelease());
      await page.waitForSelector(".commit-signature-check:not([disabled]):has-text('Verify signature')");
      const after = await page.evaluate(() => [...window.__previewReads]);
      if (after.filter((c) => c === "commit_details").length !== 1 || after.filter((c) => c === "rev_diff").length !== 1 || after.filter((c) => c === "commit_signature").length !== 1) throw new Error(`cached revisit reran Git: ${after}`);
      await shot("50-preview-cache");
    } finally { await page.evaluate(() => { window.__signatureRelease?.(); window.fetch = window.__previewFetch; }); }
  });

  await check("search filters commits", async () => {
    await page.fill(".search-box input", "greeting");
    await until(async () => (await page.locator(".grow.match").count()) >= 2, "no search matches");
    await page.fill(".search-box input", "");
  });

  await check("review mode shows commits, files and a full-height diff", async () => {
    await page.click(".history-mode button:has-text('Review')");
    await page.waitForSelector(".review .grow.compact");
    await page.locator(".review .grow.compact", { hasText: "Merge branch 'feature/auth'" }).click();
    await page.waitForSelector(".review-details .file-row");
    await page.waitForSelector(".review-details .diff .dl");
    // Arrow keys move between commits without the graph.
    await page.locator(".review .graph-scroll").press("ArrowDown");
    await until(async () => (await page.locator(".review .grow.compact.selected").innerText()).includes("Enable debug mode"), "ArrowDown did not select the next commit");
    await page.waitForSelector(".review-details .diff .dl");
    // Alt+arrows step through files with the commit list focused, without changing the commit.
    await page.locator(".review .graph-scroll").press("End");
    // Wait for this commit's details (three files), not the previous commit's file list.
    await page.waitForSelector(".review-details .commit-subject:has-text('Initial project structure')");
    await until(async () => (await page.locator(".review-details .file-row").count()) === 3, "commit files did not load");
    await page.waitForSelector(".review-details .file-row.selected");
    const firstFile = await page.locator(".review-details .file-row.selected").innerText();
    // The selected file carries over between commits; step towards the side that has a neighbour.
    const atEnd = await page.locator(".review-details .file-row").last().evaluate((el) => el.classList.contains("selected"));
    const key = atEnd ? "Alt+ArrowUp" : "Alt+ArrowDown";
    await page.locator(".review .graph-scroll").press(key);
    await until(async () => (await page.locator(".review-details .file-row.selected").innerText()) !== firstFile, `${key} did not move to another file`);
    const selected = await page.locator(".review .grow.compact.selected").innerText();
    if (!selected.includes("Initial project structure")) throw new Error(`${key} changed the commit to: ${selected}`);
    await shot("18-review");
    await page.click(".review-details .details-hide");
    await page.waitForSelector(".review-details", { state: "detached" });
    const historyOnly = await page.locator(".review-list").boundingBox();
    const reviewBounds = await page.locator(".review").boundingBox();
    if (historyOnly.height < reviewBounds.height - 2) throw new Error("closing preview did not return space to history");
    await page.locator(".review .graph-scroll").press("End");
    await page.waitForSelector(".review-details .commit-subject");
    await page.click(".history-mode button:has-text('Graph')");
    await page.waitForSelector(".graph-cols");
  });

  await check("typing into a dialog keeps every character", async () => {
    await page.click(".tb-btn:has-text('Branch')");
    const input = page.locator(".modal input.input");
    await input.waitFor();
    await page.waitForTimeout(200);
    // Real key presses with pauses: each re-render must not re-select (and so replace) the text.
    await page.keyboard.type("feat/typed-name", { delay: 80 });
    const value = await input.inputValue();
    if (value !== "feat/typed-name") throw new Error(`input holds ${JSON.stringify(value)}`);
    // Text fields carry no dropdown chevron (only selects do).
    const bg = await input.evaluate((el) => getComputedStyle(el).backgroundImage);
    if (bg !== "none") throw new Error(`text input has a background image: ${bg.slice(0, 60)}`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached" });
  });

  await check("stage a single line from the diff", async () => {
    await page.click(".view-tab:has-text('Changes')");
    // A status refresh right after switching views can rebuild the list and drop the
    // selection, so click again until the diff for app.ts is actually shown.
    await until(
      async () => {
        await page.locator(".changes .file-row", { hasText: "app.ts" }).first().click({ timeout: 3000 }).catch(() => {});
        return page
          .waitForSelector(".diff-head .path:has-text('app.ts')", { timeout: 2000 })
          .then(() => page.waitForSelector(".changes .diff .dl.add", { timeout: 2000 }))
          .then(() => true, () => false);
      },
      "diff for app.ts did not open",
      20000,
    );
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
    await page.waitForSelector(".changes[data-pending='false']");
    // Reproduce a real response ordering: refresh's status was read before add,
    // its layer list after add, while add's completion is still in transit.
    // Delay transport responses; do not fabricate repository state or bypass Git.
    await page.evaluate(() => {
      const original = window.fetch;
      let staged;
      const stageDone = new Promise((resolve) => { staged = resolve; });
      let release;
      const completion = new Promise((resolve) => { release = resolve; });
      window.__layerRace = { statusHeld: false, release: () => { window.fetch = original; release(); } };
      let firstStatus = true, firstLayers = true;
      window.fetch = async (url, init) => {
        const command = decodeURIComponent(new URL(url).pathname.slice(1));
        if (command === "layers_state" && firstLayers) { firstLayers = false; await stageDone; }
        const response = await original(url, init);
        if (command === "status" && firstStatus) {
          firstStatus = false;
          await response.clone().json();
          window.__layerRace.statusHeld = true;
          await stageDone;
        }
        if (command === "stage") { await response.clone().json(); staged(); await completion; }
        return response;
      };
    });
    await page.click("button[title='Refresh (F5)']");
    await page.waitForFunction(() => window.__layerRace.statusHeld);
    await page.locator(".file-row", { hasText: "config.json" }).first().hover();
    await page.locator(".file-row", { hasText: "config.json" }).first().locator("button[title='Stage']").click();
    await until(async () => (await page.locator(".open-layer .file-row", { hasText: "config.json" }).count()) === 1, "config.json not in open layer");
    if (!(await page.locator(".layer:not(.open-layer) button[title='Unstage layer']").isDisabled())) throw new Error("layer action enabled before staging completion/state refresh");
    await shot("04-layers");
    await page.evaluate(() => window.__layerRace.release());
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

  await check("repository panels collapse independently and review files can be resized", async () => {
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.click(".view-tab:has-text('History')");
    await page.click(".history-mode button:has-text('Review')");
    await page.locator(".review .graph-scroll").press("End");
    await page.waitForSelector(".commit-details .file-row");
    const list = await page.locator(".review-list").boundingBox();
    const details = await page.locator(".review-details").boundingBox();
    if (list.y >= details.y) throw new Error("review commits should be above the diff");
    await page.click(".branches-toggle");
    await page.waitForSelector(".branches-slot", { state: "hidden" });
    await page.click(".branches-toggle");
    await page.waitForSelector(".branches-slot", { state: "visible" });
    await page.click(".topbar button[aria-label='Toggle repositories panel']");
    await page.waitForSelector(".repository-slot", { state: "hidden" });
    await page.click(".topbar button[aria-label='Toggle repositories panel']");
    await page.waitForSelector(".repository-slot", { state: "visible" });
    // Give a growing pane actual headroom instead of depending on the runner's display.
    await page.setViewportSize({ width: 1600, height: 900 });
    const before = await page.locator(".commit-details .details-left").evaluate((el) => el.clientWidth);
    const splitter = await page.locator(".commit-details > .splitter-v").boundingBox();
    await page.mouse.move(splitter.x + 3, splitter.y + 180);
    await page.mouse.down();
    await page.mouse.move(splitter.x + 70, splitter.y + 180, { steps: 8 });
    await page.mouse.up();
    const after = await page.locator(".commit-details .details-left").evaluate((el) => el.clientWidth);
    if (after < before + 40) throw new Error("file list did not resize");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("revqora.settings")).state.layouts.review.commitFilesWidth);
    if (Math.abs(saved - (before + 67)) > 4) throw new Error("preferred file list width was not persisted");
    // A narrower window clamps the rendered width without rewriting the preference.
    await page.setViewportSize({ width: 1028, height: 760 });
    const containerWidth = await page.locator(".commit-details").evaluate((el) => el.clientWidth);
    const narrowBefore = await page.locator(".commit-details .details-left").evaluate((el) => el.clientWidth);
    const clamped = (preferred) => Math.max(140, Math.min(preferred, containerWidth * .45));
    if (Math.abs(narrowBefore - clamped(saved)) > 2) throw new Error("file list did not respect the available width");
    if (await page.evaluate(() => JSON.parse(localStorage.getItem("revqora.settings")).state.layouts.review.commitFilesWidth) !== saved) throw new Error("viewport resize overwrote preferred file list width");
    const target = Math.max(140, narrowBefore - 60);
    const narrowSplitter = await page.locator(".commit-details > .splitter-v").boundingBox();
    const x = narrowSplitter.x + narrowSplitter.width / 2, y = narrowSplitter.y + narrowSplitter.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + target - saved, y, { steps: 8 });
    await page.mouse.up();
    const narrowAfter = await page.locator(".commit-details .details-left").evaluate((el) => el.clientWidth);
    const narrowSaved = await page.evaluate(() => JSON.parse(localStorage.getItem("revqora.settings")).state.layouts.review.commitFilesWidth);
    if (narrowBefore - narrowAfter < 40) throw new Error("file list did not shrink in a narrow window");
    if (Math.abs(narrowSaved - target) > 4 || Math.abs(narrowAfter - clamped(narrowSaved)) > 2) throw new Error("narrow resize did not persist preferred width independently of its layout clamp");
    await shot("24-resize-narrow");
    await page.setViewportSize(viewport);
    await page.click(".focus-toggle");
    await page.waitForSelector(".repository-slot", { state: "hidden" });
    await page.waitForSelector(".branches-slot", { state: "hidden" });
    await page.waitForSelector(".review-list", { state: "hidden" });
    await shot("19-focus");
    await page.click(".focus-toggle");
    await page.waitForSelector(".repository-slot", { state: "visible" });
    await page.waitForSelector(".branches-slot", { state: "visible" });
    await page.setViewportSize({ width: 980, height: 700 });
    const fits = await page.evaluate(() => document.querySelector(".app").scrollWidth <= innerWidth + 1);
    if (!fits) throw new Error("workspace overflowed the minimum window width");
    await page.setViewportSize(viewport);
    await page.click(".history-mode button:has-text('Graph')");
  });

  await check("column history keeps independent panel sizes, visibility and focus after reload", async () => {
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 1650, height: 950 });
    const layouts = () => page.evaluate(() => JSON.parse(localStorage.getItem("revqora.settings")).state.layouts);
    const drag = async (selector, dx) => {
      const box = await page.locator(selector).boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, { steps: 8 }); await page.mouse.up();
    };
    const before = await layouts();
    await page.click(".history-mode button:has-text('Columns')");
    await page.waitForSelector(".columns-details .commit-message-open:not(:disabled)");
    const positions = await page.locator(".repository-slot, .branches-slot, .columns-commits, .columns-details .details-left, .columns-details .diff").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x));
    if (positions.length !== 5 || positions.some((x, i) => i > 0 && x <= positions[i - 1])) throw new Error("repository, branch, commit, file and diff columns are out of order");
    await drag(".repository-sidebar > .splitter-v", 20);
    await drag(".workspace > .splitter-v", 20);
    await page.click(".topbar button[aria-label='Toggle repositories panel']");
    await page.click(".branches-toggle");
    await drag(".columns-history > .splitter-v", 60);
    await drag(".commit-details > .splitter-v", 40);
    await page.click(".topbar button[aria-label='Toggle repositories panel']");
    await page.click(".branches-toggle");
    await page.click(".focus-toggle");
    await page.waitForSelector(".repository-slot", { state: "hidden" });
    await page.waitForSelector(".branches-slot", { state: "hidden" });
    await page.waitForSelector(".columns-commits", { state: "visible" });
    const expected = (await layouts()).columns;
    if (expected.repositoriesWidth < before.columns.repositoriesWidth + 15 || expected.sidebarWidth < before.columns.sidebarWidth + 15 || expected.historyListWidth < before.columns.historyListWidth + 50 || expected.commitFilesWidth < before.columns.commitFilesWidth + 30) throw new Error("column widths were not persisted");
    await page.click(".history-mode button:has-text('Review')");
    await page.waitForSelector(".repository-slot", { state: "visible" });
    await page.waitForSelector(".branches-slot", { state: "visible" });
    if (JSON.stringify((await layouts()).review) !== JSON.stringify(before.review)) throw new Error("Columns changed Review's preferences");
    await page.click(".branches-toggle");
    await page.click(".history-mode button:has-text('Graph')");
    await page.waitForSelector(".branches-slot", { state: "visible" });
    if (JSON.stringify((await layouts()).graph) !== JSON.stringify(before.graph)) throw new Error("another layout changed Graph's preferences");
    await page.click(".history-mode button:has-text('Columns')");
    await page.waitForSelector(".repository-slot", { state: "hidden" });
    if (JSON.stringify((await layouts()).columns) !== JSON.stringify(expected)) throw new Error("Columns preferences were not restored");
    await page.reload();
    await page.waitForSelector(".columns-commits .grow:not(.wip) .text", { timeout: 20000 });
    await page.waitForSelector(".repository-slot", { state: "hidden" });
    await page.waitForSelector(".branches-slot", { state: "hidden" });
    if (JSON.stringify((await layouts()).columns) !== JSON.stringify(expected)) throw new Error("reload lost the saved column layout");
    await page.locator(".columns-commits .graph-scroll").press("End");
    await page.waitForSelector(".columns-details .commit-subject:has-text('Initial project structure')");
    await page.waitForSelector(".columns-details .diff .dl");
    await shot("26-three-columns");
    await page.keyboard.press("Control+Shift+r");
    await page.waitForSelector(".history-mode button.on:has-text('Graph')");
    await page.keyboard.press("Control+Shift+r");
    await page.waitForSelector(".history-mode button.on:has-text('Review')");
    await page.keyboard.press("Control+Shift+r");
    await page.waitForSelector(".history-mode button.on:has-text('Columns')");
    await page.click(".history-mode button:has-text('Graph')");
    await page.setViewportSize(viewport);
  });

  await check("branch deletion supports local-only, remote, force confirmation and partial failure", async () => {
    const localExists = (name) => git("branch", "--list", name) !== "";
    const remoteExists = (name) => git("ls-remote", "--heads", "origin", "refs/heads/" + name) !== "";
    const create = (name, remoteName = name, start = "HEAD") => {
      git("branch", name, start);
      git("push", "-q", "origin", `${name}:refs/heads/${remoteName}`);
      git("branch", `--set-upstream-to=origin/${remoteName}`, name);
    };
    const openDelete = async (name) => {
      await page.fill(".sidebar input[placeholder^='Filter branches']", name);
      await page.click("button[title='Refresh (F5)']");
      await page.locator(`.sidebar [data-branch-kind='local'][data-branch-name='${name}']`).click({ button: "right" });
      await page.locator(".ctx-item").filter({ hasText: /^Delete…$/ }).click();
      await page.waitForSelector(".modal .delete-remote-branch");
      await page.waitForSelector(".branch-review[aria-busy='false'][data-review-local-oid]");
    };
    create("ui-local-only");
    await openDelete("ui-local-only");
    if (await page.locator(".delete-remote-branch").isChecked()) throw new Error("remote deletion must be opt-in");
    await page.click(".delete-branch-confirm");
    await page.waitForSelector(".modal", { state: "detached" });
    if (localExists("ui-local-only") || !remoteExists("ui-local-only")) throw new Error("local-only deletion touched the remote or kept the local branch");
    git("push", "-q", "origin", ":refs/heads/ui-local-only");
    create("ui-delete-both", "published/ui-delete-both");
    git("push", "-q", "origin", "ui-delete-both:refs/heads/ui-delete-both");
    await openDelete("ui-delete-both");
    await page.check(".delete-remote-branch");
    await page.waitForSelector("select[aria-label='Remote branch']");
    if (await page.locator("select[aria-label='Remote branch']").inputValue() !== JSON.stringify(["origin", "refs/heads/published/ui-delete-both"])) throw new Error("delete dialog did not prefer the configured upstream");
    await shot("27-delete-both");
    await page.click(".delete-branch-confirm");
    await page.waitForSelector(".modal", { state: "detached" });
    if (localExists("ui-delete-both") || remoteExists("published/ui-delete-both") || !remoteExists("ui-delete-both")) throw new Error("combined deletion did not delete only the selected upstream");
    git("push", "-q", "origin", ":refs/heads/ui-delete-both");
    for (const pushed of [false, true]) {
      create("ui-unmerged");
      const tip = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-p", "HEAD", "-m", "Branch-only commit");
      git("update-ref", "refs/heads/ui-unmerged", tip);
      if (pushed) git("push", "-q", "origin", "ui-unmerged");
      await openDelete("ui-unmerged");
      await page.check(".delete-remote-branch");
      await page.click(".delete-branch-confirm");
      await page.waitForSelector(".force-delete-branch");
      if (!(await page.locator(".delete-branch-confirm").isDisabled()) || !localExists("ui-unmerged") || !remoteExists("ui-unmerged")) throw new Error("unmerged guard deleted a ref before force confirmation");
      if (pushed) {
        await shot("29-pushed-unmerged-guard");
        await page.check(".force-delete-branch");
        await page.uncheck(".delete-remote-branch");
        await page.waitForSelector(".force-delete-branch", { state: "detached" });
        if ((await page.locator(".delete-branch-confirm").innerText()).includes("Force")) throw new Error("force acknowledgement leaked into another deletion mode");
        await page.check(".delete-remote-branch");
        await page.click(".delete-branch-confirm");
        await page.waitForSelector(".force-delete-branch");
        if (!(await page.locator(".delete-branch-confirm").isDisabled())) throw new Error("combined deletion reused an old force acknowledgement");
      }
      await page.click(".modal button:has-text('Cancel')");
      await openDelete("ui-unmerged");
      await page.check(".delete-remote-branch");
      await page.click(".delete-branch-confirm");
      await page.waitForSelector(".force-delete-branch");
      await page.check(".force-delete-branch");
      await page.click(".delete-branch-confirm");
      await page.waitForSelector(".modal", { state: "detached" });
      if (localExists("ui-unmerged") || remoteExists("ui-unmerged")) throw new Error("explicit force confirmation did not complete deletion");
    }
    // The tracking alias deliberately matches an unrelated, real server branch.
    create("ui-mapped");
    git("push", "-q", "origin", "ui-mapped:refs/heads/ui-mapped-alias");
    const fetchSpecs = git("config", "--get-all", "remote.origin.fetch").split(/\r?\n/);
    git("config", "remote.origin.fetch", "+refs/heads/ui-mapped:refs/remotes/origin/ui-mapped-alias");
    git("fetch", "-q", "origin");
    try {
      await openDelete("ui-mapped");
      await page.check(".delete-remote-branch");
      if (!(await page.locator(".modal").innerText()).includes("origin/ui-mapped")) throw new Error("resolved server branch missing from dialog");
      await page.click(".delete-branch-confirm");
      await page.waitForSelector(".modal", { state: "detached" });
      if (localExists("ui-mapped") || remoteExists("ui-mapped") || !remoteExists("ui-mapped-alias")) throw new Error("custom fetch mapping deleted the wrong server ref");
    } finally {
      git("config", "--unset-all", "remote.origin.fetch");
      for (const spec of fetchSpecs) git("config", "--add", "remote.origin.fetch", spec);
    }
    git("push", "-q", "origin", ":refs/heads/ui-mapped-alias");
    create("ui-failed-remote", "ui-failed-remote", "HEAD~1");
    const originalLocalOid = git("rev-parse", "ui-failed-remote");
    const deletedLocalOid = git("rev-parse", "HEAD");
    if (originalLocalOid === deletedLocalOid) throw new Error("refreshed-deletion fixture needs distinct local tips A and B");
    const pushUrl = git("remote", "get-url", "--push", "origin");
    const hook = path.join(path.resolve(repo, pushUrl), "hooks", "pre-receive");
    const other = path.join(work, "env", "deletion-other-clone");
    git("clone", "-q", "--branch", "ui-failed-remote", pushUrl, other);
    const otherGit = (...args) => execFileSync("git", ["-C", other, "-c", "commit.gpgsign=false", "-c", "user.name=Other clone", "-c", "user.email=other@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    fs.writeFileSync(hook, "#!/bin/sh\necho 'Server temporarily refuses updates' >&2\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    try {
      await openDelete("ui-failed-remote");
      // Review A, advance the local branch externally to B, then explicitly refresh.
      // After local B is deleted, every remote retry must retain B, not the initial A.
      git("update-ref", "refs/heads/ui-failed-remote", deletedLocalOid, originalLocalOid);
      await page.click(".refresh-branch-review");
      await page.waitForSelector(`.branch-review[aria-busy='false'][data-review-local-oid='${deletedLocalOid}']`);
      await page.check(".delete-remote-branch");
      await page.click(".delete-branch-confirm");
      await page.waitForSelector(".delete-branch-error:has-text('Local branch deleted. Remote deletion failed')");
      if (localExists("ui-failed-remote") || !remoteExists("ui-failed-remote")) throw new Error("partial deletion state was reported incorrectly");
      await shot("28-delete-remote-failed");
      fs.unlinkSync(hook);
      otherGit("commit", "--allow-empty", "-qm", "Unseen server commit");
      otherGit("push", "-q", "origin", "ui-failed-remote");
      const changed = otherGit("rev-parse", "HEAD");
      // Retry must keep the original lease even after the local part succeeded.
      await page.click(".delete-branch-confirm");
      await page.waitForSelector(".branch-review[data-remote-changed='true']");
      if (!(await page.locator(".delete-branch-confirm").isDisabled()) || !remoteExists("ui-failed-remote")) throw new Error("retry deleted an unseen server tip");
      await page.click(".refresh-remote-deletion");
      await page.waitForSelector(".remote-deletion-review");
      if (!(await page.locator(".remote-deletion-review").innerText()).includes(changed.slice(0, 12))) throw new Error("refreshed remote SHA missing");
      if (!(await page.locator(".delete-branch-confirm").isDisabled())) throw new Error("refreshed tip did not require new consent");
      await shot("38-remote-deletion-review");
      await page.check(".confirm-reviewed-remote");
      // Even explicit force consent must not delete a subsequent server tip.
      otherGit("commit", "--allow-empty", "-qm", "Another unseen server commit");
      otherGit("push", "-q", "origin", "ui-failed-remote");
      await page.click(".delete-branch-confirm");
      await page.waitForSelector(".branch-review[data-remote-changed='true']");
      if (!remoteExists("ui-failed-remote")) throw new Error("force deleted a newer unseen tip");
      await page.click(".refresh-remote-deletion");
      await page.waitForSelector(".remote-deletion-review");
      if (await page.locator(".confirm-reviewed-remote").isChecked()) throw new Error("old remote consent leaked into refreshed state");
      await page.check(".confirm-reviewed-remote");
      await page.click(".delete-branch-confirm");
      await page.waitForSelector(".modal", { state: "detached" });
      if (remoteExists("ui-failed-remote")) throw new Error("remote retry failed");
      // Follow the success action to the FINAL remote checkpoint, not the earlier
      // local checkpoint that still retains B even when this regression occurs.
      const notice = page.locator(".toast").filter({ hasText: "Deleted ui-failed-remote and origin/ui-failed-remote" });
      const checkpointId = (await notice.innerText()).match(/Recovery checkpoint (\S+) saved/)?.[1];
      if (!checkpointId) throw new Error("final recovery checkpoint ID missing");
      await notice.getByRole("button", { name: "Open recovery checkpoint", exact: true }).click();
      await page.locator(`.recovery-detail[data-checkpoint-id='${checkpointId}']`).waitFor();
      const branchOption = await page.locator("select[aria-label='Saved recovery reference'] option").evaluateAll((options) => options.find((o) => o.textContent.startsWith("refs/heads/ui-failed-remote ·"))?.value);
      if (branchOption === undefined) throw new Error("deleted local reference missing from final checkpoint");
      await page.selectOption("select[aria-label='Saved recovery reference']", branchOption);
      await page.fill("input[aria-label='Recovered local branch']", "ui-refreshed-deletion-recovery");
      await page.getByRole("button", { name: "Restore branch", exact: true }).click();
      await until(() => localExists("ui-refreshed-deletion-recovery"), "final checkpoint did not restore the deleted branch", 15000);
      const restoredOid = git("rev-parse", "ui-refreshed-deletion-recovery");
      if (restoredOid !== deletedLocalOid) throw new Error(`final checkpoint restored ${restoredOid} instead of deleted local tip ${deletedLocalOid} (initial review ${originalLocalOid})`);
      await page.waitForSelector(".recovery-center[aria-busy='false']");
      await shot("49-refreshed-deletion-recovery");
      await page.locator(".modal button", { hasText: /^Close$/ }).click();
      git("branch", "-D", "ui-refreshed-deletion-recovery");
    } finally { if (fs.existsSync(hook)) fs.unlinkSync(hook); }
    await page.fill(".sidebar input[placeholder^='Filter branches']", "");
  });

  await check("deletion review selects its target and opens the exact recovery checkpoint", async () => {
    const openDelete = async (name) => {
      await page.fill(".sidebar input[placeholder^='Filter branches']", name);
      await page.click("button[title='Refresh (F5)']");
      await page.locator(`.sidebar [data-branch-kind='local'][data-branch-name='${name}']`).click({ button: "right" });
      await page.locator(".ctx-item").filter({ hasText: /^Delete…$/ }).click();
      await page.waitForSelector(".branch-review[aria-busy='false'][data-review-local-oid]");
    };
    const original = git("rev-parse", "HEAD");
    const tip = git("-c", "commit.gpgsign=false", "commit-tree", git("rev-parse", "HEAD^{tree}"), "-p", "HEAD", "-m", "Squash-integrated history");
    git("branch", "ui-review-source", tip);
    git("branch", "ui-review-target", tip);
    await openDelete("ui-review-source");
    if (!(await page.locator(".branch-review-integration").innerText()).includes("Changes appear integrated")) throw new Error("squash estimate missing");
    await page.click(".delete-branch-confirm");
    await page.waitForSelector(".force-delete-branch");
    if (!git("branch", "--list", "ui-review-source")) throw new Error("squash estimate bypassed force consent");
    await shot("44-squash-review");
    await page.selectOption("select[aria-label='Comparison branch']", "refs/heads/ui-review-target");
    await page.waitForSelector(".branch-review[aria-busy='false'][data-review-local-oid]");
    if (await page.locator(".force-delete-branch").count()) throw new Error("target change retained force consent");
    if (!(await page.locator(".branch-review-integration").innerText()).includes("0 local commits outside target")) throw new Error("selected comparison target was ignored");
    await shot("45-selected-deletion-target");
    await page.click(".delete-branch-confirm");
    await page.waitForSelector(".modal", { state: "detached" });
    if (git("branch", "--list", "ui-review-source") || git("rev-parse", "HEAD") !== original) throw new Error("selected-target deletion affected the current branch");
    const notice = page.locator(".toast").filter({ hasText: "Deleted local branch ui-review-source" });
    const id = (await notice.innerText()).match(/Recovery checkpoint (\S+) saved/)?.[1];
    if (!id) throw new Error("saved checkpoint ID missing from deletion notice");
    await notice.getByRole("button", { name: "Open recovery checkpoint", exact: true }).click();
    await page.locator(`.recovery-detail[data-checkpoint-id='${id}']`).waitFor();
    const sourceOption = await page.locator("select[aria-label='Saved recovery reference'] option").evaluateAll((options) => options.find((o) => o.textContent.startsWith("refs/heads/ui-review-source ·"))?.value);
    if (!sourceOption) throw new Error("deleted source reference missing from its checkpoint");
    await page.selectOption("select[aria-label='Saved recovery reference']", sourceOption);
    await page.fill("input[aria-label='Recovered local branch']", "ui-review-restored");
    await page.getByRole("button", { name: "Restore branch", exact: true }).click();
    await until(() => git("rev-parse", "--verify", "--quiet", "refs/heads/ui-review-restored") === tip, "deletion checkpoint did not restore the exact branch tip", 15000);
    await shot("46-deletion-checkpoint");
    await page.locator(".modal button", { hasText: /^Close$/ }).click();
    git("branch", "-D", "ui-review-target", "ui-review-restored");

    // The remote-list menu must use the same reviewed, leased deletion flow.
    git("push", "-q", "origin", "HEAD:refs/heads/ui-review-server-only");
    await page.fill(".sidebar input[placeholder^='Filter branches']", "ui-review-server-only");
    await page.click("button[title='Refresh (F5)']");
    await page.locator(".sidebar [data-branch-kind='remote'][data-branch-name='origin/ui-review-server-only']").click({ button: "right" });
    await page.locator(".ctx-item").filter({ hasText: /^Delete on remote…$/ }).click();
    await page.waitForSelector(".branch-review[aria-busy='false'][data-review-local-oid]");
    if (await page.locator(".delete-remote-branch").count()) throw new Error("remote-only deletion offered to remove a local branch");
    if (!(await page.locator(".modal").innerText()).includes("local branch and its worktrees are kept")) throw new Error("remote-only consequences missing");
    const localHead = git("rev-parse", "HEAD");
    const localIndex = fs.readFileSync(path.join(repo, ".git", "index"));
    await shot("48-direct-remote-review");
    await page.click(".delete-branch-confirm");
    // Wait for checkpoint + leased transport completion before checking Git state.
    await page.waitForSelector(".modal", { state: "detached", timeout: 60000 });
    if (git("ls-remote", "--heads", "origin", "refs/heads/ui-review-server-only") || git("rev-parse", "HEAD") !== localHead || !fs.readFileSync(path.join(repo, ".git", "index")).equals(localIndex)) throw new Error("direct remote deletion changed local work or kept the server branch");

    git("branch", "ui-review-worktree");
    const worktree = path.join(work, "env", "linked review проверка 'quoted'");
    git("worktree", "add", "-q", worktree, "ui-review-worktree");
    fs.writeFileSync(path.join(worktree, "manual-edit.txt"), "Keep this uncommitted edit\n");
    try {
      await openDelete("ui-review-worktree");
      const text = await page.locator(".branch-review-worktrees").innerText();
      const shownPath = await page.locator(".branch-review-worktrees code").innerText();
      const canonicalPath = (value) => {
        const canonical = fs.realpathSync.native(value).replaceAll("\\", "/");
        return process.platform === "win32" ? canonical.toLowerCase() : canonical;
      };
      if (canonicalPath(shownPath) !== canonicalPath(worktree)) throw new Error(`linked worktree path mismatch: expected ${worktree}, saw ${shownPath}`);
      if (!text.includes("1 changed files") || !(await page.locator(".delete-branch-confirm").isDisabled())) throw new Error("dirty checked-out branch was not blocked");
      await shot("47-worktree-deletion-review");
      await page.click(".modal button:has-text('Cancel')");
    } finally { git("worktree", "remove", "--force", worktree); git("branch", "-D", "ui-review-worktree"); }
    await page.fill(".sidebar input[placeholder^='Filter branches']", "");
    await page.click("button[title='Refresh (F5)']");
  });

  await check("twenty repositories support bulk fetch and clean fast-forward pull", async () => {
    const multi = path.join(work, "env", "multi");
    fs.mkdirSync(multi, { recursive: true });
    const seed = path.join(multi, "seed");
    const origin = path.join(multi, "origin.git");
    fs.mkdirSync(seed);
    const at = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    at(seed, "init", "-q", "-b", "main");
    at(seed, "config", "user.name", "Fixture");
    at(seed, "config", "user.email", "fixture@example.com");
    fs.writeFileSync(path.join(seed, "shared.txt"), "initial\n");
    fs.writeFileSync(path.join(seed, "tabs.txt"), "a\t".repeat(120) + "OLD_TAB_END\n");
    at(seed, "add", "-A");
    at(seed, "commit", "-qm", "Initial fixture");
    at(seed, "clone", "-q", "--bare", seed, origin);
    at(seed, "remote", "add", "origin", origin);
    const names = ["batch-clean", "batch-dirty", "batch-diverged", "batch-ready"];
    const repos = [];
    for (const name of names) { const dir = path.join(multi, name); at(seed, "clone", "-q", origin, dir); repos.push(dir); }
    fs.writeFileSync(path.join(repos[1], "draft.txt"), "local work\n");
    at(repos[2], "config", "user.name", "Fixture");
    at(repos[2], "config", "user.email", "fixture@example.com");
    fs.writeFileSync(path.join(repos[2], "local.txt"), "local commit\n");
    at(repos[2], "add", "-A");
    at(repos[2], "commit", "-qm", "Local-only fixture");
    const dirtyHead = at(repos[1], "rev-parse", "HEAD"), divergedHead = at(repos[2], "rev-parse", "HEAD");
    fs.writeFileSync(path.join(seed, "long.ts"), 'export const longLine = "' + "long-text-".repeat(100) + '";\n');
    fs.writeFileSync(path.join(seed, "tabs.txt"), "abc\t".repeat(120) + "NEW_TAB_END\n");
    fs.writeFileSync(path.join(seed, "large.txt"), Array.from({ length: 3200 }, (_, i) => i === 2200 ? "virtual-long-".repeat(120) : "line " + i).join("\n") + "\n");
    at(seed, "add", "-A");
    at(seed, "commit", "-qm", "Incoming fixture update keeps long commit messages readable across the whole preview header", "-m",
      "Explain why the change matters, preserving paragraphs and readable descriptions.\n\n- Keep the selected file\n- Keep the diff scroll position\n\n```ts\nconst message = '<script>text only</script>';\n```\n\n" + "Additional context for a long commit description.\n\n".repeat(36) + "Co-authored-by: Jane Example <jane@example.com>\nSigned-off-by: Fixture <fixture@example.com>");
    at(seed, "push", "-q", "origin", "main");
    const expected = at(seed, "rev-parse", "HEAD");
    for (let i = 4; i < 19; i++) { const dir = path.join(multi, "extra-" + String(i).padStart(2, "0")); at(seed, "clone", "-q", origin, dir); repos.push(dir); }
    await page.evaluate((paths) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: paths }), repos);
    await until(async () => await page.locator(".repository-item").count() === 20, "twenty repositories did not open", 60000);
    await page.click(".topbar button[aria-label='All repositories']");
    await page.waitForSelector(".repository-table tbody tr");
    await page.locator(".repository-overview .repository-sync button:has-text('Fetch all')").click();
    // Twenty sequential fetches also refresh refs/status; allow six seconds per repo on Windows.
    await until(async () => !(await page.locator(".statusbar .busy-item").count()), "bulk fetch did not finish", 120000);
    await until(async () => (await page.locator(".repository-table tbody tr", { hasText: "batch-clean" }).innerText()).includes("1"), "incoming commits were not refreshed", 20000);
    await shot("20-repositories");
    await page.locator(".repository-overview .repository-sync button:has-text('Pull all')").click();
    await page.waitForSelector(".modal:has-text('Pull repositories')");
    if (await page.locator(".modal input:checked").count() !== 2) throw new Error("only two clean incoming repositories should be selected");
    if (!(await page.locator(".modal .batch-row", { hasText: "batch-dirty" }).locator("input").isDisabled())) throw new Error("dirty repository should be skipped");
    if (!(await page.locator(".modal .batch-row", { hasText: "batch-diverged" }).locator("input").isDisabled())) throw new Error("diverged repository should be skipped");
    await page.click(".modal button:has-text('Pull (2)')");
    await page.waitForSelector(".modal:has-text('Pull results')", { timeout: 60000 });
    if (at(repos[0], "rev-parse", "HEAD") !== expected || at(repos[3], "rev-parse", "HEAD") !== expected) throw new Error("clean repositories were not fast-forwarded");
    if (at(repos[1], "rev-parse", "HEAD") !== dirtyHead || at(repos[2], "rev-parse", "HEAD") !== divergedHead) throw new Error("skipped repository HEAD changed");
    if (!fs.existsSync(path.join(repos[1], "draft.txt"))) throw new Error("local work disappeared");
    await page.click(".modal button:has-text('Done')");
    await page.locator(".repository-table .repository-name", { hasText: "batch-ready" }).click();
    await page.waitForSelector(".grow .text:has-text('Incoming fixture update')");
    await page.locator(".grow", { hasText: "Incoming fixture update" }).click();
    await page.waitForSelector(".details .file-row");
    await page.locator(".details .file-row", { hasText: "long.ts" }).click();
    await page.waitForSelector(".details .diff .dl.add .code:has-text('longLine')");
    await page.waitForSelector(".diff-hscroll");
    const overflow = () => page.locator(".details .diff-body").evaluate((el) => el.scrollWidth - el.clientWidth);
    if (await overflow() < 100) throw new Error("long lines should have horizontal scroll");
    await page.locator(".diff-hscroll input").fill("180");
    await until(async () => await page.locator(".details .diff-body").evaluate((el) => el.scrollLeft) > 100, "horizontal scroll did not move");
    await page.click(".diff-wrap");
    await until(async () => await overflow() <= 1, "wrapped unified diff overflowed");
    await page.click("button[title='Side by side']");
    await until(async () => await overflow() <= 1, "wrapped split diff overflowed");
    await page.click(".diff-wrap");
    await page.waitForSelector(".diff-hscroll");
    const right = await page.locator(".split-dl .half.add").first().boundingBox();
    const viewport = await page.locator(".details .diff-body").boundingBox();
    if (right.x >= viewport.x + viewport.width) throw new Error("right split column is outside the viewport");
    await page.locator(".diff-hscroll input").fill("180");
    await until(async () => await page.locator(".split-dl .half.add .code").first().evaluate((el) => el.getBoundingClientRect().left < el.parentElement.getBoundingClientRect().left - 100), "split columns did not pan together");
    await shot("21-long-lines");
    await page.locator(".details .file-row", { hasText: "tabs.txt" }).click();
    await page.waitForSelector(".split-dl .half.add .code:has-text('NEW_TAB_END')");
    await page.waitForSelector(".diff-hscroll input");
    const tabScroll = page.locator(".diff-hscroll input");
    await tabScroll.fill(String(Math.floor(Number(await tabScroll.getAttribute("max")))));
    await until(async () => await page.locator(".split-dl .half:not(.empty) .code").evaluateAll((nodes) => nodes.length === 2 && nodes.every((code) => {
      // Inspect the final glyphs, not the clipped span's full bounding box.
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let last = null;
      while (walker.nextNode()) last = walker.currentNode;
      if (!last) return false;
      const range = document.createRange();
      range.setStart(last, Math.max(0, last.textContent.length - 7));
      range.setEnd(last, last.textContent.length);
      const tail = range.getBoundingClientRect(), viewport = code.parentElement.getBoundingClientRect();
      return getComputedStyle(code).tabSize === "4" && tail.left >= viewport.left - 1 && tail.right <= viewport.right + 1;
    })), "tabbed split lines cannot be scrolled to their ends");
    await shot("25-tabbed-lines");
    await page.click("button[title='Unified']");
    await page.locator(".details .file-row", { hasText: "large.txt" }).click();
    await page.waitForSelector(".virtual-diff");
    await until(async () => await overflow() > 100, "virtual diff lost off-screen long lines");
    // Opening and dismissing a long message must leave the mounted diff untouched.
    await page.locator(".details .diff-body").evaluate((el) => { el.scrollTop = 800; el.scrollLeft = 160; });
    await page.waitForTimeout(100);
    const scrollBefore = await page.locator(".details .diff-body").evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    const fileBefore = await page.locator(".details .file-row.selected").getAttribute("title");
    await page.click(".commit-message-open");
    await page.waitForSelector(".modal:has-text('Commit message')");
    await page.waitForSelector(".commit-message-body li:has-text('Keep the selected file')");
    await page.waitForSelector(".commit-message-body code:has-text('<script>text only</script>')");
    await page.waitForTimeout(200);
    if (await page.locator(".commit-message-trailers").getAttribute("open") !== null) throw new Error("sign-offs should start collapsed");
    const dialogBody = page.locator(".modal-body");
    if (!(await dialogBody.evaluate((el) => el.scrollHeight > el.clientHeight))) throw new Error("long message should scroll inside the dialog");
    await shot("22-commit-message");
    await page.locator(".commit-message-trailers summary").click();
    await page.waitForSelector(".commit-message-trailers dd:has-text('jane@example.com')");
    await page.locator(".commit-message-trailers dd").last().scrollIntoViewIfNeeded();
    await shot("23-commit-signoffs");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached" });
    const scrollAfter = await page.locator(".details .diff-body").evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    if (Math.abs(scrollBefore.x - scrollAfter.x) > 1 || Math.abs(scrollBefore.y - scrollAfter.y) > 1) throw new Error("closing the message moved the diff scroll");
    if (await page.locator(".details .file-row.selected").getAttribute("title") !== fileBefore) throw new Error("closing the message changed the selected path");
    await page.click(".history-mode button:has-text('Review')");
    await page.click(".focus-toggle");
    await page.click(".review-details .details-hide");
    await page.waitForSelector(".review-details", { state: "detached" });
    await page.waitForSelector(".review-list", { state: "visible" });
    await page.waitForSelector(".repository-slot", { state: "visible" });
    await page.click(".history-mode button:has-text('Graph')");
    await page.locator(".repository-item", { hasText: "demo" }).locator(".repository-select").click();
    // Loading twenty repository tabs can exceed the normal per-action timeout.
    await page.waitForSelector(".repo-current:has-text('demo')", { timeout: 60000 });
  });

  await check("repository transactions queue fetch and reject a stale reset after a commit", async () => {
    const original = git("rev-parse", "HEAD");
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    const savedHook = fs.existsSync(hook) ? fs.readFileSync(hook) : null;
    const started = path.join(repo, ".git", "revqora-queue-started");
    const release = path.join(repo, ".git", "revqora-queue-release");
    fs.writeFileSync(path.join(repo, "queue-commit.txt"), "Queued commit\n");
    git("add", "queue-commit.txt");
    fs.writeFileSync(hook, "#!/bin/sh\ntouch .git/revqora-queue-started\nwhile test ! -f .git/revqora-queue-release; do sleep 0.05; done\n");
    fs.chmodSync(hook, 0o755);
    try {
      await page.evaluate(async (root) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const status = await invoke("status", { repo: root });
        const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
        window.__queueTest = { expected: status.stateToken, commit: settle(invoke("commit", { repo: root, expectedState: status.stateToken, message: "Queue test commit", opts: {} })) };
      }, repo);
      await until(() => fs.existsSync(started), "commit hook did not start", 15000);
      await page.evaluate((root) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
        window.__queueTest.fetch = settle(invoke("fetch_background", { repo: root }));
        window.__queueTest.reset = settle(invoke("reset", { repo: root, expectedState: window.__queueTest.expected, target: "HEAD~1", mode: "hard" }));
      }, repo);
      await page.waitForSelector(".repository-queue:has-text('2 queued')");
      await shot("36-repository-queue");
      fs.writeFileSync(path.join(repo, "queue-external.txt"), "Keep this IDE edit\n");
      fs.writeFileSync(release, "continue\n");
      const result = await page.evaluate(async () => {
        const [commit, fetch, reset] = await Promise.all([window.__queueTest.commit, window.__queueTest.fetch, window.__queueTest.reset]);
        return { commit, fetch, reset };
      });
      if (!result.commit.ok || !result.fetch.ok || result.reset.ok || result.reset.error.kind !== "stale-operation") throw new Error("queued commit/fetch/reset did not preserve the original precondition");
      if (git("rev-parse", "HEAD") !== result.commit.value || fs.readFileSync(path.join(repo, "queue-external.txt"), "utf8") !== "Keep this IDE edit\n") throw new Error("queued reset lost commit or worktree data");
      await page.waitForSelector(".repository-queue", { state: "detached" });
    } finally {
      fs.writeFileSync(release, "continue\n");
      await page.evaluate(async () => { if (window.__queueTest) await Promise.all([window.__queueTest.commit, window.__queueTest.fetch, window.__queueTest.reset]); });
      if (savedHook) fs.writeFileSync(hook, savedHook); else fs.rmSync(hook, { force: true });
      git("reset", "--mixed", original);
      for (const file of [started, release, path.join(repo, "queue-commit.txt"), path.join(repo, "queue-external.txt")]) fs.rmSync(file, { force: true });
      await page.click("button[title='Refresh (F5)']");
    }
  });

  await check("a deletion confirmation keeps its precondition across external Git changes", async () => {
    git("branch", "ui-stale-confirm");
    await page.fill(".sidebar input[placeholder^='Filter branches']", "ui-stale");
    await page.click("button[title='Refresh (F5)']");
    await page.locator(".sidebar [data-branch-kind='local'][data-branch-name='ui-stale-confirm']").click({ button: "right" });
    await page.locator(".ctx-item").filter({ hasText: /^Delete…$/ }).click();
    await page.waitForSelector(".branch-review[aria-busy='false'][data-review-local-oid]");
    git("branch", "ui-stale-external");
    await page.waitForSelector(".sidebar [data-branch-kind='local'][data-branch-name='ui-stale-external']");
    await page.click(".delete-branch-confirm");
    await page.waitForSelector(".delete-branch-error:has-text('repository changed')");
    if (!git("branch", "--list", "ui-stale-confirm")) throw new Error("stale confirmation removed a branch");
    await shot("37-stale-confirmation");
    await page.click(".modal button:has-text('Cancel')");
    git("branch", "-D", "ui-stale-confirm", "ui-stale-external");
    await page.fill(".sidebar input[placeholder^='Filter branches']", "");
    await page.click("button[title='Refresh (F5)']");
  });

  await check("dark theme renders", async () => {
    if (await page.locator(".commit-box input").inputValue().catch(() => "")) throw new Error("commit message from the aborted merge was left behind");
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await page.click(".view-tab:has-text('History')");
    await page.locator(".grow", { hasText: "Merge branch 'hotfix/greeting'" }).first().click();
    await page.waitForSelector(".details .file-row");
    await page.waitForSelector(".diff .dl.add");
    await page.waitForTimeout(600);
    await shot("07-history-dark");
    await page.click(".view-tab:has-text('Changes')");
    await page.waitForTimeout(500);
    await shot("08-changes-dark");
  });

  let persistentOperation;
  await check("operation journal filters, redacts credentials, exports and clears selected history", async () => {
    const secret = "ghp_JOURNAL_TEST_SECRET_12345678";
    const data = await page.evaluate(async ({ root, secret }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke("remote_add", { repo: root, name: "ui-journal-redaction", url: `https://user:${secret}@127.0.0.1:1/not-a-repo` });
      await invoke("remote_remove", { repo: root, name: "ui-journal-redaction" });
      const page = await invoke("operation_log_list", { filter: { repo: root, search: "remote add", status: "succeeded" } });
      const detail = await invoke("operation_log_detail", { id: page.entries[0].id });
      const keep = await invoke("operation_log_list", { filter: { repo: root, search: "remote remove", status: "succeeded" } });
      return { detail, keep: keep.entries[0].id, health: await invoke("operation_log_health") };
    }, { root: repo, secret });
    persistentOperation = data.keep;
    if (!data.health.available || data.health.warning) throw new Error(`journal unavailable: ${data.health.warning}`);
    if (JSON.stringify(data.detail).includes(secret) || !JSON.stringify(data.detail).includes("[redacted]")) throw new Error("credential redaction did not happen before persistence");
    for (const file of [data.health.path, data.health.path + "-wal"]) {
      if (fs.existsSync(file) && fs.readFileSync(file).includes(Buffer.from(secret))) throw new Error("raw credential present in journal files");
    }
    await page.click(".operation-log-open");
    await page.waitForSelector(".operation-log .log-row");
    await page.fill("input[aria-label='Search operation log']", "reset");
    await page.selectOption(".log-status-filter", "failed");
    await page.locator(".log-row", { hasText: "Reset" }).first().click();
    await page.waitForSelector(".log-result-error:has-text('stale-operation')");
    await shot("39-operation-log");
    await page.fill("input[aria-label='Search operation log']", "remote add");
    await page.selectOption(".log-status-filter", "succeeded");
    await page.locator(".log-row", { hasText: "Remote add" }).first().click();
    await page.waitForSelector(".log-command summary:has-text('ui-journal-redaction')");
    if ((await page.locator(".log-detail").innerText()).includes(secret)) throw new Error("UI exposed a credential");
    const destination = path.join(work, "operation-log-export.json");
    const count = await page.evaluate(({ root, destination }) => window.__TAURI_INTERNALS__.invoke("operation_log_export", { filter: { repo: root, search: "remote add", status: "succeeded" }, destination }), { root: repo, destination });
    const exported = fs.readFileSync(destination, "utf8");
    if (!count || exported.includes(secret) || !JSON.parse(exported).operations.some((o) => o.entry.id === data.detail.entry.id)) throw new Error("journal export does not match the selected filter");
    await page.click(".log-clear");
    await page.locator(".modal button", { hasText: /^Clear completed entries$/ }).click();
    await until(async () => await page.locator(".log-row").count() === 0, "cleared journal entries remain visible");
    const kept = await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke("operation_log_detail", { id }), persistentOperation);
    if (kept.entry.status !== "succeeded") throw new Error("clearing a filter removed unrelated history");
    await page.locator(".modal button", { hasText: /^Close$/ }).click();
  });

  await check("journal survives process restart and marks abandoned queued/running actions as unknown", async () => {
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    const savedHook = fs.existsSync(hook) ? fs.readFileSync(hook) : null;
    const started = path.join(repo, ".git", "journal-started");
    const release = path.join(repo, ".git", "journal-release");
    const done = path.join(repo, ".git", "journal-done");
    fs.writeFileSync(path.join(repo, "journal-restart.txt"), "Keep this work after restart\n");
    git("add", "-A");
    fs.writeFileSync(hook, "#!/bin/sh\ntouch .git/journal-started\nwhile test ! -f .git/journal-release; do sleep 0.05; done\ntouch .git/journal-done\n");
    fs.chmodSync(hook, 0o755);
    try {
      await page.click(".operation-log-open");
      await page.evaluate(async (root) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const state = await invoke("status", { repo: root });
        window.__journalExpected = state.stateToken;
        window.__journalCommit = invoke("commit", { repo: root, expectedState: state.stateToken, message: "Journal restart probe", opts: {} }).catch(() => {});
      }, repo);
      await until(() => fs.existsSync(started), "journal probe hook did not start", 15000);
      await page.evaluate((root) => { window.__journalQueued = window.__TAURI_INTERNALS__.invoke("branch_create", { repo: root, name: "ui-journal-never-run", start: null, checkout: false, expectedState: window.__journalExpected }).catch(() => {}); }, repo);
      await page.waitForSelector(".repository-queue:has-text('queued')");
      await page.waitForSelector(".operation-log .log-row .log-state.running");
      await page.waitForSelector(".operation-log .log-row .log-state.queued");
      const unfinished = await page.evaluate((root) => window.__TAURI_INTERNALS__.invoke("operation_log_list", { filter: { repo: root } }), repo);
      const ids = unfinished.entries.filter((e) => e.command === "commit" && e.status === "running" || e.command === "branch_create" && e.status === "queued").map((e) => e.id);
      if (ids.length !== 2) throw new Error("journal did not record queued and running actions before shutdown");
      const exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
      await close();
      await exited;
      fs.writeFileSync(release, "continue\n");
      const deadline = Date.now() + 15000;
      while (fs.existsSync(path.join(repo, ".git", "index.lock")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (fs.existsSync(path.join(repo, ".git", "index.lock"))) throw new Error("orphan Git process did not release index lock");
      // Give the closed WebView provider time to release the same profile directory.
      await new Promise((resolve) => setTimeout(resolve, 500));
      ({ page, close, child } = await launch({ exe, args: [repo], profile: smokeProfile, port: 0 }));
      attachPage();
      // Loading twenty repository tabs can exceed the normal per-action timeout.
    await page.waitForSelector(".repo-current:has-text('demo')", { timeout: 60000 });
      const recovered = await page.evaluate(async ({ ids, keep }) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        return { entries: await Promise.all(ids.map((id) => invoke("operation_log_detail", { id }))), kept: await invoke("operation_log_detail", { id: keep }) };
      }, { ids, keep: persistentOperation });
      if (recovered.entries.some((d) => d.entry.status !== "interrupted") || recovered.kept.entry.status !== "succeeded") throw new Error("restart lost history or claimed an unknown action succeeded");
      if (git("branch", "--list", "ui-journal-never-run")) throw new Error("queued action was replayed after restart");
      await page.click(".operation-log-open");
      await page.locator(".log-row:has(.log-state.interrupted)").first().click();
      await page.waitForSelector(".log-detail .log-notice:has-text('final result is unknown')");
      await shot("40-operation-log-recovered");
      await page.locator(".modal button", { hasText: /^Close$/ }).click();
    } finally {
      fs.writeFileSync(release, "continue\n");
      const deadline = Date.now() + 15000;
      while (fs.existsSync(started) && !fs.existsSync(done) && fs.existsSync(path.join(repo, ".git", "index.lock")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (savedHook) fs.writeFileSync(hook, savedHook); else if (fs.existsSync(hook)) fs.unlinkSync(hook);
    }
  });

  await check("Undo Center persists checkpoints and recovers exact files and staging into a new worktree", async () => {
    fs.writeFileSync(path.join(repo, "ui-recovery.txt"), "staged checkpoint content\n");
    git("add", "ui-recovery.txt");
    fs.writeFileSync(path.join(repo, "ui-recovery.txt"), "unstaged checkpoint content\r\n");
    fs.writeFileSync(path.join(repo, "ui-recovery.bin"), Buffer.from([0, 255, 1, 13, 10]));
    await page.click("button[aria-label='Undo Center']");
    await page.waitForSelector(".recovery-center");
    await page.click(".recovery-toolbar button:has-text('Create checkpoint')");
    const prompt = page.locator(".modal").last();
    await prompt.locator("input").fill("Native recovery snapshot");
    await prompt.getByRole("button", { name: "Create checkpoint", exact: true }).click();
    await page.waitForSelector(".recovery-title h3:has-text('Native recovery snapshot')");
    await page.waitForSelector(".recovery-center[aria-busy='false']");
    const saved = await page.evaluate((root) => window.__TAURI_INTERNALS__.invoke("recovery_list", { repo: root }), repo);
    const cp = saved.checkpoints.find((item) => item.label === "Native recovery snapshot");
    if (!cp?.workspace) throw new Error("manual checkpoint was not saved");
    const storage = path.resolve(saved.storagePath);
    const portableData = path.join(smokeProfile, "revqora-data");
    const relativeStorage = path.relative(portableData, storage);
    if (path.isAbsolute(relativeStorage) || relativeStorage === ".." || relativeStorage.startsWith(`..${path.sep}`)) throw new Error("checkpoint files escaped the portable profile");
    if (!fs.existsSync(path.join(storage, cp.id, "checkpoint.json")) || fs.existsSync(path.join(repo, ".git", "revqora")) || fs.existsSync(path.join(repo, ".git", "revqora-squash"))) throw new Error("application data remained inside Git metadata");
    if (!fs.existsSync(path.join(portableData, "temp"))) throw new Error("portable temporary folder was not initialized");
    await shot("41-undo-center");
    await page.locator(".modal button", { hasText: /^Close$/ }).click();
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
    await close(); await exited;
    await new Promise((resolve) => setTimeout(resolve, 500));
    ({ page, close, child } = await launch({ exe, args: [repo], profile: smokeProfile, port: 0 })); attachPage();
    // Loading twenty repository tabs can exceed the normal per-action timeout.
    await page.waitForSelector(".repo-current:has-text('demo')", { timeout: 60000 });
    git("reset", "--hard", "HEAD"); git("clean", "-fd");
    const sourceHead = git("rev-parse", "HEAD");
    const sourceIndex = fs.readFileSync(path.join(repo, ".git", "index"));
    await page.click("button[aria-label='Undo Center']");
    await page.locator(`.recovery-row[data-checkpoint-id='${cp.id}']`).click();
    await page.locator(`.recovery-detail[data-checkpoint-id='${cp.id}']`).waitFor();
    const destination = path.join(work, "recovered-native-worktree");
    await page.fill("input[aria-label='Recovery destination']", destination);
    await page.fill("input[aria-label='Recovery worktree branch']", "ui-recovered-workspace");
    await page.click("button:has-text('Recover in new worktree')");
    await page.waitForSelector(".recovery-success", { timeout: 30000 });
    const recoveredGit = (...args) => execFileSync("git", ["-C", destination, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
    if (fs.readFileSync(path.join(destination, "ui-recovery.txt"), "utf8") !== "unstaged checkpoint content\r\n" || recoveredGit("show", ":ui-recovery.txt") !== "staged checkpoint content") throw new Error("file bytes or staging were not recovered");
    if (!fs.readFileSync(path.join(destination, "ui-recovery.bin")).equals(Buffer.from([0, 255, 1, 13, 10]))) throw new Error("binary recovery failed");
    if (git("rev-parse", "HEAD") !== sourceHead || !sourceIndex.equals(fs.readFileSync(path.join(repo, ".git", "index"))) || fs.existsSync(path.join(repo, "ui-recovery.txt"))) throw new Error("recovery replaced current worktree state");
    await shot("42-undo-center-recovered");
    await page.locator(".modal button", { hasText: /^Close$/ }).click();
  });

  await check("automatic checkpoints restore deleted branches and stashes and can be explicitly removed", async () => {
    git("branch", "ui-removed-recovery");
    const branch = await page.evaluate(async (root) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke("branch_delete", { repo: root, name: "ui-removed-recovery", force: true });
      const catalog = await invoke("recovery_list", { repo: root });
      const cp = catalog.checkpoints.find((cp) => cp.command === "branch_delete");
      return invoke("recovery_detail", { repo: root, id: cp.id });
    }, repo);
    fs.writeFileSync(path.join(repo, "ui-stash-recovery.txt"), "preserve this stash\n");
    git("stash", "push", "-u", "-m", "Recovery smoke stash");
    const stashOid = git("rev-parse", "stash@{0}");
    const stash = await page.evaluate(async (root) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke("stash_drop", { repo: root, index: 0 });
      const catalog = await invoke("recovery_list", { repo: root });
      const cp = catalog.checkpoints.find((cp) => cp.command === "stash_drop");
      return invoke("recovery_detail", { repo: root, id: cp.id });
    }, repo);
    // Hold each detail response until the UI has entered its loading state.
    // This reproduces the CI race without depending on machine speed or sleeps.
    const selectLoadedCheckpoint = async (id) => {
      await page.evaluate((id) => {
        const original = window.fetch;
        const endpoint = window.__TAURI_INTERNALS__.convertFileSrc("recovery_detail", "ipc");
        window.__recoveryOriginalFetch = original;
        window.fetch = async function (input, init) {
          const response = await original.call(this, input, init);
          if (String(input) === endpoint && (await response.clone().json()).id === id) {
            await new Promise((resolve) => { window.__recoveryReleaseDetail = resolve; });
          }
          return response;
        };
      }, id);
      try {
        await page.locator(`.recovery-row[data-checkpoint-id='${id}']`).click();
        await page.waitForFunction(() => typeof window.__recoveryReleaseDetail === "function");
        if (await page.locator(".recovery-detail[data-checkpoint-id]").count()) throw new Error("stale checkpoint actions remained available during loading");
      } finally {
        await page.evaluate(() => {
          window.fetch = window.__recoveryOriginalFetch;
          window.__recoveryReleaseDetail?.();
          delete window.__recoveryReleaseDetail;
          delete window.__recoveryOriginalFetch;
        });
      }
      await page.locator(`.recovery-detail[data-checkpoint-id='${id}']`).waitFor();
    };
    await page.click("button[aria-label='Undo Center']");
    await selectLoadedCheckpoint(branch.id);
    const branchRef = branch.refs.findIndex((ref) => ref.name === "refs/heads/ui-removed-recovery");
    await page.selectOption("select[aria-label='Saved recovery reference']", String(branchRef));
    await page.fill("input[aria-label='Recovered local branch']", "ui-removed-recovery");
    await page.getByRole("button", { name: "Restore branch", exact: true }).click();
    await until(() => !!git("branch", "--list", "ui-removed-recovery"), "branch was not recovered", 15000);
    await page.waitForSelector(".recovery-center[aria-busy='false']");
    await selectLoadedCheckpoint(stash.id);
    await page.selectOption("select[aria-label='Saved recovery reference']", String(stash.refs.findIndex((ref) => ref.kind === "stash" && ref.oid === stashOid)));
    await page.getByRole("button", { name: "Restore stash", exact: true }).click();
    await until(() => git("rev-parse", "--verify", "--quiet", "stash@{0}") === stashOid, "stash was not recovered", 15000);
    if (fs.existsSync(path.join(repo, "ui-stash-recovery.txt"))) throw new Error("stash recovery applied files without consent");
    await page.waitForSelector(".recovery-center[aria-busy='false']");
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await shot("43-undo-center-references");
    await page.click("button[aria-label='Delete checkpoint']");
    await page.locator(".modal").last().getByRole("button", { name: "Delete checkpoint", exact: true }).click();
    await page.locator(`.recovery-row[data-checkpoint-id='${stash.id}']`).waitFor({ state: "detached" });
    if (git("for-each-ref", `refs/revqora/recovery/${stash.id}`)) throw new Error("removed checkpoint still pins objects");
    await page.locator(".modal button", { hasText: /^Close$/ }).click();
  });

  if (errors.length) throw new Error("console errors: " + errors.join(" | "));
} catch (e) {
  failed = true;
  if (!results.some((r) => r.startsWith("FAIL"))) results.push("FAIL " + e.message);
} finally {
  await close();
  feed.close();
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
