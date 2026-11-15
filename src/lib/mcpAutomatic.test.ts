import { describe, expect, it } from "vitest";
import { mcpNeedsApproval, pushesToTrackedUpstream } from "./mcpAutomatic";

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
    expect(mcpNeedsApproval("delete_only", "pull", {}, undefined, true)).toBe(true);
    expect(mcpNeedsApproval("delete_only", "push", { force: true })).toBe(true);
    expect(mcpNeedsApproval("delete_only", "cherry_pick_abort", {})).toBe(true);
    expect(mcpNeedsApproval("delete_only", "stash_drop", {})).toBe(true);
    expect(mcpNeedsApproval("delete_only", "stash_apply", {})).toBe(false);
    expect(mcpNeedsApproval("delete_only", "merge_pr", {})).toBe(true);
    // Publishing decisions an agent reading untrusted PR text must not make alone.
    expect(mcpNeedsApproval("delete_only", "review_pr", { reviewKind: "approve" })).toBe(true);
    expect(mcpNeedsApproval("delete_only", "review_pr", { reviewKind: "comment" })).toBe(false);
    expect(mcpNeedsApproval("delete_only", "push", {}, undefined, false, false)).toBe(true);
    expect(mcpNeedsApproval("delete_only", "push", {}, undefined, false, true)).toBe(false);
    expect(mcpNeedsApproval("delete_only", "review_workflow_step", {}, "prCleanup")).toBe(true);
    expect(mcpNeedsApproval("delete_only", "review_workflow_step", {}, "command")).toBe(true);
    expect(mcpNeedsApproval("delete_only", "review_workflow_step", {}, "checkClean")).toBe(false);
  });
  it("recognises a push to the branch's own upstream", () => {
    expect(pushesToTrackedUpstream({}, "feature", "origin/feature")).toBe(true);
    expect(pushesToTrackedUpstream({ remote: "origin", remoteBranch: "feature" }, "feature", "origin/feature")).toBe(true);
    expect(pushesToTrackedUpstream({ remoteBranch: "main" }, "feature", "origin/feature")).toBe(false);
    expect(pushesToTrackedUpstream({ remote: "fork" }, "feature", "origin/feature")).toBe(false);
    expect(pushesToTrackedUpstream({}, "feature", null)).toBe(false);
    expect(pushesToTrackedUpstream({}, "feat", "origin/team/feat")).toBe(false);
  });
});
