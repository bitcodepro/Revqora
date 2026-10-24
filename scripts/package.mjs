// Packs the release build into a portable zip for GitHub Releases:
//   Revqora-<version>-win-x64.zip
//     Revqora/revqora.exe
//     Revqora/LICENSE, THIRD_PARTY_NOTICES.md
// Users unpack it anywhere and run revqora.exe (Git must be installed); updates replace the files.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const releaseDir = path.join(root, "src-tauri", "target", "release");
const exe = path.join(releaseDir, "revqora.exe");
if (!fs.existsSync(exe)) throw new Error("Release build not found — run `npx tauri build` first.");

const out = path.join(root, "release");
const stage = path.join(out, "Revqora");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(exe, path.join(stage, "revqora.exe"));
for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) fs.copyFileSync(path.join(root, f), path.join(stage, f));

const zip = path.join(out, `Revqora-${version}-win-x64.zip`);
fs.rmSync(zip, { force: true });
const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
execFileSync(tar, ["-a", "-c", "-f", zip, "-C", out, "Revqora"], { stdio: "inherit" });
const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`Packed ${path.relative(root, zip)} (${mb} MB)`);
