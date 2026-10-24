// Launches the built app with WebView2 remote debugging and connects Playwright to it.
// Usage (as a module): const { page, close } = await launch({ exe, args, port, profile });
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { chromium } from "playwright-core";

export async function launch({ exe, args = [], port = 9333, profile }) {
  if (port === 0) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CDP port");
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`, REVQORA_MULTI_INSTANCE: "1" };
  if (profile) env.WEBVIEW2_USER_DATA_FOLDER = profile;
  const child = spawn(exe, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  let startupError;
  let stderr = "";
  child.on("error", (error) => { startupError = error.message; });
  child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-4000); });
  let browser;
  let connectionError = "";
  for (let i = 0; i < 60; i++) {
    if (startupError || child.exitCode !== null) break;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch (error) {
      connectionError = error.message.slice(0, 1600);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) {
    const state = startupError ?? (child.exitCode === null ? "app is still running" : `app exited with code ${child.exitCode}`);
    let windowState = "";
    if (process.platform === "win32" && child.pid && child.exitCode === null) {
      try {
        const command = `$p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; $listeners = @(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,State,OwningProcess); [pscustomobject]@{SessionId=$p.SessionId;WindowTitle=$p.MainWindowTitle;Responding=$p.Responding;Listeners=$listeners} | ConvertTo-Json -Compress`;
        windowState = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
      } catch { windowState = "Window diagnostics unavailable"; }
    }
    child.kill();
    throw new Error(`Could not connect to the WebView over CDP: ${state}\n${connectionError}${windowState ? `\n${windowState}` : ""}${stderr ? `\n${stderr}` : ""}`);
  }
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) {
    await browser.close();
    child.kill();
    throw new Error("No page found");
  }
  await page.waitForLoadState("domcontentloaded");
  return {
    page,
    browser,
    child,
    close: async () => {
      try {
        await browser.close();
      } catch {}
      child.kill();
    },
  };
}
