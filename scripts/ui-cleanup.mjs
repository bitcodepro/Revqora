import fs from "node:fs";
import { execFileSync } from "node:child_process";

// A worktree opened by a scenario can still have native readers after switching
// tabs or restoring the session. Release the app before removing its fixtures.
export async function shutdownAndCleanup(close, cleanups) {
  await close(); // A failed shutdown must never authorize fixture deletion.
  const errors = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Native fixture cleanup failed");
}

// Processes that can hold a fixture folder on Windows after the app is gone: what is still
// running, with its parent and command line, so a failed removal names its cause.
const HOLDERS = ["git", "git-remote-http", "git-remote-https", "ssh", "ssh-agent", "sh", "bash", "conhost", "revqora", "msedgewebview2", "node"];

export function describeLeftoverProcesses(run = defaultRun) {
  if (process.platform !== "win32") return "";
  const names = HOLDERS.map(name => `'${name}.exe'`).join(",");
  const script = `Get-CimInstance Win32_Process | Where-Object { @(${names}) -contains $_.Name.ToLower() -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { '{0} pid={1} parent={2} started={3} {4}' -f $_.Name, $_.ProcessId, $_.ParentProcessId, $_.CreationDate, ([string]$_.CommandLine).Substring(0, [Math]::Min(300, ([string]$_.CommandLine).Length)) }`;
  try { return run(script).trim(); } catch (error) { return `(could not list processes: ${error.message})`; }
}

function defaultRun(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30000 });
}

// Removes a fixture folder. When Windows refuses, the processes still running are logged, and
// the folder is watched for a while to tell a slow exit from a lasting hold; the removal still
// fails, so the hold is fixed rather than waited out.
export async function removeFixtureFolder(folder, { remove = target => fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }), list = describeLeftoverProcesses, watchMs = 30000, pollMs = 2000, log = console.error } = {}) {
  try { remove(folder); return; }
  catch (error) {
    log(`Removing ${folder} failed (${error.code ?? error.message}). Processes still running:\n${list() || "(none of git, ssh, sh, conhost, Revqora, WebView2)"}`);
    const started = Date.now();
    while (Date.now() - started < watchMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      try {
        remove(folder);
        log(`${folder} could be removed ${Math.round((Date.now() - started) / 1000)} s later. Processes running then:\n${list() || "(none)"}`);
        break;
      } catch {}
    }
    throw error;
  }
}
