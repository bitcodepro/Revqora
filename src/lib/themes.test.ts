import { describe, expect, it } from "vitest";
import {
  BUILTIN_PALETTES, BUILTIN_THEMES, THEME_GROUPS, THEME_TOKENS, cleanThemeName, colorHex, composite, contrastRatio,
  duplicateTheme, formatColor, isThemeToken, normalizeColor, parseCssColor, parseThemeFile, restoreCustomThemes,
  resolveTheme, serializeTheme, themeLabel, themePalette, toggledTheme, uniqueThemeName,
  type BuiltinThemeId, type CustomTheme, type ThemePalette, type ThemeTokenName,
} from "./themes";
// vitest stubs CSS imports (even `?raw`) in the node environment, so the file is read from disk.
// @ts-expect-error The project has no Node typings; vitest runs this file in Node.
import { readFileSync } from "node:fs";

const css: string = readFileSync(new URL("../styles/theme.css", import.meta.url), "utf8");


/** Custom properties of the one rule in theme.css whose selector list has exactly `selector`. */
function cssBlock(selector: string): Record<string, string> {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(rule => rule[1].split(",").map((part: string) => part.trim()).includes(selector));
  expect(rules, selector).toHaveLength(1);
  return Object.fromEntries([...rules[0][2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}

const selectors: Record<BuiltinThemeId, string> = {
  dark: `:root[data-theme="dark"]`,
  light: `:root[data-theme="light"]`,
  "hc-dark": `:root[data-theme="dark"][data-contrast="more"]`,
  "hc-light": `:root[data-theme="light"][data-contrast="more"]`,
};
const ids = Object.keys(selectors) as BuiltinThemeId[];
const names = THEME_TOKENS.map(item => item.name);
const SURFACES = ["--bg", "--bg-elev", "--bg-elev2", "--bg-elev3", "--bg-input"] as const;
const LANES = names.filter(name => name.startsWith("--lane-"));
const SYNTAX = names.filter(name => name.startsWith("--tok-"));

describe("theme tokens", () => {
  it("lists every token once, in a known group, with a label", () => {
    expect(new Set(names).size).toBe(names.length);
    const groups = new Set(THEME_GROUPS.map(group => group.id));
    for (const item of THEME_TOKENS) {
      expect(groups.has(item.group), item.name).toBe(true);
      expect(item.label.trim(), item.name).not.toBe("");
    }
    expect(new Set(THEME_TOKENS.map(item => item.label)).size).toBe(names.length);
    for (const group of THEME_GROUPS) expect(THEME_TOKENS.some(item => item.group === group.id), group.id).toBe(true);
  });

  it.each(ids)("theme.css defines exactly the %s palette", id => {
    const block = cssBlock(selectors[id]);
    const colours = Object.fromEntries(Object.entries(block).filter(([name]) => !name.startsWith("--shadow-")));
    expect(Object.keys(colours).sort()).toEqual([...names].sort());
    expect(colours).toEqual(BUILTIN_PALETTES[id]);
  });

  it.each(ids)("every %s value is a valid theme colour", id => {
    expect(Object.keys(BUILTIN_PALETTES[id]).sort()).toEqual([...names].sort());
    for (const name of names) expect(normalizeColor(BUILTIN_PALETTES[id][name]), `${id} ${name}`).not.toBeNull();
  });

  it("gives light themes their own shadows and each theme its colour scheme", () => {
    for (const { id, scheme } of BUILTIN_THEMES) {
      const rule = new RegExp(`${selectors[id].replace(/[[\]"]/g, "\\$&")}\\s*\\{[^}]*color-scheme:\\s*${scheme};`);
      expect(rule.test(css), id).toBe(true);
    }
    expect(cssBlock(selectors["hc-light"])["--shadow-pop"]).toBeTruthy();
    expect(cssBlock(selectors["hc-light"])["--shadow-card"]).toBeTruthy();
  });
});

describe("high-contrast palettes", () => {
  const ratio = (p: ThemePalette, fg: ThemeTokenName | string, bg: ThemeTokenName | string, under: ThemeTokenName = "--bg") =>
    contrastRatio(isThemeToken(fg) ? p[fg] : fg, isThemeToken(bg) ? p[bg] : bg, p[under]);
  // Squared-distance-free check: two colours differ visibly when some channel is far apart.
  const distance = (a: string, b: string) => {
    const x = parseCssColor(a)!, y = parseCssColor(b)!;
    return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);
  };

  describe.each(["hc-dark", "hc-light"] as const)("%s", id => {
    const p = BUILTIN_PALETTES[id];

    it("uses opaque surfaces", () => {
      for (const surface of SURFACES) expect.soft(parseCssColor(p[surface])!.a, surface).toBe(1);
    });

    it("body text is at least 7:1 on every surface", () => {
      for (const text of ["--text", "--text-dim", "--text-faint"] as const) {
        for (const surface of SURFACES) expect.soft(ratio(p, text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(7);
      }
    });

    it("text stays at least 7:1 on hovered, selected and current rows", () => {
      const states = ["--bg-hover", "--bg-hover-strong", "--bg-selected", "--bg-selected-strong", "--accent-soft"] as const;
      for (const surface of SURFACES) {
        for (const state of states) {
          expect.soft(ratio(p, "--text", state, surface), `text on ${state} over ${surface}`).toBeGreaterThanOrEqual(7);
          expect.soft(ratio(p, "--text-dim", state, surface), `text-dim on ${state} over ${surface}`).toBeGreaterThanOrEqual(7);
        }
      }
      expect.soft(ratio(p, "--text", "--bg-explorer-current")).toBeGreaterThanOrEqual(7);
    });

    it("coloured text is at least 7:1 on every surface", () => {
      const coloured = ["--accent", "--accent-strong", "--green", "--red", "--amber", "--blue", "--cyan", "--pink", ...SYNTAX] as ThemeTokenName[];
      for (const name of coloured) {
        for (const surface of SURFACES) expect.soft(ratio(p, name, surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(7);
      }
    });

    it("text on accent fills and on the word selection is at least 7:1", () => {
      expect.soft(ratio(p, "--accent-fg", "--accent-fill")).toBeGreaterThanOrEqual(7);
      expect.soft(ratio(p, "--accent-fg", "--accent-fill-strong")).toBeGreaterThanOrEqual(7);
      // Menus and counters put literal white on the accent fill.
      expect.soft(ratio(p, "#ffffff", "--accent-fill")).toBeGreaterThanOrEqual(7);
      expect.soft(ratio(p, "#ffffff", "--accent-fill-strong")).toBeGreaterThanOrEqual(7);
      expect.soft(ratio(p, "--word-selection-text", "--word-selection-bg")).toBeGreaterThanOrEqual(7);
    });

    it("borders, the focus ring and the scrollbar are at least 3:1 on every surface", () => {
      for (const name of ["--border", "--border-soft", "--border-strong", "--focus", "--scroll-thumb", "--scroll-thumb-hover"] as const) {
        for (const surface of SURFACES) expect.soft(ratio(p, name, surface, surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    });

    it("graph lanes are at least 3:1 on every surface and differ from each other", () => {
      for (const lane of LANES) {
        for (const surface of SURFACES) expect.soft(ratio(p, lane, surface), `${lane} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
      for (const a of LANES) for (const b of LANES) if (a < b) expect.soft(distance(p[a], p[b]), `${a} / ${b}`).toBeGreaterThan(40);
    });

    it("diff lines keep 7:1 text and added / deleted colours stay apart", () => {
      const diff = ["--diff-add", "--diff-add-gutter", "--diff-add-word", "--diff-del", "--diff-del-gutter", "--diff-del-word", "--diff-hunk", "--diff-sel",
        "--conflict-ours", "--conflict-ours-strong", "--conflict-theirs", "--conflict-theirs-strong", "--conflict-base"] as const;
      for (const name of diff) {
        expect.soft(ratio(p, "--text", name), `text on ${name}`).toBeGreaterThanOrEqual(7);
        expect.soft(ratio(p, "--text-dim", name), `text-dim on ${name}`).toBeGreaterThanOrEqual(7);
      }
      // Syntax colours are read on added and deleted lines too.
      for (const tok of SYNTAX) {
        for (const line of ["--diff-add", "--diff-del", "--diff-hunk"] as const) expect.soft(ratio(p, tok, line), `${tok} on ${line}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const [add, del] of [["--diff-add", "--diff-del"], ["--diff-add-gutter", "--diff-del-gutter"], ["--diff-add-word", "--diff-del-word"]] as const) {
        expect.soft(distance(p[add], p[del]), `${add} / ${del}`).toBeGreaterThan(60);
      }
      // A changed word stands out from its line.
      expect.soft(distance(p["--diff-add-word"], p["--diff-add"])).toBeGreaterThan(30);
      expect.soft(distance(p["--diff-del-word"], p["--diff-del"])).toBeGreaterThan(30);
      const selected = formatColor(composite(parseCssColor(p["--diff-sel"])!, parseCssColor(p["--bg"])!));
      expect.soft(distance(selected, p["--bg"])).toBeGreaterThan(30);
      expect.soft(distance(p["--conflict-ours-strong"], p["--conflict-theirs-strong"])).toBeGreaterThan(40);
    });

    it("syntax classes stay as distinguishable as in the standard theme", () => {
      const standard = BUILTIN_PALETTES[id === "hc-dark" ? "dark" : "light"];
      for (const a of SYNTAX) for (const b of SYNTAX) {
        if (a < b && standard[a] !== standard[b]) expect.soft(distance(p[a], p[b]), `${a} / ${b}`).toBeGreaterThan(20);
      }
    });
  });
});

describe("colours", () => {
  it("reads hex, rgb() and hsl()", () => {
    expect(parseCssColor("#FFF")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#0d0f15")).toEqual({ r: 13, g: 15, b: 21, a: 1 });
    expect(parseCssColor("#00000080")!.a).toBeCloseTo(0.502, 3);
    expect(parseCssColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseCssColor("RGBA(255, 255, 255, 0.045)")).toEqual({ r: 255, g: 255, b: 255, a: 0.045 });
    expect(parseCssColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(colorHex(parseCssColor("rgb(100%, 0%, 0%)")!)).toBe("#ff0000");
    expect(colorHex(parseCssColor("hsl(120, 100%, 25%)")!)).toBe("#008000");
    expect(colorHex(parseCssColor("hsla(240deg 100% 50% / 0.5)")!)).toBe("#0000ff");
    expect(normalizeColor("  #ABCDEF  ")).toBe("#abcdef");
    expect(normalizeColor("hsl(0, 100%, 50%, 0.25)")).toBe("rgba(255, 0, 0, 0.25)");
  });

  it.each([
    "", "red", "transparent", "#12", "#12345", "#gggggg", "#1234567", "var(--bg)", "url(https://example.com/x.png)",
    "rgb(1, 2)", "rgb(1, 2, 3", "rgb(1, 2, 3);", "rgb(1, 2, 3) } body { display: none", "#fff; background: url(x)",
    "rgb(var(--x), 0, 0)", "rgb(10%, 20, 30)", "hsl(120, 100, 25)", "color-mix(in srgb, red, blue)", "calc(1px)",
    "#fff /* x */", "expression(alert(1))", "rgb(1,2,3)\\", "#fff{", "#fff}", `#${"f".repeat(80)}`,
  ])("rejects %j", value => {
    expect(parseCssColor(value)).toBeNull();
    expect(normalizeColor(value)).toBeNull();
  });

  it("rejects values that are not strings", () => {
    for (const value of [null, undefined, 0, {}, ["#fff"]]) expect(normalizeColor(value)).toBeNull();
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    // A translucent background is painted over what is under it first.
    expect(contrastRatio("#ffffff", "rgba(0, 0, 0, 0.5)", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#808080"), 1);
    expect(() => contrastRatio("red", "#fff")).toThrow();
  });
});

describe("custom themes", () => {
  const theme: CustomTheme = { id: "t1", name: "Mine", base: "hc-dark", colors: { "--bg": "#101010", "--accent": "rgba(1, 2, 3, 0.5)" } };

  it("duplicates built-in and custom themes under a free name", () => {
    const copy = duplicateTheme("dark", []);
    expect(copy).toMatchObject({ name: "Dark copy", base: "dark", colors: {} });
    const second = duplicateTheme("dark", [copy]);
    expect(second.name).toBe("Dark copy 2");
    expect(second.id).not.toBe(copy.id);
    const fromCustom = duplicateTheme(theme, [theme]);
    expect(fromCustom).toMatchObject({ name: "Mine copy", base: "hc-dark", colors: theme.colors });
    expect(fromCustom.colors).not.toBe(theme.colors);
  });

  it("cleans names", () => {
    expect(cleanThemeName("  My\n\ttheme\u0000 ")).toBe("My theme");
    expect(cleanThemeName("x".repeat(200))).toHaveLength(60);
    expect(cleanThemeName(42)).toBe("");
    expect(uniqueThemeName("mine", [theme])).toBe("mine 2");
    expect(uniqueThemeName("Mine", [theme], "t1")).toBe("Mine");
    expect(uniqueThemeName("", [])).toBe("Custom theme");
  });

  it("round-trips through the theme file with every token", () => {
    const text = serializeTheme(theme);
    const file = JSON.parse(text);
    expect(file).toMatchObject({ format: "revqora.theme", version: 1, name: "Mine", base: "hc-dark" });
    expect(Object.keys(file.colors)).toEqual(names);
    const imported = parseThemeFile(text);
    expect(imported.name).toBe("Mine");
    expect(imported.base).toBe("hc-dark");
    expect(imported.colors["--bg"]).toBe("#101010");
    expect(imported.colors["--accent"]).toBe("rgba(1, 2, 3, 0.5)");
    expect(themePalette({ base: imported.base, colors: imported.colors })).toEqual(
      Object.fromEntries(names.map(name => [name, normalizeColor(themePalette(theme)[name])])));
  });

  it("accepts a file with only some tokens and stores colours in one spelling", () => {
    const imported = parseThemeFile(JSON.stringify({ format: "revqora.theme", version: 1, name: " Sea ", base: "light", colors: { "--bg": "#ABC", "--text": "hsl(0 0% 0%)" } }));
    expect(imported).toEqual({ name: "Sea", base: "light", colors: { "--bg": "#aabbcc", "--text": "#000000" } });
  });

  const file = (patch: Record<string, unknown>) => JSON.stringify({ format: "revqora.theme", version: 1, name: "X", base: "dark", colors: {}, ...patch });
  it.each([
    ["not json", "{", /not valid JSON/],
    ["an array", "[]", /exported from Revqora/],
    ["another format", JSON.stringify({ format: "revqora.shortcuts", version: 1 }), /not a Revqora theme file/],
    ["a newer version", file({ version: 2 }), /unsupported version/],
    ["an unknown field", file({ css: "body{}" }), /Unknown field "css"/],
    ["no name", file({ name: "  " }), /no name/],
    ["a name that is not text", file({ name: 5 }), /no name/],
    ["an unknown base", file({ base: "solarized" }), /base theme must be one of/],
    ["no colours", file({ colors: null }), /no "colors" object/],
    ["colours as a list", file({ colors: ["#fff"] }), /no "colors" object/],
    ["an unknown token", file({ colors: { "--fs": "#fff" } }), /Unknown colour token "--fs"/],
    ["a token without dashes", file({ colors: { bg: "#fff" } }), /Unknown colour token "bg"/],
    ["an inherited key", file({ colors: { toString: "#fff" } }), /Unknown colour token "toString"/],
    ["a named colour", file({ colors: { "--bg": "red" } }), /"red" is not a valid colour for --bg/],
    ["url()", file({ colors: { "--bg": "url(https://example.com/a.png)" } }), /not a valid colour for --bg/],
    ["var()", file({ colors: { "--bg": "var(--text)" } }), /not a valid colour for --bg/],
    ["a semicolon", file({ colors: { "--bg": "#fff; color: red" } }), /not a valid colour for --bg/],
    ["braces", file({ colors: { "--bg": "#fff } * { display: none" } }), /not a valid colour for --bg/],
    ["a number", file({ colors: { "--bg": 0 } }), /not a valid colour for --bg/],
  ])("rejects a file with %s", (_case, text, message) => {
    expect(() => parseThemeFile(text)).toThrow(message);
  });

  it("rejects an oversized file before parsing it", () => {
    expect(() => parseThemeFile(" ".repeat(256 * 1024 + 1))).toThrow(/smaller than 256 KB/);
  });

  it("restores saved themes and drops what it cannot trust", () => {
    expect(restoreCustomThemes(undefined)).toEqual([]);
    expect(restoreCustomThemes({})).toEqual([]);
    const restored = restoreCustomThemes([
      theme,
      { id: "t1", name: "Duplicate id", base: "dark", colors: {} },
      { id: "t2", name: "Mine", base: "light", colors: { "--bg": "url(x)", "--nope": "#fff", "--text": "#FFF" } },
      { id: "bad id!", name: "Bad", base: "dark", colors: {} },
      { id: "t3", name: "No base", base: "sepia", colors: {} },
      { id: "t4", name: "", base: "dark" },
      null, "text",
    ]);
    expect(restored).toEqual([
      theme,
      { id: "t2", name: "Mine 2", base: "light", colors: { "--text": "#ffffff" } },
      { id: "t4", name: "Custom theme", base: "dark", colors: {} },
    ]);
  });
});

describe("resolving the theme setting", () => {
  const custom: CustomTheme = { id: "c1", name: "Night", base: "hc-dark", colors: { "--bg": "#111111" } };
  const env = (light: boolean, moreContrast = false) => ({ light, moreContrast });

  it("follows the system colour scheme and contrast", () => {
    expect(resolveTheme("system", [], env(false)).base).toBe("dark");
    expect(resolveTheme("system", [], env(true)).base).toBe("light");
    expect(resolveTheme("system", [], env(false, true)).base).toBe("hc-dark");
    expect(resolveTheme("system", [], env(true, true))).toMatchObject({ base: "hc-light", scheme: "light", contrast: true, colors: {} });
  });

  it("keeps an explicit choice whatever the system asks for", () => {
    expect(resolveTheme("light", [], env(false, true))).toMatchObject({ base: "light", scheme: "light", contrast: false });
    expect(resolveTheme("hc-dark", [], env(true))).toMatchObject({ base: "hc-dark", scheme: "dark", contrast: true });
  });

  it("resolves a custom theme to its base and colours", () => {
    expect(resolveTheme("custom:c1", [custom], env(true))).toEqual({ base: "hc-dark", scheme: "dark", contrast: true, colors: { "--bg": "#111111" }, custom });
    expect(resolveTheme("custom:gone", [custom], env(true)).base).toBe("light");
    expect(resolveTheme("nonsense", [], env(false)).base).toBe("dark");
  });

  it("toggles to the built-in theme of the other scheme, keeping high contrast", () => {
    expect(toggledTheme("dark", [], env(true))).toBe("light");
    expect(toggledTheme("light", [], env(true))).toBe("dark");
    expect(toggledTheme("system", [], env(true))).toBe("dark");
    expect(toggledTheme("system", [], env(false, true))).toBe("hc-light");
    expect(toggledTheme("hc-light", [], env(false))).toBe("hc-dark");
    expect(toggledTheme("custom:c1", [custom], env(false))).toBe("hc-light");
    expect(toggledTheme("custom:c2", [{ ...custom, id: "c2", base: "light" }], env(false))).toBe("dark");
  });

  it("names the setting", () => {
    expect(themeLabel("system", [])).toBe("System");
    expect(themeLabel("hc-light", [])).toBe("High contrast light");
    expect(themeLabel("custom:c1", [custom])).toBe("Night");
    expect(themeLabel("custom:gone", [custom])).toBe("System");
  });
});
