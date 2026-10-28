// Fail early if a runner cannot initialize native WebView2 automation.
import path from "node:path";
import fs from "node:fs";
import { createProfile, launch } from "./ui-driver.mjs";

const index = process.argv.indexOf("--exe");
if (index < 0 || !process.argv[index + 1]) throw new Error("Pass --exe with the native application path");
const profile = createProfile("revqora-startup-");
let close;
try {
  ({ close } = await launch({ exe: path.resolve(process.argv[index + 1]), profile, port: 0 }));
} finally {
  await close?.();
  if (!process.argv.includes("--keep")) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log("Native WebView2 startup and CDP connection passed.");
