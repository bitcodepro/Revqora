import { describe, expect, it } from "vitest";
import { keyboardOwner, listKeysBlocked, shortcutBlocked } from "./keyboardOwner";

const page = (...present: string[]) => ({ querySelector: (selector: string) => (present.includes(selector) ? {} : null) });

describe("keyboard owner", () => {
  it("names the topmost surface: a dialog over the palette, a menu and a tool window", () => {
    expect(keyboardOwner(page())).toBeNull();
    expect(keyboardOwner(page(".conflict-overlay"))).toBe("tool");
    expect(keyboardOwner(page(".conflict-overlay", ".ctx-menu"))).toBe("menu");
    expect(keyboardOwner(page(".ctx-menu", ".palette"))).toBe("palette");
    expect(keyboardOwner(page(".conflict-overlay", ".palette", ".modal"))).toBe("dialog");
  });

  it("runs no global shortcut behind a dialog, the palette or an open menu", () => {
    for (const owner of ["dialog", "palette", "menu"] as const) {
      for (const id of ["closeTab", "fetch", "stage-file", "palette", "refresh", "workspaceUndo"]) expect(shortcutBlocked(id, owner)).toBe(true);
    }
  });

  it("keeps application shortcuts under a tool window and blocks those for the view it covers", () => {
    for (const id of ["palette", "settings", "theme", "refresh", "fetch", "nextTab", "history", "workspaceUndo"]) expect(shortcutBlocked(id, "tool")).toBe(false);
    for (const id of ["stage-file", "unstage-file", "stage-all", "unstage-all", "close-preview", "historyFind"]) expect(shortcutBlocked(id, "tool")).toBe(true);
  });

  it("blocks nothing in a plain workspace", () => {
    for (const id of ["stage-file", "close-preview", "historyFind", "closeTab"]) expect(shortcutBlocked(id, null)).toBe(false);
    expect(listKeysBlocked(null)).toBe(false);
  });

  it("keeps unbound list keys away from a history list behind any surface", () => {
    for (const owner of ["dialog", "palette", "menu", "tool"] as const) expect(listKeysBlocked(owner)).toBe(true);
  });
});
