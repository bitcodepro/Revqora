import { Cloud, Flag, GitBranch, Star } from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import * as A from "../lib/actions";
import { relativeTime } from "../lib/format";
import { repositoryKey } from "../lib/repositoryLibrary";
import { useSettings } from "../lib/settings";
import { matchesShortcut } from "../lib/shortcuts";
import type { BranchInfo, RefsSnapshot } from "../lib/types";
import { contextMenu } from "../lib/ui";
import { branchKind, branchRowMenu, showBranch } from "./BranchNavigation";
import { runMenuShortcut } from "./menus";
import { renameRemoteBranch } from "./RemoteRename";
import { BranchAheadBehind } from "./bits";

interface Props {
  id: string;
  root: string;
  branch: BranchInfo;
  upstream?: BranchInfo;
  refs: RefsSnapshot;
  depth: number;
  primary: boolean;
  favorite: boolean;
  focused: boolean;
  selected: boolean;
  viewed: boolean;
  historyDetached: boolean;
  withRepository: (run: (root: string) => void) => void;
  onSelect: (event: MouseEvent, activate: () => void) => void;
}

export function ExplorerBranchRow({ id, root, branch, upstream, refs, depth, primary, favorite, focused, selected, viewed,
  historyDetached, withRepository, onSelect }: Props) {
  const { name, fullName, isHead } = branch;
  const kind = branchKind(branch);
  const menu = () => branchRowMenu(root, branch, upstream, historyDetached, refs, withRepository);
  const checkout = () => { if (!isHead) withRepository(repo => void A.checkout(repo, name, kind)); };
  const rename = () => withRepository(repo => void (kind === "local" ? A.renameBranch(repo, name) : renameRemoteBranch(repo, name)));
  const deleteItem = () => {
    const item = menu().find(item => item.shortcut === "branch-delete");
    if (!item?.disabled) item?.onClick?.();
  };
  const title = [name, branch.subject, branch.author && branch.author + " · " + relativeTime(branch.time),
    branch.creator ? "Created by " + branch.creator.name + " <" + branch.creator.email + ">" : "Branch creator unknown",
    branch.upstream && "Tracks " + branch.upstream].filter(Boolean).join("\n");
  return <div role="treeitem" aria-level={depth + 1} aria-label={name} aria-selected={selected}
    data-explorer-entry={id} data-explorer-branch={fullName} data-branch-ref={fullName}
    style={{ "--tree-depth": Math.min(depth, 12) } as CSSProperties}
    className={["repository-item", "explorer-branch", focused && "explorer-focused", selected && "batch-selected", viewed && "active"].filter(Boolean).join(" ")}
    onContextMenu={event => contextMenu(event, menu())}>
    <span className="library-tree-spacer" aria-hidden="true"/>
    <button type="button" className="repository-select" aria-current={viewed} title={title}
      onClick={event => onSelect(event, () => withRepository(repo => showBranch(repo, branch, false, historyDetached)))}
      onDoubleClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey) checkout(); }}
      onKeyDown={event => {
        if (matchesShortcut(event, "renameItem") || matchesShortcut(event, "deleteItem")) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) (matchesShortcut(event, "renameItem") ? rename : deleteItem)();
        } else runMenuShortcut(event, menu(), "branch-");
      }}>
      {kind === "local" ? <GitBranch size={14}/> : <Cloud size={14}/>}
      <span className="repository-label">{name}</span>
      {isHead && <span className="explorer-branch-current" aria-label="Checked out" title="Checked out"/>}
      {primary && <Flag size={12} className="branch-primary-mark" role="img" aria-label="Primary branch"/>}
      <BranchAheadBehind branch={branch}/>
    </button>
    <button type="button" className={"icon-btn sm repository-star" + (favorite ? " active" : "")}
      aria-label={(favorite ? "Unfavorite branch " : "Favorite branch ") + name} aria-pressed={favorite}
      data-shortcut="branch-favorite"
      onClick={() => useSettings.getState().toggleBranchFavorite(repositoryKey(root), fullName)}>
      <Star size={12} fill={favorite ? "currentColor" : "none"}/>
    </button>
  </div>;
}
