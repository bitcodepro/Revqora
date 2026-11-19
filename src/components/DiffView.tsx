import { useShallow } from "zustand/react/shallow";
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  AlignJustify,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Columns2,
  FileDiff as FileDiffIcon,
  FileWarning,
  Minus,
  Plus,
  Pilcrow,
  Search,
  RemoveFormatting,
  UnfoldVertical,
  Undo2,
  WrapText,
  X,
} from "lucide-react";
import type { DiffHunk, DiffLine, FileDiff } from "../lib/types";
import { useSettings } from "../lib/settings";
import { matchesShortcut, shortcutTitle } from "../lib/shortcuts";
import { highlightLines, languageFor, type Tok } from "../lib/languages";
import { wordDiff, type Span } from "../lib/worddiff";
import { basename, dirname } from "../lib/format";
import { contextMenu, copyText } from "../lib/ui";
import { copyFileNameItem, useCopySelectionMenu } from "./NamePathMenu";
import { DIFF_TAB_SIZE, measureDiffLine } from "../lib/diffMetrics";
import type { LanguageSupport } from "@codemirror/language";
import { ImageDiff, isImagePath, type ImageSides } from "./ImageDiff";
import { TextDiffPreview } from "./TextDiffPreview";
import { useDiffWordSelection } from "./DiffWordSelection";
import { create } from "zustand";
import { movedLines } from "../lib/movedLines";
import { changeBlocks, lineRange } from "../lib/lineSelection";
import { submodulePointers } from "../lib/submodulePointer";
import { SubmoduleSummary } from "./SubmoduleSummary";

export type DiffMode = "unstaged" | "staged" | "readonly" | "pick";
export type LineAction = "stage" | "unstage" | "discard" | "apply" | "stash";

interface Props {
  diff: FileDiff | null;
  loading?: boolean;
  error?: string | null;
  mode: DiffMode;
  path: string;
  badge?: ReactNode;
  actions?: ReactNode;
  canStash?: boolean;
  onApply?: (selection: [number, number][], action: LineAction) => Promise<void> | void;
  emptyText?: string;
  /** Repository root and blob locations used to preview binary images. */
  root?: string;
  images?: ImageSides;
  /** API patches have provider-selected context, not local Git diff options. */
  sourceOptions?: boolean;
  onComment?: (side: "LEFT" | "RIGHT", line: number) => void;
}

/** Extra context lines asked for per file path ("Show more context"); not persisted. */
export const useContextExpansion = create<{ extra: Record<string, number>; more: (path: string) => void; reset: (path: string) => void }>((set) => ({
  extra: {},
  more: (path) => set((s) => ({ extra: { ...s.extra, [path]: Math.min(10_000, (s.extra[path] ?? 0) + CONTEXT_STEP) } })),
  reset: (path) => set((s) => { const extra = { ...s.extra }; delete extra[path]; return { extra }; }),
}));
const CONTEXT_STEP = 20;

/** Diff options from the settings (context / whole file / whitespace / algorithm) for backend
 *  calls, plus any extra context asked for on `path`. */
export function useDiffOpts(path?: string | null) {
  const ctx = useSettings((s) => s.contextLines);
  const full = useSettings((s) => s.diffFullFile);
  const ws = useSettings((s) => s.ignoreWhitespace);
  const blank = useSettings((s) => s.ignoreBlankLines);
  const algorithm = useSettings((s) => s.diffAlgorithm);
  const extra = useContextExpansion((s) => (path ? s.extra[path] ?? 0 : 0));
  return useMemo(() => ({
    context: full ? 100000 : ctx + extra,
    ignoreWhitespace: ws,
    ...(blank ? { ignoreBlankLines: true } : {}),
    ...(algorithm !== "default" ? { algorithm } : {}),
  }), [ctx, full, ws, blank, algorithm, extra]);
}

const key = (h: number, l: number) => `${h}:${l}`;
/** Diffs longer than this render only the visible rows. */
const VIRTUAL_THRESHOLD = 3000;

/** Pairs runs of deletions with following additions for word-level highlighting. */
function pairLines(lines: DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "-") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i].kind === "-") i++;
    const addStart = i;
    while (i < lines.length && lines[i].kind === "+") i++;
    const n = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < n; k++) {
      pairs.set(delStart + k, addStart + k);
      pairs.set(addStart + k, delStart + k);
    }
  }
  return pairs;
}

function useHighlight(path: string, hunks: DiffHunk[] | undefined, enabled: boolean) {
  const [lang, setLang] = useState<LanguageSupport | null>(null);
  useEffect(() => {
    let alive = true;
    setLang(null);
    languageFor(path).then((l) => alive && setLang(l));
    return () => {
      alive = false;
    };
  }, [path]);
  return useMemo(() => {
    if (!lang || !hunks || !enabled) return null;
    // Highlight the old and the new side of every hunk as continuous code.
    return hunks.map((h) => {
      const oldIdx: number[] = [];
      const newIdx: number[] = [];
      const oldLines: string[] = [];
      const newLines: string[] = [];
      h.lines.forEach((l, i) => {
        if (l.kind === " " || l.kind === "-") {
          oldIdx.push(i);
          oldLines.push(l.text);
        }
        if (l.kind === " " || l.kind === "+") {
          newIdx.push(i);
          newLines.push(l.text);
        }
      });
      const res: (Tok[] | undefined)[] = new Array(h.lines.length);
      try {
        const o = highlightLines(lang.language, oldLines);
        const n = highlightLines(lang.language, newLines);
        oldIdx.forEach((li, k) => {
          if (h.lines[li].kind === "-") res[li] = o[k];
        });
        newIdx.forEach((li, k) => (res[li] = n[k]));
      } catch {
        /* fall back to plain text */
      }
      return res;
    });
  }, [lang, hunks, enabled]);
}

function renderCode(text: string, toks: Tok[] | undefined, spans: Span[] | undefined, kind: string, whitespace: boolean): ReactNode {
  const display = (part: string) => !whitespace ? part : part.split(/( +|\t)/).map((chunk,i) => chunk.startsWith(" ") || chunk === "\t" ? <span key={i} className={chunk === "\t" ? "ws-tab" : "ws-space"}>{chunk}</span> : chunk);
  if (spans && spans.some((s) => s.changed)) {
    const cls = kind === "+" ? "w-add" : "w-del";
    return spans.map((s, i) => (s.changed ? <span key={i} className={cls}>{display(s.text)}</span> : <Fragment key={i}>{display(s.text)}</Fragment>));
  }
  if (toks && toks.length) return toks.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{display(t.text)}</span> : <Fragment key={i}>{display(t.text)}</Fragment>));
  return text ? display(text) : " ";
}

/**
 * The text of one diff line. Its inputs (tokens, word changes) are remembered per diff, so a
 * selection, search or scroll change redraws only the lines whose text styling changed.
 */
const Code = memo(function Code({ text, toks, spans, kind, whitespace }: { text: string; toks: Tok[] | undefined; spans: Span[] | undefined; kind: string; whitespace: boolean }) {
  return <span className="code">{kind === "\\" ? text : renderCode(text, toks, spans, kind, whitespace)}</span>;
});

type FlatRow = { kind: "hunk"; h: number } | { kind: "line"; h: number; l: number };
type VirtualRow = FlatRow | { kind: "pair"; h: number; a: number | null; b: number | null };

export function DiffView({ diff, loading, error, mode, path, badge, actions, canStash = false, onApply, emptyText, root, images, sourceOptions = true, onComment }: Props) {
  // Only the diff settings: unrelated settings writes must not re-render every open diff.
  const s = useSettings(useShallow((st) => ({
    set: st.set, codeFont: st.codeFont, codeFontSize: st.codeFontSize, diffFullFile: st.diffFullFile, diffMode: st.diffMode,
    ignoreWhitespace: st.ignoreWhitespace, showWhitespace: st.showWhitespace, wrapDiff: st.wrapDiff,
    ignoreBlankLines: st.ignoreBlankLines, diffAlgorithm: st.diffAlgorithm, highlightMovedLines: st.highlightMovedLines,
  })));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<{ h: number; l: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const contextExtra = useContextExpansion((st) => (path ? st.extra[path] ?? 0 : 0));
  const moreContext = useContextExpansion((st) => st.more);
  const resetContext = useContextExpansion((st) => st.reset);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [hitIdx, setHitIdx] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(800);
  const [viewW, setViewW] = useState(800);
  const [horizontal, setHorizontal] = useState({ max: 0, position: 0 });
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  const totalLines = diff?.hunks.reduce((a, h) => a + h.lines.length, 0) ?? 0;
  // Long diffs render only the visible rows, side by side too (wrapped lines have no fixed height).
  const virtual = totalLines > VIRTUAL_THRESHOLD && !s.wrapDiff;
  const expensive = totalLines > VIRTUAL_THRESHOLD || !!diff?.previewLimited;
  const hl = useHighlight(path, diff?.hunks, !expensive);
  const words = useMemo(() => {
    if (!diff || expensive) return null;
    return diff.hunks.map((h) => {
      const pairs = pairLines(h.lines);
      const map = new Map<number, Span[]>();
      pairs.forEach((other, i) => {
        if (h.lines[i].kind !== "-") return;
        const wd = wordDiff(h.lines[i].text, h.lines[other].text);
        map.set(i, wd.old);
        map.set(other, wd.new);
      });
      return map;
    });
  }, [diff, expensive]);

  const pointers = useMemo(() => submodulePointers(diff ?? null), [diff]);
  const moved = useMemo(() => (diff && s.highlightMovedLines && !expensive ? movedLines(diff.hunks) : new Set<string>()), [diff, s.highlightMovedLines, expensive]);
  useEffect(() => {
    setSel(new Set());
    setAnchor(null);
  }, [diff?.hash, path]);
  useEffect(() => {
    setCollapsed(new Set());
    setHitIdx(0);
  }, [path]);

  const splitPan = s.diffMode === "split" && !s.wrapDiff;
  // Virtual rows and clipped split columns cannot supply an intrinsic scroll width.
  const textWidth = useMemo(() => {
    if ((!virtual && !splitPan) || !diff) return 0;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return 0;
    context.font = `${s.codeFontSize}px "${s.codeFont}", monospace`;
    const measure = (text: string) => context.measureText(text).width;
    let width = 0;
    for (const h of diff.hunks) for (const line of h.lines) {
      width = Math.max(width, measureDiffLine(line.text, measure));
    }
    return Math.ceil(width);
  }, [virtual, splitPan, diff, s.codeFontSize, s.codeFont]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => {
      setViewH(el.clientHeight);
      setViewW(el.clientWidth);
      const max = splitPan ? Math.max(0, textWidth - (el.clientWidth - 26) / 2 + 80) : Math.max(0, el.scrollWidth - el.clientWidth);
      setHorizontal((h) => {
        const position = splitPan ? Math.min(h.position, max) : el.scrollLeft;
        return h.max === max && h.position === position ? h : { max, position };
      });
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    update();
    return () => ro.disconnect();
  }, [diff, s.wrapDiff, s.diffMode, s.codeFontSize, s.codeFont, collapsed, splitPan, textWidth]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollLeft = 0;
    setHorizontal((h) => ({ ...h, position: 0 }));
  }, [path, s.diffMode, s.wrapDiff]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !splitPan) return;
    const wheel = (e: WheelEvent) => {
      const delta = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      if (!delta) return;
      e.preventDefault();
      setHorizontal((h) => ({ ...h, position: Math.max(0, Math.min(h.max, h.position + delta)) }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [splitPan]);

  const interactive = mode !== "readonly" && !!onApply;
  const rowH = Math.ceil(s.codeFontSize * 1.6);
  // A diff that becomes virtual (wrapping turned off, longer diff) starts from where it is scrolled.
  useEffect(() => {
    if (virtual && bodyRef.current) setScroll(Math.floor(bodyRef.current.scrollTop / rowH) * rowH);
  }, [virtual, rowH]);

  // Flattened rows (used for virtualization, search and change navigation).
  const flat = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    diff?.hunks.forEach((h, hi) => {
      out.push({ kind: "hunk", h: hi });
      if (!collapsed.has(hi)) h.lines.forEach((_, li) => out.push({ kind: "line", h: hi, l: li }));
    });
    return out;
  }, [diff, collapsed]);
  /** The rows a virtual diff draws: unified lines, or side-by-side pairs. */
  const vrows = useMemo<VirtualRow[]>(() => {
    if (!virtual || !diff) return [];
    if (s.diffMode !== "split") return flat;
    const out: VirtualRow[] = [];
    diff.hunks.forEach((h, hi) => {
      out.push({ kind: "hunk", h: hi });
      if (!collapsed.has(hi)) for (const [a, b] of splitRows(h.lines)) out.push({ kind: "pair", h: hi, a, b });
    });
    return out;
  }, [virtual, diff, collapsed, flat, s.diffMode]);
  const vrowIndex = (h: number, l: number | null) => vrows.findIndex((r) => r.h === h && (l === null ? r.kind === "hunk" : r.kind === "line" ? r.l === l : r.kind === "pair" && (r.a === l || r.b === l)));
  const wordSelection = useDiffWordSelection(contentRef, JSON.stringify([root, path, diff?.hash]), function* () {
    if (!diff) return;
    for (const row of flat) {
      if (row.kind !== "line") continue;
      const line = diff.hunks[row.h].lines[row.l];
      yield line.text;
      if (s.diffMode === "split" && line.kind === " ") yield line.text;
    }
  });
  const selectionMenu = useCopySelectionMenu(wordSelection.selectedText);

  const q = find.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!q || !diff) return [] as { h: number; l: number }[];
    const out: { h: number; l: number }[] = [];
    diff.hunks.forEach((h, hi) => h.lines.forEach((l, li) => l.text.toLowerCase().includes(q) && out.push({ h: hi, l: li })));
    return out;
  }, [q, diff]);
  const hitSet = useMemo(() => new Set(hits.map((x) => key(x.h, x.l))), [hits]);
  const curHit = hits.length ? hits[Math.min(hitIdx, hits.length - 1)] : null;

  const scrollToRow = (h: number, l: number | null) => {
    const el = bodyRef.current;
    if (!el) return;
    if (collapsed.has(h)) setCollapsed((c) => new Set([...c].filter((x) => x !== h)));
    if (virtual) {
      const idx = vrowIndex(h, l);
      if (idx >= 0) el.scrollTop = Math.max(0, idx * rowH - el.clientHeight / 3);
      return;
    }
    const target = el.querySelector<HTMLElement>(l === null ? `[data-hunk="${h}"]` : `[data-line="${h}:${l}"]`);
    if (target) el.scrollTop = Math.max(0, target.offsetTop - el.clientHeight / 3);
  };

  useEffect(() => {
    if (curHit) scrollToRow(curHit.h, curHit.l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curHit?.h, curHit?.l]);

  /** Jumps to the next / previous hunk relative to the current scroll position. */
  const jumpChange = (dir: 1 | -1) => {
    const el = bodyRef.current;
    if (!el || !diff) return;
    const tops: number[] = virtual
      ? diff.hunks.map((_, hi) => vrowIndex(hi, null) * rowH)
      : diff.hunks.map((_, hi) => el.querySelector<HTMLElement>(`[data-hunk="${hi}"]`)?.offsetTop ?? 0);
    const cur = el.scrollTop + 4;
    const idx = dir > 0 ? tops.findIndex((t) => t > cur + 8) : tops.map((t, i) => [t, i] as const).filter(([t]) => t < cur - 8).pop()?.[1] ?? -1;
    if (idx >= 0) el.scrollTop = Math.max(0, tops[idx] - 8);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const editable = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
    const next = matchesShortcut(e, "diffNext");
    if (next || matchesShortcut(e, "diffPrevious")) {
      e.preventDefault();
      e.stopPropagation();
      jumpChange(next ? 1 : -1);
    } else if (matchesShortcut(e, "diffFind")) {
      e.preventDefault();
      e.stopPropagation();
      setFindOpen(true);
      setTimeout(() => findRef.current?.select(), 0);
    } else if (!editable && !e.repeat && matchesShortcut(e, "codeCopySelection")) {
      const text = wordSelection.selectedText();
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        void copyText(text);
      }
    } else if (!editable && !e.repeat && matchesShortcut(e, "diffCopyName")) {
      e.preventDefault();
      e.stopPropagation();
      void copyText(basename(path), "Name copied");
    } else if (interactive && !busy && !e.repeat && !editable) {
      const actions: LineAction[] = mode === "unstaged"
        ? ["stage", ...(canStash ? ["stash" as const] : []), ...(!loading ? ["discard" as const] : [])]
        : mode === "staged" ? ["unstage"] : ["apply"];
      for (const action of actions) {
        const lines = matchesShortcut(e, `diff-${action}-lines`);
        if (!lines && !matchesShortcut(e, `diff-${action}-hunk`)) continue;
        const element = (e.target as HTMLElement).closest<HTMLElement>("[data-hunk], [data-line]");
        const focused = element?.dataset.hunk ?? element?.dataset.line?.split(":")[0];
        const hunk = focused === undefined ? anchor?.h ?? (diff?.hunks.length === 1 ? 0 : -1) : Number(focused);
        const selection = lines ? selectedPairs() : diff?.hunks[hunk] ? hunkSelection(hunk) : [];
        if (selection.length) {
          e.preventDefault();
          e.stopPropagation();
          void apply(selection, action);
        }
        break;
      }
    }
  };

  /** A drag across line numbers: the selection before it, and whether it adds or removes. */
  const drag = useRef<{ base: Set<string>; add: boolean; from: { h: number; l: number } } | null>(null);
  useEffect(() => {
    const end = () => { drag.current = null; };
    const view = bodyRef.current?.ownerDocument.defaultView ?? window;
    view.addEventListener("mouseup", end);
    return () => view.removeEventListener("mouseup", end);
  }, []);
  const toggle = (h: number, l: number, shift: boolean) => {
    if (!interactive || !diff) return;
    const line = diff.hunks[h].lines[l];
    if (line.kind !== "+" && line.kind !== "-") return;
    const next = new Set(sel);
    if (shift && anchor) {
      // Shift: the range from the anchor, across hunks too.
      for (const k of lineRange(diff.hunks, anchor, { h, l }, collapsed)) next.add(k);
    } else {
      const k = key(h, l);
      const add = !next.has(k);
      if (add) next.add(k);
      else next.delete(k);
      setAnchor({ h, l });
      // Press and drag over more line numbers to extend.
      drag.current = { base: new Set(sel), add, from: { h, l } };
    }
    setSel(next);
  };
  const dragOver = (h: number, l: number) => {
    const d = drag.current;
    if (!d || !diff) return;
    const next = new Set(d.base);
    for (const k of lineRange(diff.hunks, d.from, { h, l }, collapsed)) {
      if (d.add) next.add(k);
      else next.delete(k);
    }
    setSel(next);
  };
  /** Change blocks per hunk, so one hunk can be staged piece by piece. */
  const blocks = useMemo(() => {
    const out = new Map<string, number[]>();
    diff?.hunks.forEach((h, hi) => {
      const list = changeBlocks(h);
      if (list.length > 1) for (const b of list) out.set(key(hi, b.start), b.lines);
    });
    return out;
  }, [diff]);

  const apply = async (selection: [number, number][], action: LineAction) => {
    if (!onApply || !selection.length) return;
    setBusy(true);
    try {
      await onApply(selection, action);
      setSel(new Set());
    } finally {
      setBusy(false);
    }
  };

  const hunkSelection = (h: number): [number, number][] =>
    diff!.hunks[h].lines.flatMap((l, i) => (l.kind === "+" || l.kind === "-" ? [[h, i] as [number, number]] : []));
  const selectedPairs = (): [number, number][] => [...sel].map((k) => k.split(":").map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const hunkHeader = (h: DiffHunk, hi: number, style?: React.CSSProperties) => (
    <div className="hunk-head" data-hunk={hi} style={style}>
      <button aria-label={collapsed.has(hi) ? "Expand" : "Collapse"}
        className="icon-btn sm"
        onClick={() => setCollapsed((c) => (c.has(hi) ? new Set([...c].filter((x) => x !== hi)) : new Set([...c, hi])))}
        title={collapsed.has(hi) ? "Expand" : "Collapse"}
      >
        {collapsed.has(hi) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </button>
      <span className="hh">{h.header}</span>
      {interactive && (
        <div className="actions">
          {mode === "unstaged" && (
            <>
              <button className="btn sm" disabled={busy} onClick={() => apply(hunkSelection(hi), "stage")}>
                <Plus size={12} /> Stage hunk
              </button>
              {canStash && <button className="btn sm" disabled={busy} onClick={() => apply(hunkSelection(hi), "stash")}><Archive size={12} /> Stash hunk</button>}
              {!loading && <button className="btn sm ghost discard" disabled={busy} onClick={() => apply(hunkSelection(hi), "discard")} title="Discard hunk" aria-label="Discard hunk">
                <Undo2 size={12} />
              </button>}
            </>
          )}
          {mode === "staged" && (
            <button className="btn sm" disabled={busy} onClick={() => apply(hunkSelection(hi), "unstage")}>
              <Minus size={12} /> Unstage hunk
            </button>
          )}
          {mode === "pick" && (
            <button className="btn sm" disabled={busy} onClick={() => apply(hunkSelection(hi), "apply")} title="Apply this hunk to the working tree">
              <Plus size={12} /> Apply hunk
            </button>
          )}
        </div>
      )}
    </div>
  );

  const lineRow = (hi: number, li: number, style?: React.CSSProperties) => {
    const l = diff!.hunks[hi].lines[li];
    const k = key(hi, li);
    const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : l.kind === "\\" ? "meta" : "ctx";
    const selectable = interactive && (l.kind === "+" || l.kind === "-");
    const hit = hitSet.has(k) ? (curHit && curHit.h === hi && curHit.l === li ? "search-cur" : "search-hit") : "";
    return (
      <div key={k} data-line={k} onMouseEnter={drag.current ? () => dragOver(hi, li) : undefined} className={`dl ${cls} ${moved.has(k) ? "moved" : ""} ${sel.has(k) ? "sel" : ""} ${selectable ? "selectable" : ""} ${hit}`} style={style} title={moved.has(k) ? "Moved: the same line was removed or added elsewhere in this diff" : undefined}>
        {onComment && l.oldNo !== null ? <button className="ln review-line" title={`Comment on old line ${l.oldNo}`} aria-label={`Comment on old line ${l.oldNo}`} onClick={()=>onComment("LEFT",l.oldNo!)}>{l.oldNo}</button> : <span className="ln" onMouseDown={e=>toggle(hi,li,e.shiftKey)}>{l.oldNo??""}</span>}
        {onComment && l.newNo !== null ? <button className="ln review-line" title={`Comment on new line ${l.newNo}`} aria-label={`Comment on new line ${l.newNo}`} onClick={()=>onComment("RIGHT",l.newNo!)}>{l.newNo}</button> : <span className="ln" onMouseDown={e=>toggle(hi,li,e.shiftKey)}>{l.newNo??""}</span>}
        <span className="mk">{l.kind === " " || l.kind === "\\" ? "" : l.kind}</span>
        <Code text={l.text} toks={hl?.[hi]?.[li]} spans={words?.[hi]?.get(li)} kind={l.kind} whitespace={s.showWhitespace} />
        {interactive && blocks.has(k) && (mode === "unstaged" || mode === "staged") && (
          <span className="block-actions">
            <button type="button" className="btn sm" disabled={busy} title="Only this block of changes" onClick={() => apply(blocks.get(k)!.map((i) => [hi, i] as [number, number]), mode === "unstaged" ? "stage" : "unstage")}>
              {mode === "unstaged" ? "Stage block" : "Unstage block"}
            </button>
          </span>
        )}
      </div>
    );
  };

  const head = (
    <div className="diff-head">
      <div className="path" title={path} onContextMenu={e => contextMenu(e, [
        copyFileNameItem(path, "diffCopyName"),
      ])}>
        {dirname(path) && <span className="dir">{dirname(path)}/</span>}
        {basename(path)}
      </div>
      <div className="diff-controls">
      {diff?.oldPath && <span className="pill blue">renamed from {basename(diff.oldPath)}</span>}
      {diff?.isNew && <span className="pill green">new</span>}
      {diff?.isDeleted && <span className="pill red">deleted</span>}
      {diff?.oldMode && diff?.newMode && diff.oldMode !== diff.newMode && (
        <span className="pill">
          mode {diff.oldMode} → {diff.newMode}
        </span>
      )}
      {badge}
      {diff && !diff.binary && (
        <span className="stats" style={{ marginLeft: 4 }}>
          <span className="a">+{diff.additions}</span>
          <span className="d">−{diff.deletions}</span>
        </span>
      )}
      {actions}
      {diff && diff.hunks.length > 1 && (
        <>
          <button aria-label={shortcutTitle("Previous change", "diffPrevious")} className="icon-btn" title={shortcutTitle("Previous change", "diffPrevious")} onClick={() => jumpChange(-1)}>
            <ChevronsUp size={15} />
          </button>
          <button aria-label={shortcutTitle("Next change", "diffNext")} className="icon-btn" title={shortcutTitle("Next change", "diffNext")} onClick={() => jumpChange(1)}>
            <ChevronsDown size={15} />
          </button>
        </>
      )}
      <button aria-label={shortcutTitle("Find in diff", "diffFind")}
        className={`icon-btn ${findOpen ? "active" : ""}`}
        title={shortcutTitle("Find in diff", "diffFind")}
        onClick={() => {
          setFindOpen((v) => !v);
          setTimeout(() => findRef.current?.focus(), 0);
        }}
      >
        <Search size={15} />
      </button>
      <div className="seg" style={{ marginLeft: 6 }}>
        <button type="button" className={s.diffMode === "unified" ? "on" : ""} aria-pressed={s.diffMode === "unified"} aria-label="Unified" onClick={() => s.set({ diffMode: "unified" })} title="Unified">
          <AlignJustify size={13} />
        </button>
        <button type="button" className={s.diffMode === "split" ? "on" : ""} aria-pressed={s.diffMode === "split"} aria-label="Side by side" onClick={() => s.set({ diffMode: "split" })} title="Side by side">
          <Columns2 size={13} />
        </button>
      </div>
      <button type="button" className={`btn sm diff-view-menu ${s.wrapDiff || s.showWhitespace || (sourceOptions && (s.diffFullFile || s.ignoreWhitespace)) ? "active" : ""}`}
        aria-label="Diff view options" aria-haspopup="menu" title="Line wrapping, whitespace and context"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          // Opened below the button, right-aligned to it when there is room.
          contextMenu({ clientX: Math.max(6, box.right - 250), clientY: box.bottom + 4, currentTarget: e.currentTarget, preventDefault: () => {} }, [
            { label: "Wrap lines", icon: <WrapText size={14} />, checked: s.wrapDiff, onClick: () => s.set({ wrapDiff: !s.wrapDiff }) },
            { label: "Show whitespace", icon: <Pilcrow size={14} />, checked: s.showWhitespace, onClick: () => s.set({ showWhitespace: !s.showWhitespace }) },
            { label: "Highlight moved lines", checked: s.highlightMovedLines, onClick: () => s.set({ highlightMovedLines: !s.highlightMovedLines }) },
            ...(sourceOptions ? [
              { separator: true },
              { label: "Show the whole file", icon: <UnfoldVertical size={14} />, checked: s.diffFullFile, hint: "not only the changes", onClick: () => s.set({ diffFullFile: !s.diffFullFile }) },
              { label: "Ignore whitespace changes", icon: <RemoveFormatting size={14} />, checked: s.ignoreWhitespace, onClick: () => s.set({ ignoreWhitespace: !s.ignoreWhitespace }) },
              { label: "Ignore blank lines", checked: s.ignoreBlankLines, onClick: () => s.set({ ignoreBlankLines: !s.ignoreBlankLines }) },
              { label: "Show more context", hint: path && contextExtra ? `+${contextExtra} lines` : undefined, disabled: !path || s.diffFullFile, onClick: () => { if (path) moreContext(path); } },
              ...(path && contextExtra ? [{ label: "Normal context", onClick: () => resetContext(path) }] : []),
              { separator: true },
              { label: "Diff algorithm", children: (["default", "myers", "minimal", "patience", "histogram"] as const).map((value) => ({
                label: value === "default" ? "Git's default" : value[0].toUpperCase() + value.slice(1), checked: s.diffAlgorithm === value, onClick: () => s.set({ diffAlgorithm: value }) })) },
            ] : []),
          ]);
        }}>
        View <ChevronDown size={13} />
      </button>
      </div>
    </div>
  );

  const findBar = findOpen && (
    <div className="diff-find">
      <Search size={13} className="faint" />
      <input
        ref={findRef}
        value={find}
        placeholder="Find in this diff"
        onChange={(e) => {
          setFind(e.target.value);
          setHitIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") setHitIdx((i) => (hits.length ? (i + (e.shiftKey ? hits.length - 1 : 1)) % hits.length : 0));
          if (e.key === "Escape") {
            setFindOpen(false);
            setFind("");
          }
        }}
      />
      <span className="count">{q ? (hits.length ? `${Math.min(hitIdx, hits.length - 1) + 1} / ${hits.length}` : "No matches") : ""}</span>
      <button className="icon-btn sm" aria-label="Previous diff match" onClick={() => setHitIdx((i) => (hits.length ? (i + hits.length - 1) % hits.length : 0))} disabled={!hits.length}>
        <ChevronsUp size={13} />
      </button>
      <button className="icon-btn sm" aria-label="Next diff match" onClick={() => setHitIdx((i) => (hits.length ? (i + 1) % hits.length : 0))} disabled={!hits.length}>
        <ChevronsDown size={13} />
      </button>
      <button
        className="icon-btn sm"
        aria-label="Close diff search"
        onClick={() => {
          setFindOpen(false);
          setFind("");
        }}
      >
        <X size={13} />
      </button>
    </div>
  );

  let body: ReactNode;
  if (error) {
    body = (
      <div className="empty">
        <div className="big">
          <FileWarning size={24} />
        </div>
        <div>{error}</div>
      </div>
    );
  } else if (!diff) {
    body = loading ? (
      <div className="loading-center" role="status" aria-label="Loading file changes">
        <span className="loader" aria-hidden="true" />
      </div>
    ) : (
      <div className="empty">
        <div className="big">
          <FileDiffIcon size={24} />
        </div>
        <div>{emptyText ?? "Select a file to see its changes"}</div>
      </div>
    );
  } else if (diff.binary && root && images && isImagePath(path)) {
    body = <ImageDiff root={root} revision={diff.hash} sides={{ old: diff.isNew ? null : images.old, new: diff.isDeleted ? null : images.new }} />;
  } else if (diff.binary || diff.encodedText) {
    const fallback = (
      <div className="empty">
        <div className="big">
          <FileWarning size={24} />
        </div>
        <h3>{diff.binary ? "Binary file" : "Text preview unavailable"}</h3>
        <div>No readable text with this encoding.</div>
      </div>
    );
    body = root && images ? <TextDiffPreview key={JSON.stringify([root, path])} root={root}
      revision={diff.hash} before={diff.isNew ? null : images.old} after={diff.isDeleted ? null : images.new} fallback={fallback} /> : fallback;
  } else if (diff.hunks.length === 0) {
    body = <div className="empty">{diff.previewLimited ? "No complete changed line fits in the preview." : diff.oldMode !== diff.newMode ? "Only the file mode changed." : sourceOptions && s.ignoreWhitespace ? "Only whitespace changed." : "No textual changes."}</div>;
  } else if (virtual) {
    // Very long diffs: fixed-height rows, only the visible window is rendered.
    const first = Math.max(0, Math.floor(scroll / rowH) - 30);
    const last = Math.min(vrows.length - 1, Math.ceil((scroll + viewH) / rowH) + 30);
    const rows: ReactNode[] = [];
    for (let i = first; i <= last; i++) {
      const r = vrows[i];
      const style: React.CSSProperties = { position: "absolute", top: i * rowH, left: 0, right: 0, height: rowH };
      if (r.kind === "hunk") rows.push(<Fragment key={"h" + r.h}>{hunkHeader(diff.hunks[r.h], r.h, { ...style, height: rowH })}</Fragment>);
      else if (r.kind === "line") rows.push(lineRow(r.h, r.l, style));
      else {
        const split: SplitProps = { hunk: diff.hunks[r.h], hi: r.h, toks: hl?.[r.h], words: words?.[r.h], sel, onToggle: toggle, interactive, hits: hitSet, onComment, whitespace: s.showWhitespace, moved, onDragOver: dragOver };
        rows.push(<div className="split-dl" key={`p${r.h}:${r.a}:${r.b}`} style={style}><SplitHalf {...split} idx={r.a} side="l" /><SplitHalf {...split} idx={r.b} side="r" /></div>);
      }
    }
    body = (
      <div className={`virtual-diff ${s.diffMode === "split" ? "virtual-split" : ""}`} style={{ height: vrows.length * rowH + 20, minWidth: s.diffMode === "split" ? undefined : textWidth + 150 }}>
        {rows}
      </div>
    );
  } else {
    body = (
      <>
        {diff.hunks.map((h, hi) => (
          <div className="hunk" key={hi}>
            {hunkHeader(h, hi)}
            {!collapsed.has(hi) &&
              (s.diffMode === "split" ? (
                <SplitHunk hunk={h} hi={hi} toks={hl?.[hi]} words={words?.[hi]} sel={sel} onToggle={toggle} interactive={interactive} hits={hitSet} onComment={onComment} whitespace={s.showWhitespace} moved={moved} onDragOver={dragOver}/>
              ) : (
                h.lines.map((_, li) => lineRow(hi, li))
              ))}
          </div>
        ))}
      </>
    );
  }

  return (
    <div className={`diff ${s.showWhitespace?"diff-whitespace":""}`} aria-busy={!!loading} data-diff-hash={diff?.hash} style={{ ["--diff-view-width" as string]: `${viewW}px`, ["--split-scroll" as string]: `${splitPan ? horizontal.position : 0}px`, ["--diff-tab-size" as string]: DIFF_TAB_SIZE }} onKeyDown={onKeyDown} tabIndex={-1} onCopy={event => {
      if (!wordSelection.all || (event.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const text = wordSelection.selectedText();
      if (text) { event.preventDefault(); event.clipboardData.setData("text/plain", text); }
    }}>
      {path && head}
      {findBar}
      {diff?.truncated && (
        <div className="callout warn" role="status" style={{ margin: 12 }}>
          <FileWarning size={15} /> {diff.previewLimited
            ? "The diff exceeds the preview size limit. Line and hunk actions are unavailable in this preview."
            : "The diff is very large; only the first lines are shown."}
        </div>
      )}
      <div ref={bodyRef} className={`diff-body ${!diff && loading && !error ? "diff-loading" : ""} ${s.wrapDiff ? "wrap" : ""}`} onScroll={(e) => {
        const el = e.currentTarget;
        // Only a virtual diff draws by scroll position, and only whole rows matter: scrolling a
        // normal diff, or within one row, redraws nothing.
        if (virtual) setScroll(Math.floor(el.scrollTop / rowH) * rowH);
        if (!splitPan) setHorizontal((h) => h.position === el.scrollLeft ? h : { ...h, position: el.scrollLeft });
      }}>
        <div ref={contentRef} className={`diff-content ${virtual ? "virtual-content" : ""} ${s.diffMode === "split" ? "split-content" : ""}`}
          onMouseDown={wordSelection.onMouseDown} onClick={wordSelection.onClick}
          onMouseDownCapture={selectionMenu.onMouseDownCapture}
          onContextMenu={e => {
            if (!(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) selectionMenu.onContextMenu(e);
          }}>{root && path && pointers && <SubmoduleSummary root={root} path={path} from={pointers.from} to={pointers.to} />}{body}</div>
      </div>
      {!s.wrapDiff && horizontal.max > 1 && (
        <div className="diff-hscroll">
          <span aria-hidden="true">↔</span>
          <input type="range" min={0} max={horizontal.max} step={1} value={Math.min(horizontal.position, horizontal.max)} aria-label="Horizontal code scroll"
            onChange={(e) => {
              const position = Number(e.target.value);
              if (splitPan) setHorizontal((h) => ({ ...h, position }));
              else if (bodyRef.current) bodyRef.current.scrollLeft = position;
            }} />
        </div>
      )}
      {interactive && sel.size > 0 && (
        <div className="sel-bar">
          <span>
            <b>{sel.size}</b> line{sel.size === 1 ? "" : "s"} selected
          </span>
          {mode === "unstaged" && (
            <>
              <button className="btn sm primary" disabled={busy} onClick={() => apply(selectedPairs(), "stage")}>
                <Plus size={12} /> Stage lines
              </button>
              {canStash && <button className="btn sm" disabled={busy} onClick={() => apply(selectedPairs(), "stash")}><Archive size={12} /> Stash lines</button>}
              {!loading && <button className="btn sm danger" disabled={busy} onClick={() => apply(selectedPairs(), "discard")}>
                <Undo2 size={12} /> Discard lines
              </button>}
            </>
          )}
          {mode === "staged" && (
            <button className="btn sm primary" disabled={busy} onClick={() => apply(selectedPairs(), "unstage")}>
              <Minus size={12} /> Unstage lines
            </button>
          )}
          {mode === "pick" && (
            <button className="btn sm primary" disabled={busy} onClick={() => apply(selectedPairs(), "apply")}>
              <Plus size={12} /> Apply to working tree
            </button>
          )}
          <button className="btn sm ghost" onClick={() => setSel(new Set())}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

type SplitProps = {
  hunk: DiffHunk;
  hi: number;
  toks: (Tok[] | undefined)[] | undefined;
  words: Map<number, Span[]> | undefined;
  sel: Set<string>;
  onToggle: (h: number, l: number, shift: boolean) => void;
  interactive: boolean;
  hits: Set<string>;
  onComment?: Props["onComment"];
  whitespace: boolean;
  moved?: Set<string>;
  onDragOver?: (h: number, l: number) => void;
};

/** Side-by-side rows of a hunk: [left line index | null, right line index | null]. */
function splitRows(lines: DiffLine[]): [number | null, number | null][] {
  const rows: [number | null, number | null][] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === " " || l.kind === "\\") {
      rows.push([i, l.kind === " " ? i : null]);
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && lines[i].kind === "-") dels.push(i++);
    while (i < lines.length && lines[i].kind === "+") adds.push(i++);
    if (!dels.length && !adds.length) { rows.push([i, null]); i++; continue; }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
  }
  return rows;
}

function SplitHalf({ idx, side, hunk: { lines }, hi, toks, words, sel, onToggle, interactive, hits, onComment, whitespace, moved, onDragOver }: SplitProps & { idx: number | null; side: "l" | "r" }) {
  if (idx === null) return <div className="half empty" />;
  const l = lines[idx];
  const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : "";
  const no = side === "l" ? l.oldNo : l.newNo;
  const k = `${hi}:${idx}`;
  return (
    <div
      data-line={k}
      onMouseEnter={onDragOver ? () => onDragOver(hi, idx) : undefined}
      className={`half ${cls} ${moved?.has(k) ? "moved" : ""} ${sel.has(k) ? "sel" : ""} ${hits.has(k) ? "search-hit" : ""}`}
      style={sel.has(k) ? { boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}
    >
      {onComment && no !== null ? <button className="ln review-line" title={`Comment on ${side === "l" ? "old" : "new"} line ${no}`} aria-label={`Comment on ${side === "l" ? "old" : "new"} line ${no}`} onClick={()=>onComment(side === "l" ? "LEFT" : "RIGHT",no)}>{no}</button> : <span className="ln" style={{ cursor: interactive && cls ? "pointer" : undefined }} onMouseDown={e=>onToggle(hi,idx,e.shiftKey)}>{no??""}</span>}
      <span className="mk">{l.kind === " " || l.kind === "\\" ? "" : l.kind}</span>
      <span className="code-viewport"><Code text={l.text} toks={toks?.[idx]} spans={words?.get(idx)} kind={l.kind} whitespace={whitespace} /></span>
    </div>
  );
}

function SplitHunk(props: SplitProps) {
  const rows = splitRows(props.hunk.lines);
  return (
    <div className="split-hunk">
      {rows.map(([a, b], ri) => (
        <div className="split-dl" key={ri}>
          <SplitHalf {...props} idx={a} side="l" />
          <SplitHalf {...props} idx={b} side="r" />
        </div>
      ))}
    </div>
  );
}
