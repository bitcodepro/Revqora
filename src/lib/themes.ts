// Theme model: the colour tokens, the built-in palettes, custom themes, the theme file
// format and contrast maths. Pure logic, no DOM: `themeApply.ts` puts a theme on a page.

export type ColorScheme = "dark" | "light";
export type BuiltinThemeId = "light" | "dark" | "hc-light" | "hc-dark";
export type ThemePref = "system" | BuiltinThemeId | `custom:${string}`;

export interface BuiltinTheme { id: BuiltinThemeId; label: string; scheme: ColorScheme; contrast: boolean }

/** Picker order, after "System". */
export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  { id: "light", label: "Light", scheme: "light", contrast: false },
  { id: "dark", label: "Dark", scheme: "dark", contrast: false },
  { id: "hc-light", label: "High contrast light", scheme: "light", contrast: true },
  { id: "hc-dark", label: "High contrast dark", scheme: "dark", contrast: true },
];
const builtinById = new Map(BUILTIN_THEMES.map(theme => [theme.id, theme]));

export function isBuiltinThemeId(value: unknown): value is BuiltinThemeId {
  return typeof value === "string" && builtinById.has(value as BuiltinThemeId);
}

export type ThemeGroupId = "surfaces" | "text" | "accents" | "diff" | "graph";
export const THEME_GROUPS: readonly { id: ThemeGroupId; label: string }[] = [
  { id: "surfaces", label: "Surfaces" },
  { id: "text", label: "Text" },
  { id: "accents", label: "Accents and status" },
  { id: "diff", label: "Diff and code" },
  { id: "graph", label: "Graph" },
];

const token = <N extends string>(name: N, label: string, group: ThemeGroupId) => ({ name, label, group });

/** Every colour token of `styles/theme.css`, in the order the editor shows them. */
export const THEME_TOKENS = [
  token("--bg", "Window background", "surfaces"),
  token("--bg-elev", "Panel background", "surfaces"),
  token("--bg-elev2", "Raised panel background", "surfaces"),
  token("--bg-elev3", "Highest raised background", "surfaces"),
  token("--bg-input", "Input background", "surfaces"),
  token("--bg-hover", "Hover background", "surfaces"),
  token("--bg-hover-strong", "Strong hover background", "surfaces"),
  token("--bg-explorer-current", "Current repository row", "surfaces"),
  token("--bg-selected", "Selected row", "surfaces"),
  token("--bg-selected-strong", "Selected row, focused", "surfaces"),
  token("--border", "Border", "surfaces"),
  token("--border-soft", "Subtle border", "surfaces"),
  token("--border-strong", "Strong border", "surfaces"),
  token("--scroll-thumb", "Scrollbar", "surfaces"),
  token("--scroll-thumb-hover", "Scrollbar, hovered", "surfaces"),
  token("--skeleton", "Loading placeholder", "surfaces"),

  token("--text", "Text", "text"),
  token("--text-dim", "Secondary text", "text"),
  token("--text-faint", "Faint text", "text"),
  token("--word-selection-bg", "Selected word background", "text"),
  token("--word-selection-text", "Selected word text", "text"),

  token("--accent", "Accent", "accents"),
  token("--accent-strong", "Strong accent", "accents"),
  token("--accent-soft", "Accent tint", "accents"),
  token("--accent-fg", "Text on accent", "accents"),
  token("--accent-fill", "Accent fill", "accents"),
  token("--accent-fill-strong", "Strong accent fill", "accents"),
  token("--focus", "Focus ring", "accents"),
  token("--green", "Green (success, added)", "accents"),
  token("--green-soft", "Green tint", "accents"),
  token("--red", "Red (error, deleted)", "accents"),
  token("--red-soft", "Red tint", "accents"),
  token("--amber", "Amber (warning)", "accents"),
  token("--amber-soft", "Amber tint", "accents"),
  token("--blue", "Blue (information)", "accents"),
  token("--blue-soft", "Blue tint", "accents"),
  token("--cyan", "Cyan", "accents"),
  token("--pink", "Pink", "accents"),

  token("--diff-add", "Added line", "diff"),
  token("--diff-add-gutter", "Added line gutter", "diff"),
  token("--diff-add-word", "Added word", "diff"),
  token("--diff-del", "Deleted line", "diff"),
  token("--diff-del-gutter", "Deleted line gutter", "diff"),
  token("--diff-del-word", "Deleted word", "diff"),
  token("--diff-hunk", "Hunk header", "diff"),
  token("--diff-sel", "Selected diff lines", "diff"),
  token("--conflict-ours", "Conflict: ours", "diff"),
  token("--conflict-ours-strong", "Conflict: ours, header", "diff"),
  token("--conflict-theirs", "Conflict: theirs", "diff"),
  token("--conflict-theirs-strong", "Conflict: theirs, header", "diff"),
  token("--conflict-base", "Conflict: base", "diff"),
  token("--tok-keyword", "Syntax: keyword", "diff"),
  token("--tok-string", "Syntax: string", "diff"),
  token("--tok-number", "Syntax: number", "diff"),
  token("--tok-comment", "Syntax: comment", "diff"),
  token("--tok-function", "Syntax: function", "diff"),
  token("--tok-type", "Syntax: type", "diff"),
  token("--tok-property", "Syntax: property", "diff"),
  token("--tok-operator", "Syntax: operator", "diff"),
  token("--tok-tag", "Syntax: tag", "diff"),
  token("--tok-attr", "Syntax: attribute", "diff"),
  token("--tok-meta", "Syntax: meta", "diff"),

  token("--lane-0", "Graph lane 1", "graph"),
  token("--lane-1", "Graph lane 2", "graph"),
  token("--lane-2", "Graph lane 3", "graph"),
  token("--lane-3", "Graph lane 4", "graph"),
  token("--lane-4", "Graph lane 5", "graph"),
  token("--lane-5", "Graph lane 6", "graph"),
  token("--lane-6", "Graph lane 7", "graph"),
  token("--lane-7", "Graph lane 8", "graph"),
  token("--lane-8", "Graph lane 9", "graph"),
  token("--lane-9", "Graph lane 10", "graph"),
  token("--lane-10", "Graph lane 11", "graph"),
  token("--lane-11", "Graph lane 12", "graph"),
] as const;

export type ThemeTokenName = (typeof THEME_TOKENS)[number]["name"];
export type ThemePalette = Record<ThemeTokenName, string>;
export type ThemeColors = Partial<ThemePalette>;

const tokenNames = new Set<string>(THEME_TOKENS.map(item => item.name));
export function isThemeToken(name: string): name is ThemeTokenName { return tokenNames.has(name); }

/**
 * The built-in palettes. `styles/theme.css` defines the same values for the page;
 * `themes.test.ts` parses that file and fails when the two differ.
 */
export const BUILTIN_PALETTES: Record<BuiltinThemeId, ThemePalette> = {
  dark: {
    "--bg": "#0d0f15", "--bg-elev": "#12151d", "--bg-elev2": "#181c26", "--bg-elev3": "#1f2430", "--bg-input": "#0f1219",
    "--bg-hover": "rgba(255, 255, 255, 0.045)", "--bg-hover-strong": "rgba(255, 255, 255, 0.08)",
    "--bg-explorer-current": "#414551", "--bg-selected": "rgba(124, 108, 255, 0.17)", "--bg-selected-strong": "rgba(124, 108, 255, 0.28)",
    "--border": "#222734", "--border-soft": "#1b1f2a", "--border-strong": "#303747",
    "--scroll-thumb": "rgba(255, 255, 255, 0.12)", "--scroll-thumb-hover": "rgba(255, 255, 255, 0.22)", "--skeleton": "rgba(255, 255, 255, 0.05)",
    "--text": "#eef0f6", "--text-dim": "#bcc2d0", "--text-faint": "#8a91a5",
    "--word-selection-bg": "#315d9a", "--word-selection-text": "#fff",
    "--accent": "#8b7cff", "--accent-strong": "#7461ff", "--accent-soft": "rgba(139, 124, 255, 0.16)", "--accent-fg": "#ffffff",
    "--accent-fill": "#6a58f0", "--accent-fill-strong": "#5f4bea", "--focus": "#8b7cff",
    "--green": "#3fb950", "--green-soft": "rgba(63, 185, 80, 0.15)", "--red": "#f8554b", "--red-soft": "rgba(248, 85, 75, 0.14)",
    "--amber": "#e5b44a", "--amber-soft": "rgba(229, 180, 74, 0.14)", "--blue": "#5aa8ff", "--blue-soft": "rgba(90, 168, 255, 0.15)",
    "--cyan": "#37c8d4", "--pink": "#f17ac6",
    "--diff-add": "rgba(46, 160, 67, 0.13)", "--diff-add-gutter": "rgba(46, 160, 67, 0.22)", "--diff-add-word": "rgba(46, 160, 67, 0.42)",
    "--diff-del": "rgba(248, 81, 73, 0.12)", "--diff-del-gutter": "rgba(248, 81, 73, 0.2)", "--diff-del-word": "rgba(248, 81, 73, 0.4)",
    "--diff-hunk": "rgba(90, 168, 255, 0.08)", "--diff-sel": "rgba(139, 124, 255, 0.3)",
    "--conflict-ours": "rgba(90, 168, 255, 0.13)", "--conflict-ours-strong": "rgba(90, 168, 255, 0.35)",
    "--conflict-theirs": "rgba(241, 122, 198, 0.12)", "--conflict-theirs-strong": "rgba(241, 122, 198, 0.33)", "--conflict-base": "rgba(229, 180, 74, 0.1)",
    "--tok-keyword": "#c49bff", "--tok-string": "#9fd88a", "--tok-number": "#f4b06a", "--tok-comment": "#6c7489", "--tok-function": "#79b8ff",
    "--tok-type": "#4fd6c8", "--tok-property": "#e4bf7f", "--tok-operator": "#a9b1c6", "--tok-tag": "#ff8fa3", "--tok-attr": "#e4bf7f", "--tok-meta": "#8b95ab",
    "--lane-0": "#8b7cff", "--lane-1": "#37c8d4", "--lane-2": "#f17ac6", "--lane-3": "#e5b44a", "--lane-4": "#3fb950", "--lane-5": "#5aa8ff",
    "--lane-6": "#ff8a4c", "--lane-7": "#b48cff", "--lane-8": "#4fd1a5", "--lane-9": "#ff6b8b", "--lane-10": "#c9d34a", "--lane-11": "#6fa0ff",
  },
  light: {
    "--bg": "#f4f5f9", "--bg-elev": "#ffffff", "--bg-elev2": "#f7f8fb", "--bg-elev3": "#eef0f6", "--bg-input": "#ffffff",
    "--bg-hover": "rgba(20, 24, 40, 0.045)", "--bg-hover-strong": "rgba(20, 24, 40, 0.08)",
    "--bg-explorer-current": "#d9dbe1", "--bg-selected": "rgba(101, 80, 240, 0.11)", "--bg-selected-strong": "rgba(101, 80, 240, 0.2)",
    "--border": "#e1e4ec", "--border-soft": "#eceef4", "--border-strong": "#cfd4e0",
    "--scroll-thumb": "rgba(20, 24, 40, 0.16)", "--scroll-thumb-hover": "rgba(20, 24, 40, 0.3)", "--skeleton": "rgba(20, 24, 40, 0.06)",
    "--text": "#12151f", "--text-dim": "#3f4658", "--text-faint": "#697084",
    "--word-selection-bg": "#c8ddff", "--word-selection-text": "#122b4d",
    "--accent": "#6550f0", "--accent-strong": "#5640e6", "--accent-soft": "rgba(101, 80, 240, 0.1)", "--accent-fg": "#ffffff",
    "--accent-fill": "#6550f0", "--accent-fill-strong": "#5640e6", "--focus": "#5a45e6",
    "--green": "#1a7a31", "--green-soft": "rgba(31, 143, 58, 0.1)", "--red": "#d1342b", "--red-soft": "rgba(209, 52, 43, 0.09)",
    "--amber": "#8f6200", "--amber-soft": "rgba(176, 120, 0, 0.1)", "--blue": "#1f6fe0", "--blue-soft": "rgba(31, 111, 224, 0.1)",
    "--cyan": "#0b7480", "--pink": "#c4378f",
    "--diff-add": "#e9f8ec", "--diff-add-gutter": "#d3f1da", "--diff-add-word": "#a8e4b6",
    "--diff-del": "#fdeeed", "--diff-del-gutter": "#fadad7", "--diff-del-word": "#f5b5af",
    "--diff-hunk": "#eef4ff", "--diff-sel": "rgba(101, 80, 240, 0.22)",
    "--conflict-ours": "rgba(31, 111, 224, 0.08)", "--conflict-ours-strong": "rgba(31, 111, 224, 0.22)",
    "--conflict-theirs": "rgba(196, 55, 143, 0.07)", "--conflict-theirs-strong": "rgba(196, 55, 143, 0.2)", "--conflict-base": "rgba(176, 120, 0, 0.08)",
    "--tok-keyword": "#7a3fd6", "--tok-string": "#237a2e", "--tok-number": "#b35a00", "--tok-comment": "#6b7285", "--tok-function": "#1f5fc4",
    "--tok-type": "#0f7f86", "--tok-property": "#8a5a00", "--tok-operator": "#545c70", "--tok-tag": "#c42050", "--tok-attr": "#8a5a00", "--tok-meta": "#6d7488",
    "--lane-0": "#6550f0", "--lane-1": "#0f9aa8", "--lane-2": "#d0399a", "--lane-3": "#c48a00", "--lane-4": "#1f9a3f", "--lane-5": "#1f6fe0",
    "--lane-6": "#e0661f", "--lane-7": "#8f5ce6", "--lane-8": "#0f9f78", "--lane-9": "#e0395f", "--lane-10": "#8a9a10", "--lane-11": "#3f6fe0",
  },
  "hc-light": {
    "--bg": "#ffffff", "--bg-elev": "#ffffff", "--bg-elev2": "#f5f5f5", "--bg-elev3": "#ebebeb", "--bg-input": "#ffffff",
    "--bg-hover": "rgba(0, 0, 0, 0.07)", "--bg-hover-strong": "rgba(0, 0, 0, 0.12)",
    "--bg-explorer-current": "#cfcfcf", "--bg-selected": "rgba(44, 20, 150, 0.12)", "--bg-selected-strong": "rgba(44, 20, 150, 0.2)",
    "--border": "#6b6b6b", "--border-soft": "#808080", "--border-strong": "#4d4d4d",
    "--scroll-thumb": "rgba(0, 0, 0, 0.55)", "--scroll-thumb-hover": "rgba(0, 0, 0, 0.75)", "--skeleton": "rgba(0, 0, 0, 0.1)",
    "--text": "#000000", "--text-dim": "#1f1f1f", "--text-faint": "#3d3d3d",
    "--word-selection-bg": "#0a3d8f", "--word-selection-text": "#ffffff",
    "--accent": "#3b1fb8", "--accent-strong": "#2c1496", "--accent-soft": "rgba(59, 31, 184, 0.12)", "--accent-fg": "#ffffff",
    "--accent-fill": "#3b1fb8", "--accent-fill-strong": "#2c1496", "--focus": "#0037c8",
    "--green": "#0b5a1e", "--green-soft": "rgba(11, 90, 30, 0.12)", "--red": "#8f0f08", "--red-soft": "rgba(163, 20, 12, 0.1)",
    "--amber": "#5f3f00", "--amber-soft": "rgba(107, 71, 0, 0.12)", "--blue": "#08409a", "--blue-soft": "rgba(10, 74, 168, 0.12)",
    "--cyan": "#06515a", "--pink": "#8f1a63",
    "--diff-add": "#c8f5d2", "--diff-add-gutter": "#a5e8b5", "--diff-add-word": "#7fd896",
    "--diff-del": "#ffd6d2", "--diff-del-gutter": "#ffbab3", "--diff-del-word": "#ff9a90",
    "--diff-hunk": "#dbe8ff", "--diff-sel": "rgba(59, 31, 184, 0.22)",
    "--conflict-ours": "rgba(10, 74, 168, 0.12)", "--conflict-ours-strong": "rgba(10, 74, 168, 0.3)",
    "--conflict-theirs": "rgba(143, 26, 99, 0.11)", "--conflict-theirs-strong": "rgba(143, 26, 99, 0.28)", "--conflict-base": "rgba(107, 71, 0, 0.13)",
    "--tok-keyword": "#5a1fb0", "--tok-string": "#14591f", "--tok-number": "#7a3d00", "--tok-comment": "#424857", "--tok-function": "#0f478f",
    "--tok-type": "#064e54", "--tok-property": "#5c3c00", "--tok-operator": "#2e3442", "--tok-tag": "#8f1238", "--tok-attr": "#5c3c00", "--tok-meta": "#5a3566",
    "--lane-0": "#4a30d8", "--lane-1": "#006a94", "--lane-2": "#b0227f", "--lane-3": "#8a5f00", "--lane-4": "#14732c", "--lane-5": "#1257c0",
    "--lane-6": "#b84a0c", "--lane-7": "#8a3fd0", "--lane-8": "#0a7558", "--lane-9": "#c01f48", "--lane-10": "#5f6b00", "--lane-11": "#555b66",
  },
  "hc-dark": {
    "--bg": "#000000", "--bg-elev": "#0a0a0a", "--bg-elev2": "#141414", "--bg-elev3": "#1f1f1f", "--bg-input": "#000000",
    "--bg-hover": "rgba(255, 255, 255, 0.1)", "--bg-hover-strong": "rgba(255, 255, 255, 0.16)",
    "--bg-explorer-current": "#3a3a3a", "--bg-selected": "rgba(150, 170, 255, 0.2)", "--bg-selected-strong": "rgba(150, 170, 255, 0.3)",
    "--border": "#8c8c8c", "--border-soft": "#767676", "--border-strong": "#b0b0b0",
    "--scroll-thumb": "rgba(255, 255, 255, 0.5)", "--scroll-thumb-hover": "rgba(255, 255, 255, 0.72)", "--skeleton": "rgba(255, 255, 255, 0.12)",
    "--text": "#ffffff", "--text-dim": "#e6e6e6", "--text-faint": "#c8c8c8",
    "--word-selection-bg": "#ffe14d", "--word-selection-text": "#000000",
    "--accent": "#b3a8ff", "--accent-strong": "#c8c0ff", "--accent-soft": "rgba(179, 168, 255, 0.2)", "--accent-fg": "#ffffff",
    "--accent-fill": "#4a35d0", "--accent-fill-strong": "#4030b8", "--focus": "#ffe14d",
    "--green": "#5ee07a", "--green-soft": "rgba(94, 224, 122, 0.18)", "--red": "#ff8a80", "--red-soft": "rgba(255, 138, 128, 0.18)",
    "--amber": "#ffd24d", "--amber-soft": "rgba(255, 210, 77, 0.18)", "--blue": "#8cc4ff", "--blue-soft": "rgba(140, 196, 255, 0.18)",
    "--cyan": "#5fe3ee", "--pink": "#ff9bd8",
    "--diff-add": "#072a10", "--diff-add-gutter": "#0b3d17", "--diff-add-word": "#0f5223",
    "--diff-del": "#4d0f0f", "--diff-del-gutter": "#641414", "--diff-del-word": "#8a1c1c",
    "--diff-hunk": "#0f2a4d", "--diff-sel": "rgba(140, 196, 255, 0.3)",
    "--conflict-ours": "rgba(140, 196, 255, 0.18)", "--conflict-ours-strong": "rgba(140, 196, 255, 0.36)",
    "--conflict-theirs": "rgba(255, 155, 216, 0.17)", "--conflict-theirs-strong": "rgba(255, 155, 216, 0.38)", "--conflict-base": "rgba(255, 210, 77, 0.16)",
    "--tok-keyword": "#d4b3ff", "--tok-string": "#b5f0a0", "--tok-number": "#ffc27a", "--tok-comment": "#b0b8c8", "--tok-function": "#9ccaff",
    "--tok-type": "#6ee8dc", "--tok-property": "#f0d090", "--tok-operator": "#d0d6e6", "--tok-tag": "#ffa8b8", "--tok-attr": "#f0d090", "--tok-meta": "#d0b8c8",
    "--lane-0": "#a99cff", "--lane-1": "#4de1ee", "--lane-2": "#ff8fd4", "--lane-3": "#ffcc33", "--lane-4": "#5ee07a", "--lane-5": "#6bb5ff",
    "--lane-6": "#ff9a5c", "--lane-7": "#d0a8ff", "--lane-8": "#5fe8bd", "--lane-9": "#ff7d9a", "--lane-10": "#dbe65c", "--lane-11": "#c8ccd6",
  },
};

// ───────────── colours ─────────────

export interface Rgba { r: number; g: number; b: number; a: number }

const NUMBER = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)";
const ALPHA = `(${NUMBER}%?)`;
// Legacy comma syntax and the modern space syntax, each with an optional alpha.
const RGB_COMMA = new RegExp(`^rgba?\\(\\s*(${NUMBER}%?)\\s*,\\s*(${NUMBER}%?)\\s*,\\s*(${NUMBER}%?)\\s*(?:,\\s*${ALPHA}\\s*)?\\)$`);
const RGB_SPACE = new RegExp(`^rgba?\\(\\s*(${NUMBER}%?)\\s+(${NUMBER}%?)\\s+(${NUMBER}%?)\\s*(?:/\\s*${ALPHA}\\s*)?\\)$`);
const HSL_COMMA = new RegExp(`^hsla?\\(\\s*(${NUMBER})(?:deg)?\\s*,\\s*(${NUMBER})%\\s*,\\s*(${NUMBER})%\\s*(?:,\\s*${ALPHA}\\s*)?\\)$`);
const HSL_SPACE = new RegExp(`^hsla?\\(\\s*(${NUMBER})(?:deg)?\\s+(${NUMBER})%\\s+(${NUMBER})%\\s*(?:/\\s*${ALPHA}\\s*)?\\)$`);
const MAX_COLOR_LENGTH = 64;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
function alphaValue(text: string | undefined): number {
  if (text === undefined) return 1;
  return clamp(text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text), 0, 1);
}

/**
 * Reads a hex, rgb()/rgba() or hsl()/hsla() colour. Anything else (names, var(), url(),
 * other functions, extra text) is not a theme colour and gives null.
 */
export function parseCssColor(input: unknown): Rgba | null {
  if (typeof input !== "string" || input.length > MAX_COLOR_LENGTH) return null;
  const value = input.trim().toLowerCase();
  if (/^#[0-9a-f]+$/.test(value)) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = "f"] = hex;
      return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: parseInt(a + a, 16) / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const rgb = RGB_COMMA.exec(value) ?? RGB_SPACE.exec(value);
  if (rgb) {
    const parts = rgb.slice(1, 4);
    const percent = parts.filter(part => part.endsWith("%")).length;
    // CSS does not mix numbers and percentages between the three channels.
    if (percent !== 0 && percent !== 3) return null;
    const [r, g, b] = parts.map(part => clamp(percent ? Number(part.slice(0, -1)) * 2.55 : Number(part), 0, 255));
    return { r, g, b, a: alphaValue(rgb[4]) };
  }
  const hsl = HSL_COMMA.exec(value) ?? HSL_SPACE.exec(value);
  if (hsl) {
    const h = ((Number(hsl[1]) % 360) + 360) % 360;
    const s = clamp(Number(hsl[2]), 0, 100) / 100;
    const l = clamp(Number(hsl[3]), 0, 100) / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: alphaValue(hsl[4]) };
  }
  return null;
}

const hexPair = (value: number) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");

/** `#rrggbb` of a colour without its alpha: what `<input type="color">` takes. */
export function colorHex(color: Rgba): string { return `#${hexPair(color.r)}${hexPair(color.g)}${hexPair(color.b)}`; }

/** The one spelling Revqora stores and applies: `#rrggbb`, or `rgba(r, g, b, a)` with alpha. */
export function formatColor(color: Rgba): string {
  if (color.a >= 1) return colorHex(color);
  const alpha = Math.round(clamp(color.a, 0, 1) * 1000) / 1000;
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${alpha})`;
}

/** A valid colour in Revqora's spelling, or null. The result is built from numbers, never from the input text. */
export function normalizeColor(input: unknown): string | null {
  const color = parseCssColor(input);
  return color ? formatColor(color) : null;
}

function channel(value: number) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** `top` painted over an opaque `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const mix = (a: number, b: number) => a * top.a + b * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function mustParse(value: string): Rgba {
  const color = parseCssColor(value);
  if (!color) throw Error(`Not a theme colour: ${value}`);
  return color;
}

/**
 * WCAG 2 contrast ratio of `foreground` on `background`. Translucent colours are painted
 * first: the background over `under` (white by default), the foreground over the result.
 */
export function contrastRatio(foreground: string, background: string, under = "#ffffff"): number {
  const back = composite(mustParse(background), mustParse(under));
  const front = composite(mustParse(foreground), back);
  const a = relativeLuminance(front), b = relativeLuminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ───────────── custom themes ─────────────

export interface CustomTheme {
  /** Unique among the saved custom themes; the theme setting stores `custom:<id>`. */
  id: string;
  name: string;
  /** The built-in theme this one started from: gives the colour scheme and every colour it does not change. */
  base: BuiltinThemeId;
  colors: ThemeColors;
}

export const THEME_NAME_LIMIT = 60;
export const CUSTOM_THEME_LIMIT = 50;
export const THEME_FILE_LIMIT = 256 * 1024;
const THEME_FILE_FORMAT = "revqora.theme";

export function cleanThemeName(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, THEME_NAME_LIMIT).trim();
}

/** `name`, or `name 2`, `name 3`… when another custom theme already has it. */
export function uniqueThemeName(name: string, themes: readonly CustomTheme[], exceptId?: string): string {
  const taken = new Set(themes.filter(theme => theme.id !== exceptId).map(theme => theme.name.toLowerCase()));
  const base = cleanThemeName(name) || "Custom theme";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, THEME_NAME_LIMIT - suffix.length).trim() + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function customThemePref(id: string): ThemePref { return `custom:${id}`; }
export function customThemeId(pref: string): string | null { return pref.startsWith("custom:") ? pref.slice(7) : null; }

/** Keeps only known tokens with valid colours, in Revqora's spelling. */
function cleanColors(input: unknown): ThemeColors {
  const colors: ThemeColors = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return colors;
  for (const { name } of THEME_TOKENS) {
    if (!Object.prototype.hasOwnProperty.call(input, name)) continue;
    const value = normalizeColor((input as Record<string, unknown>)[name]);
    if (value) colors[name] = value;
  }
  return colors;
}

/** Saved settings are read leniently: a damaged entry is dropped or repaired, never applied as it is. */
export function restoreCustomThemes(saved: unknown): CustomTheme[] {
  if (!Array.isArray(saved)) return [];
  const themes: CustomTheme[] = [];
  const ids = new Set<string>();
  for (const item of saved) {
    if (themes.length >= CUSTOM_THEME_LIMIT) break;
    if (!item || typeof item !== "object") continue;
    const { id, name, base, colors } = item as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id) || ids.has(id) || !isBuiltinThemeId(base)) continue;
    ids.add(id);
    themes.push({ id, name: uniqueThemeName(cleanThemeName(name), themes), base, colors: cleanColors(colors) });
  }
  return themes;
}

export function newThemeId(themes: readonly CustomTheme[], random: () => number = Math.random): string {
  const taken = new Set(themes.map(theme => theme.id));
  for (;;) {
    const id = `t${Math.floor(random() * 36 ** 8).toString(36).padStart(8, "0")}`;
    if (!taken.has(id)) return id;
  }
}

/** Every token of a theme: its own colours over its base palette. */
export function themePalette(theme: Pick<CustomTheme, "base" | "colors">): ThemePalette {
  return { ...BUILTIN_PALETTES[theme.base], ...cleanColors(theme.colors) };
}

/** A copy of a built-in or custom theme as a new custom theme. */
export function duplicateTheme(source: BuiltinThemeId | CustomTheme, themes: readonly CustomTheme[], name?: string): CustomTheme {
  const builtin = typeof source === "string" ? builtinById.get(source)! : null;
  return {
    id: newThemeId(themes),
    name: uniqueThemeName(name ?? `${builtin ? builtin.label : (source as CustomTheme).name} copy`, themes),
    base: builtin ? builtin.id : (source as CustomTheme).base,
    colors: builtin ? {} : { ...cleanColors((source as CustomTheme).colors) },
  };
}

/** The theme file: self-contained, with every token, so it looks the same wherever it is imported. */
export function serializeTheme(theme: Pick<CustomTheme, "name" | "base" | "colors">): string {
  const palette = themePalette(theme);
  const colors = Object.fromEntries(THEME_TOKENS.map(({ name }) => [name, normalizeColor(palette[name]) ?? palette[name]]));
  return JSON.stringify({ format: THEME_FILE_FORMAT, version: 1, name: cleanThemeName(theme.name) || "Custom theme", base: theme.base, colors }, null, 2) + "\n";
}

export interface ImportedTheme { name: string; base: BuiltinThemeId; colors: ThemeColors }

const shown = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/**
 * Reads a theme file strictly. Any unknown field or token, or any value that is not a hex,
 * rgb() or hsl() colour, rejects the whole file with a message that names the problem.
 */
export function parseThemeFile(text: string): ImportedTheme {
  if (text.length > THEME_FILE_LIMIT) throw Error("Choose a theme file smaller than 256 KB.");
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^﻿/, "")); }
  catch { throw Error("This file is not valid JSON. Choose a theme exported from Revqora."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Choose a theme exported from Revqora.");
  const file = parsed as Record<string, unknown>;
  if (file.format !== THEME_FILE_FORMAT) throw Error("This is not a Revqora theme file (the \"format\" field must be \"revqora.theme\").");
  if (file.version !== 1) throw Error("This Revqora theme file uses an unsupported version.");
  const unknownField = Object.keys(file).find(key => !["format", "version", "name", "base", "colors"].includes(key));
  if (unknownField !== undefined) throw Error(`Unknown field "${shown(unknownField)}" in the theme file.`);
  const name = cleanThemeName(file.name);
  if (typeof file.name !== "string" || !name) throw Error("The theme file has no name.");
  if (!isBuiltinThemeId(file.base)) throw Error(`The base theme must be one of: ${BUILTIN_THEMES.map(theme => theme.id).join(", ")}.`);
  if (!file.colors || typeof file.colors !== "object" || Array.isArray(file.colors)) throw Error("The theme file has no \"colors\" object.");
  const colors: ThemeColors = {};
  for (const [key, value] of Object.entries(file.colors as Record<string, unknown>)) {
    if (!isThemeToken(key)) throw Error(`Unknown colour token "${shown(key)}".`);
    const color = normalizeColor(value);
    if (!color) throw Error(`"${shown(value)}" is not a valid colour for ${key}. Use a hex, rgb() or hsl() colour.`);
    colors[key] = color;
  }
  return { name, base: file.base, colors };
}

// ───────────── resolving the theme setting ─────────────

export interface ThemeEnvironment {
  /** The system asks for a light interface (`prefers-color-scheme: light`). */
  light: boolean;
  /** The system asks for more contrast (`prefers-contrast: more` or `forced-colors: active`). */
  moreContrast: boolean;
}

export interface ResolvedTheme {
  base: BuiltinThemeId;
  scheme: ColorScheme;
  contrast: boolean;
  /** Colours a custom theme puts over the base palette; empty for a built-in theme. */
  colors: ThemeColors;
  custom: CustomTheme | null;
}

function resolvedBuiltin(id: BuiltinThemeId, custom: CustomTheme | null = null): ResolvedTheme {
  const { scheme, contrast } = builtinById.get(id)!;
  return { base: id, scheme, contrast, colors: custom ? cleanColors(custom.colors) : {}, custom };
}

export function resolveCustomTheme(theme: CustomTheme): ResolvedTheme { return resolvedBuiltin(theme.base, theme); }

/** A deleted or unknown custom theme falls back to System. */
export function resolveTheme(pref: string, customThemes: readonly CustomTheme[], env: ThemeEnvironment): ResolvedTheme {
  if (isBuiltinThemeId(pref)) return resolvedBuiltin(pref);
  const id = customThemeId(pref);
  const custom = id === null ? undefined : customThemes.find(theme => theme.id === id);
  if (custom) return resolveCustomTheme(custom);
  const scheme: ColorScheme = env.light ? "light" : "dark";
  return resolvedBuiltin(env.moreContrast ? `hc-${scheme}` : scheme);
}

/**
 * "Toggle dark / light theme": the built-in theme of the other colour scheme. High contrast
 * stays high contrast, and a custom theme switches to the built-in opposite of its base
 * (the custom theme itself is kept; choose it again in Settings).
 */
export function toggledTheme(pref: string, customThemes: readonly CustomTheme[], env: ThemeEnvironment): BuiltinThemeId {
  const current = resolveTheme(pref, customThemes, env);
  const scheme: ColorScheme = current.scheme === "dark" ? "light" : "dark";
  return current.contrast ? `hc-${scheme}` : scheme;
}

export function themeLabel(pref: string, customThemes: readonly CustomTheme[]): string {
  if (isBuiltinThemeId(pref)) return builtinById.get(pref)!.label;
  const id = customThemeId(pref);
  return (id !== null && customThemes.find(theme => theme.id === id)?.name) || "System";
}
