import { describe, expect, it } from "vitest";
import { branchRef } from "./branchRef";

describe("branchRef", () => {
  it("keeps a local branch named like a remote one apart from the remote-tracking branch", () => {
    expect(branchRef("local", "origin/feature")).toBe("refs/heads/origin/feature");
    expect(branchRef("remote", "origin/feature")).toBe("refs/remotes/origin/feature");
  });

  it("qualifies plain and nested names", () => {
    expect(branchRef("local", "main")).toBe("refs/heads/main");
    expect(branchRef("local", "feature/login")).toBe("refs/heads/feature/login");
  });
});
