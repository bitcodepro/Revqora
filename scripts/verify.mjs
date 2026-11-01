// Full local verification: formatting, lint, unit + integration tests, production build, UI smoke test.
//   npm run verify            (everything)
//   npm run verify -- --quick (skip the release build and the UI smoke test)
//   npm run verify -- --build-only (CI build producer; other checks are required jobs)
import { createTimings } from "./ci-timing.mjs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");
const buildOnly = process.argv.includes("--build-only");
if (quick && buildOnly) throw new Error("Choose --quick or --build-only");
const timings = createTimings({ file:process.env.REVQORA_VERIFY_TIMINGS, title:buildOnly ? "Windows native build" : "Verification stages" });
const features = process.env.REVQORA_VERIFY_UI_AUTOMATION === "1" ? ["--features", "ui-automation"] : [];
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH}` };
const tauriDir = path.join(root, "src-tauri");

const steps = [
  ["UI helper and fixture tests (no native window)", "node", ["--test", "scripts/ui-readiness.test.mjs", "scripts/branch-cleanup-fixture.test.mjs", "scripts/agent-workspace-fixture.test.mjs", "scripts/ci-timing.test.mjs"], root],
  ["Rust format", "cargo", ["fmt", "--check"], tauriDir],
  ["Rust lint (clippy, warnings are errors)", "cargo", ["clippy", "--all-targets", ...features, "--", "-D", "warnings"], tauriDir],
  ["Rust unit + git workflow tests", "cargo", ["test", ...features], tauriDir],
  ["TypeScript typecheck", "npx", ["tsc", "--noEmit", "-p", "."], root],
  ["Frontend unit tests", "npx", ["vitest", "run"], root],
];
if (buildOnly) steps.length = 0;
if (!quick) {
  steps.push(["Release build", "npx", ["tauri", "build", ...features], root]);
  steps.push(["Portable zip", "node", ["scripts/package.mjs"], root]);
  if (!buildOnly) steps.push(["UI smoke test (real app via WebView2 CDP)", "node", ["scripts/ui-smoke.mjs", "--exe", path.join(root, "release", "Revqora", process.platform === "win32" ? "revqora.exe" : "revqora")], root]);
}

const results = [];
try {
for (const [name, cmd, args, cwd] of steps) {
  const t = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  timings.measureSync("stage", name, () => {
    const result = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) { const error = new Error(`${name} exited with ${result.status}`); error.result = result; throw error; }
    return result;
  });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const result = `PASS  ${name}  (${secs}s)`;
  results.push(result); console.log(result);
}
console.log("\n" + results.join("\n"));
console.log(buildOnly ? "\nNative build and portable zip passed; quick checks and native scenarios run in separate required CI jobs." : quick ? "\nQuick verification passed (release build and UI smoke test skipped)." : "\nAll verification steps passed.");
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { timings.finish(); }
