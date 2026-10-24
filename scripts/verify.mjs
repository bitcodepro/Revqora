// Full local verification: formatting, lint, unit + integration tests, production build, UI smoke test.
//   npm run verify            (everything)
//   npm run verify -- --quick (skip the release build and the UI smoke test)
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH}` };
const tauriDir = path.join(root, "src-tauri");

const steps = [
  ["Rust format", "cargo", ["fmt", "--check"], tauriDir],
  ["Rust lint (clippy, warnings are errors)", "cargo", ["clippy", "--all-targets", "--", "-D", "warnings"], tauriDir],
  ["Rust unit + git workflow tests", "cargo", ["test"], tauriDir],
  ["TypeScript typecheck", "npx", ["tsc", "--noEmit", "-p", "."], root],
  ["Frontend unit tests", "npx", ["vitest", "run"], root],
];
if (!quick) {
  steps.push(["Release build", "npx", ["tauri", "build"], root]);
  steps.push(["Portable zip", "node", ["scripts/package.mjs"], root]);
  steps.push(["UI smoke test (real app via WebView2 CDP)", "node", ["scripts/ui-smoke.mjs", "--exe", path.join(root, "release", "Revqora", process.platform === "win32" ? "revqora.exe" : "revqora")], root]);
}

const results = [];
for (const [name, cmd, args, cwd] of steps) {
  const t = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  results.push(`${r.status === 0 ? "PASS" : "FAIL"}  ${name}  (${secs}s)`);
  if (r.status !== 0) {
    console.log("\n" + results.join("\n"));
    console.log(`\nVerification FAILED at: ${name}`);
    process.exit(1);
  }
}
console.log("\n" + results.join("\n"));
console.log(quick ? "\nQuick verification passed (release build and UI smoke test skipped)." : "\nAll verification steps passed.");
