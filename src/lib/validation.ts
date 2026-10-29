import { create } from "zustand";
import { api } from "./api";
import { useRepos } from "./store";
import type { ValidationReport } from "./types";

export const validationRunning = (r?: ValidationReport | null) => !!r && (r.phase === "queued" || r.phase === "running");
export function validationFresh(r: ValidationReport | null | undefined, token: string | null | undefined, dirty = false, root?: string): boolean {
  return !!r && (!root || r.repositoryRoot === root) && r.phase === "passed" && !dirty && !!token && r.beforeState === r.afterState && r.afterState === token;
}
interface Checks { reports: Record<string, ValidationReport | null>; set: (root: string, report: ValidationReport | null) => void; }
export const useValidation = create<Checks>((set) => ({ reports: {}, set: (root, report) => set((s) => ({ reports: { ...s.reports, [root]: report } })) }));
const polls = new Map<string, ReturnType<typeof setTimeout>>();
const requests = new Set<string>();
export async function refreshValidation(root: string) {
  if (polls.has(root) || requests.has(root)) return;
  requests.add(root);
  try {
    const r = await api.validationReport(root);
    useValidation.getState().set(root, r);
    if (validationRunning(r)) polls.set(root, setTimeout(() => { polls.delete(root); void refreshValidation(root).catch(() => {}); }, 300));
    else if (r) await useRepos.getState().refresh(root, { status: true, info: true, layers: true });
  } finally { requests.delete(root); }
}
