// Keyboard shortcuts: defaults, user overrides (settings.shortcuts) and event matching.
import { useSettings } from "./settings";

export interface ShortcutDef {
  id: string;
  label: string;
  default: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", label: "Command palette", default: "Ctrl+K" },
  { id: "open", label: "Open repository", default: "Ctrl+O" },
  { id: "refresh", label: "Refresh", default: "F5" },
  { id: "history", label: "Show history", default: "Ctrl+1" },
  { id: "changes", label: "Show changes", default: "Ctrl+2" },
  { id: "pulls", label: "Show pull requests", default: "Ctrl+3" },
  { id: "reviewMode", label: "Switch history between Graph and Review", default: "Ctrl+Shift+R" },
  { id: "fetch", label: "Fetch", default: "Ctrl+Shift+F" },
  { id: "pull", label: "Pull", default: "Ctrl+Shift+ArrowDown" },
  { id: "push", label: "Push", default: "Ctrl+Shift+ArrowUp" },
  { id: "branch", label: "New branch", default: "Ctrl+B" },
  { id: "stash", label: "Stash changes", default: "Ctrl+Shift+S" },
  { id: "compare", label: "Compare branches", default: "Ctrl+Shift+C" },
  { id: "browse", label: "Browse files", default: "Ctrl+Shift+E" },
  { id: "tools", label: "Repository tools", default: "" },
  { id: "theme", label: "Toggle dark / light theme", default: "Ctrl+Shift+T" },
  { id: "settings", label: "Settings", default: "Ctrl+," },
  { id: "closeTab", label: "Close repository tab", default: "Ctrl+W" },
  { id: "nextTab", label: "Next repository tab", default: "Ctrl+Tab" },
  { id: "prevTab", label: "Previous repository tab", default: "Ctrl+Shift+Tab" },
];

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** "Ctrl+Shift+K" style description of a key event, or null for lone modifiers. */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let k = e.key;
  if (k === " ") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join("+");
}

export function bindingFor(id: string, overrides = useSettings.getState().shortcuts): string {
  return overrides[id] ?? SHORTCUTS.find((s) => s.id === id)?.default ?? "";
}

/** Action id bound to a key combination. */
export function actionFor(combo: string): string | null {
  const o = useSettings.getState().shortcuts;
  for (const s of SHORTCUTS) {
    const b = bindingFor(s.id, o);
    if (b && b.toLowerCase() === combo.toLowerCase()) return s.id;
  }
  return null;
}

/** Display form, e.g. "Ctrl+Shift+↑". */
export function prettyCombo(c: string): string {
  return c.replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→");
}
