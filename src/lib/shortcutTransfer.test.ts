import { expect, it } from "vitest";
import { exportShortcuts, normalizeShortcutKey, readShortcutFile, reviewShortcutAssignments } from "./shortcutTransfer";
import { SHORTCUTS } from "./shortcuts";

it("round-trips the shortcut catalog including intentional removals", () => {
  const imported = readShortcutFile(exportShortcuts({open:"Alt+O", renameItem:""}));
  expect(imported.rows.length).toBe(SHORTCUTS.length);
  expect(imported.skipped).toBe(0);
  expect(imported.rows.find(row => row.suggested === "open")?.key).toBe("Alt+O");
  expect(imported.rows.find(row => row.suggested === "renameItem")?.key).toBe("");
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
