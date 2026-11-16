import { describe, expect, it } from "vitest";
import { branchRef, readableMergeMessage } from "./branchRef";

describe("branchRef", () => {
  it("keeps a local branch named like a remote one apart from the remote-tracking branch", () => {
    expect(branchRef("local", "origin/feature")).toBe("refs/heads/origin/feature");
    expect(branchRef("remote", "origin/feature")).toBe("refs/remotes/origin/feature");
  });

  it("qualifies plain, nested and object-id-like names", () => {
    expect(branchRef("local", "main")).toBe("refs/heads/main");
    expect(branchRef("local", "feature/login")).toBe("refs/heads/feature/login");
    // A branch named like a full commit id must not be passed bare: Git reads the id first.
    const id = "a".repeat(40);
    expect(branchRef("local", id)).toBe(`refs/heads/${id}`);
  });
});

describe("readableMergeMessage", () => {
  it("shows the short branch name Git would have used for a short argument", () => {
    expect(readableMergeMessage("Merge branch 'refs/heads/hotfix/greeting'")).toBe("Merge branch 'hotfix/greeting'");
    expect(readableMergeMessage("Merge branch 'refs/heads/topic' into side\n\n# Conflicts:\n#\tfile.txt\n"))
      .toBe("Merge branch 'topic' into side\n\n# Conflicts:\n#\tfile.txt\n");
    expect(readableMergeMessage("Merge remote-tracking branch 'refs/remotes/origin/hotfix/g'")).toBe("Merge remote-tracking branch 'origin/hotfix/g'");
  });

  it("leaves other messages and the message body alone", () => {
    expect(readableMergeMessage("Merge commit 'abc123'")).toBe("Merge commit 'abc123'");
    expect(readableMergeMessage("Fix 'refs/heads/x' handling")).toBe("Fix 'refs/heads/x' handling");
    expect(readableMergeMessage("Merge branch 'main'\n\nSee 'refs/heads/main'")).toBe("Merge branch 'main'\n\nSee 'refs/heads/main'");
    expect(readableMergeMessage("")).toBe("");
  });
});
