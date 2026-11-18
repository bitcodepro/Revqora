import { describe, expect, it } from "vitest";
import { mcpNeedsApproval, pushesToTrackedUpstream, withoutProgress } from "./mcpAutomatic";

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

describe("MCP Git output", () => {
  it("leaves out progress lines and keeps the result", () => {
    const output = ["Enumerating objects: 5, done.", "Counting objects:  20% (1/5)", "Counting objects: 100% (5/5), done.",
      "Writing objects:  33% (1/3)", "Writing objects: 100% (3/3), 421 bytes | 140.00 KiB/s, done.", "Total 3 (delta 1), reused 0 (delta 0)",
      "remote: Create pull request for feature:", "   c6af2ac..38df736  feature -> feature"].join("\n");
    expect(withoutProgress(output).split("\n")).toEqual(["Enumerating objects: 5, done.", "Counting objects: 100% (5/5), done.",
      "Writing objects: 100% (3/3), 421 bytes | 140.00 KiB/s, done.", "Total 3 (delta 1), reused 0 (delta 0)",
      "remote: Create pull request for feature:", "   c6af2ac..38df736  feature -> feature"]);
  });
});
