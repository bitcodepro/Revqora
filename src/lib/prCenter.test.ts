import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendPullRequests, pullRequestNumber, restorePrPreferences, safeWebUrl, searchPullRequests, utf8Length, prWriteAttemptKey, prWriteAttemptPending, setPrWriteAttemptPending } from "./prCenter";
import type { PullRequest } from "./types";
const row = (number: number, title: string): PullRequest => ({ number, title, author: "Alice", head: "feature/login", base: "main", state: "open", draft: false, created: "2026-01-01", headSha: "a".repeat(40), url: "https://example.invalid/pr/1" });
describe("PR Center", () => {
  it("restores independent bounded panels from untrusted saved preferences", () => {
    expect(restorePrPreferences({ state: "bad", section: "files", listOpen: false, filesOpen: "false", listWidth: 9999, filesWidth: NaN })).toEqual({ state: "open", section: "files", listOpen: false, filesOpen: true, listWidth: 520, filesWidth: 220 });
    expect(restorePrPreferences(null).listWidth).toBe(280);
  });
  it("combines overlapping pages while preserving order and updated metadata", () => {
    const merged = appendPullRequests([row(1,"before"),row(2,"second")],[row(1,"after"),row(3,"third")]);
    expect(merged.map(p=>[p.number,p.title])).toEqual([[1,"after"],[2,"second"],[3,"third"]]);
    expect(searchPullRequests(merged,"#2 ALICE login").map(p=>p.number)).toEqual([2]);
  });
  it("accepts only exact safe request numbers", () => {
    expect(pullRequestNumber(" #42 ")).toBe(42);
    for (const value of ["0","-1","42 text","1.5","1e3","9007199254740992"]) expect(pullRequestNumber(value)).toBeNull();
  });
  it("does not launch credential or non-web links returned by providers", () => {
    for (const value of ["file:///bad.exe","javascript:alert(1)","https://token@host/pr","https://host/\npr"]) expect(safeWebUrl(value)).toBeNull();
    expect(safeWebUrl("https://host/pr/1")).toBe("https://host/pr/1");
    expect(utf8Length("Тест😀")).toBe(12);
  });
});

describe("durable PR write attempts", () => {
  beforeEach(() => {
    const storage: Record<string, unknown> = {};
    vi.stubGlobal("localStorage", Object.assign(storage, {
      getItem: (key: string) => typeof storage[key] === "string" ? storage[key] : null,
      setItem: (key: string, value: string) => { storage[key] = value; },
      removeItem: (key: string) => { delete storage[key]; },
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("retains a possibly saved create/edit across reloads and scopes acknowledgements", async () => {
    const create = prWriteAttemptKey("E:/Projects/repo", "connection", null), edit = prWriteAttemptKey("E:/Projects/repo", "connection", 7);
    setPrWriteAttemptPending(create, true); setPrWriteAttemptPending(edit, true);
    // Re-importing models an editor/app restart without copying any React state.
    vi.resetModules();
    const reopened = await import("./prCenter");
    expect(reopened.prWriteAttemptPending(reopened.prWriteAttemptKey("E:/Projects/repo", "connection", null))).toBe(true);
    expect(reopened.prWriteAttemptPending(edit)).toBe(true);
    for (const other of [prWriteAttemptKey("E:/Projects/other", "connection", null), prWriteAttemptKey("E:/Projects/repo", "another", null), prWriteAttemptKey("E:/Projects/repo", "connection", 8)]) expect(prWriteAttemptPending(other)).toBe(false);
    setPrWriteAttemptPending(create, false);
    expect(prWriteAttemptPending(create)).toBe(false); expect(prWriteAttemptPending(edit)).toBe(true);
    setPrWriteAttemptPending(edit, false); expect(prWriteAttemptPending(edit)).toBe(false);
  });
  it("fails closed on inaccessible storage and refuses to forget old attempts at its limit", () => {
    const key = prWriteAttemptKey("repo", "connection", null);
    localStorage.setItem(key, "interrupted or malformed marker"); expect(prWriteAttemptPending(key)).toBe(true);
    for (let n = 1; n < 32; n++) setPrWriteAttemptPending(prWriteAttemptKey("repo", "connection", n), true);
    expect(() => setPrWriteAttemptPending(prWriteAttemptKey("repo", "connection", 99), true)).toThrow(/pending PR write/);
    expect(prWriteAttemptPending(key)).toBe(true);
    vi.stubGlobal("localStorage", { getItem() { throw Error("Unavailable"); } });
    expect(prWriteAttemptPending(key)).toBe(true); expect(() => setPrWriteAttemptPending(key, true)).toThrow("Unavailable");
  });
});
