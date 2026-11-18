// Repeatable fixtures for performance baselines (docs/APP_PERFORMANCE.md, "Baseline harness").
//
//   node scripts/perf-fixtures.mjs <empty-target-dir> [--merges-commits N] [--workspace N]
//
// Creates, with the same content on every run (fixed seed, fixed dates):
//   normal/      5,275 commits: 5,075 on main, a 200-commit topic fork, 33 local and remote refs,
//                tokens for search (subject PERF-825 at commit 800, body-only PERF-BODY-810 at 810,
//                every 17th commit by perf-17@example.invalid).
//   merges/      a merge-heavy history (default 20,000 commits, 40 feature branches merged back).
//   large-diff/  HEAD changes 600 files, renames 50 and rewrites 5,000 lines of a 20,000-line file.
//   workspace/   N clones (default 40) of one origin: 3 ahead, 3 behind, 3 with changes,
//                2 on a branch without upstream with unpublished commits, the rest clean.
//   manifest.json  generator version, Git version and the expected answers for checks.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_VERSION = 1;
const IDENTITY = ["-c", "user.name=Perf Fixture", "-c", "user.email=perf@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
const git = (cwd, ...args) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds a `git fast-import` stream. */
class Importer {
  constructor() { this.parts = []; this.mark = 0; this.time = 1_700_000_000; }
  blob(text) {
    const data = Buffer.from(text);
    this.parts.push(Buffer.from(`blob\nmark :${++this.mark}\ndata ${data.length}\n`), data, Buffer.from("\n"));
    return this.mark;
  }
  commit(ref, { from, merge, message, author = "Perf Fixture <perf@example.invalid>", changes = [] }) {
    this.time += 60;
    const mark = ++this.mark;
    const data = Buffer.from(message);
    let head = `commit ${ref}\nmark :${mark}\nauthor ${author} ${this.time} +0000\ncommitter ${author} ${this.time} +0000\ndata ${data.length}\n`;
    let tail = "";
    if (from) tail += `from ${from}\n`;
    if (merge) tail += `merge ${merge}\n`;
    for (const change of changes) tail += `${change}\n`;
    this.parts.push(Buffer.from(head), data, Buffer.from(`\n${tail}\n`));
    return `:${mark}`;
  }
  reset(ref, from) { this.parts.push(Buffer.from(`reset ${ref}\nfrom ${from}\n\n`)); }
  run(repo) {
    const result = spawnSync("git", ["fast-import", "--quiet"], { cwd: repo, input: Buffer.concat(this.parts), maxBuffer: 1 << 30 });
    if (result.status !== 0) throw new Error(`fast-import failed: ${result.stderr}`);
  }
}

function init(dir, bare = false) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main", ...(bare ? ["--bare"] : []));
}

export function makeNormal(dir) {
  init(dir);
  const im = new Importer();
  const main = [];
  for (let i = 1; i <= 5075; i++) {
    const blob = im.blob(`revision ${i}\n`);
    const message = i === 800 ? "PERF-825 unique subject token\n" : i === 810 ? "Commit 810\n\nThe body holds PERF-BODY-810 only.\n" : `Commit ${i}\n`;
    const author = i % 17 === 0 ? "Perf Seventeen <perf-17@example.invalid>" : undefined;
    main.push(im.commit("refs/heads/main", { message, author, changes: [`M 100644 :${blob} notes/file${i % 50}.txt`] }));
  }
  let topic = main[4799];
  im.reset("refs/heads/topic", topic);
  for (let i = 1; i <= 200; i++) {
    const blob = im.blob(`topic ${i}\n`);
    topic = im.commit("refs/heads/topic", { message: `Topic ${i}\n`, changes: [`M 100644 :${blob} topic/file${i % 20}.txt`] });
  }
  for (let k = 1; k <= 32; k++) im.reset(`refs/heads/ref-${String(k).padStart(2, "0")}`, main[k * 150]);
  im.reset("refs/remotes/origin/main", main[5073]);
  for (let k = 1; k <= 32; k++) im.reset(`refs/remotes/origin/ref-${String(k).padStart(2, "0")}`, main[k * 150 - 1]);
  im.run(dir);
  git(dir, "checkout", "-q", "-f", "main");
  return { commits: 5275, mainCommits: 5075, subjectToken: "PERF-825", subjectTokenCommit: 800, bodyToken: "PERF-BODY-810", authorEmail: "perf-17@example.invalid", authorCommits: Math.floor(5075 / 17) };
}

export function makeMerges(dir, commits = 20_000, branches = 40) {
  init(dir);
  const rnd = random(7);
  const im = new Importer();
  const words = "fix add refactor update remove improve parser graph cache index merge layout theme button docs tests api client server".split(" ");
  const authors = ["Alex Rivera <alex@example.invalid>", "Sam Chen <sam@example.invalid>", "Jordan Blake <jordan@example.invalid>", "Taylor Morgan <taylor@example.invalid>"];
  const pick = list => list[Math.floor(rnd() * list.length)];
  const open = new Map();
  const mainMarks = [];
  let main = null, merges = 0;
  const commit = (ref, from, merge, message) => {
    const blob = im.blob(`line ${im.mark}\n`);
    return im.commit(ref, { from, merge, message: message ?? `${pick(words)} ${pick(words)} ${im.mark}\n`, author: pick(authors), changes: [`M 100644 :${blob} src/file${im.mark % 500}.txt`] });
  };
  for (let i = 0; i < commits; i++) {
    const r = rnd();
    if (open.size && r < 0.35) {
      const name = pick([...open.keys()]);
      open.set(name, commit(`refs/heads/${name}`, open.get(name)));
      if (rnd() < 0.03) {
        main = commit("refs/heads/main", main, open.get(name), `Merge branch '${name}'\n`);
        mainMarks.push(main);
        merges++;
        open.delete(name);
      }
    } else if (open.size < branches && r < 0.40 && mainMarks.length) {
      const name = `feature/${pick(words)}-${i}`;
      open.set(name, commit(`refs/heads/${name}`, mainMarks[Math.max(0, mainMarks.length - 1 - Math.floor(rnd() * 200))]));
    } else {
      main = commit("refs/heads/main", main);
      mainMarks.push(main);
    }
  }
  im.run(dir);
  git(dir, "checkout", "-q", "-f", "main");
  return { commits, merges, openBranches: open.size };
}

export function makeLargeDiff(dir) {
  init(dir);
  const im = new Importer();
  const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix} line ${i + 1}`).join("\n") + "\n";
  const base = [];
  for (let i = 0; i < 650; i++) base.push(`M 100644 :${im.blob(lines(`file ${i}`, 50))} src/module${i % 20}/file${i}.ts`);
  base.push(`M 100644 :${im.blob(lines("big", 20_000))} data/big.txt`);
  const first = im.commit("refs/heads/main", { message: "Base for the large diff\n", changes: base });
  const change = [];
  for (let i = 0; i < 600; i++) change.push(`M 100644 :${im.blob(lines(`file ${i}`, 50).replace(`file ${i} line 25`, `file ${i} line 25 changed`))} src/module${i % 20}/file${i}.ts`);
  for (let i = 600; i < 650; i++) change.push(`R src/module${i % 20}/file${i}.ts src/renamed/file${i}.ts`);
  const big = lines("big", 20_000).split("\n").map((line, i) => i % 4 === 0 ? `${line} rewritten` : line).join("\n");
  change.push(`M 100644 :${im.blob(big)} data/big.txt`);
  im.commit("refs/heads/main", { from: first, message: "Change 600 files, rename 50 and rewrite 5,000 lines\n", changes: change });
  im.run(dir);
  git(dir, "checkout", "-q", "-f", "main");
  return { changedFiles: 651, renamedFiles: 50, bigFileChangedLines: 5000 };
}

export function makeWorkspace(dir, count = 40) {
  fs.mkdirSync(dir, { recursive: true });
  const seed = path.join(dir, "seed"), origin = path.join(dir, "origin.git");
  init(seed);
  const im = new Importer();
  let tip = null;
  const files = [];
  for (let i = 0; i < 500; i++) files.push(`M 100644 :${im.blob(`file ${i}\n`.repeat(20))} src/dir${i % 25}/file${i}.txt`);
  tip = im.commit("refs/heads/main", { message: "Initial files\n", changes: files });
  for (let i = 1; i < 200; i++) tip = im.commit("refs/heads/main", { from: tip, message: `Work ${i}\n`, changes: [`M 100644 :${im.blob(`work ${i}\n`)} notes/note${i % 10}.txt`] });
  im.run(seed);
  git(seed, "checkout", "-q", "-f", "main");
  git(dir, "clone", "-q", "--bare", seed, origin);
  const repos = [];
  const expected = { outgoing: [], incoming: [], changes: [], unpublished: [] };
  for (let i = 1; i <= count; i++) {
    const name = `repo-${String(i).padStart(2, "0")}`, repo = path.join(dir, name);
    git(dir, "clone", "-q", origin, repo);
    repos.push(name);
  }
  // Behind: the server gets one commit after these clones fetch it.
  git(seed, "commit", "-q", "--allow-empty", "-m", "Incoming commit");
  git(seed, "push", "-q", origin, "main");
  repos.forEach((name, index) => {
    const repo = path.join(dir, name), kind = index % 13;
    if (kind === 1) { git(repo, "commit", "-q", "--allow-empty", "-m", "Commit to push"); expected.outgoing.push(name); }
    if (kind === 2) { git(repo, "fetch", "-q", "origin"); expected.incoming.push(name); }
    if (kind === 3) { fs.appendFileSync(path.join(repo, "src/dir0/file0.txt"), "edited\n"); fs.writeFileSync(path.join(repo, "untracked.log"), "x"); expected.changes.push(name); }
    if (kind === 4 && expected.unpublished.length < 2) { git(repo, "switch", "-q", "-c", "local-only"); git(repo, "commit", "-q", "--allow-empty", "-m", "Unpublished"); expected.unpublished.push(name); }
  });
  fs.rmSync(seed, { recursive: true, force: true, maxRetries: 5 });
  return { repositories: repos, origin: "origin.git", expected };
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find(a => !a.startsWith("--"));
  if (!target) throw new Error("usage: node scripts/perf-fixtures.mjs <empty-target-dir> [--merges-commits N] [--workspace N]");
  const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
  const root = path.resolve(target);
  // Never write into existing work.
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`${root} is not empty`);
  fs.mkdirSync(root, { recursive: true });
  const started = Date.now();
  const manifest = {
    version: FIXTURE_VERSION,
    git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
    normal: makeNormal(path.join(root, "normal")),
    merges: makeMerges(path.join(root, "merges"), option("--merges-commits", 20_000)),
    largeDiff: makeLargeDiff(path.join(root, "large-diff")),
    workspace: makeWorkspace(path.join(root, "workspace"), option("--workspace", 40)),
  };
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`fixtures v${FIXTURE_VERSION} in ${root} (${Date.now() - started} ms)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
