import type { ManagedBranch, Worktree } from "./types";
import { repositoryKey } from "./repositoryLibrary";

export const branchFilters = ["All", "Active", "Merged", "Unmerged", "Stale", "Diverged", "Protected"] as const;
export type BranchFilter = typeof branchFilters[number];
export interface BranchPreferences {
  base: string | null; scope: "all" | "local" | "remote"; filter: BranchFilter;
  sort: "recent" | "name" | "divergence"; staleDays: number; protections: string[];
}
export const defaults: BranchPreferences = { base: null, scope: "all", filter: "All", sort: "recent", staleDays: 90, protections: ["main", "master", "develop", "release/*"] };
export function restoreBranchPreferences(value: unknown): BranchPreferences {
  const v = value && typeof value === "object" ? value as Partial<BranchPreferences> : {};
  return {
    base: typeof v.base === "string" && /^refs\/(heads|remotes)\//.test(v.base) ? v.base : null,
    scope: v.scope === "local" || v.scope === "remote" ? v.scope : "all",
    filter: branchFilters.includes(v.filter as BranchFilter) ? v.filter! : "All",
    sort: v.sort === "name" || v.sort === "divergence" ? v.sort : "recent",
    staleDays: typeof v.staleDays === "number" && Number.isFinite(v.staleDays) ? Math.max(1, Math.min(3650, Math.round(v.staleDays))) : 90,
    protections: Array.isArray(v.protections) ? v.protections.filter((s): s is string => typeof s === "string" && !!s.trim() && s.length <= 256).slice(0, 100).map(s => s.trim()) : [...defaults.protections],
  };
}
export function preferencesKey(root: string) { return `revqora.branch-manager.${repositoryKey(root)}`; }
export function loadBranchPreferences(root: string) {
  try { return restoreBranchPreferences(JSON.parse(localStorage.getItem(preferencesKey(root)) ?? "null")); } catch { return restoreBranchPreferences(null); }
}
/** Linear wildcard matcher; user rules are never evaluated as regular expressions. */
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
export function isProtected(branch: ManagedBranch, rules: string[]) {
  return branch.protectionNames.some(name => rules.some(rule => matchesRule(name, rule)));
}
export function branchWorktrees(branch: ManagedBranch, worktrees: Worktree[]) {
  return branch.local ? worktrees.filter(w => w.branch === branch.name && !w.bare && !w.detached) : [];
}
export function matchesFilter(b: ManagedBranch, filter: BranchFilter, preferences: BranchPreferences, worktrees: Worktree[], now: number) {
  switch (filter) {
    case "Active": return b.current || branchWorktrees(b, worktrees).length > 0;
    case "Merged": return b.merged === true;
    case "Unmerged": return b.merged === false;
    case "Stale": return b.time > 0 && now / 1000 - b.time >= preferences.staleDays * 86400;
    case "Diverged": return b.ahead > 0 && b.behind > 0;
    case "Protected": return isProtected(b, preferences.protections);
    default: return true;
  }
}
export function selectBranches(branches: ManagedBranch[], preferences: BranchPreferences, search: string, worktrees: Worktree[], now = Date.now()) {
  const query = search.trim().toLocaleLowerCase();
  return branches.filter(b => (preferences.scope === "all" || b.local === (preferences.scope === "local")) &&
    (!query || [b.name, b.fullRef, b.author, b.subject, b.oid].some(s => s.toLocaleLowerCase().includes(query))) &&
    matchesFilter(b, preferences.filter, preferences, worktrees, now))
    .sort((a, b) => (preferences.sort === "name" ? a.name.localeCompare(b.name) : preferences.sort === "divergence" ? (b.ahead + b.behind) - (a.ahead + a.behind) : b.time - a.time) || a.fullRef.localeCompare(b.fullRef));
}
