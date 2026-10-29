// Conflict-marker parsing used by the merge editor.

export interface ConflictBlock {
  /** 0-based line index of the "<<<<<<<" marker. */
  startLine: number;
  /** 0-based line index of the ">>>>>>>" marker. */
  endLine: number;
  /** Character offsets of the whole block (marker lines included, trailing newline included). */
  from: number;
  to: number;
  ours: string[];
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

const START = /^(<{7,})(?:\s|$)/;

/** Finds all well-formed conflict blocks in a text. */
export function parseConflicts(text: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  const lines = text.split("\n");
  const offsets: number[] = new Array(lines.length + 1);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = off;
    off += lines[i].length + 1;
  }
  offsets[lines.length] = Math.min(off, text.length);
  const strip = (l: string) => (l.endsWith("\r") ? l.slice(0, -1) : l);

  let i = 0;
  while (i < lines.length) {
    const line = strip(lines[i]);
    const opening = START.exec(line);
    if (!opening) {
      i++;
      continue;
    }
    const start = i;
    const width = opening[1].length;
    const marker = (value: string, character: string) => value === character.repeat(width) || value.startsWith(character.repeat(width) + " ");
    const oursLabel = line.slice(width).trim();
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let section: "ours" | "base" | "theirs" = "ours";
    let j = i + 1;
    let closed = false;
    let theirsLabel = "";
    for (; j < lines.length; j++) {
      const l = strip(lines[j]);
      if (START.test(l)) break; // malformed: nested start
      if (section === "ours" && marker(l, "|")) {
        section = "base";
        base = [];
        continue;
      }
      if ((section === "ours" || section === "base") && l === "=".repeat(width)) {
        section = "theirs";
        continue;
      }
      if (section === "theirs" && marker(l, ">")) {
        theirsLabel = l.slice(width).trim();
        closed = true;
        break;
      }
      if (section === "ours") ours.push(l);
      else if (section === "base") base!.push(l);
      else theirs.push(l);
    }
    if (closed) {
      blocks.push({
        startLine: start,
        endLine: j,
        from: offsets[start],
        to: j + 1 < lines.length ? offsets[j + 1] : text.length,
        ours,
        base,
        theirs,
        oursLabel,
        theirsLabel,
      });
      i = j + 1;
    } else {
      i = start + 1;
    }
  }
  return blocks;
}

export type Resolution = "ours" | "theirs" | "both" | "both-theirs-first" | "base" | "none";

/** Replacement text for a block (keeps a trailing newline if the block had one). */
export function resolveBlock(block: ConflictBlock, how: Resolution, eol = "\n", hadTrailingNewline = true): string {
  let lines: string[];
  switch (how) {
    case "ours":
      lines = block.ours;
      break;
    case "theirs":
      lines = block.theirs;
      break;
    case "both":
      lines = [...block.ours, ...block.theirs];
      break;
    case "both-theirs-first":
      lines = [...block.theirs, ...block.ours];
      break;
    case "base":
      lines = block.base ?? [];
      break;
    default:
      lines = [];
  }
  if (lines.length === 0) return "";
  return lines.join(eol) + (hadTrailingNewline ? eol : "");
}

/** Applies a resolution to one block of the text and returns the new text. */
export function applyResolution(text: string, block: ConflictBlock, how: Resolution): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const blockText = text.slice(block.from, block.to);
  const trailing = blockText.endsWith("\n");
  return text.slice(0, block.from) + resolveBlock(block, how, eol, trailing) + text.slice(block.to);
}

/** Resolves every block the same way. */
export function resolveAll(text: string, how: Resolution): string {
  let out = text;
  // Apply from the end so offsets stay valid.
  const blocks = parseConflicts(text).reverse();
  for (const b of blocks) out = applyResolution(out, b, how);
  return out;
}

/** Locates a sequence of lines inside a file (used to align side panes). Returns 0-based line or -1. */
export function findLines(haystack: string[], needle: string[], fromLine = 0): number {
  if (needle.length === 0) return -1;
  outer: for (let i = Math.max(0, fromLine); i <= haystack.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k].replace(/\r$/, "") !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}
