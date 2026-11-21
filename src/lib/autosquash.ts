import type { PlanCommit, RebaseAction } from "./types";

export interface AutosquashRow extends PlanCommit { action: RebaseAction; message: string; }
export interface AutosquashResult { rows: AutosquashRow[]; warnings: string[]; matched: number; }
const message = (c: PlanCommit) => c.body ? `${c.subject}\n\n${c.body}` : c.subject;

/** Build a reviewable plan. Only unambiguous earlier targets are moved. */
export function autosquash(commits: PlanCommit[]): AutosquashResult {
  const rows: AutosquashRow[] = commits.map((c) => ({ ...c, action: "pick", message: message(c) }));
  const children = new Map<string, AutosquashRow[]>();
  const moved = new Set<string>();
  const warnings: string[] = [];
  // Earlier rows by subject, so an exact target is found without scanning them again.
  const bySubject = new Map<string, AutosquashRow[]>();
  const earlierWhere = (end: number, test: (r: AutosquashRow) => boolean) => {
    const found: AutosquashRow[] = [];
    for (let k = 0; k < end; k++) if (test(rows[k])) found.push(rows[k]);
    return found;
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prefix = /^(fixup|squash)! (.+)$/.exec(row.subject);
    const remember = () => { const same = bySubject.get(row.subject); if (same) same.push(row); else bySubject.set(row.subject, [row]); };
    if (!prefix) {
      remember();
      continue;
    }
    const target = prefix[2];
    // Full/abbreviated object IDs, then exact subject, then subject prefix.
    const id = target.toLowerCase();
    const byId = /^[0-9a-f]{4,64}$/i.test(target) ? earlierWhere(i, (r) => r.oid.startsWith(id)) : [];
    const exact = byId.length ? [] : bySubject.get(target) ?? [];
    const candidates = byId.length ? byId : exact.length ? exact : earlierWhere(i, (r) => r.subject.startsWith(target));
    remember();
    if (candidates.length !== 1) { warnings.push(`${row.subject}: ${candidates.length ? "ambiguous target" : "target is outside this range or missing"}; kept as Pick.`); continue; }
    row.action = prefix[1] === "fixup" ? "fixup" : "squash";
    const owner = candidates[0].oid;
    children.set(owner, [...(children.get(owner) ?? []), row]);
    moved.add(row.oid);
  }
  const ordered: AutosquashRow[] = [];
  const visit = (r: AutosquashRow) => { ordered.push(r); for (const child of children.get(r.oid) ?? []) visit(child); };
  for (const row of rows) if (!moved.has(row.oid)) visit(row);
  // The existing rebase runner takes the final combined message from the group head.
  let head: AutosquashRow | null = null;
  for (const row of ordered) {
    if (row.action !== "fixup" && row.action !== "squash") head = row;
    else if (row.action === "squash" && head) head.message += `\n\n${message(row)}`;
  }
  return { rows: ordered, warnings, matched: moved.size };
}
