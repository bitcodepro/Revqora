/** Pure helpers for the sparse checkout tab and the sparse clone option. */

/** Normalizes a folder the way the backend does: forward slashes, no outer slashes. */
export function normalizeFolder(raw: string): { folder: string | null; error: string } {
  const folder = raw.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!folder || folder === ".") return { folder: null, error: "Top-level files are always included; enter a folder." };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(folder)) return { folder: null, error: "A folder cannot contain control characters." };
  for (const part of folder.split("/")) {
    if (!part || part === "." || part === "..") return { folder: null, error: `${raw.trim()} is not a plain relative folder path.` };
    if (part.toLowerCase() === ".git") return { folder: null, error: "The .git folder is never checked out." };
  }
  return { folder, error: "" };
}

/** Parses a one-folder-per-line list; blank lines are ignored, duplicates removed. */
export function parseFolderList(text: string): { folders: string[]; error: string } {
  const folders: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const { folder, error } = normalizeFolder(line);
    if (!folder) return { folders: [], error };
    if (!folders.includes(folder)) folders.push(folder);
  }
  return { folders, error: "" };
}

/** Every directory that contains a tracked file, sorted, from a recursive tree listing. */
export function directoriesOf(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    let i = path.lastIndexOf("/");
    while (i > 0) {
      const dir = path.slice(0, i);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      i = dir.lastIndexOf("/");
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

/**
 * Whether cone mode with `folders` checks out `path`: top-level files, everything under a
 * listed folder, and the files directly inside each ancestor of a listed folder.
 */
export function inCone(path: string, folders: readonly string[]): boolean {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return true;
  const parent = path.slice(0, slash);
  return folders.some((f) => path.startsWith(`${f}/`) || f === parent || f.startsWith(`${parent}/`));
}

export interface ConeCurrent { enabled: boolean; cone: boolean; folders: readonly string[] }

/**
 * Tracked files that would leave the working tree when cone mode switches to `next`, and how
 * many come back. Returns null when the current selection is non-cone (only Git can evaluate it).
 */
export function conePreview(paths: readonly string[], current: ConeCurrent, next: readonly string[]): { leaving: string[]; arriving: number } | null {
  if (current.enabled && !current.cone) return null;
  const now = (p: string) => !current.enabled || inCone(p, current.folders);
  const leaving: string[] = [];
  let arriving = 0;
  for (const p of paths) {
    const before = now(p);
    const after = inCone(p, next);
    if (before && !after) leaving.push(p);
    else if (!before && after) arriving++;
  }
  return { leaving, arriving };
}

/** Changed files (from status) inside `leaving`; Git keeps these in place. */
export function changedAmong(leaving: readonly string[], changed: readonly string[]): string[] {
  const set = new Set(leaving);
  return changed.filter((p) => set.has(p));
}

/** Non-cone patterns that select the same folders as cone mode (plus top-level files). */
export function coneToPatterns(folders: readonly string[]): string[] {
  return ["/*", "!/*/", ...folders.map((f) => `/${f}/`)];
}

/** Converts non-cone patterns to cone folders where a pattern names a plain directory. */
export function patternsToFolders(patterns: readonly string[]): { folders: string[]; dropped: string[] } {
  const folders: string[] = [];
  const dropped: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p || p === "/*" || p === "!/*/") continue;
    const m = /^\/?([^*?[\]!#]+?)\/?$/.exec(p);
    const folder = m ? normalizeFolder(m[1]).folder : null;
    if (folder && p.endsWith("/")) {
      if (!folders.includes(folder)) folders.push(folder);
    } else {
      dropped.push(p);
    }
  }
  return { folders, dropped };
}
