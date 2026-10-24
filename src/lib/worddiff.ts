// Intra-line (word level) highlighting for paired removed/added lines.

export interface Span {
  text: string;
  changed: boolean;
}

function tokenize(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/** LCS over tokens; returns spans for the old and new line. Falls back to whole-line for long lines. */
export function wordDiff(a: string, b: string): { old: Span[]; new: Span[] } {
  if (a === b) return { old: [{ text: a, changed: false }], new: [{ text: b, changed: false }] };
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length * tb.length > 250_000) {
    return { old: [{ text: a, changed: true }], new: [{ text: b, changed: true }] };
  }
  const n = ta.length;
  const m = tb.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldSpans: Span[] = [];
  const newSpans: Span[] = [];
  const push = (arr: Span[], text: string, changed: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text;
    else arr.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      push(oldSpans, ta[i], false);
      push(newSpans, tb[j], false);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(oldSpans, ta[i++], true);
    } else {
      push(newSpans, tb[j++], true);
    }
  }
  while (i < n) push(oldSpans, ta[i++], true);
  while (j < m) push(newSpans, tb[j++], true);
  // If almost everything changed, word highlighting is noise.
  const changedRatio = (spans: Span[], total: string) => spans.filter((s) => s.changed).reduce((acc, s) => acc + s.text.length, 0) / Math.max(1, total.length);
  if (changedRatio(oldSpans, a) > 0.7 && changedRatio(newSpans, b) > 0.7) {
    return { old: [{ text: a, changed: false }], new: [{ text: b, changed: false }] };
  }
  return { old: oldSpans, new: newSpans };
}
