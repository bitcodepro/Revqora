import type { ConflictInfo } from "./types";
import { create } from "zustand";

export const normalizeConflictText = (text: string) => text.replace(/\r\n/g, "\n");
export function conflictInitialText(info: ConflictInfo): string {
  // The working file may already contain partially resolved or manually edited blocks.
  return normalizeConflictText(info.working ?? info.merged);
}
export function conflictOutput(text: string, info: ConflictInfo): string {
  const crlf = info.working !== null ? info.working.includes("\r\n") : info.eolCrlf;
  return crlf ? normalizeConflictText(text).replace(/\n/g, "\r\n") : normalizeConflictText(text);
}
export interface ConflictDraft { info: ConflictInfo; text: string; token: string | null; }
export function sameConflictVersions(a: ConflictInfo, b: ConflictInfo) {
  const { stateToken: _a, ...left } = a;
  const { stateToken: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}
// Session-local buffers survive file/repository navigation. Explicit Save draft writes
// to disk through the guarded backend and creates a recovery checkpoint.
export const useConflictDrafts = create<{ version: number }>(() => ({ version: 0 }));
class Drafts extends Map<string, ConflictDraft> {
  set(key: string, draft: ConflictDraft) { super.set(key, draft); useConflictDrafts.setState((s) => ({ version: s.version + 1 })); return this; }
  delete(key: string) { const removed = super.delete(key); if (removed) useConflictDrafts.setState((s) => ({ version: s.version + 1 })); return removed; }
}
export const conflictDrafts = new Drafts();
export const conflictDraftKey = (root: string, path: string) => JSON.stringify([root, path]);
export function conflictHasUnsaved(root: string) {
  return [...conflictDrafts.entries()].some(([key, draft]) => (JSON.parse(key) as string[])[0] === root && draft.text !== conflictInitialText(draft.info));
}
