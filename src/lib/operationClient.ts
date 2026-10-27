import type { RepoInfo, StatusSummary } from "./types";

export const MUTATING_COMMANDS = new Set([
  "identity_set", "apply_selection", "stage", "unstage", "discard", "commit", "commit_graph_write", "checkout", "branch_create", "branch_rename", "branch_delete", "branch_set_upstream", "tag_create", "tag_delete", "reset", "undo_commit", "fetch", "fetch_background", "pull", "push", "push_ref", "remote_add", "remote_remove", "remote_set_url", "merge_start", "op_abort", "op_continue", "op_skip", "cherry_pick", "revert", "rebase_onto", "interactive_rebase", "rewrite", "conflict_save", "conflict_take", "conflict_mark_resolved", "conflict_unresolve", "stash_save", "stash_apply", "stash_drop", "layer_seal", "layer_unstage", "layer_discard", "layer_merge_down", "layer_move", "layer_rename", "layers_flatten", "layer_preview", "layer_unstage_files", "layer_commit", "submodule_update", "submodule_add", "submodule_sync", "worktree_add", "worktree_remove", "worktree_lock", "worktree_prune", "bisect_start", "bisect_mark", "bisect_reset", "lfs_track", "lfs_run", "signing_set", "maintenance_run", "restore_branch", "apply_patch", "checkout_file", "apply_from_commit", "stash_restore_file", "pull_request_checkout",
]);

const UNGUARDED = new Set(["identity_set", "signing_set", "fetch", "fetch_background", "commit_graph_write", "maintenance_run", "worktree_lock", "worktree_prune", "submodule_sync"]);
const DISPLAYED_STATE = new Set(["commit", "apply_selection", "layer_commit", "layer_unstage", "layer_discard", "layer_merge_down", "layer_move", "layer_rename", "layer_unstage_files", "layers_flatten", "stash_apply", "stash_drop"]);

interface Hooks {
  observed: (repo: string) => string | null;
  observedHead?: (repo: string) => { branch: string | null; oid: string | null } | null;
  refreshed: (repo: string, status: StatusSummary, info: RepoInfo) => void;
  pending?: (repo: string, delta: number) => void;
}

let hooks: Hooks = { observed: () => null, refreshed: () => {} };
export function setOperationHooks(next: Hooks) { hooks = next; }

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Preserve the displayed precondition; never retry a rejected mutation automatically. */
export async function repositoryCall<T>(invoke: Invoke, command: string, args?: Record<string, unknown>): Promise<T> {
  const repo = typeof args?.repo === "string" ? args.repo : null;
  if (!repo || !MUTATING_COMMANDS.has(command)) return invoke<T>(command, args);
  hooks.pending?.(repo, 1);
  try {
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
    return await invoke<T>(command, { ...args, expectedState });
  } finally {
    // Compound UI actions (commit then push, local then remote delete) must see
    // their own preceding mutation rather than reusing its now-stale token.
    // Refresh failures must not turn a successful Git mutation into a retryable error.
    await Promise.all([invoke<StatusSummary>("status", { repo }), invoke<RepoInfo>("repo_info", { repo })])
      .then(([status, info]) => hooks.refreshed(repo, status, info), () => {}).catch(() => {});
    hooks.pending?.(repo, -1);
  }
}
