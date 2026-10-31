import { describe, expect, it } from "vitest";
import { appendPullRequests, pullRequestNumber, restorePrPreferences, safeWebUrl, searchPullRequests, utf8Length } from "./prCenter";
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
