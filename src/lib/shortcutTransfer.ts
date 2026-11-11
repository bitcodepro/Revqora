import { acceptsPlainShortcut, SHORTCUTS, shortcutConflict } from "./shortcuts";

export const SHORTCUT_FILE_LIMIT = 2 * 1024 * 1024;
const format = "revqora.shortcuts";
const definitions = new Map(SHORTCUTS.map(item => [item.id, item]));
const byLabel = new Map(SHORTCUTS.map(item => [normalizeName(item.label), item.id]));
const knownCommands: Record<string, string> = {
  "workbench.action.showCommands": "palette", "workbench.action.files.openFolder": "open",
  "workbench.action.openSettings": "settings", "workbench.view.scm": "changes",
  "workbench.action.terminal.toggleTerminal": "terminal", "renameFile": "renameItem",
  "git.fetch": "fetch", "git.pull": "pull", "git.push": "push", "git.sync": "sync",
  "git.branch": "branch", "git.stage": "stage-file", "git.stageAll": "stage-all",
  "git.unstage": "unstage-file", "git.unstageAll": "unstage-all", "git.stash": "stash",
  "Git.Fetch": "fetch", "Git.Pull": "pull", "Vcs.Push": "push", "GotoAction": "palette",
  "ShowSettings": "settings", "ActivateVersionControlToolWindow": "changes",
  "RenameElement": "renameItem", "ActivateTerminalToolWindow": "terminal", "Git.Stash": "stash",
};

function normalizeName(name: string) { return name.toLowerCase().replace(/[^a-z0-9]/g, ""); }
const aliases: Record<string, string> = {
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  page_up: "PageUp", page_down: "PageDown", pageup: "PageUp", pagedown: "PageDown",
  esc: "Escape", escape: "Escape", del: "Delete", delete: "Delete", insert: "Insert",
  enter: "Enter", tab: "Tab", space: "Space", back_space: "Backspace", backspace: "Backspace",
  home: "Home", end: "End", comma: ",", period: ".", minus: "-", equals: "=", slash: "/",
  back_slash: "\\", open_bracket: "[", close_bracket: "]", semicolon: ";", quote: "'",
};

export function normalizeShortcutKey(input: string, rider = false): string | null {
  const value = input.trim();
  if (!value) return "";
  const plus = !rider && value.endsWith("++");
  const parts = rider ? value.toLowerCase().split(/\s+/).filter(part => part !== "pressed")
    : (plus ? value.slice(0, -2) : value).toLowerCase().split("+");
  const key = plus ? "+" : parts.pop()!;
  const mods = new Set<string>();
  for (const mod of parts) {
    if (["ctrl", "control", "cmd", "command", "meta", "win"].includes(mod)) mods.add("Ctrl");
    else if (mod === "alt" || mod === "option") mods.add("Alt");
    else if (mod === "shift") mods.add("Shift");
    else return null;
  }
  const functionKey = /^f(?:[1-9]|1\d|2[0-4])$/.test(key);
  const main = aliases[key] ?? (functionKey || /^[a-z0-9`~!@#$%^&*()+_={}\[\]|\\:;'",.<>/?-]$/.test(key) ? key.toUpperCase() : null);
  if (!main || (!functionKey && !mods.has("Ctrl") && !mods.has("Alt"))) return null;
  return [...["Ctrl", "Alt", "Shift"].filter(mod => mods.has(mod)), main].join("+");
}

function nativeShortcutKey(id: string, input: string): string | null {
  if (!input) return "";
  // Revqora exports the original KeyboardEvent key, which can be Unicode or a
  // browser key name. Only validate the native structure and preserve the key.
  const modifiers = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?/.exec(input)![0];
  const key = input.slice(modifiers.length);
  if (!key || /\p{Cc}/u.test(key) || (!/^(?:Ctrl|Alt)\+/.test(modifiers) && !/^F\d+$/.test(key) && (modifiers || !acceptsPlainShortcut(id, key)))) return null;
  return input;
}

type SourceBinding = { command: string; label?: string; key: string; context?: string };
export interface ImportedShortcut { command: string; key: string; suggested: string; context?: string }
export interface ShortcutImport { source: string; rows: ImportedShortcut[]; skipped: number }

function jsonWithComments(text: string) {
  // JSON strings must remain opaque to comment and trailing comma removal.
  const clean = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token[0] === '"' ? token : " ");
  return JSON.parse(clean.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token === "," ? "" : token));
}

function bindingObject(item: unknown): Record<string, unknown> {
  return item && typeof item === "object" ? item as Record<string, unknown> : {};
}

export function readShortcutFile(text: string): ShortcutImport {
  if (text.length > SHORTCUT_FILE_LIMIT) throw Error("Choose a shortcut file smaller than 2 MB.");
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  let source: string, input: SourceBinding[];
  let skipped = 0;
  if (trimmed.startsWith("<")) {
    if (/<!DOCTYPE/i.test(trimmed)) throw Error("Choose a Rider keymap XML without a document type declaration.");
    const xml = new DOMParser().parseFromString(trimmed, "application/xml");
    const keymap = xml.querySelector("keymap");
    if (!keymap || xml.querySelector("parsererror")) throw Error("Choose a valid Rider keymap XML file.");
    source = "Rider";
    input = Array.from(keymap.querySelectorAll("action > keyboard-shortcut")).flatMap(node => {
      if (node.hasAttribute("second-keystroke")) { skipped++; return []; }
      return [{ command: node.parentElement?.getAttribute("id") ?? "", key: node.getAttribute("first-keystroke") ?? "" }];
    });
  } else {
    const parsed: unknown = jsonWithComments(trimmed);
    const backup = bindingObject(parsed);
    const own = backup.format === format;
    if (own && backup.version !== 1) throw Error("This Revqora shortcut file uses an unsupported version.");
    const raw = own ? backup.shortcuts : parsed;
    if (!Array.isArray(raw)) throw Error("Choose a Revqora shortcut export or a VS Code keybindings.json file.");
    source = own ? "Revqora" : "VS Code";
    input = raw.flatMap(value => {
      const row = bindingObject(value);
      const command = own ? row.id : row.command;
      if (typeof command !== "string" || typeof row.key !== "string" || command.startsWith("-")) { skipped++; return []; }
      return [{ command, key: row.key, label: own && typeof row.label === "string" ? row.label : undefined, context: !own && typeof row.when === "string" ? row.when : undefined }];
    });
  }
  const seen = new Set<string>();
  const rows = input.flatMap(({command, label, key, context}) => {
    const normalized = source === "Revqora" ? nativeShortcutKey(command, key) : normalizeShortcutKey(key, source === "Rider");
    if (!command || normalized === null || (!normalized && source !== "Revqora")) { skipped++; return []; }
    const id = JSON.stringify([command, normalized]);
    if (seen.has(id)) return [];
    seen.add(id);
    const shortName = command.split(/[.:/]/).at(-1) ?? command;
    const suggestion = definitions.has(command) ? command : knownCommands[command] ?? byLabel.get(normalizeName(label ?? shortName)) ?? "";
    return [{ command: label ? `${label} · ${command}` : command, key: normalized, suggested: definitions.has(suggestion) ? suggestion : "", context }];
  });
  return { source, rows, skipped };
}

export function exportShortcuts(overrides: Record<string, string>): string {
  return JSON.stringify({ format, version: 1, shortcuts: SHORTCUTS.map(({ id, label, default: fallback }) => ({ id, label, key: overrides[id] ?? fallback })) }, null, 2) + "\n";
}

export function reviewShortcutAssignments(overrides: Record<string, string>, rows: { id: string; key: string }[]) {
  const next = { ...overrides };
  const errors = new Map<number, string>();
  const seen = new Set<string>();
  rows.forEach(({ id, key }, index) => {
    if (!definitions.has(id) || seen.has(id)) { errors.set(index, "Choose a different Revqora action."); return; }
    seen.add(id);
    next[id] = key;
  });
  rows.forEach(({id, key}, index) => {
    if (errors.has(index) || !key) return;
    const conflict = shortcutConflict(id, key, next);
    if (conflict) errors.set(index, `Already assigned to ${conflict.label}.`);
  });
  return { next, errors };
}
