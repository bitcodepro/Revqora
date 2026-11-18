// Lines for copyable diagnostics reports. The backend (`diagnostics_report`) adds the Revqora
// and Git versions and the platform, and removes tokens, credentials and file contents.
import type { ErrorLogEntry } from "./errorLog";
import type { ConnectionCheckItem, ConnectionCheckReport, OperationLogDetail } from "./types";

export const CHECK_STATES: Record<ConnectionCheckItem["state"], string> = {
  ok: "Works", failed: "Failed", limited: "Limited", "not-verified": "Not verified", skipped: "Not checked",
};

export const CHECK_CAUSES: Record<NonNullable<ConnectionCheckItem["cause"]>, string> = {
  "no-credentials": "No credentials", "token-rejected": "Credential rejected", permission: "Insufficient permissions",
  "not-found": "Not found or no access", timeout: "Timed out", "rate-limit": "Rate limit", network: "Network or proxy",
  server: "Provider error", "ssh-host": "SSH host key", "invalid-response": "Incomplete response", other: "Other",
};

const SYMBOLS: Record<ConnectionCheckItem["state"], string> = { ok: "✓", failed: "✗", limited: "!", "not-verified": "?", skipped: "–" };

/** "HTTP 403 · request ID … · 210 ms" for one check. */
export function checkFacts(item: ConnectionCheckItem) {
  return [item.httpStatus && `HTTP ${item.httpStatus}`, item.code && `code ${item.code}`, item.requestId && `request ID ${item.requestId}`, `${item.ms} ms`]
    .filter(Boolean).join(" · ");
}

export function connectionLines(report: ConnectionCheckReport): string[] {
  const lines = [
    "Operation: Check connection",
    `Repository: ${report.repository}`,
    `Remote: ${report.remote ?? "none"}${report.url ? ` · ${report.url}` : ""}${report.transport ? ` (${report.transport})` : ""}`,
    `Provider: ${report.provider ? `${report.provider}${report.project ? ` · ${report.project}` : ""}` : "not detected"}`,
    `Credentials: ${report.credentialSource ?? "—"}`,
    "",
  ];
  for (const item of report.items) {
    lines.push(`${SYMBOLS[item.state]} ${item.label}: ${CHECK_STATES[item.state]} · ${checkFacts(item)}`);
    lines.push(`  ${item.detail}`);
    if (item.cause) lines.push(`  Cause: ${CHECK_CAUSES[item.cause]}`);
    if (item.next) lines.push(`  Next step: ${item.next}`);
  }
  return lines;
}

export function errorLogLines(entry: ErrorLogEntry): string[] {
  return [
    `Operation: ${entry.source}`,
    `Error code: ${entry.code}`,
    `Recorded: ${new Date(entry.timestamp).toISOString()}${entry.count > 1 ? ` (×${entry.count})` : ""}`,
    "Message:",
    ...entry.message.split("\n").map(line => line.replace(/^http_status=/, "HTTP status: ").replace(/^request_id=/, "Request ID: ").replace(/^retry_after=/, "Retry after (s): ")
      .replace(/^Repository: (.+)$/, (_, path: string) => `Repository: ${basename(path)}`)),
  ];
}

const ms = (value: number | null) => value === null ? "—" : `${value} ms`;

/** One Operation log entry: result, timings and each Git command with its stderr (never stdout). */
export function operationLines({ entry, steps }: OperationLogDetail): string[] {
  const lines = [
    `Operation: ${entry.command}`,
    `Repository: ${basename(entry.repo)}`,
    `Status: ${entry.status}${entry.outcome ? ` · ${entry.outcome}` : ""}`,
    `Requested: ${new Date(entry.requestedAt).toISOString()}`,
    `Timings: queue wait ${ms(entry.waitMs)} · total ${ms(entry.durationMs)}`,
  ];
  if (entry.errorKind || entry.error) lines.push(`Error code: ${entry.errorKind ?? "—"}`, "Error:", ...(entry.error ?? "").split("\n"));
  lines.push("", `Git commands (${steps.length}):`);
  for (const step of steps) {
    lines.push(`git ${step.args.join(" ")} · exit ${step.exitCode ?? "—"} · ${ms(step.durationMs)}`);
    if (step.stderr) lines.push(...step.stderr.split("\n").slice(0, 20).map(line => `  ${line}`));
  }
  return lines;
}

/** Code, HTTP status and request ID of a failed request, as report lines. */
export function errorFacts(error: unknown): string[] {
  const value = typeof error === "object" && error !== null ? error as { kind?: unknown; details?: unknown } : {};
  const details = Array.isArray(value.details) ? value.details.filter((detail): detail is string => typeof detail === "string") : [];
  const detail = (key: string) => details.find(item => item.startsWith(`${key}=`))?.slice(key.length + 1);
  return [
    typeof value.kind === "string" && value.kind ? `Error code: ${value.kind}` : "",
    detail("http_status") ? `HTTP status: ${detail("http_status")}` : "",
    detail("request_id") ? `Request ID: ${detail("request_id")}` : "",
    detail("retry_after") ? `Retry after (s): ${detail("retry_after")}` : "",
  ].filter(Boolean);
}

export function pullRequestErrorLines(operation: string, repository: string, message: string, facts: string[] = [], provider?: string): string[] {
  return [`Operation: ${operation}`, `Repository: ${basename(repository)}`, ...(provider ? [`Provider: ${provider}`] : []), ...facts, "Message:", ...message.split("\n")];
}

function basename(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}
