import { ArrowDownToLine, ArrowUpFromLine, RefreshCw } from "lucide-react";
import { syncRepositories, type SyncKind, type SyncTarget } from "../lib/remoteSync";
import type { MenuItem } from "../lib/ui";

const ICONS: Record<SyncKind, React.ReactNode> = {
  fetch: <RefreshCw size={14}/>, pull: <ArrowDownToLine size={14}/>, push: <ArrowUpFromLine size={14}/>,
};
const VERBS: Record<SyncKind, string> = { fetch: "Fetch", pull: "Pull", push: "Push" };

/** Fetch, Pull and Push items for `targets`, labelled "<Verb> <what>". */
function syncMenu(targets: SyncTarget[], what: string): MenuItem[] {
  const empty = !targets.length;
  return (["fetch", "pull", "push"] as const).map((kind): MenuItem => ({
    label: `${VERBS[kind]} ${what}`, icon: ICONS[kind], disabled: empty, hint: empty ? "No repositories" : undefined,
    onClick: () => void syncRepositories(kind, targets),
  }));
}

/** Every branch of the folders' repositories, nested folders included. */
export const folderSyncMenu = (roots: string[], folders: number) =>
  syncMenu(roots.map(root => ({ root })), folders > 1 ? "all branches in selected folders" : "all branches in folder");

/** Every branch of the chosen repositories. */
export const repositorySyncMenu = (roots: string[]) =>
  syncMenu(roots.map(root => ({ root })), roots.length > 1 ? "all branches in selected repositories" : "all branches");

/** Only the selected branches, across repositories. */
export const branchSyncMenu = (targets: SyncTarget[]) => syncMenu(targets, "all selected branches");
