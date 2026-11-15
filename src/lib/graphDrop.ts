// Decides what a drag and drop in History or the Branches panel can do.
// Pure: no DOM, no store, no backend. The caller turns the result into menu items and runs
// the existing actions (merge, rebase, cherry-pick, reset, push, pull) for the chosen one.
import { plural, shortOid } from "./format";

export type DropBranchScope = "local" | "remote";

export interface DropBranchRef {
  scope: DropBranchScope;
  /** Short name: `feature/login` or `origin/feature/login`. */
  name: string;
}

export type DragItem =
  | ({ kind: "branch" } & DropBranchRef)
  /** Commits in the order they are applied (oldest first). */
  | { kind: "commits"; oids: string[] };

export type DropTarget =
  | ({ kind: "branch" } & DropBranchRef)
  | { kind: "commit"; oid: string; subject: string };

export interface DropBranch {
  name: string;
  oid: string;
  /** Short upstream name (`origin/main`) of a local branch. */
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}

export interface DropRepoState {
  /** The checked-out branch; null while HEAD is detached. */
  head: string | null;
  /** The operation in progress (`merge`, `rebase`, `cherry-pick`, ...) or `none`. */
  operation: string;
  local: DropBranch[];
  remote: DropBranch[];
  /** Local branches checked out in another worktree. */
  otherWorktreeBranches: string[];
}

export type DropActionId = "merge" | "rebase" | "fast-forward" | "pull" | "push" | "cherry-pick" | "reset" | "compare";

/** What runs once the receiving branch is checked out. */
export type DropRun =
  /** Merge `source` into the checked-out branch (the merge dialog still asks for the strategy). */
  | { type: "merge"; source: string }
  /** Rebase the checked-out branch onto `onto` (a branch name or a commit). */
  | { type: "rebase"; onto: string }
  | { type: "cherry-pick"; oids: string[] }
  /** Reset the checked-out branch (the reset dialog still asks for the mode). */
  | { type: "reset"; oid: string; subject: string }
  /** Push the checked-out branch through the push dialog. */
  | { type: "push" }
  | { type: "pull"; branch: string; upstream: string; fastForwardOnly: boolean }
  | { type: "compare"; from: string; to: string };

export interface DropAction {
  id: DropActionId;
  /** The complete, truthful menu label, including a branch switch when one is needed. */
  label: string;
  /** Extra explanation for an enabled item. */
  hint?: string;
  /** Why the action cannot run now. The item is shown disabled with this reason. */
  disabled?: string;
  /** The local branch that must be checked out when `run` happens; null when none is needed. */
  branch: string | null;
  /** True when `branch` is not the current branch: it is checked out first and `run` is skipped
   *  if that fails or is cancelled. */
  switches: boolean;
  run: DropRun;
}

const OPERATION_NAMES: Record<string, string> = {
  merge: "merge",
  squash: "squash merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  am: "patch application",
  bisect: "bisect",
};

const fullRef = (ref: DropBranchRef) => `refs/${ref.scope === "local" ? "heads" : "remotes"}/${ref.name}`;

const findBranch = (repo: DropRepoState, ref: DropBranchRef) =>
  (ref.scope === "local" ? repo.local : repo.remote).find(branch => branch.name === ref.name);

/** Why an action whose receiving branch is `branch` cannot start, or undefined when it can. */
function blocker(repo: DropRepoState, branch: string): string | undefined {
  if (repo.operation !== "none") {
    return `Finish or abort the ${OPERATION_NAMES[repo.operation] ?? repo.operation} in progress first`;
  }
  if (repo.head === branch) return undefined;
  if (repo.head === null) return "HEAD is detached. Check out a branch first";
  if (repo.otherWorktreeBranches.includes(branch)) return `${branch} is checked out in another worktree`;
  return undefined;
}

function action(
  repo: DropRepoState,
  id: DropActionId,
  branch: string,
  labels: { current: string; switching: string },
  run: DropRun,
  extra: { hint?: string; disabled?: string } = {},
): DropAction {
  const switches = repo.head !== branch;
  const disabled = blocker(repo, branch) ?? extra.disabled;
  return {
    id,
    label: switches ? labels.switching : labels.current,
    ...(extra.hint && !disabled ? { hint: extra.hint } : {}),
    ...(disabled ? { disabled } : {}),
    branch,
    switches,
    run,
  };
}

/**
 * The actions offered when `item` is dropped on `target`, in menu order.
 * An empty list means the drop does nothing: no drop indicator and no menu.
 */
export function graphDropActions(item: DragItem, target: DropTarget, repo: DropRepoState): DropAction[] {
  if (item.kind === "commits") {
    // Commits onto a commit, or onto a remote-tracking branch, have no action.
    if (target.kind !== "branch" || target.scope !== "local" || !item.oids.length) return [];
    const onto = findBranch(repo, target);
    if (!onto) return [];
    const count = plural(item.oids.length, "commit");
    return [
      action(repo, "cherry-pick", onto.name, {
        current: `Cherry-pick ${count} onto ${onto.name}`,
        switching: `Switch to ${onto.name} and cherry-pick ${count}`,
      }, { type: "cherry-pick", oids: [...item.oids] }, {
        disabled: item.oids.length === 1 && item.oids[0] === onto.oid ? `This commit is already the tip of ${onto.name}` : undefined,
      }),
    ];
  }

  const source = findBranch(repo, item);
  if (!source) return [];

  if (target.kind === "commit") {
    // Only a local branch can be moved or replayed, and only onto another commit than its tip.
    if (item.scope !== "local" || source.oid === target.oid) return [];
    return [
      action(repo, "reset", source.name, {
        current: `Reset ${source.name} to this commit…`,
        switching: `Switch to ${source.name} and reset it to this commit…`,
      }, { type: "reset", oid: target.oid, subject: target.subject }),
      action(repo, "rebase", source.name, {
        current: `Rebase ${source.name} onto this commit`,
        switching: `Switch to ${source.name} and rebase it onto this commit`,
      }, { type: "rebase", onto: target.oid }),
    ];
  }

  const destination = findBranch(repo, target);
  if (!destination) return [];
  // The same branch on both sides.
  if (item.scope === target.scope && item.name === target.name) return [];

  const sameCommit = source.oid === destination.oid
    ? `${source.name} and ${destination.name} point to the same commit`
    : undefined;
  const actions: DropAction[] = [];

  if (target.scope === "local") {
    const tracked = item.scope === "remote" && destination.upstream === source.name;
    if (tracked) {
      const pull: DropRun = { type: "pull", branch: destination.name, upstream: source.name, fastForwardOnly: false };
      // Ahead/behind against the upstream is already known, so this fast-forward is certain.
      if ((destination.ahead ?? 0) === 0 && (destination.behind ?? 0) > 0) {
        actions.push(action(repo, "fast-forward", destination.name, {
          current: `Fast-forward ${destination.name} to ${source.name}`,
          switching: `Switch to ${destination.name} and fast-forward it to ${source.name}`,
        }, { ...pull, fastForwardOnly: true }, { hint: "Pull, fast-forward only" }));
      }
      actions.push(action(repo, "pull", destination.name, {
        current: `Pull ${destination.name} from ${source.name}`,
        switching: `Switch to ${destination.name} and pull from ${source.name}…`,
      }, pull));
    }
    actions.push(action(repo, "merge", destination.name, {
      current: `Merge ${source.name} into ${destination.name}…`,
      switching: `Switch to ${destination.name} and merge ${source.name}…`,
    }, { type: "merge", source: source.name }, { disabled: sameCommit }));
  }

  if (item.scope === "local") {
    if (target.scope === "remote" && source.upstream === destination.name) {
      actions.push(action(repo, "push", source.name, {
        current: `Push ${source.name} to ${destination.name}…`,
        switching: `Switch to ${source.name} and push it to ${destination.name}…`,
      }, { type: "push" }, { disabled: sameCommit && `Nothing to push: ${sameCommit}` }));
    }
    actions.push(action(repo, "rebase", source.name, {
      current: `Rebase ${source.name} onto ${destination.name}`,
      switching: `Switch to ${source.name} and rebase it onto ${destination.name}`,
    }, { type: "rebase", onto: destination.name }, { disabled: sameCommit }));
  }

  actions.push({
    id: "compare",
    label: `Compare ${source.name} with ${destination.name}`,
    branch: null,
    switches: false,
    run: { type: "compare", from: fullRef(target), to: fullRef(item) },
  });
  return actions;
}

/** A short name for the dragged item, shown beside the pointer. */
export function dragItemLabel(item: DragItem, subject?: string): string {
  if (item.kind === "branch") return item.name;
  if (item.oids.length !== 1) return plural(item.oids.length, "commit");
  return `${shortOid(item.oids[0])}${subject ? ` ${subject}` : ""}`;
}
