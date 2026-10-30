import { test } from "node:test";
import assert from "node:assert/strict";
import { isApplicationUrl, waitForApplicationPage } from "./ui-readiness.mjs";

const ready = (patch = {}) => ({ url: "http://tauri.localhost/", origin: "http://tauri.localhost", readyState: "complete", rootRendered: true, bridgeReady: true, storageReadable: true, storageError: null, ...patch });
const page = (states) => {
  let index = 0;
  return { url: () => states[Math.min(index, states.length - 1)].url, evaluate: async () => states[Math.min(index++, states.length - 1)] };
};
const browser = (...pages) => ({ contexts: () => [{ pages: () => pages }] });
const options = { timeoutMs: 2000, pollMs: 1 };

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
