const NAMES: Record<string, string> = { lf: "LF", crlf: "CRLF", mixed: "mixed LF and CRLF" };

/** What the diff shows for a file whose line endings alone changed: Git converts line endings
 *  before it compares, so no line differs although the file is listed as modified. */
export function lineEndingsNote(endings: { stored: string; working: string }): string {
  const name = (eol: string) => NAMES[eol] ?? eol;
  return `Only line endings changed: ${name(endings.stored)} in Git, ${name(endings.working)} in the working copy. The text is the same.`;
}
