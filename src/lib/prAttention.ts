import { matchesPrAuthor, samePrAuthor, type PrAuthor } from "./prAuthors";
import type { ForgeInfo, PrAttention, PrReviewer, PullRequest } from "./types";

/**
 * The "Needs attention" queue of the PR Center and of the MCP `pull_request_queue` tool.
 * Both build their rows with `attentionRows`, so the same scope and filter give the same list.
 */
export type AttentionKind = "review" | "changes" | "ci" | "merge" | "check";
export type AttentionFilter = "all" | "any" | AttentionKind;
export const ATTENTION_FILTERS: readonly { value: AttentionFilter; label: string }[] = [
  { value: "all", label: "All requests" },
  { value: "any", label: "Needs attention" },
  { value: "review", label: "Waiting for my review" },
  { value: "changes", label: "Needs my changes" },
  { value: "ci", label: "CI failed" },
  { value: "merge", label: "Ready to merge" },
  { value: "check", label: "Needs a check" },
];
export const isAttentionFilter = (value: unknown): value is AttentionFilter => ATTENTION_FILTERS.some(f => f.value === value);

export interface AttentionReason { kind: AttentionKind; text: string }
/** The provider read for one PR: its answer, its error, or that it was not read. */
export interface AttentionFacts { value?: PrAttention; error?: string; loading?: boolean; skipped?: string }

/** Provider reads per repository and refresh. Further PRs show "Needs a check". */
export const ATTENTION_CHECKS_PER_REPOSITORY = 20;
/** Provider reads at once across all repositories. */
export const ATTENTION_PARALLEL = 4;

const reviewerAuthor = (r: PrReviewer): PrAuthor =>
  ({ key: r.id ? `id:${r.id}` : r.login ? `login:${r.login.toLowerCase()}` : `name:${r.name}`, label: r.name || r.login, login: r.login });

/** The provider answer for the PR's current head commit; an answer for an older head is ignored. */
export function currentFacts(pull: PullRequest, facts?: AttentionFacts): PrAttention | undefined {
  return facts?.value && facts.value.headSha === pull.headSha ? facts.value : undefined;
}

function myReview(pull: PullRequest, viewer: PrAuthor, value?: PrAttention): PrReviewer | undefined {
  const list = value?.reviewers ?? pull.reviewers;
  return list?.find(r => !r.group && samePrAuthor(reviewerAuthor(r), viewer));
}

/** Open PRs whose CI, merge readiness or review state must be read from the provider. */
export function needsFacts(pull: PullRequest, viewer: PrAuthor | null): boolean {
  if (!viewer || pull.state !== "open") return false;
  if (matchesPrAuthor(pull, viewer)) return true;
  return myReview(pull, viewer)?.state === "unknown";
}

/** PR numbers to read, newest first, and those left out by the per-repository limit. */
export function attentionCandidates(items: PullRequest[], viewer: PrAuthor | null, limit = ATTENTION_CHECKS_PER_REPOSITORY): { check: number[]; skipped: number[] } {
  const wanted = items.filter(p => needsFacts(p, viewer)).sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0) || b.number - a.number).map(p => p.number);
  return { check: wanted.slice(0, limit), skipped: wanted.slice(limit) };
}

function notRead(facts: AttentionFacts | undefined, what: string): AttentionReason | null {
  if (facts?.loading) return null;
  if (facts?.error) return { kind: "check", text: `${what} unavailable: ${facts.error}` };
  if (facts?.skipped) return { kind: "check", text: facts.skipped };
  return { kind: "check", text: `${what} not checked yet. Refresh to check it.` };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why this PR needs the viewer, from list data and the provider read for its head commit. */
export function attentionReasons(pull: PullRequest, viewer: PrAuthor | null, facts?: AttentionFacts): AttentionReason[] {
  if (!viewer || pull.state !== "open") return [];
  const value = currentFacts(pull, facts);
  const reasons: AttentionReason[] = [];
  if (!matchesPrAuthor(pull, viewer)) {
    const review = myReview(pull, viewer, value);
    if (review?.state === "requested") reasons.push({ kind: "review", text: "Your review is requested" });
    else if (review?.state === "unknown") { const reason = notRead(facts, "Your review state"); if (reason) reasons.push(reason); }
    return reasons;
  }
  const s = pull.signals;
  if (s?.changesRequested) reasons.push({ kind: "changes", text: `Changes requested by ${plural(s.changesRequested, "reviewer", "reviewers")}` });
  if (s?.conflicts) reasons.push({ kind: "changes", text: `Merge conflicts with ${pull.base}` });
  if (!value) {
    const reason = notRead(facts, "CI and merge status");
    if (reason) reasons.push(reason);
    return reasons;
  }
  if (value.ci === "failed") reasons.push({ kind: "ci", text: value.failedChecks.length ? `CI failed: ${value.failedChecks.join(", ")}` : "CI failed" });
  if (value.merge === "ready") reasons.push({ kind: "merge", text: "Ready to merge: the server reports nothing blocking" });
  else if (value.merge === "unknown" && !pull.draft && value.ci !== "failed" && !s?.conflicts && !s?.changesRequested) {
    reasons.push({ kind: "check", text: "Merge readiness is not reported by this provider's API. Check it on the server." });
  }
  return reasons;
}

export function matchesAttention(reasons: AttentionReason[], filter: AttentionFilter): boolean {
  return filter === "all" || (filter === "any" ? reasons.length > 0 : reasons.some(r => r.kind === filter));
}

/** One repository's scan, as the PR Center and the MCP queue keep it. */
export interface AttentionGroup {
  forge: ForgeInfo | null;
  author: PrAuthor | null;
  items: PullRequest[];
  attention?: Record<number, AttentionFacts>;
}

export interface AttentionRow {
  root: string;
  forge: ForgeInfo;
  pull: PullRequest;
  reasons: AttentionReason[];
  /** When the provider was read for this PR (ms since epoch), if it was. */
  checkedAt: number | null;
}

/** The queue rows of `groups` for `filter`, newest first, in the same order everywhere. */
export function attentionRows(groups: Record<string, AttentionGroup>, filter: AttentionFilter): AttentionRow[] {
  return Object.entries(groups).flatMap(([root, group]) => {
    const forge = group.forge;
    if (!forge) return [];
    return group.items.flatMap(pull => {
      const facts = group.attention?.[pull.number];
      const reasons = filter === "all" ? [] : attentionReasons(pull, group.author, facts);
      if (!matchesAttention(reasons, filter)) return [];
      return [{ root, forge, pull, reasons, checkedAt: currentFacts(pull, facts)?.checkedAt ?? null }];
    });
  }).sort((a, b) => (Date.parse(b.pull.created) || 0) - (Date.parse(a.pull.created) || 0) || a.root.localeCompare(b.root) || a.pull.number - b.pull.number);
}

export const IDENTITY_NOTICE = "Revqora does not know your account here. Set My PR author or use a verified API account to see what needs you.";
