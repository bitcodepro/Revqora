import { expect, it } from "vitest";
import { exportShortcuts, normalizeShortcutKey, readShortcutFile, reviewShortcutAssignments } from "./shortcutTransfer";
import { actionFor, comboFromEvent, matchesShortcut, shortcutConflict, SHORTCUTS } from "./shortcuts";
import { useSettings } from "./settings";

function shiftedKey(code: string, key: string) {
  return { code, key, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false } as KeyboardEvent;
}

it("round-trips the shortcut catalog including intentional removals", () => {
  const imported = readShortcutFile(exportShortcuts({open:"Alt+O", renameItem:""}));
  expect(imported.rows.length).toBe(SHORTCUTS.length);
  expect(imported.skipped).toBe(0);
  expect(imported.rows.find(row => row.suggested === "open")?.key).toBe("Alt+O");
  expect(imported.rows.find(row => row.suggested === "renameItem")?.key).toBe("");
  for (const [id, key] of [
    ["explorerExtendNext", "Shift+ArrowDown"],
    ["explorerExtendPrevious", "Shift+ArrowUp"],
    ["navigationSelectRange", "Shift+Space"],
  ]) expect(imported.rows.find(row => row.suggested === id)?.key).toBe(key);
  expect(reviewShortcutAssignments({}, imported.rows.map(row => ({id:row.suggested, key:row.key}))).errors.size).toBe(0);
});

it("matches VS Code command IDs in JSONC and reports chords as unsupported", () => {
  const result = readShortcutFile(`[
    // keybindings.json
    {"command":"git.fetch","key":"ctrl+alt+f","when":"active && resource == 'https://test'"},
    {"command":"workbench.action.showCommands","key":"ctrl+k ctrl+p"},
    {"command":"extension.special","key":"alt+j"},
  ]`);
  expect(result).toMatchObject({source:"VS Code", skipped:1, rows:[
    {command:"git.fetch", key:"Ctrl+Alt+F", suggested:"fetch", context:"active && resource == 'https://test'"},
    {command:"extension.special", key:"Alt+J", suggested:""},
  ]});
  expect(normalizeShortcutKey("shift ctrl pressed PAGE_UP", true)).toBe("Ctrl+Shift+PageUp");
  expect(normalizeShortcutKey("Ctrl+Shift++")).toBe("Ctrl+Shift++");
});

it("checks conflicts against the entire selection and allows an atomic swap", () => {
  expect(reviewShortcutAssignments({}, [{id:"open",key:"Ctrl+N"}]).errors.get(0)).toMatch(/Command palette/);
  expect(reviewShortcutAssignments({}, [{id:"open",key:"Ctrl+N"},{id:"palette",key:"Ctrl+O"}]).errors.size).toBe(0);
  expect(reviewShortcutAssignments({}, [{id:"open",key:"Alt+O"},{id:"open",key:"Alt+P"}]).errors.size).toBe(1);
});

it("resolves imported Shift combinations when the event reports a different character", () => {
  const imported = readShortcutFile(JSON.stringify([
    { command: "git.fetch", key: "ctrl+shift+[" },
    { command: "git.push", key: "ctrl+shift+1" },
    { command: "renameFile", key: "ctrl+shift+=" },
  ]));
  const before = useSettings.getState().shortcuts;
  try {
    useSettings.getState().set({ shortcuts: reviewShortcutAssignments({}, imported.rows.map(row => ({ id: row.suggested, key: row.key }))).next });
    expect(actionFor(shiftedKey("BracketLeft", "{"))).toBe("fetch");
    expect(actionFor(shiftedKey("Digit1", "!"))).toBe("push");
    expect(actionFor(shiftedKey("BracketLeft", "Х"))).toBe("fetch");
    expect(matchesShortcut(shiftedKey("Equal", "+"), "renameItem")).toBe(true);
    expect(actionFor(shiftedKey("Numpad1", "!"))).toBeNull();
    useSettings.getState().set({ shortcuts: { ...useSettings.getState().shortcuts, open: "Ctrl+Shift+Х" } });
    expect(actionFor(shiftedKey("BracketLeft", "Х"))).toBe("fetch");
    useSettings.getState().set({ shortcuts: { open: "Ctrl+Shift+Х" } });
    expect(actionFor(shiftedKey("BracketLeft", "Х"))).toBe("open");
  } finally { useSettings.getState().set({ shortcuts: before }); }
});

it("detects conflicts between imported base keys and captured shifted symbols", () => {
  const capture = comboFromEvent(shiftedKey("Digit1", "!"))!;
  expect(reviewShortcutAssignments({ push: capture }, [{ id: "fetch", key: "Ctrl+Shift+1" }]).errors.get(0)).toMatch(/Push/);
  expect(reviewShortcutAssignments({ push: "Ctrl+Shift+[" }, [{ id: "fetch", key: "Ctrl+Shift+{" }]).errors.get(0)).toMatch(/Push/);
  const cyrillic = shiftedKey("BracketLeft", "Х");
  expect(shortcutConflict("fetch", comboFromEvent(cyrillic)!, { push: "Ctrl+Shift+[" })?.id).toBe("push");
});

it("preserves non-ASCII and browser key names in native backups", () => {
  const shortcuts = { fetch: "Ctrl+Ф", push: "Ctrl+Shift+É", pull: "Alt+𐐀", sync: "Ctrl+CapsLock", settings: "Ctrl+Shift++" };
  const imported = readShortcutFile(exportShortcuts(shortcuts));
  expect(imported.skipped).toBe(0);
  const restored = reviewShortcutAssignments({}, imported.rows.map(row => ({ id: row.suggested, key: row.key })));
  expect(restored.errors.size).toBe(0);
  expect(restored.next).toMatchObject(shortcuts);
});
