import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY_FILTERS, filterChips, filterError, filterRequest, isValidDate, removeFilter, historyListMode } from "./historyFilters";

describe("history filters", () => {
  it("validates calendar dates", () => {
    expect(isValidDate("2024-02-29")).toBe(true);
    expect(isValidDate("2023-02-29")).toBe(false);
    expect(isValidDate("2024-13-01")).toBe(false);
    expect(isValidDate("2024-1-01")).toBe(false);
    expect(isValidDate("yesterday")).toBe(false);
  });
  it("reports option-like values and bad ranges", () => {
    expect(filterError({ ...EMPTY_HISTORY_FILTERS, author: "--all" })).toMatch(/'-'/);
    expect(filterError({ ...EMPTY_HISTORY_FILTERS, path: " -x" })).toMatch(/'-'/);
    expect(filterError({ ...EMPTY_HISTORY_FILTERS, since: "2024-05-02", until: "2024-05-01" })).toMatch(/after/);
    expect(filterError({ ...EMPTY_HISTORY_FILTERS, since: "2024-05-01", until: "2024-05-01" })).toBeNull();
  });
  it("builds a trimmed request only when a filter is active", () => {
    expect(filterRequest(EMPTY_HISTORY_FILTERS)).toBeNull();
    expect(filterRequest({ ...EMPTY_HISTORY_FILTERS, author: "  " })).toBeNull();
    expect(filterRequest({ ...EMPTY_HISTORY_FILTERS, author: " Ann ", path: "src\\lib/" })).toEqual({ ...EMPTY_HISTORY_FILTERS, author: "Ann", path: "src/lib" });
    expect(filterRequest({ ...EMPTY_HISTORY_FILTERS, noMerges: true })?.noMerges).toBe(true);
  });
  it("lists and removes chips", () => {
    const f = { ...EMPTY_HISTORY_FILTERS, author: "Ann", since: "2024-01-01", firstParent: true };
    expect(filterChips(f).map((c) => c.key)).toEqual(["author", "since", "firstParent"]);
    expect(filterChips(removeFilter(f, "firstParent")).map((c) => c.key)).toEqual(["author", "since"]);
  });
});

describe("history list mode", () => {
  const base = { filtersActive: false, searchActive: false, loaded: true, matches: 0, onlyMatching: false, currentOutsideGraph: false };
  it("filters alone show only matching commits, or an empty state", () => {
    expect(historyListMode({ ...base, filtersActive: true, matches: 3 })).toBe("list");
    expect(historyListMode({ ...base, filtersActive: true, matches: 0 })).toBe("empty");
    expect(historyListMode({ ...base, filtersActive: true, loaded: false })).toBe("graph");
  });
  it("search text alone keeps highlighting in the graph", () => {
    expect(historyListMode({ ...base, searchActive: true, matches: 3 })).toBe("graph");
    expect(historyListMode({ ...base, searchActive: true, matches: 3, onlyMatching: true })).toBe("list");
    expect(historyListMode({ ...base, searchActive: true, matches: 3, currentOutsideGraph: true })).toBe("list");
    expect(historyListMode({ ...base, searchActive: true, matches: 0 })).toBe("graph");
  });
});
