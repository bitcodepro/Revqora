// Launches the built app with WebView2 remote debugging and connects Playwright to it.
// Usage (as a module): const { page, close } = await launch({ exe, args, port, profile });
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

export async function launch({ exe, args = [], port = 9333, profile }) {
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, REVQORA_MULTI_INSTANCE: "1" };
  if (profile) env.WEBVIEW2_USER_DATA_FOLDER = profile;
  const child = spawn(exe, args, { env, stdio: "ignore" });
  let browser;
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) {
    child.kill();
    throw new Error("Could not connect to the WebView over CDP");
  }
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error("No page found");
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
