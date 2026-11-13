import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";

const words = /[\p{ID_Continue}$]+/gu;
const singleWord = /^[\p{ID_Continue}$]+$/u;
const highlightName = "revqora-diff-word";

function textSelection(content: HTMLElement | null) {
  const selection = content?.ownerDocument.getSelection();
  return selection?.anchorNode && selection.focusNode && !selection.isCollapsed
    && content?.contains(selection.anchorNode) && content.contains(selection.focusNode) ? selection : null;
}

function codeRanges(code: HTMLElement, matches: Iterable<RegExpExecArray>) {
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
  for (const match of matches) {
    const start = advanceTo(match.index);
    if (!start) break;
    const range = doc.createRange();
    range.setStart(start, match.index - offset);
    const end = match.index + match[0].length;
    const last = advanceTo(end);
    if (!last) break;
    range.setEnd(last, end - offset);
    ranges.push(range);
  }
  return ranges;
}

function wordAtClick(event: MouseEvent<HTMLDivElement>) {
  const code = (event.target as Element).closest<HTMLElement>(".code");
  if (!code) return null;
  const doc = code.ownerDocument;
  const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
  const fallback = !caret ? doc.caretRangeFromPoint?.(event.clientX, event.clientY) : null;
  const node = caret?.offsetNode ?? fallback?.startContainer;
  if (!node || !code.contains(node)) return null;
  const prefix = doc.createRange();
  prefix.selectNodeContents(code);
  prefix.setEnd(node, caret?.offset ?? fallback!.startOffset);
  const position = prefix.toString().length;
  const text = code.textContent ?? "";
  for (const match of text.matchAll(words)) {
    if (match.index > position) break;
    if (position > match.index + match[0].length) continue;
    const [range] = codeRanges(code, [match]);
    if (range) return { word: match[0], range };
  }
  return null;
}

export function useDiffWordSelection(content: RefObject<HTMLDivElement | null>, identity: string, lines: () => Iterable<string>) {
  const [picked, setPicked] = useState<{ identity: string; word: string } | null>(null);
  const previousWord = useRef<{ identity: string; word: string } | null>(null);
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
      ranges = Array.from(root.querySelectorAll<HTMLElement>(".code")).flatMap(code => {
        const text = code.textContent ?? "";
        return text.includes(word) ? codeRanges(code, [...text.matchAll(words)].filter(match => match[0] === word)) : [];
      });
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
    all: !!word,
    selectedText: () => {
      if (!word) return textSelection(content.current)?.toString() ?? "";
      const matches: string[] = [];
      // Use diff lines so scrolling a virtualized row out of view cannot change what gets copied.
      for (const line of lines()) {
        if (!line.includes(word)) continue;
        for (const match of line.matchAll(words)) if (match[0] === word) matches.push(word);
      }
      return matches.join("\n");
    },
    onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.detail % 2 === 0) return;
      const selected = word ?? textSelection(content.current)?.toString().trim() ?? "";
      previousWord.current = singleWord.test(selected) ? { identity, word: selected } : null;
      setPicked(null);
    },
    onClick: (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.detail < 2 || event.detail % 2 !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const match = wordAtClick(event);
      const selection = content.current?.ownerDocument.getSelection();
      if (!match || !selection) return;
      selection.removeAllRanges();
      selection.addRange(match.range);
      const previous = previousWord.current;
      if (previous?.identity === identity && previous.word === match.word) setPicked({ identity, word: match.word });
    },
  };
}
