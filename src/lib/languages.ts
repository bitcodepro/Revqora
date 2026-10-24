// Language registry shared by the diff highlighter and the conflict editor.
import { LanguageDescription, LanguageSupport, StreamLanguage, type Language } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";

const legacy = (loader: () => Promise<LanguageSupport>) => loader;

export const languages: LanguageDescription[] = [
  LanguageDescription.of({ name: "TypeScript", extensions: ["ts", "mts", "cts"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })) }),
  LanguageDescription.of({ name: "TSX", extensions: ["tsx"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })) }),
  LanguageDescription.of({ name: "JavaScript", extensions: ["js", "mjs", "cjs"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript()) }),
  LanguageDescription.of({ name: "JSX", extensions: ["jsx"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })) }),
  LanguageDescription.of({ name: "Rust", extensions: ["rs"], load: () => import("@codemirror/lang-rust").then((m) => m.rust()) }),
  LanguageDescription.of({ name: "Python", extensions: ["py", "pyw", "pyi"], load: () => import("@codemirror/lang-python").then((m) => m.python()) }),
  LanguageDescription.of({ name: "CSS", extensions: ["css", "scss", "less"], load: () => import("@codemirror/lang-css").then((m) => m.css()) }),
  LanguageDescription.of({ name: "HTML", extensions: ["html", "htm", "vue", "svelte", "razor", "cshtml"], load: () => import("@codemirror/lang-html").then((m) => m.html()) }),
  LanguageDescription.of({ name: "JSON", extensions: ["json", "jsonc", "json5"], filename: /^(\.babelrc|\.eslintrc|tsconfig.*)$/, load: () => import("@codemirror/lang-json").then((m) => m.json()) }),
  LanguageDescription.of({ name: "Markdown", extensions: ["md", "markdown", "mdx"], load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) }),
  LanguageDescription.of({ name: "C++", extensions: ["c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()) }),
  LanguageDescription.of({ name: "Java", extensions: ["java", "kt", "kts", "scala", "groovy", "gradle"], load: () => import("@codemirror/lang-java").then((m) => m.java()) }),
  LanguageDescription.of({
    name: "XML",
    extensions: ["xml", "csproj", "fsproj", "vbproj", "props", "targets", "xaml", "axaml", "svg", "resx", "config", "nuspec", "plist"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  }),
  LanguageDescription.of({ name: "SQL", extensions: ["sql"], load: () => import("@codemirror/lang-sql").then((m) => m.sql()) }),
  LanguageDescription.of({ name: "YAML", extensions: ["yml", "yaml"], load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()) }),
  LanguageDescription.of({
    name: "C#",
    extensions: ["cs", "csx"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => new LanguageSupport(StreamLanguage.define(m.csharp)))),
  }),
  LanguageDescription.of({ name: "Go", extensions: ["go"], load: legacy(() => import("@codemirror/legacy-modes/mode/go").then((m) => new LanguageSupport(StreamLanguage.define(m.go)))) }),
  LanguageDescription.of({
    name: "Shell",
    extensions: ["sh", "bash", "zsh"],
    filename: /^(\.bashrc|\.zshrc|\.profile)$/,
    load: legacy(() => import("@codemirror/legacy-modes/mode/shell").then((m) => new LanguageSupport(StreamLanguage.define(m.shell)))),
  }),
  LanguageDescription.of({
    name: "PowerShell",
    extensions: ["ps1", "psm1", "psd1"],
    load: legacy(() => import("@codemirror/legacy-modes/mode/powershell").then((m) => new LanguageSupport(StreamLanguage.define(m.powerShell)))),
  }),
  LanguageDescription.of({ name: "TOML", extensions: ["toml"], load: legacy(() => import("@codemirror/legacy-modes/mode/toml").then((m) => new LanguageSupport(StreamLanguage.define(m.toml)))) }),
  LanguageDescription.of({
    name: "Dockerfile",
    filename: /^(Dockerfile|Containerfile)(\..*)?$/,
    load: legacy(() => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => new LanguageSupport(StreamLanguage.define(m.dockerFile)))),
  }),
  LanguageDescription.of({ name: "Swift", extensions: ["swift"], load: legacy(() => import("@codemirror/legacy-modes/mode/swift").then((m) => new LanguageSupport(StreamLanguage.define(m.swift)))) }),
  LanguageDescription.of({ name: "Ruby", extensions: ["rb", "rake", "gemspec"], load: legacy(() => import("@codemirror/legacy-modes/mode/ruby").then((m) => new LanguageSupport(StreamLanguage.define(m.ruby)))) }),
  LanguageDescription.of({ name: "Lua", extensions: ["lua"], load: legacy(() => import("@codemirror/legacy-modes/mode/lua").then((m) => new LanguageSupport(StreamLanguage.define(m.lua)))) }),
];

function base(path: string) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

const cache = new Map<string, Promise<LanguageSupport | null>>();

export function languageFor(path: string): Promise<LanguageSupport | null> {
  const desc = LanguageDescription.matchFilename(languages, base(path));
  if (!desc) return Promise.resolve(null);
  let p = cache.get(desc.name);
  if (!p) {
    p = desc.load().catch(() => null);
    cache.set(desc.name, p);
  }
  return p;
}

export interface Tok {
  text: string;
  cls: string;
}

/** Highlights a block of lines; returns one token list per line. */
export function highlightLines(lang: Language, lines: string[]): Tok[][] {
  const text = lines.join("\n");
  if (text.length > 400_000) return lines.map((l) => [{ text: l, cls: "" }]);
  const tree = lang.parser.parse(text);
  const out: Tok[][] = lines.map(() => []);
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const ranges: { from: number; to: number; cls: string }[] = [];
  highlightTree(tree, classHighlighter, (from, to, cls) => ranges.push({ from, to, cls }));
  let ri = 0;
  for (let li = 0; li < lines.length; li++) {
    const ls = starts[li];
    const le = ls + lines[li].length;
    const toks: Tok[] = [];
    let p = ls;
    while (ri < ranges.length && ranges[ri].to <= ls) ri++;
    for (let k = ri; k < ranges.length && ranges[k].from < le; k++) {
      const r = ranges[k];
      const f = Math.max(r.from, ls);
      const t = Math.min(r.to, le);
      if (f > p) toks.push({ text: text.slice(p, f), cls: "" });
      if (t > f) toks.push({ text: text.slice(f, t), cls: r.cls });
      p = Math.max(p, t);
    }
    if (p < le) toks.push({ text: text.slice(p, le), cls: "" });
    out[li] = toks;
  }
  return out;
}
