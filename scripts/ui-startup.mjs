// Fail early if a runner cannot initialize native WebView2 automation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./ui-driver.mjs";

const index = process.argv.indexOf("--exe");
if (index < 0 || !process.argv[index + 1]) throw new Error("Pass --exe with the native application path");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "revqora-startup-"));
const { close } = await launch({ exe: path.resolve(process.argv[index + 1]), profile, port: 0 });
await close();
console.log("Native WebView2 startup and CDP connection passed.");
