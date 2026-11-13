import { describe, expect, it } from "vitest";
import { actionFor, comboFromEvent, matchesShortcut, SHORTCUTS, shortcutConflict } from "./shortcuts";

function key(code: string, key: string, extra: Partial<KeyboardEvent> = {}) {
  return { code, key, ctrlKey: true, ...extra } as KeyboardEvent;
}

describe("layout-independent shortcuts", () => {
  it("uses the same physical letter, number and punctuation in different layouts", () => {
    expect(actionFor(key("KeyN", "т"))).toBe("palette");
    expect(actionFor(key("KeyN", "n"))).toBe("palette");
    expect(actionFor(key("Digit1", "&"))).toBe("history");
    expect(actionFor(key("Comma", "б"))).toBe("settings");
    expect(actionFor(key("KeyR", "к", { shiftKey: true }))).toBe("reviewMode");
    expect(matchesShortcut(key("KeyA", "ф"), "explorerSelectAll")).toBe(true);
    expect(comboFromEvent(key("KeyN", "т"))).toBe("Ctrl+N");
    expect(comboFromEvent(key("KeyQ", "a"))).toBe("Ctrl+Q");
    expect(comboFromEvent(key("NumpadDecimal", ","))).toBe("Ctrl+NumpadDecimal");
    expect(actionFor(key("F5", "F5", { ctrlKey: false }))).toBe("refresh");
  });

  it("leaves IME composition and AltGr text input alone", () => {
    expect(actionFor(key("KeyN", "т", { isComposing: true }))).toBeNull();
    expect(comboFromEvent(key("KeyN", "т", { altKey: true, getModifierState: state => state === "AltGraph" }))).toBeNull();
  });
});

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
