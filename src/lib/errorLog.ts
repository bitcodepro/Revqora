import { invoke } from "@tauri-apps/api/core";

export interface ErrorLogEntry {
  id: number;
  timestamp: number;
  source: string;
  code: string;
  message: string;
  count: number;
}

const reported = new WeakSet<object>();
const writes = new Set<Promise<unknown>>();

export function recordError(source: string, error: unknown, repository?: string) {
  if (typeof window === "undefined") return;
  const value = typeof error === "object" && error !== null ? error as Record<string, unknown> : null;
  if (value?.kind === "repository-folder-unavailable") return;
  if (value && reported.has(value)) return;
  if (value) reported.add(value);
  const code = typeof value?.kind === "string" ? value.kind : error instanceof Error ? error.name : "error";
  const details = Array.isArray(value?.details) ? value.details
    .filter((detail): detail is string => typeof detail === "string" && /^(os_error=-?\d+|io_kind=\w+)$/.test(detail)) : [];
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

export function installErrorReporting() {
  window.addEventListener("error", event => {
    if (event instanceof ErrorEvent) recordError("JavaScript", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", event => recordError("Unhandled promise", event.reason));
}
