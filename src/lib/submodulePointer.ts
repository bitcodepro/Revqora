import type { FileDiff } from "./types";

/** The old and new commit of a submodule pointer change ("Subproject commit <oid>" lines), or
 *  null when the diff is not a gitlink change. A "-dirty" suffix (local edits) is dropped. */
export function submodulePointers(diff: FileDiff | null): { from: string | null; to: string | null } | null {
  if (!diff || diff.binary) return null;
  let from: string | null = null, to: string | null = null, seen = false;
  for (const h of diff.hunks) for (const l of h.lines) {
    const m = /^Subproject commit ([0-9a-f]{7,64})(?:-dirty)?$/.exec(l.text.trim());
    if (!m) continue;
    seen = true;
    if (l.kind === "-") from = m[1];
    else if (l.kind === "+") to = m[1];
  }
  return seen && (from || to) ? { from, to } : null;
}
