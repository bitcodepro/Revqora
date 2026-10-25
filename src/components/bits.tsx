import { useEffect, useState } from "react";
import { useSettings } from "../lib/settings";
import { Bug, Check, ChevronDown, ChevronRight, Cloud, Folder, GitBranch, Tag, CircleDot } from "lucide-react";
import type { RefLabel } from "../lib/types";
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
      style={style}
      title={
        merged
          ? `${r.name} — its changes are already in ${merged} (squash or rebase merge), so no merge line connects it`
          : `${r.syncedRemote ? `${r.name} — in sync with ${r.syncedRemote}` : r.name}${r.kind === "local" || r.kind === "remote" ? "\nCtrl+click to check out" : ""}`
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

export function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  if (!ahead && !behind) return null;
  return (
    <span className="hstack" style={{ gap: 5 }}>
      {ahead > 0 && <span className="ab up">↑{ahead}</span>}
      {behind > 0 && <span className="ab down">↓{behind}</span>}
    </span>
  );
}

/**
 * Renders file rows either flat or grouped under their folder (collapsible headers).
 * `render` gets the item and whether it is shown inside a folder group.
 */
export function FileGroups<T extends { path: string }>({
  items,
  tree,
  render,
  idPrefix,
}: {
  items: T[];
  tree: boolean;
  render: (item: T, grouped: boolean) => React.ReactNode;
  idPrefix: string;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!tree) return <>{items.map((it) => render(it, false))}</>;
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
        const isClosed = closed.has(d);
        return (
          <div key={`${idPrefix}:${d}`}>
            <div
              className="file-row folder-row"
              onClick={() => setClosed((c) => (c.has(d) ? new Set([...c].filter((x) => x !== d)) : new Set([...c, d])))}
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
            {!isClosed && <div className="folder-children">{groups.get(d)!.map((it) => render(it, true))}</div>}
          </div>
        );
      })}
    </>
  );
}
