import { describe, expect, it } from "vitest";
import { selectedCleanupItems } from "./branchCleanup";
import type { BranchCleanupReview, BranchCleanupMode, DeletionPlan } from "./types";

const ref = (name: string) => `refs/heads/${name}`;
function item(name: string, mode: BranchCleanupMode = "local", base = "main"): BranchCleanupReview["items"][number] {
  const plan: DeletionPlan = {
    proof: { name, localOid: "a".repeat(40), remoteOnly: mode === "remote", localPresent: true, baseRef: ref(base), baseOid: "b".repeat(40), target: null },
    bases: [], localOnly: null, remoteOnly: null, localUnmerged: 0, remoteUnmerged: null, localIntegration: "reachable", remoteIntegration: null,
    worktrees: [], currentChanges: 0, stateToken: "state",
  };
  return { request: { reference: ref(name), oid: plan.proof.localOid, mode }, plan, error: null, forceRequired: false };
}
const review = (...items: BranchCleanupReview["items"]) => ({ items, stateToken: "fresh" });
const references = (value: BranchCleanupReview | null, excluded: ReadonlySet<string>) => selectedCleanupItems(value, excluded).map(x => x.request.reference);

describe("cleanup keep decisions", () => {
  it("preserves excluded A across B scope changes, a new base and refreshed proofs", () => {
    const excluded = new Set([ref("A")]);
    expect(references(review(item("A"), item("B")), excluded)).toEqual([ref("B")]);
    expect(references(review(item("A"), item("B", "both")), excluded)).toEqual([ref("B")]);
    expect(references(review(item("A", "local", "develop"), item("B", "both", "develop")), excluded)).toEqual([ref("B")]);
    const refreshedB = item("B", "both", "develop"); refreshedB.plan!.proof.localOid = "c".repeat(40);
    const selected = selectedCleanupItems(review(item("A"), refreshedB), excluded);
    expect(selected.map(x => x.plan.proof.localOid)).toEqual(["c".repeat(40)]);
    expect(references(null, excluded)).toEqual([]);
    expect(references(review(item("A"), refreshedB), excluded)).toEqual([ref("B")]);
  });
  it("uses full references across reordering and distinguishes local/remote names", () => {
    const remote = item("A", "remote"); remote.request.reference = "refs/remotes/origin/A";
    expect(references(review(item("B"), remote, item("A")), new Set([ref("A")]))).toEqual([ref("B"), "refs/remotes/origin/A"]);
  });
  it("excludes invalid rows, retains keep decisions through invalidation and permits explicit re-inclusion", () => {
    const invalid = item("A"); invalid.plan = null; invalid.error = "Protected";
    const withError = item("B"); withError.error = "Stale";
    const excluded = new Set([ref("A")]);
    expect(references(review(invalid, withError, item("C")), excluded)).toEqual([ref("C")]);
    expect(references(review(item("A"), item("C")), excluded)).toEqual([ref("C")]);
    excluded.delete(ref("A"));
    expect(references(review(item("A"), item("C")), excluded)).toEqual([ref("A"), ref("C")]);
  });
});
