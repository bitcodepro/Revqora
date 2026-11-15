import type { DiffHunk } from "./types";

export interface LinePos { h: number; l: number }

const changed = (hunks: DiffHunk[], p: LinePos) => {
  const k = hunks[p.h]?.lines[p.l]?.kind;
  return k === "+" || k === "-";
};

/** Changed lines from `a` to `b` in display order, across hunk boundaries (collapsed hunks are
 *  skipped, as they are not shown). Keys are `${hunk}:${line}`. */
export function lineRange(hunks: DiffHunk[], a: LinePos, b: LinePos, collapsed: Set<number> = new Set()): string[] {
  const before = (x: LinePos, y: LinePos) => x.h < y.h || (x.h === y.h && x.l <= y.l);
  const [from, to] = before(a, b) ? [a, b] : [b, a];
  const out: string[] = [];
  for (let h = from.h; h <= to.h; h++) {
    if (collapsed.has(h) && h !== from.h && h !== to.h) continue;
    const lines = hunks[h]?.lines ?? [];
    const start = h === from.h ? from.l : 0;
    const end = h === to.h ? to.l : lines.length - 1;
    for (let l = start; l <= end; l++) if (changed(hunks, { h, l })) out.push(`${h}:${l}`);
  }
  return out;
}

/** Contiguous runs of changed lines inside each hunk (the "blocks" a hunk can be split into).
 *  Returns, per hunk, the line index each run starts at and its line indexes. */
export function changeBlocks(hunk: DiffHunk): { start: number; lines: number[] }[] {
  const out: { start: number; lines: number[] }[] = [];
  let current: number[] | null = null;
  hunk.lines.forEach((line, i) => {
    if (line.kind === "+" || line.kind === "-") {
      if (!current) { current = []; out.push({ start: i, lines: current }); }
      current.push(i);
    } else if (line.kind === " ") {
      current = null;
    }
  });
  return out;
}
