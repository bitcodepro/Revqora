import { describe, expect, it } from "vitest";
import { mcpNeedsApproval, mcpSyncOutcome } from "./mcpAutomatic";

describe("MCP approval modes", () => {
  it("preserves review by default and lets Full approve cover deletion", () => {
    expect(mcpNeedsApproval("ask", "commit", {})).toBe(true);
    expect(mcpNeedsApproval("full", "delete_branch", {})).toBe(false);
    expect(mcpNeedsApproval("full", "stash_drop", {})).toBe(false);
  });

  it("reviews the effects of an operation in delete-only mode", () => {
    expect(mcpNeedsApproval("delete_only", "stage", {})).toBe(false);
    expect(mcpNeedsApproval("delete_only", "fetch", {})).toBe(false);
    expect(mcpNeedsApproval("delete_only", "fetch", { prune: true })).toBe(true);
    expect(mcpNeedsApproval("delete_only", "pull", {}, undefined, false, true)).toBe(true);
    expect(mcpNeedsApproval("delete_only", "push", { force: true })).toBe(true);
    expect(mcpNeedsApproval("delete_only", "cherry_pick_abort", {})).toBe(true);
    expect(mcpNeedsApproval("delete_only", "stash_drop", {})).toBe(true);
    expect(mcpNeedsApproval("delete_only", "stash_apply", {})).toBe(false);
    expect(mcpNeedsApproval("delete_only", "merge_pr", {}, undefined, true)).toBe(true);
    expect(mcpNeedsApproval("delete_only", "review_workflow_step", {}, "prCleanup")).toBe(true);
    expect(mcpNeedsApproval("delete_only", "review_workflow_step", {}, "command")).toBe(true);
    expect(mcpNeedsApproval("delete_only", "review_workflow_step", {}, "checkClean")).toBe(false);
  });
});

it("reports incomplete Sync with its checkpoint and actual Git effect", () => {
  const result = { sent: true, received: false, checkpoint: { id: "checkpoint" }, warnings: [] };
  expect(mcpSyncOutcome(result, false, true).phase).toBeUndefined();
  expect(mcpSyncOutcome(result, true, true)).toMatchObject({
    phase: "partial", errorCode: "sync_incomplete", result: { received: false, sent: true, checkpoint: "checkpoint" },
  });
  expect(mcpSyncOutcome({ ...result, warnings: ["Server state changed"] }, false, true)).toMatchObject({
    phase: "partial", message: "Server state changed",
  });
});
