import { ArrowDownToLine, ArrowUpFromLine, RefreshCw } from "lucide-react";
import { syncRepositories, type SyncKind, type SyncTarget } from "../lib/remoteSync";
import type { MenuItem } from "../lib/ui";

const ICONS: Record<SyncKind, React.ReactNode> = {
  fetch: <RefreshCw size={14}/>, pull: <ArrowDownToLine size={14}/>, push: <ArrowUpFromLine size={14}/>,
};
const VERBS: Record<SyncKind, string> = { fetch: "Fetch", pull: "Pull", push: "Push" };

/** Pull and Push need a local branch: remote-tracking branches of a selection are left out. */
export function localTargets(targets: SyncTarget[]): SyncTarget[] {
  return targets.flatMap(target => {
    if (!target.branches) return [target];
    const branches = target.branches.filter(branch => !branch.startsWith("refs/remotes/"));
    return branches.length ? [{ ...target, branches }] : [];
  });
}

/** Fetch, Pull and Push items for `targets`, labelled "<Verb> <what>". Pull and Push act on the
 *  local branches only; with remote branches alone they are disabled. */
function syncMenu(targets: SyncTarget[], what: string): MenuItem[] {
  const local = localTargets(targets);
  return (["fetch", "pull", "push"] as const).map((kind): MenuItem => {
    const chosen = kind === "fetch" ? targets : local;
    const hint = !targets.length ? "Nothing to sync" : !chosen.length ? "Remote branches can only be fetched" : undefined;
    return { label: `${VERBS[kind]} ${what}`, icon: ICONS[kind], disabled: !chosen.length, hint, onClick: () => void syncRepositories(kind, chosen) };
  });
}

/** What a right-click acts on: folders and repositories with every branch, branches on their own. */
export interface SyncSelection {
  /** The repositories of each folder, nested folders included. */
  folders: string[][];
  repositories: string[];
  branches: SyncTarget[];
}

/** Fetch, Pull and Push for a selection, labelled by what it holds. */
export function selectionSyncMenu({ folders, repositories, branches }: SyncSelection): MenuItem[] {
  const targets: SyncTarget[] = [...folders.flat().map(root => ({ root })), ...repositories.map(root => ({ root })), ...branches];
  const kinds = [folders, repositories, branches].filter(list => list.length).length;
  const what = kinds > 1 ? "all selected items"
    : folders.length ? folders.length > 1 ? "all branches in selected folders" : "all branches in folder"
      : repositories.length ? repositories.length > 1 ? "all branches in selected repositories" : "all branches"
        : branches.length > 1 ? "all selected branches" : "branch";
  return syncMenu(targets, what);
}

/** Every branch of the chosen repositories. */
export const repositorySyncMenu = (roots: string[]) => selectionSyncMenu({ folders: [], repositories: roots, branches: [] });

/** The branches of one branch folder (such as feature/) in one repository. Remote-only branches
 *  can only be fetched: there is no local branch to pull into or push from. */
export function branchFolderSyncMenu(root: string, branches: string[], remoteOnly = false): MenuItem[] {
  const items = syncMenu(branches.length ? [{ root, branches }] : [], "all branches in folder");
  return remoteOnly ? items.slice(0, 1) : items;
}
