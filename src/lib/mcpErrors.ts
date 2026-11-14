import { errorMessage, isGitError } from "./api";

export interface McpError {
  code: string;
  message: string;
  activeActionId?: string;
}

export class McpToolError extends Error {
  constructor(readonly code: string, message: string, readonly activeActionId?: string) {
    super(message);
  }
}

const gitErrorCodes = new Map([
  ["invalid-arguments", "invalid_arguments"],
  ["invalid-commit", "invalid_commit"],
  ["commit-not-found", "commit_not_found"],
  ["invalid-cursor", "invalid_cursor"],
  ["stale-operation", "stale_state"],
  ["not-conflicted", "stale_state"],
  ["operation-in-progress", "operation_in_progress"],
  ["conflict", "unresolved_conflicts"],
  ["git-missing", "git_unavailable"],
  ["git-timeout", "git_timeout"],
  ["auth", "provider_authentication_failed"],
  ["forge-network", "provider_unavailable"],
  ["forge-server", "provider_unavailable"],
  ["forge-write-uncertain", "result_unverified"],
  ["forge-rate-limit", "provider_rate_limited"],
  ["forge-http", "provider_error"],
  ["forge-graphql", "provider_error"],
  ["forge-account", "pr_connection_required"],
  ["identity-unavailable", "identity_unavailable"],
  ["pr-connection-required", "pr_connection_required"],
  ["file-not-found", "file_not_found"],
  ["checkpoint-failed", "checkpoint_failed"],
  ["output-limit", "result_too_large"],
]);

export function mcpError(reason: unknown): McpError {
  const code = reason instanceof McpToolError ? reason.code
    : isGitError(reason) ? gitErrorCodes.get(reason.kind) ?? "operation_failed" : "operation_failed";
  const message = errorMessage(reason).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[credentials]@").slice(0, 2000);
  return { code, message, ...(reason instanceof McpToolError && reason.activeActionId ? { activeActionId: reason.activeActionId } : {}) };
}
