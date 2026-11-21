import type { CommitDetails, FileDiff, GraphRow } from "./types";

// Memory a cached answer holds, estimated from its text (UTF-16, two bytes a character) plus a
// fixed cost per object. Cheap enough to run on every answer: no copy of the answer is made,
// as serializing it to measure would. Fields an answer lacks count for nothing.

const text = (value: string | null | undefined) => value?.length ?? 0;

/** A diff: dominated by its lines. */
export function diffBytes(diff: FileDiff): number {
  let chars = 200 + text(diff.path) + text(diff.oldPath);
  for (const hunk of diff.hunks ?? []) {
    chars += 60 + text(hunk.header);
    for (const line of hunk.lines ?? []) chars += 40 + line.text.length;
  }
  return chars * 2;
}

/** Commit details: the message and the changed files. */
export function detailsBytes(details: CommitDetails): number {
  let chars = 400 + text(details.subject) + text(details.body) + text(details.author) + text(details.authorEmail) + text(details.committer) + text(details.committerEmail) + 42 * (details.parents?.length ?? 0);
  for (const file of details.files ?? []) chars += 60 + file.path.length + text(file.oldPath);
  return chars * 2;
}

/** One History row: its text, labels and drawn lines. */
export function rowBytes(row: GraphRow): number {
  let chars = 160 + text(row.subject) + text(row.author) + text(row.email) + text(row.committer) + 42 * (row.parents?.length ?? 0) + 24 * (row.segs?.length ?? 0);
  for (const label of row.refs ?? []) chars += 30 + 2 * label.name.length;
  return chars * 2;
}
