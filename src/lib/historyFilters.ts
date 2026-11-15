import type { HistoryFilters } from "./types";

export const EMPTY_HISTORY_FILTERS: HistoryFilters = { author: "", path: "", since: "", until: "", firstParent: false, noMerges: false };

/** Calendar date in YYYY-MM-DD form. */
export function isValidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The first problem with the filters, or null when they can be sent. */
export function filterError(f: HistoryFilters): string | null {
  for (const value of [f.author, f.path, f.since, f.until]) if (value.trim().startsWith("-")) return "Filter values cannot start with '-'.";
  if (f.since && !isValidDate(f.since)) return "Enter the start date as YYYY-MM-DD.";
  if (f.until && !isValidDate(f.until)) return "Enter the end date as YYYY-MM-DD.";
  if (f.since && f.until && f.since > f.until) return "The start date is after the end date.";
  return null;
}

/** Trimmed filters for the backend, or null when no filter is active. */
export function filterRequest(f: HistoryFilters): HistoryFilters | null {
  const req: HistoryFilters = {
    author: f.author.trim(),
    path: f.path.trim().replace(/\\/g, "/").replace(/\/+$/, ""),
    since: f.since.trim(),
    until: f.until.trim(),
    firstParent: f.firstParent,
    noMerges: f.noMerges,
  };
  return filterChips(req).length ? req : null;
}

export interface FilterChip {
  key: keyof HistoryFilters;
  label: string;
}

/** Active filters as removable chips. */
export function filterChips(f: HistoryFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.author.trim()) chips.push({ key: "author", label: `Author: ${f.author.trim()}` });
  if (f.path.trim()) chips.push({ key: "path", label: `Path: ${f.path.trim()}` });
  if (f.since.trim()) chips.push({ key: "since", label: `Since ${f.since.trim()}` });
  if (f.until.trim()) chips.push({ key: "until", label: `Until ${f.until.trim()}` });
  if (f.firstParent) chips.push({ key: "firstParent", label: "First parent only" });
  if (f.noMerges) chips.push({ key: "noMerges", label: "No merge commits" });
  return chips;
}

export function removeFilter(f: HistoryFilters, key: keyof HistoryFilters): HistoryFilters {
  return { ...f, [key]: EMPTY_HISTORY_FILTERS[key] };
}
