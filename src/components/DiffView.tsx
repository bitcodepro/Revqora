import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlignJustify,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Columns2,
  FileDiff as FileDiffIcon,
  FileWarning,
  Maximize2,
  Minus,
  Plus,
  Search,
  Space,
  Trash2,
  WrapText,
  X,
} from "lucide-react";
import type { DiffHunk, DiffLine, FileDiff } from "../lib/types";
import { useSettings } from "../lib/settings";
import { highlightLines, languageFor, type Tok } from "../lib/languages";
import { wordDiff, type Span } from "../lib/worddiff";
import { basename, dirname } from "../lib/format";
import type { LanguageSupport } from "@codemirror/language";
import { ImageDiff, isImagePath, type ImageSides } from "./ImageDiff";

export type DiffMode = "unstaged" | "staged" | "readonly" | "pick";
export type LineAction = "stage" | "unstage" | "discard" | "apply";

interface Props {
  diff: FileDiff | null;
  loading?: boolean;
  error?: string | null;
  mode: DiffMode;
  path: string;
  badge?: ReactNode;
  actions?: ReactNode;
  onApply?: (selection: [number, number][], action: LineAction) => Promise<void> | void;
  emptyText?: string;
  /** Repository root and blob locations used to preview binary images. */
  root?: string;
  images?: ImageSides;
}

/** Diff options from the settings (context / whole file / whitespace) for backend calls. */
export function useDiffOpts() {
  const ctx = useSettings((s) => s.contextLines);
  const full = useSettings((s) => s.diffFullFile);
  const ws = useSettings((s) => s.ignoreWhitespace);
  return useMemo(() => ({ context: full ? 100000 : ctx, ignoreWhitespace: ws }), [ctx, full, ws]);
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

function renderCode(text: string, toks: Tok[] | undefined, spans: Span[] | undefined, kind: string): ReactNode {
  if (spans && spans.some((s) => s.changed)) {
    const cls = kind === "+" ? "w-add" : "w-del";
    return spans.map((s, i) => (s.changed ? <span key={i} className={cls}>{s.text}</span> : <Fragment key={i}>{s.text}</Fragment>));
  }
  if (toks && toks.length) return toks.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : <Fragment key={i}>{t.text}</Fragment>));
  return text || " ";
}

type FlatRow = { kind: "hunk"; h: number } | { kind: "line"; h: number; l: number };

export function DiffView({ diff, loading, error, mode, path, badge, actions, onApply, emptyText, root, images }: Props) {
  const s = useSettings();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<{ h: number; l: number } | null>(null);
  const [busy, setBusy] = useState(false);
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
  const virtual = totalLines > VIRTUAL_THRESHOLD && !s.wrapDiff && s.diffMode === "unified";
  // Highlighting tens of thousands of lines costs more than it helps.
  const hl = useHighlight(path, diff?.hunks, totalLines < 20000);
  const words = useMemo(() => {
    if (!diff || totalLines > 20000) return null;
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
  }, [diff, totalLines]);

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
    let width = 0;
    for (const h of diff.hunks) for (const line of h.lines) {
      width = Math.max(width, context.measureText(line.text.replace(/\t/g, "    ")).width);
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

  // Flattened rows (used for virtualization, search and change navigation).
  const flat = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    diff?.hunks.forEach((h, hi) => {
      out.push({ kind: "hunk", h: hi });
      if (!collapsed.has(hi)) h.lines.forEach((_, li) => out.push({ kind: "line", h: hi, l: li }));
    });
    return out;
  }, [diff, collapsed]);

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
      const idx = flat.findIndex((r) => r.h === h && (l === null ? r.kind === "hunk" : r.kind === "line" && r.l === l));
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
      ? diff.hunks.map((_, hi) => flat.findIndex((r) => r.kind === "hunk" && r.h === hi) * rowH)
      : diff.hunks.map((_, hi) => el.querySelector<HTMLElement>(`[data-hunk="${hi}"]`)?.offsetTop ?? 0);
    const cur = el.scrollTop + 4;
    const idx = dir > 0 ? tops.findIndex((t) => t > cur + 8) : tops.map((t, i) => [t, i] as const).filter(([t]) => t < cur - 8).pop()?.[1] ?? -1;
    if (idx >= 0) el.scrollTop = Math.max(0, tops[idx] - 8);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "F7") {
      e.preventDefault();
      jumpChange(e.shiftKey ? -1 : 1);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      setFindOpen(true);
      setTimeout(() => findRef.current?.select(), 0);
    }
  };

  const toggle = (h: number, l: number, shift: boolean) => {
    if (!interactive || !diff) return;
    const line = diff.hunks[h].lines[l];
    if (line.kind !== "+" && line.kind !== "-") return;
    const next = new Set(sel);
    if (shift && anchor && anchor.h === h) {
      const [a, b] = [Math.min(anchor.l, l), Math.max(anchor.l, l)];
      for (let i = a; i <= b; i++) {
        const k = diff.hunks[h].lines[i].kind;
        if (k === "+" || k === "-") next.add(key(h, i));
      }
    } else {
      const k = key(h, l);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      setAnchor({ h, l });
    }
    setSel(next);
  };

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
      <button
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
              <button className="btn sm ghost" disabled={busy} onClick={() => apply(hunkSelection(hi), "discard")} title="Discard hunk">
                <Trash2 size={12} />
              </button>
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
      <div key={k} data-line={k} className={`dl ${cls} ${sel.has(k) ? "sel" : ""} ${selectable ? "selectable" : ""} ${hit}`} style={style}>
        <span className="ln" onMouseDown={(e) => toggle(hi, li, e.shiftKey)}>
          {l.oldNo ?? ""}
        </span>
        <span className="ln" onMouseDown={(e) => toggle(hi, li, e.shiftKey)}>
          {l.newNo ?? ""}
        </span>
        <span className="mk">{l.kind === " " || l.kind === "\\" ? "" : l.kind}</span>
        <span className="code">{l.kind === "\\" ? l.text : renderCode(l.text, hl?.[hi]?.[li], words?.[hi]?.get(li), l.kind)}</span>
      </div>
    );
  };

  const head = (
    <div className="diff-head">
      <div className="path" title={path}>
        {dirname(path) && <span className="dir">{dirname(path)}/</span>}
        {basename(path)}
      </div>
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
      <div className="spacer" />
      {actions}
      {diff && diff.hunks.length > 1 && (
        <>
          <button className="icon-btn" title="Previous change (Shift+F7)" onClick={() => jumpChange(-1)}>
            <ChevronsUp size={15} />
          </button>
          <button className="icon-btn" title="Next change (F7)" onClick={() => jumpChange(1)}>
            <ChevronsDown size={15} />
          </button>
        </>
      )}
      <button
        className={`icon-btn ${findOpen ? "active" : ""}`}
        title="Find in diff (Ctrl+F)"
        onClick={() => {
          setFindOpen((v) => !v);
          setTimeout(() => findRef.current?.focus(), 0);
        }}
      >
        <Search size={15} />
      </button>
      <div className="seg" style={{ marginLeft: 6 }}>
        <button className={s.diffMode === "unified" ? "on" : ""} onClick={() => s.set({ diffMode: "unified" })} title="Unified">
          <AlignJustify size={13} />
        </button>
        <button className={s.diffMode === "split" ? "on" : ""} onClick={() => s.set({ diffMode: "split" })} title="Side by side">
          <Columns2 size={13} />
        </button>
      </div>
      <button className={`icon-btn ${s.diffFullFile ? "active" : ""}`} title="Show the whole file" onClick={() => s.set({ diffFullFile: !s.diffFullFile })}>
        <Maximize2 size={14} />
      </button>
      <button className={`icon-btn ${s.ignoreWhitespace ? "active" : ""}`} title="Ignore whitespace" onClick={() => s.set({ ignoreWhitespace: !s.ignoreWhitespace })}>
        <Space size={15} />
      </button>
      <button className={`btn sm diff-wrap ${s.wrapDiff ? "active" : ""}`} title="Wrap lines" aria-pressed={s.wrapDiff} onClick={() => s.set({ wrapDiff: !s.wrapDiff })}>
        <WrapText size={15} /> Wrap lines
      </button>
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
      <button className="icon-btn sm" onClick={() => setHitIdx((i) => (hits.length ? (i + hits.length - 1) % hits.length : 0))} disabled={!hits.length}>
        <ChevronsUp size={13} />
      </button>
      <button className="icon-btn sm" onClick={() => setHitIdx((i) => (hits.length ? (i + 1) % hits.length : 0))} disabled={!hits.length}>
        <ChevronsDown size={13} />
      </button>
      <button
        className="icon-btn sm"
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
      <div className="loading-center">
        <span className="loader" />
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
    body = <ImageDiff root={root} sides={{ old: diff.isNew ? null : images.old, new: diff.isDeleted ? null : images.new }} />;
  } else if (diff.binary) {
    body = (
      <div className="empty">
        <div className="big">
          <FileWarning size={24} />
        </div>
        <h3>Binary file</h3>
        <div>{diff.isNew ? "Added" : diff.isDeleted ? "Deleted" : "Changed"} — no text diff available.</div>
      </div>
    );
  } else if (diff.hunks.length === 0) {
    body = <div className="empty">{diff.oldMode !== diff.newMode ? "Only the file mode changed." : s.ignoreWhitespace ? "Only whitespace changed." : "No textual changes."}</div>;
  } else if (virtual) {
    // Very long diffs: fixed-height rows, only the visible window is rendered.
    const first = Math.max(0, Math.floor(scroll / rowH) - 30);
    const last = Math.min(flat.length - 1, Math.ceil((scroll + viewH) / rowH) + 30);
    const rows: ReactNode[] = [];
    for (let i = first; i <= last; i++) {
      const r = flat[i];
      const style: React.CSSProperties = { position: "absolute", top: i * rowH, left: 0, right: 0, height: rowH };
      rows.push(r.kind === "hunk" ? <Fragment key={"h" + r.h}>{hunkHeader(diff.hunks[r.h], r.h, { ...style, height: rowH })}</Fragment> : lineRow(r.h, r.l, style));
    }
    body = (
      <div className="virtual-diff" style={{ height: flat.length * rowH + 20, minWidth: textWidth + 150 }}>
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
                <SplitHunk hunk={h} hi={hi} toks={hl?.[hi]} words={words?.[hi]} sel={sel} onToggle={toggle} interactive={interactive} hits={hitSet} />
              ) : (
                h.lines.map((_, li) => lineRow(hi, li))
              ))}
          </div>
        ))}
        {diff.truncated && (
          <div className="callout warn" style={{ margin: 12 }}>
            <FileWarning size={15} /> The diff is very large; only the first lines are shown.
          </div>
        )}
      </>
    );
  }

  return (
    <div className="diff" style={{ ["--diff-view-width" as string]: `${viewW}px`, ["--split-scroll" as string]: `${splitPan ? horizontal.position : 0}px` }} onKeyDown={onKeyDown} tabIndex={-1}>
      {path && head}
      {findBar}
      <div ref={bodyRef} className={`diff-body ${s.wrapDiff ? "wrap" : ""}`} onScroll={(e) => {
        const el = e.currentTarget;
        setScroll(el.scrollTop);
        if (!splitPan) setHorizontal((h) => h.position === el.scrollLeft ? h : { ...h, position: el.scrollLeft });
      }}>
        <div ref={contentRef} className={`diff-content ${virtual ? "virtual-content" : ""} ${s.diffMode === "split" ? "split-content" : ""}`}>{body}</div>
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
              <button className="btn sm danger" disabled={busy} onClick={() => apply(selectedPairs(), "discard")}>
                <Trash2 size={12} /> Discard lines
              </button>
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

function SplitHunk({
  hunk,
  hi,
  toks,
  words,
  sel,
  onToggle,
  interactive,
  hits,
}: {
  hunk: DiffHunk;
  hi: number;
  toks: (Tok[] | undefined)[] | undefined;
  words: Map<number, Span[]> | undefined;
  sel: Set<string>;
  onToggle: (h: number, l: number, shift: boolean) => void;
  interactive: boolean;
  hits: Set<string>;
}) {
  // Build rows of [left index | null, right index | null].
  const rows: [number | null, number | null][] = [];
  const lines = hunk.lines;
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
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
  }
  const half = (idx: number | null, side: "l" | "r") => {
    if (idx === null) return <div className="half empty" />;
    const l = lines[idx];
    const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : "";
    const no = side === "l" ? l.oldNo : l.newNo;
    const k = `${hi}:${idx}`;
    return (
      <div
        data-line={k}
        className={`half ${cls} ${sel.has(k) ? "sel" : ""} ${hits.has(k) ? "search-hit" : ""}`}
        style={sel.has(k) ? { boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}
      >
        <span className="ln" style={{ cursor: interactive && cls ? "pointer" : undefined }} onMouseDown={(e) => onToggle(hi, idx, e.shiftKey)}>
          {no ?? ""}
        </span>
        <span className="mk">{l.kind === " " || l.kind === "\\" ? "" : l.kind}</span>
        <span className="code-viewport"><span className="code">{l.kind === "\\" ? l.text : renderCode(l.text, toks?.[idx], words?.get(idx), l.kind)}</span></span>
      </div>
    );
  };
  return (
    <div className="split-hunk">
      {rows.map(([a, b], ri) => (
        <div className="split-dl" key={ri}>
          {half(a, "l")}
          {half(b, "r")}
        </div>
      ))}
    </div>
  );
}
