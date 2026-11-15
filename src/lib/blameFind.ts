/** Indexes of lines containing `query` (case-insensitive); empty query = no matches. */
export function findLines(lines: readonly string[], query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  lines.forEach((text, i) => {
    if (text.toLowerCase().includes(q)) out.push(i);
  });
  return out;
}

/** Position in `matches` of the next (or previous) match after line index `from`, wrapping around; -1 without matches. */
export function stepMatch(matches: readonly number[], from: number, backwards: boolean): number {
  if (!matches.length) return -1;
  if (backwards) {
    for (let k = matches.length - 1; k >= 0; k--) if (matches[k] < from) return k;
    return matches.length - 1;
  }
  const k = matches.findIndex((i) => i > from);
  return k < 0 ? 0 : k;
}

/** scrollTop that keeps row `index` (fixed `row` height) visible in a viewport of `viewH`. */
export function scrollToRow(index: number, row: number, scrollTop: number, viewH: number): number {
  const top = index * row;
  if (top < scrollTop) return top;
  if (top + row > scrollTop + viewH) return Math.max(0, top + row - viewH);
  return scrollTop;
}
