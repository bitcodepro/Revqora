import type { ForgeInfo, PullRequest, PrState } from "./types";
import { repositoryKey } from "./repositoryLibrary";
export interface PrPreferences { state: PrState; section: "overview" | "files" | "discussions"; listOpen: boolean; filesOpen: boolean; listWidth: number; filesWidth: number }
export const prPreferencesKey = (root: string) => `revqora:pr-center:${repositoryKey(root)}`;
export function restorePrPreferences(value: unknown): PrPreferences {
  const p = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<PrPreferences> : {};
  const width = (n: unknown, min: number, max: number, fallback: number) => typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  return { state: ["open", "closed", "merged", "all"].includes(p.state ?? "") ? p.state! : "open", section: p.section === "files" || p.section === "discussions" ? p.section : "overview", listOpen: typeof p.listOpen === "boolean" ? p.listOpen : true, filesOpen: typeof p.filesOpen === "boolean" ? p.filesOpen : true, listWidth: width(p.listWidth, 200, 520, 280), filesWidth: width(p.filesWidth, 160, 480, 220) };
}
export function loadPrPreferences(root: string): PrPreferences { try { return restorePrPreferences(JSON.parse(localStorage.getItem(prPreferencesKey(root)) ?? "null")); } catch { return restorePrPreferences(null); } }
export function appendPullRequests(before: PullRequest[], page: PullRequest[]): PullRequest[] { const items = new Map(before.map(p => [p.number, p])); for (const p of page) items.set(p.number, p); return [...items.values()]; }
export function searchPullRequests(items: PullRequest[], query: string): PullRequest[] { const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean); return items.filter(p => terms.every(q => `${p.number} #${p.number} ${p.title} ${p.author} ${p.head} ${p.base} ${p.state}`.toLowerCase().includes(q))); }
export function pullRequestNumber(value: string): number | null { if (!/^#?[1-9]\d*$/.test(value.trim())) return null; const n = Number(value.trim().replace(/^#/, "")); return Number.isSafeInteger(n) ? n : null; }
export function safeWebUrl(value: string | null | undefined): string | null { if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null; try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !!u.hostname && !u.username && !u.password ? u.href : null; } catch { return null; } }
export const utf8Length = (value: string) => new TextEncoder().encode(value).length;

const WRITE_ATTEMPT_PREFIX = "revqora:pr-write-attempt:";
// Authorization revisions/actors/local clones can change without changing the
// server-side write. Keep unresolved outcomes under the provider/repository.
export function forgeRepositoryIdentity(forge: Pick<ForgeInfo, "kind" | "api" | "project">): string {
  let api = forge.api;
  try { api = new URL(api).href; } catch { /* Backend validates connections. */ }
  return JSON.stringify([forge.kind, api.replace(/\/+$/, ""), forge.kind === "github" ? forge.project.toLowerCase() : forge.project]);
}
export const prWriteAttemptKey = (forge: Pick<ForgeInfo, "kind" | "api" | "project">, number: number | null) => WRITE_ATTEMPT_PREFIX + JSON.stringify(["v2", forgeRepositoryIdentity(forge), number]);
function legacyPrWriteKeys(key: string, root?: string): string[] {
  if (!root) return [];
  const number = JSON.parse(key.slice(WRITE_ATTEMPT_PREFIX.length))[2];
  return Object.keys(localStorage).filter(k => {
    if (!k.startsWith(WRITE_ATTEMPT_PREFIX)) return false;
    try { const old = JSON.parse(k.slice(WRITE_ATTEMPT_PREFIX.length)); return Array.isArray(old) && old.length === 3 && old[0] === repositoryKey(root) && old[2] === number; } catch { return false; }
  });
}
export function prWriteAttemptPending(key: string, root?: string): boolean {
  try { return localStorage.getItem(key) !== null || legacyPrWriteKeys(key, root).length > 0; } catch { return true; }
}
export function setPrWriteAttemptPending(key: string, pending: boolean, root?: string): void {
  const legacy = legacyPrWriteKeys(key, root);
  if (!pending) { for (const k of legacy) localStorage.removeItem(k); localStorage.removeItem(key); return; }
  if (!localStorage.getItem(key) && !legacy.length && Object.keys(localStorage).filter(k => k.startsWith(WRITE_ATTEMPT_PREFIX)).length >= 32) throw Error("Check pending PR write results on the server before sending more requests.");
  // Publish the stable marker before removing any old authorization-scoped
  // marker; a failed migration must never remove the only pending-result guard.
  localStorage.setItem(key, JSON.stringify({ updated: Date.now() }));
  for (const k of legacy) localStorage.removeItem(k);
}
