import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorMessage } from "./api";
import * as A from "./actions";
import { basename } from "./format";
import { useRepos } from "./store";
import { useLibrary } from "./repositoryLibrary";
import { useSettings } from "./settings";
import { closeOverlay, openOverlay, showDialog, useUi } from "./ui";
import type { FileDiff, PrState, SearchMode } from "./types";
import { Modal } from "../components/Modal";
import { validBranchName } from "../components/dialogs";
import { createPullRequest } from "../components/PullRequests";
import { chooseReview } from "../components/PrReviews";
import { mergeDialog } from "../components/PrMerge";
import { syncRepositories } from "../components/SyncRepositories";
import { openWorkflowStepReview } from "../components/WorkflowBuilder";

type Arguments = {
  repository?: string; offset?: number; oid?: string; path?: string; side?: string;
  scope?: string; query?: string; mode?: SearchMode | "all"; state?: PrState;
  number?: number; section?: string; cursor?: string; revision?: string; fileId?: string;
  view?: string; id?: string; action?: string; target?: string; paths?: string[]; message?: string;
  from?: string; to?: string; feed?: string; branch?: string; base?: string;
};
interface DesktopRequest {
  id: string;
  session: string;
  request: { name: string; arguments: Arguments };
}
type Phase = "preparing" | "awaiting_confirmation" | "running" | "cancelled" | "succeeded" | "handed_off" | "failed";
interface ActionStatus { id: string; session: string; action: string; phase: Phase; message?: string; commit?: string; runId?: string }
const actions = new Map<string, ActionStatus>();
let activeAction: string | null = null;

function permittedRoots() {
  const { activeWorkspaceId, workspaces } = useLibrary.getState();
  const allowed = activeWorkspaceId ? new Set(workspaces.find(workspace => workspace.id === activeWorkspaceId)?.roots ?? []) : null;
  const { order, tabs } = useRepos.getState();
  return order.filter(root => (!allowed || allowed.has(root)) && !!tabs[root]?.info);
}

function requireRepo(root?: string) {
  if (!root || !permittedRoots().includes(root)) throw new Error("Choose a repository from list_repositories in the active workspace.");
  return root;
}

const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
function exactCommit(oid?: string) {
  if (!oid || !oidPattern.test(oid)) throw new Error("Supply the full commit hash.");
  return oid;
}

function safeError(reason: unknown) {
  return errorMessage(reason).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[credentials]@").slice(0, 2000);
}

function page<T>(items: T[], offset = 0, size = 100) {
  return { items: items.slice(offset, offset + size), total: items.length, nextOffset: offset + size < items.length ? offset + size : null };
}

function diffPage(diff: FileDiff, offset: number) {
  const { hunks, hash: _hash, ...summary } = diff;
  const total = hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
  let start = 0;
  let lineTextTruncated = false;
  const end = offset + 160;
  const items = [];
  for (const { lines, header } of hunks) {
    if (start >= end) break;
    if (start + lines.length > offset) {
      const selected = lines.slice(Math.max(0, offset - start), end - start).map(line => {
        if (line.text.length <= 600) return line;
        lineTextTruncated = true;
        return { ...line, text: line.text.slice(0, 600) };
      });
      items.push({ header, lines: selected });
    }
    start += lines.length;
  }
  return { ...summary, hunks: items, totalLines: total, lineTextTruncated, nextOffset: end < total ? end : null };
}

async function prContext(root: string, number: number) {
  const forge = await api.forgeInfo(root);
  const connection = forge?.connectionRevision;
  if (!forge || !connection) throw new Error("Choose an API account and remote in Revqora's PR Center first.");
  return { root, forge, connection, detail: await api.prDetail(root, number, connection) };
}

async function pullRequest(root: string, a: Arguments) {
  const number = a.number!;
  const { connection, detail } = await prContext(root, number);
  const { revision } = detail;
  if (a.revision && a.revision !== revision) throw new Error("The PR changed. Read its files or overview again.");
  switch (a.section) {
    case "files": return { revision, ...await api.prFiles(root, number, connection, revision, a.offset ?? 0) };
    case "diff": {
      if (!a.revision || !a.fileId) throw new Error("Supply fileId and revision from the files section.");
      const { diff, notice } = await api.prFile(root, number, connection, revision, a.fileId);
      return { revision, notice, diff: diff ? diffPage(diff, a.offset ?? 0) : null };
    }
    case "discussions": return { revision, ...await api.prReviewPage(root, number, connection, revision, a.feed ?? "threads", a.cursor) };
    case "checks": return { revision, checks: await api.prChecks(root, number, connection, revision) };
    default: return detail;
  }
}

function navigate(root: string, view: string) {
  if (useUi.getState().dialogs.length) throw new Error("Finish the open Revqora dialog before changing views.");
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
  fetch: "Fetch from all remotes", pull: "Pull current branch", push: "Open push review", sync: "Open Sync review",
  create_pr: "Open PR creation", review_pr: "Open PR review", merge_pr: "Open PR merge review", pr_workflow: "Open PR workflow",
  start_workflow: "Create waiting workflow run", review_workflow_step: "Open workflow step review",
};

function Approval({ action, description, details, close }: { action: string; description: string; details: string[]; close: (approved: boolean) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => close(false), 120_000);
    return () => window.clearTimeout(timer);
  }, [close]);
  return <Modal title={`MCP request · ${action}`} subtitle={description} wide onClose={() => close(false)} onSubmit={() => close(true)}
    footer={<><button className="btn" type="button" onClick={() => close(false)}>Decline</button>
      <button className="btn primary" type="submit">Approve in Revqora</button></>}>
    <p className="muted">A local MCP client requested this action. This approval applies to this request only.</p>
    {details.length > 0 && <pre className="code-list">{details.join("\n")}</pre>}
  </Modal>;
}

async function runAction(event: DesktopRequest, root: string, a: Arguments, status: ActionStatus) {
  const action = status.action;
  try {
    const target = a.target;
    const number = a.number;
    const title = actionNames[action];
    const detail: string[] = [];
    if ((action === "stage" || action === "unstage") && !a.paths?.length) throw new Error("Supply exact paths from repository_status.");
    if (["create_branch", "checkout", "delete_branch"].includes(action) && (!target || target.trim() !== target || validBranchName(target))) throw new Error("Supply a valid local branch name.");
    if (action === "cherry_pick") exactCommit(target);
    if (["review_pr", "merge_pr", "pr_workflow"].includes(action) && !number) throw new Error("Supply a PR number.");
    if (action === "commit" && !a.message?.trim()) throw new Error("Supply a commit message.");
    if (action === "start_workflow" && (!a.branch || !a.base)) throw new Error("Supply the workflow branch and base.");
    if (target) detail.push(`Target: ${target}`);
    if (number) detail.push(`Pull request #${number}`);
    const paths = [...new Set(a.paths ?? [])];
    const baseline = await api.status(root);
    const expectedState = baseline.stateToken;
    if (!expectedState) throw new Error("Repository status is not ready. Refresh and inspect it first.");
    const pullMode = useSettings.getState().pullMode;
    if (action === "pull") detail.push(`Upstream: ${baseline.upstream ?? "none configured"}`, `Pull mode: ${pullMode}`);
    if (action === "stage" || action === "unstage") {
      const inputPaths = new Map(baseline.files.map(file => [file.path, file]));
      for (const path of paths) {
        const file = inputPaths.get(path);
        if (!file || file.conflict || (action === "stage" ? !file.untracked && file.worktree === "." : file.untracked || file.index === ".")) {
          throw new Error(`The file is not eligible for this action: ${path}`);
        }
      }
      detail.push(...paths);
    }
    let targetOid: string | undefined;
    if (action === "checkout" || action === "delete_branch") {
      targetOid = (await api.refs(root)).local.find(branch => branch.name === target)?.oid;
      if (!targetOid) throw new Error("The local branch does not exist.");
      if (action === "delete_branch" && target === baseline.branch) throw new Error("Switch away from this branch before deleting it.");
      detail.push(`Branch tip: ${targetOid}`);
    }
    const pr = ["review_pr", "merge_pr", "pr_workflow"].includes(action) ? await prContext(root, number!) : null;
    if (pr) detail.push(pr.detail.pull.title, `${pr.detail.pull.head} → ${pr.detail.pull.base} · ${pr.detail.pull.headSha}`);
    if (action === "commit") {
      const info = await api.repoInfo(root);
      if (info.state.kind !== "none" || baseline.conflictCount || !baseline.stagedCount) throw new Error("Stage changes and finish the current Git operation before committing.");
      const limit = useSettings.getState().largeFileMb;
      const large = await api.largeStagedFiles(root, limit * 1024 * 1024);
      detail.push(a.message!.trim(), "", `${baseline.stagedCount} staged file(s)`);
      if (large.length) detail.push("", `Warning: ${large.length} file(s) exceed ${limit} MiB. Approval commits them as staged.`,
        ...large.slice(0, 50).map(file => file.path));
    }
    const catalog = action === "start_workflow" ? await api.workflowCatalog(root) : null;
    if (catalog) {
      const recipe = catalog.definitions.find(definition => definition.id === target);
      if (!recipe) throw new Error("Choose a recipe ID from list_workflows.");
      detail.push(`${recipe.name} · ${recipe.steps.length} steps`, `Branch: ${a.branch}`, `Base: ${a.base}`, "Each workflow step requires a separate review.");
    }
    const run = action === "review_workflow_step" && target ? await api.workflowRun(root, target) : null;
    if (action === "review_workflow_step") {
      if (run?.phase !== "ready") throw new Error("Choose a waiting workflow run ID from list_workflows.");
      detail.push(`${run.definition.name} · step ${run.cursor + 1} of ${run.definition.steps.length}`);
    }
    if (useUi.getState().dialogs.length) throw new Error("Finish the open Revqora dialog before requesting another action.");
    requireRepo(root);
    if (!await api.mcpLease(event.session)) throw new Error("The MCP session ended.");
    status.phase = "awaiting_confirmation";
    const approved = await showDialog<boolean>(close => <Approval action={title}
      description={`${root} · ${baseline.branch ?? "detached HEAD"}`} details={detail} close={close} />);
    if (!approved || !await api.mcpLease(event.session)) { status.phase = "cancelled"; return; }
    requireRepo(root);
    if ((await api.status(root)).stateToken !== expectedState) throw new Error("The repository changed during approval. Review the current state and submit a new request.");
    if (targetOid && (await api.refs(root)).local.find(branch => branch.name === target)?.oid !== targetOid) throw new Error("The target branch changed during approval.");
    if (!await api.mcpLease(event.session)) { status.phase = "cancelled"; return; }
    status.phase = "running";
    switch (action) {
      case "stage": await api.stage(root, paths, expectedState); break;
      case "unstage": await api.unstage(root, paths, expectedState); break;
      case "commit": {
        const signing = await api.signingGet(root);
        if (!await api.mcpLease(event.session)) { status.phase = "cancelled"; return; }
        status.commit = await api.commit(root, a.message!.trim(), { sign: signing.signCommits }, expectedState);
        break;
      }
      case "create_branch":
        await api.branchCreate(root, target!, baseline.oid, false, expectedState); break;
      case "start_workflow": {
        const started = await api.workflowBegin(root, target!, catalog!.revision, { branch: a.branch!, base: a.base! });
        status.runId = started.id;
        status.message = "Created a waiting run. Request a review for the next step.";
        break;
      }
      case "cherry_pick": {
        const result = await api.cherryPick(root, [target!], false, expectedState);
        A.handleOutcome(root, result, "Cherry-pick");
        if (result.status !== "done") { status.phase = "handed_off"; status.message = result.status; return; }
        break;
      }
      case "fetch":
        if (await A.fetchAll(root) === undefined) throw new Error("Fetch failed. See Revqora's operation log.");
        break;
      default:
        status.phase = "handed_off";
        status.message = "Continue in Revqora and verify the result with the read tools.";
        switch (action) {
          case "checkout": await A.checkout(root, target!, "local", expectedState); break;
          case "delete_branch": await A.deleteBranch(root, target!); break;
          case "stash": await A.stash(root, expectedState); break;
          case "pull": await A.pull(root, pullMode, expectedState); break;
          case "push": await A.push(root); break;
          case "sync": await syncRepositories([root]); break;
          case "create_pr": await createPullRequest(root, null); break;
          case "review_pr": await chooseReview(pr!, () => { void useRepos.getState().refresh(root); }); break;
          case "merge_pr":
            if (pr!.forge.kind === "bitbucket") throw new Error("This PR must be merged in Bitbucket. Review it in PR Center.");
            await mergeDialog({ ...pr!, updated: () => { void useRepos.getState().refresh(root); } });
            break;
          case "pr_workflow": {
            const pull = pr!.detail.pull;
            openOverlay({ kind: "workflows", root, pull: { number: pull.number, head: pull.head, base: pull.base, remote: pr!.forge.remote } });
            break;
          }
          case "review_workflow_step": {
            const current = await api.workflowRun(root, target!);
            if (current.phase !== "ready" || current.cursor !== run!.cursor) throw new Error("The workflow advanced during approval.");
            if (!await api.mcpLease(event.session)) { status.phase = "cancelled"; return; }
            await openWorkflowStepReview(root, current.id);
            break;
          }
        }
        return;
    }
    status.phase = "succeeded";
  } catch (reason) {
    status.phase = "failed";
    status.message = safeError(reason);
  } finally {
    activeAction = null;
  }
}

function requestAction(event: DesktopRequest, root: string, a: Arguments) {
  if (activeAction || useUi.getState().dialogs.length) throw new Error("Finish the existing Revqora review before requesting another action.");
  const id = event.id;
  const status: ActionStatus = { id, session: event.session, action: a.action!, phase: "preparing" };
  activeAction = id;
  actions.set(id, status);
  if (actions.size > 50) actions.delete(actions.keys().next().value!);
  void runAction(event, root, a, status);
  return { id, phase: status.phase, message: "Switch to Revqora to review this action. Poll action_status for the outcome." };
}

async function dispatch(event: DesktopRequest): Promise<unknown> {
  const { name, arguments: a } = event.request;
  if (name === "list_repositories") {
    const roots = permittedRoots();
    const { active, tabs } = useRepos.getState();
    return { active: active && roots.includes(active) ? active : null, repositories: roots.map(id => ({ id, name: tabs[id].info?.name ?? basename(id), branch: tabs[id].info?.head.branch })) };
  }
  if (name === "action_status") {
    const status = actions.get(a.id!);
    if (!status || status.session !== event.session) throw new Error("Unknown MCP action in this session.");
    const { session: _session, ...result } = status;
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
      return { commits: (await api.repositoryCommitSearch(root, a.query!, a.mode && a.mode !== "all" ? a.mode : "quick")).slice(0, 100) };
    case "commit_details": {
      const { files, ...commit } = await api.commitDetails(root, exactCommit(a.oid));
      return { ...commit, body: commit.body.slice(0, 12000), files: page(files, a.offset, 100) };
    }
    case "file_diff": {
      const path = a.path!;
      if (a.side === "commit") {
        const oid = exactCommit(a.oid);
        const { files, diffBase } = await api.commitDetails(root, oid);
        if (!files.some(file => file.path === path)) throw new Error("Choose a changed path from commit_details.");
        return diffPage(await api.revDiff(root, diffBase, oid, path, { disableTextconv: true }), a.offset ?? 0);
      }
      const file = (await api.status(root)).files.find(file => file.path === path);
      if (!file || path.endsWith("/") || a.side === "staged" && file.untracked) throw new Error("Choose a changed file from repository_status.");
      return diffPage(await api.workingDiff(root, path, a.side === "staged" ? "staged" : "unstaged", file.untracked, { disableTextconv: true }), a.offset ?? 0);
    }
    case "list_worktrees": {
      const { worktrees } = await api.worktreeManagerSnapshot(root);
      return page(worktrees, a.offset);
    }
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
    case "pull_request": return pullRequest(root, a);
    case "open_view": return navigate(root, a.view!);
    case "request_action": return requestAction(event, root, a);
    default: throw new Error("Unknown Revqora tool.");
  }
}

export function listenMcpDesktop() {
  return listen<DesktopRequest>("mcp-request", ({ payload }) => {
    void (async () => {
      if (!await api.mcpLease(payload.session, payload.id)) return;
      const result = await dispatch(payload);
      if (payload.request.arguments.repository) requireRepo(payload.request.arguments.repository);
      if ((JSON.stringify(result)?.length ?? 0) > 180_000) throw new Error("The result is too large to return safely. Use a narrower query or inspect the complete result in Revqora.");
      await api.mcpReply(payload.session, payload.id, result);
    })().catch(reason => api.mcpReply(payload.session, payload.id, null, safeError(reason)).catch(() => {}));
  }, { target: "main" });
}
