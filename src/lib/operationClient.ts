import type { RepoInfo, StatusSummary } from "./types";

export const MUTATING_COMMANDS = new Set([
  "working_file_save", "cherry_pick_compared_commit",
  "stack_append","stack_restack","stack_finalize",
  "pr_merge_submit", "pr_cleanup_submit", "rebase_studio_start", "rebase_studio_capture",
  "stash_selection", "remote_rename_plan", "remote_branch_rename",
  "branch_cleanup_execute", "branch_delete_reviewed", "branch_delete_remote_reviewed",
  "recovery_create", "recovery_delete", "recovery_restore_branch", "recovery_restore_stash", "recovery_restore_files", "recovery_restore_workspace",
  "identity_set", "apply_selection", "stage", "unstage", "discard", "commit", "commit_graph_write", "checkout", "branch_create", "branch_rename", "branch_delete", "branch_delete_remote", "branch_delete_refresh", "branch_set_upstream", "tag_create", "tag_delete", "reset", "undo_commit", "fetch", "fetch_background", "fetch_more_history", "update_moved_tags", "pull", "push", "push_ref", "remote_add", "remote_remove", "remote_set_url", "merge_start", "op_abort", "op_continue", "op_skip", "cherry_pick", "revert", "rebase_onto", "interactive_rebase", "rewrite", "conflict_save", "conflict_external", "conflict_take", "conflict_mark_resolved", "conflict_unresolve", "stash_save", "stash_apply", "stash_drop", "layer_seal", "layer_unstage", "layer_discard", "layer_merge_down", "layer_move", "layer_rename", "layers_flatten", "layer_preview", "layer_unstage_files", "layer_commit", "submodule_update", "submodule_add", "submodule_sync", "worktree_add", "worktree_remove", "worktree_lock", "worktree_prune", "bisect_start", "bisect_mark", "bisect_reset", "lfs_track", "lfs_run", "lfs_lock", "lfs_unlock", "ignore_apply", "rerere_set", "note_set", "stash_branch", "signing_set", "maintenance_run", "restore_branch", "apply_patch", "checkout_file", "apply_from_commit", "stash_restore_file", "pull_request_checkout", "fixup_commit",
  "sparse_checkout_set", "sparse_checkout_add", "sparse_checkout_disable", "sparse_checkout_reapply",
]);

const UNGUARDED = new Set(["stack_restack","pr_merge_submit", "pr_cleanup_submit", "remote_rename_plan", "identity_set", "signing_set", "fetch", "fetch_background", "fetch_more_history", "update_moved_tags", "commit_graph_write", "maintenance_run", "submodule_sync", "lfs_lock", "lfs_unlock", "rerere_set", "note_set", "ignore_apply"]);
const DISPLAYED_STATE = new Set(["stash_selection", "commit", "apply_selection", "layer_commit", "layer_unstage", "layer_discard", "layer_merge_down", "layer_move", "layer_rename", "layer_unstage_files", "layers_flatten", "stash_apply", "stash_drop"]);

interface Hooks {
  observed: (repo: string) => string | null;
  observedHead?: (repo: string) => { branch: string | null; oid: string | null } | null;
  refreshed: (repo: string, status: StatusSummary, info: RepoInfo) => void;
  /** When the changes of an operation started at `startedAt` were complete (see changeTime). */
  changeTime?: (repo: string, startedAt: number) => number;
  /** Brings the shown repository's status and info up to `since`, sharing a read that already
   *  started after it. False when the repository is not shown: the caller reads them itself. */
  settle?: (repo: string, since: number) => Promise<boolean>;
  pending?: (repo: string, delta: number) => void;
  /** Asked when ignored files could not be saved before an operation; true accepts that list. */
  confirmUnprotected?: (repo: string, message: string, paths: string[]) => Promise<boolean>;
  /** Asked when Git may overwrite local ignored or untracked paths: save a copy and continue,
   * continue without one, or cancel (null). `details` holds incoming/local path pairs. */
  confirmCollision?: (repo: string, message: string, details: string[]) => Promise<"copy" | "risk" | null>;
}

let hooks: Hooks = { observed: () => null, refreshed: () => {} };
export function setOperationHooks(next: Hooks) { hooks = next; }

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Runs `call` and lets the user decide when it stops to protect local files: a collision (save a
 * copy and continue, continue without one, or cancel) or files that could not be saved (run
 * without a copy, or cancel). Every decision is for this command and its next run only; the
 * backend checks the exact list again. Decisions travel as a one-shot token on the retry, so no
 * other request (even the same command) can use them; a no-copy answer keeps the collision choice.
 */
async function withConsent<T>(invoke: Invoke, repo: string, command: string, call: (consent?: string) => Promise<T>): Promise<T> {
  // One-shot token of this request's decisions; only the retry that carries it may use them.
  let consent: string | undefined;
  // This request's collision decision. Its token is used up by the attempt that runs, so a later
  // no-copy answer sends the decision again and gets one new token for both.
  let collision: { paths: string[]; copy: boolean } | null = null;
  for (;;) {
    try {
      return await call(consent);
    } catch (e) {
      const err = e as { kind?: string; message?: string; details?: string[]; declined?: boolean };
      if (err?.kind === "ignored-collision" && hooks.confirmCollision) {
        const details = err.details ?? [];
        const choice = await hooks.confirmCollision(repo, err.message ?? "", details);
        if (!choice) {
          // The user saw the paths and cancelled; callers need not explain it again.
          err.declined = true;
          throw e;
        }
        collision = { paths: details.filter((_, i) => i % 2 === 1), copy: choice === "copy" };
        consent = await invoke<string>("recovery_accept_collisions", { repo, command, ...collision });
        continue;
      }
      if (err?.kind !== "ignored-backup-unavailable" || !hooks.confirmUnprotected) throw e;
      const paths = err.details ?? [];
      if (!(await hooks.confirmUnprotected(repo, err.message ?? "", paths))) throw e;
      // Kept together with this request's collision choice, under a new token.
      consent = await invoke<string>("recovery_accept_unprotected", { repo, command, paths, collision });
    }
  }
}

/** Preserve the displayed precondition; never retry a rejected mutation automatically. */
export async function repositoryCall<T>(invoke: Invoke, command: string, args?: Record<string, unknown>): Promise<T> {
  const repo = typeof args?.repo === "string" ? args.repo : null;
  if (!repo || !MUTATING_COMMANDS.has(command)) return invoke<T>(command, args);
  // The background sweep owns the refresh. Its Git write still uses the
  // backend queue, but the foreground controls stay usable while it runs.
  if (command === "fetch_background") return invoke<T>(command, { ...args, expectedState: null });
  hooks.pending?.(repo, 1);
  const startedAt = Date.now();
  let refresh = true;
  try {
    if (command === "stage" && args?.review) {
      return await invoke<T>(command, { ...args, expectedState: null });
    }
    const stage = command === "stage" || (command === "apply_selection" && args?.mode === "stage");
    if (stage && typeof args?.expectedState !== "string") {
      const sourceHead = hooks.observedHead?.(repo);
      // Stage reads the selected files in the queue. Line staging also verifies
      // its displayed diff on the backend.
      if (sourceHead) return await invoke<T>(command, { ...args, expectedState: null, sourceHead });
    }
    if (command === "checkout" && args?.kind !== "commit" && !args?.choice && typeof args?.expectedState !== "string") {
      const sourceHead = hooks.observedHead?.(repo);
      if (sourceHead) {
        // The queued checkout observes current worktree changes and verifies this source HEAD itself.
        const result = await withConsent(invoke, repo, command, (consent) => invoke<T>(command, { ...args, expectedState: null, sourceHead, recoveryConsent: consent }));
        refresh = !(typeof result === "object" && result && "status" in result && result.status === "review");
        return result;
      }
    }
    let expectedState: string | null = null;
    if (!UNGUARDED.has(command)) {
      expectedState = typeof args?.expectedState === "string" ? args.expectedState : DISPLAYED_STATE.has(command) ? hooks.observed(repo) : null;
      if (!expectedState) {
        const displayed = hooks.observedHead?.(repo);
        const current = await invoke<StatusSummary>("status", { repo });
        if (displayed && (displayed.branch !== current.branch || displayed.oid !== current.oid)) {
          throw { kind: "stale-operation", message: "The current branch or commit changed. Review the refreshed view before trying again.", stderr: "", code: null, details: [] };
        }
        expectedState = current.stateToken ?? null;
      }
    }
    return await withConsent(invoke, repo, command, (consent) => invoke<T>(command, { ...args, expectedState, recoveryConsent: consent }));
  } finally {
    // Compound UI actions (commit then push, local then remote delete) must see
    // their own preceding mutation rather than reusing its now-stale token.
    // Refresh failures must not turn a successful Git mutation into a retryable error.
    if (refresh) {
      // The operation's completion event already starts a full read after the change; share it
      // instead of reading status and info a second time.
      const since = hooks.changeTime?.(repo, startedAt) ?? Date.now();
      const settled = await (hooks.settle?.(repo, since) ?? Promise.resolve(false)).catch(() => false);
      if (!settled) {
        await Promise.all([invoke<StatusSummary>("status", { repo }), invoke<RepoInfo>("repo_info", { repo })])
          .then(([status, info]) => hooks.refreshed(repo, status, info), () => {}).catch(() => {});
      }
    }
    hooks.pending?.(repo, -1);
  }
}
