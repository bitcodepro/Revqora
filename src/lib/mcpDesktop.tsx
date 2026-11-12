import { useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, newOpId } from "./api";
import { McpToolError, mcpError } from "./mcpErrors";
import { mcpNeedsApproval, runAutomaticMcpAction, type McpActionOptions } from "./mcpAutomatic";
import { assertDiffVersion, conflictLine, conflictSidePage, diffPage, type DiffPageOptions } from "./mcpDiff";
import { loadBranchPreferences } from "./branchManager";
import { deletionProtection } from "./branchProtection";
import * as A from "./actions";
import { basename } from "./format";
import { useRepos } from "./store";
import { useSettings } from "./settings";
import { closeOverlay, openOverlay, showDialog, useUi } from "./ui";
import type { BranchInfo, McpApprovalMode, PrState, SearchMode, StageReview, StashInfo, StatusSummary } from "./types";
import { Modal } from "../components/Modal";
import { validBranchName } from "../components/dialogs";
import { createPullRequest } from "../components/PullRequests";
import { chooseReview } from "../components/PrReviews";
import { mergeDialog } from "../components/PrMerge";
import { syncRepositories } from "../components/SyncRepositories";
import { openWorkflowStepReview } from "../components/WorkflowBuilder";

type Arguments = McpActionOptions & DiffPageOptions & {
  repository?: string; oid?: string; path?: string; side?: string;
  scope?: string; query?: string; mode?: SearchMode | "all"; state?: PrState;
  section?: string; cursor?: string; revision?: string; fileId?: string;
  view?: string; id?: string; action?: string; paths?: string[];
  from?: string; to?: string; feed?: string;
};
interface DesktopRequest {
  id: string;
  session: string;
  request: { name: string; arguments: Arguments };
}
type Phase = "preparing" | "awaiting_confirmation" | "running" | "waiting_for_resolution" | "cancelled" | "succeeded" | "partial" | "handed_off" | "failed";
interface ActionStatus {
  id: string; session: string; root: string; action: string; phase: Phase; message?: string; errorCode?: string;
  approval?: "manual" | "automatic"; reason?: string; conflicts?: string[]; commit?: string; runId?: string; result?: Record<string, unknown>;
}
const actions = new Map<string, ActionStatus>();
let activeAction: string | null = null;

const cancellationMessages: Record<string, string> = {
  user_declined: "The person in Revqora declined this request.",
  dialog_dismissed: "The review was closed before approval.",
  approval_timed_out: "The review expired before approval.",
  session_expired: "The MCP session ended before the operation could run.",
  cherry_pick_aborted: "The cherry-pick was aborted in Revqora.",
  cherry_pick_skipped: "The cherry-pick was skipped in Revqora.",
};

function cancelAction(status: ActionStatus, reason: string) {
  status.phase = "cancelled";
  status.reason = reason;
  status.message = cancellationMessages[reason];
}

function permittedRoots() {
  const { order, tabs } = useRepos.getState();
  return order.filter(root => !!tabs[root]?.info);
}

function requireRepo(root?: string) {
  if (!root || !permittedRoots().includes(root)) throw new McpToolError("repository_not_open", "Choose an open repository from list_repositories.");
  return root;
}

const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
function exactCommit(oid?: string) {
  if (!oid || !oidPattern.test(oid)) throw new McpToolError("invalid_commit", "Supply the full commit hash.");
  return oid.toLowerCase();
}

function page<T>(items: T[], offset = 0, size = 100) {
  return { items: items.slice(offset, offset + size), total: items.length, nextOffset: offset + size < items.length ? offset + size : null };
}

async function prContext(root: string, number: number) {
  const forge = await api.forgeInfo(root);
  const connection = forge?.connectionRevision;
  if (!forge || !connection) throw new McpToolError("pr_connection_required", "Choose an API account and remote in Revqora's PR Center first.");
  return { root, forge, connection, detail: await api.prDetail(root, number, connection) };
}

async function pullRequest(root: string, a: Arguments) {
  const number = a.number!;
  const { connection, detail } = await prContext(root, number);
  const { revision } = detail;
  if (a.revision && a.revision !== revision) throw new McpToolError(a.section === "diff" && a.diffVersion ? "diff_changed" : "stale_state", "The PR changed. Read its files or overview again.");
  switch (a.section) {
    case "files": return { revision, ...await api.prFiles(root, number, connection, revision, a.offset ?? 0) };
    case "diff": {
      if (!a.revision || !a.fileId) throw new McpToolError("invalid_arguments", "Supply fileId and revision from the files section.");
      const { diff, notice } = await api.prFile(root, number, connection, revision, a.fileId);
      if (!diff && a.diffVersion) throw new McpToolError("diff_changed", "The provider diff is unavailable. Start again from the PR files.");
      return { revision, notice, diff: diff ? diffPage(diff, a) : null };
    }
    case "discussions": return { revision, ...await api.prReviewPage(root, number, connection, revision, a.feed ?? "threads", a.cursor) };
    case "checks": return { revision, checks: await api.prChecks(root, number, connection, revision) };
    default: return detail;
  }
}

function navigate(root: string, view: string) {
  if (useUi.getState().dialogs.length) throw new McpToolError("review_pending", "Finish the open Revqora dialog before changing views.");
  useRepos.getState().activate(root);
  switch (view) {
    case "history": case "changes": case "pull_requests":
      closeOverlay();
      useRepos.getState().patch(root, { view: view === "pull_requests" ? "pulls" : view });
      break;
    case "branches": case "worktrees": case "workflows": case "agents":
      openOverlay({ kind: view, root });
      break;
  }
  return { repository: root, view };
}

const actionNames: Record<string, string> = {
  stage: "Stage files", unstage: "Unstage files", commit: "Commit staged changes", create_branch: "Create branch",
  checkout: "Switch branch", delete_branch: "Review branch deletion", cherry_pick: "Cherry-pick commit", stash: "Open stash dialog",
  stash_apply: "Apply stash", stash_pop: "Pop stash", stash_drop: "Delete stash",
  cherry_pick_continue: "Continue cherry-pick", cherry_pick_abort: "Abort cherry-pick",
  fetch: "Fetch from all remotes", pull: "Pull current branch", push: "Open push review", sync: "Open Sync review",
  create_pr: "Open PR creation", review_pr: "Open PR review", merge_pr: "Open PR merge review", pr_workflow: "Open PR workflow",
  start_workflow: "Create waiting workflow run", review_workflow_step: "Open workflow step review",
};

interface ApprovalField { label: string; initial: string; multiline?: boolean; validate: (value: string) => string | null }
type ApprovalResult = { value: string } | { reason: "user_declined" | "dialog_dismissed" | "approval_timed_out" };

function Approval({ action, description, details, field, close }: {
  action: string; description: string; details: string[]; field?: ApprovalField; close: (approved: ApprovalResult | null) => void;
}) {
  const [value, setValue] = useState(field?.initial ?? "");
  const error = field?.validate(value);
  return <Modal title={`MCP request · ${action}`} subtitle={description} wide onClose={() => close({reason:"dialog_dismissed"})} onSubmit={() => { if (!error) close({value}); }}
    footer={<><button className="btn" type="button" onClick={() => close({reason:"user_declined"})}>Decline</button>
      <button className="btn primary" type="submit" disabled={!!error}>Approve in Revqora</button></>}>
    <p className="muted">A local MCP client requested this action. This approval applies to this request only.</p>
    {field && <>
      <label className="field">{field.label}
        {field.multiline ? <textarea className="textarea mono" rows={5} value={value} onChange={e => setValue(e.target.value)}/>
          : <input className="input" value={value} onChange={e => setValue(e.target.value)}/>}
      </label>
      {error && <span className="red" role="alert">{error}</span>}
    </>}
    {details.length > 0 && <pre className="code-list">{details.join("\n")}</pre>}
  </Modal>;
}

const branchActions = new Set(["create_branch", "checkout", "delete_branch"]);
interface BranchReview {
  baseline: StatusSummary;
  branches: BranchInfo[];
  tip?: string;
  start?: { oid: string; branch?: string };
}

function branchNameError(value: string) {
  if (!value || value.trim() !== value || new TextEncoder().encode(value).length > 512) return "Supply a valid local branch name.";
  if (value === "@" || /[\x00-\x20\x7f]/.test(value) || value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    return "This name is not a valid Git branch.";
  }
  return validBranchName(value);
}

function duplicateBranch(root: string, name: string, branches: BranchInfo[]) {
  const windowsPath = /^[a-z]:[\\/]|^[\\/]{2}/i.test(root);
  const normalize = (value: string) => windowsPath ? value.toLowerCase() : value;
  const candidate = normalize(name);
  return branches.find(branch => {
    const current = normalize(branch.name);
    return current === candidate || current.startsWith(candidate + "/") || candidate.startsWith(current + "/");
  });
}

async function reviewBranchAction(root: string, action: string, target?: string, base?: string): Promise<BranchReview> {
  const invalid = branchNameError(target ?? "");
  if (!target || invalid) throw new McpToolError("invalid_arguments", invalid ?? "Supply a local branch name.");
  const baseline = await api.status(root);
  if (!baseline.oid && (action !== "create_branch" || !base)) {
    throw new McpToolError("initial_commit_required", `Create the first commit on ${baseline.branch ?? "the current branch"} before using this Git branch action.`);
  }
  const { local: branches } = await api.refs(root);
  if (action === "create_branch") {
    const existing = duplicateBranch(root, target, branches);
    if (existing) throw new McpToolError("branch_exists", `The name conflicts with local branch ${existing.name}.`);
    if (!base) return { baseline, branches, start: { oid: baseline.oid! } };
    if (oidPattern.test(base)) {
      const oid = exactCommit(base);
      await api.verifyCommit(root, oid);
      return { baseline, branches, start: { oid } };
    }
    const name = base.startsWith("refs/heads/") ? base.slice("refs/heads/".length) : base;
    if (branchNameError(name)) throw new McpToolError("invalid_arguments", "Base must be a local branch name or a full commit SHA.");
    const oid = branches.find(branch => branch.name === name)?.oid;
    if (!oid) throw new McpToolError("branch_not_found", `Base branch ${name} does not exist.`);
    return { baseline, branches, start: { oid, branch: name } };
  }
  const tip = branches.find(branch => branch.name === target)?.oid;
  if (!tip) throw new McpToolError("branch_not_found", "The local branch does not exist.");
  if (action === "delete_branch") {
    if (target === baseline.branch) throw new McpToolError("branch_checked_out", "Switch away from this branch before deleting it.");
    const protectedReason = deletionProtection(loadBranchPreferences(root).protections, target, null);
    if (protectedReason) throw new McpToolError("branch_protected", protectedReason);
  }
  return {baseline,branches,tip};
}

interface PickReview { baseline: StatusSummary; incoming: string }

async function reviewPendingPick(root: string, action: string): Promise<PickReview> {
  const [baseline, info] = await Promise.all([api.status(root), api.repoInfo(root)]);
  if (info.state.kind !== "cherry-pick" || !info.state.incoming) throw new McpToolError("no_cherry_pick", "There is no cherry-pick to continue or abort.");
  if (action === "cherry_pick_continue" && baseline.conflictCount) {
    throw new McpToolError("unresolved_conflicts", "Resolve and stage the remaining conflict files before continuing the cherry-pick.");
  }
  return { baseline, incoming: info.state.incoming };
}

interface PathReview { baseline: StatusSummary; paths: string[]; stageReview?: StageReview }
interface PreparedAction {
  branch?: BranchReview;
  pendingPick?: PickReview;
  paths?: PathReview;
  stash?: StashInfo;
  pickOid?: string;
}

async function reviewPaths(root: string, action: "stage" | "unstage", paths: string[]): Promise<PathReview> {
  const baseline = await api.status(root, action === "unstage");
  const files = new Map(baseline.files.map(file => [file.path, file]));
  const renamed = new Map(baseline.files.filter(file => file.index === "R" && file.origPath).map(file => [file.origPath!, file]));
  const selected = new Set<string>();
  const proofs: [string, string][] = [];
  for (const path of new Set(paths)) {
    const file = (action === "unstage" ? renamed.get(path) : undefined) ?? files.get(path);
    if (!file) throw new McpToolError("file_not_found", `Path is not listed in repository_status: ${path}`);
    const eligible = action === "stage" ? file.untracked || file.worktree !== "." : !file.conflict && !file.untracked && file.index !== ".";
    if (!eligible) {
      throw new McpToolError("file_not_eligible", `Path is not eligible for ${action}: ${path}`);
    }
    selected.add(file.path);
    if (action === "stage") {
      if (!file.diffToken || file.path.endsWith("/")) throw new McpToolError("invalid_arguments", "Choose exact file paths from repository_status.");
      proofs.push([file.path, file.diffToken]);
    } else if (file.index === "R" && file.origPath) {
      selected.add(file.origPath);
    }
  }
  if (action === "unstage") return { baseline, paths: [...selected] };
  const { kind, incoming, step, stoppedAt } = (await api.repoInfo(root)).state;
  return { baseline, paths: [...selected], stageReview: { branch: baseline.branch, oid: baseline.oid,
    operation: { kind, incoming, step, stoppedAt }, files: Object.fromEntries(proofs) } };
}

async function reviewStash(root: string, index: number, oid: string): Promise<StashInfo> {
  const stash = (await api.stashList(root)).find(item => item.index === index && item.oid === oid);
  if (!stash) throw new McpToolError("stale_state", "The stash changed. Read list_stashes again.");
  return stash;
}

async function runAction(event: DesktopRequest, root: string, a: Arguments, status: ActionStatus, mode: McpApprovalMode, prepared: PreparedAction) {
  const action = status.action;
  const { branch: branchReview, pendingPick: pickReview, stash, pickOid } = prepared;
  try {
    const pathReview = action === "unstage" ? await reviewPaths(root, action, a.paths!) : prepared.paths;
    let target = stash?.oid ?? pickOid ?? a.target;
    const number = a.number;
    const title = actionNames[action];
    const detail: string[] = [];
    if (action === "commit" && !a.message?.trim()) throw new Error("Supply a commit message.");
    if (target && action !== "create_branch") detail.push(`Target: ${target}`);
    if (number) detail.push(`Pull request #${number}`);
    const paths = pathReview?.paths ?? [];
    const stageReview = pathReview?.stageReview;
    const baseline = branchReview?.baseline ?? pickReview?.baseline ?? pathReview?.baseline ?? await api.status(root, action === "commit");
    const expectedState = baseline.stateToken;
    if (!expectedState) throw new Error("Repository status is not ready. Refresh and inspect it first.");
    const pullMode = useSettings.getState().pullMode;
    if (action === "pull") detail.push(`Upstream: ${baseline.upstream ?? "none configured"}`, `Pull mode: ${pullMode}`);
    if ((action === "pull" || action === "fetch") && a.prune) detail.push("Prune references removed from the remote.");
    if (action === "push" && a.force) detail.push("Force push with lease may replace remote history.");
    if (action === "cherry_pick" && (baseline.conflictCount || (await api.repoInfo(root)).state.kind !== "none")) {
      throw new McpToolError("operation_in_progress", "Finish the current Git operation before cherry-picking another commit.");
    }
    if (pickReview) {
      detail.push(`Incoming commit: ${pickReview.incoming}`);
      if (action === "cherry_pick_abort") detail.push("Git will return to the state before this cherry-pick.");
    }
    detail.push(...paths);
    if (action === "stage" && baseline.files.some(file => file.conflict && paths.includes(file.path))) {
      detail.push("Staging conflicted paths marks their working versions as resolved.");
    }
    if (stash) {
      detail.push(`stash@{${stash.index}} · ${stash.message}`);
      if (action === "stash_drop") detail.push("Delete the stash without applying it. Revqora saves a recovery checkpoint.");
      else {
        detail.push(a.restoreIndex === false ? "Restore working changes only." : "Restore working changes and the saved index.");
        if (action === "stash_pop") detail.push("Remove the stash after successful application.");
      }
    }
    if (action === "checkout" && a.dirtyAction) {
      detail.push(a.dirtyAction === "move" ? "If there are uncommitted changes, move them to the destination." : "If there are uncommitted changes, stash them for the source branch.");
    }
    const targetOid = branchReview?.tip;
    if (targetOid) detail.push(`Branch tip: ${targetOid}`);
    const deletionPlan = mode !== "ask" && action === "delete_branch" ? await api.branchDeletePlan(root, target!, undefined, null) : undefined;
    if (deletionPlan) {
      if (deletionPlan.stateToken !== expectedState || deletionPlan.proof.localOid !== targetOid) throw new McpToolError("stale_state", "The branch changed while preparing deletion.");
      detail.push(`${deletionPlan.localUnmerged} commit(s) outside the comparison branch. Revqora saves a recovery checkpoint.`);
      if (a.force) detail.push("Force deletion is requested for this local branch.");
    }
    let field: ApprovalField | undefined;
    const start = branchReview?.start;
    if (start) {
      detail.push(`Starting commit: ${start.branch ? start.branch + " · " : ""}${start.oid}`);
      field = {label:"Branch name",initial:target!,validate:value=>{
        const error = branchNameError(value);
        if (error) return error;
        const existing = duplicateBranch(root, value, branchReview?.branches ?? []);
        return existing ? `The name conflicts with local branch ${existing.name}.` : null;
      }};
    }
    const pr = ["review_pr", "merge_pr", "pr_workflow"].includes(action) ? await prContext(root, number!) : null;
    if (pr && a.revision && a.revision !== pr.detail.revision) throw new McpToolError("stale_state", "The pull request changed. Read the current revision and submit a new request.");
    if (pr) detail.push(pr.detail.pull.title, `${pr.detail.pull.head} → ${pr.detail.pull.base} · ${pr.detail.pull.headSha}`);
    if (action === "commit") {
      const info = await api.repoInfo(root);
      if (info.state.kind !== "none" || baseline.conflictCount || !baseline.stagedCount) throw new Error("Stage changes and finish the current Git operation before committing.");
      const limit = useSettings.getState().largeFileMb;
      const large = await api.largeStagedFiles(root, limit * 1024 * 1024);
      detail.push(`${baseline.stagedCount} staged file(s)`);
      field = {label:"Commit message",initial:a.message!,multiline:true,validate:value=>
        !value.trim() || value.includes("\0") ? "Supply a commit message."
          : new TextEncoder().encode(value).length > 8192 ? "Keep the commit message within 8 KiB." : null};
      if (large.length) detail.push("", `Warning: ${large.length} file(s) exceed ${limit} MiB. Approval commits them as staged.`,
        ...large.slice(0, 50).map(file => file.path));
    }
    const catalog = action === "start_workflow" ? await api.workflowCatalog(root) : null;
    if (catalog) {
      const recipe = catalog.definitions.find(definition => definition.id === target);
      if (!recipe) throw new Error("Choose a recipe ID from list_workflows.");
      detail.push(`${recipe.name} · ${recipe.steps.length} steps`, `Branch: ${a.branch}`, `Base: ${a.base}`, "Each workflow step is requested separately.");
    }
    const run = action === "review_workflow_step" && target ? await api.workflowRun(root, target) : null;
    if (action === "review_workflow_step") {
      if (run?.phase !== "ready") throw new Error("Choose a waiting workflow run ID from list_workflows.");
      detail.push(`${run.definition.name} · step ${run.cursor + 1} of ${run.definition.steps.length}`);
    }
    const mergePlan = mode === "delete_only" && action === "merge_pr" && pr && pr.forge.kind !== "bitbucket"
      ? await api.prMergePlan(root, number!, pr.connection, pr.detail.revision) : undefined;
    const mergeMayDelete = !!mergePlan && mergePlan.sourceBranchMayBeDeleted !== false;
    if (mergeMayDelete) detail.push("The provider may delete the source branch after merging.");
    const manual = mcpNeedsApproval(mode, action, a, run?.definition.steps[run.cursor]?.kind, mergeMayDelete, pullMode === "rebase");
    status.approval = manual ? "manual" : "automatic";
    if (manual && useUi.getState().dialogs.length) throw new McpToolError("review_pending", "Finish the open Revqora dialog before requesting another action.");
    requireRepo(root);
    if (!await api.mcpLease(event.session)) { cancelAction(status, "session_expired"); return; }
    let value = field?.initial ?? "";
    if (manual) {
      status.phase = "awaiting_confirmation";
      const approved = await showDialog<ApprovalResult | null>(close => <Approval action={title}
        description={`${root} · ${baseline.branch ?? "detached HEAD"}`} details={detail} field={field} close={close} />,
        { ms: 120_000, value: { reason: "approval_timed_out" } });
      if (!approved || "reason" in approved) { cancelAction(status, approved?.reason ?? "dialog_dismissed"); return; }
      value = approved.value;
    } else {
      const invalid = field?.validate(value);
      if (invalid) throw new McpToolError("invalid_arguments", invalid);
    }
    if (!await api.mcpLease(event.session)) { cancelAction(status, "session_expired"); return; }
    if (action === "create_branch") target = value;
    requireRepo(root);
    if (!stageReview && (await api.status(root)).stateToken !== expectedState) throw new McpToolError("stale_state", "The repository changed during approval. Review the current state and submit a new request.");
    if (branchReview) {
      const { local } = await api.refs(root);
      if (targetOid && local.find(branch => branch.name === target)?.oid !== targetOid) {
        throw new McpToolError("stale_state", "The target branch changed during approval.");
      }
      if (start) {
        const existing = duplicateBranch(root, target!, local);
        if (existing) throw new McpToolError("branch_exists", `The name conflicts with local branch ${existing.name}.`);
        if (start.branch && local.find(branch => branch.name === start.branch)?.oid !== start.oid) {
          throw new McpToolError("stale_state", "The starting branch changed during approval.");
        }
        await api.verifyCommit(root, start.oid);
      }
    }
    if (stash) await reviewStash(root, stash.index, stash.oid);
    if (!await api.mcpLease(event.session)) { cancelAction(status, "session_expired"); return; }
    status.phase = "running";
    const authorize = async () => {
      if (!manual && (await api.mcpInfo()).approvalMode !== mode) {
        throw new McpToolError("approval_policy_changed", "The MCP approval mode changed. Submit a fresh request.");
      }
      if (!await api.mcpLease(event.session)) { cancelAction(status, "session_expired"); return false; }
      requireRepo(root);
      return true;
    };
    if (!await authorize()) return;
    switch (action) {
      case "stage": await api.stage(root, paths, undefined, stageReview); break;
      case "unstage": await api.unstage(root, paths, expectedState, true); break;
      case "commit": {
        const signing = await api.signingGet(root);
        if (!await authorize()) return;
        status.commit = await api.commit(root, value, { sign: signing.signCommits, verbatimMessage: true }, expectedState, true);
        status.result = {sha:status.commit};
        break;
      }
      case "create_branch":
        await api.branchCreate(root, target!, start!.oid, false, expectedState);
        status.result = { branch: target!, sha: start!.oid };
        break;
      case "checkout": {
        const dirtyChoice = a.dirtyAction ?? (manual ? undefined : "stash");
        const result = await A.checkoutWithOutcome(root, target!, "local", expectedState, authorize, dirtyChoice);
        if (result.status === "cancelled") { cancelAction(status, status.reason ?? "dialog_dismissed"); return; }
        if (result.status === "failed") throw result.error;
        const switched = result.switch;
        const source = `refs/heads/${switched.branch}`;
        let restoreStash: StashInfo | undefined;
        let warning = switched.warning ?? undefined;
        if (!switched.stash) {
          try { restoreStash = (await api.stashList(root)).find(item => item.switchSource === source); }
          catch { warning = "The branch was switched. Read list_stashes to check for saved changes."; }
        }
        const hasLocalChanges = switched.branch === baseline.branch && baseline.files.length > 0;
        let nextStep = "none";
        if (switched.conflicts.length) nextStep = "resolve_conflicts";
        else if (warning) nextStep = "inspect_worktree_and_stash";
        else if (switched.dirtyAction === "stash") nextStep = "return_to_source";
        else if (restoreStash) nextStep = hasLocalChanges ? "save_changes_before_restore" : "restore_stash";
        status.result = {
          previousBranch: baseline.branch, currentBranch: switched.branch, conflicts: switched.conflicts,
          dirtyAction: switched.dirtyAction, stash: switched.stash, switchSource: switched.stash?.switchSource ?? restoreStash?.switchSource ?? null,
          changesRestored: switched.moved, nextStep,
          restoreStash: restoreStash ? { oid: restoreStash.oid, index: restoreStash.index, switchSource: restoreStash.switchSource } : null,
        };
        status.message = warning;
        break;
      }
      case "delete_branch": {
        if (deletionPlan) {
          if (!await authorize()) return;
          const result = await api.branchDeleteReviewed(root, deletionPlan.proof, false, a.force ?? false, expectedState, loadBranchPreferences(root).protections);
          status.result = { branch: target!, sha: targetOid, checkpoint: result.checkpoint?.id ?? null };
          status.message = result.warning ?? undefined;
          break;
        }
        status.phase = "awaiting_confirmation";
        const result = await A.deleteBranchWithOutcome(root, target!, {
          expectedState, localOnly:true, protectionRules:loadBranchPreferences(root).protections,
          authorize:async () => {
            if (!await authorize()) return false;
            status.phase = "running";
            return true;
          },
        });
        if (result.status === "cancelled") { cancelAction(status, status.reason ?? "dialog_dismissed"); return; }
        if (result.status === "failed") throw result.error;
        status.result = {branch:result.branch,sha:result.oid};
        break;
      }
      case "start_workflow": {
        const started = await api.workflowBegin(root, target!, catalog!.revision, { branch: a.branch!, base: a.base! });
        status.runId = started.id;
        status.message = "Created a waiting run. Request the next step separately.";
        break;
      }
      case "cherry_pick": {
        const result = await api.cherryPick(root, [target!], false, expectedState, status.id);
        await useRepos.getState().refresh(root);
        A.handleOutcome(root, result, "Cherry-pick");
        if (result.status !== "done") {
          status.phase = "waiting_for_resolution";
          status.conflicts = result.conflicts;
          status.message = "Resolve and stage the conflicts, then continue the cherry-pick, or abort it.";
          return;
        }
        break;
      }
      case "cherry_pick_continue": {
        const result = await api.opContinue(root, "cherry-pick", null, expectedState);
        await useRepos.getState().refresh(root);
        A.handleOutcome(root, result, "Cherry-pick");
        if (result.status !== "done") throw new McpToolError("cherry_pick_stopped", result.message || "The cherry-pick is still paused.");
        break;
      }
      case "cherry_pick_abort": {
        await api.opAbort(root, "cherry-pick", expectedState);
        status.result = { aborted: true };
        break;
      }
      case "fetch":
        if (manual && a.prune === undefined) {
          if (await A.fetchAll(root, false) === undefined) throw new Error("Fetch failed. See Revqora's operation log.");
        } else status.message = await api.fetch(root, null, a.prune ?? false, newOpId());
        break;
      case "stash_drop": {
        const checkpoint = await api.stashDrop(root, stash!.index, stash!.oid, expectedState);
        status.result = { oid: stash!.oid, index: stash!.index, switchSource: stash!.switchSource ?? null, checkpoint: checkpoint.id };
        break;
      }
      case "stash_apply": case "stash_pop": {
        const { status: outcome, indexRestored, stashKept, staging, conflicts, message } = await api.stashApply(root, a.stashIndex!, action === "stash_pop", target!, a.restoreIndex, expectedState);
        status.result = { status: outcome, indexRestored, stashKept, staging: staging?.slice(0, 100) ?? null, stagingTotal: staging?.length ?? null, conflicts };
        status.message = outcome === "done" ? undefined : message;
        if (outcome !== "done") { status.phase = "partial"; return; }
        break;
      }
      case "pr_workflow": {
        const pull = pr!.detail.pull;
        openOverlay({ kind: "workflows", root, pull: { number: pull.number, head: pull.head, base: pull.base, remote: pr!.forge.remote } });
        if (manual) { status.phase = "handed_off"; return; }
        break;
      }
      default:
        if (!manual) {
          const outcome = await runAutomaticMcpAction({ root, action, options: a, baseline, expectedState, mode, pullMode, pr, mergePlan,
            workflowCursor: run?.cursor, authorize: async () => {
              if (!await authorize()) throw new McpToolError("session_expired", cancellationMessages.session_expired);
            } });
          Object.assign(status, outcome);
          break;
        }
        status.phase = "handed_off";
        status.message = "Continue in Revqora and verify the result with the read tools.";
        switch (action) {
          case "stash": await A.stash(root, expectedState); break;
          case "pull": await A.pull(root, pullMode, expectedState, a.prune ?? false); break;
          case "push": await A.push(root); break;
          case "sync": await syncRepositories([root]); break;
          case "create_pr": await createPullRequest(root, null); break;
          case "review_pr": await chooseReview(pr!, () => { void useRepos.getState().refresh(root); }); break;
          case "merge_pr":
            if (pr!.forge.kind === "bitbucket") throw new Error("This PR must be merged in Bitbucket. Review it in PR Center.");
            await mergeDialog({ ...pr!, updated: () => { void useRepos.getState().refresh(root); } });
            break;
          case "review_workflow_step": {
            const current = await api.workflowRun(root, target!);
            if (current.phase !== "ready" || current.cursor !== run!.cursor) throw new Error("The workflow advanced during approval.");
            if (!await api.mcpLease(event.session)) { cancelAction(status, "session_expired"); return; }
            await openWorkflowStepReview(root, current.id);
            break;
          }
        }
        return;
    }
    status.phase = "succeeded";
  } catch (reason) {
    const { code, message } = mcpError(reason);
    if (code === "session_expired") { cancelAction(status, code); return; }
    status.phase = "failed";
    status.errorCode = code;
    status.message = message;
  } finally {
    activeAction = null;
  }
}

async function requestAction(event: DesktopRequest, root: string, a: Arguments) {
  if (activeAction) {
    const sameSession = activeAction.startsWith(event.session);
    throw new McpToolError("review_pending", sameSession ? `Wait for MCP action ${activeAction} before requesting another action.` : "Wait for the previous MCP session's action to finish.", sameSession ? activeAction : undefined);
  }
  const id = event.session + event.id;
  activeAction = id;
  try {
    const { approvalMode } = await api.mcpInfo();
    if (approvalMode === "ask" && useUi.getState().dialogs.length) throw new McpToolError("review_pending", "Finish the existing Revqora review before requesting another action.");
    const action = a.action!;
    const prepared: PreparedAction = {};
    if (branchActions.has(action)) prepared.branch = await reviewBranchAction(root, action, a.target, a.base);
    if (action === "cherry_pick_continue" || action === "cherry_pick_abort") prepared.pendingPick = await reviewPendingPick(root, action);
    if (action === "cherry_pick") {
      prepared.pickOid = exactCommit(a.target);
      await api.verifyCommit(root, prepared.pickOid);
    }
    if (action === "stage") prepared.paths = await reviewPaths(root, action, a.paths!);
    if (action === "stash_apply" || action === "stash_pop" || action === "stash_drop") {
      prepared.stash = await reviewStash(root, a.stashIndex!, exactCommit(a.target));
    }
    if (!await api.mcpLease(event.session, event.id)) throw new McpToolError("session_expired", "The MCP request expired before the review could open.");
    const status: ActionStatus = { id, session: event.session, root, action, phase: "preparing" };
    actions.set(id, status);
    if (actions.size > 50) actions.delete(actions.keys().next().value!);
    void runAction(event, root, a, status, approvalMode, prepared);
    return { id, phase: status.phase, approvalMode, message: "Poll action_status for the outcome. Revqora opens a confirmation when the selected approval mode requires one." };
  } catch (error) {
    activeAction = null;
    throw error;
  }
}

async function dispatch(event: DesktopRequest): Promise<unknown> {
  const { name, arguments: a } = event.request;
  if (name === "list_repositories" || name === "workspace_overview") {
    const roots = permittedRoots();
    const { active, tabs } = useRepos.getState();
    return {
      active: active && roots.includes(active) ? active : null,
      repositories: roots.map(id => {
        const tab = tabs[id];
        const repository = { id, name: tab.info?.name ?? basename(id), branch: tab.info?.head.branch };
        if (name === "list_repositories") return repository;
        const status = tab.sidebarStatus ?? tab.status;
        const summary = status ? {
          oid: status.oid, upstream: status.upstream, ahead: status.ahead, behind: status.behind,
          staged: status.stagedCount, unstaged: status.unstagedCount, conflicts: status.conflictCount,
          changed: status.files.length, stateVersion: status.stateVersion ?? null,
        } : null;
        return { ...repository, branch: status ? status.branch : repository.branch, status: summary, source: "desktop_snapshot", cached: true };
      }),
    };
  }
  if (name === "action_status") {
    if (/^[a-f0-9]{64}$/.test(a.id!) && !a.id!.startsWith(event.session)) {
      throw new McpToolError("session_expired", "This action ID belongs to a previous MCP session. Read the current repository state to verify the outcome.");
    }
    const status = actions.get(a.id!);
    if (!status || status.session !== event.session) throw new McpToolError("unknown_action", "Unknown MCP action in this session.");
    if (status.phase === "waiting_for_resolution") {
      const outcome = await api.mcpCherryPickStatus(requireRepo(status.root), status.id);
      if (outcome) {
        delete status.conflicts;
        if (outcome.phase === "succeeded") {
          status.phase = "succeeded";
          status.result = { sha: outcome.sha };
          delete status.message;
        } else if (outcome.phase === "cancelled") {
          cancelAction(status, outcome.reason);
        } else {
          status.phase = "failed";
          status.errorCode = outcome.reason;
          status.message = "Revqora could not verify how the pending cherry-pick ended. Inspect the repository's current state.";
        }
      }
    }
    const { session: _session, root: _root, ...result } = status;
    return result;
  }
  const root = requireRepo(a.repository);
  switch (name) {
    case "repository_status": {
      const [status, info] = await Promise.all([api.status(root), api.repoInfo(root)]);
      const { stateToken: _stateToken, diffContextToken: _diffContextToken, files, ...summary } = status;
      return { ...summary, operation: info.state.kind, files: page(files.map(({ diffToken: _diffToken, ...file }) => file), a.offset, 200) };
    }
    case "list_branches": {
      const refs = await api.refs(root);
      const branches = a.scope === "local" ? refs.local : a.scope === "remote" ? refs.remote : [...refs.local, ...refs.remote];
      const query = a.query?.toLocaleLowerCase();
      return page(branches.filter(branch => !query || branch.name.toLocaleLowerCase().includes(query)), a.offset);
    }
    case "compare_branches":
      return api.compareBranchCommits(root, a.from!, a.to!);
    case "search_commits":
      return api.repositoryCommitSearchPage(root, a.query!, a.mode && a.mode !== "all" ? a.mode : "quick", a.cursor ?? null, a.limit ?? 30);
    case "commit_details": {
      const { files, ...commit } = await api.commitDetails(root, exactCommit(a.oid), true);
      return { ...commit, body: commit.body.slice(0, 12000), files: page(files, a.offset, 100) };
    }
    case "file_diff": {
      const path = a.path!;
      if (a.side === "commit") {
        const oid = exactCommit(a.oid);
        const { files, diffBase } = await api.commitDetails(root, oid, true);
        const file = files.find(file => file.path === path);
        if (!file) throw new McpToolError(a.diffVersion ? "diff_changed" : "file_not_found", "Choose a changed path from commit_details and start at offset 0.");
        return diffPage(await api.revDiff(root, diffBase, oid, path, { disableTextconv: true, renameFrom: file.oldPath ?? undefined }), a);
      }
      const file = (await api.status(root)).files.find(file => file.path === path);
      if (!file || path.endsWith("/") || a.side === "staged" && file.untracked) throw new McpToolError(a.diffVersion ? "diff_changed" : "file_not_found", "Choose a changed file from repository_status and start at offset 0.");
      if (file.conflict) {
        const sides = await api.conflictIndexSides(root, path).catch(error => {
          if (a.diffVersion && mcpError(error).code === "stale_state") throw new McpToolError("diff_changed", "The conflict changed. Start again at offset 0.");
          throw error;
        });
        const diffVersion = `conflict:${file.conflict}:${sides.base?.oid ?? "-"}:${sides.ours?.oid ?? "-"}:${sides.theirs?.oid ?? "-"}`;
        assertDiffVersion(diffVersion, a);
        const summary = { kind: "conflict", path, empty: false, code: file.conflict, diffVersion };
        if (a.lineOffset !== undefined) {
          if (!a.conflictSide) throw new McpToolError("invalid_arguments", "Select conflictSide to continue a conflict line.");
          return { ...summary, side: a.conflictSide, line: conflictLine(sides[a.conflictSide], a.offset ?? 0, a.lineOffset) };
        }
        return { ...summary, base: conflictSidePage(sides.base, a), ours: conflictSidePage(sides.ours, a), theirs: conflictSidePage(sides.theirs, a) };
      }
      const staged = a.side === "staged";
      const renameFrom = staged && file.index === "R" ? file.origPath ?? undefined : undefined;
      return diffPage(await api.workingDiff(root, path, staged ? "staged" : "unstaged", file.untracked, { disableTextconv: true, renameFrom }, true), a);
    }
    case "list_worktrees": {
      const { worktrees } = await api.worktreeManagerSnapshot(root);
      return page(worktrees, a.offset);
    }
    case "list_stashes": return page(await api.stashList(root), a.offset);
    case "list_workflows": {
      const [catalog, runs] = await Promise.all([api.workflowCatalog(root), api.workflowRuns(root)]);
      return { definitions: catalog.definitions.map(({ id, name, steps }) => ({ id, name, steps: steps.length })), runs };
    }
    case "workflow_status": {
      const { id, phase, cursor, results, definition } = await api.workflowRun(root, a.id!);
      return { id, phase, cursor, name: definition.name, total: definition.steps.length,
        results: results.map(({ phase, exitCode, truncated }) => ({ phase, exitCode, truncated })) };
    }
    case "list_pull_requests": {
      const { forge, items, nextCursor } = await api.prPage(root, a.state ?? "open", a.cursor);
      return { provider: forge.kind, project: forge.project, items, nextCursor };
    }
    case "connection_identity": {
      const { connectionRevision: _connectionRevision, ...identity } = await api.forgeConnectionIdentity(root);
      return identity;
    }
    case "pull_request": return pullRequest(root, a);
    case "open_view": return navigate(root, a.view!);
    case "request_action": return requestAction(event, root, a);
    default: throw new McpToolError("unknown_tool", "Unknown Revqora tool.");
  }
}

export function listenMcpDesktop() {
  return listen<DesktopRequest>("mcp-request", ({ payload }) => {
    void (async () => {
      if (!await api.mcpLease(payload.session, payload.id)) return;
      const result = await dispatch(payload);
      if (payload.request.arguments.repository) requireRepo(payload.request.arguments.repository);
      if ((JSON.stringify(result)?.length ?? 0) > 180_000) throw new McpToolError("result_too_large", "The result is too large to return safely. Use a narrower query or inspect the complete result in Revqora.");
      await api.mcpReply(payload.session, payload.id, result);
    })().catch(reason => api.mcpReply(payload.session, payload.id, null, mcpError(reason)).catch(() => {}));
  }, { target: "main" });
}
