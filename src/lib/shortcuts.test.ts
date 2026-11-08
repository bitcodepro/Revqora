import { describe, expect, it } from "vitest";
import { SHORTCUTS, shortcutConflict } from "./shortcuts";

describe("shortcut conflicts", () => {
  it("rejects duplicate bindings that can be active together in History or the diff", () => {
    expect(shortcutConflict("previewNextFile", "f7", {})?.id).toBe("diffNext");
    expect(shortcutConflict("diffNext", "F8", { previewNextFile: "F8" })?.id).toBe("previewNextFile");
    expect(shortcutConflict("previewNextFile", "Ctrl+F", { diffFind: "" })?.id).toBe("historyFind");
    expect(shortcutConflict("historyFind", "F7", {})?.id).toBe("diffNext");
  });

  it("preserves the defaults for focus-sensitive search and separate editors", () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.default) expect(shortcutConflict(shortcut.id, shortcut.default, {}), shortcut.id).toBeUndefined();
    }
  });

  it("still rejects collisions with global actions and respects cleared bindings", () => {
    expect(shortcutConflict("previewNextFile", "F5", {})?.id).toBe("refresh");
    expect(shortcutConflict("previewNextFile", "F7", { diffNext: "" })).toBeUndefined();
  });
});
