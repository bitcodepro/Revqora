import { useLayoutEffect, useState, type MouseEvent, type RefObject } from "react";

const words = /[\p{ID_Continue}$]+/gu;
const highlightName = "revqora-diff-word";

function selectedWord(code: HTMLElement) {
  const doc = code.ownerDocument;
  const selection = doc.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const selected = selection.getRangeAt(0);
  if (!code.contains(selected.startContainer) || !code.contains(selected.endContainer)) return null;
  const before = doc.createRange();
  before.selectNodeContents(code);
  before.setEnd(selected.startContainer, selected.startOffset);
  const selectionText = selected.toString();
  const trimmed = selectionText.trim();
  if (!trimmed) return null;
  const start = before.toString().length + selectionText.length - selectionText.trimStart().length;
  const end = start + trimmed.length;
  for (const match of (code.textContent ?? "").matchAll(words)) {
    if (match.index <= start && match.index + match[0].length >= end) return match[0];
  }
  return null;
}

function wordRanges(code: HTMLElement, word: string) {
  const text = code.textContent ?? "";
  if (!text.includes(word)) return [];
  const doc = code.ownerDocument;
  const walker = doc.createTreeWalker(code, 4); // SHOW_TEXT
  let node = walker.nextNode() as Text | null;
  let offset = 0;
  const advanceTo = (position: number) => {
    while (node && position > offset + node.length) {
      offset += node.length;
      node = walker.nextNode() as Text | null;
    }
    return node;
  };
  const ranges: Range[] = [];
  for (const match of text.matchAll(words)) {
    if (match[0] !== word) continue;
    const start = advanceTo(match.index);
    if (!start) break;
    const range = doc.createRange();
    range.setStart(start, match.index - offset);
    const end = match.index + word.length;
    const last = advanceTo(end);
    if (!last) break;
    range.setEnd(last, end - offset);
    ranges.push(range);
  }
  return ranges;
}

export function useDiffWordSelection(content: RefObject<HTMLDivElement | null>, identity: string) {
  const [picked, setPicked] = useState<{ identity: string; word: string } | null>(null);
  const word = picked?.identity === identity ? picked.word : null;

  useLayoutEffect(() => {
    const root = content.current;
    const view = root?.ownerDocument.defaultView;
    const registry = view?.CSS?.highlights;
    if (!word || !root || !view?.Highlight || !registry) return;
    let ranges: Range[] = [];
    const highlight = registry.get(highlightName) ?? new view.Highlight();
    registry.set(highlightName, highlight);
    const clear = () => { for (const range of ranges) highlight.delete(range); };
    const refresh = () => {
      clear();
      ranges = Array.from(root.querySelectorAll<HTMLElement>(".code")).flatMap(code => wordRanges(code, word));
      for (const range of ranges) highlight.add(range);
    };
    refresh();
    const observer = new view.MutationObserver(refresh);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      clear();
      if (!highlight.size && registry.get(highlightName) === highlight) registry.delete(highlightName);
    };
  }, [content, word, identity]);

  return {
    clear: () => setPicked(null),
    onDoubleClick: (e: MouseEvent<HTMLDivElement>) => {
      const code = (e.target as Element).closest<HTMLElement>(".code");
      const word = code && selectedWord(code);
      if (word) setPicked({ identity, word });
    },
  };
}
