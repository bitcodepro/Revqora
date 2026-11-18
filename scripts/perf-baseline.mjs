// Repeatable performance baseline of a built Revqora (docs/APP_PERFORMANCE.md, "Baseline harness").
//
//   node scripts/perf-fixtures.mjs <fixtures>                      (once; same content every time)
//   node scripts/perf-baseline.mjs --fixtures <fixtures> [--exe path] [--runs 5] [--out result.json]
//                                  [--only startup,switch,diff,search,history,workspace,prs]
//   node scripts/perf-baseline.mjs --compare before.json after.json
//   node scripts/perf-baseline.mjs --table result.json              (Markdown table of a result)
//
// Every scenario reports the median and p95 of its runs. Where the app reports them, the total is
// split into queue (waiting for the repository gate), git (Git or provider API work in the
// backend) and ui (the rest: IPC, React work and rendering). Backend parts come from
// REVQORA_STAGE_TIMINGS lines, search diagnostics and the fake provider's own request times.
// Profiles, timing files and PR test repositories are created under REVQORA_TEST_TMP and removed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProfile, launch } from "./ui-driver.mjs";
import { PROVIDERS, accountServer, fixtureToken, remotePath, startForgeFixture } from "./perf-forge-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROWS = ".grow:not(.wip) .g-subject .text";

// ── statistics and comparison ──────────────────────────────────────────────────────────────

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  // Nearest-rank: p95 of 5 runs is the slowest run, never an interpolated value.
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** `samples` is a list of `{ total, queue?, git?, ui?, ... }`; each numeric field gets median/p95. */
export function summarize(samples) {
  const fields = [...new Set(samples.flatMap(sample => Object.keys(sample).filter(key => typeof sample[key] === "number")))];
  const out = { runs: samples.length };
  for (const field of fields) {
    const values = samples.map(sample => sample[field]);
    out[field] = { median: round(percentile(values, 50)), p95: round(percentile(values, 95)) };
  }
  return out;
}

const round = value => value === null ? null : Math.round(value * 10) / 10;

export function compare(before, after) {
  const lines = [`${before.label} → ${after.label}`, `${"scenario".padEnd(44)} ${"median".padStart(17)} ${"p95".padStart(17)}  change`];
  for (const [name, b] of Object.entries(before.scenarios)) {
    const a = after.scenarios[name];
    if (!a?.total || !b?.total) continue;
    const change = b.total.median ? ((a.total.median - b.total.median) / b.total.median) * 100 : 0;
    const cell = (x, y) => `${x} → ${y}`.padStart(17);
    lines.push(`${name.padEnd(44)} ${cell(b.total.median, a.total.median)} ${cell(b.total.p95, a.total.p95)}  ${change > 0 ? "+" : ""}${change.toFixed(0)}%`);
  }
  return lines.join("\n");
}

// ── stage timing lines ─────────────────────────────────────────────────────────────────────

function stageLines(file, since, until = Infinity) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(line => line.at >= since && line.at <= until);
}
const sameRepo = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const stageSum = line => line.stages.reduce((sum, [, ms]) => sum + ms, 0);
/** graph_load stages nest ("build" contains the walk, layout and rows; the walks run in parallel). */
export function stageTotal(line) {
  const build = line.stages.filter(([name]) => name === "build").at(-1);
  if (!build) return stageSum(line);
  return build[1] + line.stages.filter(([name]) => name === "exactCount").reduce((sum, [, ms]) => sum + ms, 0);
}
function backendSplit(file, repo, command, since, until) {
  const lines = stageLines(file, since, until).filter(line => sameRepo(line.repo, repo));
  const queue = lines.filter(line => line.command === "repository_wait").reduce((sum, line) => sum + stageSum(line), 0);
  const git = lines.filter(line => line.command === command).reduce((sum, line) => sum + stageTotal(line), 0);
  return { queue, git };
}

// ── the app ────────────────────────────────────────────────────────────────────────────────

async function start(context, args = []) {
  const profile = createProfile("revqora-baseline-");
  const spawned = performance.now();
  const startedAt = Date.now();
  const app = await launch({ exe: context.exe, args, profile, port: 0 });
  // Rejections cross CDP as plain objects; keep their message and kind readable.
  const invoke = async (command, payload) => {
    const reply = await app.page.evaluate(([command, payload]) => window.__TAURI_INTERNALS__.invoke(command, payload).then(value => ({ value }), error => ({ error })), [command, payload]);
    if ("error" in reply) throw new Error(`${command}: ${JSON.stringify(reply.error)}`);
    return reply.value;
  };
  return {
    ...app, invoke, spawned, startedAt, profile,
    async stop() {
      await app.close();
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}

async function skipWelcome(page) {
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function openRepository(app, root, subject) {
  await app.invoke("plugin:event|emit", { event: "open-paths", payload: [root] });
  await app.page.locator(".topbar .repo-current > b").filter({ hasText: path.basename(root) }).waitFor({ timeout: 120_000 });
  await app.page.locator(".graph-rows").getByText(subject, { exact: true }).first().waitFor({ timeout: 120_000 });
}

const subjectOf = root => execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();

// ── scenarios ──────────────────────────────────────────────────────────────────────────────

/** Cold start: a new process and an empty WebView profile per run, the repository on the command line. */
async function startup(context) {
  const repo = context.fixture("normal");
  const samples = [];
  for (let run = 0; run < context.runs; run++) {
    const app = await start(context, [repo]);
    try {
      await app.page.locator(".topbar").waitFor({ timeout: 120_000 });
      const shell = performance.now() - app.spawned;
      await app.page.locator(ROWS).first().waitFor({ timeout: 120_000 });
      const total = performance.now() - app.spawned;
      const { queue, git } = backendSplit(context.timings, repo, "graph_load", app.startedAt, Date.now());
      samples.push({ total, shell, queue, git, ui: Math.max(0, total - shell - queue - git) });
    } finally {
      await app.stop();
    }
  }
  return { "cold start → first History rows": summarize(samples) };
}

/** Repository switch, commit preview to first diff, search and history builds share one app session. */
async function session(context) {
  const result = {};
  const normal = context.fixture("normal"), merges = context.fixture("merges"), large = context.fixture("large-diff");
  const subjects = { normal: subjectOf(normal), merges: subjectOf(merges), large: subjectOf(large) };
  const app = await start(context, [normal]);
  try {
    await app.page.locator(ROWS).first().waitFor({ timeout: 120_000 });
    await skipWelcome(app.page);
    await openRepository(app, merges, subjects.merges);
    await openRepository(app, large, subjects.large);

    if (context.only("switch")) {
      // A click in the Explorer, as a user switches; the target's newest commit must be visible.
      const pick = name => app.page.locator(".explorer-sidebar .repository-select").filter({ hasText: name }).first();
      const toNormal = [], toMerges = [];
      for (let run = 0; run < context.runs; run++) {
        for (const [root, subject, samples] of [[normal, subjects.normal, toNormal], [merges, subjects.merges, toMerges]]) {
          const since = Date.now(), began = performance.now();
          await pick(path.basename(root)).click();
          await app.page.locator(".graph-rows").getByText(subject, { exact: true }).first().waitFor({ timeout: 120_000 });
          const total = performance.now() - began;
          const { queue, git } = backendSplit(context.timings, root, "graph_load", since, Date.now());
          samples.push({ total, queue, git, ui: Math.max(0, total - queue - git) });
        }
      }
      result["switch → newest commit visible (5k history)"] = summarize(toNormal);
      result["switch → newest commit visible (20k merges)"] = summarize(toMerges);
    }

    if (context.only("diff")) {
      // Commit in History → its file list in the details panel → the first file's diff lines.
      await app.page.locator(".explorer-sidebar .repository-select").filter({ hasText: "large-diff" }).first().click();
      const row = app.page.locator(".graph-rows .grow").filter({ hasText: subjects.large }).first();
      const otherSubject = execFileSync("git", ["-C", large, "log", "-1", "--format=%s", "HEAD~1"], { encoding: "utf8" }).trim();
      const other = app.page.locator(".graph-rows .grow").filter({ hasText: otherSubject }).first();
      await row.waitFor({ timeout: 120_000 });
      // The preview names a commit only once its own details have loaded, so the subject tells
      // which commit's file list is shown (both commits list data/big.txt).
      const shown = subject => app.page.waitForFunction(([subject]) => {
        const heading = document.querySelector(".details .commit-subject");
        return heading?.textContent === subject && !!document.querySelector(".details .file-row[data-file-path]");
      }, [subject], { timeout: 120_000 });
      const samples = [];
      for (let run = 0; run < context.runs; run++) {
        await other.click();
        await shown(otherSubject);
        const began = performance.now();
        await row.click();
        await shown(subjects.large);
        const files = performance.now() - began;
        await app.page.locator(".details .file-row[data-file-path='data/big.txt']").first().click();
        // Only this commit's diff of big.txt has rewritten lines (the base commit adds the file).
        await app.page.locator(".details .dl").filter({ hasText: "rewritten" }).first().waitFor({ timeout: 120_000 });
        samples.push({ total: performance.now() - began, files });
      }
      result["commit click → file list → big file diff (651 files)"] = summarize(samples);
    }

    if (context.only("search")) {
      const queries = [
        ["search subject token (quick)", normal, "PERF-825", "quick"],
        ["search body-only token (message)", normal, "PERF-BODY-810", "message"],
        ["search author, all pages (author)", normal, "perf-17@example.invalid", "author"],
        ["search 20k merges (quick)", merges, "client add 4", "quick"],
      ];
      for (const [name, repo, query, mode] of queries) {
        const first = [], complete = [];
        for (let run = 0; run < context.runs; run++) {
          const measured = await app.page.evaluate(async ([repo, query, mode]) => {
            const invoke = window.__TAURI_INTERNALS__.invoke;
            const began = performance.now();
            let cursor = null, firstMs = null, hits = 0, queue = 0, git = 0, pages = 0;
            do {
              const page = await invoke("repository_commit_search_page", { repo, query, mode, cursor, limit: 100 });
              pages++; hits += page.commits.length; queue += page.diagnostics.queueMs; git += page.diagnostics.gitMs;
              if (firstMs === null && page.commits.length) firstMs = performance.now() - began;
              cursor = page.hasMore ? page.nextCursor : null;
            } while (cursor);
            return { firstMs, total: performance.now() - began, hits, pages, queue, git };
          }, [repo, query, mode]);
          if (!measured.hits) throw new Error(`${name}: no results for ${query}`);
          first.push({ total: measured.firstMs });
          complete.push({ total: measured.total, queue: measured.queue, git: measured.git, ui: Math.max(0, measured.total - measured.queue - measured.git), hits: measured.hits, pages: measured.pages });
        }
        result[`${name} → first result`] = summarize(first);
        result[`${name} → complete`] = summarize(complete);
      }

      // Deep pagination: ~5,000 author matches in pages of 100. Git reads matches in batches;
      // later batches start with --skip, and a cursor resumed after its batch left the cache
      // walks history again up to its offset.
      const deep = [], resumed = [];
      for (let run = 0; run < context.runs; run++) {
        const measured = await app.page.evaluate(async repo => {
          const invoke = window.__TAURI_INTERNALS__.invoke;
          const search = (query, cursor) => invoke("repository_commit_search_page", { repo, query, mode: "author", cursor, limit: 100 });
          // Other queries share the bounded batch cache; a fresh query per run starts cold.
          const evict = async () => { for (const query of ["alex", "sam", "jordan", "taylor", "seventeen"]) await search(query, null); };
          await evict();
          const began = performance.now();
          let cursor = null, pages = 0, hits = 0, slowest = 0, gitCalls = 0, deepCursor = null;
          do {
            const pageBegan = performance.now();
            const page = await search("perf@example.invalid", cursor);
            slowest = Math.max(slowest, performance.now() - pageBegan);
            pages++; hits += page.commits.length; if (!page.diagnostics.cacheHit) gitCalls++;
            cursor = page.hasMore ? page.nextCursor : null;
            if (pages === 45) deepCursor = cursor;
          } while (cursor);
          const total = performance.now() - began;
          await evict();
          const resumeBegan = performance.now();
          const page = await search("perf@example.invalid", deepCursor);
          return { total, pages, hits, slowest, gitCalls, resumed: performance.now() - resumeBegan, resumedHits: page.commits.length, resumedGit: page.diagnostics.gitMs };
        }, normal);
        if (measured.hits < 4000 || !measured.resumedHits) throw new Error(`deep author search: ${JSON.stringify(measured)}`);
        deep.push({ total: measured.total, slowestPage: measured.slowest, pages: measured.pages, gitCalls: measured.gitCalls, hits: measured.hits });
        resumed.push({ total: measured.resumed, git: measured.resumedGit });
      }
      result["search author, ~5k matches, every page of 100"] = summarize(deep);
      result["search author, page 46 resumed after cache eviction"] = summarize(resumed);
    }

    if (context.only("history")) {
      // Backend history builds over IPC. The first build per repository is cold; later ones reuse it.
      for (const [name, repo] of [["normal", normal], ["merges", merges]]) {
        const samples = [];
        for (let run = 0; run < context.runs; run++) {
          const since = Date.now();
          const total = await app.page.evaluate(async repo => {
            const began = performance.now();
            await window.__TAURI_INTERNALS__.invoke("graph_load", { repo, branch: null, includeWorktree: false, limit: null, fast: true });
            return performance.now() - began;
          }, repo);
          const { queue, git } = backendSplit(context.timings, repo, "graph_load", since, Date.now() + 1);
          samples.push({ total, queue, git, ui: Math.max(0, total - queue - git) });
        }
        result[`graph_load fast rebuild (${name})`] = summarize(samples);
      }
    }
  } finally {
    await app.stop();
  }
  return result;
}

/**
 * Why one repository's PR list did not end as its fixture scenario requires, or null.
 * "ok" and "slow" load every pull request without an error; "forbidden" and "rate-limited"
 * fail before any row; "incomplete" and "truncated" fail on the second page.
 */
export function prOutcomeProblem(scenario, outcome, pulls) {
  if (!outcome) return "no result";
  if (scenario === "ok" || scenario === "slow") {
    if (outcome.error) return `failed: ${outcome.error}`;
    return outcome.rows === pulls ? null : `${outcome.rows} of ${pulls} pull requests`;
  }
  if (!outcome.error) return `loaded ${outcome.rows} pull requests instead of failing`;
  if ((scenario === "forbidden" || scenario === "rate-limited") && outcome.rows) return `${outcome.rows} rows before the error`;
  return null;
}

/** A library of 40 closed repositories: time until the Explorer's filters show every repository. */
async function workspace(context) {
  const manifest = context.manifest.workspace;
  const roots = manifest.repositories.map(name => path.join(context.fixtures, "workspace", name));
  const normal = context.fixture("normal");
  const outgoing = new Set([...manifest.expected.outgoing, ...manifest.expected.unpublished]).size;
  const incoming = manifest.expected.incoming.length;
  const app = await start(context, [normal]);
  const samples = [];
  try {
    await app.page.locator(ROWS).first().waitFor({ timeout: 120_000 });
    await skipWelcome(app.page);
    await app.page.evaluate(([roots, normal]) => {
      const settings = JSON.parse(localStorage.getItem("revqora.settings"));
      Object.assign(settings.state, { openTabs: [normal], activeTab: normal, autoFetchMinutes: 0, openLibraryOnStartup: false, explorerOpen: true });
      localStorage.setItem("revqora.settings", JSON.stringify(settings));
      localStorage.setItem("revqora.repositories", JSON.stringify({ version: 1, state: { knownRoots: [normal, ...roots], favorites: [], groups: [], activeGroupId: null } }));
    }, [roots, normal]);
    const count = name => app.page.locator(`[data-shortcut="explorer-${name}"]`).getAttribute("title").then(title => Number(title?.match(/^\d+/)?.[0] ?? -1)).catch(() => -1);
    for (let run = 0; run < context.runs; run++) {
      const began = performance.now();
      await app.page.reload();
      await app.page.locator(".app[data-app-startup='ready']").waitFor({ timeout: 120_000 });
      const ready = performance.now() - began;
      let outgoingMs = null, incomingMs = null, seen = {};
      while (performance.now() - began < 120_000 && (outgoingMs === null || incomingMs === null)) {
        seen = { outgoing: await count("outgoing"), incoming: await count("incoming") };
        if (outgoingMs === null && seen.outgoing === outgoing) outgoingMs = performance.now() - began;
        if (incomingMs === null && seen.incoming === incoming) incomingMs = performance.now() - began;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (outgoingMs === null || incomingMs === null) throw new Error(`Explorer filters did not reach ${outgoing} outgoing / ${incoming} incoming: ${JSON.stringify(seen)}`);
      // The same reads over IPC, six at a time like the app: the backend share of the totals.
      const backend = await app.page.evaluate(async roots => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const sweep = async command => {
          let next = 0;
          const began = performance.now();
          await Promise.all(Array.from({ length: 6 }, async () => { while (next < roots.length) await invoke(command, { repo: roots[next++] }); }));
          return performance.now() - began;
        };
        return { tracking: await sweep("repository_branch_tracking"), changes: await sweep("repository_change_count") };
      }, roots);
      samples.push({ total: Math.max(outgoingMs, incomingMs), ready, outgoing: outgoingMs, incoming: incomingMs, git: backend.tracking, changesSweep: backend.changes, ui: Math.max(0, Math.max(outgoingMs, incomingMs) - backend.tracking) });
    }
  } finally {
    await app.stop();
  }
  return { "reload → Incoming/Outgoing for 40 closed repositories": summarize(samples) };
}

/** The all-PR list over 44 repositories on four fake providers, loaded like useAllPullRequests. */
async function pullRequests(context) {
  const kinds = ["slow", "forbidden", "rate-limited", "incomplete", "truncated"];
  // 24 healthy repositories, then each problem once per provider (equal PR numbers everywhere).
  const plan = [...Array.from({ length: 24 }, (_, i) => ({ kind: PROVIDERS[i % 4], scenario: "ok" })),
    ...kinds.flatMap(scenario => PROVIDERS.map(kind => ({ kind, scenario })))];
  const pulls = 60;
  const forge = await startForgeFixture({ pulls, delayMs: 40, slowMs: 1200 });
  const home = fs.mkdtempSync(path.join(context.temp, "pr-repos-"));
  const repos = plan.map((entry, index) => {
    const name = `pr-${String(index + 1).padStart(2, "0")}-${entry.scenario}`;
    const root = path.join(home, name);
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", `${forge.urls[entry.kind]}${remotePath(entry.kind, name)}`]);
    forge.setScenario(name, entry.scenario);
    return { ...entry, name, root };
  });
  const app = await start(context, []);
  const samples = [];
  let outcome, refreshes = [];
  try {
    await app.page.locator(".app[data-app-startup='ready']").waitFor({ timeout: 120_000 });
    await skipWelcome(app.page);
    const accounts = {};
    for (const kind of PROVIDERS) {
      const snapshot = await app.invoke("forge_accounts_snapshot");
      const server = accountServer(kind, forge.urls[kind]);
      const added = await app.invoke("forge_account_add", { input: { id: null, kind, server, username: "", token: fixtureToken, authMode: "token", persist: false }, expected: snapshot.revision });
      accounts[kind] = added.accounts.find(account => account.kind === kind && account.server.startsWith(forge.urls[kind])).id;
    }
    for (const repo of repos) {
      const connections = await app.invoke("forge_connections", { repo: repo.root });
      await app.invoke("forge_connection_select", { repo: repo.root, selection: { remote: "origin", fingerprint: connections.remotes[0].fingerprint, accountId: accounts[repo.kind], allowSshAlias: false }, expected: connections.revision });
    }
    for (let run = 0; run < context.runs; run++) {
      const before = forge.requests.length;
      const measured = await app.page.evaluate(async roots => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const began = performance.now();
        let index = 0, first = null;
        const outcome = {};
        async function worker() {
          while (index < roots.length) {
            const root = roots[index++];
            const rows = [];
            try {
              if (!await invoke("forge_kind", { repo: root })) { outcome[root] = { error: "no forge" }; continue; }
              let cursor = null;
              do {
                const page = await invoke("pr_page", { repo: root, state: "open", cursor });
                rows.push(...page.items.map(item => item.number));
                if (first === null && page.items.length) first = performance.now() - began;
                cursor = page.nextCursor;
              } while (cursor);
              outcome[root] = { rows: rows.length, ms: performance.now() - began };
            } catch (error) {
              outcome[root] = { rows: rows.length, error: String(error?.message ?? error).slice(0, 160), ms: performance.now() - began };
            }
          }
        }
        await Promise.all([worker(), worker(), worker()]);
        return { first, total: performance.now() - began, outcome };
      }, repos.map(repo => repo.root));
      const served = forge.requests.slice(before);
      const api = served.reduce((sum, request) => sum + request.ms, 0);
      outcome = Object.fromEntries(repos.map(repo => [repo.name, measured.outcome[repo.root]]));
      // A run counts only when every repository ended as its scenario requires: an error in a
      // healthy repository, or a list from a failing one, is not a valid measurement.
      const wrong = repos.flatMap(repo => {
        const problem = prOutcomeProblem(repo.scenario, measured.outcome[repo.root], pulls);
        return problem ? [`${repo.name}: ${problem}`] : [];
      });
      if (wrong.length) throw new Error(`PR run ${run + 1}: ${wrong.length} repositories ended unexpectedly\n${wrong.join("\n")}`);
      const healthy = repos.filter(repo => repo.scenario === "ok").map(repo => measured.outcome[repo.root].ms);
      samples.push({ total: measured.total, first: measured.first, apiServed: api, requests: served.length, healthyComplete: Math.max(...healthy) });
    }
    refreshes = await prCenterRefreshes(app, repos, context.runs, expectedRows(repos, pulls));
  } catch (error) {
    error.message += `
Provider requests: ${JSON.stringify(forge.requests.slice(-8))}`;
    throw error;
  } finally {
    await app.stop();
    await forge.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  return { scenarios: { "all PRs, 44 repositories → first result / complete": summarize(samples), "PR Center all repositories → Refresh until complete": summarize(refreshes) }, outcome };
}

/** Rows the combined list shows once every repository has ended: failing lists keep the rows
 *  loaded before their error (the first page of "incomplete" and "truncated"). */
export function expectedRows(repos, pulls) {
  const firstPage = 50;
  return repos.reduce((sum, repo) => sum + (["ok", "slow"].includes(repo.scenario) ? pulls : ["incomplete", "truncated"].includes(repo.scenario) ? Math.min(firstPage, pulls) : 0), 0);
}

/**
 * The PR Center's all-repositories list, refreshed `runs` times: time until the refresh
 * completes, and the fewest rows visible meanwhile (rows that disappear during a refresh are
 * rows the user loses sight of).
 */
async function prCenterRefreshes(app, repos, runs, expected) {
  const page = app.page;
  // The combined list covers the library: add the repositories, as the user would.
  await page.evaluate(roots => localStorage.setItem("revqora.repositories", JSON.stringify({ version: 1, state: { knownRoots: roots, favorites: [], groups: [], activeGroupId: null } })), repos.map(repo => repo.root));
  await page.reload();
  await page.locator(".app[data-app-startup='ready']").waitFor({ timeout: 120_000 });
  await app.invoke("plugin:event|emit", { event: "open-paths", payload: [repos[0].root] });
  await page.locator(".topbar .repo-current > b").filter({ hasText: repos[0].name }).waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "Pull requests", exact: true }).click();
  await page.getByRole("combobox", { name: "Pull request scope", exact: true }).selectOption("all");
  const region = page.getByRole("region", { name: "Pull requests across repositories", exact: true });
  await region.getByRole("combobox", { name: "Authors across repositories", exact: true }).selectOption("all");
  await region.getByRole("button", { name: "Refresh all pull requests", exact: true }).first().waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh all pull requests"]')?.disabled, null, { timeout: 120_000 });
  const loaded = Number(await region.locator("[data-pr-loaded]").first().getAttribute("data-pr-loaded"));
  if (loaded !== expected) throw new Error(`The PR Center lists ${loaded} of ${expected} rows: ${await region.locator(".pr-scan-issues").textContent().catch(() => "")}`);
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const measured = await page.evaluate(async () => {
      const region = document.querySelector('[aria-label="Pull requests across repositories"]');
      const count = () => Number(region.querySelector("[data-pr-loaded]")?.getAttribute("data-pr-loaded") ?? 0);
      const button = () => region.querySelector('button[aria-label="Refresh all pull requests"]');
      const began = performance.now();
      button().click();
      let started = false, fewest = count();
      while (performance.now() - began < 110_000) {
        await new Promise(resolve => setTimeout(resolve, 10));
        fewest = Math.min(fewest, count());
        if (button().disabled) started = true;
        else if (started) break;
      }
      return { total: performance.now() - began, fewest, rows: count(), started };
    });
    if (!measured.started) throw new Error("The PR Center refresh did not start");
    if (measured.rows !== expected) throw new Error(`PR Center refresh ended with ${measured.rows} of ${expected} rows`);
    samples.push({ total: measured.total, fewestVisible: measured.fewest });
  }
  return samples;
}

// ── command line ───────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  if (args[0] === "--table") {
    console.log(table(JSON.parse(fs.readFileSync(args[1], "utf8"))));
    return;
  }
  if (args[0] === "--compare") {
    const [a, b] = args.slice(1).map(file => JSON.parse(fs.readFileSync(file, "utf8")));
    console.log(compare(a, b));
    return;
  }
  const fixtures = path.resolve(option("--fixtures", ""));
  const manifestFile = path.join(fixtures, "manifest.json");
  if (!fs.existsSync(manifestFile)) throw new Error("usage: perf-baseline.mjs --fixtures <dir made by perf-fixtures.mjs> [--exe path] [--runs N] [--out file] [--only a,b]");
  const temp = path.resolve(process.env.REVQORA_TEST_TMP || "");
  if (!process.env.REVQORA_TEST_TMP) throw new Error("Set REVQORA_TEST_TMP (and TEMP/TMP) to a disposable directory");
  const exe = path.resolve(option("--exe", path.join(here, "../src-tauri/target/release/revqora.exe")));
  const only = option("--only", "startup,switch,diff,search,history,workspace,prs").split(",");
  const timings = path.join(fs.mkdtempSync(path.join(temp, "baseline-")), "stage-timings.jsonl");
  process.env.REVQORA_STAGE_TIMINGS = timings;
  const context = {
    exe, fixtures, temp, timings, runs: Number(option("--runs", 5)),
    manifest: JSON.parse(fs.readFileSync(manifestFile, "utf8")),
    fixture: name => path.join(fixtures, name),
    only: name => only.includes(name),
  };
  const result = {
    label: option("--label", execFileSync("git", ["-C", here, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()),
    measuredAt: new Date().toISOString(),
    conditions: { runs: context.runs, exe: path.basename(exe), exeBytes: fs.statSync(exe).size, git: context.manifest.git, fixtureVersion: context.manifest.version, platform: `${process.platform} ${process.arch}`, cpus: (await import("node:os")).cpus().length },
    scenarios: {},
  };
  const steps = [["startup", startup], ["session", session], ["workspace", workspace], ["prs", pullRequests]];
  const out = option("--out");
  try {
    for (const [name, run] of steps) {
      if (name === "session" ? !["switch", "diff", "search", "history"].some(context.only) : !context.only(name)) continue;
      const started = Date.now();
      const value = await run(context);
      if (name === "prs") { Object.assign(result.scenarios, value.scenarios); result.prOutcome = value.outcome; }
      else Object.assign(result.scenarios, value);
      console.error(`${name}: ${Date.now() - started} ms`);
      // Keep finished scenarios when a later one fails.
      if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
    }
  } finally {
    fs.rmSync(path.dirname(timings), { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(table(result));
}

/** Markdown table of medians and p95 (milliseconds), as in docs/APP_PERFORMANCE.md. */
export function table(result) {
  const cell = value => value ? `${Math.round(value.median)} / ${Math.round(value.p95)}` : "—";
  const rows = Object.entries(result.scenarios).map(([name, v]) => {
    const extra = Object.entries(v).filter(([key]) => !["runs", "total", "queue", "git", "ui"].includes(key)).map(([key, value]) => `${key} ${cell(value)}`).join("; ");
    return `| ${name} | ${v.runs} | ${cell(v.total)} | ${cell(v.queue)} | ${cell(v.git)} | ${cell(v.ui)} | ${extra} |`;
  });
  return ["| Scenario | Runs | Total | Queue | Git/API | UI | Other (median / p95) |", "|---|---:|---:|---:|---:|---:|---|", ...rows].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
