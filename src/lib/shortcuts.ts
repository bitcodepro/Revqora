// Keyboard shortcuts: defaults, user overrides (settings.shortcuts) and event matching.
import { useSettings } from "./settings";

export interface ShortcutDef {
  id: string;
  label: string;
  description: string;
  default: string;
  scope?: "commit" | "diff" | "history" | "files" | "conflicts" | "editor" | "navigation";
}

export const PANEL_NAMES = {
  workspaces: "Workspaces", repositories: "Repositories", branches: "Branches",
  history: "Commit history", commit: "Commit preview", changes: "Changes",
  pulls: "Pull requests", worktrees: "Worktree manager",
};

const unassignedCommands: [id: string, label: string, description: string][] = [
  ["operation-log", "Operation log", "Inspect the repository or application-wide operation history."],
  ["repository-library", "Repository library and workspaces", "Manage saved repositories, groups and workspaces."],
  ["workspace-create", "Create workspace", "Create a workspace and choose its repositories."],
  ["all-workspaces", "All Workspaces", "Switch to the workspace containing all available repositories."],
  ["repository-actions", "Toggle repository actions", "Show or collapse the action block below the repository list."],
  ["import-folder", "Import repositories from a folder", "Scan a folder for Git repositories and workspaces."],
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
  { id: "renameItem", label: "Rename focused item", description: "Rename a workspace, branch or repository label from its navigation panel.", default: "F2", scope: "navigation" },
  { id: "history", label: "Show history", description: "Open the commit history for the current repository.", default: "Ctrl+1" },
  { id: "changes", label: "Show changes", description: "Show staged and unstaged changes.", default: "Ctrl+2" },
  { id: "pulls", label: "Show pull requests", description: "Open the repository’s pull or merge requests.", default: "Ctrl+3" },
  { id: "reviewMode", label: "Cycle history layouts: Graph, Review, Columns", description: "Cycle through Graph, Review and Columns.", default: "Ctrl+Shift+R" },
  { id: "overview", label: "All repositories", description: "Open the overview of repositories in the current session.", default: "Ctrl+Shift+O" },
  { id: "workspacesPanel", label: "Toggle Workspaces panel", description: "Show or hide the Workspaces sidebar.", default: "Ctrl+Alt+W" },
  { id: "groupsPanel", label: "Toggle Groups panel", description: "Show or hide the Groups sidebar.", default: "" },
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
  ...["Stage", "Unstage", "Stash", "Discard", "Apply"].flatMap(action => [
    { id: `diff-${action.toLowerCase()}-hunk`, label: `${action} hunk`, description: `${action} the focused block of changes in the diff.`, default: "", scope: "diff" as const },
    { id: `diff-${action.toLowerCase()}-lines`, label: `${action} selected lines`, description: `${action} only the selected lines in the diff.`, default: "", scope: "diff" as const },
  ]),
  { id: "historyFind", label: "Find commits", description: "Focus the search field in History.", default: "Ctrl+F", scope: "history" },
  { id: "previewNextFile", label: "Next changed file", description: "Preview the next file from the diff or commit list.", default: "Alt+ArrowDown", scope: "files" },
  { id: "previewPreviousFile", label: "Previous changed file", description: "Preview the previous file from the diff or commit list.", default: "Alt+ArrowUp", scope: "files" },
  { id: "conflictNext", label: "Next conflict", description: "Jump to the next conflict in the merge editor.", default: "Alt+ArrowDown", scope: "conflicts" },
  { id: "conflictPrevious", label: "Previous conflict", description: "Jump to the previous conflict in the merge editor.", default: "Alt+ArrowUp", scope: "conflicts" },
  { id: "conflictNextFile", label: "Next conflicted file", description: "Open the next conflicted file in the merge editor.", default: "Alt+PageDown", scope: "conflicts" },
  { id: "conflictPreviousFile", label: "Previous conflicted file", description: "Open the previous conflicted file in the merge editor.", default: "Alt+PageUp", scope: "conflicts" },
  { id: "conflictSave", label: "Save merge result", description: "Save and stage the current merge result.", default: "Ctrl+S", scope: "conflicts" },
  { id: "workingFileSave", label: "Save working file", description: "Save the file in the working-file editor.", default: "Ctrl+S", scope: "editor" },
  { id: "workspaceUndo", label: "Undo workspace move", description: "Return moved repositories to their previous workspaces.", default: "Ctrl+Z", scope: "navigation" },
  ...[
    ["checkout", "Check out focused branch"],
    ["details", "Show focused branch details"],
    ["compare", "Compare focused branch commits"],
    ["merge", "Merge focused branch into current"],
    ["rebase", "Rebase current branch onto focused branch"],
    ["upstream", "Set upstream for focused branch"],
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
