// High-level user actions: call the backend, report results, refresh state.
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, isGitError, newOpId } from "./api";
import { ALL, getTab, useRepos, type Parts } from "./store";
import { endBusy, showDialog, startBusy, toast, useUi } from "./ui";
import { GitMerge } from "lucide-react";
import { Modal } from "../components/Modal";
import { useSettings } from "./settings";
import type { OpOutcome } from "./types";
import { shortOid } from "./format";
import {
  cloneDialog,
  confirmDialog,
  createBranchDialog,
  discardDialog,
  identityDialog,
  mergeDialog,
  promptDialog,
  pushDialog,
  resetDialog,
  stashDialog,
  tagDialog,
  validBranchName,
} from "../components/dialogs";

interface ActOptions<T> {
  success?: string | ((r: T) => string | null);
  refresh?: Parts;
  busy?: string;
  quiet?: boolean;
}

/** Runs a backend action with consistent error handling and refresh. */
export async function act<T>(root: string, fn: () => Promise<T>, o: ActOptions<T> = {}): Promise<T | undefined> {
  const busyId = o.busy ? newOpId() : null;
  if (busyId) startBusy(busyId, o.busy!);
  try {
    const r = await fn();
    const msg = typeof o.success === "function" ? o.success(r) : o.success;
    if (msg) toast.success(msg);
    return r;
  } catch (e) {
    if (isGitError(e) && e.kind === "identity") {
      if (await identityDialog(root)) return act(root, fn, o);
      return undefined;
    }
    if (isGitError(e) && e.kind === "dirty-worktree") {
      useUi.getState().toast({
        kind: "error",
        title: "Local changes are in the way",
        detail: e.message,
        action: { label: "Stash changes", run: () => stash(root) },
      });
      return undefined;
    }
    if (!o.quiet) toast.error(e);
    return undefined;
  } finally {
    if (busyId) endBusy(busyId);
    // Status / state first (what the caller acts on); history and refs follow in the background.
    const parts = o.refresh ?? ALL;
    await useRepos.getState().refresh(root, { info: parts.info, status: parts.status, layers: parts.layers });
    if (parts.refs || parts.graph) void useRepos.getState().refresh(root, { refs: parts.refs, graph: parts.graph, info: parts.info });
  }
}

async function remote<T>(root: string, label: string, fn: (opId: string) => Promise<T>, success?: (r: T) => string | null): Promise<T | undefined> {
  const opId = newOpId();
  startBusy(opId, label);
  try {
    const r = await fn(opId);
    const msg = success?.(r);
    if (msg) toast.success(msg);
    return r;
  } catch (e) {
    if (isGitError(e) && e.kind === "auth") toast.error(e, "Authentication failed — check your credentials or SSH key");
    else if (isGitError(e) && e.kind === "rejected") toast.error(e, "Push rejected — pull first or force push");
    else toast.error(e, `${label} failed`);
    return undefined;
  } finally {
    endBusy(opId);
    await useRepos.getState().refresh(root, ALL);
  }
}

/** Presents the result of merge / cherry-pick / rebase style operations. */
export function handleOutcome(root: string, out: OpOutcome | undefined, what: string) {
  if (!out) return;
  const st = useRepos.getState();
  // Only jump to the Changes view while the operation is really still in progress.
  const inProgress = (st.tabs[root]?.info?.state.kind ?? "none") !== "none" || (st.tabs[root]?.status?.conflictCount ?? 0) > 0;
  if ((out.status === "conflicts" || out.status === "pending" || out.status === "stopped") && !inProgress) return;
  switch (out.status) {
    case "conflicts":
      st.patch(root, { view: "changes", changeSel: out.conflicts[0] ? { kind: "conflict", path: out.conflicts[0] } : null });
      toast.warning(`${what}: ${out.conflicts.length} conflict(s)`, "Resolve them in the Changes view, then continue — or abort to roll everything back.");
      break;
    case "pending":
      st.patch(root, { view: "changes" });
      toast.info(`${what} is ready for review`, "Check the staged result, then press Confirm merge. Nothing is committed yet.");
      break;
    case "stopped":
      st.patch(root, { view: "changes" });
      toast.info(`${what} paused`, out.message || "Make your changes, then continue.");
      break;
    case "upToDate":
      toast.info("Already up to date");
      break;
    case "fastForward":
      toast.success(out.message || "Fast-forwarded");
      break;
    default:
      toast.success(`${what} complete`);
  }
}

// ───────────── repositories ─────────────

export async function openRepoPath(path: string) {
  try {
    await useRepos.getState().open(path);
  } catch (e) {
    if (isGitError(e) && e.kind === "not-a-repo") {
      const ok = await confirmDialog({ title: "Not a Git repository", message: `${path} is not a Git repository. Create a new repository here?`, confirm: "Initialize" });
      if (ok) {
        try {
          await api.repoInit(path);
          await useRepos.getState().open(path);
          toast.success("Repository initialized");
        } catch (e2) {
          toast.error(e2);
        }
      }
    } else {
      toast.error(e, "Cannot open repository");
    }
  }
}

export async function openRepoDialog() {
  const dir = await openFolder({ directory: true, title: "Open a Git repository" });
  if (typeof dir === "string") await openRepoPath(dir);
}

export async function initRepoDialog() {
  const dir = await openFolder({ directory: true, title: "Choose a folder for the new repository" });
  if (typeof dir !== "string") return;
  try {
    await api.repoInit(dir);
    await useRepos.getState().open(dir);
    toast.success("Repository initialized");
  } catch (e) {
    toast.error(e);
  }
}

export async function cloneRepo() {
  const r = await cloneDialog();
  if (!r) return;
  const opId = newOpId();
  startBusy(opId, `Cloning ${r.name}`);
  try {
    const info = await api.repoClone(r.parent, r.url, r.name, opId);
    await useRepos.getState().open(info.root);
    toast.success(`Cloned ${r.name}`);
  } catch (e) {
    toast.error(e, "Clone failed");
  } finally {
    endBusy(opId);
  }
}

// ───────────── remotes ─────────────

export const fetchAll = (root: string) => remote(root, "Fetching", (id) => api.fetch(root, null, true, id), () => "Fetched from all remotes");

export async function pull(root: string, modeOverride?: "ff-only" | "merge" | "rebase") {
  const mode = modeOverride ?? useSettings.getState().pullMode;
  const opId = newOpId();
  startBusy(opId, "Pulling");
  let diverged = false;
  try {
    const out = await api.pull(root, mode, opId);
    if (out.status !== "done") handleOutcome(root, out, "Pull");
    else toast.success("Pulled");
  } catch (e) {
    const msg = errorMessage(e).toLowerCase();
    if (mode === "ff-only" && (msg.includes("not possible to fast-forward") || msg.includes("diverg"))) diverged = true;
    else if (isGitError(e) && e.kind === "auth") toast.error(e, "Authentication failed — check your credentials or SSH key");
    else toast.error(e, "Pull failed");
  } finally {
    endBusy(opId);
    await useRepos.getState().refresh(root, ALL);
  }
  if (diverged) {
    const how = await showDialog<"merge" | "rebase" | null>((close) => (
      <Modal
        title="Your branch and the remote have diverged"
        subtitle="Both sides have new commits, so a fast-forward is not possible."
        icon={<GitMerge size={18} />}
        tone="warn"
        onClose={() => close(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => close(null)}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => close("rebase")}>
              Rebase my commits
            </button>
            <button type="button" className="btn primary" onClick={() => close("merge")}>
              Merge
            </button>
          </>
        }
      >
        <div className="muted">Merge keeps both histories with a merge commit. Rebase replays your local commits on top of the remote ones for a straight history.</div>
      </Modal>
    ));
    if (how) await pull(root, how);
  }
}

export async function push(root: string) {
  const tab = getTab(root);
  const branch = tab?.info?.head.branch;
  if (!tab || !branch) {
    toast.warning("Check out a branch to push");
    return;
  }
  const remotes = tab.refs?.remotes ?? [];
  if (remotes.length === 0) {
    const url = await promptDialog({ title: "Add a remote", label: "This repository has no remote. Remote URL for 'origin':", placeholder: "https://github.com/user/repo.git" });
    if (!url) return;
    const ok = await act(root, () => api.remoteAdd(root, "origin", url), { success: "Remote 'origin' added", refresh: { refs: true } });
    if (ok === undefined) return;
  }
  const t2 = getTab(root)!;
  const status = t2.status;
  const opts = await pushDialog({ branch, remotes: t2.refs?.remotes ?? [], upstream: status?.upstream ?? null, ahead: status?.ahead ?? 0, behind: status?.behind ?? 0 });
  if (!opts) return;
  await remote(root, `Pushing ${branch}`, (id) => api.push(root, opts, id), () => `Pushed ${branch}`);
}

/** One-click push used after committing; asks only when needed. */
export async function quickPush(root: string) {
  const tab = getTab(root);
  if (tab?.status?.upstream && tab.status.behind === 0) {
    await remote(root, "Pushing", (id) => api.push(root, {}, id), () => "Pushed");
  } else {
    await push(root);
  }
}

export async function addRemote(root: string) {
  const name = await promptDialog({ title: "Add remote", label: "Name", initial: "origin" });
  if (!name) return;
  const url = await promptDialog({ title: `URL for ${name}`, label: "Remote URL", placeholder: "https://github.com/user/repo.git" });
  if (!url) return;
  await act(root, () => api.remoteAdd(root, name, url), { success: `Remote ${name} added` });
}

// ───────────── branches ─────────────

export function checkout(root: string, target: string, kind: "local" | "remote" | "commit") {
  return act(root, () => api.checkout(root, target, kind), { success: (b) => (kind === "commit" ? `Checked out ${shortOid(target)} (detached HEAD)` : `Switched to ${b}`), busy: "Switching branch" });
}

export async function createBranch(root: string, start: string | null, startLabel: string) {
  const r = await createBranchDialog(startLabel);
  if (!r) return;
  await act(root, () => api.branchCreate(root, r.name, start, r.checkout), { success: `Branch ${r.name} created` });
}

export async function renameBranch(root: string, name: string) {
  const v = await promptDialog({ title: `Rename ${name}`, label: "New name", initial: name, validate: validBranchName, confirm: "Rename" });
  if (!v || v === name) return;
  await act(root, () => api.branchRename(root, name, v.trim()), { success: `Renamed to ${v.trim()}` });
}

export async function deleteBranch(root: string, name: string) {
  const ok = await confirmDialog({ title: `Delete branch ${name}?`, message: "The branch label is removed. Commits stay reachable through other branches or the reflog.", confirm: "Delete", danger: true });
  if (!ok) return;
  try {
    await api.branchDelete(root, name, false);
    toast.success(`Deleted ${name}`);
  } catch (e) {
    if (isGitError(e) && e.kind === "not-merged") {
      const force = await confirmDialog({ title: `${name} is not fully merged`, message: "Its commits are not in your current branch. Delete it anyway?", confirm: "Force delete", danger: true });
      if (force) await act(root, () => api.branchDelete(root, name, true), { success: `Deleted ${name}` });
    } else toast.error(e);
  }
  await useRepos.getState().refresh(root, ALL);
}

export async function deleteRemoteBranch(root: string, remoteBranch: string) {
  const i = remoteBranch.indexOf("/");
  const remoteName = remoteBranch.slice(0, i);
  const branch = remoteBranch.slice(i + 1);
  const ok = await confirmDialog({ title: `Delete ${remoteBranch} on the server?`, message: `This deletes the branch '${branch}' from remote '${remoteName}' for everyone.`, confirm: "Delete remote branch", danger: true });
  if (!ok) return;
  await remote(root, `Deleting ${remoteBranch}`, (id) => api.pushRef(root, remoteName, `:refs/heads/${branch}`, id), () => `Deleted ${remoteBranch}`);
}

export async function setUpstream(root: string, branch: string) {
  const tab = getTab(root);
  const candidates = tab?.refs?.remote.map((r) => r.name) ?? [];
  const v = await promptDialog({ title: `Upstream for ${branch}`, label: "Remote branch", initial: candidates.find((c) => c.endsWith("/" + branch)) ?? candidates[0] ?? "origin/" + branch, help: "Leave as is to track the matching remote branch." });
  if (!v) return;
  await act(root, () => api.branchSetUpstream(root, branch, v.trim()), { success: `${branch} now tracks ${v.trim()}` });
}

export async function mergeInto(root: string, target: string) {
  const tab = getTab(root);
  const current = tab?.info?.head.branch ?? "HEAD";
  const strategy = await mergeDialog(target, current);
  if (!strategy) return;
  const out = await act(root, () => api.mergeStart(root, target, strategy), { busy: `Merging ${target}` });
  handleOutcome(root, out, "Merge");
}

export async function rebaseOnto(root: string, target: string) {
  const tab = getTab(root);
  const current = tab?.info?.head.branch ?? "HEAD";
  const ok = await confirmDialog({ title: `Rebase ${current} onto ${target}?`, message: "Your commits are replayed on top of the target. Commits get new hashes; avoid this for branches others already use.", confirm: "Rebase" });
  if (!ok) return;
  const out = await act(root, () => api.rebaseOnto(root, target), { busy: "Rebasing" });
  handleOutcome(root, out, "Rebase");
}

// ───────────── commits ─────────────

export async function cherryPick(root: string, oids: string[]) {
  const out = await act(root, () => api.cherryPick(root, oids, false), { busy: "Cherry-picking" });
  handleOutcome(root, out, "Cherry-pick");
}

export async function revertCommit(root: string, oid: string) {
  const out = await act(root, () => api.revert(root, oid, false), { busy: "Reverting" });
  handleOutcome(root, out, "Revert");
}

export async function resetTo(root: string, oid: string, subject: string) {
  const tab = getTab(root);
  const mode = await resetDialog(tab?.info?.head.branch ?? "HEAD", oid, subject);
  if (!mode) return;
  await act(root, () => api.reset(root, oid, mode), { success: `Reset to ${shortOid(oid)}` });
}

export async function reword(root: string, oid: string) {
  const details = await api.commitDetails(root, oid).catch(() => null);
  const current = details ? (details.body ? `${details.subject}\n\n${details.body}` : details.subject) : "";
  const msg = await promptDialog({ title: "Edit commit message", initial: current, multiline: true, confirm: "Save message", help: "Ctrl+Enter to save. Commits after this one are re-created." });
  if (!msg || msg === current) return;
  const out = await act(root, () => api.rewrite(root, { action: "reword", oid, message: msg }), { busy: "Rewriting history" });
  if (out && out.status !== "done") handleOutcome(root, out, "Edit message");
  else if (out) toast.success("Commit message updated");
}

export async function dropCommits(root: string, oids: string[]) {
  const ok = await confirmDialog({
    title: oids.length === 1 ? "Drop this commit?" : `Drop ${oids.length} commits?`,
    message: "The commit is removed from the branch history and its changes disappear. You can get it back from the reflog.",
    confirm: "Drop",
    danger: true,
  });
  if (!ok) return;
  const out = await act(root, () => api.rewrite(root, { action: "drop", oids }), { busy: "Rewriting history" });
  if (out && out.status !== "done") handleOutcome(root, out, "Drop");
  else if (out) toast.success("Dropped");
}

export async function squashCommits(root: string, oids: string[], subjects: string[]) {
  const msg = await promptDialog({ title: `Squash ${oids.length} commits`, initial: subjects.join("\n"), multiline: true, confirm: "Squash", help: "The combined commit gets this message." });
  if (!msg) return;
  const out = await act(root, () => api.rewrite(root, { action: "squash", oids, message: msg }), { busy: "Squashing" });
  if (out && out.status !== "done") handleOutcome(root, out, "Squash");
  else if (out) toast.success("Commits squashed");
}

export async function editCommit(root: string, oid: string) {
  const out = await act(root, () => api.rewrite(root, { action: "edit", oid }), { busy: "Starting edit" });
  handleOutcome(root, out, "Edit commit");
}

export async function moveCommit(root: string, oid: string, delta: number) {
  const out = await act(root, () => api.rewrite(root, { action: "move", oid, delta }), { busy: "Reordering" });
  if (out && out.status !== "done") handleOutcome(root, out, "Move");
}

export async function undoLastCommit(root: string) {
  await act(root, () => api.undoCommit(root), { success: "Last commit undone — its changes are staged" });
}

export async function createTag(root: string, oid: string) {
  const r = await tagDialog(oid);
  if (!r) return;
  await act(root, () => api.tagCreate(root, r.name, oid, r.message || null), { success: `Tag ${r.name} created` });
}

export async function deleteTag(root: string, name: string) {
  const ok = await confirmDialog({ title: `Delete tag ${name}?`, confirm: "Delete", danger: true });
  if (ok) await act(root, () => api.tagDelete(root, name), { success: `Deleted tag ${name}` });
}

export async function pushTag(root: string, name: string) {
  const r = getTab(root)?.refs?.remotes[0]?.name ?? "origin";
  await remote(root, `Pushing tag ${name}`, (id) => api.pushRef(root, r, `refs/tags/${name}`, id), () => `Pushed tag ${name}`);
}

// ───────────── stash ─────────────

export async function stash(root: string) {
  const r = await stashDialog();
  if (!r) return;
  await act(root, () => api.stashSave(root, r.message, r.untracked, r.keepIndex), { success: "Changes stashed" });
}

export async function stashApply(root: string, index: number, pop: boolean) {
  const out = await act(root, () => api.stashApply(root, index, pop));
  if (out?.status === "conflicts") handleOutcome(root, out, "Stash");
  else if (out) toast.success(pop ? "Stash popped" : "Stash applied");
}

export async function stashDrop(root: string, index: number) {
  const ok = await confirmDialog({ title: "Delete this stash?", confirm: "Delete", danger: true });
  if (ok) await act(root, () => api.stashDrop(root, index), { success: "Stash deleted" });
}

// ───────────── in-progress operations ─────────────

export async function abortOp(root: string, kind: string) {
  const what = kind === "merge" || kind === "squash" ? "merge" : kind;
  const ok = await confirmDialog({ title: `Abort ${what}?`, message: "Everything returns to the state before it started. Conflict resolutions you made are lost.", confirm: `Abort ${what}`, danger: true });
  if (!ok) return;
  await act(root, () => api.opAbort(root, kind), { success: `${what[0].toUpperCase() + what.slice(1)} aborted` });
}

export async function confirmMerge(root: string, kind: "merge" | "squash", message: string | null) {
  const msg = await promptDialog({
    title: kind === "merge" ? "Confirm merge" : "Commit squashed changes",
    label: "Commit message",
    initial: (message ?? "").replace(/^#.*$/gm, "").trim(),
    multiline: true,
    confirm: kind === "merge" ? "Create merge commit" : "Commit",
  });
  if (!msg) return;
  const out = await act(root, () => api.opContinue(root, kind, msg), { busy: "Committing" });
  if (out) toast.success(kind === "merge" ? "Merge committed" : "Squash committed");
}

export async function continueOp(root: string, kind: string) {
  const out = await act(root, () => api.opContinue(root, kind, null), { busy: "Continuing" });
  if (out && out.status !== "done") handleOutcome(root, out, kind[0].toUpperCase() + kind.slice(1));
  else if (out) toast.success(`${kind[0].toUpperCase() + kind.slice(1)} complete`);
}

export async function skipOp(root: string, kind: string) {
  const out = await act(root, () => api.opSkip(root, kind));
  if (out && out.status !== "done") handleOutcome(root, out, kind);
}

/** During an "edit" stop: amend staged changes into the commit and continue. */
export async function amendAndContinue(root: string) {
  const tab = getTab(root);
  if ((tab?.status?.stagedCount ?? 0) > 0) {
    const msg = await api.lastMessage(root).catch(() => "");
    const ok = await act(root, () => api.commit(root, msg, { amend: true }), { quiet: false });
    if (ok === undefined) return;
  }
  await continueOp(root, "rebase");
}

// ───────────── working copy ─────────────

export const stagePaths = (root: string, paths: string[]) => act(root, () => api.stage(root, paths), { refresh: { status: true, layers: true } });
export const unstagePaths = (root: string, paths: string[]) => act(root, () => api.unstage(root, paths), { refresh: { status: true, layers: true } });

export async function discardPaths(root: string, tracked: string[], untracked: string[]) {
  if (useSettings.getState().confirmDiscard && !(await discardDialog([...tracked, ...untracked]))) return;
  await act(root, () => api.discard(root, tracked, untracked), { success: "Changes discarded (backup kept)", refresh: { status: true, layers: true } });
}

/** Stage into a fresh layer: seal what is staged now, then stage the new paths on top. */
export async function stageAsNewLayer(root: string, paths: string[]) {
  const tab = getTab(root);
  const hasOpen = (tab?.layers?.active ? tab.layers.openFiles.length : tab?.status?.stagedCount ?? 0) > 0;
  await act(
    root,
    async () => {
      if (hasOpen) await api.layerSeal(root, null);
      await api.stage(root, paths);
    },
    { refresh: { status: true, layers: true } },
  );
}

export async function commit(root: string, message: string, opts: { amend?: boolean; signOff?: boolean; noVerify?: boolean; sign?: boolean }, andPush = false): Promise<boolean> {
  const r = await act(root, () => api.commit(root, message, opts), { success: (oid) => `Committed ${shortOid(oid)}` });
  if (r === undefined) return false;
  if (andPush) await quickPush(root);
  return true;
}

export function friendly(e: unknown) {
  return errorMessage(e);
}
