import type { IgnoreKind } from "./types";

export interface IgnoreChoice { kind: IgnoreKind; path: string; label: string }

/** The ignore rules offered for a changed path: the file itself, its extension, and each
 *  folder above it (nearest first, at most three). */
export function ignoreChoices(path: string): IgnoreChoice[] {
  const clean = path.replace(/\/+$/, "");
  const parts = clean.split("/");
  const name = parts.at(-1) ?? clean;
  const out: IgnoreChoice[] = [{ kind: "file", path: clean, label: `Ignore ${name}` }];
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) out.push({ kind: "extension", path: clean, label: `Ignore all *.${name.slice(dot + 1)} files` });
  for (let depth = parts.length - 1; depth >= 1 && out.length < 5; depth--) {
    const folder = parts.slice(0, depth).join("/");
    out.push({ kind: "folder", path: folder, label: `Ignore folder ${folder}/` });
  }
  return out;
}

/** The last lines of the ignore file plus the added rule, for a compact preview. */
export function previewTail(before: string, after: string, context = 6): { kept: string[]; added: string[] } {
  const lines = (text: string) => { const body = text.replace(/\r\n/g, "\n").replace(/\n$/, ""); return body ? body.split("\n") : []; };
  const old = lines(before), next = lines(after);
  return { kept: old.slice(Math.max(0, old.length - context)), added: next.slice(old.length) };
}
