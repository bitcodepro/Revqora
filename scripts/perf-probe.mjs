// Measures how fast the built app handles a (large) repository.
//   node scripts/perf-probe.mjs <repo> [--exe path]
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launch } from "./ui-driver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
if (!repo) throw new Error("usage: perf-probe.mjs <repo> [--exe path]");
const i = process.argv.indexOf("--exe");
const exe = i > 0 ? process.argv[i + 1] : path.join(here, "../src-tauri/target/release/revqora.exe");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "revqora-perf-"));

const t0 = Date.now();
const { page, close } = await launch({ exe, args: [repo], profile, port: 9700 });
try {
  await page.waitForSelector(".topbar", { timeout: 60000 });
  const shell = Date.now() - t0;
  await page.waitForSelector(".grow:not(.wip) .g-subject .text", { timeout: 60000 });
  console.log(`launch → app window ready: ${shell} ms (WebView2 start, measured over CDP)`);
  console.log(`launch → first commit rows visible: ${Date.now() - t0} ms`);
  const timings = await page.evaluate(async (root) => {
    const inv = (window).__TAURI_INTERNALS__.invoke;
    const time = async (fn) => {
      const s = performance.now();
      const r = await fn();
      return [Math.round(performance.now() - s), r];
    };
    const tabs = document.querySelectorAll(".repo-tab");
    const realRoot = tabs[0]?.getAttribute("title") ?? root;
    const [load, summary] = await time(() => inv("graph_load", { repo: realRoot, branch: null, includeWorktree: false, limit: null }));
    const [rows] = await time(() => inv("graph_rows", { repo: realRoot, start: 50000, count: 250 }));
    const [status] = await time(() => inv("status", { repo: realRoot }));
    const [refs] = await time(() => inv("refs_snapshot", { repo: realRoot }));
    const [search] = await time(() => inv("graph_search", { repo: realRoot, query: "parser", mode: "quick" }));
    return { commits: summary.total, lanes: summary.maxLanes, load, rows, status, refs, search };
  }, repo);
  console.log(JSON.stringify(timings, null, 2));
  // Scroll responsiveness: jump to the end and measure until rows render.
  const s = Date.now();
  await page.evaluate(() => {
    const el = document.querySelector(".graph-scroll");
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(16);
  await page.waitForFunction(() => !document.querySelector(".graph-rows .skel") && document.querySelectorAll(".grow .g-subject .text").length > 0);
  console.log(`jump to the oldest commits rendered in: ${Date.now() - s} ms`);
} finally {
  await close();
}
