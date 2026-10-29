import { describe, expect, it } from "vitest";
import { deletionProtection, matchesRule } from "./branchProtection";
import type { RemoteBranchTarget } from "./types";
const target = (patch: Partial<RemoteBranchTarget> = {}): RemoteBranchTarget => ({ label:"origin/main", remote:"origin", pushUrl:"/server.git", remoteRef:"refs/heads/main", trackingRef:"refs/remotes/origin/innocent", oid:"a".repeat(40), isUpstream:true, ...patch });
describe("reviewed deletion protection", () => {
  it("checks a protected server source even when the selected local row and tracking alias are unprotected", () => {
    expect(deletionProtection(["main"],"topic",target())).toContain("main is protected");
    expect(deletionProtection(["main"],"topic",null)).toBeNull();
    expect(deletionProtection(["topic"],"topic",null)).toContain("topic is protected");
  });
  it("checks every newly selected or refreshed remote target", () => {
    expect(deletionProtection(["main","release/*"],"topic",target({remoteRef:"refs/heads/topic"}))).toBeNull();
    expect(deletionProtection(["main","release/*"],"topic",target())).toContain("protected");
    expect(deletionProtection(["main","release/*"],null,target({remoteRef:"refs/heads/release/v2",oid:"b".repeat(40)}))).toContain("release/v2 is protected");
    expect(deletionProtection(["origin/innocent"],null,target())).toContain("origin/innocent is protected");
  });
  it("distinguishes unchanged entry points from explicitly edited manager rules", () => {
    expect(deletionProtection(undefined,"main",target())).toBeNull();
    expect(deletionProtection([],"main",target())).toBeNull();
    expect(deletionProtection([""],"topic",target())).toContain("Invalid");
    expect(deletionProtection(["main"],null,target({remoteRef:"refs/tags/main"}))).not.toBeNull();
  });
  it("uses UTF-16 wildcard semantics in both layers", () => {
    expect(matchesRule("🦀","?")).toBe(false);
    expect(matchesRule("🦀","??")).toBe(true);
  });
});
