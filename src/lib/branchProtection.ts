import type { RemoteBranchTarget } from "./types";

/** User rules are literal branch names with * and ? wildcards, never regexes. */
export function matchesRule(name: string, pattern: string): boolean {
  let n = 0, p = 0, star = -1, retry = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) { n++; p++; }
    else if (pattern[p] === "*") { star = p++; retry = n; }
    else if (star >= 0) { p = star + 1; n = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Check the actual deletion set, not the row that opened the dialog. */
export function deletionProtection(rules: string[] | undefined, local: string | null, target: RemoteBranchTarget | null | undefined): string | null {
  if (rules === undefined) return null; // Other entry points retain their existing policy.
  if (rules.length > 100 || rules.some(r => !r.trim() || r.trim() !== r || r.length > 256)) return "Invalid Branch Manager protection rules. Reopen the review.";
  const names = local ? [local] : [];
  if (target) {
    if (!target.remoteRef.startsWith("refs/heads/")) return "Cannot establish the remote branch protected by these rules.";
    names.push(target.remoteRef.slice("refs/heads/".length), target.trackingRef.replace(/^refs\/remotes\//, ""));
  }
  const protectedName = names.find(name => rules.some(rule => matchesRule(name, rule)));
  return protectedName ? `${protectedName} is protected by Branch Manager rules. Change its rule before deleting this branch.` : null;
}
