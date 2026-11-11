import { api, isGitError, newOpId } from "./api";
import { loadBranchPreferences } from "./branchManager";
import { McpToolError } from "./mcpErrors";
import { forgeRepositoryIdentity, prWriteAttemptKey, prWriteAttemptPending, setPrWriteAttemptPending } from "./prCenter";
import { canMerge, mergeDraftKey } from "./prMerge";
import { reviewAttemptPending, reviewDraftKey, setReviewAttemptPending } from "./prReviews";
import { cleanupCoversRules, workflowAgentPreview } from "./prWorkflow";
import type { ForgeInfo, McpApprovalMode, PrDetail, PrMergePlan, PrReviewKind, StatusSummary, SwitchChoice, WorkflowStep } from "./types";

export interface McpActionOptions {
  number?: number; target?: string; message?: string; branch?: string; base?: string;
  title?: string; draft?: boolean; reviewKind?: Extract<PrReviewKind, "comment" | "approve" | "request_changes">;
  method?: string; dirtyAction?: SwitchChoice["action"]; includeUntracked?: boolean; keepIndex?: boolean;
  prune?: boolean; force?: boolean; remote?: string; remoteBranch?: string; setUpstream?: boolean;
  receive?: boolean; send?: boolean;
  stashIndex?: number; restoreIndex?: boolean;
}

export function mcpNeedsApproval(mode: McpApprovalMode, action: string, options: McpActionOptions, step?: WorkflowStep["kind"], mergeMayDelete = false, pullRebases = false) {
  if (mode === "full") return false;
  if (mode !== "delete_only") return true;
  return action === "delete_branch" || action === "cherry_pick_abort" || action === "stash_pop"
    || (action === "fetch" || action === "pull") && options.prune === true
    || action === "pull" && pullRebases
    || action === "push" && options.force === true
    || action === "merge_pr" && mergeMayDelete
    || action === "review_workflow_step" && (!step || ["prCleanup", "prMerge", "command", "prAgent"].includes(step));
}

const missing = (message: string) => new McpToolError("action_details_required", message);

async function submitOnce<T>(pending: () => boolean, mark: (pending: boolean) => void, submit: () => Promise<T>, keep?: (value: T) => boolean) {
  if (pending()) throw new McpToolError("result_unverified", "Check the previous write on the provider before submitting another request.");
  mark(true);
  let result: T;
  try { result = await submit(); }
  catch (error) {
    if (isGitError(error) && !["forge-write-uncertain", "operation-failed", "git"].includes(error.kind)) mark(false);
    throw error;
  }
  if (!keep?.(result)) mark(false);
  return result;
}

interface AutomaticContext {
  root: string; action: string; options: McpActionOptions; baseline: StatusSummary; expectedState: string; mode: McpApprovalMode;
  pullMode: "ff-only" | "merge" | "rebase"; pr: { forge: ForgeInfo; connection: string; detail: PrDetail } | null;
  mergePlan?: PrMergePlan; workflowCursor?: number; authorize: () => Promise<void>;
}

export async function runAutomaticMcpAction({ root, action, options: a, baseline, expectedState, mode, pullMode, pr, mergePlan, workflowCursor, authorize }: AutomaticContext):
Promise<{ message?: string; result?: Record<string, unknown>; runId?: string }> {
  const prune = a.prune ?? mode === "full";
  switch (action) {
    case "stash":
      await authorize();
      await api.stashSave(root, a.message ?? "", a.includeUntracked ?? true, a.keepIndex ?? false, undefined, expectedState);
      return {};
    case "pull": {
      await authorize();
      const { status, message, conflicts } = await api.pull(root, pullMode, newOpId(), expectedState, prune);
      if (["conflicts", "stopped", "pending"].includes(status)) throw new McpToolError("operation_in_progress", message || "Review the pending pull in Revqora.");
      return { message, result: { status, conflicts } };
    }
    case "push": {
      if (!baseline.branch) throw missing("Check out a local branch before pushing.");
      const { local, remotes } = await api.refs(root);
      const tracking = local.find(branch => branch.name === baseline.branch);
      const remote = remotes.find(item => item.name === (a.remote ?? tracking?.remote))
        ?? (!a.remote ? remotes.find(item => tracking?.upstream?.startsWith(item.name + "/")) : undefined);
      if (!remote || remote.name.startsWith("-")) throw missing("Supply the name of an existing remote or configure an upstream for the current branch.");
      const destination = a.remoteBranch ?? (tracking?.upstream?.startsWith(remote.name + "/") ? tracking.upstream.slice(remote.name.length + 1) : baseline.branch);
      if (!destination || /[:\x00-\x20]/.test(destination)) throw missing("Supply a valid destination branch name.");
      await authorize();
      const message = await api.push(root, { remote: remote.name, branch: baseline.branch, remoteBranch: destination,
        forceWithLease: a.force ?? false, setUpstream: a.setUpstream ?? false }, newOpId(), expectedState);
      return { message, result: { remote: remote.name, branch: baseline.branch, destination } };
    }
    case "sync": {
      const plan = await api.syncPrepare(root);
      if (plan.stateToken !== expectedState) throw new McpToolError("stale_state", "The repository changed while preparing Sync.");
      const receive = a.receive ?? plan.behind > 0;
      const send = a.send ?? false;
      if (!receive && !send) {
        if (plan.ahead) throw missing("Supply send=true to publish the outgoing commits.");
        return { message: "The branch is up to date." };
      }
      await authorize();
      const result = await api.syncExecute(root, plan, receive, send);
      return { message: result.warnings.join(" · ") || undefined,
        result: { received: result.received, sent: result.sent, checkpoint: result.checkpoint.id } };
    }
    case "create_pr": {
      if (!a.title?.trim() || !a.branch?.trim() || !a.base?.trim()) throw missing("Supply title, branch (published source), and base (target) to create a pull request.");
      const { title, branch, base } = a;
      const forge = await api.forgeInfo(root);
      if (!forge?.connectionRevision) throw new McpToolError("pr_connection_required", "Choose an API account and remote in Revqora's PR Center first.");
      const connection = forge.connectionRevision;
      const key = prWriteAttemptKey(forge, null);
      await authorize();
      const pull = await submitOnce(() => prWriteAttemptPending(key, root), pending => setPrWriteAttemptPending(key, pending, root),
        () => api.prCreate(root, title.trim(), a.message ?? "", branch.trim(), base.trim(), a.draft ?? false, connection));
      return { result: { number: pull.number, url: pull.url } };
    }
    case "review_pr": {
      const kind = a.reviewKind;
      if (!pr || !kind) throw missing("Supply number and reviewKind to submit a pull request review.");
      const { connection, forge, detail } = pr;
      const n = detail.pull.number;
      const caps = await api.prReviewCapabilities(root, n, connection, detail.revision);
      if (!(kind === "approve" ? caps.approve : kind === "comment" ? caps.comment : caps.requestChanges)) {
        throw new McpToolError("pr_action_unavailable", caps.reason || "The provider does not allow this review.");
      }
      const body = a.message ?? "";
      if ((kind === "comment" || kind === "request_changes" && caps.summaryWithVote) && !body.trim()) throw missing("Supply a review message.");
      if (kind !== "comment" && !caps.summaryWithVote && body) throw missing("This provider sends votes separately. Send the message as a comment.");
      const key = reviewDraftKey(root, JSON.stringify([forgeRepositoryIdentity(forge), caps.actorId]), n, detail.pull.headSha, kind, "general");
      await authorize();
      await submitOnce(() => reviewAttemptPending(key), pending => setReviewAttemptPending(key, pending),
        () => api.prReviewAct(root, n, connection, detail.revision, { kind, body, expectedActor: caps.actorId, thread: null, threadRevision: null, anchor: null }));
      return { result: { number: n, reviewKind: kind } };
    }
    case "merge_pr": {
      if (!pr) throw missing("Supply the pull request number.");
      const { connection, forge, detail } = pr;
      if (forge.kind === "bitbucket") throw new McpToolError("pr_action_unavailable", "Merge this pull request in Bitbucket Cloud.");
      const n = detail.pull.number;
      const plan = mergePlan ?? await api.prMergePlan(root, n, connection, detail.revision);
      const method = a.method ?? (plan.methods.length === 1 ? plan.methods[0].id : undefined);
      if (plan.blockers.length || plan.merged) throw new McpToolError("pr_action_unavailable", plan.blockers.join(" · ") || "This pull request is already merged.");
      if (!method || !canMerge(plan, method)) throw missing(`Choose a merge method: ${plan.methods.map(item => item.id).join(", ") || "none available"}.`);
      const key = mergeDraftKey(root, forgeRepositoryIdentity(forge), plan.actorId, n);
      await authorize();
      const result = await submitOnce(() => reviewAttemptPending(key), pending => setReviewAttemptPending(key, pending),
        () => api.prMergeSubmit(root, n, connection, detail.revision, { planRevision: plan.revision, method, message: method === "queue" ? "" : a.message ?? "" }),
        value => value.state !== "merged");
      return { message: result.message, result: { number: n, state: result.state, sha: result.commit } };
    }
    case "review_workflow_step": {
      if (!a.target) throw missing("Supply the workflow run ID.");
      const proof = await api.workflowReview(root, a.target);
      if (proof.cursor !== workflowCursor || proof.stateToken !== expectedState) throw new McpToolError("stale_state", "The workflow changed while preparing this step.");
      if (!cleanupCoversRules(proof.step, loadBranchPreferences(root).protections)) throw new McpToolError("branch_protected", "Update the workflow to include current branch protections.");
      if (proof.conditionMet && proof.step.kind === "prAgent" && !workflowAgentPreview(proof)) throw missing("The saved workflow agent step lacks a valid launch plan.");
      if (mcpNeedsApproval(mode, action, a, proof.step.kind)) throw new McpToolError("approval_policy_changed", "This workflow step needs desktop approval. Submit a fresh request.");
      await authorize();
      const run = await api.workflowExecute(root, proof, proof.consentRequired);
      return { runId: run.id, result: { cursor: run.cursor, phase: run.phase } };
    }
    default:
      throw new McpToolError("invalid_arguments", "Unknown automatic MCP action.");
  }
}
