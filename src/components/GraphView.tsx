import { Fragment, memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Filter,
  FolderSearch,
  Loader2,
  Search,
  X,
  Zap,
} from "lucide-react";
import { api, newOpId } from "../lib/api";
import {cachedGraphRows,rememberGraphRows,rememberGraphPosition} from "../lib/graphRowsCache";
import * as A from "../lib/actions";
import { CURRENT_HISTORY_BRANCH, hasMoreHistory, INITIAL_GRAPH_COMMITS, loadEntireHistory, loadGraph, useRepos, type RepoTab } from "../lib/store";
import { useSettings } from "../lib/settings";
import { repositoryKey } from "../lib/repositoryLibrary";
import { actionFor, matchesShortcut, shortcutTitle } from "../lib/shortcuts";
import { contextMenu, copyText, endBusy, startBusy, toast } from "../lib/ui";
import type { GraphLaneAnchor, GraphRow, GraphSummary, RefLabel, SearchMode, Seg } from "../lib/types";
import { WORKTREE } from "../lib/types";
import { absoluteTime, fullTime, relativeTime, shortOid } from "../lib/format";
import { BranchAheadBehind, Avatar, RefBadge } from "./bits";
import { branchMenu, commitMenu, runMenuShortcut, tagMenu } from "./menus";
import { workspaceCommitSearch } from "./WorkspaceCommitSearch";
import { usePanelTitleMenu } from "./PanelWindows";

const ROW_H = 30;
/** Review mode: two-line rows (subject, then author, date and hash) without the graph. */
const COMPACT_ROW_H = 46;
const LANE_W = 15;
const PAD = 10;
/** Lanes beyond this are never drawn (the graph column is resizable up to it). */
const MAX_LANES = 64;
const MIN_GRAPH_W = 76;
const PAGE = 250;
const BRANCH_CONTEXT_SCOPE = "branch-context";
const branchName = (reference: string) => reference.replace(/^refs\/(heads|remotes)\//, "");

function matchesBranch(label: RefLabel, reference: string | null | undefined) {
  if (!reference) return false;
  if (label.kind === "local" || label.kind === "head") return reference === `refs/heads/${label.name}` ||
    (!!label.syncedRemote && reference === `refs/remotes/${label.syncedRemote}`);
  return label.kind === "remote" && reference === `refs/remotes/${label.name}`;
}

interface LanePin {
  key: string;
  id: number;
  anchor?: GraphLaneAnchor;
}

const x = (c: number) => PAD + c * LANE_W + LANE_W / 2;

function segPath(s: Seg, height: number): { d: string; len: number } {
  const mid = height / 2;
  const xa = x(s.a);
  const xb = x(s.b);
  if (s.t === 0) return { d: `M${xa} 0V${height}`, len: height };
  if (s.t === 1) {
    if (s.a === s.b) return { d: `M${xa} 0V${mid}`, len: mid };
    return {
      d: `M${xa} 0C${xa} ${mid * 0.55} ${xb} ${mid * 0.45} ${xb} ${mid}`,
      len: Math.hypot(xb - xa, mid) * 1.15,
    };
  }
  if (s.a === s.b) return { d: `M${xa} ${mid}V${height}`, len: mid };
  return {
    d: `M${xa} ${mid}C${xa} ${mid + mid * 0.55} ${xb} ${mid + mid * 0.45} ${xb} ${height}`,
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
  keyboardHighlighted: boolean;
  multi: boolean;
  match: boolean;
  dim: boolean;
  hl: number | null;
  pinnedLaneMember: boolean;
  branchMember: boolean;
  branchContext: GraphSummary["branchContext"];
  animDelay: number | null;
  dateStyle: "relative" | "absolute";
  showRemote: boolean;
  root: string;
  onSelect: (row: GraphRow, e: React.MouseEvent) => void;
  onMenu: (row: GraphRow, e: React.MouseEvent) => void;
  onHover: (c: number | null) => void;
  onPin: (c: number) => void;
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
      <div className="grow" style={{ top, height: p.rowH }}>
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
  const incomingBadge = r.incoming && <span className="pill blue incoming-badge" title="Fetched from upstream. Pull to add this commit to the local branch.">Incoming</span>;
  const mid = p.rowH / 2;
  const nodeColor = `var(--lane-${r.color % 12})`;
  const branchMark = (label: RefLabel) => matchesBranch(label, p.branchContext?.reference) ? "selected" :
    matchesBranch(label, p.branchContext?.base) ? "base" : matchesBranch(label, p.branchContext?.primary) ? "primary" : undefined;
  const refs = r.refs.filter(label => {
    if (p.branchContext && (label.kind === "head" || label.kind === "local" || label.kind === "remote")) return !!branchMark(label);
    return p.showRemote || label.kind !== "remote";
  });
  const branchStyle = p.branchMember ? "branch-member" : p.branchContext && !wip ? "branch-background" : "";
  const anim =
    p.animDelay !== null ? { animationDelay: `${p.animDelay}ms` } : undefined;
  const badges = refs.map((l) => (
    <RefBadge
      key={l.kind + l.name}
      r={l}
      branchMark={branchMark(l)}
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
        className={`grow compact ${p.selected ? "selected" : ""} ${p.multi ? "multi" : ""} ${p.match ? "match" : ""} ${p.dim ? "dim" : ""} ${wip ? "wip" : ""} ${branchStyle} ${r.incoming ? "incoming" : ""}`}
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
          {incomingBadge}
          {badges}
          <span className="text">{r.subject}</span>
        </div>
        {!wip && (
          <div className="c-meta">
            {r.author} · {when} ·{" "}
            <span className="mono" title={r.oid}>{shortOid(r.oid)}</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={`grow ${p.selected ? "selected" : ""} ${p.multi ? "multi" : ""} ${p.match ? "match" : ""} ${p.dim ? "dim" : ""} ${wip ? "wip" : ""} ${p.animDelay !== null ? "animate" : ""} ${p.pinnedLaneMember ? "lane-member" : ""} ${branchStyle} ${r.incoming ? "incoming" : ""} ${p.keyboardHighlighted ? "keyboard-highlighted" : ""}`}
      data-commit-index={wip ? undefined : r.index}
      style={{ top, height: p.rowH, ...anim, ["--pinned-lane-color" as string]: p.pinnedLaneMember ? nodeColor : undefined }}
      onMouseDown={(e) => e.button === 0 && p.onSelect(r, e)}
      onContextMenu={(e) => p.onMenu(r, e)}
      onDoubleClick={() => !wip && copyText(r.oid, "Hash copied")}
    >
      <div
        className="g-graph"
        onMouseEnter={() => p.onHover(r.laneId)}
        onMouseLeave={() => p.onHover(null)}
        onMouseDown={(e) => { if (e.button === 0) e.stopPropagation(); }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <svg width={p.width} height={p.rowH}>
          {r.segs.map((s, i) => {
            if (s.a >= p.lanes || s.b >= p.lanes) return null;
            const { d, len } = segPath(s, p.rowH);
            const dashed = wip && s.t === 2;
            return (
              <Fragment key={i}>
                <path
                  d={d}
                  stroke={`var(--lane-${s.c % 12})`}
                  strokeDasharray={dashed ? "3 3" : undefined}
                  className={`lane-line ${p.hl === s.id ? "hl" : ""}`}
                  style={{
                    ["--len" as string]: Math.ceil(len),
                    animationDelay: p.animDelay !== null ? `${p.animDelay}ms` : undefined,
                  }}
                />
                <path className="lane-hit" data-lane={s.id} d={d} aria-hidden="true"
                  onMouseEnter={() => p.onHover(s.id)} onMouseLeave={() => p.onHover(null)}
                  onClick={() => p.onPin(s.id)}>
                  <title>Click to pin or clear this line</title>
                </path>
              </Fragment>
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
                  className={`node ${p.hl === r.laneId ? "hl" : ""}`}
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
                className={`node ${p.hl === r.laneId ? "hl" : ""}`}
                cx={x(r.col)}
                cy={mid}
                r={3.6}
                fill={nodeColor}
                stroke="var(--bg)"
                strokeWidth={1.5}
              />
            ) : r.localOnly ? (
              <circle
                className={`node ${p.hl === r.laneId ? "hl" : ""}`}
                cx={x(r.col)}
                cy={mid}
                r={4.3}
                fill="var(--bg)"
                stroke={nodeColor}
                strokeWidth={2.2}
              />
            ) : (
              <circle
                className={`node ${p.hl === r.laneId ? "hl" : ""}`}
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
        {incomingBadge}
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
        <div className="g-hash">{!wip && <span title={r.oid}>{shortOid(r.oid)}</span>}</div>
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
  const fontSize = useSettings(s => s.uiFontSize);
  const rowH = (compact ? COMPACT_ROW_H : ROW_H) + Math.ceil(Math.max(0, fontSize - 13) * (compact ? 3 : 1.5));
  const root = tab.root;
  const primaryBranch = useSettings(settings => settings.primaryBranchByRepo[repositoryKey(root)]);
  const primaryInfo = [...(tab.refs?.local ?? []), ...(tab.refs?.remote ?? [])].find(branch => branch.fullName === primaryBranch);
  const fixedBranch = tab.branchFilter && tab.branchFilter !== CURRENT_HISTORY_BRANCH ? tab.branchFilter : null;
  const status = tab.status ?? tab.sidebarStatus;
  const localScope = tab.branchFilter === CURRENT_HISTORY_BRANCH ? !!tab.info?.head.branch : !!fixedBranch?.startsWith("refs/heads/");
  const showIncoming = useSettings(s => !s.hideIncomingByRepo[root]);
  const incoming = tab.branchFilter === CURRENT_HISTORY_BRANCH && status?.branch === tab.info?.head.branch
    ? status?.behind ?? 0
    : tab.refs?.local.find(branch => branch.fullName === fixedBranch)?.behind ?? 0;
  const selectHistoryScope = (branchFilter: string | null) => {
    patch(root, { branchFilter, branchContext: null, viewedBranch: null, selected: null, multi: [], historyJump: null });
    setPin(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    void loadGraph(root);
  };
  const summary = tab.graph;
  const branchContext = tab.branchContext && summary?.branchContext?.reference === tab.branchContext ? summary.branchContext : null;
  const graphKey = summary?.key;
  const viewedBranch = tab.branchContext ? branchContext?.reference : tab.viewedBranch;
  const [branchMembers, setBranchMembers] = useState<{ key: string; reference: string; rows: Set<number> } | null>(null);
  useEffect(() => {
    if (!graphKey || !viewedBranch) return;
    let current = true;
    void api.graphBranchMembers(root, graphKey, viewedBranch).then(rows => {
      if (current) setBranchMembers({ key: graphKey, reference: viewedBranch, rows: new Set(rows) });
    }).catch(() => {});
    return () => { current = false; };
  }, [root, graphKey, viewedBranch]);
  const highlightedRows = branchMembers && branchMembers.key === graphKey && branchMembers.reference === viewedBranch ? branchMembers.rows : undefined;
  const patch = useRepos((s) => s.patch);
  const toggleIncoming = () => {
    const settings = useSettings.getState();
    const hidden = { ...settings.hideIncomingByRepo };
    if (showIncoming) hidden[root] = true;
    else delete hidden[root];
    settings.set({ hideIncomingByRepo: hidden });
    patch(root, { selected: null, multi: [], historyJump: null });
    setPin(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    void loadGraph(root);
  };
  const dateStyle = useSettings((s) => s.dateStyle);
  const showRemote = useSettings((s) => s.showRemoteBranchesInGraph);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hoveredCommit = useRef<{ index: number; version: number; x: number; y: number } | null>(null);
  const [keyboardCommit, setKeyboardCommit] = useState<{ index: number; version: number } | null>(null);
  const keyboardIndex = !compact && keyboardCommit?.version === tab.graphVersion ? keyboardCommit.index : null;
  const [restoredRows]=useState(()=>cachedGraphRows(root,tab.graphVersion));
  const cache = useRef(restoredRows?.rows??new Map<number, GraphRow>());
  const cacheKey = useRef(restoredRows ? summary?.key : undefined);
  const loadingPages = useRef(new Set<number>());
  const [, force] = useState(0);
  const [scrollTop, setScrollTop] = useState(restoredRows?.top??0);
  useLayoutEffect(()=>{if(scrollRef.current&&restoredRows)scrollRef.current.scrollTop=restoredRows.top;},[]);
  useEffect(()=>{rememberGraphPosition(root,tab.graphVersion,scrollTop);},[root,tab.graphVersion,scrollTop]);
  const [viewH, setViewH] = useState(600);
  const [hoveredLane, setHl] = useState<number | null>(null);
  const [pin, setPin] = useState<LanePin | null>(null);
  const pinned = pin && pin.key === cacheKey.current ? pin.id : null;
  const hl = pinned ?? hoveredLane;
  const pinLane = useCallback((lane: number) => {
    const key = cacheKey.current;
    if (!key) return;
    scrollRef.current?.focus({ preventScroll: true });
    if (pin?.key === key && pin.id === lane) {
      setPin(null);
      return;
    }
    const clicked = { key, id: lane };
    setPin(clicked);
    void api.graphLaneAnchor(root, key, lane).then((anchor) => {
      setPin((current) => current === clicked ? anchor ? { ...clicked, anchor } : null : current);
    }).catch(() => setPin((current) => current === clicked ? null : current));
  }, [root, pin]);
  useEffect(() => {
    const key = summary?.key;
    if (!key || !pin?.anchor || pin.key === key) return;
    let current = true;
    void api.graphResolveLane(root, key, pin.anchor).then((id) => {
      if (!current || useRepos.getState().tabs[root]?.graph?.key !== key) return;
      setPin((latest) => latest === pin ? id == null ? null : { ...pin, key, id } : latest);
    }).catch(() => {}); // A superseded graph will be resolved after its replacement arrives.
    return () => { current = false; };
  }, [root, summary?.key, pin]);
  const [drawing, setDrawing] = useState(false);
  const firstDrawKey = useRef<string | null>(tab.loaded?root:null);
  const anchor = useRef<number | null>(null);

  // search
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("quick");
  const [found, setFound] = useState<{ scope: string; matches: Awaited<ReturnType<typeof api.historySearch>> } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const [filterOnly, setFilterOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelMenu = usePanelTitleMenu("history");
  const searchScope = JSON.stringify([root, graphKey, tab.branchFilter, tab.branchContext, mode, query.trim()]);
  const results = useMemo(() => found?.scope === searchScope ? found.matches : [], [found, searchScope]);
  const matchSet = useMemo(() => new Set(results.map(({ row }) => row.oid)), [results]);
  // An older hit can be opened directly by SHA. Show it in the same history
  // pane without constructing all the intervening graph lanes.
  const filtered = results.length > 0 && (filterOnly || results[cursor]?.graphIndex == null);
  useEffect(() => {
    anchor.current = null;
    hoveredCommit.current = null;
    setKeyboardCommit(null);
  }, [filtered, results]);

  const total = summary?.total ?? 0;
  const commitCount = summary?.commitCount ?? total - Number(tab.graphHasWorktree);

  // Offer git's commit-graph cache for large histories (once per repository).
  const dismissed = useSettings((s) => s.commitGraphDismissed.includes(root));
  const [cgMissing, setCgMissing] = useState(false);
  const [cgBusy, setCgBusy] = useState(false);
  useEffect(() => {
    if (commitCount > 20000 && !dismissed)
      api.commitGraphStatus(root).then(
        (ok) => setCgMissing(!ok),
        () => {},
      );
    else setCgMissing(false);
  }, [root, commitCount > 20000, dismissed]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const columnDrag = useRef<{ pointer: number; start: number; width: number } | null>(null);
  const resizedWidth = (x: number, drag: NonNullable<typeof columnDrag.current>) =>
    Math.max(PAD * 2 + 2 * LANE_W, Math.min(PAD * 2 + MAX_LANES * LANE_W, drag.width + x - drag.start));
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
    columns.hash ? "max(70px, calc(var(--fs-code) * 5.5))" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const hiddenLanes = (summary?.maxLanes ?? 0) > lanes;

  const cacheVersion = useRef(restoredRows?.rows.size?tab.graphVersion:-1);
  const loadPage = useCallback(
    async (page: number, version: number) => {
      const key = version * 1_000_000 + page;
      if (loadingPages.current.has(key)) return;
      loadingPages.current.add(key);
      try {
        const key=useRepos.getState().tabs[root]?.graph?.key;
        const rows = await api.graphRows(root, page * PAGE, PAGE,key);
        if (useRepos.getState().tabs[root]?.graphVersion !== version) return;
        // Keep showing the previous rows until the rebuilt graph delivers its first page.
        if (cacheVersion.current !== version) {
          cache.current = new Map();
          cacheVersion.current = version;
          cacheKey.current = key;
          setHl(null);
        }
        for (const r of rows) cache.current.set(r.index, r);
        rememberGraphRows(root,version,cache.current);
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
    if (graphKey && firstDrawKey.current !== root) {
      firstDrawKey.current = root;
      setDrawing(true);
      const t = setTimeout(() => setDrawing(false), 1100);
      return () => clearTimeout(t);
    }
  }, [tab.graphVersion, graphKey, root]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Rows visible (or filtered list when "show only matches" is on).
  const count = filtered ? results.length : total;
  const first = Math.max(0, Math.floor(scrollTop / rowH) - 8);
  const last = Math.min(count - 1, Math.ceil((scrollTop + viewH) / rowH) + 8);

  useEffect(() => {
    if (!summary || filtered) return;
    const need = new Set<number>();
    const fresh = cacheVersion.current === tab.graphVersion;
    for (let i = first; i <= last; i++) {
      if (!fresh || !cache.current.has(i)) need.add(Math.floor(i / PAGE));
    }
    need.forEach((p) => loadPage(p, tab.graphVersion));
  });

  const rowAt = useCallback((i: number) => filtered ? results[i]?.row : cache.current.get(i), [filtered, results]);

  const moreHistory = hasMoreHistory(tab);
  const expandedFrom = useRef<string | undefined>(undefined);
  // Extend the ordered prefix as the user approaches the end of the loaded rows.
  useEffect(() => {
    if (!moreHistory || tab.graphLoading || filtered || scrollTop <= 0 || last < count - 24 || expandedFrom.current === graphKey) return;
    expandedFrom.current = graphKey;
    void loadGraph(root, undefined, Math.min(summary?.commitCount ?? Infinity, tab.graphLimit + INITIAL_GRAPH_COMMITS));
  }, [moreHistory, last, count, graphKey, filtered, scrollTop, summary?.commitCount, tab.graphLoading, tab.graphLimit, root]);
  const selectedIndex = useMemo(() => {
    if (!tab.selected) return -1;
    if (filtered) return results.findIndex(({ row }) => row.oid === tab.selected);
    for (const [i, r] of cache.current) if (r.oid === tab.selected) return i;
    return -1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.selected, tab.graphVersion, cache.current.size, filtered, results]);

  const scrollToIndex = useCallback(
    (idx: number, center = false) => {
      const el = scrollRef.current;
      if (!el) return false;
      if (idx < 0) return false;
      const y = idx * rowH;
      if (center)
        el.scrollTop = Math.max(0, y - el.clientHeight / 2 + rowH / 2);
      else if (y < el.scrollTop) el.scrollTop = y;
      else if (y + rowH > el.scrollTop + el.clientHeight)
        el.scrollTop = y + rowH - el.clientHeight;
      return true;
    },
    [rowH],
  );

  useEffect(() => {
    const oid = tab.historyJump;
    if (!oid) return;
    // An external selection takes precedence over the local search and its pending scroll.
    if (query || filterOnly) {
      setQuery("");
      setFilterOnly(false);
      return;
    }
    if (!graphKey || tab.graphLoading) return;
    let current = true;
    void api.graphFind(root, oid, graphKey).then((index) => {
      const latest = useRepos.getState().tabs[root];
      if (!current || latest?.graph?.key !== graphKey || latest.historyJump !== oid) return;
      if (index == null && hasMoreHistory(latest)) {
        void loadEntireHistory(root).then(() => {
          const state = useRepos.getState().tabs[root];
          if (state?.graph?.key === graphKey && state.historyJump === oid && !state.graphLoading) patch(root, { historyJump: null });
        });
        return;
      }
      if ((latest.selected === oid || latest.selected === null) && index != null) {
        if (!scrollToIndex(index, true)) return;
        anchor.current = latest.selected === oid ? index : null;
      }
      patch(root, { historyJump: null });
    }).catch(() => {});
    return () => { current = false; };
  }, [root, graphKey, tab.historyJump, tab.graphLoading, tab.branchFilter, query, filterOnly, patch, scrollToIndex]);

  const selectIndex = useCallback(
    async (idx: number) => {
      const current = useRepos.getState().tabs[root];
      if (filtered) {
        const match = results[idx];
        if (match && current?.graph?.key === graphKey) {
          patch(root, { selected: match.row.oid, multi: [] });
          setCursor(idx);
          anchor.current = idx;
          scrollToIndex(idx);
        }
        return;
      }
      if (!current?.graph || idx < 0 || idx >= current.graph.total) return;
      const key = current.graph.key;
      let r = cacheVersion.current === current.graphVersion ? cache.current.get(idx) : undefined;
      if (!r) {
        const rows = await api.graphRows(root, idx, 1, key).catch(() => []);
        r = rows[0];
      }
      if (!r || useRepos.getState().tabs[root]?.graph?.key !== key) return;
      patch(root, { selected: r.oid, multi: [] });
      anchor.current = idx;
      scrollToIndex(idx);
    },
    [root, patch, scrollToIndex, graphKey, filtered, results],
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
          const rr = rowAt(i);
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
    [root, patch, rowAt],
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
      const visibleRows = filtered ? results.map(({ row }) => row) : [...cache.current.values()];
      const sel = visibleRows.filter(row => multi.includes(row.oid));
      contextMenu(e, commitMenu(root, r, sel.length > 1 ? sel : [r]));
    },
    [root, patch, filtered, results],
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
    let jump=0;
    const onJump = (e: Event) => {
      const { root: r, oid } = (e as CustomEvent).detail as {
        root: string;
        oid: string;
      };
      if (r !== root) return;
      const request=++jump;
      patch(root,{selected:oid,multi:[]});
      const local=[...cache.current.values()].find(row=>row.oid===oid);
      if(local){anchor.current=local.index;scrollToIndex(local.index,true);return;}
      api.graphFind(root, oid).then((idx) => {
        const latest = useRepos.getState().tabs[root];
        if(request!==jump||latest?.selected!==oid)return;
        if (idx === null || idx === undefined) {
          if (hasMoreHistory(latest)) {
            patch(root, { historyJump: oid });
            return;
          }
          if (latest.branchFilter || latest.branchContext) {
            patch(root, { branchFilter: null, branchContext: null, viewedBranch: null, historyJump: oid });
            void loadGraph(root);
            return;
          }
          toast.info(
            "Commit is not in the loaded history",
            "It may be filtered out or older than the loaded range.",
          );
          return;
        }
        anchor.current = idx;
        scrollToIndex(idx, true);
      }).catch(()=>{});
    };
    window.addEventListener("revqora:jump", onJump);
    return () => {jump++;window.removeEventListener("revqora:jump", onJump);};
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
          setHl(row.laneId);
          return;
        }
      }
    };
    window.addEventListener("revqora:highlight", onHl);
    return () => window.removeEventListener("revqora:highlight", onHl);
  }, [root]);

  // Search (debounced for quick mode).
  useEffect(() => {
    let current = true;
    if (!query.trim() || !graphKey) {
      setFound(null);
      setCursor(0);
      setSearching(false);
      return;
    }
    const delay =
      mode === "quick" || mode === "hash" || mode === "author" ? 160 : 450;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.historySearch(root, graphKey, query, mode);
        if (!current || useRepos.getState().tabs[root]?.graph?.key !== graphKey) return;
        setFound({ scope: searchScope, matches: res });
        setCursor(0);
      } catch (e) {
        if (current) toast.error(e, "Search failed");
      } finally {
        if (current) setSearching(false);
      }
    }, delay);
    return () => { current = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, root, graphKey, searchScope]);

  useEffect(() => {
    const match = results[cursor];
    if (match) scrollToIndex(filtered ? cursor : match.graphIndex ?? 0, true);
  }, [results, cursor, filtered, scrollToIndex]);

  const gotoResult = (dir: number) => {
    if (!results.length) return;
    const selected = results.findIndex(({ row }) => row.oid === tab.selected);
    const next = selected >= 0 ? (selected + dir + results.length) % results.length
      : dir < 0 ? results.length - 1 : cursor;
    setCursor(next);
    patch(root, { selected: results[next].row.oid, multi: [] });
    anchor.current = null;
  };

  useEffect(() => {
    const view = searchRef.current?.ownerDocument.defaultView;
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        !e.defaultPrevented &&
        matchesShortcut(e, "historyFind") &&
        useRepos.getState().active === root &&
        (view !== window || tab.view === "history") &&
        !view.document.querySelector(".modal")
      ) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    view.addEventListener("keydown", onKey);
    return () => view.removeEventListener("keydown", onKey);
  }, [root, tab.view]);

  const navigateHoveredCommit = (e: KeyboardEvent) => {
    if (compact || tab.selected || e.defaultPrevented || actionFor(e)) return false;
    const el = scrollRef.current;
    if (!el || el.ownerDocument.querySelector(".modal, .ctx-menu")) return false;
    const focused = el.ownerDocument.activeElement;
    if (focused !== el && focused?.closest("input, textarea, select, button, a[href], [contenteditable], [role=combobox]")) return false;

    if (e.key === "Escape" && keyboardIndex !== null) {
      setKeyboardCommit(null);
    } else if (matchesShortcut(e, "historyOpenCommit") && keyboardIndex !== null && rowAt(keyboardIndex)) {
      void selectIndex(keyboardIndex);
      setKeyboardCommit(null);
    } else {
      const nextCommit = matchesShortcut(e, "historyNextCommit");
      if (!nextCommit && !matchesShortcut(e, "historyPreviousCommit")) return false;
      const hover = hoveredCommit.current;
      const current = keyboardIndex ?? (hover?.version === tab.graphVersion ? hover.index : null);
      if (current === null) return false;
      const firstCommit = !filtered && tab.graphHasWorktree ? 1 : 0;
      if (current < firstCommit || current >= count) return false;
      const index = Math.max(firstCommit, Math.min(count - 1, current + (nextCommit ? 1 : -1)));
      setKeyboardCommit({ index, version: tab.graphVersion });
      el.focus({ preventScroll: true });
      scrollToIndex(index);
    }
    e.preventDefault();
    return true;
  };

  const navigateUnfocusedGraph = useEffectEvent((e: KeyboardEvent) => {
    if (hoveredCommit.current && e.target !== scrollRef.current) navigateHoveredCommit(e);
  });
  useEffect(() => {
    if (compact) return;
    const view = scrollRef.current?.ownerDocument.defaultView;
    const listener = (e: KeyboardEvent) => navigateUnfocusedGraph(e);
    view?.addEventListener("keydown", listener);
    return () => view?.removeEventListener("keydown", listener);
  }, [compact]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || actionFor(e)) return;
    if (navigateHoveredCommit(e.nativeEvent)) return;
    if (tab.selected && tab.selected !== WORKTREE && (e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key))) {
      const visibleRows = filtered ? results.map(({ row }) => row) : [...cache.current.values()];
      const row = visibleRows.find(candidate => candidate.oid === tab.selected);
      if (row) {
        const multi = tab.multi.includes(row.oid) ? tab.multi : [];
        const selected = visibleRows.filter(candidate => multi.includes(candidate.oid));
        if (selected.length !== multi.length) return;
        if (runMenuShortcut(e, commitMenu(root, row, selected.length > 1 ? selected : [row]), "commit-")) return;
      }
    }
    const cur =
      selectedIndex >= 0 ? selectedIndex : tab.selected === WORKTREE ? 0 : -1;
    const pageRows = Math.max(1, Math.floor(viewH / rowH) - 1);
    if (e.key === "Escape" && pin) {
      e.preventDefault();
      setPin(null);
    } else if (e.key === "Escape" && tab.selected) {
      e.preventDefault();
      useRepos.getState().patch(tab.root, { selected: null, multi: [] });
    } else if (matchesShortcut(e, "historyNextCommit")) {
      e.preventDefault();
      selectIndex(Math.min(count - 1, cur + 1));
    } else if (matchesShortcut(e, "historyPreviousCommit")) {
      e.preventDefault();
      selectIndex(Math.max(0, cur - 1));
    } else if (matchesShortcut(e, "historyNextPage")) {
      e.preventDefault();
      selectIndex(Math.min(count - 1, cur + pageRows));
    } else if (matchesShortcut(e, "historyPreviousPage")) {
      e.preventDefault();
      selectIndex(Math.max(0, cur - pageRows));
    } else if (matchesShortcut(e, "historyFirstCommit")) {
      e.preventDefault();
      selectIndex(0);
    } else if (matchesShortcut(e, "historyLastCommit")) {
      e.preventDefault();
      if (filtered) { void selectIndex(count - 1); return; }
      void loadEntireHistory(root).then(() => {
        const latest = useRepos.getState().tabs[root];
        if (latest && latest.branchFilter === tab.branchFilter && latest.branchContext === tab.branchContext && latest.selected === tab.selected && latest.graph) {
          void selectIndex(latest.graph.total - 1);
        }
      });
    } else if (matchesShortcut(e, "historyOpenCommit") && tab.selected === WORKTREE) {
      onEnterChanges();
    } else if (
      matchesShortcut(e, "historyCopyHash") &&
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
      const idx = i;
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
          keyboardHighlighted={idx === keyboardIndex}
          multi={!!r && multiSet.has(r.oid)}
          match={!!r && matchSet.has(r.oid)}
          dim={
            !filtered &&
            results.length > 0 &&
            query.trim() !== "" &&
            !!r && !matchSet.has(r.oid) &&
            r?.oid !== WORKTREE
          }
          hl={filtered ? null : hl}
          pinnedLaneMember={!filtered && !!r && r.oid !== WORKTREE && r.laneId === pinned}
          branchMember={!filtered && (highlightedRows?.has(idx) ?? false)}
          branchContext={filtered ? undefined : branchContext}
          animDelay={drawing ? Math.max(0, i - first) * 16 : null}
          dateStyle={dateStyle}
          showRemote={showRemote}
          root={root}
          onSelect={onSelect}
          onMenu={onMenu}
          onHover={filtered ? () => {} : setHl}
          onPin={filtered ? () => {} : pinLane}
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
        className="hstack graph-toolbar"
        onContextMenu={panelMenu}
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
            placeholder={shortcutTitle("Search commits", "historyFind")}
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
        <button type="button" className="btn sm" onClick={() => void workspaceCommitSearch(query, mode)}>
          <FolderSearch size={14} /> Search all repositories
        </button>
        {pin && <button type="button" className="btn sm" onClick={() => setPin(null)}>Clear line highlight</button>}
        <div className="graph-branch-filter" data-branch-filter={fixedBranch ?? undefined}>
          <select className="select" aria-label="History scope" title="Choose which branch history to show"
            value={tab.branchContext ? BRANCH_CONTEXT_SCOPE : tab.branchFilter ?? ""} onChange={event => {
              if (event.target.value !== BRANCH_CONTEXT_SCOPE) selectHistoryScope(event.target.value || null);
            }}>
            {tab.branchContext && <option value={BRANCH_CONTEXT_SCOPE}>Branch context — {branchName(tab.branchContext)}</option>}
            <option value={CURRENT_HISTORY_BRANCH}>{tab.info?.head.branch ? `Current branch — ${tab.info.head.branch}` : "Current commit (HEAD)"}</option>
            <option value="">All branches (local and fetched)</option>
            {fixedBranch && ![...(tab.refs?.local ?? []), ...(tab.refs?.remote ?? [])].some(branch => branch.fullName === fixedBranch) && <option value={fixedBranch}>{fixedBranch}</option>}
            {!!tab.refs?.local.length && <optgroup label="Local branches">{tab.refs.local.map(branch => <option key={branch.fullName} value={branch.fullName}>{branch.name}</option>)}</optgroup>}
            {!!tab.refs?.remote.length && <optgroup label="Remote branches">{tab.refs.remote.map(branch => <option key={branch.fullName} value={branch.fullName}>{branch.name}</option>)}</optgroup>}
          </select>
          {(fixedBranch || tab.branchContext) && <button type="button" className="icon-btn sm" aria-label="Clear branch filter" title="Return to current branch"
            onClick={() => selectHistoryScope(CURRENT_HISTORY_BRANCH)}><X size={12} /></button>}
        </div>
        {branchContext?.base && <span className="pill branch-context-base" title={branchContext.recorded ? "Branch creation recorded by Git" : "Base used for comparison"}>
          {branchContext.recorded ? "From" : "Compared with"} {branchName(branchContext.base)}
        </span>}
        {primaryBranch && <span className="pill branch-primary-mark" title={primaryInfo ? `Primary branch · ${primaryInfo.name}` : `Primary branch · ${branchName(primaryBranch)} (ref unavailable)`}>
          Primary · {branchName(primaryBranch)}{primaryInfo && <BranchAheadBehind branch={primaryInfo}/>}
        </span>}
        {localScope && <button type="button" className={`icon-btn sm ${showIncoming ? "active" : ""}`} aria-label="Show incoming commits"
          aria-pressed={showIncoming} title={showIncoming ? "Hide incoming commits" : "Show incoming commits"} onClick={toggleIncoming}>
          {showIncoming ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>}
        {incoming > 0 && <span className="pill" title="Fetched commits waiting for Pull">{incoming.toLocaleString()} incoming · Pull to apply</span>}
        <div className="spacer" />
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          {total
            ? `${commitCount.toLocaleString()}${summary?.commitCount == null && moreHistory ? "+" : ""} commits`
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
            This history has {commitCount.toLocaleString()} commits. Writing git's{" "}
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
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                columnDrag.current = { pointer: e.pointerId, start: e.clientX, width: graphW };
              }}
              onPointerMove={e => {
                const drag = columnDrag.current;
                if (drag?.pointer === e.pointerId) setDragW(resizedWidth(e.clientX, drag));
              }}
              onPointerUp={e => {
                const drag = columnDrag.current;
                if (drag?.pointer !== e.pointerId) return;
                columnDrag.current = null;
                if (e.clientX !== drag.start) useSettings.getState().set({ graphWidth: resizedWidth(e.clientX, drag) });
                setDragW(null);
              }}
              onLostPointerCapture={() => {
                columnDrag.current = null;
                setDragW(null);
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
        className={`graph-scroll ${drawing ? "drawing" : ""} ${keyboardIndex !== null ? "keyboard-navigation" : ""}`}
        tabIndex={0}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        onKeyDown={onKeyDown}
        onPointerMove={e => {
          if (compact) return;
          const previous = hoveredCommit.current;
          if (previous?.x === e.clientX && previous.y === e.clientY) return;
          const row = (e.target as Element).closest<HTMLElement>("[data-commit-index]");
          hoveredCommit.current = row ? { index: Number(row.dataset.commitIndex), version: tab.graphVersion, x: e.clientX, y: e.clientY } : null;
          if (keyboardIndex !== null) setKeyboardCommit(null);
        }}
        onPointerLeave={() => { hoveredCommit.current = null; }}
        onPointerDown={() => { hoveredCommit.current = null; setKeyboardCommit(null); }}
        onBlur={() => setKeyboardCommit(null)}
        data-hl={hl !== null ? hl : undefined}
        data-pinned-lane={pinned ?? undefined}
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
