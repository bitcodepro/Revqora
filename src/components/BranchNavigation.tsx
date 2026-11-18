import { Cloud, Eye, GitBranch } from "lucide-react";
import { CURRENT_HISTORY_BRANCH, loadGraph, useRepos } from "../lib/store";
import type { BranchInfo, RefsSnapshot } from "../lib/types";
import { useUi, type MenuItem } from "../lib/ui";
import { jumpToCommit } from "./GraphView";
import { branchMenu } from "./menus";

export function branchKind(branch: BranchInfo) {
  return branch.fullName.startsWith("refs/heads/") ? "local" : "remote";
}

/**
 * Shows `branch` in History. A click shows its history: Current branch for the checked-out branch
 * (with its incoming commits), otherwise that branch alone. Showing the tip keeps an All branches
 * view and highlights the branch there.
 */
export function showBranch(root: string, branch: BranchInfo, showTip: boolean, historyDetached: boolean) {
  const repos = useRepos.getState();
  const tab = repos.tabs[root];
  if (!tab) return;
  const revealHistory = useUi.getState().repositoryOverview && !historyDetached;
  const head = tab.info?.head.branch ? `refs/heads/${tab.info.head.branch}` : null;
  const shown = tab.branchFilter === CURRENT_HISTORY_BRANCH ? head : tab.branchFilter;
  const wanted = showTip && (!tab.branchFilter || shown === branch.fullName) ? tab.branchFilter : branch.fullName;
  const scope = wanted === head ? CURRENT_HISTORY_BRANCH : wanted;
  // A history of this branch alone needs no highlight: every row is the branch.
  const viewedBranch = scope ? null : branch.fullName;
  const scopeChanged = scope !== tab.branchFilter;
  if (showTip && tab.view === "history" && !revealHistory && !scopeChanged && tab.graph) {
    repos.patch(root, { viewedBranch });
    jumpToCommit(root, branch.oid);
    return;
  }
  repos.patch(root, { viewedBranch, view: "history", selected: showTip ? branch.oid : null, multi: [], branchFilter: scope, historyJump: branch.oid });
  if (revealHistory) {
    useUi.setState({ repositoryOverview: false });
    window.focus();
  }
  if (scopeChanged || !tab.graph) void loadGraph(root);
}

function filterGraph(root: string, reference: string, historyDetached: boolean) {
  useRepos.getState().patch(root, { view: "history", branchFilter: reference, viewedBranch: null, selected: null, multi: [], historyJump: null });
  if (!historyDetached && useUi.getState().repositoryOverview) useUi.setState({ repositoryOverview: false });
  void useRepos.getState().refresh(root, { graph: true });
}

export function branchRowMenu(root: string, branch: BranchInfo, upstream: BranchInfo | undefined, historyDetached: boolean,
  refs?: RefsSnapshot | null, open?: (run: (root: string) => void) => void): MenuItem[] {
  const run = (action: (repo: string) => void) => () => open ? open(action) : action(root);
  const onlyBranch = (ref: BranchInfo): MenuItem => ({
    label: "Show only this branch in graph", icon: <Eye size={14} />,
    onClick: run(repo => filterGraph(repo, ref.fullName, historyDetached)),
  });
  return [
    ...branchMenu(root, branch.name, branchKind(branch), refs, open),
    ...(upstream ? [{ label: "Upstream: " + upstream.name, icon: <Cloud size={14}/>, children: [
      { label: "Show tip in history", icon: <GitBranch size={14}/>, onClick: run(repo => showBranch(repo, upstream, true, historyDetached)) },
      onlyBranch(upstream), { separator: true },
      ...branchMenu(root, upstream.name, "remote", refs, open),
    ] }] : []),
    { separator: true }, onlyBranch(branch),
  ];
}
