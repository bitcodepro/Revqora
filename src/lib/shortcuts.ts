// Keyboard shortcuts: defaults, user overrides (settings.shortcuts) and event matching.
import { useSettings } from "./settings";

export interface ShortcutDef {
  id: string;
  label: string;
  description: string;
  default: string;
  scope?: "commit" | "diff" | "history" | "files" | "conflicts" | "editor";
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", label: "Command palette", description: "Search actions, branches and repositories.", default: "Ctrl+K" },
  { id: "open", label: "Open repository", description: "Open a local Git repository.", default: "Ctrl+O" },
  { id: "refresh", label: "Refresh", description: "Reload the current repository or overview.", default: "F5" },
  { id: "history", label: "Show history", description: "Open the commit history for the current repository.", default: "Ctrl+1" },
  { id: "changes", label: "Show changes", description: "Show staged and unstaged changes.", default: "Ctrl+2" },
  { id: "pulls", label: "Show pull requests", description: "Open the repository’s pull or merge requests.", default: "Ctrl+3" },
  { id: "reviewMode", label: "Cycle history layouts: Graph, Review, Columns", description: "Cycle through Graph, Review and Columns.", default: "Ctrl+Shift+R" },
  { id: "overview", label: "All repositories", description: "Open the overview of repositories in the current session.", default: "Ctrl+Shift+O" },
  { id: "repositoriesPanel", label: "Toggle repositories panel", description: "Show or hide the repository sidebar.", default: "Ctrl+Alt+R" },
  { id: "branchesPanel", label: "Toggle branches panel", description: "Show or hide the branches sidebar.", default: "Ctrl+Alt+B" },
  { id: "focusMode", label: "Focus on code", description: "Toggle the layout that gives code more space.", default: "Ctrl+Shift+Enter" },
  { id: "fetch", label: "Fetch", description: "Download remote refs and objects without updating your branch.", default: "Ctrl+Shift+F" },
  { id: "pull", label: "Pull", description: "Bring changes from the upstream into your current branch.", default: "Ctrl+Shift+ArrowDown" },
  { id: "push", label: "Push", description: "Publish local changes to the remote.", default: "Ctrl+Shift+ArrowUp" },
  { id: "branch", label: "New branch", description: "Create a branch in the current repository.", default: "Ctrl+B" },
  { id: "stash", label: "Stash changes", description: "Save local changes for later.", default: "Ctrl+Shift+S" },
  { id: "compare", label: "Compare branches", description: "Open the branch comparison view.", default: "Ctrl+Shift+C" },
  { id: "browse", label: "Browse files", description: "Browse files in the selected commit or HEAD.", default: "Ctrl+Shift+E" },
  { id: "tools", label: "Repository tools", description: "Open repository utilities and maintenance actions.", default: "" },
  { id: "theme", label: "Toggle dark / light theme", description: "Switch the app between light and dark.", default: "Ctrl+Shift+T" },
  { id: "settings", label: "Settings", description: "Open application preferences.", default: "Ctrl+," },
  { id: "closeTab", label: "Close repository tab", description: "Close the current repository tab.", default: "Ctrl+W" },
  { id: "nextTab", label: "Next repository tab", description: "Select the next open repository.", default: "Ctrl+Tab" },
  { id: "prevTab", label: "Previous repository tab", description: "Select the previous open repository.", default: "Ctrl+Shift+Tab" },
  { id: "paletteAlternate", label: "Command palette (alternate)", description: "Open the command palette with a second binding.", default: "Ctrl+Shift+P" },
  { id: "commit", label: "Commit from the message fields", description: "Submit the current commit or continuation form.", default: "Ctrl+Enter", scope: "commit" },
  { id: "diffNext", label: "Next change", description: "Jump to the next changed block in the diff.", default: "F7", scope: "diff" },
  { id: "diffPrevious", label: "Previous change", description: "Jump to the previous changed block in the diff.", default: "Shift+F7", scope: "diff" },
  { id: "diffFind", label: "Find in diff", description: "Open text search for the focused diff.", default: "Ctrl+F", scope: "diff" },
  { id: "historyFind", label: "Find commits", description: "Focus the search field in History.", default: "Ctrl+F", scope: "history" },
  { id: "previewNextFile", label: "Next changed file", description: "Preview the next file from the diff or commit list.", default: "Alt+ArrowDown", scope: "files" },
  { id: "previewPreviousFile", label: "Previous changed file", description: "Preview the previous file from the diff or commit list.", default: "Alt+ArrowUp", scope: "files" },
  { id: "conflictNext", label: "Next conflict", description: "Jump to the next conflict in the merge editor.", default: "Alt+ArrowDown", scope: "conflicts" },
  { id: "conflictPrevious", label: "Previous conflict", description: "Jump to the previous conflict in the merge editor.", default: "Alt+ArrowUp", scope: "conflicts" },
  { id: "conflictNextFile", label: "Next conflicted file", description: "Open the next conflicted file in the merge editor.", default: "Alt+PageDown", scope: "conflicts" },
  { id: "conflictPreviousFile", label: "Previous conflicted file", description: "Open the previous conflicted file in the merge editor.", default: "Alt+PageUp", scope: "conflicts" },
  { id: "conflictSave", label: "Save merge result", description: "Save and stage the current merge result.", default: "Ctrl+S", scope: "conflicts" },
  { id: "workingFileSave", label: "Save working file", description: "Save the file in the working-file editor.", default: "Ctrl+S", scope: "editor" },
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
    if (s.scope) continue;
    const b = bindingFor(s.id, o);
    if (b && b.toLowerCase() === combo.toLowerCase()) return s.id;
  }
  return null;
}

export function matchesShortcut(event: KeyboardEvent | React.KeyboardEvent, id: string): boolean {
  if (event.defaultPrevented || ("nativeEvent" in event ? event.nativeEvent.isComposing : event.isComposing)) return false;
  const binding = bindingFor(id);
  return !!binding && comboFromEvent(event)?.toLowerCase() === binding.toLowerCase();
}

// History can show a file list and a focused diff at the same time.
const previewScopes = new Set(["history", "files", "diff"]);

export function shortcutConflict(id: string, combo: string, overrides: Record<string, string>) {
  const key = combo.toLowerCase();
  if (!key) return undefined;
  const scope = SHORTCUTS.find((shortcut) => shortcut.id === id)?.scope;
  return SHORTCUTS.find((shortcut) => {
    if (shortcut.id === id || bindingFor(shortcut.id, overrides).toLowerCase() !== key) return false;
    // Ctrl+F is shared by design: the focused diff handles it before History does.
    if (key === "ctrl+f" && ((id === "diffFind" && shortcut.id === "historyFind")
      || (id === "historyFind" && shortcut.id === "diffFind"))) return false;
    return !scope || !shortcut.scope || scope === shortcut.scope
      || (previewScopes.has(scope) && previewScopes.has(shortcut.scope));
  });
}

/** Display form, e.g. "Ctrl+Shift+↑". */
export function prettyCombo(c: string): string {
  return c.replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→");
}

export function shortcutTitle(label: string, id: string): string {
  const binding = bindingFor(id);
  return binding ? `${label} (${prettyCombo(binding)})` : label;
}
