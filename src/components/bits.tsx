import { useEffect, useRef, useState } from "react";
import { useSettings } from "../lib/settings";
import { Bug, Check, ChevronDown, ChevronRight, Cloud, Folder, GitBranch, Tag, CircleDot } from "lucide-react";
import type { BranchInfo, RefLabel } from "../lib/types";
import { avatarHue, basename, dirname, initials } from "../lib/format";

const avatarUrls = new Map<string, Promise<string | null>>();
const failedAvatars = new Set<string>();

/** GitHub noreply addresses map to the account picture, others to Gravatar (sha256 of the email). */
function avatarUrl(email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return Promise.resolve(null);
  let p = avatarUrls.get(e);
  if (!p) {
    const gh = e.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
    p = gh
      ? Promise.resolve(`https://github.com/${gh[1]}.png?size=64`)
      : crypto.subtle
          .digest("SHA-256", new TextEncoder().encode(e))
          .then((buf) => `https://www.gravatar.com/avatar/${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")}?s=64&d=404`)
          .catch(() => null);
    avatarUrls.set(e, p);
  }
  return p;
}

export function Avatar({ name, email, large }: { name: string; email?: string; large?: boolean }) {
  const hue = avatarHue(email || name);
  const enabled = useSettings((s) => s.avatars);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (enabled && email && !failedAvatars.has(email)) avatarUrl(email).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [enabled, email]);
  return (
    <span
      className={`avatar ${large ? "lg" : ""}`}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${(hue + 40) % 360} 62% 42%))`, overflow: "hidden", position: "relative" }}
      title={email ? `${name} <${email}>` : name}
    >
      {initials(name)}
      {url && (
        <img
          src={url}
          alt=""
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
          onError={() => {
            if (email) failedAvatars.add(email);
            setUrl(null);
          }}
        />
      )}
    </span>
  );
}

export function RefBadge({ r, color, merged, onClick, onContextMenu }: { r: RefLabel; color?: number; merged?: string; onClick?: (e: React.MouseEvent) => void; onContextMenu?: (e: React.MouseEvent) => void }) {
  const style = color !== undefined ? ({ "--lane-c": `var(--lane-${color % 12})` } as React.CSSProperties) : undefined;
  const icon =
    r.kind === "tag" ? <Tag size={12} /> : r.kind === "remote" ? <Cloud size={12} /> : r.kind === "detached" ? <CircleDot size={12} /> : r.kind === "bisect" ? <Bug size={12} /> : <GitBranch size={12} />;
  return (
    <span
      className={`ref ${r.kind} ${r.kind === "bisect" ? (r.name.endsWith("bad") ? "bad" : "good") : ""}${merged ? " squashed" : ""}`}
      data-ref-kind={r.kind}
      data-ref-name={r.name}
      style={style}
      title={
        merged
          ? `${r.name} — its changes are already in ${merged} (squash or rebase merge), so no merge line connects it`
          : `${r.syncedRemote ? `${r.name} — in sync with ${r.syncedRemote}` : r.name}${r.kind === "local" || r.kind === "remote" ? "\nRight-click to check out" : ""}`
      }
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      onContextMenu={onContextMenu}
    >
      {icon}
      <span className="rn">{r.name}</span>
      {r.syncedRemote && <Cloud size={12} style={{ opacity: 0.8 }} />}
      {merged && <Check size={12} strokeWidth={3} />}
    </span>
  );
}

export function StatusIcon({ code }: { code: string }) {
  const c = code === "?" ? "A" : code;
  return (
    <span className={`st st-${c}`} title={code}>
      {c}
    </span>
  );
}

export function PathLabel({ path, hideDir }: { path: string; hideDir?: boolean }) {
  const dir = hideDir ? "" : dirname(path);
  return (
    <>
      <span className="fname">{basename(path)}</span>
      {dir && <span className="fdir">{"‎" + dir}</span>}
    </>
  );
}

export function AheadBehind({ ahead, behind, aheadHint }: { ahead: number; behind: number; aheadHint?: string }) {
  if (!ahead && !behind) return null;
  return (
    <span className="hstack" style={{ gap: 5 }}>
      {ahead > 0 && <span className="ab up" title={aheadHint}>↑{ahead}</span>}
      {behind > 0 && <span className="ab down">↓{behind}</span>}
    </span>
  );
}

export function BranchAheadBehind({ branch }: { branch: BranchInfo }) {
  return <AheadBehind ahead={branch.unpublished ?? branch.ahead} behind={branch.behind}
    aheadHint={branch.unpublished ? "Commits absent from fetched remote branches · publish this branch to push them" : undefined}/>;
}

/**
 * Renders file rows either flat or grouped under their folder (collapsible headers).
 * `render` gets the item and whether it is shown inside a folder group.
 */
export function FileGroups<T extends { path: string }>({
  items,
  tree,
  expandAll = false,
  render,
  idPrefix,
  onFolderMenu,
}: {
  items: T[];
  tree: boolean;
  expandAll?: boolean;
  render: (item: T, grouped: boolean) => React.ReactNode;
  idPrefix: string;
  /** Context menu for a folder row ("." = the repository root). */
  onFolderMenu?: (e: React.MouseEvent, folder: string) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // Huge lists (tens of thousands of untracked files) render in steps as they scroll into view.
  // A long list paints its first rows at once and the rest of the first step one frame later,
  // so a large commit's files appear sooner.
  const [limit, setLimit] = useState(FIRST_PAINT);
  const filling = limit < FILE_STEP && items.length > limit;
  useEffect(() => {
    if (!filling) return;
    const frame = requestAnimationFrame(() => setLimit((n) => Math.max(n, FILE_STEP)));
    return () => cancelAnimationFrame(frame);
  }, [filling]);
  const more = items.length > limit && !filling ? <MoreFiles shown={limit} total={items.length} onMore={(all) => setLimit((n) => all ? items.length : n + FILE_STEP)} /> : null;
  if (!tree) return <>{items.slice(0, limit).map((it) => render(it, false))}{more}</>;
  let budget = limit;
  /** The files of an open folder that still fit in the rendered budget. */
  const take = (files: T[]) => { const shown = files.slice(0, budget); budget -= shown.length; return shown; };
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const d = dirname(it.path) || ".";
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(it);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)));
  return (
    <>
      {dirs.map((d) => {
        const isClosed = !expandAll && closed.has(d);
        return (
          <div key={`${idPrefix}:${d}`}>
            <div
              className="file-row folder-row"
              onContextMenu={onFolderMenu ? (e) => onFolderMenu(e, d === "." ? "" : d) : undefined}
              onClick={() => { if (!expandAll) setClosed((c) => (c.has(d) ? new Set([...c].filter((x) => x !== d)) : new Set([...c, d]))); }}
            >
              {isClosed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <Folder size={13} style={{ color: "var(--text-faint)", flex: "none" }} />
              <span className="ellipsis" style={{ color: "var(--text-dim)", fontWeight: 600 }}>
                {d === "." ? "(root)" : d}
              </span>
              <span className="pill" style={{ marginLeft: "auto" }}>
                {groups.get(d)!.length}
              </span>
            </div>
            {!isClosed && budget > 0 && <div className="folder-children">{take(groups.get(d)!).map((it) => render(it, true))}</div>}
          </div>
        );
      })}
      {more}
    </>
  );
}

const FILE_STEP = 600;
/** Rows of a long file list painted before the rest of the first step. */
const FIRST_PAINT = 150;

/** The end of a partly rendered file list: loads the next rows when it scrolls into view. */
function MoreFiles({ shown, total, onMore }: { shown: number; total: number; onMore: (all: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onMore);
  latest.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) latest.current(false); }, { rootMargin: "400px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);
  return (
    <div ref={ref} className="file-row more-files" role="status">
      <span className="muted">{shown.toLocaleString()} of {total.toLocaleString()} files shown</span>
      <button type="button" className="btn sm" onClick={() => onMore(true)}>Show all</button>
    </div>
  );
}
