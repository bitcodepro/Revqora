import { FolderMinus, FolderPlus, Unlink } from "lucide-react";
import { groupsInWorkspace, repositoryKey, useLibrary } from "../lib/repositoryLibrary";
import { visibleTree } from "../lib/libraryTree";
import type { MenuItem } from "../lib/ui";
import { matchesShortcut } from "../lib/shortcuts";

export function repositoryMembershipMenu(roots: string[], groupId?: string): MenuItem[] {
  const library = useLibrary.getState();
  const workspace = library.workspaces.find(w => w.id === library.activeWorkspaceId);
  const available = groupsInWorkspace(library.groups, workspace);
  const keys = roots.map(repositoryKey);
  const groupMembers = new Map(library.groups.map(group => [group.id, new Set(group.roots.map(repositoryKey))]));
  const hasMembers = (id: string) => keys.some(key => groupMembers.get(id)?.has(key));
  const add = visibleTree(available, () => true, () => false, false)
    .filter(({entry}) => keys.some(key => !groupMembers.get(entry.id)?.has(key)))
    .map(({entry, depth}) => ({
      label: "　".repeat(depth) + entry.name,
      onClick: () => useLibrary.getState().addToGroup(roots, entry.id),
    }));
  const memberships = visibleTree(library.groups, () => true, () => false, false).filter(({entry}) => hasMembers(entry.id));
  const group = memberships.find(({entry}) => entry.id === groupId)?.entry ?? (memberships.length === 1 ? memberships[0].entry : undefined);
  const remove = (id: string) => useLibrary.getState().removeFromGroups(roots, id);
  return [
    ...(add.length ? [{ label: "Add to group", icon: <FolderPlus size={14}/>, children: add }] : []),
    ...(group ? [{ label: `Remove from group · ${group.name}`, shortcut: "repo-remove-group", icon: <FolderMinus size={14}/>, onClick: () => remove(group.id) }] : []),
    ...(!group && memberships.length ? [{
      label: "Remove from group", icon: <FolderMinus size={14}/>,
      children: memberships.map(({entry, depth}) => ({ label: "　".repeat(depth) + entry.name, onClick: () => remove(entry.id) })),
    }] : []),
    ...(memberships.length ? [{ label: "Remove from all groups", shortcut: "repo-remove-all-groups", icon: <Unlink size={14}/>, onClick: () => useLibrary.getState().removeFromGroups(roots) }] : []),
  ];
}

export function isDeleteShortcut(event: React.KeyboardEvent) {
  return matchesShortcut(event, "deleteItem") && !event.repeat &&
    !(event.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
}
