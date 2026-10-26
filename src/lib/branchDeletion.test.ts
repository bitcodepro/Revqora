import { describe, expect, it } from "vitest";
import { deletionTargetKey, remoteDeletionRefspec, type RemoteBranchTarget } from "./branchDeletion";

const target: RemoteBranchTarget = { label: "origin/topic", remote: "origin", remoteRef: "refs/heads/topic", trackingRef: "refs/remotes/origin/topic2", oid: "abc", isUpstream: true };

describe("remote deletion targets", () => {
  it("deletes the resolved server ref even when its tracking ref has another name", () => {
    expect(remoteDeletionRefspec(target)).toBe(":refs/heads/topic");
  });
  it("distinguishes targets with identical display labels", () => {
    expect(deletionTargetKey({ ...target, remote: "team/upstream", remoteRef: "refs/heads/topic" })).not.toBe(deletionTargetKey({ ...target, remote: "team", remoteRef: "refs/heads/upstream/topic" }));
  });
  it("refuses missing, non-branch and wildcard destinations", () => {
    for (const remoteRef of ["", "refs/heads/", "refs/tags/topic", "refs/heads/*", "refs/heads/topic:other"]) {
      expect(() => remoteDeletionRefspec({ ...target, remoteRef })).toThrow();
    }
  });
});
