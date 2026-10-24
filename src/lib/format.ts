export function shortOid(oid: string | null | undefined, n = 8): string {
  return oid ? oid.slice(0, n) : "";
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;

export function relativeTime(unix: number, now = Date.now() / 1000): string {
  if (!unix) return "";
  const diff = unix - now;
  const abs = Math.abs(diff);
  const table: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [86400 * 7, "day"],
    [86400 * 30, "week"],
    [86400 * 365, "month"],
    [Infinity, "year"],
  ];
  const sizes: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 86400 * 7, month: 86400 * 30, year: 86400 * 365 };
  for (const [limit, unit] of table) {
    if (abs < limit) {
      if (unit === "second") return abs < 45 ? "just now" : rtf ? rtf.format(Math.round(diff / 60), "minute") : "1 min ago";
      const v = Math.round(diff / sizes[unit]);
      return rtf ? rtf.format(v, unit) : `${Math.abs(v)} ${unit}s ago`;
    }
  }
  return "";
}

export function absoluteTime(unix: number): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fullTime(unix: number): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" });
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable pleasant color for an author avatar. */
export function avatarHue(key: string): number {
  return hashString(key.toLowerCase()) % 360;
}

export function basename(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

export function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.replace(/\//g, sep);
}

export function plural(n: number, word: string, pluralWord = word + "s"): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function statusLabel(code: string): string {
  switch (code) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "T":
      return "Type changed";
    case "?":
      return "Untracked";
    case "U":
      return "Conflict";
    default:
      return code;
  }
}

export function conflictLabel(code: string | null): string {
  switch (code) {
    case "UU":
      return "Both modified";
    case "AA":
      return "Both added";
    case "DU":
      return "Deleted by us";
    case "UD":
      return "Deleted by them";
    case "AU":
      return "Added by us";
    case "UA":
      return "Added by them";
    case "DD":
      return "Both deleted";
    default:
      return "Conflict";
  }
}
