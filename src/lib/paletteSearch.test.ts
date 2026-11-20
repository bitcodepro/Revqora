import { describe, expect, it } from "vitest";
import { nextFilter, PALETTE_FILTERS, rankPalette, type PaletteEntry } from "./paletteSearch";
import { SHORTCUTS } from "./shortcuts";

const entries: PaletteEntry[] = [
  { kind: "repository", label: "pull-service", context: "E:/work/pull-service" },
  { kind: "branch", label: "feature/pull-cache", context: "pull-service" },
  { kind: "folder", label: "Pull tools" },
  { kind: "command", label: "Pull" },
  { kind: "command", label: "Pull all repositories" },
  { kind: "command", label: "Report an issue" },
  { kind: "shortcut", label: "Pull", context: "Bring changes from the upstream." },
];
const labels = (query: string, filter: Parameters<typeof rankPalette>[2]) => rankPalette(query, entries, filter).map(entry => `${entry.kind}:${entry.label}`);

describe("command palette search", () => {
  it("lists commands and menu actions before repositories, branches and folders", () => {
    expect(labels("pull", "all")).toEqual([
      "command:Pull", "command:Pull all repositories",
      "repository:pull-service", "folder:Pull tools", "branch:feature/pull-cache",
    ]);
  });

  it("puts a command matched only by scattered letters after the repository typed by name", () => {
    const found = rankPalette("pse", [{ kind: "command", label: "Push selected" }, { kind: "repository", label: "pse-tools" }], "all");
    expect(found.map(entry => entry.label)).toEqual(["pse-tools", "Push selected"]);
  });

  it("shows only the chosen kind under a filter", () => {
    expect(labels("pull", "commands")).toEqual(["command:Pull", "command:Pull all repositories"]);
    expect(labels("pull", "branches")).toEqual(["branch:feature/pull-cache"]);
    expect(labels("pull", "repositories")).toEqual(["repository:pull-service"]);
    expect(labels("pull", "folders")).toEqual(["folder:Pull tools"]);
    expect(labels("pull", "shortcuts")).toEqual(["shortcut:Pull"]);
  });

  it("lists commands for an empty query, and everything of a kind under its filter", () => {
    expect(labels("", "all")).toEqual(["command:Pull", "command:Pull all repositories", "command:Report an issue"]);
    expect(labels("", "repositories")).toEqual(["repository:pull-service"]);
    expect(labels("", "shortcuts")).toEqual(["shortcut:Pull"]);
  });

  it("finds Report an issue", () => {
    expect(labels("issue", "all")).toEqual(["command:Report an issue"]);
    expect(SHORTCUTS.find(shortcut => shortcut.id === "report-issue")).toMatchObject({ label: "Report an issue", default: "" });
  });

  it("cycles the filters with Tab and Shift+Tab", () => {
    const ids = PALETTE_FILTERS.map(filter => filter.id);
    expect(ids).toEqual(["all", "commands", "shortcuts", "repositories", "branches", "folders"]);
    expect(nextFilter("all")).toBe("commands");
    expect(nextFilter("folders")).toBe("all");
    expect(nextFilter("all", true)).toBe("folders");
  });
});
