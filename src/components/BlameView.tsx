import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ScanSearch, X } from "lucide-react";
import type { LanguageSupport } from "@codemirror/language";
import { api, errorMessage } from "../lib/api";
import { useRepos } from "../lib/store";
import { closeOverlay, openOverlay } from "../lib/ui";
import type { Blame } from "../lib/types";
import { absoluteTime, initials, relativeTime, shortOid, avatarHue } from "../lib/format";
import { highlightLines, languageFor, type Tok } from "../lib/languages";
import { jumpToCommit } from "./GraphView";

const ROW = 20;
const NOT_COMMITTED = "0000000000000000000000000000000000000000";

export function BlameView({ root, path, rev, line }: { root: string; path: string; rev: string | null; line?: number }) {
  const [blame, setBlame] = useState<Blame | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lang, setLang] = useState<LanguageSupport | null>(null);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [hover, setHover] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setBlame(null);
    setErr(null);
    api.blame(root, path, rev).then(
      (b) => alive && setBlame(b),
      (e) => alive && setErr(errorMessage(e)),
    );
    languageFor(path).then((l) => alive && setLang(l));
    return () => {
      alive = false;
    };
  }, [root, path, rev]);

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
      const uncommitted = l.oid === NOT_COMMITTED;
      const age = c && maxT > minT ? (c.time - minT) / (maxT - minT) : 1;
      rows.push(
        <div
          key={i}
          className="blame-row"
          style={{ top: i * ROW, background: hover === l.oid ? "var(--bg-selected)" : undefined, borderTop: startsGroup && i > 0 ? "1px solid var(--border-soft)" : undefined }}
          onMouseEnter={() => setHover(l.oid)}
        >
          <div className="blame-gutter" title={c && !uncommitted ? `${c.summary}\n${c.author} · ${absoluteTime(c.time)}\n${l.oid}` : "Not committed yet"}>
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
                        <button className="icon-btn sm" title="Blame the version before this commit" onClick={() => dig(c.previous!)}>
                          <ScanSearch size={12} />
                        </button>
                      )}
                    </>
                  )
                )}
              </>
            )}
          </div>
          <span className="blame-ln">{l.line}</span>
          <span className="blame-code">
            {toks?.[i]?.length ? toks[i].map((t, k) => (t.cls ? <span key={k} className={t.cls}>{t.text}</span> : <Fragment key={k}>{t.text}</Fragment>)) : l.text || " "}
          </span>
        </div>,
      );
    }
  }

  return (
    <div className="conflict-overlay">
      <div className="cf-head">
        <ScanSearch size={18} style={{ color: "var(--accent)" }} />
        <div className="cf-title">
          <span className="p">Blame · {path}</span>
          <span className="s">{rev ? `at ${shortOid(rev)}` : "working tree"} · click a commit to open it in the graph</span>
        </div>
        <div className="spacer" />
        {history.length > 0 && (
          <button className="btn sm" onClick={back}>
            <ArrowLeft size={13} /> Back
          </button>
        )}
        <button className="btn" onClick={closeOverlay}>
          <X size={14} /> Close
        </button>
      </div>
      {err && <div className="empty">{err}</div>}
      {!err && !blame && (
        <div className="loading-center">
          <span className="loader" />
        </div>
      )}
      {blame && (
        <div ref={ref} className="blame-scroll" onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)} onMouseLeave={() => setHover(null)}>
          <div style={{ position: "relative", height: blame.lines.length * ROW }}>{rows}</div>
        </div>
      )}
    </div>
  );
}
