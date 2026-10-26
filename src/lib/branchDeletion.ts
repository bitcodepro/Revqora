import type { RemoteBranchTarget } from "./types";
export type { RemoteBranchTarget } from "./types";

export function deletionTargetKey(target: RemoteBranchTarget): string {
  return JSON.stringify([target.remote, target.remoteRef]);
}

export function remoteDeletionRefspec(target: RemoteBranchTarget): string {
  if (!target.remoteRef.startsWith("refs/heads/") || target.remoteRef.length === "refs/heads/".length || /[\s:*?\[\\]/.test(target.remoteRef)) {
    throw new Error("Cannot establish the server branch to delete. Reopen the dialog.");
  }
  return `:${target.remoteRef}`;
}
