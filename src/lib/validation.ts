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
function schedulePoll(root: string) {
  if (!polls.has(root)) polls.set(root, setTimeout(() => { polls.delete(root); void refreshValidation(root).catch(() => {}); }, 300));
}
export async function refreshValidation(root: string) {
  if (polls.has(root) || requests.has(root)) return;
  requests.add(root);
  const observed = useValidation.getState().reports[root];
  let report: ValidationReport | null;
  try {
    report = await api.validationReport(root);
  } catch (e) {
    if (validationRunning(useValidation.getState().reports[root])) schedulePoll(root);
    throw e;
  } finally { requests.delete(root); }
  // A new start may publish Queued while an older IPC response is in flight.
  // Do not replace the new job or lose its suppressed request to refresh.
  const current = useValidation.getState().reports[root];
  if (current !== observed && current?.id !== report?.id) {
    if (validationRunning(current)) schedulePoll(root);
    return;
  }
  useValidation.getState().set(root, report);
  if (validationRunning(report)) schedulePoll(root);
  // The request guard covers only status IPC. Sidebar/layers refresh can be
  // slow, and must not prevent a newly confirmed check from polling.
  else if (report) await useRepos.getState().refresh(root, { status: true, info: true, layers: true });
}
