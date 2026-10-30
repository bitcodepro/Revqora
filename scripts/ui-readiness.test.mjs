import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { applicationDocumentState, isApplicationUrl, waitForApplicationPage } from "./ui-readiness.mjs";

const ready = (patch = {}) => ({ url: "http://tauri.localhost/", origin: "http://tauri.localhost", readyState: "complete", rootRendered: true, bridgeReady: true, storageReadable: true, storageError: null, ...patch });
const page = (states) => {
  let index = 0;
  return { url: () => states[Math.min(index, states.length - 1)].url, evaluate: async () => states[Math.min(index++, states.length - 1)] };
};
const browser = (...pages) => ({ contexts: () => [{ pages: () => pages }] });
const options = { timeoutMs: 2000, pollMs: 1 };

const documentContext = () => ({
  location: { href: "http://tauri.localhost/", origin: "http://tauri.localhost" },
  document: { readyState: "complete", querySelector: () => ({ childElementCount: 1 }) },
  window: { __TAURI_INTERNALS__: { invoke() {} } },
});
test("the serialized native-document probe catches a denied localStorage getter", () => {
  const context = documentContext();
  Object.defineProperty(context.window, "localStorage", { get() { const error = new Error("Access is denied for this document"); error.name = "SecurityError"; throw error; } });
  const state = vm.runInNewContext(`(${applicationDocumentState.toString()})()`, context);
  assert.equal(state.origin, "http://tauri.localhost");
  assert.equal(state.rootRendered, true);
  assert.equal(state.bridgeReady, true);
  assert.equal(state.storageReadable, false);
  assert.equal(state.storageError, "SecurityError: Access is denied for this document");
});
test("the serialized probe reads the store without changing preferences or logging their values", () => {
  let reads = 0;
  const context = documentContext();
  context.window.localStorage = { getItem(key) { assert.equal(key, "revqora.settings"); reads++; return "private preferences"; } };
  const state = vm.runInNewContext(`(${applicationDocumentState.toString()})()`, context);
  assert.equal(reads, 1);
  assert.equal(state.storageReadable, true);
  assert.equal(state.storageError, null);
  assert.doesNotMatch(JSON.stringify(state), /private preferences/);
});

test("app readiness rejects opaque, error and unrelated documents", () => {
  for (const url of ["about:blank", "data:text/html,hi", "chrome-error://chromewebdata/", "https://example.com/", "http://tauri.localhost.evil/", "http://localhost:9999"]) assert.equal(isApplicationUrl(url), false, url);
  for (const url of ["http://tauri.localhost/", "https://tauri.localhost/index.html", "tauri://localhost/", "http://localhost:1420/", "http://127.0.0.1:1420/"]) assert.equal(isApplicationUrl(url), true, url);
});
test("waits through a storage-denied initial document before accepting the real app", async () => {
  const observations = [];
  const native = page([ready({ url: "about:blank", origin: "null", rootRendered: false, bridgeReady: false, storageReadable: false, storageError: "SecurityError: Access is denied" }), ready()]);
  assert.equal(await waitForApplicationPage(browser(native), { ...options, observe: state => observations.push(state) }), native);
  assert.equal(observations[0].storageError, "SecurityError: Access is denied");
  assert.equal(observations.at(-1).origin, "http://tauri.localhost");
});
test("chooses the actual app rather than the first CDP page", async () => {
  const initial = page([ready({ url: "about:blank", origin: "null" })]);
  const native = page([ready()]);
  assert.equal(await waitForApplicationPage(browser(initial, native), options), native);
});
test("requires bridge, rendered React root and usable storage after DOMContentLoaded", async () => {
  const native = page([ready({ rootRendered: false }), ready({ bridgeReady: false }), ready({ storageReadable: false, storageError: "SecurityError: transient" }), ready()]);
  let observed = 0;
  assert.equal(await waitForApplicationPage(browser(native), { ...options, observe: () => observed++ }), native);
  assert.equal(observed, 4);
});
test("retains real application storage failures in bounded startup diagnostics", async () => {
  const native = page([ready({ storageReadable: false, storageError: "SecurityError: Access is denied for this document" })]);
  await assert.rejects(waitForApplicationPage(browser(native), { timeoutMs: 100, pollMs: 1 }), error => {
    assert.match(error.message, /http:\/\/tauri.localhost/);
    assert.match(error.message, /SecurityError: Access is denied/);
    assert.match(error.message, /"rootRendered":true/);
    return true;
  });
});
