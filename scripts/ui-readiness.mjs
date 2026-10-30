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
          && state.rootRendered && state.bridgeReady && state.storageReadable) return page;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Revqora document/storage did not become ready: ${JSON.stringify([...diagnostics.values()])}`);
}
