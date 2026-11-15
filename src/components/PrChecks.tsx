import { CheckCircle2, CircleDashed, MinusCircle, XCircle } from "lucide-react";
import type { Check } from "../lib/types";

// Kept apart from the Pull Request Center so History can show a commit's CI state without loading it.
export function CheckIcon({ state, size = 14 }: { state: Check["state"]; size?: number }) {
  switch (state) {
    case "success": return <CheckCircle2 size={size} style={{ color: "var(--green)" }} />;
    case "failure": return <XCircle size={size} style={{ color: "var(--red)" }} />;
    case "pending": return <CircleDashed size={size} className="spin" style={{ color: "var(--amber)" }} />;
    default: return <MinusCircle size={size} style={{ color: "var(--text-faint)" }} />;
  }
}
export function summarizeChecks(checks: Check[]): Check["state"] | null { return !checks.length ? null : checks.some(c => c.state === "failure") ? "failure" : checks.some(c => c.state === "pending") ? "pending" : "success"; }
