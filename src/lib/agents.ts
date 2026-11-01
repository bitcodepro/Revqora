import type { AgentRequest } from "./types";
export const agentPresets = {
  codex: ["exec", "--sandbox", "workspace-write", "-"],
  claude: ["--print", "--permission-mode", "acceptEdits", "--no-session-persistence"],
  custom: [],
} as const;
export function agentArgs(text: string): string[] {
  const args: unknown = JSON.parse(text);
  if (!Array.isArray(args) || args.length > 64 || args.some(a => typeof a !== "string" || a.includes("\0") || a.length > 8192) || args.reduce((n, a) => n + a.length, 0) > 32768) throw new Error("Arguments must be a JSON array of up to 64 strings (32 KiB total).");
  return args;
}
export const agentActive = (phase: string) => ["queued", "running", "stopping", "external", "interrupted"].includes(phase);
export function agentProfileKey(root: string) { return `revqora.agent-profile:${root}`; }
export function loadAgentProfile(root: string): Pick<AgentRequest,"provider"|"executable"|"args"|"timeoutSeconds"> {
  const fallback = {provider:"codex" as const, executable:"", args:[...agentPresets.codex], timeoutSeconds:1800};
  try {
    const p = JSON.parse(localStorage.getItem(agentProfileKey(root)) ?? "null");
    if (!p || !Object.hasOwn(agentPresets,p.provider) || typeof p.executable !== "string" || !Number.isInteger(p.timeoutSeconds) || p.timeoutSeconds < 1 || p.timeoutSeconds > 14400) return fallback;
    return {provider:p.provider, executable:p.executable, args:agentArgs(JSON.stringify(p.args)), timeoutSeconds:p.timeoutSeconds};
  } catch { return fallback; }
}
