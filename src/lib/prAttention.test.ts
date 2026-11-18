import { describe, expect, it } from "vitest";
import { attentionCandidates, attentionReasons, attentionRows, matchesAttention, needsFacts, type AttentionFacts } from "./prAttention";
import type { PrAuthor } from "./prAuthors";
import type { ForgeInfo, PrAttention, PullRequest } from "./types";

const me: PrAuthor = { key: "id:1", label: "alice", login: "alice" };
const pull = (number: number, change: Partial<PullRequest> = {}): PullRequest => ({
  number, title: `PR ${number}`, author: "bob", authorId: "2", authorLogin: "bob", head: `topic-${number}`, base: "main",
  url: `https://example.test/${number}`, draft: false, state: "open", created: `2026-11-${String(10 + number).padStart(2, "0")}T00:00:00Z`, headSha: `sha${number}`,
  ...change,
});
const mine = (number: number, change: Partial<PullRequest> = {}) => pull(number, { author: "alice", authorId: "1", authorLogin: "alice", ...change });
const facts = (number: number, change: Partial<PrAttention> = {}): AttentionFacts => ({
  value: { number, revision: "r", headSha: `sha${number}`, checkedAt: 1_000, ci: "passed", failedChecks: [], merge: "blocked", blockers: ["Needs approval"], ...change },
});
const kinds = (reasons: { kind: string }[]) => reasons.map(r => r.kind);

describe("Needs attention reasons", () => {
  it("lists a review request for you only while you have not reviewed", () => {
    expect(attentionReasons(pull(1, { reviewers: [{ id: "1", login: "alice", name: "Alice", state: "requested" }] }), me))
      .toEqual([{ kind: "review", text: "Your review is requested" }]);
    expect(attentionReasons(pull(1, { reviewers: [{ id: "1", login: "alice", name: "Alice", state: "approved" }] }), me)).toEqual([]);
    expect(attentionReasons(pull(1, { reviewers: [{ id: "9", login: "core", name: "Core", state: "requested", group: true }] }), me)).toEqual([]);
    expect(attentionReasons(pull(1, { reviewers: [{ id: "3", login: "cy", name: "Cy", state: "requested" }] }), me)).toEqual([]);
  });

  it("reads the review state when the list does not report it, and says when it could not", () => {
    const gitlab = pull(2, { reviewers: [{ id: "1", login: "alice", name: "Alice", state: "unknown" }] });
    expect(needsFacts(gitlab, me)).toBe(true);
    expect(attentionReasons(gitlab, me, { loading: true })).toEqual([]);
    expect(kinds(attentionReasons(gitlab, me, facts(2, { reviewers: [{ id: "1", login: "alice", name: "Alice", state: "requested" }] })))).toEqual(["review"]);
    expect(attentionReasons(gitlab, me, facts(2, { reviewers: [{ id: "1", login: "alice", name: "Alice", state: "commented" }] }))).toEqual([]);
    expect(attentionReasons(gitlab, me, { error: "HTTP 403" })).toEqual([{ kind: "check", text: "Your review state unavailable: HTTP 403" }]);
  });

  it("names what your own request needs: changes, conflicts, failed CI or a merge", () => {
    const pr = mine(3, { signals: { changesRequested: 2, conflicts: true } });
    expect(attentionReasons(pr, me, facts(3, { ci: "failed", failedChecks: ["build", "lint"] }))).toEqual([
      { kind: "changes", text: "Changes requested by 2 reviewers" },
      { kind: "changes", text: "Merge conflicts with main" },
      { kind: "ci", text: "CI failed: build, lint" },
    ]);
    expect(attentionReasons(mine(4), me, facts(4, { merge: "ready", blockers: [] })))
      .toEqual([{ kind: "merge", text: "Ready to merge: the server reports nothing blocking" }]);
    expect(attentionReasons(mine(4), me, facts(4))).toEqual([]);
  });

  it("never treats an unread or outdated status as fine", () => {
    expect(kinds(attentionReasons(mine(5), me))).toEqual(["check"]);
    expect(attentionReasons(mine(5), me, { error: "Rate limited" })).toEqual([{ kind: "check", text: "CI and merge status unavailable: Rate limited" }]);
    expect(attentionReasons(mine(5), me, { skipped: "Not checked: too many." })).toEqual([{ kind: "check", text: "Not checked: too many." }]);
    // An answer for an earlier head commit (CI ran on another push) is ignored.
    expect(kinds(attentionReasons(mine(5, { headSha: "new" }), me, facts(5, { merge: "ready", blockers: [] })))).toEqual(["check"]);
    // While a refresh reads it again, the earlier answer for the same head still counts.
    expect(kinds(attentionReasons(mine(5), me, { ...facts(5, { ci: "failed" }), loading: true }))).toEqual(["ci"]);
  });

  it("asks for a check where the provider cannot confirm merge readiness", () => {
    expect(kinds(attentionReasons(mine(6), me, facts(6, { merge: "unknown", blockers: [] })))).toEqual(["check"]);
    expect(kinds(attentionReasons(mine(6, { draft: true }), me, facts(6, { merge: "unknown", blockers: [] })))).toEqual([]);
  });

  it("needs an identity and an open request", () => {
    expect(attentionReasons(mine(7), null)).toEqual([]);
    expect(attentionReasons(mine(7, { state: "merged" }), me)).toEqual([]);
    expect(needsFacts(mine(7, { state: "closed" }), me)).toBe(false);
  });
});

describe("Attention queue", () => {
  const forge = { kind: "github", project: "team/repo", api: "https://api.github.com" } as ForgeInfo;
  const items = [mine(1), pull(2, { reviewers: [{ id: "1", login: "alice", name: "Alice", state: "requested" }] }), pull(3), mine(4)];
  const groups = {
    "/b": { forge, author: me, items, attention: { 1: facts(1, { ci: "failed" }), 4: facts(4, { merge: "ready", blockers: [] }) } },
    "/a": { forge, author: me, items: [mine(1, { headSha: "sha1" })], attention: { 1: { error: "HTTP 502" } } },
    "/none": { forge: null, author: null, items: [] },
  };

  it("filters by reason and orders rows the same way for every filter", () => {
    const any = attentionRows(groups, "any");
    expect(any.map(r => [r.root, r.pull.number])).toEqual([["/b", 4], ["/b", 2], ["/a", 1], ["/b", 1]]);
    expect(attentionRows(groups, "ci").map(r => [r.root, r.pull.number])).toEqual([["/b", 1]]);
    expect(attentionRows(groups, "merge").map(r => r.checkedAt)).toEqual([1_000]);
    expect(attentionRows(groups, "review").map(r => r.pull.number)).toEqual([2]);
    expect(attentionRows(groups, "check").map(r => r.root)).toEqual(["/a"]);
    expect(attentionRows(groups, "all")).toHaveLength(5);
    expect(matchesAttention([], "any")).toBe(false);
  });

  it("reads at most the newest requests of one repository and reports the rest", () => {
    const many = Array.from({ length: 5 }, (_, i) => mine(i + 1));
    expect(attentionCandidates([...many, pull(9)], me, 3)).toEqual({ check: [5, 4, 3], skipped: [2, 1] });
    expect(attentionCandidates(many, null)).toEqual({ check: [], skipped: [] });
  });
});
