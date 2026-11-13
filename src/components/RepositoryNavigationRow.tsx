import { ChevronDown, ChevronRight, CircleAlert, FolderGit2, FolderPlus, Pencil, X } from "lucide-react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { repositorySidebarStatus, useRepos, type RepoTab } from "../lib/store";
import { contextMenu } from "../lib/ui";
import { bindingFor, matchesShortcut, prettyCombo } from "../lib/shortcuts";
import { FavoriteButton, openLibraryRepository, renameRepositoryDialog } from "./RepositoryLibrary";
import { repositoryMembershipMenu } from "./LibraryMenus";
import { namePathMenu } from "./NamePathMenu";
import { runMenuShortcut } from "./menus";
import { AheadBehind } from "./bits";

export function activateRepository(root: string) {
  if (useRepos.getState().tabs[root]) useRepos.getState().activate(root);
  else void openLibraryRepository(root);
}

export const repositoryMenu = (root: string, name: string, roots: string[], groupId: string | undefined, createGroup: () => void) => [
  { label: "Create group", shortcut: "group-create", icon: <FolderPlus size={14}/>, onClick: createGroup },
  ...repositoryMembershipMenu(roots, groupId),
  { label: "Rename repository…", icon: <Pencil size={14}/>, hint: prettyCombo(bindingFor("renameItem")), onClick: () => void renameRepositoryDialog(root) },
  ...namePathMenu(name, root, null),
];

export function renameRepositoryOnKey(e: React.KeyboardEvent, root: string) {
  if (e.repeat || !matchesShortcut(e, "renameItem")) return;
  e.preventDefault();
  e.stopPropagation();
  void renameRepositoryDialog(root);
}

export const matchesGroupShortcut = (e: React.KeyboardEvent) => !e.repeat &&
  ["group-create", "repo-remove-group", "repo-remove-all-groups"].some(id => matchesShortcut(e, id));

export function RepositoryNavigationRow({ root, name, tab, current, selected, selection, groupId, createGroup, onClick, onPointerDown, onSelectionKeyDown, depth, explorer }:
  { root: string; name: string; tab?: RepoTab; current: boolean; selected: boolean; selection: string[]; groupId?: string;
    createGroup: () => void; onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void; onSelectionKeyDown?: (event: React.KeyboardEvent) => void; depth?: number;
    explorer?: { id: string; focused: boolean; expanded: boolean; toggle: () => void } }) {
  const status = repositorySidebarStatus(tab);
  const menu = () => repositoryMenu(root, name, selection, groupId, createGroup);
  return <div role={depth === undefined ? "listitem" : "treeitem"} aria-level={depth === undefined ? undefined : depth + 1}
    aria-label={depth === undefined ? undefined : name} aria-selected={depth === undefined ? undefined : selected}
    aria-expanded={explorer?.expanded} aria-busy={!!tab && (!!tab.opening || !tab.loaded)}
    data-explorer-entry={explorer?.id} data-explorer-repository={depth === undefined ? undefined : root} data-repository-parent={depth === undefined ? undefined : groupId ?? ""}
    data-repository-state={tab ? tab.info ? "open" : tab.error ? "unavailable" : "opening" : "closed"}
    className={`repository-item ${depth === undefined ? "" : "explorer-repository"} ${current ? "active" : ""} ${explorer?.focused ? "explorer-focused" : ""} ${selected ? "batch-selected" : ""}`}
    style={depth === undefined ? undefined : { "--tree-depth": Math.min(depth, 12) } as CSSProperties}
    onKeyDown={e => { renameRepositoryOnKey(e, root); if (matchesGroupShortcut(e)) runMenuShortcut(e, menu()); }}
    onContextMenu={e => contextMenu(e, menu())}>
    {explorer ? <button type="button" className="icon-btn sm library-tree-toggle"
      aria-label={(explorer.expanded ? "Collapse" : "Expand") + " branches in " + name}
      aria-expanded={explorer.expanded} onClick={explorer.toggle}>
      {explorer.expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
    </button> : depth !== undefined && <span className="library-tree-spacer" aria-hidden="true"/>}
    <button type="button" className="repository-select" aria-current={current} onPointerDown={onPointerDown} onClick={onClick} onKeyDown={onSelectionKeyDown}
      data-shortcut="renameItem" data-tooltip="Rename repository · Drag to move · Shift+click selects a range"
      title={`${root}\n${tab?.info ? tab.info.head.branch ?? "Detached HEAD" : tab ? tab.error ?? "Opening repository…" : "Closed · click to open"}${tab?.fetchError ? "\n" + tab.fetchError : ""}`}>
      <FolderGit2 size={14}/><span className="repository-label">{name}</span>
      {!tab && <span className="faint">Closed</span>}
      {tab && !tab.info && (tab.error ? <CircleAlert size={12} className="amber" aria-label="Repository unavailable"/> : <span className="faint" title="Opening repository…" aria-label="Opening repository">…</span>)}
      <AheadBehind ahead={status?.ahead ?? 0} behind={status?.behind ?? 0}/>
      {!!status?.files.length && <span className="repository-dirty" aria-label="Local changes"/>}
      {!!tab?.fetchError && <CircleAlert size={12} className="amber"/>}
    </button>
    <FavoriteButton root={root} name={name}/>
    {tab && <button type="button" className="repository-close icon-btn sm" title={`Close ${name}`} aria-label={`Close ${name}`} onClick={() => useRepos.getState().close(root)}><X size={12}/></button>}
  </div>;
}
