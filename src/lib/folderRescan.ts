/** Folder import: what a rescan keeps selected and how it describes the change. */

export interface ScanBefore {
  /** Repositories the previous scan found. */
  known: ReadonlySet<string>;
  /** Of those, the ones still selected. */
  selected: ReadonlySet<string>;
}

/** After a rescan: new repositories are selected, the user's choices for known ones are kept. */
export function rescanSelection(roots: string[], before: ScanBefore): Set<string> {
  return new Set(roots.filter(root => !before.known.has(root) || before.selected.has(root)));
}

/** The note above the list, for example "Rescanned: found 2 repositories more · 1 repository no longer found." */
export function rescanSummary(roots: string[], before: ScanBefore): string {
  const found = new Set(roots);
  const added = roots.filter(root => !before.known.has(root)).length;
  const gone = [...before.known].filter(root => !found.has(root)).length;
  const plural = (count: number) => `${count} ${count === 1 ? "repository" : "repositories"}`;
  const parts = [added ? `found ${plural(added)} more` : "", gone ? `${plural(gone)} no longer found` : ""].filter(Boolean);
  return parts.length ? `Rescanned: ${parts.join(" · ")}.` : "Rescanned: no changes.";
}
