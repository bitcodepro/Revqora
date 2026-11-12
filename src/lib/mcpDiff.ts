import { McpToolError } from "./mcpErrors";
import type { DiffLine, FileDiff, IndexConflictSide } from "./types";

export interface DiffPageOptions { offset?: number; limit?: number; diffVersion?: string; lineOffset?: number; conflictSide?: "base" | "ours" | "theirs" }
const encoder = new TextEncoder();
const PAGE_BYTES = 112_000;

export function assertDiffVersion(version: string, options: DiffPageOptions) {
  if (options.diffVersion !== undefined && options.diffVersion !== version) {
    throw new McpToolError("diff_changed", "The diff changed. Restart at offset 0 and use the new diffVersion.");
  }
  if (!options.diffVersion && ((options.offset ?? 0) > 0 || options.lineOffset !== undefined)) {
    throw new McpToolError("diff_version_required", "Pass diffVersion from the first page when requesting another page or continuing a line.");
  }
}

function textChunk(text: string, start: number, size: number) {
  const lowSurrogateAt = (at: number) => {
    const code = text.charCodeAt(at);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  if (start > text.length || lowSurrogateAt(start)) throw new McpToolError("invalid_arguments", "Use the nextTextOffset from the preceding line chunk.");
  let end = Math.min(text.length, start + size);
  if (lowSurrogateAt(end)) end--;
  return { text: text.slice(start, end), nextTextOffset: end < text.length ? end : null };
}

type PageLine = DiffLine & { lineIndex: number; nextTextOffset: number | null };

export function diffPage(diff: FileDiff, options: DiffPageOptions) {
  const { hunks, hash: diffVersion, ...summary } = diff;
  assertDiffVersion(diffVersion, options);
  if (options.conflictSide) throw new McpToolError("invalid_arguments", "conflictSide applies only to a conflicted file.");
  const offset = options.offset ?? 0;
  const lineOffset = options.lineOffset;
  const limit = lineOffset === undefined ? options.limit ?? 400 : 1;
  const total = hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
  if (lineOffset !== undefined && offset >= total) throw new McpToolError("invalid_arguments", "The requested diff line does not exist.");
  const items: { header: string; lines: PageLine[] }[] = [];
  let start = 0, returned = 0, size = 0, lineTextTruncated = false;
  for (const { lines, header } of hunks) {
    if (returned === limit) break;
    const first = Math.max(0, offset - start);
    if (first < lines.length) {
      const item: (typeof items)[number] = { header: header.slice(0, 600), lines: [] };
      const headerSize = encoder.encode(JSON.stringify(item)).length + 1;
      for (let i = first; i < lines.length && returned < limit; i++) {
        const chunk = textChunk(lines[i].text, lineOffset ?? 0, lineOffset === undefined ? 600 : 16_000);
        const line = { ...lines[i], ...chunk, lineIndex: start + i };
        const bytes = encoder.encode(JSON.stringify(line)).length + 1 + (item.lines.length ? 0 : headerSize);
        if (size + bytes > PAGE_BYTES) break;
        item.lines.push(line);
        size += bytes;
        returned++;
        lineTextTruncated ||= line.nextTextOffset !== null;
      }
      if (item.lines.length) items.push(item);
      if (first + item.lines.length < lines.length) break;
    }
    start += lines.length;
  }
  const next = offset + returned;
  return { ...summary, diffVersion, hunks: items, totalLines: total, lineTextTruncated,
    nextOffset: lineOffset === undefined && next < total ? next : null };
}

export function conflictSidePage(side: IndexConflictSide | null, options: DiffPageOptions) {
  if (!side || side.text === null) return side;
  const offset = options.offset ?? 0;
  const lines = side.text ? side.text.split("\n") : [];
  const end = offset + Math.min(options.limit ?? 40, 40);
  const selected = lines.slice(offset, end);
  const text = selected.map(line => textChunk(line, 0, 240));
  const truncatedLines = text.flatMap((line, i) => line.nextTextOffset === null ? [] : [{ lineIndex: offset + i, nextTextOffset: line.nextTextOffset }]);
  return { ...side, text: text.map(line => line.text).join("\n"),
    totalLines: lines.length, lineTextTruncated: truncatedLines.length > 0, truncatedLines, nextOffset: end < lines.length ? end : null };
}

export function conflictLine(side: IndexConflictSide | null, offset: number, lineOffset: number) {
  const line = side?.text?.split("\n")[offset];
  if (line === undefined) throw new McpToolError("invalid_arguments", "The requested conflict line does not exist or is unavailable.");
  return { ...textChunk(line, lineOffset, 16_000), lineIndex: offset };
}
