/** The surface that owns the keyboard in a window, topmost first. */
export type KeyboardOwner = "dialog" | "palette" | "menu" | "tool" | null;

const OWNERS: [Exclude<KeyboardOwner, null>, string][] = [
  ["dialog", ".modal"],
  ["palette", ".palette"],
  ["menu", ".ctx-menu"],
  // Blame, Compare, the merge editor and the other tool windows drawn over the workspace.
  ["tool", ".conflict-overlay"],
];

export function keyboardOwner(doc: { querySelector(selector: string): unknown }): KeyboardOwner {
  for (const [owner, selector] of OWNERS) if (doc.querySelector(selector)) return owner;
  return null;
}

/** Commands that act on the History or Changes selection, which a tool window covers. */
const COVERED_BY_TOOL = new Set(["stage-file", "unstage-file", "stage-all", "unstage-all", "close-preview", "historyFind"]);

/** A dialog, the palette or an open menu takes every shortcut. A tool window keeps the
 *  application shortcuts and blocks only those aimed at the workspace hidden behind it. */
export function shortcutBlocked(id: string, owner: KeyboardOwner): boolean {
  if (!owner) return false;
  return owner !== "tool" || COVERED_BY_TOOL.has(id);
}

/** Unbound keys (arrows moving the hovered commit) never reach a list behind any surface. */
export const listKeysBlocked = (owner: KeyboardOwner) => owner !== null;

/** Commands that change which workspace view is shown. */
export const VIEW_SWITCHES = new Set(["history", "changes", "pulls", "reviewMode", "overview"]);

/** Tool windows that only show something: closing them loses nothing, unless they mark an
 *  unsaved edit (`data-unsaved`, e.g. Branch Manager's protection rules). A rebase plan, a
 *  workflow being edited, an agent request and the merge editor hold work, so they are never
 *  closed for the user. */
const VIEWERS = new Set(["blame", "compare", "stash", "tree", "branches", "worktrees", "stacks", "historyExplorer"]);

/** What a view-switching shortcut does while a tool window covers the workspace, so the switch
 *  never happens unseen behind it: a viewer closes and the view changes; a tool holding work
 *  stays and the user is told why nothing changed. */
export function viewSwitchUnderTool(owner: KeyboardOwner, overlayKind: string | null, mergeEditorOpen: boolean, unsavedEdit = false): "switch" | "close-tool" | "keep-tool" {
  if (owner !== "tool") return "switch";
  return !mergeEditorOpen && !unsavedEdit && overlayKind !== null && VIEWERS.has(overlayKind) ? "close-tool" : "keep-tool";
}
