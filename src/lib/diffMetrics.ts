export const DIFF_TAB_SIZE = 4;

/** Measure preserved tabs at CSS tab stops, rather than adding fixed spaces. */
export function measureDiffLine(text: string, measure: (text: string) => number): number {
  if (!text.includes("\t")) return measure(text);
  const parts = text.split("\t");
  const tabWidth = measure(" ") * DIFF_TAB_SIZE;
  if (!tabWidth) return measure(parts.join(""));
  // CSS Text requires the following stop if the next one is less than 0.5ch away.
  // https://www.w3.org/TR/css-text-3/#white-space-phase-2
  const minimumAdvance = measure("0") / 2;
  let width = measure(parts[0]);
  for (const part of parts.slice(1)) width = Math.ceil((width + minimumAdvance) / tabWidth) * tabWidth + measure(part);
  return width;
}
