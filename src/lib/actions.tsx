import { readableMergeMessage } from "./branchRef";
import { plural } from "./format";
import { bitbucketHttps } from "./bitbucketHttps";
// High-level user actions: call the backend, report results, refresh state.
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, isGitError, newOpId } from "./api";
import { recordError } from "./errorLog";
import { ALL, getTab, historyAfterSwitch, operationChangeTime, refreshAfterOperation, refreshUntilShown, useRepos, type Parts } from "./store";
import { endBusy, showDialog, startBusy, toast, useUi } from "./ui";
import { GitMerge } from "lucide-react";
import { Modal } from "../components/Modal";
import { DeleteBranchDialog, type DeleteBranchOutcome } from "../components/DeleteBranchDialog";
import { useSettings } from "./settings";
import type { OpOutcome, PullOutcome, SwitchChoice, SwitchOutcome } from "./types";
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
  rebaseMergesDialog,
  resetDialog,
  stashDialog,
  tagDialog,
  validBranchName,
} from "../components/dialogs";

interface ActOptions<T> {
  success?: string | ((r: T) => string | null);
  refresh?: Parts | false;
  busy?: string;
  quiet?: boolean;
  onError?: (error: unknown) => void;
}

/** Establish the state shown by a confirmation, then keep it fixed until submission. */
export async function prepareOperation(root: string): Promise<string | null> {
  try {
    const [status, info] = await Promise.all([api.status(root), api.repoInfo(root)]);
    if (status.branch !== info.head.branch || status.oid !== info.head.oid) {
      toast.warning("Repository is changing", "Refresh and review its current state before trying again.");
      return null;
    }
    const displayed = getTab(root)?.info?.head;
    useRepos.getState().patch(root, { status, info });
    if (displayed && (displayed.branch !== info.head.branch || displayed.oid !== info.head.oid)) {
      toast.warning("Repository changed", "The current branch or commit changed. Review the refreshed view before trying again.");
      return null;
    }
    return status.stateToken ?? null;
  } catch (e) { toast.error(e); return null; }
}

/** Runs a backend action with consistent error handling and refresh. */
export async function act<T>(root: string, fn: () => Promise<T>, o: ActOptions<T> = {}): Promise<T | undefined> {
  const busyId = o.busy ? newOpId() : null;
  const startedAt = Date.now();
  if (busyId) startBusy(busyId, o.busy!);
  try {
    const r = await fn();
    const msg = typeof o.success === "function" ? o.success(r) : o.success;
    if (msg) toast.success(msg);
    return r;
  } catch (e) {
    if (isGitError(e) && e.kind === "identity") {
      if (await identityDialog(root)) return act(root, fn, o);
      o.onError?.(e);
      return undefined;
    }
    o.onError?.(e);
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
    if (o.refresh !== false) {
      // The operation's own completion refresh usually started already: share it.
      const parts = o.refresh ?? ALL, since = operationChangeTime(root, startedAt);
      await refreshUntilShown(root, { info: parts.info, status: parts.status, layers: parts.layers }, since);
      if (parts.refs || parts.graph) void useRepos.getState().refresh(root, { refs: parts.refs, graph: parts.graph, info: parts.info }, { since });
    }
  }
}

/** Cancel for one fetch, pull or push (by its operation id): stops its Git transfer, or ends it before it starts when it is still queued. */
const cancelTransfer = (opId: string) => () => void api.cancelTransfer(opId).catch(() => undefined);

/** Errors every fetch, pull and push can end with. Returns false for the caller's own cases.
 *  `sends`: the transfer uploads (Push, Push tag); the server may have accepted it before Cancel stopped Git. */
export function reportTransferError(root: string, e: unknown, label: string, remoteName?: string | null, sends = false): boolean {
  if (!isGitError(e)) return false;
  if (e.kind === "cancelled") {
    toast.info(`${label} cancelled`, sends
      ? "The server may already have received it before Git was stopped. Fetch to see what the server has now."
      : "Your branches and files were not changed.");
  } else if (e.kind === "auth") {
    recordError("Authentication failed", e);
    useUi.getState().toast({
      kind: "error",
      title: "Authentication failed — check your credentials or SSH key",
      detail: `${e.message}\nYour saved sign-in was kept. To sign in with another account, forget it first.`,
      action: { label: "Forget saved login", run: () => void forgetSavedLogin(root, remoteName ?? null) },
    });
  } else if (e.kind === "network-stalled") {
    toast.error(e, `${label} stopped: the server is not responding`);
  } else if (e.kind === "partial-fetch") {
    toast.warning(`${label}: some remotes could not be fetched`, e.message);
  } else return false;
  return true;
}

/** Forget saved login: drops the saved sign-in for one remote (or every HTTPS remote) after asking. */
export async function forgetSavedLogin(root: string, remoteName: string | null) {
  const remotes = getTab(root)?.refs?.remotes ?? [];
  const web = remotes.filter((r) => /^https?:\/\//i.test(r.fetchUrl) || /^https?:\/\//i.test(r.pushUrl));
  const names = remoteName ? [remoteName] : web.map((r) => r.name);
  if (!names.length) {
    toast.info("No saved sign-in to forget", "These remotes use SSH. Manage SSH keys in Git connection settings.");
    return;
  }
  const ok = await confirmDialog({
    title: "Forget saved login?",
    message: `Git forgets the saved sign-in for ${names.join(", ")}. It applies to every repository on the same server. The next fetch, pull or push asks you to sign in again.`,
    confirm: "Forget saved login",
  });
  if (!ok) return;
  try {
    for (const name of names) await api.forgetSavedLogin(root, name);
    toast.success("Saved sign-in forgotten", "Fetch, pull or push to sign in again.");
  } catch (e) {
    toast.error(e, "Could not forget the saved sign-in");
  }
}

/** After a fetch: offer to take the server's version of tags that moved there. */
async function offerMovedTags(root: string) {
  let tags: string[];
  try {
    tags = await api.movedTags(root);
  } catch {
    return;
  }
  if (!tags.length) return;
  const shown = tags.length > 5 ? `${tags.slice(0, 5).join(", ")} and ${tags.length - 5} more` : tags.join(", ");
  useUi.getState().toast({
    kind: "warning",
    title: `${plural(tags.length, "tag")} changed on the server`,
    detail: `Your local versions were kept: ${shown}. Update them to use the server's versions; the old targets stay in the tags' reflogs.`,
    action: { label: "Update moved tags", run: () => void updateMovedTags(root) },
  }, 20000);
}

export async function updateMovedTags(root: string) {
  await remote(root, "Updating moved tags", (id) => api.updateMovedTags(root, id), () => "Moved tags updated");
}

const warnedCredentialManager = new Set<string>();

/** Bitbucket Cloud refuses OAuth sign-in from Git Credential Manager older than 3.0.0 from November 30, 2026.
 *  Warn once per session, only where GCM can be the one signing in: an HTTPS bitbucket.org remote, GCM configured
 *  and older, and no token of Revqora's own answering first. SSH, API tokens and app passwords are not affected. */
async function warnOutdatedCredentialManager(root: string, remoteName?: string | null) {
  const remotes = (getTab(root)?.refs?.remotes ?? []).filter((r) => !remoteName || r.name === remoteName);
  if (warnedCredentialManager.has("bitbucket") || !remotes.some((r) => bitbucketHttps(r.fetchUrl) || bitbucketHttps(r.pushUrl))) return;
  try {
    const gcm = await api.credentialManager(root);
    if (gcm?.outdated && !gcm.revqoraToken && !warnedCredentialManager.has("bitbucket")) {
      warnedCredentialManager.add("bitbucket");
      toast.warning("Update Git Credential Manager",
        `From November 30, 2026 Bitbucket stops accepting OAuth (browser) sign-in from Git Credential Manager older than ${gcm.minVersion}. Installed: ${gcm.version}. This matters only if you sign in to Bitbucket through Git Credential Manager with OAuth; SSH keys, API tokens and app passwords keep working. Update Git for Windows (it includes Git Credential Manager) or Git Credential Manager itself.`);
    }
  } catch {
    // Asked again after the next transfer.
  }
}

async function remote<T>(root: string, label: string, fn: (opId: string) => Promise<T>, success?: (r: T) => string | null, remoteName?: string | null, sends = false): Promise<T | undefined> {
  const opId = newOpId();
  startBusy(opId, label, cancelTransfer(opId));
  try {
    const r = await fn(opId);
    const msg = success?.(r);
    if (msg) toast.success(msg);
    return r;
  } catch (e) {
    if (reportTransferError(root, e, label, remoteName, sends)) return undefined;
    if (isGitError(e) && e.kind === "rejected") toast.error(e, "Push rejected — pull first or force push");
    else toast.error(e, `${label} failed`);
    return undefined;
  } finally {
    endBusy(opId);
    await refreshAfterOperation(root, opId);
    void warnOutdatedCredentialManager(root, remoteName);
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
      // Restoring set-aside changes can conflict after the operation itself finished: nothing is left to continue or abort.
      if ((st.tabs[root]?.info?.state.kind ?? "none") === "none") toast.warning(`${what}: ${plural(out.conflicts.length, "conflict")} in your restored changes`, out.message.trim() || "Resolve the conflicted files in the Changes view. A copy of your changes is kept in Stashes.");
      else toast.warning(`${what}: ${plural(out.conflicts.length, "conflict")}`, "Resolve them in the Changes view, then continue — or abort to roll everything back.");
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
    if (isGitError(e) && e.kind === "repository-folder-unavailable") {
      toast.warning("Repository folder unavailable", e.message);
    } else if (isGitError(e) && e.kind === "not-a-repo") {
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
  const dirs = await openFolder({ directory: true, multiple: true, title: "Open Git repositories" });
  await Promise.all((typeof dirs === "string" ? [dirs] : dirs ?? []).map(openRepoPath));
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
    const result = await api.repoClone(r.parent, r.url, r.name, opId,r.connection, r.options);
    await useRepos.getState().open(result.root);
    toast.success(`Cloned ${r.name}`);
    if(result.connectionWarning)toast.warning("Authentication settings need attention",result.connectionWarning);
  } catch (e) {
    toast.error(e, "Clone failed");
  } finally {
    endBusy(opId);
  }
}

// ───────────── remotes ─────────────

async function fetchRemotes(root: string, name: string | null, prune = true) {
  const out = await remote(root, name ? `Fetching ${name}` : "Fetching", (id) => api.fetch(root, name, prune, id),
    () => name ? `Fetched ${name}` : "Fetched from all remotes", name);
  useRepos.getState().patch(root, out !== undefined ? { lastFetchedAt: Date.now(), fetchError: null } : { fetchError: "Fetch failed. Try Fetch again to sign in or see the error." });
  if (out !== undefined) void offerMovedTags(root);
  return out;
}

export const fetchAll = (root: string, prune?: boolean) => fetchRemotes(root, null, prune);
export const fetchRemote = (root: string, name: string) => fetchRemotes(root, name);

type PullTarget = { branch: string; upstream: string };

export async function pullBranch(root: string, target: PullTarget) {
  try {
    const status = await api.status(root);
    if (status.branch !== target.branch) {
      if (!status.stateToken || !await confirmDialog({
        title: `Check out and pull ${target.branch}?`,
        message: `Switch to ${target.branch} and pull from ${target.upstream}.`,
        confirm: "Check out and Pull",
      })) return;
      if (await checkout(root, target.branch, "local", status.stateToken) !== target.branch) return;
    }
    await pull(root, undefined, undefined, undefined, target);
  } catch (error) {
    toast.error(error, "Could not prepare branch pull");
  }
}

export async function pull(root: string, modeOverride?: "ff-only" | "merge" | "rebase", expectedState?: string, pruneRemote?: boolean, target?: PullTarget) {
  const mode = modeOverride ?? useSettings.getState().pullMode;
  const opId = newOpId();
  startBusy(opId, "Pulling", cancelTransfer(opId));
  let diverged = false;
  let outcome: PullOutcome | undefined;
  try {
    if (target) {
      const status = await api.status(root);
      if (status.branch !== target.branch || status.upstream !== target.upstream || !status.stateToken) {
        toast.warning("Branch or upstream changed", "Review the branch and try Pull again.");
        return;
      }
      expectedState = status.stateToken;
    }
    outcome = await api.pull(root, mode, opId, expectedState, pruneRemote);
  } catch (e) {
    const msg = errorMessage(e).toLowerCase();
    // The collision dialog already listed the paths; the user cancelled and nothing changed.
    if (isGitError(e) && e.kind === "ignored-collision" && (e as { declined?: boolean }).declined) toast.info("Pull cancelled", "Your local files were kept.");
    else if (isGitError(e) && e.kind === "ignored-collision") toast.error(e, "Pull stopped to protect local files");
    else if (isGitError(e) && e.kind === "partial-operation") toast.error(e, "Pull partially completed — review the repository and submodules");
    else if (mode === "ff-only" && ((isGitError(e) && e.kind === "diverged") || msg.includes("not possible to fast-forward") || msg.includes("diverg"))) diverged = true;
    else if (reportTransferError(root, e, "Pull", target?.upstream.split("/")[0] ?? null)) { /* reported */ }
    else toast.error(e, "Pull failed");
  } finally {
    endBusy(opId);
    await refreshAfterOperation(root, opId);
    void warnOutdatedCredentialManager(root, target?.upstream.split("/")[0] ?? null);
  }
  if (outcome) {
    if (outcome.status === "upstreamGone" && outcome.upstreamGone) {
      const gone = outcome.upstreamGone;
      useUi.getState().toast({kind:"info",title:"Upstream unavailable; repository refreshed",detail:outcome.message,
        action:gone.defaultBranch?{label:`Continue on ${gone.defaultBranch}`,run:()=>void continueAfterDeletedUpstream(root,gone)}:{label:"Choose upstream",run:()=>void setUpstream(root,gone.branch)}},20000);
    }
    else if (["done", "upToDate", "fastForward"].includes(outcome.status)) toast.success("Pulled", outcome.message);
    else handleOutcome(root, outcome, "Pull");
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
    if (how) await pull(root, how, undefined, pruneRemote, target);
  }
}

async function continueAfterDeletedUpstream(root:string,gone:NonNullable<PullOutcome["upstreamGone"]>) {
  try {
    const state=await api.status(root),refs=await api.refs(root),branch=gone.defaultBranch;
    if(state.branch!==gone.branch||!branch){toast.info("Current branch changed","Review the current branch before continuing.");return;}
    const remote=`${gone.remote}/${branch}`,local=refs.local.find(b=>b.name===branch);
    if(local&&local.upstream!==remote){
      await setUpstream(root,local.name);
      if((await api.refs(root)).local.find(b=>b.name===branch)?.upstream!==remote||(await api.status(root)).branch!==gone.branch)return;
    }
    if(!local&&!refs.remote.some(b=>b.name===remote)){toast.info("Choose an upstream",`The remote's default branch ${remote} is outside this repository's fetch settings.`);return;}
    if(await checkout(root,local?branch:remote,local?"local":"remote")!==undefined)await pull(root,"ff-only");
  }catch(e){toast.error(e,"Could not continue on the remote's default branch");}
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
  await remote(root, `Pushing ${branch}`, (id) => api.push(root, opts, id, status?.stateToken), () => `Pushed ${branch}`, opts.remote ?? null, true);
}

/** One-click push used after committing; asks only when needed. */
export async function quickPush(root: string) {
  const tab = getTab(root);
  if (tab?.status?.upstream && tab.status.behind === 0) {
    await remote(root, "Pushing", (id) => api.push(root, {}, id), () => "Pushed", null, true);
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

const switching = new Set<string>();

export async function checkout(root: string, target: string, kind: "local" | "remote" | "commit", expectedState?: string) {
  const result = await checkoutWithOutcome(root, target, kind, expectedState);
  if (result.status === "succeeded" && !result.switch.conflicts.length && !result.switch.warning) return result.switch.branch;
}

type CheckoutResult =
  | { status: "succeeded"; switch: Extract<SwitchOutcome, {status:"switched"}> }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

export async function checkoutWithOutcome(
  root: string, target: string, kind: "local" | "remote" | "commit", expectedState?: string, authorize?: () => Promise<boolean>, dirtyChoice?: SwitchChoice["action"],
): Promise<CheckoutResult> {
  if (switching.has(root)) return {status:"failed",error:new Error("A branch switch is already in progress.")};
  switching.add(root);
  try {
    let failure: unknown;
    const onError = (error: unknown) => { failure = error; };
    // The operation client already refreshes HEAD and status before returning.
    let result = await act(root, () => api.checkout(root, target, kind, undefined, expectedState), { busy: "Switching branch", refresh: false, onError });
    if (result?.status === "review") {
      const review = result;
      const source = review.source.startsWith("HEAD/") ? `detached HEAD (${shortOid(review.source.slice(5))})` : review.source.slice(11);
      const action = dirtyChoice ?? await showDialog<SwitchChoice["action"] | null>((close) => <Modal
        title="Switch with uncommitted changes" subtitle={`${source} → ${target}`} onClose={() => close(null)}
        footer={<>
          <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
          <button type="button" className="btn" onClick={() => close("move")}>Move changes</button>
          <button type="button" className="btn primary" onClick={() => close("stash")}>Stash and switch</button>
        </>}
      >
        <p>You have changes in {review.files} {review.files === 1 ? "file" : "files"}, including any new untracked files.</p>
        <p><b>Stash and switch</b> saves the changes for {source}. Restore them when you return.</p>
        <p><b>Move changes</b> applies them on {target}. If there are conflicts, resolve them in Changes. The stash stays available until the move succeeds.</p>
      </Modal>);
      if (!action || !getTab(root) || authorize && !await authorize()) return {status:"cancelled"};
      result = await act(root, () => api.checkout(root, target, kind, { action, targetOid: review.targetOid }, review.stateToken), {
        busy: action === "move" ? "Moving changes" : "Stashing and switching",
        refresh: false,
        onError,
      });
    }
    const repos = useRepos.getState();
    if (result?.status === "switched" && kind !== "commit") {
      const tab = repos.tabs[root];
      repos.patch(root, { selected: null, multi: [], historyJump: null, ...(tab ? historyAfterSwitch(tab, result.branch, kind, target) : {}) });
    }
    void repos.refresh(root, { refs: true, graph: true, layers: true });
    if (result?.status !== "switched") return {status:"failed",error:failure ?? new Error("The branch switch did not finish.")};
    if (result.conflicts.length) {
      showStashConflicts(root, result.conflicts);
      return {status:"succeeded",switch:result};
    }
    const label = kind === "commit" ? `Checked out ${shortOid(target)} (detached HEAD)` : `Switched to ${result.branch}`;
    if (result.warning) {
      toast.warning(label, result.warning);
      return {status:"succeeded",switch:result};
    }
    toast.success(label, result.moved ? "Changes moved to this branch." : result.saved ? "Changes saved for the source branch." : undefined);
    return {status:"succeeded",switch:result};
  } finally {
    switching.delete(root);
  }
}

export async function createBranch(root: string, start: string | null, startLabel: string) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const r = await createBranchDialog(startLabel);
  if (!r) return;
  await act(root, () => api.branchCreate(root, r.name, start, r.checkout, expectedState), { success: `Branch ${r.name} created` });
}

export async function renameBranch(root: string, name: string) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const v = await promptDialog({ title: `Rename ${name}`, label: "New name", initial: name, validate: validBranchName, confirm: "Rename" });
  if (!v || v === name) return;
  await act(root, () => api.branchRename(root, name, v.trim(), expectedState), { success: `Renamed to ${v.trim()}` });
}

export async function deleteBranch(root: string, name: string, protectionRules?: string[]) {
  await deleteBranchWithOutcome(root, name, {protectionRules});
}

export async function deleteBranchWithOutcome(root: string, name: string, options: {
  expectedState?: string; localOnly?: boolean; protectionRules?: string[]; authorize?: () => Promise<boolean>;
}): Promise<DeleteBranchOutcome> {
  try {
    const expectedState = options.expectedState ?? await prepareOperation(root);
    if (!expectedState) return {status:"failed",error:new Error("The repository state could not be prepared for deletion.")};
    const targets = options.localOnly ? [] : await api.branchDeleteTargets(root, name);
    return await showDialog<DeleteBranchOutcome>(close => <DeleteBranchDialog expectedState={expectedState} root={root} name={name}
      targets={targets} protectionRules={options.protectionRules} authorize={options.authorize} onClose={close} />);
  } catch (e) {
    toast.error(e);
    return {status:"failed",error:e};
  }
}

export async function deleteRemoteBranch(root: string, remoteBranch: string, protectionRules?: string[]) {
  try {
    const expectedState = await prepareOperation(root);
    if (!expectedState) return;
    const target = await api.branchDeleteRemoteTarget(root, `refs/remotes/${remoteBranch}`);
    const name = target.remoteRef.slice("refs/heads/".length);
    await showDialog<void>((close) => <DeleteBranchDialog expectedState={expectedState} root={root} name={name} targets={[target]} remoteOnly protectionRules={protectionRules} onClose={() => close()} />);
  } catch (e) { toast.error(e); }
}

export async function setUpstream(root: string, branch: string) {
  const tab = getTab(root);
  const candidates = tab?.refs?.remote.map((r) => r.name) ?? [];
  const v = await promptDialog({ title: `Upstream for ${branch}`, label: "Remote branch", initial: candidates.find((c) => c.endsWith("/" + branch)) ?? candidates[0] ?? "origin/" + branch, help: "Leave as is to track the matching remote branch." });
  if (!v) return;
  await act(root, () => api.branchSetUpstream(root, branch, v.trim()), { success: `${branch} now tracks ${v.trim()}` });
}

/** `label` names the target in dialogs when `target` is a fully qualified ref or an id. */
export async function mergeInto(root: string, target: string, label = target) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const tab = getTab(root);
  const current = tab?.info?.head.branch ?? "HEAD";
  const strategy = await mergeDialog(label, current);
  if (!strategy) return;
  const out = await act(root, () => api.mergeStart(root, target, strategy, expectedState), { busy: `Merging ${label}` });
  handleOutcome(root, out, "Merge");
}

export async function rebaseOnto(root: string, target: string, label = target) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const tab = getTab(root);
  const current = tab?.info?.head.branch ?? "HEAD";
  // A plain rebase drops merge commits; ask what to do when the branch has some.
  let merges: number;
  try {
    merges = await api.rebaseMergeCount(root, target);
  } catch (e) {
    toast.error(e, "Could not inspect the commits to rebase");
    return;
  }
  let keepMerges = false;
  if (merges > 0) {
    const choice = await rebaseMergesDialog(current, label, merges);
    if (!choice) return;
    keepMerges = choice === "keep";
  } else {
    const ok = await confirmDialog({ title: `Rebase ${current} onto ${label}?`, message: "Your commits are replayed on top of the target. Commits get new hashes; avoid this for branches others already use.", confirm: "Rebase" });
    if (!ok) return;
  }
  const out = await act(root, () => api.rebaseOnto(root, target, expectedState, keepMerges), { busy: "Rebasing" });
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
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const tab = getTab(root);
  const mode = await resetDialog(tab?.info?.head.branch ?? "HEAD", oid, subject);
  if (!mode) return;
  await act(root, () => api.reset(root, oid, mode, expectedState), { success: `Reset to ${shortOid(oid)}` });
}

export async function reword(root: string, oid: string) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const details = await api.commitDetails(root, oid).catch(() => null);
  const current = details ? (details.body ? `${details.subject}\n\n${details.body}` : details.subject) : "";
  const msg = await promptDialog({ title: "Edit commit message", initial: current, multiline: true, confirm: "Save message", help: "Ctrl+Enter to save. Commits after this one are re-created." });
  if (!msg || msg === current) return;
  const out = await act(root, () => api.rewrite(root, { action: "reword", oid, message: msg }, expectedState), { busy: "Rewriting history" });
  if (out && out.status !== "done") handleOutcome(root, out, "Edit message");
  else if (out) toast.success("Commit message updated");
}

export async function dropCommits(root: string, oids: string[]) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const ok = await confirmDialog({
    title: oids.length === 1 ? "Drop this commit?" : `Drop ${oids.length} commits?`,
    message: "The commit is removed from the branch history and its changes disappear. You can get it back from the reflog.",
    confirm: "Drop",
    danger: true,
  });
  if (!ok) return;
  const out = await act(root, () => api.rewrite(root, { action: "drop", oids }, expectedState), { busy: "Rewriting history" });
  if (out && out.status !== "done") handleOutcome(root, out, "Drop");
  else if (out) toast.success("Dropped");
}

export async function squashCommits(root: string, oids: string[], subjects: string[]) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const msg = await promptDialog({ title: `Squash ${oids.length} commits`, initial: subjects.join("\n"), multiline: true, confirm: "Squash", help: "The combined commit gets this message." });
  if (!msg) return;
  const out = await act(root, () => api.rewrite(root, { action: "squash", oids, message: msg }, expectedState), { busy: "Squashing" });
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
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const r = await tagDialog(oid);
  if (!r) return;
  await act(root, () => api.tagCreate(root, r.name, oid, r.message || null, expectedState), { success: `Tag ${r.name} created` });
}

export async function deleteTag(root: string, name: string) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const ok = await confirmDialog({ title: `Delete tag ${name}?`, confirm: "Delete", danger: true });
  if (ok) await act(root, () => api.tagDelete(root, name, expectedState), { success: `Deleted tag ${name}` });
}

export async function pushTag(root: string, name: string) {
  const r = getTab(root)?.refs?.remotes[0]?.name ?? "origin";
  await remote(root, `Pushing tag ${name}`, (id) => api.pushRef(root, r, `refs/tags/${name}`, id), () => `Pushed tag ${name}`, r, true);
}

// ───────────── stash ─────────────

export async function stash(root: string, expectedState?: string) {
  const r = await stashDialog();
  if (!r) return;
  await act(root, () => api.stashSave(root, r.message, r.untracked, r.keepIndex, undefined, expectedState), { success: "Changes stashed" });
}

export async function stashApply(root: string, index: number, pop: boolean, oid = getTab(root)?.refs?.stashes.find(s => s.index === index)?.oid) {
  if (!oid) return toast.warning("Stash unavailable", "Refresh the stash list before trying again.");
  const out = await act(root, () => api.stashApply(root, index, pop, oid));
  if (out?.status === "conflicts") showStashConflicts(root, out.conflicts);
  else if (out?.status === "index_not_restored") {
    const rows = out.staging ?? [];
    await showDialog<void>(close => <Modal title="Stash applied with different staging" tone="warn" wide onClose={() => close()}
      footer={<button type="button" className="btn primary" onClick={() => close()}>Done</button>}>
      <p>{out.message}</p>
      {out.staging === null ? <p>Open Changes to inspect the current index.</p> : rows.length > 0 ? <ul>
        {rows.map(row => <li key={row.path}><code>{row.path}</code> · {row.currentlyStaged ? "currently staged" : "outside staging"} · {row.matchesSavedIndex ? "matches the saved index" : "differs from the saved index"}</li>)}
      </ul> : <p>This stash had no staged paths.</p>}
    </Modal>);
  }
  else if (out) toast.success(pop ? "Stash popped" : "Stash applied");
}

function showStashConflicts(root: string, conflicts: string[]) {
  useRepos.getState().patch(root, { view: "changes", changeSel: conflicts[0] ? { kind: "conflict", path: conflicts[0] } : null });
  toast.warning("Stash has conflicts", "Resolve them on the current branch in Changes. The stash is still available.");
}

export async function stashDrop(root: string, index: number, oid = getTab(root)?.refs?.stashes.find(s => s.index === index)?.oid) {
  if (!oid) return toast.warning("Stash unavailable", "Refresh the stash list before trying again.");
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const ok = await confirmDialog({ title: "Delete this stash?", confirm: "Delete", danger: true });
  if (ok) await act(root, () => api.stashDrop(root, index, oid, expectedState), { success: "Stash deleted" });
}

// ───────────── in-progress operations ─────────────

function offerStudioResult(root: string, out: OpOutcome | undefined) {
  if (!out?.studioSession) return;
  const id = out.studioSession;
  useUi.getState().toast({ kind: out.studioWarning ? "warning" : "info", title: "Rebase Studio result available", detail: out.studioWarning ?? "Compare the saved before/after snapshots or open recovery.", action: { label: "Review result", run: () => { void import("../components/RebaseResult").then((m) => m.rebaseResultDialog(root, id)); } } }, 20000);
}

export async function abortOp(root: string, kind: string) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const what = kind === "merge" || kind === "squash" ? "merge" : kind;
  const ok = await confirmDialog({ title: `Abort ${what}?`, message: "Git will return to the state before this operation. Current manual changes and staging will be checkpointed in Undo Center before aborting.", confirm: `Abort ${what}`, danger: true });
  if (!ok) return;
  const out = await act(root, () => api.opAbort(root, kind, expectedState), { success: `${what[0].toUpperCase() + what.slice(1)} aborted` });
  offerStudioResult(root, out);
}

export async function confirmMerge(root: string, kind: "merge" | "squash", message: string | null) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  const msg = await promptDialog({
    title: kind === "merge" ? "Confirm merge" : "Commit squashed changes",
    label: "Commit message",
    initial: readableMergeMessage(message ?? "").replace(/^#.*$/gm, "").trim(),
    multiline: true,
    confirm: kind === "merge" ? "Create merge commit" : "Commit",
  });
  if (!msg) return;
  const out = await act(root, () => api.opContinue(root, kind, msg, expectedState), { busy: "Committing" });
  if (out) toast.success(kind === "merge" ? "Merge committed" : "Squash committed");
}

export async function continueOp(root: string, kind: string) {
  const out = await act(root, () => api.opContinue(root, kind, null), { busy: "Continuing" });
  if (out && out.status !== "done") handleOutcome(root, out, kind[0].toUpperCase() + kind.slice(1));
  else if (out) { toast.success(`${kind[0].toUpperCase() + kind.slice(1)} complete`); offerStudioResult(root, out); }
}

export async function skipOp(root: string, kind: string) {
  const out = await act(root, () => api.opSkip(root, kind));
  if (out && out.status !== "done") handleOutcome(root, out, kind);
  else offerStudioResult(root, out);
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
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  if (useSettings.getState().confirmDiscard && !(await discardDialog([...tracked, ...untracked]))) return;
  await act(root, () => api.discard(root, tracked, untracked, expectedState), { success: "Changes discarded (backup kept)", refresh: { status: true, layers: true } });
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
