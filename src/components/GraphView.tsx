import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Filter,
  Loader2,
  Search,
  X,
  Zap,
} from "lucide-react";
import { api, newOpId } from "../lib/api";
import * as A from "../lib/actions";
import { loadGraph, useRepos, type RepoTab } from "../lib/store";
import { useSettings } from "../lib/settings";
import { contextMenu, copyText, endBusy, startBusy, toast } from "../lib/ui";
import type { GraphRow, SearchMode, Seg } from "../lib/types";
import { WORKTREE } from "../lib/types";
import { absoluteTime, fullTime, relativeTime } from "../lib/format";
import { Avatar, RefBadge } from "./bits";
import { branchMenu, commitMenu, tagMenu } from "./menus";

const ROW_H = 30;
/** Review mode: two-line rows (subject, then author, date and hash) without the graph. */
const COMPACT_ROW_H = 46;
const LANE_W = 15;
const PAD = 10;
/** Lanes beyond this are never drawn (the graph column is resizable up to it). */
const MAX_LANES = 64;
const MIN_GRAPH_W = 76;
const PAGE = 250;

const x = (c: number) => PAD + c * LANE_W + LANE_W / 2;

function segPath(s: Seg): { d: string; len: number } {
  const mid = ROW_H / 2;
  const xa = x(s.a);
  const xb = x(s.b);
  if (s.t === 0) return { d: `M${xa} 0V${ROW_H}`, len: ROW_H };
  if (s.t === 1) {
    if (s.a === s.b) return { d: `M${xa} 0V${mid}`, len: mid };
    return {
      d: `M${xa} 0C${xa} ${mid * 0.55} ${xb} ${mid * 0.45} ${xb} ${mid}`,
      len: Math.hypot(xb - xa, mid) * 1.15,
    };
  }
  if (s.a === s.b) return { d: `M${xa} ${mid}V${ROW_H}`, len: mid };
  return {
    d: `M${xa} ${mid}C${xa} ${mid + mid * 0.55} ${xb} ${mid + mid * 0.45} ${xb} ${ROW_H}`,
    len: Math.hypot(xb - xa, mid) * 1.15,
  };
}

interface RowProps {
  row: GraphRow | undefined;
  index: number;
  width: number;
  lanes: number;
  columns: { author: boolean; date: boolean; hash: boolean };
  selected: boolean;
  multi: boolean;
  match: boolean;
  dim: boolean;
  hl: number | null;
  animDelay: number | null;
  dateStyle: "relative" | "absolute";
  showRemote: boolean;
  root: string;
  onSelect: (row: GraphRow, e: React.MouseEvent) => void;
  onMenu: (row: GraphRow, e: React.MouseEvent) => void;
  onHover: (c: number | null) => void;
  onRefClick: (name: string) => void;
  compact: boolean;
  rowH: number;
}

const NO_BRANCHES: string[] = [];

const Row = memo(function Row(p: RowProps) {
  const squashed = useRepos((s) => s.tabs[p.root]?.squashMerged) ?? NO_BRANCHES;
  const headName =
    useRepos((s) => s.tabs[p.root]?.info?.head?.branch) ?? "HEAD";
  const top = p.index * p.rowH;
  if (!p.row && p.compact) {
    return (
      <div className="grow compact" style={{ top, height: p.rowH }}>
        <span
          className="skel"
          style={{ width: `${40 + ((p.index * 37) % 40)}%`, height: 10 }}
        />
        <span className="skel" style={{ width: "45%", height: 8 }} />
      </div>
    );
  }
  if (!p.row) {
    return (
      <div className="grow" style={{ top, height: ROW_H }}>
        <div className="g-graph" />
        <div className="g-subject">
          <span
            className="skel"
            style={{ width: `${40 + ((p.index * 37) % 40)}%`, height: 10 }}
          />
        </div>
        {p.columns.author && <div />}
        {p.columns.date && <div />}
        {p.columns.hash && <div />}
      </div>
    );
  }
  const r = p.row;
  const wip = r.oid === WORKTREE;
  const mid = ROW_H / 2;
  const nodeColor = `var(--lane-${r.color % 12})`;
  const refs = p.showRemote
    ? r.refs
    : r.refs.filter((l) => l.kind !== "remote");
  const anim =
    p.animDelay !== null ? { animationDelay: `${p.animDelay}ms` } : undefined;
  const badges = refs.map((l) => (
    <RefBadge
      key={l.kind + l.name}
      r={l}
      merged={
        squashed.includes(l.name) ||
        (!!l.syncedRemote && squashed.includes(l.syncedRemote))
          ? headName
          : undefined
      }
      color={l.kind === "local" || l.kind === "head" ? r.color : undefined}
      onClick={(e) =>
        (e.ctrlKey || e.metaKey) && (l.kind === "local" || l.kind === "remote")
          ? void A.checkout(p.root, l.name, l.kind)
          : p.onRefClick(l.name)
      }
      onContextMenu={(e) =>
        contextMenu(
          e,
          l.kind === "tag"
            ? tagMenu(p.root, l.name, r.oid)
            : l.kind === "detached"
              ? commitMenu(p.root, r, [r])
              : branchMenu(
                  p.root,
                  l.name,
                  l.kind === "remote" ? "remote" : "local",
                ),
        )
      }
    />
  ));
  if (p.compact) {
    const when =
      p.dateStyle === "relative"
        ? relativeTime(r.authorTime)
        : absoluteTime(r.authorTime);
    return (
      <div
        className={`grow compact ${p.selected ? "selected" : ""} ${p.multi ? "multi" : ""} ${p.match ? "match" : ""} ${p.dim ? "dim" : ""} ${wip ? "wip" : ""}`}
        style={{ top, height: p.rowH }}
        onMouseDown={(e) => e.button === 0 && p.onSelect(r, e)}
        onContextMenu={(e) => p.onMenu(r, e)}
        onDoubleClick={() => !wip && copyText(r.oid, "Hash copied")}
        title={
          wip
            ? undefined
            : `${r.subject}
${r.author} · ${fullTime(r.authorTime)}
${r.oid}`
        }
      >
        <div className="g-subject">
          {badges}
          <span className="text">{r.subject}</span>
        </div>
        {!wip && (
          <div className="c-meta">
            {r.author} · {when} ·{" "}
            <span className="mono">{r.oid.slice(0, 7)}</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={`grow ${p.selected ? "selected" : ""} ${p.multi ? "multi" : ""} ${p.match ? "match" : ""} ${p.dim ? "dim" : ""} ${wip ? "wip" : ""} ${p.animDelay !== null ? "animate" : ""}`}
      style={{ top, height: ROW_H, ...anim }}
      onMouseDown={(e) => e.button === 0 && p.onSelect(r, e)}
      onContextMenu={(e) => p.onMenu(r, e)}
      onDoubleClick={() => !wip && copyText(r.oid, "Hash copied")}
    >
      <div
        className="g-graph"
        onMouseEnter={() => p.onHover(r.color)}
        onMouseLeave={() => p.onHover(null)}
      >
        <svg width={p.width} height={ROW_H}>
          {r.segs.map((s, i) => {
            if (s.a >= p.lanes || s.b >= p.lanes) return null;
            const { d, len } = segPath(s);
            const dashed = wip && s.t === 2;
            return (
              <path
                key={i}
                d={d}
                stroke={`var(--lane-${s.c % 12})`}
                strokeDasharray={dashed ? "3 3" : undefined}
                className={p.hl === s.c ? "hl" : undefined}
                style={{
                  ["--len" as string]: Math.ceil(len),
                  animationDelay:
                    p.animDelay !== null ? `${p.animDelay}ms` : undefined,
                }}
              />
            );
          })}
          {r.col < p.lanes &&
            (wip ? (
              <circle
                className="node"
                cx={x(r.col)}
                cy={mid}
                r={5}
                fill="var(--bg)"
                stroke={nodeColor}
                strokeWidth={2}
                strokeDasharray="2.5 2"
              />
            ) : r.isHead ? (
              <>
                <circle
                  className="head-ring"
                  cx={x(r.col)}
                  cy={mid}
                  r={6}
                  stroke={nodeColor}
                />
                <circle
                  className={`node ${p.hl === r.color ? "hl" : ""}`}
                  cx={x(r.col)}
                  cy={mid}
                  r={6}
                  fill={nodeColor}
                  stroke="var(--bg)"
                  strokeWidth={2}
                />
                <circle cx={x(r.col)} cy={mid} r={2.2} fill="var(--bg)" />
              </>
            ) : r.isMerge ? (
              <circle
                className={`node ${p.hl === r.color ? "hl" : ""}`}
                cx={x(r.col)}
                cy={mid}
                r={3.6}
                fill={nodeColor}
                stroke="var(--bg)"
                strokeWidth={1.5}
              />
            ) : r.localOnly ? (
              <circle
                className={`node ${p.hl === r.color ? "hl" : ""}`}
                cx={x(r.col)}
                cy={mid}
                r={4.3}
                fill="var(--bg)"
                stroke={nodeColor}
                strokeWidth={2.2}
              />
            ) : (
              <circle
                className={`node ${p.hl === r.color ? "hl" : ""}`}
                cx={x(r.col)}
                cy={mid}
                r={4.6}
                fill={nodeColor}
                stroke="var(--bg)"
                strokeWidth={1.5}
              />
            ))}
        </svg>
      </div>
      <div className="g-subject">
        {badges}
        <span className="text" title={r.subject}>
          {r.subject}
        </span>
      </div>
      {p.columns.author && (
        <div className="g-author">
          {!wip && (
            <>
              <Avatar name={r.author} email={r.email} />
              <span className="n">{r.author}</span>
            </>
          )}
        </div>
      )}
      {p.columns.date && (
        <div className="g-date" title={wip ? "" : fullTime(r.authorTime)}>
          {wip
            ? ""
            : p.dateStyle === "relative"
              ? relativeTime(r.authorTime)
              : absoluteTime(r.authorTime)}
        </div>
      )}
      {p.columns.hash && (
        <div className="g-hash">{wip ? "" : r.oid.slice(0, 7)}</div>
      )}
    </div>
  );
});

export function GraphView({
  tab,
  onEnterChanges,
  compact = false,
}: {
  tab: RepoTab;
  onEnterChanges: () => void;
  compact?: boolean;
}) {
  const rowH = compact ? COMPACT_ROW_H : ROW_H;
  const root = tab.root;
  const summary = tab.graph;
  const patch = useRepos((s) => s.patch);
  const dateStyle = useSettings((s) => s.dateStyle);
  const showRemote = useSettings((s) => s.showRemoteBranchesInGraph);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<number, GraphRow>());
  const loadingPages = useRef(new Set<number>());
  const [, force] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [hl, setHl] = useState<number | null>(null);
  const [drawing, setDrawing] = useState(false);
  const firstDrawKey = useRef<string | null>(null);
  const anchor = useRef<number | null>(null);

  // search
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("quick");
  const [results, setResults] = useState<number[]>([]);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const [filterOnly, setFilterOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const matchSet = useMemo(() => new Set(results), [results]);

  const total = summary?.total ?? 0;

  // Offer git's commit-graph cache for large histories (once per repository).
  const dismissed = useSettings((s) => s.commitGraphDismissed.includes(root));
  const [cgMissing, setCgMissing] = useState(false);
  const [cgBusy, setCgBusy] = useState(false);
  useEffect(() => {
    if (total > 20000 && !dismissed)
      api.commitGraphStatus(root).then(
        (ok) => setCgMissing(!ok),
        () => {},
      );
    else setCgMissing(false);
  }, [root, total > 20000, dismissed]); // eslint-disable-line react-hooks/exhaustive-deps
  const writeCommitGraph = async () => {
    const id = newOpId();
    setCgBusy(true);
    startBusy(id, "Writing commit-graph");
    try {
      await api.commitGraphWrite(root, id);
      setCgMissing(false);
      toast.success(
        "Commit-graph written",
        "History ordering and branch comparisons are faster now.",
      );
      useRepos.getState().refresh(root, { graph: true });
    } catch (e) {
      toast.error(e, "Could not write the commit-graph");
    } finally {
      endBusy(id);
      setCgBusy(false);
    }
  };
  const graphWidthSetting = useSettings((s) => s.graphWidth);
  const columns = useSettings((s) => s.graphColumns);
  const autoLanes = Math.min(16, Math.max(summary?.maxLanes ?? 1, 2));
  const [dragW, setDragW] = useState<number | null>(null);
  // Never narrower than the "Graph" header label, or it runs into "Description".
  const graphW = Math.max(
    MIN_GRAPH_W,
    dragW ??
      (graphWidthSetting > 0
        ? graphWidthSetting
        : PAD * 2 + autoLanes * LANE_W),
  );
  const lanes = Math.min(MAX_LANES, Math.floor((graphW - PAD * 2) / LANE_W));
  const cols = [
    `${graphW}px`,
    "minmax(220px, 1fr)",
    columns.author ? "minmax(120px, 170px)" : "",
    columns.date ? "116px" : "",
    columns.hash ? "70px" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const hiddenLanes = (summary?.maxLanes ?? 0) > lanes;

  const cacheVersion = useRef(-1);
  const loadPage = useCallback(
    async (page: number, version: number) => {
      const key = version * 1_000_000 + page;
      if (loadingPages.current.has(key)) return;
      loadingPages.current.add(key);
      try {
        const rows = await api.graphRows(root, page * PAGE, PAGE);
        if (useRepos.getState().tabs[root]?.graphVersion !== version) return;
        // Keep showing the previous rows until the rebuilt graph delivers its first page.
        if (cacheVersion.current !== version) {
          cache.current = new Map();
          cacheVersion.current = version;
        }
        for (const r of rows) cache.current.set(r.index, r);
        force((n) => n + 1);
      } catch {
        /* history reloads on next refresh */
      } finally {
        loadingPages.current.delete(key);
      }
    },
    [root],
  );

  // Reset the row cache whenever the backend rebuilt the graph.
  useEffect(() => {
    force((n) => n + 1);
    if (summary && firstDrawKey.current !== root) {
      firstDrawKey.current = root;
      setDrawing(true);
      const t = setTimeout(() => setDrawing(false), 1100);
      return () => clearTimeout(t);
    }
  }, [tab.graphVersion, summary, root]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Rows visible (or filtered list when "show only matches" is on).
  const indexList: number[] | null =
    filterOnly && results.length ? results : null;
  const count = indexList ? indexList.length : total;
  const first = Math.max(0, Math.floor(scrollTop / rowH) - 8);
  const last = Math.min(count - 1, Math.ceil((scrollTop + viewH) / rowH) + 8);

  useEffect(() => {
    if (!summary) return;
    const need = new Set<number>();
    const fresh = cacheVersion.current === tab.graphVersion;
    for (let i = first; i <= last; i++) {
      const idx = indexList ? indexList[i] : i;
      if (idx !== undefined && (!fresh || !cache.current.has(idx)))
        need.add(Math.floor(idx / PAGE));
    }
    need.forEach((p) => loadPage(p, tab.graphVersion));
  });

  const rowAt = (i: number) => cache.current.get(i);

  // Reaching the end of a capped history loads the next chunk.
  const limitHit = !!summary && total >= tab.graphLimit && !tab.branchFilter;
  useEffect(() => {
    if (!limitHit || tab.graphLoading) return;
    if (last >= count - 50) {
      patch(root, { graphLimit: tab.graphLimit + 150_000 });
      setTimeout(() => loadGraph(root), 0);
    }
  }, [limitHit, last, count, tab.graphLoading, tab.graphLimit, root, patch]);
  const selectedIndex = useMemo(() => {
    if (!tab.selected) return -1;
    for (const [i, r] of cache.current) if (r.oid === tab.selected) return i;
    return -1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.selected, tab.graphVersion, cache.current.size]);

  const scrollToIndex = useCallback(
    (idx: number, center = false) => {
      const el = scrollRef.current;
      if (!el) return;
      const pos = indexList ? indexList.indexOf(idx) : idx;
      if (pos < 0) return;
      const y = pos * rowH;
      if (center)
        el.scrollTop = Math.max(0, y - el.clientHeight / 2 + rowH / 2);
      else if (y < el.scrollTop) el.scrollTop = y;
      else if (y + rowH > el.scrollTop + el.clientHeight)
        el.scrollTop = y + rowH - el.clientHeight;
    },
    [indexList],
  );

  const selectIndex = useCallback(
    async (idx: number) => {
      if (idx < 0 || idx >= total) return;
      let r = rowAt(idx);
      if (!r) {
        const rows = await api.graphRows(root, idx, 1).catch(() => []);
        r = rows[0];
      }
      if (!r) return;
      patch(root, { selected: r.oid, multi: [] });
      anchor.current = idx;
      scrollToIndex(idx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, total, scrollToIndex],
  );

  const onSelect = useCallback(
    (r: GraphRow, e: React.MouseEvent) => {
      scrollRef.current?.focus();
      if (r.oid === WORKTREE) {
        // Clicking "Uncommitted changes" opens the Changes view.
        patch(root, { selected: null, multi: [], view: "changes" });
        return;
      }
      const t = useRepos.getState().tabs[root];
      if (e.ctrlKey || e.metaKey) {
        const base = t?.multi.length
          ? t.multi
          : t?.selected && t.selected !== WORKTREE
            ? [t.selected]
            : [];
        const set = new Set(base);
        if (set.has(r.oid)) set.delete(r.oid);
        else set.add(r.oid);
        patch(root, { multi: [...set], selected: r.oid });
        anchor.current = r.index;
        return;
      }
      if (e.shiftKey && anchor.current !== null) {
        const [a, b] = [
          Math.min(anchor.current, r.index),
          Math.max(anchor.current, r.index),
        ];
        const oids: string[] = [];
        for (let i = a; i <= b; i++) {
          const rr = cache.current.get(i);
          if (rr && rr.oid !== WORKTREE) oids.push(rr.oid);
        }
        patch(root, { multi: oids, selected: r.oid });
        return;
      }
      anchor.current = r.index;
      // Clicking the selected commit again closes its details.
      const cur = useRepos.getState().tabs[root];
      patch(
        root,
        cur?.selected === r.oid && !cur.multi.length
          ? { selected: null, multi: [] }
          : { selected: r.oid, multi: [] },
      );
    },
    [root, patch],
  );

  const onMenu = useCallback(
    (r: GraphRow, e: React.MouseEvent) => {
      if (r.oid === WORKTREE) {
        e.preventDefault();
        return;
      }
      const t = useRepos.getState().tabs[root];
      const multi = t?.multi.includes(r.oid) ? t.multi : [];
      if (!multi.length && t?.selected !== r.oid)
        patch(root, { selected: r.oid, multi: [] });
      const sel = multi
        .map((o) => [...cache.current.values()].find((x) => x.oid === o))
        .filter(Boolean) as GraphRow[];
      contextMenu(e, commitMenu(root, r, sel.length > 1 ? sel : [r]));
    },
    [root, patch],
  );

  const onRefClick = useCallback(
    async (name: string) => {
      const idx = await api.graphFind(root, name).catch(() => null);
      if (idx !== null && idx !== undefined) selectIndex(idx);
    },
    [root, selectIndex],
  );

  // Jump to a commit when another part of the UI asks (sidebar click etc.).
  useEffect(() => {
    const onJump = (e: Event) => {
      const { root: r, oid } = (e as CustomEvent).detail as {
        root: string;
        oid: string;
      };
      if (r !== root) return;
      api.graphFind(root, oid).then((idx) => {
        if (idx === null || idx === undefined) {
          toast.info(
            "Commit is not in the loaded history",
            "It may be filtered out or older than the loaded range.",
          );
          return;
        }
        let rr = cache.current.get(idx);
        patch(root, { selected: rr?.oid ?? oid, multi: [] });
        anchor.current = idx;
        scrollToIndex(idx, true);
        if (!rr)
          api
            .graphRows(root, idx, 1)
            .then((rows) => rows[0] && patch(root, { selected: rows[0].oid }));
      });
    };
    window.addEventListener("revqora:jump", onJump);
    return () => window.removeEventListener("revqora:jump", onJump);
  }, [root, patch, scrollToIndex]);

  // Highlight a branch lane when it is hovered elsewhere (sidebar).
  useEffect(() => {
    const onHl = (e: Event) => {
      const { root: r, oid } = (e as CustomEvent).detail as {
        root: string;
        oid: string | null;
      };
      if (r !== root) return;
      if (!oid) return setHl(null);
      for (const row of cache.current.values()) {
        if (row.oid === oid) {
          setHl(row.color);
          return;
        }
      }
    };
    window.addEventListener("revqora:highlight", onHl);
    return () => window.removeEventListener("revqora:highlight", onHl);
  }, [root]);

  // Search (debounced for quick mode).
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setCursor(0);
      return;
    }
    const delay =
      mode === "quick" || mode === "hash" || mode === "author" ? 160 : 450;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.graphSearch(root, query, mode);
        setResults(res);
        setCursor(0);
        if (res.length) {
          scrollToIndex(res[0], true);
        }
      } catch (e) {
        toast.error(e, "Search failed");
      } finally {
        setSearching(false);
      }
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, root, tab.graphVersion]);

  const gotoResult = (dir: number) => {
    if (!results.length) return;
    const next = (cursor + dir + results.length) % results.length;
    setCursor(next);
    selectIndex(results[next]);
    scrollToIndex(results[next], true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "f" &&
        useRepos.getState().active === root &&
        tab.view === "history"
      ) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root, tab.view]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Alt+arrows belong to the file list of the commit details (and Alt+Left/Right to the
    // web view); only plain arrows move between commits.
    if (e.altKey && e.key.startsWith("Arrow")) return;
    const cur =
      selectedIndex >= 0 ? selectedIndex : tab.selected === WORKTREE ? 0 : -1;
    const pageRows = Math.max(1, Math.floor(viewH / rowH) - 1);
    if (e.key === "Escape" && tab.selected) {
      e.preventDefault();
      useRepos.getState().patch(tab.root, { selected: null, multi: [] });
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectIndex(Math.min(total - 1, cur + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectIndex(Math.max(0, cur - 1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      selectIndex(Math.min(total - 1, cur + pageRows));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      selectIndex(Math.max(0, cur - pageRows));
    } else if (e.key === "Home") {
      e.preventDefault();
      selectIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      selectIndex(total - 1);
    } else if (e.key === "Enter" && tab.selected === WORKTREE) {
      onEnterChanges();
    } else if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "c" &&
      tab.selected &&
      tab.selected !== WORKTREE
    ) {
      e.preventDefault();
      copyText(tab.selected, "Hash copied");
    }
  };

  const multiSet = useMemo(() => new Set(tab.multi), [tab.multi]);
  const rows: React.ReactNode[] = [];
  if (summary) {
    for (let i = first; i <= last; i++) {
      const idx = indexList ? indexList[i] : i;
      const r = rowAt(idx);
      rows.push(
        <Row
          key={idx}
          row={r}
          index={i}
          width={graphW}
          lanes={lanes}
          columns={columns}
          selected={!!r && r.oid === tab.selected}
          multi={!!r && multiSet.has(r.oid)}
          match={matchSet.has(idx)}
          dim={
            !indexList &&
            results.length > 0 &&
            query.trim() !== "" &&
            !matchSet.has(idx) &&
            r?.oid !== WORKTREE
          }
          hl={hl}
          animDelay={drawing ? Math.max(0, i - first) * 16 : null}
          dateStyle={dateStyle}
          showRemote={showRemote}
          root={root}
          onSelect={onSelect}
          onMenu={onMenu}
          onHover={setHl}
          onRefClick={onRefClick}
          compact={compact}
          rowH={rowH}
        />,
      );
    }
  }

  return (
    <div className="graph-panel">
      <div
        className="hstack"
        style={{
          padding: "8px 12px",
          gap: 8,
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <div className="search-box" style={{ width: "min(560px, 60%)" }}>
          {searching ? (
            <Loader2 size={14} className="spin faint" />
          ) : (
            <Search size={14} className="faint" />
          )}
          <input
            ref={searchRef}
            value={query}
            placeholder="Search commits  (Ctrl+F)"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") gotoResult(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") {
                setQuery("");
                scrollRef.current?.focus();
              }
            }}
          />
          {query && (
            <span className="count">
              {results.length
                ? `${cursor + 1} / ${results.length}`
                : searching
                  ? ""
                  : "No results"}
            </span>
          )}
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as SearchMode)}
            title="What to search"
          >
            <option value="quick">All</option>
            <option value="message">Message</option>
            <option value="author">Author</option>
            <option value="hash">Hash</option>
            <option value="content">Code (pickaxe)</option>
            <option value="path">File path</option>
          </select>
          <button
            className="icon-btn sm"
            onClick={() => gotoResult(-1)}
            disabled={!results.length}
            title="Previous (Shift+Enter)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            className="icon-btn sm"
            onClick={() => gotoResult(1)}
            disabled={!results.length}
            title="Next (Enter)"
          >
            <ChevronDown size={14} />
          </button>
          <button
            className={`icon-btn sm ${filterOnly ? "active" : ""}`}
            onClick={() => setFilterOnly((v) => !v)}
            title="Show only matching commits"
          >
            <Filter size={13} />
          </button>
          {query && (
            <button
              className="icon-btn sm"
              onClick={() => setQuery("")}
              title="Clear"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {tab.branchFilter && (
          <span className="pill accent" style={{ height: 24, gap: 6 }}>
            Only {tab.branchFilter}
            <X
              size={12}
              style={{ cursor: "pointer" }}
              onClick={() => {
                patch(root, { branchFilter: null });
                setTimeout(
                  () => useRepos.getState().refresh(root, { graph: true }),
                  0,
                );
              }}
            />
          </span>
        )}
        <div className="spacer" />
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          {total
            ? `${(total - (tab.graphHasWorktree ? 1 : 0)).toLocaleString()} commits`
            : ""}
          {tab.graphLoading && (
            <Loader2
              size={12}
              className="spin"
              style={{ marginLeft: 6, verticalAlign: -2 }}
            />
          )}
        </span>
      </div>
      {cgMissing && (
        <div
          className="callout"
          style={{ margin: "8px 12px 0", alignItems: "center" }}
        >
          <Zap size={15} />
          <div style={{ flex: 1 }}>
            This history has {total.toLocaleString()} commits. Writing git's{" "}
            <b>commit-graph</b> cache makes ordering and branch comparisons
            faster. It only adds a file under .git and changes nothing else.
          </div>
          <button
            className="btn sm primary"
            onClick={writeCommitGraph}
            disabled={cgBusy}
          >
            {cgBusy ? (
              <Loader2 size={12} className="spin" />
            ) : (
              <Zap size={12} />
            )}{" "}
            Speed up
          </button>
          <button
            className="btn sm ghost"
            onClick={() => {
              const st = useSettings.getState();
              st.set({
                commitGraphDismissed: [...st.commitGraphDismissed, root],
              });
            }}
          >
            Not now
          </button>
        </div>
      )}
      {!compact && (
        <div
          className="graph-cols"
          style={{ gridTemplateColumns: cols }}
          onContextMenu={(e) =>
            contextMenu(e, [
              {
                label: "Author",
                checked: columns.author,
                onClick: () =>
                  useSettings
                    .getState()
                    .set({
                      graphColumns: { ...columns, author: !columns.author },
                    }),
              },
              {
                label: "Date",
                checked: columns.date,
                onClick: () =>
                  useSettings
                    .getState()
                    .set({ graphColumns: { ...columns, date: !columns.date } }),
              },
              {
                label: "Hash",
                checked: columns.hash,
                onClick: () =>
                  useSettings
                    .getState()
                    .set({ graphColumns: { ...columns, hash: !columns.hash } }),
              },
              { separator: true },
              {
                label: "Fit graph to all lanes",
                onClick: () =>
                  useSettings
                    .getState()
                    .set({
                      graphWidth:
                        PAD * 2 +
                        Math.min(MAX_LANES, summary?.maxLanes ?? 4) * LANE_W,
                    }),
              },
              {
                label: "Automatic graph width",
                onClick: () => useSettings.getState().set({ graphWidth: 0 }),
              },
            ])
          }
          title="Right-click to choose columns"
        >
          <span
            style={{
              paddingLeft: 12,
              position: "relative",
              alignSelf: "stretch",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            Graph
            {hiddenLanes && (
              <span
                className="pill amber"
                style={{ height: 15, fontSize: 9 }}
                title="Some branches are hidden — drag the edge to widen"
              >
                +{(summary?.maxLanes ?? 0) - lanes}
              </span>
            )}
            <span
              className="col-resize"
              onMouseDown={(e) => {
                e.preventDefault();
                const start = e.clientX;
                const base = graphW;
                let latest = base;
                const move = (ev: MouseEvent) => {
                  latest = Math.max(
                    PAD * 2 + 2 * LANE_W,
                    Math.min(
                      PAD * 2 + MAX_LANES * LANE_W,
                      base + ev.clientX - start,
                    ),
                  );
                  setDragW(latest);
                };
                const up = () => {
                  window.removeEventListener("mousemove", move);
                  window.removeEventListener("mouseup", up);
                  useSettings.getState().set({ graphWidth: latest });
                  setDragW(null);
                };
                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
              }}
              onDoubleClick={() =>
                useSettings.getState().set({ graphWidth: 0 })
              }
            />
          </span>
          <span>Description</span>
          {columns.author && <span>Author</span>}
          {columns.date && <span>Date</span>}
          {columns.hash && <span style={{ textAlign: "right" }}>Hash</span>}
        </div>
      )}
      <div
        ref={scrollRef}
        className={`graph-scroll ${drawing ? "drawing" : ""}`}
        tabIndex={0}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        onKeyDown={onKeyDown}
        data-hl={hl !== null ? hl : undefined}
      >
        {!summary && (
          <div className="loading-center" style={{ height: "100%" }}>
            <span className="loader" />
          </div>
        )}
        {summary && total === 0 && (
          <div className="empty" style={{ height: "100%" }}>
            <h3>No commits yet</h3>
            <div>Make your first commit in the Changes view.</div>
          </div>
        )}
        <div
          className="graph-rows"
          style={{ height: count * rowH, ["--cols" as string]: cols }}
        >
          <style>{`.graph-rows > .grow { grid-template-columns: ${cols}; }`}</style>
          {rows}
        </div>
      </div>
    </div>
  );
}

export function highlightBranch(root: string, oid: string | null) {
  window.dispatchEvent(
    new CustomEvent("revqora:highlight", { detail: { root, oid } }),
  );
}

export function jumpToCommit(root: string, oid: string) {
  window.dispatchEvent(
    new CustomEvent("revqora:jump", { detail: { root, oid } }),
  );
}
