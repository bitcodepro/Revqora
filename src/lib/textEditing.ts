export function editorDocument(text: string) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const doc = text.slice(bom.length);
  const endings = new Set(doc.match(/\r\n|\r|\n/g) ?? []);
  if (endings.size > 1) throw new Error("This file mixes line endings. Use an external editor to preserve or normalize them before editing here.");
  return { bom, doc, eol: [...endings][0] ?? "\n" };
}

/** Expand to tab stops. Leading indentation is the safe default; all tabs is explicit. */
export function tabsToSpaces(text: string, size: number, all = false): string {
  if (!Number.isInteger(size) || size < 1 || size > 16) throw new Error("Choose a tab width from 1 to 16.");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const expand = (part: string) => {
    let column = 0, result = "";
    for (const char of part) {
      if (char === "\t") { const count = size - column % size; result += " ".repeat(count); column += count; }
      else { result += char; column++; }
    }
    return result;
  };
  const body = text.slice(bom.length);
  return bom + (all ? body.replace(/[^\r\n]+/g, expand) : body.replace(/(^|\r\n|\r|\n)([ \t]+)/g, (_, eol: string, indent: string) => eol + expand(indent)));
}
