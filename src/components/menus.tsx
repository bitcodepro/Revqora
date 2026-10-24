import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleDot,
  CloudUpload,
  Copy,
  Eraser,
  FileEdit,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  Link2,
  Pencil,
  RotateCcw,
  Shuffle,
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
import { getTab } from "../lib/store";
import { api } from "../lib/api";
import { branchCard } from "./BranchCard";
import { branchReflogDialog, savePatch } from "./RepoTools";
import { WORKTREE } from "../lib/types";
import type { GraphRow } from "../lib/types";
import { shortOid } from "../lib/format";

const I = 14;

export function branchMenu(root: string, name: string, kind: "local" | "remote"): MenuItem[] {
  const tab = getTab(root);
  const current = tab?.info?.head.branch;
  const isCurrent = kind === "local" && name === current;
  const items: MenuItem[] = [];
  if (!isCurrent) items.push({ label: kind === "remote" ? `Check out as local branch` : `Check out ${name}`, icon: <Check size={I} />, onClick: () => A.checkout(root, name, kind) });
  items.push({ label: "Create branch from here…", icon: <GitBranchPlus size={I} />, onClick: () => A.createBranch(root, name, name) });
  items.push({ label: "Branch details…", icon: <GitBranch size={I} />, onClick: () => branchCard(root, name) });
  items.push({ label: "Branch history (reflog)…", icon: <History size={I} />, onClick: () => branchReflogDialog(root, name) });
  items.push({ label: "Browse files", icon: <FolderTree size={I} />, onClick: () => openOverlay({ kind: "tree", root, rev: name }) });
  items.push({ label: "Compare with working tree", icon: <GitCompareArrows size={I} />, onClick: () => openOverlay({ kind: "compare", root, from: name, to: WORKTREE }) });
  if (!isCurrent) items.push({ label: `Compare with ${current ?? "HEAD"}`, icon: <GitCompareArrows size={I} />, onClick: () => openOverlay({ kind: "compare", root, from: current ?? "HEAD", to: name }) });
  if (!isCurrent && current) {
    items.push({ separator: true });
    items.push({ label: `Merge ${name} into ${current}…`, icon: <GitMerge size={I} />, onClick: () => A.mergeInto(root, name) });
    items.push({ label: `Rebase ${current} onto ${name}`, icon: <GitPullRequestArrow size={I} />, onClick: () => A.rebaseOnto(root, name) });
  }
  items.push({ separator: true });
  if (kind === "local") {
    if (isCurrent) items.push({ label: "Push…", icon: <CloudUpload size={I} />, onClick: () => A.push(root) });
    items.push({ label: "Set upstream…", icon: <Link2 size={I} />, onClick: () => A.setUpstream(root, name) });
    items.push({ label: "Rename…", icon: <Pencil size={I} />, onClick: () => A.renameBranch(root, name) });
    items.push({ label: "Delete…", icon: <Trash2 size={I} />, danger: true, disabled: isCurrent, onClick: () => A.deleteBranch(root, name) });
  } else {
    items.push({ label: "Delete on remote…", icon: <Trash2 size={I} />, danger: true, onClick: () => A.deleteRemoteBranch(root, name) });
  }
  items.push({ separator: true });
  items.push({ label: "Copy name", icon: <Copy size={I} />, onClick: () => copyText(name, "Branch name copied") });
  return items;
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
    items.push({ label: `Cherry-pick ${multi.length} commits`, icon: <GitCommitHorizontal size={I} />, disabled: busy, onClick: () => A.cherryPick(root, ordered.map((r) => r.oid)) });
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
    items.push({ label: `Save ${multi.length} commits as a patch…`, icon: <FileDown size={I} />, onClick: () => savePatch(root, ordered.map((r) => r.oid), ordered[ordered.length - 1].subject) });
    if (multi.length === 2)
      items.push({ label: "Compare these two commits", icon: <GitCompareArrows size={I} />, onClick: () => openOverlay({ kind: "compare", root, from: ordered[0].oid, to: ordered[1].oid }) });
    items.push({ label: `Drop ${multi.length} commits…`, icon: <Trash2 size={I} />, danger: true, disabled: busy, onClick: () => A.dropCommits(root, ordered.map((r) => r.oid)) });
    items.push({ separator: true });
    items.push({ label: "Copy hashes", icon: <Copy size={I} />, onClick: () => copyText(ordered.map((r) => r.oid).join("\n"), "Hashes copied") });
    return items;
  }

  items.push({ label: "Check out this commit", icon: <CircleDot size={I} />, disabled: row.isHead, onClick: () => A.checkout(root, row.oid, "commit") });
  items.push({ label: "Create branch here…", icon: <GitBranchPlus size={I} />, onClick: () => A.createBranch(root, row.oid, shortOid(row.oid)) });
  items.push({ label: "Create tag here…", icon: <Tag size={I} />, onClick: () => A.createTag(root, row.oid) });
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
    items.push({ label: "Cherry-pick", icon: <GitCommitHorizontal size={I} />, disabled: busy, onClick: () => A.cherryPick(root, [row.oid]) });
  }
  items.push({ label: "Compare with working tree", icon: <GitCompareArrows size={I} />, onClick: () => openOverlay({ kind: "compare", root, from: row.oid, to: WORKTREE }) });
  items.push({ label: "Browse files at this commit", icon: <FolderTree size={I} />, onClick: () => openOverlay({ kind: "tree", root, rev: row.oid }) });
  items.push({ label: "Save as patch…", icon: <FileDown size={I} />, onClick: () => savePatch(root, [row.oid], row.subject) });
  if (!row.isHead) items.push({ label: `Compare with ${current}`, icon: <GitCompareArrows size={I} />, onClick: () => openOverlay({ kind: "compare", root, from: row.oid, to: "HEAD" }) });
  items.push({ label: "Revert commit", icon: <Undo2 size={I} />, disabled: busy, onClick: () => A.revertCommit(root, row.oid) });
  items.push({ label: `Reset ${current} to here…`, icon: <RotateCcw size={I} />, disabled: busy || row.isHead, onClick: () => A.resetTo(root, row.oid, row.subject) });
  items.push({ separator: true });
  const editable = !busy && !row.isMerge;
  items.push({
    label: "Edit history",
    icon: <Shuffle size={I} />,
    disabled: !editable,
    children: [
      { label: "Interactive rebase from here…", icon: <ListOrdered size={I} />, onClick: () => openOverlay({ kind: "rebase", root, base: null, oldest: row.oid }) },
      { separator: true },
      { label: "Edit message…", icon: <Pencil size={I} />, onClick: () => A.reword(root, row.oid) },
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
      { label: "Drop commit…", icon: <Trash2 size={I} />, danger: true, onClick: () => A.dropCommits(root, [row.oid]) },
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
