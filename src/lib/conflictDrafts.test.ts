import { afterEach, describe, expect, it } from "vitest";
import { conflictDraftKey, conflictDrafts, conflictHasUnsaved } from "./conflictStudio";
import type { ConflictInfo } from "./types";
const info = { working: "on disk\n" } as ConflictInfo;
afterEach(() => conflictDrafts.clear());
describe("retained conflict drafts after external resolution", () => {
  it("stops blocking checks after Take ours, Mark resolved or external resolution removes the conflict", () => {
    const key = conflictDraftKey("repo", "resolved.txt");
    conflictDrafts.set(key, { info, text: "manual draft\n", token: "before" });
    expect(conflictHasUnsaved("repo", ["resolved.txt", "still-conflicted.txt"])).toBe(true);
    expect(conflictHasUnsaved("repo", ["still-conflicted.txt"])).toBe(false);
    // Resolving outside the editor must not silently destroy the manual buffer.
    expect(conflictDrafts.get(key)?.text).toBe("manual draft\n");
  });
  it("does not block after abort or close/reopen with no remaining conflicts", () => {
    const key = conflictDraftKey("repo", "f.txt");
    conflictDrafts.set(key, { info, text: "recover me", token: "before" });
    expect(conflictHasUnsaved("repo", [])).toBe(false);
    expect(conflictHasUnsaved("repo")).toBe(true); // unknown/loading status stays conservative
    expect(conflictHasUnsaved("other repo", ["f.txt"])).toBe(false);
    conflictDrafts.delete(key);
    expect(conflictHasUnsaved("repo", ["f.txt"])).toBe(false);
  });
});
