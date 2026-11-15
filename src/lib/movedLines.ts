import type { DiffHunk } from "./types";

/** Shortest trimmed text that counts as a moved line (blank lines and braces are everywhere). */
const MIN_MOVED = 8;

/** Lines whose text was removed in one place and added in another: `${hunk}:${line}` keys.
 *  A deletion directly followed by an identical addition is an edit (whitespace), not a move. */
export function movedLines(hunks: DiffHunk[], limit = 20_000): Set<string> {
  const removed = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  let seen = 0;
  hunks.forEach((h, hi) => h.lines.forEach((l, li) => {
    if (++seen > limit || (l.kind !== "+" && l.kind !== "-")) return;
    const text = l.text.trim();
    if (text.length < MIN_MOVED) return;
    const side = l.kind === "-" ? removed : added;
    const list = side.get(text) ?? [];
    list.push(`${hi}:${li}`);
    side.set(text, list);
  }));
  const out = new Set<string>();
  for (const [text, dels] of removed) {
    const adds = added.get(text);
    if (!adds) continue;
    for (const key of [...dels, ...adds]) out.add(key);
  }
  // Same text replaced in place (a run of deletions followed by its additions) is not a move.
  hunks.forEach((h, hi) => {
    let i = 0;
    while (i < h.lines.length) {
      if (h.lines[i].kind !== "-") { i++; continue; }
      const dels: number[] = [];
      while (i < h.lines.length && h.lines[i].kind === "-") dels.push(i++);
      const adds: number[] = [];
      while (i < h.lines.length && h.lines[i].kind === "+") adds.push(i++);
      dels.forEach((d, n) => {
        const a = adds[n];
        if (a !== undefined && h.lines[d].text.trim() === h.lines[a].text.trim()) { out.delete(`${hi}:${d}`); out.delete(`${hi}:${a}`); }
      });
    }
  });
  return out;
}
