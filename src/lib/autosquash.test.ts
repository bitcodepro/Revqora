import { describe, expect, it } from "vitest";
import { autosquash } from "./autosquash";
import type { PlanCommit } from "./types";

const c = (oid: string, subject: string, body = ""): PlanCommit => ({ oid: oid.repeat(40), subject, body, author: "Tester", time: 0 });

describe("autosquash preview", () => {
  it("moves fixups after the matching original without changing unrelated commits", () => {
    const a = c("a", "Add login"); const b = c("b", "Other work"); const fix = c("c", "fixup! Add login");
    const result = autosquash([a, b, fix]);
    expect(result.rows.map((r) => [r.oid, r.action])).toEqual([[a.oid, "pick"], [fix.oid, "fixup"], [b.oid, "pick"]]);
    expect(result.matched).toBe(1); expect(result.warnings).toEqual([]);
  });
  it("combines squash descriptions and supports abbreviated SHA and nested fixups", () => {
    const a = c("a", "Base", "Original description"); const b = c("b", "Other");
    const sq = c("c", "squash! aaaaaaa", "More context"); const fix = c("d", "fixup! squash! aaaaaaa");
    const result = autosquash([a, b, sq, fix]);
    expect(result.rows.map((r) => r.action)).toEqual(["pick", "squash", "fixup", "pick"]);
    expect(result.rows[0].message).toContain("Original description"); expect(result.rows[0].message).toContain("More context");
    expect(result.rows[0].message).not.toContain("fixup!");
  });
  it("keeps missing, ambiguous and forward targets as Pick with a visible warning", () => {
    const result = autosquash([c("a", "Same"), c("b", "Same"), c("c", "fixup! Same"), c("d", "fixup! Later"), c("e", "Later"), c("f", "squash! absent")]);
    expect(result.matched).toBe(0); expect(result.warnings).toHaveLength(3); expect(result.rows.every((r) => r.action === "pick")).toBe(true);
  });
  it("does not mutate the original plan and matches a unique subject prefix", () => {
    const source = [c("a", "Long subject"), c("b", "fixup! Long")];
    const copy = structuredClone(source); expect(autosquash(source).matched).toBe(1); expect(source).toEqual(copy);
  });
});
