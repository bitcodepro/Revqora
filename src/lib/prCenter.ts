import type { PullRequest, PrState } from "./types";
import { repositoryKey } from "./repositoryLibrary";
export interface PrPreferences { state: PrState; section: "overview" | "files"; listOpen: boolean; filesOpen: boolean; listWidth: number; filesWidth: number }
export const prPreferencesKey = (root: string) => `revqora:pr-center:${repositoryKey(root)}`;
export function restorePrPreferences(value: unknown): PrPreferences {
  const p = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<PrPreferences> : {};
  const width = (n: unknown, min: number, max: number, fallback: number) => typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  return { state: ["open", "closed", "merged", "all"].includes(p.state ?? "") ? p.state! : "open", section: p.section === "files" ? "files" : "overview", listOpen: typeof p.listOpen === "boolean" ? p.listOpen : true, filesOpen: typeof p.filesOpen === "boolean" ? p.filesOpen : true, listWidth: width(p.listWidth, 200, 520, 280), filesWidth: width(p.filesWidth, 160, 480, 220) };
}
export function loadPrPreferences(root: string): PrPreferences { try { return restorePrPreferences(JSON.parse(localStorage.getItem(prPreferencesKey(root)) ?? "null")); } catch { return restorePrPreferences(null); } }
export function appendPullRequests(before: PullRequest[], page: PullRequest[]): PullRequest[] { const items = new Map(before.map(p => [p.number, p])); for (const p of page) items.set(p.number, p); return [...items.values()]; }
export function searchPullRequests(items: PullRequest[], query: string): PullRequest[] { const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean); return items.filter(p => terms.every(q => `${p.number} #${p.number} ${p.title} ${p.author} ${p.head} ${p.base} ${p.state}`.toLowerCase().includes(q))); }
export function pullRequestNumber(value: string): number | null { if (!/^#?[1-9]\d*$/.test(value.trim())) return null; const n = Number(value.trim().replace(/^#/, "")); return Number.isSafeInteger(n) ? n : null; }
export function safeWebUrl(value: string | null | undefined): string | null { if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null; try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !!u.hostname && !u.username && !u.password ? u.href : null; } catch { return null; } }
export const utf8Length = (value: string) => new TextEncoder().encode(value).length;
