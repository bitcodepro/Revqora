import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, History, ScanSearch, Search, X } from "lucide-react";
import type { LanguageSupport } from "@codemirror/language";
import { api, errorMessage } from "../lib/api";
import { useRepos } from "../lib/store";
import { closeOverlay, contextMenu, openOverlay, type MenuItem } from "../lib/ui";
import type { Blame } from "../lib/types";
import { absoluteTime, initials, relativeTime, shortOid, avatarHue } from "../lib/format";
import { highlightLines, languageFor, type Tok } from "../lib/languages";
import { jumpToCommit } from "./GraphView";
import { openInEditor } from "../lib/externalTools";
import { lineHistoryDialog } from "./HistoryDialogs";
import { useSettings, type BlameMoves } from "../lib/settings";
import { findLines, scrollToRow, stepMatch } from "../lib/blameFind";

const ROW = 20;

export function BlameView({ root, path, rev, line }: { root: string; path: string; rev: string | null; line?: number }) {
  const [blame, setBlame] = useState<Blame | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lang, setLang] = useState<LanguageSupport | null>(null);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [hover, setHover] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  /** Selected line range (final line numbers), for "History of these lines". */
  const [range, setRange] = useState<{ anchor: number; start: number; end: number } | null>(null);
  /** Keyboard-focused line index. */
  const [focus, setFocus] = useState<number | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const ignoreWhitespace = useSettings((s) => s.blameIgnoreWhitespace);
  const moves = useSettings((s) => s.blameMoves);
  const ignoreRevs = useSettings((s) => s.blameIgnoreRevs);
  const setSettings = useSettings((s) => s.set);

  useEffect(() => {
    let alive = true;
    setBlame(null);
    setErr(null);
    api.blame(root, path, rev, { ignoreWhitespace, moves, ignoreRevs }).then(
      (b) => alive && setBlame(b),
      (e) => alive && setErr(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [root, path, rev, ignoreWhitespace, moves, ignoreRevs]);

  useEffect(() => {
    let alive = true;
    languageFor(path).then((l) => alive && setLang(l));
    return () => {
      alive = false;
    };
  }, [path]);

  // The line texts are listed once per blame; typing searches them without blocking the input.
  const texts = useMemo(() => blame?.lines.map((l) => l.text) ?? [], [blame]);
  const searched = useDeferredValue(query);
  const matches = useMemo(() => (blame ? findLines(texts, searched) : []), [blame, texts, searched]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const reveal = (index: number) => {
    const el = ref.current;
    if (el) el.scrollTop = scrollToRow(index, ROW, el.scrollTop, el.clientHeight);
  };
  const openFind = () => {
    setFindOpen(true);
    setTimeout(() => findRef.current?.select(), 0);
  };
  const closeFind = () => {
    setFindOpen(false);
    setQuery("");
    ref.current?.focus();
  };
  const step = (backwards: boolean) => {
    const from = current >= 0 && matches[current] !== undefined ? matches[current] : (focus ?? Math.floor((ref.current?.scrollTop ?? 0) / ROW) - 1);
    const k = stepMatch(matches, from, backwards);
    if (k < 0) return;
    setCurrent(k);
    setFocus(matches[k]);
    reveal(matches[k]);
  };
  useEffect(() => {
    // New search text: go to the first match at or below the visible top.
    const top = Math.floor((ref.current?.scrollTop ?? 0) / ROW);
    const k = stepMatch(matches, top - 1, false);
    setCurrent(k);
    if (k >= 0) reveal(matches[k]);
  }, [matches]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [blame]);

  useEffect(() => {
    if (blame && line && ref.current) ref.current.scrollTop = Math.max(0, (line - 5) * ROW);
  }, [blame, line]);

  const toks = useMemo<Tok[][] | null>(() => {
    if (!blame || !lang) return null;
    try {
      return highlightLines(lang.language, blame.lines.map((l) => l.text));
    } catch {
      return null;
    }
  }, [blame, lang]);

  // Recency scale for the age bar.
  const [minT, maxT] = useMemo(() => {
    const ts = blame ? Object.values(blame.commits).map((c) => c.time).filter(Boolean) : [];
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : [0, 1];
  }, [blame]);

  const goto = (oid: string) => {
    closeOverlay();
    useRepos.getState().patch(root, { view: "history" });
    setTimeout(() => jumpToCommit(root, oid), 50);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!blame) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const n = blame.lines.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = Math.max(0, Math.min(n - 1, focus === null ? Math.floor((ref.current?.scrollTop ?? 0) / ROW) : focus + delta));
      setFocus(next);
      const lineNo = blame.lines[next].line;
      setRange((r) => (e.shiftKey && r ? { anchor: r.anchor, start: Math.min(r.anchor, lineNo), end: Math.max(r.anchor, lineNo) } : { anchor: lineNo, start: lineNo, end: lineNo }));
      reveal(next);
    } else if (e.key === "Enter" && focus !== null) {
      const l = blame.lines[focus];
      if (l && !/^0+$/.test(l.oid)) {
        e.preventDefault();
        goto(l.oid);
      }
    }
  };
  const lineMenu = (l: Blame["lines"][number]): MenuItem[] => {
    const committed = !/^0+$/.test(l.oid);
    const inRange = range && l.line >= range.start && l.line <= range.end && range.end > range.start;
    const dirtyNote = rev === null ? "Line numbers are taken from the last commit; uncommitted edits above these lines can shift them." : undefined;
    return [
      // One line: follow it from the commit that last changed it, at its line number there (exact).
      { label: "History of this line…", icon: <History size={14} />, disabled: !committed, hint: committed ? undefined : "not committed",
        onClick: () => void lineHistoryDialog(root, l.origPath || path, l.origLine, l.origLine, l.oid) },
      ...(inRange ? [{ label: `History of lines ${range.start}–${range.end}…`, icon: <History size={14} />,
        onClick: () => void lineHistoryDialog(root, path, range.start, range.end, rev, dirtyNote) }] : []),
      { separator: true },
      { label: "Open commit", disabled: !committed, onClick: () => goto(l.oid) },
      { label: "Open in editor at this line", onClick: () => void openInEditor(root, path, l.line) },
    ];
  };
  const dig = (prev: string) => {
    setHistory((h) => [...h, rev]);
    openOverlay({ kind: "blame", root, path, rev: prev });
  };
  const back = () => {
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    openOverlay({ kind: "blame", root, path, rev: prev ?? null });
  };

  const first = Math.max(0, Math.floor(scroll / ROW) - 10);
  const last = blame ? Math.min(blame.lines.length - 1, Math.ceil((scroll + viewH) / ROW) + 10) : -1;
  const rows: React.ReactNode[] = [];
  if (blame) {
    for (let i = first; i <= last; i++) {
      const l = blame.lines[i];
      const c = blame.commits[l.oid];
      const startsGroup = i === 0 || blame.lines[i - 1].oid !== l.oid;
      const uncommitted = /^0+$/.test(l.oid);
      const age = c && maxT > minT ? (c.time - minT) / (maxT - minT) : 1;
      rows.push(
        <div
          key={i}
          className={`blame-row ${range && l.line >= range.start && l.line <= range.end ? "selected" : ""}${matchSet.has(i) ? " find-match" : ""}${matches[current] === i ? " find-current" : ""}${focus === i ? " focused" : ""}`}
          onContextMenu={(e) => contextMenu(e, lineMenu(l))}
          style={{ top: i * ROW, background: hover === l.oid ? "var(--bg-selected)" : undefined, borderTop: startsGroup && i > 0 ? "1px solid var(--border-soft)" : undefined }}
          onMouseEnter={() => setHover(l.oid)}
        >
          <div className="blame-gutter" title={c && !uncommitted ? `${c.summary}\n${c.author} · ${absoluteTime(c.time)}\n${l.oid}${l.origPath && l.origPath !== path ? `\nFrom ${l.origPath}` : ""}` : "Not committed yet"}>
            <span className="age" style={{ opacity: 0.25 + age * 0.75 }} />
            {startsGroup && (
              <>
                {uncommitted ? (
                  <span className="faint" style={{ fontStyle: "italic" }}>
                    Not committed yet
                  </span>
                ) : (
                  c && (
                    <>
                      <span className="avatar" style={{ width: 16, height: 16, fontSize: 7, background: `hsl(${avatarHue(c.email || c.author)} 60% 48%)` }}>
                        {initials(c.author)}
                      </span>
                      <span className="sum" onClick={() => goto(l.oid)}>
                        {c.summary}
                      </span>
                      <span className="when">{relativeTime(c.time)}</span>
                      {c.previous && (
                        <button aria-label="Blame the version before this commit" className="icon-btn sm" title="Blame the version before this commit" onClick={() => dig(c.previous!)}>
                          <ScanSearch size={12} />
                        </button>
                      )}
                    </>
                  )
                )}
              </>
            )}
          </div>
          <span className="blame-ln" role="button" tabIndex={-1} title="Click to select lines (Shift+click for a range); right-click for their history"
            onClick={(e) => (setFocus(i), setRange((r) => (e.shiftKey && r ? { anchor: r.anchor, start: Math.min(r.anchor, l.line), end: Math.max(r.anchor, l.line) } : { anchor: l.line, start: l.line, end: l.line })))}>{l.line}</span>
          <span className="blame-code">
            {toks?.[i]?.length ? toks[i].map((t, k) => (t.cls ? <span key={k} className={t.cls}>{t.text}</span> : <Fragment key={k}>{t.text}</Fragment>)) : l.text || " "}
          </span>
        </div>,
      );
    }
  }

  return (
    <div className="conflict-overlay" onKeyDown={onKey}>
      <div className="cf-head">
        <ScanSearch size={18} style={{ color: "var(--accent)" }} />
        <div className="cf-title">
          <span className="p">Blame · {path}</span>
          <span className="s">{rev ? `at ${shortOid(rev)}` : "working tree"} · click a commit to open it in the graph</span>
        </div>
        <div className="spacer" />
        <label className="blame-opt" title="Ignore whitespace changes (git blame -w)">
          <input type="checkbox" checked={ignoreWhitespace} onChange={(e) => setSettings({ blameIgnoreWhitespace: e.target.checked })} /> Ignore whitespace
        </label>
        <label className="blame-opt" title="Attribute moved or copied lines to the commit that wrote them (git blame -M, or -C -C across files)">
          Moved lines
          <select aria-label="Detect moved lines" value={moves} onChange={(e) => setSettings({ blameMoves: e.target.value as BlameMoves })}>
            <option value="off">Off</option>
            <option value="file">Within file</option>
            <option value="files">Across files</option>
          </select>
        </label>
        <label className="blame-opt" title="Skip the commits listed in .git-blame-ignore-revs or blame.ignoreRevsFile">
          <input type="checkbox" checked={ignoreRevs} onChange={(e) => setSettings({ blameIgnoreRevs: e.target.checked })} /> Use ignore-revs file
        </label>
        <button className="icon-btn" aria-label="Find in blame" title="Find (Ctrl+F)" onClick={openFind}>
          <Search size={14} />
        </button>
        {history.length > 0 && (
          <button className="btn sm" onClick={back}>
            <ArrowLeft size={13} /> Back
          </button>
        )}
        <button className="btn" onClick={closeOverlay}>
          <X size={14} /> Close
        </button>
      </div>
      {findOpen && blame && (
        <div className="blame-find">
          <Search size={13} />
          <input
            ref={findRef}
            aria-label="Find text in blame"
            placeholder="Find in file"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
              }
            }}
          />
          <span className="faint">{query ? (matches.length ? `${current + 1} of ${matches.length}` : "No matches") : ""}</span>
          <button className="icon-btn sm" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => step(true)}>
            <ChevronUp size={13} />
          </button>
          <button className="icon-btn sm" aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => step(false)}>
            <ChevronDown size={13} />
          </button>
          <button className="icon-btn sm" aria-label="Close find" onClick={closeFind}>
            <X size={13} />
          </button>
        </div>
      )}
      {err && <div className="empty">{err}</div>}
      {!err && !blame && (
        <div className="loading-center">
          <span className="loader" />
        </div>
      )}
      {blame && (
        <div ref={ref} className="blame-scroll" tabIndex={0} aria-label="Blame lines (Up/Down move, Shift extends the selection, Enter opens the commit)" onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)} onMouseLeave={() => setHover(null)}>
          <div style={{ position: "relative", height: blame.lines.length * ROW }}>{rows}</div>
        </div>
      )}
    </div>
  );
}
