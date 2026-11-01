import path from "node:path";

// Native WebView CDP can expose an initial document before the app navigation.
// Keep URL/origin/storage failures visible; never disable browser security or
// treat an inaccessible application store as an empty set of preferences.
export function isApplicationUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "tauri:" && url.hostname === "localhost" && !url.port)
      || (["http:", "https:"].includes(url.protocol) && url.hostname === "tauri.localhost" && !url.port)
      || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "1420");
  } catch { return false; }
}

// Self-contained: Playwright serializes this function into the native document.
export function applicationDocumentState() {
  const state = {
    url: location.href, origin: location.origin, readyState: document.readyState,
    rootRendered: !!document.querySelector("#root")?.childElementCount,
    startup: document.querySelector("[data-app-startup]")?.getAttribute("data-app-startup") ?? null,
    bridgeReady: typeof window.__TAURI_INTERNALS__?.invoke === "function",
    storageReadable: false, storageError: null,
  };
  try { window.localStorage.getItem("revqora.settings"); state.storageReadable = true; }
  catch (e) { state.storageError = `${e.name}: ${e.message}`.slice(0, 512); }
  return state;
}

export async function waitForApplicationPage(browser, { timeoutMs = 30000, pollMs = 100, observe = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  const diagnostics = new Map();
  while (Date.now() < deadline) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      let state;
      try {
        state = await page.evaluate(applicationDocumentState);
      } catch (e) { state = { url: page.url(), error: String(e.message ?? e).slice(0, 512) }; }
      const previous = diagnostics.get(state.url);
      if (JSON.stringify(previous) !== JSON.stringify(state)) observe(state);
      diagnostics.set(state.url, state);
      if (diagnostics.size > 8) diagnostics.delete(diagnostics.keys().next().value);
      if (isApplicationUrl(state.url) && ["interactive", "complete"].includes(state.readyState)
          && state.rootRendered && state.bridgeReady && state.storageReadable && state.startup === "ready") return page;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Revqora document/storage did not become ready: ${JSON.stringify([...diagnostics.values()])}`);
}

// Forced taskkill /F is a crash, not a settings-flush barrier. Account/task state is native
// portable data: open its repository explicitly without recreating any records.
export async function openRepository(page, root) {
  await page.locator('[data-app-startup="ready"]').waitFor();
  await page.evaluate(p => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: [p] }), root);
  await page.waitForFunction(repositoryIsActive, { expected: root, windows: process.platform === "win32" });
  await page.locator(".topbar .repo-current > b").filter({ hasText: path.basename(root) }).waitFor();
}

// Serialized into the native document: confirm identity, not a matching basename
// from an old tab. The header title comes from the active repository's root.
export function repositoryIsActive({ expected, windows }) {
  const actual = document.querySelector(".topbar .repo-current")?.getAttribute("title");
  const normalize = value => {
    let path = value.replaceAll("\\", "/");
    if (path.startsWith("//?/UNC/")) path = "//" + path.slice(8);
    else if (path.startsWith("//?/")) path = path.slice(4);
    path = path.replace(/\/+$/, "");
    return windows ? path.toLowerCase() : path;
  };
  return typeof actual === "string" && normalize(actual) === normalize(expected);
}
