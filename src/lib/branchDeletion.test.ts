import { describe, expect, it } from "vitest";
import { deletionTargets } from "./branchDeletion";
import type { RefsSnapshot } from "./types";

function refs(upstream: string | null, remoteNames: string[], branches: string[]): RefsSnapshot {
  return { local: [{ name: "topic", upstream }], remotes: remoteNames.map((name) => ({ name })), remote: branches.map((name) => ({ name })) } as RefsSnapshot;
}

describe("remote deletion targets", () => {
  it("prefers the tracked remote ref even when it differs from the local name", () => {
    expect(deletionTargets(refs("backup/published/topic", ["origin", "backup"], ["origin/topic", "backup/published/topic", "origin/unrelated"]), "topic")).toEqual([
      { label: "backup/published/topic", remote: "backup", branch: "published/topic" },
      { label: "origin/topic", remote: "origin", branch: "topic" },
    ]);
  });
  it("matches configured remote names with slashes and never guesses unrelated refs", () => {
    expect(deletionTargets(refs("team/upstream/topic", ["team/upstream"], ["team/upstream/topic"]), "topic")).toEqual([{ label: "team/upstream/topic", remote: "team/upstream", branch: "topic" }]);
    expect(deletionTargets(refs("team/upstream/topic", ["team", "team/upstream"], ["team/upstream/topic"]), "topic")).toEqual([]);
    expect(deletionTargets(refs(null, ["origin"], ["origin/main", "unknown/topic"]), "topic")).toEqual([]);
  });
});
