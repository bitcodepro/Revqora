// Timing only: no retries, shortened waits, mutation changes or swallowed errors.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function createTimings({ file, summary = process.env.GITHUB_STEP_SUMMARY, title = "Verification timings", now = () => performance.now() } = {}) {
  const started = now(), entries = [], totals = new Map();
  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive:true });
    fs.writeFileSync(file, JSON.stringify({ title, elapsedMs:now()-started, entries, totals:Object.fromEntries(totals) }, null, 2));
  };
  const record = (kind, name, start, status) => {
    const ms = now()-start;
    if (kind === "scenario" || kind === "stage") entries.push({ kind, name, ms, status });
    const key = `${kind}: ${name}`, prior = totals.get(key) ?? { count:0, ms:0, maxMs:0, failures:0 };
    totals.set(key, { count:prior.count+1, ms:prior.ms+ms, maxMs:Math.max(prior.maxMs,ms), failures:prior.failures+(status==="failed"?1:0) });
    if (kind !== "process") save();
  };
  return {
    async measure(kind, name, run) {
      const start=now(); let status="failed";
      try { const value=await run(); status="passed"; return value; }
      finally { record(kind,name,start,status); }
    },
    measureSync(kind, name, run) {
      const start=now(); let status="failed";
      try { const value=run(); status="passed"; return value; }
      finally { record(kind,name,start,status); }
    },
    finish() {
      save();
      const slow=[...entries].sort((a,b)=>b.ms-a.ms).slice(0,15);
      const seconds=ms=>(ms/1000).toFixed(2);
      const report=[`### ${title}`, "", `Elapsed: ${seconds(now()-started)}s. Nested timings overlap; do not sum them.`, "", "| Slowest stages/scenarios | Seconds | Result |", "| --- | ---: | --- |", ...slow.map(e=>`| ${e.name.replaceAll("|","/")} | ${seconds(e.ms)} | ${e.status} |`), "", "| Activity | Count | Total seconds | Max seconds |", "| --- | ---: | ---: | ---: |", ...[...totals].filter(([key])=>!key.startsWith("scenario:")&&!key.startsWith("stage:")).map(([key,t])=>`| ${key} | ${t.count} | ${seconds(t.ms)} | ${seconds(t.maxMs)} |`), ""].join("\n");
      console.log(report);
      if (summary) fs.appendFileSync(summary, report+"\n");
      return { entries:[...entries], totals:Object.fromEntries(totals) };
    },
  };
}

export const smokeTimings = createTimings({ file:process.env.REVQORA_SMOKE_OUT ? path.join(process.env.REVQORA_SMOKE_OUT,"timings.json") : undefined, title:`Native UI: ${process.env.REVQORA_SMOKE_SUITE || "all"}` });
// Only the executable name is recorded. Arguments can contain credentials.
export const timedExecFileSync = (file, args, options) => smokeTimings.measureSync("process", path.basename(file), () => execFileSync(file,args,options));

export const SMOKE_SUITES = Object.freeze({ core:{offset:0,count:71}, workspace:{offset:71,count:9}, cleanup:{offset:80,count:6}, worktrees:{offset:86,count:34} });
export function assertSmokeCoverage(suite, completed) {
  const expected=suite==="all"?Object.values(SMOKE_SUITES).reduce((sum,s)=>sum+s.count,0):SMOKE_SUITES[suite]?.count;
  if (completed!==expected) throw new Error(`Incomplete ${suite} coverage: ${completed} scenarios, expected ${expected}`);
}
