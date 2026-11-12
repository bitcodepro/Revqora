// Keyboard shortcuts: defaults, user overrides (settings.shortcuts) and event matching.
import { useSettings } from "./settings";

export interface ShortcutDef {
  id: string;
  label: string;
  description: string;
  default: string;
  scope?: "commit" | "diff" | "history" | "files" | "fileList" | "conflicts" | "editor" | "navigation";
}

export const PANEL_NAMES = {
  explorer: "Explorer", repositories: "Repositories", branches: "Branches",
  history: "Commit history", commit: "Commit preview", changes: "Changes",
  pulls: "Pull requests", worktrees: "Worktree manager",
};

const unassignedCommands: [id: string, label: string, description: string][] = [
  ["operation-log", "Operation log", "Inspect the repository or application-wide operation history."],
  ["repository-library", "Repository library", "Manage saved repositories and groups."],
  ["repository-actions", "Toggle repository actions", "Show or collapse the action block below the repository list."],
  ["import-folder", "Import repositories from a folder", "Scan a folder for Git repositories and recreate its structure as groups."],
  ["clone", "Clone repository", "Clone a repository into a local folder."],
  ["init", "New repository", "Initialize a Git repository in a folder."],
  ["forge-accounts", "Accounts and API connections", "Manage provider accounts, tokens and API access."],
  ["git-connections", "Git connection settings", "Choose how Git authenticates for this repository."],
  ["check-updates", "Check Updates", "Check for a new version of Revqora now."],
  ["about", "About Revqora", "Show the app version and project information."],
  ["sync", "Sync repository", "Review a safe sync of the current repository."],
  ["sync-all", "Sync all repositories", "Review sync for the open repositories."],
  ["fetch-all", "Fetch all repositories", "Fetch remote updates for the open repositories."],
  ["pull-all", "Pull all repositories", "Review fast-forward pulls for the open repositories."],
  ["worktree-manager", "Worktree manager", "Manage worktrees in the current repository."],
  ["worktree", "New worktree", "Open the worktree creation form."],
  ["branch-manager", "Branch manager", "Find, inspect and clean up branches."],
  ["branch-stacks", "Branch Stacks", "Manage stacks of dependent branches."],
  ["deleted", "Recently deleted branches", "Review deleted branches and recovery options."],
  ["reflog", "Undo history (reflog)", "Inspect the Git reflog and recovery points."],
  ["recovery-center", "Undo Center", "Review saved recovery checkpoints."],
  ["undo", "Undo last commit", "Review undoing the last commit while keeping its changes."],
  ["pop-stash", "Pop latest stash", "Apply and drop the most recent stash."],
  ["patch", "Apply patch file", "Choose a patch file to apply."],
  ["submodule", "Add submodule", "Register another repository as a submodule."],
  ["submodules", "Update submodules", "Update submodules to their recorded revisions."],
  ["lfs", "Track files with Git LFS", "Add a Git LFS tracking pattern."],
  ["history-explorer", "History Explorer", "Search changed code and symbols in history."],
  ["workspace-search", "Search all repositories", "Search commit history across open repositories in the workspace."],
  ["workflow-builder", "Workflow Builder", "Open the workflow editor and run history."],
  ["agent-workspace", "Agent Workspace", "Open agent tasks for the current repository."],
  ["terminal", "Open terminal here", "Open a terminal in the current repository."],
  ["show-folder", "Show in Explorer", "Reveal the current repository in the system file manager."],
  ["layout-graph", "Graph layout", "Show History in the Graph layout."],
  ["layout-review", "Review layout", "Show History in the Review layout."],
  ["layout-columns", "Columns layout", "Show History in the Columns layout."],
  ["stage-file", "Stage selected file", "Stage the whole file selected in Changes."],
  ["unstage-file", "Unstage selected file", "Unstage the file selected in Changes."],
  ["stage-all", "Stage all files", "Stage the unstaged files in Changes."],
  ["unstage-all", "Unstage all files", "Unstage the files in the open staging layer."],
  ["close-preview", "Close commit preview", "Close the selected commit and its file preview."],
  ...Object.entries(PANEL_NAMES).map(([id, name]): [string, string, string] => [`window-${id}`, `Toggle ${name} in a separate window`, `Detach or return the ${name} panel.`]),
];

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", label: "Command palette", description: "Search actions, branches and repositories.", default: "Ctrl+N" },
  { id: "open", label: "Open repository", description: "Open a local Git repository.", default: "Ctrl+O" },
  { id: "refresh", label: "Refresh", description: "Reload the current repository or overview.", default: "F5" },
  { id: "renameItem", label: "Rename focused item", description: "Rename a focused group, branch or repository label.", default: "F2", scope: "navigation" },
  { id: "deleteItem", label: "Delete focused item", description: "Review deletion of the selected groups or branches.", default: "Delete", scope: "navigation" },
  ...[
    ["explorerNextRow", "Focus next Explorer row", "ArrowDown", "Move down through visible folders and repositories."],
    ["explorerPreviousRow", "Focus previous Explorer row", "ArrowUp", "Move up through visible folders and repositories."],
    ["explorerExtendNext", "Extend Explorer selection down", "Shift+ArrowDown", "Select the next sibling at the focused row's level."],
    ["explorerExtendPrevious", "Extend Explorer selection up", "Shift+ArrowUp", "Select the previous sibling at the focused row's level."],
    ["explorerSelectAll", "Select all at the current Explorer level", "Ctrl+A", "Select visible folders and repositories in the same parent. Press again to add the level above."],
  ].map(([id, label, key, description]) => ({ id, label, description, default: key, scope: "navigation" as const })),
  { id: "navigationClearSelection", label: "Clear group or repository selection", description: "Clear the current selection in Explorer or Repositories.", default: "Escape", scope: "navigation" },
  { id: "navigationToggleSelection", label: "Toggle focused group or repository selection", description: "Add or remove the focused row from the selection.", default: "Ctrl+Space", scope: "navigation" },
  { id: "navigationSelectRange", label: "Select a range of groups or repositories", description: "Select from the last focused row to this row.", default: "Shift+Space", scope: "navigation" },
  { id: "navigationAddSelectionRange", label: "Add a range of groups or repositories to the selection", description: "Keep the current selection and add the range to this row.", default: "Ctrl+Shift+Space", scope: "navigation" },
  ...[
    ["group-create", "Create group"],
    ["group-selected", "Group selected groups"],
    ["group-sub", "Create subgroup"],
    ["group-unlink", "Remove group from its parent"],
    ["repo-remove-group", "Remove repositories from the current group"],
    ["repo-remove-all-groups", "Remove repositories from all groups"],
  ].map(([id, label]) => ({ id, label, description: "Runs from the focused row in Workspaces, Groups or Repositories.", default: "", scope: "navigation" as const })),
  { id: "history", label: "Show history", description: "Open the commit history for the current repository.", default: "Ctrl+1" },
  { id: "changes", label: "Show changes", description: "Show staged and unstaged changes.", default: "Ctrl+2" },
  { id: "pulls", label: "Show pull requests", description: "Open the repository’s pull or merge requests.", default: "Ctrl+3" },
  { id: "reviewMode", label: "Cycle history layouts: Graph, Review, Columns", description: "Cycle through Graph, Review and Columns.", default: "Ctrl+Shift+R" },
  { id: "overview", label: "All repositories", description: "Open the overview of repositories in the current session.", default: "Ctrl+Shift+O" },
  { id: "workspacesPanel", label: "Toggle Explorer panel", description: "Show or hide groups and repositories in Explorer.", default: "Ctrl+Alt+W" },
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
  { id: "codeCopySelection", label: "Copy selected code", description: "Copy the selected text from a diff or the working-file editor.", default: "", scope: "diff" },
  { id: "diffCopyName", label: "Copy diff file name", description: "Copy the full name of the file displayed in the focused diff.", default: "", scope: "diff" },
  ...["Stage", "Unstage", "Stash", "Discard", "Apply"].flatMap(action => [
    { id: `diff-${action.toLowerCase()}-hunk`, label: `${action} hunk`, description: `${action} the focused block of changes in the diff.`, default: "", scope: "diff" as const },
    { id: `diff-${action.toLowerCase()}-lines`, label: `${action} selected lines`, description: `${action} only the selected lines in the diff.`, default: "", scope: "diff" as const },
  ]),
  { id: "historyFind", label: "Find commits", description: "Focus the search field in History.", default: "Ctrl+F", scope: "history" },
  ...[
    ["historyNextCommit", "Next commit", "ArrowDown"],
    ["historyPreviousCommit", "Previous commit", "ArrowUp"],
    ["historyOpenCommit", "Open highlighted commit", "Enter"],
    ["historyNextPage", "Next page of commits", "PageDown"],
    ["historyPreviousPage", "Previous page of commits", "PageUp"],
    ["historyFirstCommit", "First commit", "Home"],
    ["historyLastCommit", "Last commit", "End"],
    ["historyCopyHash", "Copy selected commit hash", "Ctrl+C"],
  ].map(([id, label, key]) => ({ id, label, description: "Runs from the commit list in History.", default: key, scope: "history" as const })),
  { id: "previewNextFile", label: "Next changed file", description: "Preview the next changed file.", default: "Ctrl+ArrowDown", scope: "files" },
  { id: "changesFindFile", label: "Find changed files", description: "Focus the file filter in Changes.", default: "", scope: "files" },
  { id: "previewPreviousFile", label: "Previous changed file", description: "Preview the previous changed file.", default: "Ctrl+ArrowUp", scope: "files" },
  { id: "previewNextFileAlternate", label: "Next changed file (alternate)", description: "Preview the next changed file with a second binding.", default: "Alt+ArrowDown", scope: "files" },
  { id: "previewPreviousFileAlternate", label: "Previous changed file (alternate)", description: "Preview the previous changed file with a second binding.", default: "Alt+ArrowUp", scope: "files" },
  ...[
    ["fileListNext", "Next file in the file list", "ArrowDown"],
    ["fileListPrevious", "Previous file in the file list", "ArrowUp"],
    ["fileListFirst", "First file in the file list", "Home"],
    ["fileListLast", "Last file in the file list", "End"],
  ].map(([id, label, key]) => ({ id, label, description: "Runs from Changes or a focused file list.", default: key, scope: "fileList" as const })),
  { id: "conflictNext", label: "Next conflict", description: "Jump to the next conflict in the merge editor.", default: "Alt+ArrowDown", scope: "conflicts" },
  { id: "conflictPrevious", label: "Previous conflict", description: "Jump to the previous conflict in the merge editor.", default: "Alt+ArrowUp", scope: "conflicts" },
  { id: "conflictNextFile", label: "Next conflicted file", description: "Open the next conflicted file in the merge editor.", default: "Alt+PageDown", scope: "conflicts" },
  { id: "conflictPreviousFile", label: "Previous conflicted file", description: "Open the previous conflicted file in the merge editor.", default: "Alt+PageUp", scope: "conflicts" },
  { id: "conflictSave", label: "Save merge result", description: "Save and stage the current merge result.", default: "Ctrl+S", scope: "conflicts" },
  { id: "workingFileSave", label: "Save working file", description: "Save the file in the working-file editor.", default: "Ctrl+S", scope: "editor" },
  { id: "workingFileEdit", label: "Edit working file", description: "Edit the working copy of the selected file from Changes.", default: "", scope: "files" },
  { id: "workingFileClose", label: "Close working file editor", description: "Return to the diff for the selected file.", default: "Escape", scope: "editor" },
  { id: "workingFileReload", label: "Reload working file from disk", description: "Read the current file from disk in the working-file editor.", default: "", scope: "editor" },
  { id: "workspaceUndo", label: "Undo Explorer move", description: "Restore the previous group structure after a move.", default: "Ctrl+Z", scope: "navigation" },
  ...[
    ["checkout", "Check out focused branch"],
    ["details", "Show focused branch details"],
    ["compare", "Compare focused branch commits"],
    ["primary", "Set or clear primary branch"],
    ["merge", "Merge focused branch into current"],
    ["rebase", "Rebase current branch onto focused branch"],
    ["upstream", "Set upstream for focused branch"],
    ["fetch", "Fetch remote for focused branch"],
    ["pull", "Pull focused branch"],
    ["delete", "Review deletion of focused branch"],
  ].map(([id, label]) => ({ id: `branch-${id}`, label, description: "Runs from the focused row in Branches.", default: "", scope: "navigation" as const })),
  ...[
    ["checkout", "Check out selected commit"],
    ["branch", "Create branch at selected commit"],
    ["tag", "Create tag at selected commit"],
    ["pick", "Cherry-pick selected commits"],
    ["compare", "Compare selected commit with working tree"],
    ["browse", "Browse files at selected commit"],
    ["patch", "Save selected commits as a patch"],
    ["revert", "Revert selected commit"],
    ["reset", "Review reset to selected commit"],
    ["rebase", "Interactive rebase from selected commit"],
    ["reword", "Edit selected commit message"],
    ["drop", "Review dropping selected commits"],
  ].map(([id, label]) => ({ id: `commit-${id}`, label, description: "Runs from the focused commit list in History.", default: "", scope: "history" as const })),
  ...unassignedCommands.map(([id, label, description]) => ({ id, label, description, default: "" })),
];

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);
type ShortcutEvent = KeyboardEvent | React.KeyboardEvent;

// Key positions used by IDE bindings that spell out the unshifted key.
const SHIFTED_POSITIONS = new Map<string, [base: string, shifted: string]>([
  ["Digit0", ["0", ")"]], ["Digit1", ["1", "!"]], ["Digit2", ["2", "@"]],
  ["Digit3", ["3", "#"]], ["Digit4", ["4", "$"]], ["Digit5", ["5", "%"]],
  ["Digit6", ["6", "^"]], ["Digit7", ["7", "&"]], ["Digit8", ["8", "*"]], ["Digit9", ["9", "("]],
  ["Backquote", ["`", "~"]], ["Minus", ["-", "_"]], ["Equal", ["=", "+"]],
  ["BracketLeft", ["[", "{"]], ["BracketRight", ["]", "}"]], ["Backslash", ["\\", "|"]],
  ["Semicolon", [";", ":"]], ["Quote", ["'", "\""]], ["Comma", [",", "<"]],
  ["Period", [".", ">"]], ["Slash", ["/", "?"]],
]);
const US_SHIFT_ALIASES = new Map([...SHIFTED_POSITIONS.values()].map(([base, shifted]) => [shifted, base]));

function eventModifiers(e: ShortcutEvent): string[] {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  return parts;
}

/** "Ctrl+Shift+K" style description of a key event, or null for lone modifiers. */
export function comboFromEvent(e: ShortcutEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let k = e.key;
  if (k === " ") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  return [...eventModifiers(e), k].join("+");
}

function eventBindings(event: ShortcutEvent): string[] {
  if (event.defaultPrevented || ("nativeEvent" in event ? event.nativeEvent.isComposing : event.isComposing)) return [];
  const captured = comboFromEvent(event);
  if (!captured) return [];
  const exact = captured.toLowerCase();
  const positional = shiftedPositionBinding(event);
  // A shortcut captured in the user's layout takes precedence over a positional match.
  return positional && positional !== exact ? [exact, positional] : [exact];
}

function shiftedPositionBinding(event: ShortcutEvent): string | undefined {
  const position = event.shiftKey ? SHIFTED_POSITIONS.get(event.code) : undefined;
  return position && [...eventModifiers(event), position[0]].join("+").toLowerCase();
}

function conflictKey(combo: string): string {
  return combo.toLowerCase().replace(/^((?:(?:ctrl|alt)\+)*shift\+)(.+)$/, (_, modifiers, key) =>
    modifiers + (US_SHIFT_ALIASES.get(key) ?? key));
}

export function bindingFor(id: string, overrides = useSettings.getState().shortcuts): string {
  return overrides[id] ?? SHORTCUTS.find((s) => s.id === id)?.default ?? "";
}

export function acceptsPlainShortcut(id: string, key: string) {
  const action = SHORTCUTS.find(item => item.id === id);
  if (!action?.scope) return false;
  if (action.default === key) return true;
  return (action.scope === "history" || action.scope === "fileList") &&
    /^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End|Enter)$/.test(key);
}

/** Resolve a global action, trying the produced key before its unshifted position. */
export function actionFor(event: ShortcutEvent): string | null {
  const o = useSettings.getState().shortcuts;
  for (const combo of eventBindings(event)) {
    const action = SHORTCUTS.find(s => !s.scope && bindingFor(s.id, o).toLowerCase() === combo);
    if (action) return action.id;
  }
  return null;
}

export function matchesShortcut(event: ShortcutEvent, id: string): boolean {
  const [exact, positional] = eventBindings(event);
  const overrides = useSettings.getState().shortcuts;
  const binding = bindingFor(id, overrides).toLowerCase();
  if (!binding || !exact) return false;
  if (binding === exact) return true;
  if (binding !== positional) return false;
  const scope = SHORTCUTS.find(shortcut => shortcut.id === id)?.scope;
  return !SHORTCUTS.some(shortcut => shortcut.id !== id && (!shortcut.scope || shortcut.scope === scope)
    && bindingFor(shortcut.id, overrides).toLowerCase() === exact);
}

// History can show a file list and a focused diff at the same time.
const previewScopes = new Set(["history", "files", "diff"]);

export function shortcutConflict(id: string, combo: string, overrides: Record<string, string>, capturedEvent?: ShortcutEvent) {
  const key = conflictKey(combo);
  if (!key) return undefined;
  const positional = capturedEvent && shiftedPositionBinding(capturedEvent);
  const scope = SHORTCUTS.find((shortcut) => shortcut.id === id)?.scope;
  return SHORTCUTS.find((shortcut) => {
    const assigned = conflictKey(bindingFor(shortcut.id, overrides));
    if (shortcut.id === id || (assigned !== key && assigned !== positional)) return false;
    // Ctrl+F is shared by design: the focused diff handles it before History does.
    if (key === "ctrl+f" && ((id === "diffFind" && shortcut.id === "historyFind")
      || (id === "historyFind" && shortcut.id === "diffFind"))) return false;
    return !scope || !shortcut.scope || scope === shortcut.scope
      || (scope === "fileList" && shortcut.scope === "files") || (scope === "files" && shortcut.scope === "fileList")
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
