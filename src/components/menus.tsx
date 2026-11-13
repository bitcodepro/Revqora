import { renameRemoteBranch } from "./RemoteRename";
import { namePathMenu } from "./NamePathMenu";
import { branchCommitCompare } from "./BranchCommitCompare";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleDot,
  CloudUpload,
  Copy,
  Eraser,
  FileEdit,
  Flag,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  Link2,
  Pencil,
  RotateCcw,
  RefreshCw,
  Shuffle,
  Star,
  Info,
  Tag,
  Trash2,
  Undo2,
  Combine,
  GitCompareArrows,
  ListOrdered,
  Bug,
  FileDown,
  FolderTree,
  History,
} from "lucide-react";
import type { MenuItem } from "../lib/ui";
import { copyText, openOverlay } from "../lib/ui";
import * as A from "../lib/actions";
import * as X from "../lib/extraActions";
import { getTab, loadGraph } from "../lib/store";
import { repositoryKey } from "../lib/repositoryLibrary";
import { useSettings } from "../lib/settings";
import { api } from "../lib/api";
import { branchCard } from "./BranchCard";
import { branchReflogDialog, savePatch } from "./RepoTools";
import { WORKTREE } from "../lib/types";
import type { BranchInfo, GraphRow, RefsSnapshot } from "../lib/types";
import { shortOid } from "../lib/format";
import { matchesShortcut } from "../lib/shortcuts";

const I = 14;

export function runMenuShortcut(event: React.KeyboardEvent, items: MenuItem[], prefix = ""): boolean {
  if (event.repeat) return false;
  for (const item of items) {
    if (item.disabled) continue;
    if (item.shortcut?.startsWith(prefix) && item.onClick && matchesShortcut(event, item.shortcut)) {
      event.preventDefault();
      event.stopPropagation();
      item.onClick();
      return true;
    }
    if (item.children && runMenuShortcut(event, item.children, prefix)) return true;
  }
  return false;
}

export function primaryBranchMenuItem(root: string, reference: string): MenuItem {
  const key = repositoryKey(root);
  const primary = useSettings.getState().primaryBranchByRepo[key] === reference;
  return { label: primary ? "Clear primary branch" : "Set as primary branch", shortcut: "branch-primary", icon: <Flag size={I} />, onClick: () => {
    const settings = useSettings.getState();
    const primaryBranchByRepo = { ...settings.primaryBranchByRepo };
    if (primaryBranchByRepo[key] === reference) delete primaryBranchByRepo[key];
    else primaryBranchByRepo[key] = reference;
    settings.set({ primaryBranchByRepo });
    if (getTab(root)?.branchContext) void loadGraph(root);
  } };
}

function branchFavoriteMenuItem(root: string, reference: string): MenuItem {
  const favorite = useSettings.getState().branchFavoritesByRepo[repositoryKey(root)]?.includes(reference);
  return {
    label: favorite ? "Unfavorite branch" : "Favorite branch",
    shortcut: "branch-favorite",
    icon: <Star size={I} fill={favorite ? "currentColor" : "none"}/>,
    onClick: () => useSettings.getState().toggleBranchFavorite(repositoryKey(root), reference),
  };
}

export function branchMenu(root: string, name: string, kind: "local" | "remote", refs = getTab(root)?.refs,
  open?: (run: (root: string) => void) => void): MenuItem[] {
  const run = (action: (repo: string) => void) => () => open ? open(action) : action(root);
  const tab = getTab(root);
  const current = refs === tab?.refs && tab?.info ? tab.info.head.branch : refs?.local.find(branch => branch.isHead)?.name;
  const isCurrent = kind === "local" && name === current;
  const reference = `refs/${kind === "local" ? "heads" : "remotes"}/${name}`;
  const items: MenuItem[] = [...namePathMenu(name, root, reference), { separator: true }];
  if (!isCurrent) items.push({ label: kind === "remote" ? `Check out as local branch` : `Check out ${name}`, shortcut: "branch-checkout", icon: <Check size={I} />, onClick: run(repo => A.checkout(repo, name, kind)) });
  items.push({ label: "Create branch from here…", icon: <GitBranchPlus size={I} />, onClick: run(repo => A.createBranch(repo, name, name)) });
  items.push({ label: "Branch details…", shortcut: "branch-details", icon: <GitBranch size={I} />, onClick: run(repo => branchCard(repo, name, reference)) });
  items.push({ label: "Branch history (reflog)…", icon: <History size={I} />, onClick: run(repo => branchReflogDialog(repo, name)) });
  items.push({ label: "Browse files", icon: <FolderTree size={I} />, onClick: run(repo => openOverlay({ kind: "tree", root: repo, rev: name })) });
  items.push({ label: "Compare branch commits…", shortcut: "branch-compare", icon: <GitCompareArrows size={I} />, onClick: run(repo => branchCommitCompare(repo, reference)) });
  items.push(primaryBranchMenuItem(root, reference), branchFavoriteMenuItem(root, reference));
  items.push({ label: "Compare with working tree", icon: <GitCompareArrows size={I} />, onClick: run(repo => openOverlay({ kind: "compare", root: repo, from: reference, to: WORKTREE })) });
  if (!isCurrent) items.push({ label: `Compare with ${current ?? "HEAD"}`, icon: <GitCompareArrows size={I} />, onClick: run(repo => openOverlay({ kind: "compare", root: repo, from: current ? `refs/heads/${current}` : "HEAD", to: reference })) });
  if (!isCurrent && current) {
    items.push({ separator: true });
    items.push({ label: `Merge ${name} into ${current}…`, shortcut: "branch-merge", icon: <GitMerge size={I} />, onClick: run(repo => A.mergeInto(repo, name)) });
    items.push({ label: `Rebase ${current} onto ${name}`, shortcut: "branch-rebase", icon: <GitPullRequestArrow size={I} />, onClick: run(repo => A.rebaseOnto(repo, name)) });
  }
  items.push({ separator: true });
  if (isCurrent) items.push({ label: "Push…", icon: <CloudUpload size={I} />, onClick: run(repo => A.push(repo)) });
  items.push(...branchRemoteItems(reference, kind, current, refs, run));
  if (kind === "local") {
    items.push({ label: "Set upstream…", shortcut: "branch-upstream", icon: <Link2 size={I} />, onClick: run(repo => A.setUpstream(repo, name)) });
    items.push({ label: "Rename…", icon: <Pencil size={I} />, onClick: run(repo => A.renameBranch(repo, name)) });
    items.push({ label: "Delete…", shortcut: "branch-delete", icon: <Trash2 size={I} />, danger: true, disabled: isCurrent, onClick: run(repo => A.deleteBranch(repo, name)) });
  } else {
    items.push({ label: "Rename on remote…", icon: <Pencil size={I} />, onClick: run(repo => renameRemoteBranch(repo, name)) });
    items.push({ label: "Delete on remote…", shortcut: "branch-delete", icon: <Trash2 size={I} />, danger: true, onClick: run(repo => A.deleteRemoteBranch(repo, name)) });
  }
  return items;
}

function branchRemoteItems(reference: string, kind: "local" | "remote", current: string | null | undefined, refs: RefsSnapshot | null | undefined, run: (action: (repo: string) => void) => () => void): MenuItem[] {
  const local = refs?.local ?? [];
  const branch = local.find(candidate => candidate.fullName === reference);
  const remoteRef = kind === "remote" ? reference : branch?.upstreamFullName;
  const remotes = refs?.remotes ?? [];
  const upstreamRemote = remotes.reduce<string | undefined>((matched, remote) =>
    remoteRef?.startsWith(`refs/remotes/${remote.name}/`) && remote.name.length > (matched?.length ?? 0) ? remote.name : matched, undefined);
  const fetchRemotes = upstreamRemote ? [upstreamRemote] : kind === "local" ? remotes.map(remote => remote.name) : [];
  let fetchItem: MenuItem = { label: "Fetch", icon: <RefreshCw size={I} /> };
  if (fetchRemotes.length === 1) {
    const remote = fetchRemotes[0]!;
    fetchItem = { ...fetchItem, shortcut: "branch-fetch", onClick: run(repo => A.fetchRemote(repo, remote)) };
  } else if (fetchRemotes.length > 1) {
    fetchItem.children = fetchRemotes.map(remote => ({ label: remote, onClick: run(repo => A.fetchRemote(repo, remote)) }));
  } else {
    fetchItem = { ...fetchItem, disabled: true, hint: "No remote configured" };
  }

  const targets = kind === "local"
    ? branch?.upstream ? [branch] : []
    : local.filter(candidate => candidate.upstreamFullName === reference && candidate.upstream);
  const pull = (target: BranchInfo) => run(repo => {
    if (target.upstream) return A.pullBranch(repo, { branch: target.name, upstream: target.upstream });
  });
  const preferred = targets.find(target => target.name === current) ?? (targets.length === 1 ? targets[0] : undefined);
  let pullItem: MenuItem = { label: "Pull", icon: <ArrowDown size={I} /> };
  if (preferred) {
    pullItem = { ...pullItem, label: preferred.name === current ? "Pull" : "Pull…", shortcut: "branch-pull", onClick: pull(preferred) };
  } else if (targets.length > 1) {
    pullItem.children = targets.map(target => ({ label: target.name, onClick: pull(target) }));
  } else {
    pullItem = { ...pullItem, disabled: true, hint: kind === "local" ? "Set an upstream first" : "Check out a tracking branch first" };
  }
  return [pullItem, fetchItem];
}

export function tagMenu(root: string, name: string, oid: string): MenuItem[] {
  return [
    { label: "Check out tag", icon: <CircleDot size={I} />, onClick: () => A.checkout(root, name, "commit") },
    { label: "Create branch from tag…", icon: <GitBranchPlus size={I} />, onClick: () => A.createBranch(root, name, name) },
    { label: "Push tag", icon: <CloudUpload size={I} />, onClick: () => A.pushTag(root, name) },
    { separator: true },
    { label: "Copy name", icon: <Copy size={I} />, onClick: () => copyText(name) },
    { label: "Copy commit hash", icon: <Copy size={I} />, onClick: () => copyText(oid, "Hash copied") },
    { separator: true },
    { label: "Delete tag…", icon: <Trash2 size={I} />, danger: true, onClick: () => A.deleteTag(root, name) },
  ];
}

export function commitMenu(root: string, row: GraphRow, selection: GraphRow[]): MenuItem[] {
  const tab = getTab(root);
  const current = tab?.info?.head.branch ?? "HEAD";
  const busy = (tab?.info?.state.kind ?? "none") !== "none";
  const multi = selection.length > 1 ? selection : null;
  const branches = row.refs.filter((r) => r.kind === "local" || r.kind === "remote");
  const items: MenuItem[] = [];

  if (multi) {
    const ordered = [...multi].sort((a, b) => b.index - a.index); // oldest first
    items.push({ label: `Cherry-pick ${multi.length} commits`, shortcut: "commit-pick", icon: <GitCommitHorizontal size={I} />, disabled: busy, onClick: () => A.cherryPick(root, ordered.map((r) => r.oid)) });
    items.push({
      label: `Squash ${multi.length} commits…`,
      icon: <Combine size={I} />,
      disabled: busy,
      onClick: () =>
        A.squashCommits(
          root,
          ordered.map((r) => r.oid),
          ordered.map((r) => r.subject),
        ),
    });
    items.push({ label: `Save ${multi.length} commits as a patch…`, shortcut: "commit-patch", icon: <FileDown size={I} />, onClick: () => savePatch(root, ordered.map((r) => r.oid), ordered[ordered.length - 1].subject) });
    if (multi.length === 2)
      items.push({ label: "Compare these two commits", icon: <GitCompareArrows size={I} />, onClick: () => openOverlay({ kind: "compare", root, from: ordered[0].oid, to: ordered[1].oid }) });
    items.push({ label: `Drop ${multi.length} commits…`, shortcut: "commit-drop", icon: <Trash2 size={I} />, danger: true, disabled: busy, onClick: () => A.dropCommits(root, ordered.map((r) => r.oid)) });
    items.push({ separator: true });
    items.push({ label: "Copy hashes", icon: <Copy size={I} />, onClick: () => copyText(ordered.map((r) => r.oid).join("\n"), "Hashes copied") });
    return items;
  }

  items.push({ label: "Check out this commit", shortcut: "commit-checkout", icon: <CircleDot size={I} />, disabled: row.isHead, onClick: () => A.checkout(root, row.oid, "commit") });
  items.push({ label: "Create branch here…", shortcut: "commit-branch", icon: <GitBranchPlus size={I} />, onClick: () => A.createBranch(root, row.oid, shortOid(row.oid)) });
  items.push({ label: "Create tag here…", shortcut: "commit-tag", icon: <Tag size={I} />, onClick: () => A.createTag(root, row.oid) });
  items.push({ separator: true });
  if (!row.isHead) {
    if (branches.length) {
      for (const b of branches.slice(0, 3)) {
        if (b.kind === "head") continue;
        items.push({ label: `Merge ${b.name} into ${current}…`, icon: <GitMerge size={I} />, disabled: busy, onClick: () => A.mergeInto(root, b.name) });
      }
    } else {
      items.push({ label: `Merge this commit into ${current}…`, icon: <GitMerge size={I} />, disabled: busy, onClick: () => A.mergeInto(root, row.oid) });
    }
    items.push({ label: `Rebase ${current} onto here`, icon: <GitPullRequestArrow size={I} />, disabled: busy, onClick: () => A.rebaseOnto(root, branches[0]?.name ?? row.oid) });
    items.push({ label: "Cherry-pick", shortcut: "commit-pick", icon: <GitCommitHorizontal size={I} />, disabled: busy, onClick: () => A.cherryPick(root, [row.oid]) });
  }
  items.push({ label: "Compare with working tree", shortcut: "commit-compare", icon: <GitCompareArrows size={I} />, onClick: () => openOverlay({ kind: "compare", root, from: row.oid, to: WORKTREE }) });
  items.push({ label: "Browse files at this commit", shortcut: "commit-browse", icon: <FolderTree size={I} />, onClick: () => openOverlay({ kind: "tree", root, rev: row.oid }) });
  items.push({ label: "Save as patch…", shortcut: "commit-patch", icon: <FileDown size={I} />, onClick: () => savePatch(root, [row.oid], row.subject) });
  if (!row.isHead) items.push({ label: `Compare with ${current}`, icon: <GitCompareArrows size={I} />, onClick: () => openOverlay({ kind: "compare", root, from: row.oid, to: "HEAD" }) });
  items.push({ label: "Revert commit", shortcut: "commit-revert", icon: <Undo2 size={I} />, disabled: busy, onClick: () => A.revertCommit(root, row.oid) });
  items.push({ label: `Reset ${current} to here…`, shortcut: "commit-reset", icon: <RotateCcw size={I} />, disabled: busy || row.isHead, onClick: () => A.resetTo(root, row.oid, row.subject) });
  items.push({ separator: true });
  const editable = !busy && !row.isMerge;
  items.push({
    label: "Edit history",
    icon: <Shuffle size={I} />,
    disabled: !editable,
    children: [
      { label: "Interactive rebase from here…", shortcut: "commit-rebase", icon: <ListOrdered size={I} />, onClick: () => openOverlay({ kind: "rebase", root, base: null, oldest: row.oid }) },
      { separator: true },
      { label: "Edit message…", shortcut: "commit-reword", icon: <Pencil size={I} />, onClick: () => A.reword(root, row.oid) },
      { label: "Edit commit contents (stop here)", icon: <FileEdit size={I} />, onClick: () => A.editCommit(root, row.oid) },
      {
        label: "Squash into parent…",
        icon: <Combine size={I} />,
        disabled: row.parents.length !== 1,
        onClick: async () => {
          const parent = await api.commitDetails(root, row.parents[0]).catch(() => null);
          A.squashCommits(root, [row.parents[0], row.oid], [parent?.subject ?? "", row.subject]);
        },
      },
      { label: "Move up (newer)", icon: <ArrowUp size={I} />, disabled: row.isHead, onClick: () => A.moveCommit(root, row.oid, 1) },
      { label: "Move down (older)", icon: <ArrowDown size={I} />, onClick: () => A.moveCommit(root, row.oid, -1) },
      { separator: true },
      { label: "Drop commit…", shortcut: "commit-drop", icon: <Trash2 size={I} />, danger: true, onClick: () => A.dropCommits(root, [row.oid]) },
    ],
  });
  const bisecting = tab?.info?.state.kind === "bisect";
  items.push({
    label: "Bisect",
    icon: <Bug size={I} />,
    children: bisecting
      ? [
          { label: "Mark this commit good", onClick: () => X.bisectMark(root, "good", row.oid) },
          { label: "Mark this commit bad", onClick: () => X.bisectMark(root, "bad", row.oid) },
          { label: "Skip this commit", onClick: () => X.bisectMark(root, "skip", row.oid) },
          { separator: true },
          { label: "Finish bisect", onClick: () => X.bisectReset(root) },
        ]
      : [{ label: "Start: this commit is good, HEAD is bad…", disabled: row.isHead || busy, onClick: () => X.bisectStart(root, row.oid) }],
  });
  if (row.isHead) items.push({ label: "Undo commit (keep changes staged)", icon: <Eraser size={I} />, disabled: busy, onClick: () => A.undoLastCommit(root) });
  if (!row.localOnly) items.push({ label: "Already pushed — rewriting needs a force push", icon: <Info size={I} />, disabled: true });
  items.push({ separator: true });
  items.push({
    label: "Copy",
    icon: <Copy size={I} />,
    children: [
      { label: "Full hash", hint: shortOid(row.oid), onClick: () => copyText(row.oid, "Hash copied") },
      { label: "Short hash", onClick: () => copyText(row.oid.slice(0, 8), "Short hash copied") },
      { label: "Subject", onClick: () => copyText(row.subject, "Subject copied") },
      { label: "Hash and subject", onClick: () => copyText(`${row.oid.slice(0, 8)} ${row.subject}`) },
    ],
  });
  if (branches.length) {
    items.push({ separator: true });
    for (const b of branches) {
      if (b.kind === "head") continue;
      items.push({ label: b.name, icon: <GitBranch size={I} />, children: branchMenu(root, b.name, b.kind === "remote" ? "remote" : "local") });
    }
  }
  return items;
}
