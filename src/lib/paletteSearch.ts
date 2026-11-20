// Ranking and filters of the command palette (Ctrl+N).

export type PaletteKind = "command" | "shortcut" | "repository" | "branch" | "folder";
export type PaletteFilter = "all" | "commands" | "shortcuts" | "repositories" | "branches" | "folders";

export const PALETTE_FILTERS: { id: PaletteFilter; label: string; placeholder: string }[] = [
  { id: "all", label: "All", placeholder: "Search commands, repositories, branches, folders…" },
  { id: "commands", label: "Commands", placeholder: "Search commands and menu actions…" },
  { id: "shortcuts", label: "Shortcuts", placeholder: "Search keyboard shortcuts to view or assign…" },
  { id: "repositories", label: "Repositories", placeholder: "Search repositories…" },
  { id: "branches", label: "Branches", placeholder: "Search local and remote branches…" },
  { id: "folders", label: "Folders", placeholder: "Search Explorer folders…" },
];

const KINDS: Record<PaletteFilter, PaletteKind[]> = {
  all: ["command", "repository", "branch", "folder"],
  commands: ["command"],
  shortcuts: ["shortcut"],
  repositories: ["repository"],
  branches: ["branch"],
  folders: ["folder"],
};

/** Kinds a filter shows. "All" leaves out the shortcut list: its commands are already there. */
export const filterKinds = (filter: PaletteFilter) => KINDS[filter];

/** The filter after `filter`, or before it with `back` (Tab / Shift+Tab in the palette). */
export function nextFilter(filter: PaletteFilter, back = false): PaletteFilter {
  const at = PALETTE_FILTERS.findIndex(item => item.id === filter);
  const n = PALETTE_FILTERS.length;
  return PALETTE_FILTERS[(at + (back ? n - 1 : 1)) % n]!.id;
}

/** How well `q` (lower case) matches `s`: exact 200, substring 100-20, letters in order 10, else 0. */
export function paletteScore(q: string, s: string): number {
  if (!q) return 1;
  const l = s.toLowerCase();
  const i = l.indexOf(q);
  if (l === q || l.replace(/…$/, "") === q) return 200;
  if (i >= 0) return 100 - Math.min(i, 80);
  let qi = 0;
  for (let k = 0; k < l.length && qi < q.length; k++) if (l[k] === q[qi]) qi++;
  return qi === q.length ? 10 : 0;
}

/** A command matched only by scattered letters, not by a word the user typed. */
const LOOSE = 10;

export interface PaletteEntry { kind: PaletteKind; label: string; context?: string; search?: string }

/**
 * Entries to show for `query` under `filter`, best first. Under "All", commands and menu
 * actions come first, then folders, repositories and branches; a command that matches only by
 * scattered letters comes after them, so it never hides the repository or branch typed by name.
 * An empty query lists commands under "All" and everything of the chosen kind under a filter.
 */
export function rankPalette<T extends PaletteEntry>(query: string, entries: T[], filter: PaletteFilter, limit = 60): T[] {
  const q = query.trim().toLowerCase();
  const kinds = filterKinds(filter);
  const tokens = q.split(/\s+/).filter(Boolean);
  const rank = (entry: T) => {
    const text = [entry.label, entry.context, entry.search].filter(Boolean).join(" ").toLowerCase();
    return paletteScore(q, entry.label) || (tokens.length && tokens.every(token => text.includes(token)) ? 12 : 0);
  };
  const tier = (entry: T, score: number) => entry.kind !== "command" && entry.kind !== "shortcut" ? 1 : score > LOOSE ? 0 : 2;
  const scored: { entry: T; score: number; tier: number; at: number }[] = [];
  entries.forEach((entry, at) => {
    if (!kinds.includes(entry.kind)) return;
    if (!q && filter === "all" && entry.kind !== "command") return;
    const score = rank(entry);
    if (score > 0) scored.push({ entry, score, tier: filter === "all" ? tier(entry, score) : 0, at });
  });
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score || a.at - b.at);
  return scored.slice(0, limit).map(item => item.entry);
}
