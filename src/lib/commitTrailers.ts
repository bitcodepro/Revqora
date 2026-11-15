/** Co-author trailers and recent commit messages for the commit box. */

export interface Person { name: string; email: string }

const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*:\s/;
const CO_AUTHOR = /^co-authored-by:\s*(.+?)\s*<([^<>]+)>\s*$/i;

/** Parses a typed `Name <email>`; null when the form is invalid. */
export function parsePerson(input: string): Person | null {
  const m = /^\s*([^<>]+?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(input);
  if (!m || !EMAIL.test(m[2]) || /[\r\n]/.test(m[1])) return null;
  return { name: m[1], email: m[2] };
}

export const formatPerson = (p: Person) => `${p.name} <${p.email}>`;
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Co-authors named by `Co-authored-by:` lines in the message body, in order. */
export function coAuthorsIn(body: string): Person[] {
  const out: Person[] = [];
  for (const line of body.split("\n")) {
    const m = CO_AUTHOR.exec(line.trim());
    if (m && !out.some((p) => sameEmail(p.email, m[2]))) out.push({ name: m[1], email: m[2].trim() });
  }
  return out;
}

/** Adds one `Co-authored-by:` trailer at the end of the body, after a blank line,
 *  joining an existing trailer block. Existing co-authors are left unchanged. */
export function addCoAuthor(body: string, person: Person): string {
  if (coAuthorsIn(body).some((p) => sameEmail(p.email, person.email))) return body;
  const line = `Co-authored-by: ${formatPerson(person)}`;
  const text = body.replace(/\s+$/, "");
  if (!text) return line;
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1].split("\n");
  const trailerBlock = last.every((l) => TRAILER.test(l.trim())) && (paragraphs.length > 1 || last.some((l) => CO_AUTHOR.test(l.trim())));
  return trailerBlock ? `${text}\n${line}` : `${text}\n\n${line}`;
}

/** Removes the `Co-authored-by:` trailer for this e-mail; other trailers stay. */
export function removeCoAuthor(body: string, email: string): string {
  const lines = body.split("\n").filter((line) => {
    const m = CO_AUTHOR.exec(line.trim());
    return !(m && sameEmail(m[2], email));
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

const normalize = (message: string) => message.replace(/\r\n/g, "\n").trim();

/** Remembers a message Revqora committed, newest first, without duplicates. */
export function rememberMessage(list: readonly string[], message: string, max = 30): string[] {
  const m = normalize(message);
  if (!m) return [...list];
  return [m, ...list.filter((x) => normalize(x) !== m)].slice(0, max);
}

/** Revqora's own recent messages first, then the user's commits from history; unique. */
export function mergeRecentMessages(local: readonly string[], history: readonly string[], max = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...local, ...history]) {
    const m = normalize(raw);
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

export function splitMessage(message: string): { summary: string; body: string } {
  const [summary = "", ...rest] = normalize(message).split("\n");
  return { summary: summary.trim(), body: rest.join("\n").trim() };
}
