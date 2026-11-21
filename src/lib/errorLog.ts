import { invoke } from "@tauri-apps/api/core";

export interface ErrorLogEntry {
  id: number;
  timestamp: number;
  source: string;
  code: string;
  message: string;
  count: number;
}

// Answers, not failures: a closed repository folder, a request a newer one replaced, the user's
// Cancel, a request refused because the repository changed meanwhile (nothing was done; the
// window or the MCP client asks again), and a pull request read without an API connection.
const NOT_FAILURES = new Set(["repository-folder-unavailable", "superseded", "cancelled", "scan-cancelled", "stale-operation", "pr-connection-required"]);
const reported = new WeakSet<object>();
const writes = new Set<Promise<unknown>>();

export function recordError(source: string, error: unknown, repository?: string) {
  if (typeof window === "undefined") return;
  const value = typeof error === "object" && error !== null ? error as Record<string, unknown> : null;
  // Not failures: a closed repository folder, a request a newer one replaced, the user's Cancel.
  if (typeof value?.kind === "string" && NOT_FAILURES.has(value.kind)) return;
  if (value && reported.has(value)) return;
  if (value) reported.add(value);
  const code = typeof value?.kind === "string" ? value.kind : error instanceof Error ? error.name : "error";
  const details = Array.isArray(value?.details) ? value.details
    .filter((detail): detail is string => typeof detail === "string" && /^(os_error=-?\d+|io_kind=\w+|http_status=\d{3}|request_id=[\w:.-]{1,128}|retry_after=\d+)$/.test(detail)) : [];
  const message = typeof value?.message === "string" ? value.message : String(error);
  // Keep arbitrary Git output and command arguments out of the shareable log.
  const write = invoke("error_log_record", {
    source, code, message: [message, ...details, ...(repository ? [`Repository: ${repository}`] : [])].join("\n").slice(0, 8192),
  })
    .catch(() => { if (value) reported.delete(value); });
  writes.add(write);
  void write.finally(() => writes.delete(write));
}

export async function readErrorLog() {
  await Promise.allSettled(writes);
  return invoke<ErrorLogEntry[]>("error_log_list");
}

export async function clearErrorLog() {
  await Promise.allSettled(writes);
  await invoke("error_log_clear");
}

export function installErrorReporting() {
  window.addEventListener("error", event => {
    if (event instanceof ErrorEvent) recordError("JavaScript", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", event => recordError("Unhandled promise", event.reason));
}
