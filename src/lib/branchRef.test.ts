import { describe, expect, it } from "vitest";
import { branchRef, gitBranchArg } from "./branchRef";

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

describe("gitBranchArg", () => {
  const refs = (local: string[], remote: string[] = [], tags: string[] = []) => ({
    local: local.map(name => ({ name })), remote: remote.map(name => ({ name })), tags: tags.map(name => ({ name })),
  });

  it("uses the short name when Git resolves it to the same branch, so merge messages stay readable", () => {
    expect(gitBranchArg("refs/heads/hotfix/greeting", refs(["main", "hotfix/greeting"]))).toBe("hotfix/greeting");
    expect(gitBranchArg("refs/remotes/origin/feature", refs(["main"], ["origin/feature"]))).toBe("origin/feature");
  });

  it("keeps the full ref when a local branch shadows a remote-tracking branch of the same name", () => {
    const known = refs(["main", "origin/feature"], ["origin/feature"]);
    expect(gitBranchArg("refs/remotes/origin/feature", known)).toBe("refs/remotes/origin/feature");
    // The local branch itself wins Git's lookup, so its short name is still exact.
    expect(gitBranchArg("refs/heads/origin/feature", known)).toBe("origin/feature");
  });

  it("keeps the full ref when a tag shadows the branch", () => {
    expect(gitBranchArg("refs/heads/v1", refs(["v1"], [], ["v1"]))).toBe("refs/heads/v1");
    expect(gitBranchArg("refs/remotes/origin/v1", refs([], ["origin/v1"], ["origin/v1"]))).toBe("refs/remotes/origin/v1");
  });

  it("leaves commit ids, other refs and unknown repositories alone", () => {
    const id = "a".repeat(40);
    expect(gitBranchArg(id, refs(["main"]))).toBe(id);
    expect(gitBranchArg("refs/tags/v1", refs([], [], ["v1"]))).toBe("refs/tags/v1");
    expect(gitBranchArg("refs/heads/main", null)).toBe("refs/heads/main");
  });
});
